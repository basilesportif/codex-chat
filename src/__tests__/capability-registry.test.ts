import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { outputResource } from "../capabilities.js";
import { capabilityRegistry, capabilityRegistryById } from "../capability-registry.js";
import { DIRECTIVE_ACTION_TYPES } from "../directives.js";
import { EMPLOYEE_COMMAND_ACTIONS } from "../employees.js";
import { IPC_OPERATION_BY_MESSAGE_TYPE, UNDERLYING_DIRECTIVE_OPERATION_BY_ACTION } from "../service.js";
import { USER_EVENT_SOURCES, type OutputTarget } from "../types.js";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const EVENT_RECEIVE_OPERATIONS = USER_EVENT_SOURCES.map((source) => `${source}.event.receive`);
const DIRECTIVE_OPERATIONS = DIRECTIVE_ACTION_TYPES.map((type) => `directive.${type}.execute`);
const EMPLOYEE_MANAGE_OPERATIONS = EMPLOYEE_COMMAND_ACTIONS.map((action) => `employees.manage.${action}`);
const IPC_OPERATION_MATRIX = [...new Set([...Object.values(IPC_OPERATION_BY_MESSAGE_TYPE), "ipc.unknown"])];
const UNDERLYING_DIRECTIVE_OPERATIONS = Object.values(UNDERLYING_DIRECTIVE_OPERATION_BY_ACTION);

const DYNAMIC_OPERATION_EXPANSIONS: Record<string, readonly string[]> = {
  "UserEvent.source receive operation from `${event.source}.event.receive`": EVENT_RECEIVE_OPERATIONS,
  "Directive action operation from `directive.${action.type}.execute`": DIRECTIVE_OPERATIONS,
  "Employee command operation from `employees.manage.${employeeCommand.action}`": EMPLOYEE_MANAGE_OPERATIONS,
  "Local IPC authorizeIpcMessage operation matrix": IPC_OPERATION_MATRIX,
  "underlyingDirectiveOperation(action) side-effect matrix": UNDERLYING_DIRECTIVE_OPERATIONS,
};

// codex-chat currently has no enforced crm.*, projects.*, or calendar.*
// chokepoints in src/. Those families should be added here only when a generic
// store-evaluated runtime path starts asking authorize() about those ids.
const STORE_EVALUATED_OPERATIONS = new Set<string>();

interface ExtractionResult {
  operations: Set<string>;
  unsupported: string[];
}

describe("capability registry", () => {
  test("has unique ids and valid metadata shape", () => {
    expect(capabilityRegistry.length).toBeGreaterThan(0);
    expect(capabilityRegistryById.size).toBe(capabilityRegistry.length);

    for (const entry of capabilityRegistry) {
      expect(entry.id).toMatch(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]+)+$/);
      expect(entry.family).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(entry.description.trim()).toBe(entry.description);
      expect(entry.description).not.toBe("");
      expect(entry.selectorKeys.length).toBeGreaterThan(0);
      expect(new Set(entry.selectorKeys).size).toBe(entry.selectorKeys.length);
      expect(["low", "medium", "high"]).toContain(entry.riskTier);
    }
  });

  test("matches operation ids used by runtime authorization chokepoints", async () => {
    const extracted = await extractAuthorizeOperations();
    expect(extracted.unsupported).toEqual([]);

    const registryIds = new Set(capabilityRegistry.map((entry) => entry.id));
    const missingFromRegistry = [...extracted.operations].filter((id) => !registryIds.has(id)).sort();
    expect(missingFromRegistry).toEqual([]);

    const unusedRegistryEntries = capabilityRegistry
      .filter((entry) => !entry.deprecated)
      .filter((entry) => !extracted.operations.has(entry.id) && !STORE_EVALUATED_OPERATIONS.has(entry.id))
      .map((entry) => entry.id)
      .sort();
    expect(unusedRegistryEntries).toEqual([]);
  });

  test("output selector metadata is backed by outputResource keys", () => {
    const target: OutputTarget = {
      id: "target-1",
      surfaceKind: "slack",
      teamId: "T1",
      channelId: "C1",
      chatId: "123",
      threadId: "1700000000.000100",
      messageId: "1700000000.000200",
      routingPolicy: "source_reply",
      allowedOutputTypes: ["text", "image", "document", "reaction", "progress", "artifact"],
    };
    const resource = outputResource(target, "text");
    const actualKeys = new Set(Object.keys(resource).filter((key) => resource[key] !== undefined));
    const outputEntries = capabilityRegistry.filter((entry) => entry.id.startsWith("output."));

    for (const entry of outputEntries) {
      const unsupported = entry.selectorKeys.filter((key) => !actualKeys.has(key));
      expect(unsupported, `${entry.id} advertised keys not populated by outputResource()`).toEqual([]);
    }
  });
});

async function extractAuthorizeOperations(): Promise<ExtractionResult> {
  const operations = new Set<string>();
  const unsupported: string[] = [];
  const files = (await listTypeScriptFiles(sourceRoot))
    .filter((file) => !relative(sourceRoot, file).startsWith("__tests__/"))
    .filter((file) => !file.endsWith(join("src", "capabilities.ts")));

  for (const file of files) {
    const text = await readFile(file, "utf8");
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    visitSourceFile(sourceFile, operations, unsupported);
  }

  return { operations, unsupported: unsupported.sort() };
}

async function listTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listTypeScriptFiles(path));
    else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }
  return files;
}

function visitSourceFile(sourceFile: ts.SourceFile, operations: Set<string>, unsupported: string[]): void {
  const visit = (node: ts.Node, enclosingFunction: string | undefined): void => {
    const nextEnclosingFunction = functionLikeName(node) ?? enclosingFunction;
    if (ts.isCallExpression(node)) {
      collectCallExpression(sourceFile, node, operations, unsupported, nextEnclosingFunction);
    }

    ts.forEachChild(node, (child) => visit(child, nextEnclosingFunction));
  };

  visit(sourceFile, undefined);
}

function collectCallExpression(sourceFile: ts.SourceFile, node: ts.CallExpression, operations: Set<string>, unsupported: string[], enclosingFunction: string | undefined): void {
  const name = callName(node.expression);
  if (!name) return;

  if (name === "authorizeAndRecord" || name === "authorizeServiceCommand") {
    collectOperationExpression(sourceFile, node.arguments[1], operations, unsupported, enclosingFunction);
    return;
  }

  if (name === "authorize" || name === "authorizeOrThrow") {
    const requirement = node.arguments[1];
    if (requirement && ts.isObjectLiteralExpression(requirement)) {
      collectOperationExpression(sourceFile, objectProperty(requirement, "operation"), operations, unsupported, enclosingFunction);
    } else if (requirement && ts.isCallExpression(requirement) && callName(requirement.expression) === "requirementForInboundEvent") {
      collectOperationExpression(sourceFile, requirement.arguments[1], operations, unsupported, enclosingFunction);
    } else {
      unsupported.push(`${location(sourceFile, node)} ${name} call with unsupported requirement shape: ${requirement?.getText(sourceFile) ?? "missing"}`);
    }
    return;
  }

  if (name === "authorizeOutput") {
    collectAuthorizeOutputOperation(sourceFile, node, operations, unsupported, enclosingFunction);
    return;
  }

  if (name === "requirementForInboundEvent") {
    collectOperationExpression(sourceFile, node.arguments[1], operations, unsupported, enclosingFunction);
    return;
  }

  if (name === "outOfScopeAllowedDecision") {
    const input = node.arguments[0];
    if (input && ts.isObjectLiteralExpression(input)) {
      collectOperationExpression(sourceFile, objectProperty(input, "operation"), operations, unsupported, enclosingFunction);
    }
  }
}

function collectAuthorizeOutputOperation(sourceFile: ts.SourceFile, node: ts.CallExpression, operations: Set<string>, unsupported: string[], enclosingFunction: string | undefined): void {
  const input = node.arguments[0];
  if (!input || !ts.isObjectLiteralExpression(input)) {
    unsupported.push(`${location(sourceFile, node)} authorizeOutput call without an object literal`);
    return;
  }

  const explicitOperation = objectProperty(input, "operation");
  if (explicitOperation) {
    collectOperationExpression(sourceFile, explicitOperation, operations, unsupported, enclosingFunction);
    return;
  }

  const outputType = literalText(objectProperty(input, "outputType"));
  if (!outputType) {
    unsupported.push(`${location(sourceFile, node)} authorizeOutput call without a literal outputType`);
    return;
  }

  operations.add(outputType === "reaction" ? "output.reaction.add" : `output.${outputType}.send`);
}

function collectOperationExpression(sourceFile: ts.SourceFile, expression: ts.Expression | undefined, operations: Set<string>, unsupported: string[], enclosingFunction: string | undefined): void {
  if (!expression) {
    unsupported.push(`${location(sourceFile, sourceFile)} missing operation expression`);
    return;
  }

  const literal = literalText(expression);
  if (literal) {
    operations.add(literal);
    return;
  }

  if (ts.isConditionalExpression(expression)) {
    collectOperationExpression(sourceFile, expression.whenTrue, operations, unsupported, enclosingFunction);
    collectOperationExpression(sourceFile, expression.whenFalse, operations, unsupported, enclosingFunction);
    return;
  }

  const text = expression.getText(sourceFile).replace(/\s+/g, " ");
  if (text === "operation" && (enclosingFunction === "authorizeAndRecord" || enclosingFunction === "authorizeServiceCommand")) {
    return;
  }
  if (text === "receiveOperation" || text === "`${event.source}.event.receive`") {
    addExpansion("UserEvent.source receive operation from `${event.source}.event.receive`", operations);
    return;
  }
  if (text === "`directive.${action.type}.execute`") {
    addExpansion("Directive action operation from `directive.${action.type}.execute`", operations);
    return;
  }
  if (text === "`employees.manage.${employeeCommand.action}`") {
    addExpansion("Employee command operation from `employees.manage.${employeeCommand.action}`", operations);
    return;
  }
  if (text === "underlyingOperation") {
    addExpansion("underlyingDirectiveOperation(action) side-effect matrix", operations);
    return;
  }
  if (text === "operation" && relative(sourceRoot, sourceFile.fileName) === "service.ts" && enclosingFunction === "authorizeIpcMessage") {
    addExpansion("Local IPC authorizeIpcMessage operation matrix", operations);
    return;
  }

  unsupported.push(`${location(sourceFile, expression)} unsupported dynamic operation expression: ${text}`);
}

function addExpansion(reason: keyof typeof DYNAMIC_OPERATION_EXPANSIONS, operations: Set<string>): void {
  for (const operation of DYNAMIC_OPERATION_EXPANSIONS[reason]) operations.add(operation);
}

function callName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function functionLikeName(node: ts.Node): string | undefined {
  if (!ts.isFunctionDeclaration(node) && !ts.isMethodDeclaration(node) && !ts.isFunctionExpression(node)) return undefined;
  const name = node.name;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

function objectProperty(node: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  for (const property of node.properties) {
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === key) return property.name;
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    if ((ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === key) return property.initializer;
  }
  return undefined;
}

function literalText(expression: ts.Expression | undefined): string | undefined {
  if (!expression) return undefined;
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  return undefined;
}

function location(sourceFile: ts.SourceFile, node: ts.Node): string {
  const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${relative(sourceRoot, sourceFile.fileName)}:${pos.line + 1}`;
}

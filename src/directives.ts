import { z } from "zod";

const routeSchema = z.enum(["return_to_main", "send_to_user", "send_progress_and_return", "send_to_admins", "store_only", "silent"]);

const baseAction = z.object({
  type: z.string(),
  idempotencyKey: z.string().min(1).optional()
});

const sendTextAction = baseAction.extend({
  type: z.literal("send_text"),
  chatId: z.number().int().optional(),
  text: z.string().min(1),
  replyToMessageId: z.number().int().optional(),
  format: z.enum(["text", "markdownv2"]).optional()
});

const sendImageAction = baseAction.extend({
  type: z.literal("send_image"),
  chatId: z.number().int().optional(),
  path: z.string().optional(),
  fileId: z.string().optional(),
  caption: z.string().optional(),
  asDocument: z.boolean().optional(),
  replyToMessageId: z.number().int().optional()
}).refine((value) => value.path || value.fileId, "send_image requires path or fileId");

const sendDocumentAction = baseAction.extend({
  type: z.literal("send_document"),
  chatId: z.number().int().optional(),
  path: z.string(),
  caption: z.string().optional(),
  replyToMessageId: z.number().int().optional()
});

const dispatchSubagentAction = baseAction.extend({
  type: z.literal("dispatch_subagent"),
  profile: z.string().min(1),
  prompt: z.string().min(1),
  route: routeSchema.default("return_to_main"),
  timeoutSec: z.number().int().positive().optional(),
  summary: z.string().min(1).optional(),
  model: z.string().optional(),
  effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  images: z.array(z.string()).optional()
});

const cancelJobAction = baseAction.extend({
  type: z.literal("cancel_job"),
  jobId: z.string().min(1)
});

const notifyOwnerAction = baseAction.extend({
  type: z.literal("notify_owner"),
  text: z.string().min(1)
});

const enqueueMainAction = baseAction.extend({
  type: z.literal("enqueue_main"),
  text: z.string().min(1),
  route: routeSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const reactAction = baseAction.extend({
  type: z.literal("react"),
  chatId: z.number().int().optional(),
  messageId: z.number().int(),
  emoji: z.string().min(1)
});

export const directiveActionSchema = z.discriminatedUnion("type", [
  sendTextAction,
  sendImageAction,
  sendDocumentAction,
  dispatchSubagentAction,
  cancelJobAction,
  notifyOwnerAction,
  enqueueMainAction,
  reactAction
]);

export const directiveBlockSchema = z.object({
  version: z.literal(1),
  actions: z.array(directiveActionSchema).min(1)
});

export type DirectiveAction = z.infer<typeof directiveActionSchema>;
export type DirectiveBlock = z.infer<typeof directiveBlockSchema>;

export interface DirectiveParseResult {
  cleanText: string;
  blocks: DirectiveBlock[];
  errors: string[];
}

const directiveFence = /```codex-chat\s*([\s\S]*?)```/g;

export function parseDirectives(text: string): DirectiveParseResult {
  const blocks: DirectiveBlock[] = [];
  const errors: string[] = [];
  const cleanText = text.replace(directiveFence, (_match, body: string) => {
    try {
      const parsed = JSON.parse(body);
      const block = directiveBlockSchema.parse(parsed);
      for (const action of block.actions) {
        if (action.type !== "enqueue_main" && !action.idempotencyKey) {
          errors.push(`Directive action ${action.type} is missing idempotencyKey`);
        }
      }
      blocks.push(block);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    return "";
  }).trim();
  return { cleanText, blocks, errors };
}


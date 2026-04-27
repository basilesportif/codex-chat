import { describe, expect, test } from "vitest";
import { isTelegramAdmin, isTelegramUserAllowed } from "../telegram.js";

describe("telegram allowlist", () => {
  test("allows a numeric user ID when chat policy matches", () => {
    expect(isTelegramUserAllowed({
      userId: 1001,
      chatId: 2002,
      configUserIds: [1001],
      configChatIds: [2002]
    })).toBe(true);
  });

  test("denies users outside the allowlist", () => {
    expect(isTelegramUserAllowed({
      userId: 9999,
      chatId: 2002,
      configUserIds: [1001],
      configChatIds: [2002]
    })).toBe(false);
  });

  test("empty allowlist denies all users", () => {
    expect(isTelegramUserAllowed({
      userId: 1001,
      chatId: 2002,
      configUserIds: [],
      configChatIds: []
    })).toBe(false);
  });

  test("detects admins from config and paired state", () => {
    expect(isTelegramAdmin({ userId: 1001, configAdminUserIds: [1001] })).toBe(true);
    expect(isTelegramAdmin({
      userId: 1002,
      configAdminUserIds: [],
      stateUsers: [{ userId: 1002, isAdmin: true }]
    })).toBe(true);
    expect(isTelegramAdmin({ userId: 1003, configAdminUserIds: [1001] })).toBe(false);
  });
});

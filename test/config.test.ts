import { describe, expect, it } from "vitest";
import { parseConfig, ConfigError } from "../src/config";
import { MailboxError, toToolError } from "../src/errors";
import type { Env } from "../src/env";

const mk = (vars: Record<string, string | undefined> = {}) => vars as unknown as Env;

describe("parseConfig", () => {
  it("returns defaults for empty vars", () => {
    expect(parseConfig(mk())).toEqual({
      deleteOnAck: true,
      ttlDays: 7,
      maxUnread: 10,
      auditLogBodies: false,
      blockedSenderFeedback: "silent",
      oauthRedirectAllowlist: ["https://claude.ai/api/mcp/auth_callback"],
    });
  });

  it("treats empty strings as defaults", () => {
    expect(parseConfig(mk({ MAX_UNREAD: "", DELETE_ON_ACK: "" })).maxUnread).toBe(10);
  });

  it("parses booleans", () => {
    expect(parseConfig(mk({ DELETE_ON_ACK: "false" })).deleteOnAck).toBe(false);
    expect(parseConfig(mk({ AUDIT_LOG_BODIES: "true" })).auditLogBodies).toBe(true);
    expect(() => parseConfig(mk({ DELETE_ON_ACK: "yes" }))).toThrow(ConfigError);
    expect(() => parseConfig(mk({ DELETE_ON_ACK: "yes" }))).toThrow(/DELETE_ON_ACK/);
  });

  it("parses TTL days", () => {
    expect(parseConfig(mk({ MESSAGE_TTL_DAYS: "0" })).ttlDays).toBe(0);
    expect(() => parseConfig(mk({ MESSAGE_TTL_DAYS: "-1" }))).toThrow(/MESSAGE_TTL_DAYS/);
    expect(() => parseConfig(mk({ MESSAGE_TTL_DAYS: "abc" }))).toThrow(/MESSAGE_TTL_DAYS/);
  });

  it("requires MAX_UNREAD >= 1", () => {
    expect(parseConfig(mk({ MAX_UNREAD: "3" })).maxUnread).toBe(3);
    expect(() => parseConfig(mk({ MAX_UNREAD: "0" }))).toThrow(/MAX_UNREAD/);
  });

  it("parses blocked sender feedback", () => {
    expect(parseConfig(mk({ BLOCKED_SENDER_FEEDBACK: "reject" })).blockedSenderFeedback).toBe("reject");
    expect(() => parseConfig(mk({ BLOCKED_SENDER_FEEDBACK: "loud" }))).toThrow(/BLOCKED_SENDER_FEEDBACK/);
  });

  it("parses the redirect allowlist", () => {
    expect(
      parseConfig(mk({ OAUTH_REDIRECT_ALLOWLIST: "https://a/cb, https://b/cb" })).oauthRedirectAllowlist,
    ).toEqual(["https://a/cb", "https://b/cb"]);
  });
});

describe("toToolError", () => {
  it("maps MailboxError", () => {
    const e = new MailboxError("rate_limited", "slow down", "wait", 5);
    expect(toToolError(e)).toEqual({ code: "rate_limited", message: "slow down", hint: "wait", retry_after: 5 });
  });

  it("omits retry_after when absent", () => {
    expect(toToolError(new MailboxError("blocked", "m", "h"))).not.toHaveProperty("retry_after");
  });

  it("hides unknown errors as internal", () => {
    const r = toToolError(new Error("secret"));
    expect(r.code).toBe("internal");
    expect(JSON.stringify(r)).not.toContain("secret");
  });
});

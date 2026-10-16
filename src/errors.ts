export type ErrorCode =
  | "unknown_recipient"
  | "blocked"
  | "inbox_full"
  | "too_large"
  | "invalid_input"
  | "invalid_reply_to"
  | "not_found"
  | "rate_limited"
  | "unauthorized"
  | "internal";

export class MailboxError extends Error {
  code: ErrorCode;
  hint: string;
  retryAfter?: number;
  constructor(code: ErrorCode, message: string, hint: string, retryAfter?: number) {
    super(message);
    this.name = "MailboxError";
    this.code = code;
    this.hint = hint;
    this.retryAfter = retryAfter;
  }
}

export interface ToolError {
  code: ErrorCode;
  message: string;
  hint: string;
  retry_after?: number;
}

export function toToolError(e: unknown): ToolError {
  if (e instanceof MailboxError) {
    const out: ToolError = { code: e.code, message: e.message, hint: e.hint };
    if (e.retryAfter !== undefined) out.retry_after = e.retryAfter;
    return out;
  }
  return { code: "internal", message: "Internal error.", hint: "Retry later; if it persists, contact the operator." };
}

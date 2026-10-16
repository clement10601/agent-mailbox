import type { ZodRawShape } from "zod";

export interface ToolDef {
  description: string;
  schema: ZodRawShape;
  // Arguments have already been validated against `schema` by the MCP layer.
  handler: (args: any) => Promise<unknown>;
}

export type ToolSet = Record<string, ToolDef>;

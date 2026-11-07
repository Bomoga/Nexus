import type { ModelInfo, ModelRole } from "../contracts";

// The provider-neutral surface the agent loop and the model picker program against (PLAN L1-03).
// No SDK imports here. Keys are call parameters, never fields (CLAUDE.md §14).

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;       // JSON Schema for the tool arguments
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
  /** Opaque provider data that must travel back with this call (e.g. Gemini thought signatures). The loop never reads it. */
  providerMeta?: unknown;
}

export type TurnMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string; isError?: boolean };

export interface TurnRequest {
  modelId: string;
  role: ModelRole;
  system: string;
  messages: TurnMessage[];
  tools: ToolDef[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "cancelled";

export type TurnEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown; providerMeta?: unknown }
  | { type: "done"; usage: Usage; stopReason: StopReason }
  | { type: "error"; message: string };

export interface Provider {
  /** Matches ProviderAccount.provider and ModelInfo.provider. */
  readonly id: string;
  /** Lists the models this key can use. Throws ProviderAuthError on a rejected key. */
  listModels(apiKey: string): Promise<ModelInfo[]>;
  /** One model turn. Yields text deltas and tool calls, then exactly one `done` (or an `error`). */
  turn(req: TurnRequest, apiKey: string): AsyncIterable<TurnEvent>;
}

/** Thrown by listModels when the provider rejects the key; the accounts service maps it to status "invalid". */
export class ProviderAuthError extends Error {
  constructor(message = "provider rejected the API key") {
    super(message);
    this.name = "ProviderAuthError";
  }
}

/**
 * Whether a model may serve a role. Swarms is text-only and never drives the code-editing agent (§6, Tier 2);
 * the agent role also needs tool calling.
 */
export function roleEligible(model: Pick<ModelInfo, "provider" | "supportsTools">, role: ModelRole): boolean {
  if (role === "agent") return model.provider !== "swarms" && model.supportsTools;
  return true;
}

/** Collects a turn into its text, tool calls and terminal event; handy for tests and for text-only roles. */
export async function collectTurn(events: AsyncIterable<TurnEvent>): Promise<{ text: string; toolCalls: ToolCall[]; done?: Extract<TurnEvent, { type: "done" }>; error?: string }> {
  let text = "";
  const toolCalls: ToolCall[] = [];
  let done: Extract<TurnEvent, { type: "done" }> | undefined;
  let error: string | undefined;
  for await (const e of events) {
    if (e.type === "text_delta") text += e.text;
    else if (e.type === "tool_call") toolCalls.push({ id: e.id, name: e.name, args: e.args, ...(e.providerMeta !== undefined ? { providerMeta: e.providerMeta } : {}) });
    else if (e.type === "done") done = e;
    else error = e.message;
  }
  return { text, toolCalls, done, error };
}

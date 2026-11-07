import type { ModelInfo } from "../contracts";
import { DEFAULT_AGENT_MODEL, SwarmsClient, SwarmsUnavailable } from "../features/swarms/swarms-client";
import { redact } from "../shared/redact";
import type { Provider, TurnEvent, TurnMessage, TurnRequest } from "./provider";

// Swarms as a text-only provider (PLAN L1-17): briefs, summaries and approval wording. It never serves the coding
// agent: no tool calling, and the agent role is refused here as well as in roleEligible (CLAUDE.md §6, Tier 2).

export const SWARMS_MODEL_ID = "swarms:single-agent";

export function createSwarmsProvider(client: SwarmsClient = new SwarmsClient(), opts: { budgetKey?: () => string | undefined } = {}): Provider {
  return {
    id: "swarms",

    async listModels(apiKey: string): Promise<ModelInfo[]> {
      await client.checkKey(apiKey);                         // a real call: a saved key alone never means connected
      return [{ provider: "swarms", modelId: SWARMS_MODEL_ID, displayName: "Swarms (text only)", supportsTools: false }];
    },

    async *turn(req: TurnRequest, apiKey: string): AsyncIterable<TurnEvent> {
      if (req.role === "agent") {
        yield { type: "error", message: "Swarms is a text-only provider and cannot drive the coding agent." };
        return;
      }
      if (req.signal?.aborted) { yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "cancelled" }; return; }
      const modelName = req.modelId.startsWith("swarms:") && req.modelId !== SWARMS_MODEL_ID ? req.modelId.slice("swarms:".length) : DEFAULT_AGENT_MODEL;
      try {
        const { text } = await client.complete({ apiKey, sessionId: opts.budgetKey?.(), system: req.system, task: transcript(req.messages), modelName, maxTokens: req.maxTokens });
        if (text.length > 0) yield { type: "text_delta", text };
        yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "end_turn" };
      } catch (e) {
        if (req.signal?.aborted) { yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "cancelled" }; return; }
        yield { type: "error", message: e instanceof SwarmsUnavailable ? e.message : redact(e instanceof Error ? e.message : "Swarms request failed") };
      }
    },
  };
}

/** Text roles send a single user message; if there is history, flatten it into one task. */
function transcript(messages: readonly TurnMessage[]): string {
  if (messages.length === 1 && messages[0].role === "user") return messages[0].content;
  return messages.map(m => (m.role === "user" ? `User: ${m.content}` : m.role === "assistant" ? `Assistant: ${m.content}` : `Tool result: ${m.content}`)).join("\n\n");
}

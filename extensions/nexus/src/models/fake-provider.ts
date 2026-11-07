import { fx } from "../contracts/fixtures";
import type { ModelInfo } from "../contracts";
import type { Provider, TurnEvent, TurnRequest } from "./provider";

// Deterministic provider for tests and offline runs: replays a scripted sequence of turns, no network (PLAN L1-03).

const usage = { inputTokens: 100, outputTokens: 50 };
const call = (id: string, name: string, args: unknown): TurnEvent => ({ type: "tool_call", id, name, args });

/**
 * The demo fix: read src/cart.ts, write the fix, ask to run the tests, commit, summarise.
 * Tool names are the ones exposed to the model by the agent runtime (PLAN L1-09).
 */
export const FAKE_AGENT_SCRIPT: TurnEvent[][] = [
  [
    { type: "text_delta", text: "Reading src/cart.ts" },
    call("tc_1", "read_file", { path: "src/cart.ts" }),
    { type: "done", usage, stopReason: "tool_use" },
  ],
  [
    call("tc_2", "write_file", { path: "src/cart.ts", content: "<fixed cart.ts>" }),
    { type: "done", usage, stopReason: "tool_use" },
  ],
  [
    call("tc_3", "run_command", { command: "npm test" }),
    { type: "done", usage, stopReason: "tool_use" },
  ],
  [
    call("tc_4", "commit", { message: "fix cart discount for qty > 1" }),
    { type: "done", usage, stopReason: "tool_use" },
  ],
  [
    { type: "text_delta", text: "Fixed the discount so it applies per unit; tests pass." },
    { type: "done", usage, stopReason: "end_turn" },
  ],
];

export interface FakeProviderOptions {
  id?: string;
  script?: TurnEvent[][];
  models?: ModelInfo[];
  /** When set, listModels rejects with this error (e.g. a ProviderAuthError). */
  listError?: Error;
}

export class FakeProvider implements Provider {
  readonly id: string;
  /** Every request seen, in order, so tests can assert on what the loop sent. */
  readonly requests: TurnRequest[] = [];
  /** Every key seen by turn()/listModels(), so tests can assert keys are per-call. */
  readonly keysSeen: string[] = [];
  private turnIndex = 0;
  private readonly script: TurnEvent[][];
  private readonly models: ModelInfo[];
  private readonly listError?: Error;

  constructor(opts: FakeProviderOptions = {}) {
    this.id = opts.id ?? "anthropic";
    this.script = opts.script ?? FAKE_AGENT_SCRIPT;
    this.models = opts.models ?? fx.models.filter(m => m.provider === this.id);
    this.listError = opts.listError;
  }

  async listModels(apiKey: string): Promise<ModelInfo[]> {
    this.keysSeen.push(apiKey);
    if (this.listError) throw this.listError;
    return this.models.map(m => ({ ...m }));
  }

  async *turn(req: TurnRequest, apiKey: string): AsyncIterable<TurnEvent> {
    this.keysSeen.push(apiKey);
    this.requests.push(req);
    if (req.signal?.aborted) {
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "cancelled" };
      return;
    }
    const events = this.script[this.turnIndex++];
    if (!events) {
      yield { type: "error", message: "fake provider script exhausted" };
      return;
    }
    for (const e of events) {
      if (req.signal?.aborted) {
        yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "cancelled" };
        return;
      }
      yield e;
    }
  }
}

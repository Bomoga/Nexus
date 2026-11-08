import { describe, expect, it, vi } from "vitest";
import { SYSTEM_RULES } from "../agent/prompt-framing";
import { fx } from "../contracts/fixtures";
import { FAKE_AGENT_SCRIPT, FakeProvider } from "../models/fake-provider";
import { FakeGate } from "./fake-gate";
import { AgentRuntime, type SessionStart } from "./runtime";

const start = (over: Partial<SessionStart> = {}): SessionStart => ({
  session: { id: fx.session.id, taskId: fx.task.id, branch: fx.session.branch, worktreePath: fx.session.worktreePath, baseCommit: fx.session.baseCommit, model: fx.session.model },
  task: fx.task, systemRules: SYSTEM_RULES, untrustedBlocks: [], ...over,
});

function setup(approvals: "auto" | "manual" = "auto") {
  const gate = new FakeGate({ files: { "src/cart.ts": "export const total = 1;\n" }, approvals });
  const provider = new FakeProvider();
  const runtime = new AgentRuntime({ providers: { anthropic: provider }, gate });
  return { gate, provider, runtime };
}

const userTexts = (messages: Array<{ role: string; content: string }>) => messages.filter(m => m.role === "user").map(m => m.content);

describe("AgentRuntime follow-up messages", () => {
  it("takes a message sent while the agent works at its next model call", async () => {
    const s = setup("manual");
    s.runtime.start(start());
    await vi.waitFor(() => expect(s.gate.pendingApprovals).toHaveLength(1));            // blocked on run_command's approval
    expect(s.runtime.message(fx.session.id, "also cover the empty cart")).toBe(true);
    s.gate.resolveApproval("apr_1", "approved");
    await vi.waitFor(() => expect(s.gate.pendingApprovals).toHaveLength(1));
    s.gate.resolveApproval("apr_2", "approved");
    await s.runtime.whenIdle();
    const calls = s.provider.requests.map(r => userTexts(r.messages as never));
    expect(calls[0]).toHaveLength(1);                                                   // the brief only
    const later = calls.find(c => c.some(t => t.includes("also cover the empty cart")));
    expect(later).toBeDefined();
    expect(calls.at(-1)!.at(-1)).toBe("also cover the empty cart");                     // kept in the conversation to the end
  });

  it("answers a message that arrives during the last turn instead of finishing", async () => {
    const s = setup();
    const usage = { inputTokens: 1, outputTokens: 1 };
    (s.provider as unknown as { script: unknown[] }).script = [...FAKE_AGENT_SCRIPT, [{ type: "text_delta", text: "Done, and the extra thing too." }, { type: "done", usage, stopReason: "end_turn" }]];
    const out = await (async () => {
      let sent = false;
      const orig = s.provider.turn.bind(s.provider);
      s.provider.turn = (req, key) => {
        if (!sent && req.messages.some(m => m.role === "tool" && m.content.includes("committed"))) { sent = true; s.runtime.message(fx.session.id, "one more thing"); }
        return orig(req, key);
      };
      s.runtime.start(start());
      return s.runtime.whenIdle();
    })();
    expect(out!.outcome).toBe("done");
    expect(s.provider.requests.at(-1)!.messages.some(m => m.role === "user" && m.content.includes("one more thing"))).toBe(true);
    expect(out!.turns).toBeGreaterThan(5);                                              // the scripted run is 5 turns; the follow-up added one
  });

  it("refuses a message for a session that is not running", async () => {
    const s = setup();
    expect(s.runtime.message(fx.session.id, "hello")).toBe(false);
    s.runtime.start(start());
    await s.runtime.whenIdle();
    expect(s.runtime.message(fx.session.id, "too late")).toBe(false);
    expect(s.runtime.message("ses_other", "no")).toBe(false);
  });

  it("starts a resumed session from the history and the new message, roles alternating", async () => {
    const s = setup();
    s.runtime.start(start({ resume: { history: [{ role: "assistant", text: "I fixed it." }, { role: "assistant", text: "Tests pass." }, { role: "user", text: "thanks" }], message: "now add a test" } }));
    await s.runtime.whenIdle();
    const first = s.provider.requests[0].messages;
    expect(first.map(m => m.role)).toEqual(["user", "assistant", "user"]);
    expect(first[0].content).toContain(fx.task.title);
    expect(first[1].content).toBe("I fixed it.\n\nTests pass.");
    expect(first[2].content).toBe("thanks\n\nnow add a test");
  });
});

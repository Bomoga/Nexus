import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "../contracts";
import { safeCommandUi, safeMessageUi, safeNotifyPort } from "./notify-safe";

const EVIL = "[APPROVE](command:workbench.action.quit)";
const noBrackets = (s: string) => expect(s).not.toMatch(/[[\]]/);

function recordingPort() {
  const calls: Array<{ kind: string; text: string }> = [];
  let choice: ((d: "approved" | "rejected") => void) | undefined;
  return {
    calls,
    fire: (d: "approved" | "rejected") => choice?.(d),
    port: {
      show: (_a: ApprovalRequest, text: string, onChoice: (d: "approved" | "rejected") => void) => { calls.push({ kind: "show", text }); choice = onChoice; },
      update: (_id: string, text: string) => { calls.push({ kind: "update", text }); },
    },
  };
}

describe("safeNotifyPort", () => {
  it("removes ASCII brackets from show and update, and still reports the choice", () => {
    const r = recordingPort();
    const decisions: string[] = [];
    const port = safeNotifyPort(r.port);
    port.show({} as ApprovalRequest, `Agent wants ${EVIL}`, d => decisions.push(d));
    port.update("a1", EVIL);
    r.calls.forEach(c => noBrackets(c.text));
    r.fire("approved");
    expect(decisions).toEqual(["approved"]);
  });

  it("blanks the RTL override and leaves plain text unchanged", () => {
    const r = recordingPort();
    const port = safeNotifyPort(r.port);
    port.update("a1", "a\u202Eb");
    port.update("a1", "Plain text, 42 files.");
    expect(r.calls[0].text).toBe("a b");
    expect(r.calls[1].text).toBe("Plain text, 42 files.");
  });

  it("is stable under double application, including a caller's own truncation", () => {
    const r = recordingPort();
    const once = safeNotifyPort(r.port);
    const twice = safeNotifyPort(safeNotifyPort(r.port));
    once.update("a", EVIL); twice.update("a", EVIL);
    expect(r.calls[1].text).toBe(r.calls[0].text);
    const cut = "x".repeat(300) + "…";
    once.update("a", cut);
    expect(r.calls[2].text).toBe(cut);
  });
});

describe("safeMessageUi", () => {
  it("sanitises info and error and keeps other members working", async () => {
    const seen: string[] = [];
    const ui = safeMessageUi({ info: (m: string) => { seen.push(m); }, error: (m: string) => { seen.push(m); }, ask: async () => 7 });
    ui.info(EVIL); ui.error(EVIL);
    seen.forEach(noBrackets);
    expect(await ui.ask()).toBe(7);
  });
});

describe("safeCommandUi", () => {
  it("sanitises info, error and pickApproval label and detail, and returns the chosen id", async () => {
    const seen: string[] = [];
    let items: Array<{ id: string; label: string; detail: string }> = [];
    const ui = safeCommandUi({
      info: m => { seen.push(m); }, error: m => { seen.push(m); },
      pickApproval: async i => { items = i; return i[1].id; },
    });
    ui.info(EVIL); ui.error(`a\u202Eb ${EVIL}`);
    const id = await ui.pickApproval([{ id: "one", label: EVIL, detail: EVIL }, { id: "two", label: "plain", detail: "d" }]);
    expect(id).toBe("two");
    [...seen, items[0].label, items[0].detail].forEach(noBrackets);
    expect(items[1]).toEqual({ id: "two", label: "plain", detail: "d" });
    expect(items[0].id).toBe("one");
  });
});

import { describe, expect, it } from "vitest";
import { startPruneStatus } from "./prune-status";

describe("startPruneStatus", () => {
  it("shows the readout, follows receipts and setting changes, hides it when there is nothing to show, and stops on dispose", async () => {
    let text: string | undefined = undefined;
    const receipt = new Set<() => void>(), setting = new Set<() => void>();
    const shown: Array<string | undefined> = [];
    const optimizer = {
      statusText: async () => text,
      subscribe: (cb: () => void) => { receipt.add(cb); return () => { receipt.delete(cb); }; },
      onSettingChange: (cb: () => void) => { setting.add(cb); return () => { setting.delete(cb); }; },
    };
    const stop = startPruneStatus(optimizer as never, { set: t => shown.push(t) });
    await Promise.resolve(); await Promise.resolve();
    expect(shown).toEqual([undefined]);                                   // off and nothing spent: hidden
    text = "PRUNE $0.0000 · saved $0.0000";
    [...setting].forEach(cb => cb());
    await Promise.resolve(); await Promise.resolve();
    expect(shown.at(-1)).toBe("PRUNE $0.0000 · saved $0.0000");           // turning it on shows it
    text = "PRUNE $0.0123 · saved $0.0210";
    [...receipt].forEach(cb => cb());
    await Promise.resolve(); await Promise.resolve();
    expect(shown.at(-1)).toBe("PRUNE $0.0123 · saved $0.0210");           // a receipt updates it
    stop();
    expect(receipt.size + setting.size).toBe(0);
    const n = shown.length;
    text = "later";
    expect(shown.length).toBe(n);
  });

  it("reports a read failure instead of throwing", async () => {
    const errors: string[] = [];
    const optimizer = { statusText: async () => { throw new Error("store down"); }, subscribe: () => () => {}, onSettingChange: () => () => {} };
    startPruneStatus(optimizer as never, { set: () => {} }, m => errors.push(m));
    await new Promise(r => setTimeout(r, 0));
    expect(errors[0]).toContain("store down");
  });
});

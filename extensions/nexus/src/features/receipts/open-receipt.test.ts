import { describe, expect, test, vi } from "vitest";
import { isHttpsUrl, openReceipt } from "./open-receipt";
import type { OpenReceiptDeps, ReceiptLink } from "./open-receipt";

function deps(link?: ReceiptLink | Error, over: Partial<OpenReceiptDeps> = {}) {
  const d = {
    receipts: {
      openReceipt: vi.fn(async () => {
        if (link instanceof Error) throw link;
        return link ?? { verifyUrl: "https://withprune.com/verify", metadataJson: '{"sig":"abc"}', message: "The signed receipt is on your clipboard." };
      }),
    },
    askReceiptId: vi.fn(async () => "rcpt_typed"),
    copy: vi.fn(async () => undefined),
    openExternal: vi.fn(async () => true),
    info: vi.fn(),
    error: vi.fn(),
    ...over,
  };
  return d;
}

describe("openReceipt", () => {
  test("copies the signed receipt, opens Prune's verify page and says what to do", async () => {
    const d = deps();
    await openReceipt(d, "rcpt_01", "ses_01");
    expect(d.receipts.openReceipt).toHaveBeenCalledWith("rcpt_01", "ses_01");
    expect(d.copy).toHaveBeenCalledWith('{"sig":"abc"}');
    expect(d.openExternal).toHaveBeenCalledWith("https://withprune.com/verify");
    expect(d.info).toHaveBeenCalledWith("Nexus: The signed receipt is on your clipboard.");
  });

  test("without signed metadata nothing is copied, the page still opens", async () => {
    const d = deps({ verifyUrl: "https://withprune.com/verify", message: "paste it from your dashboard" });
    await openReceipt(d, "rcpt_01");
    expect(d.copy).not.toHaveBeenCalled();
    expect(d.openExternal).toHaveBeenCalledOnce();
  });

  test("asks for an id when none is given; cancelling does nothing", async () => {
    const asked = deps();
    await openReceipt(asked);
    expect(asked.receipts.openReceipt).toHaveBeenCalledWith("rcpt_typed", undefined);
    const cancelled = deps(undefined, { askReceiptId: vi.fn(async () => undefined) });
    await openReceipt(cancelled);
    expect(cancelled.receipts.openReceipt).not.toHaveBeenCalled();
    expect(cancelled.error).not.toHaveBeenCalled();
  });

  test("a malformed id is refused before any lookup", async () => {
    const d = deps();
    await openReceipt(d, "rcpt 01; rm -rf /");
    expect(d.receipts.openReceipt).not.toHaveBeenCalled();
    expect(d.error).toHaveBeenCalledOnce();
  });

  test("never opens a non-https address", async () => {
    for (const verifyUrl of ["http://withprune.com/verify", "javascript:alert(1)", "file:///c:/x", "not a url"]) {
      const d = deps({ verifyUrl, message: "m" });
      await openReceipt(d, "rcpt_01");
      expect(d.openExternal, verifyUrl).not.toHaveBeenCalled();
      expect(d.error, verifyUrl).toHaveBeenCalledOnce();
    }
    expect(isHttpsUrl("https://withprune.com/verify")).toBe(true);
  });

  test("an unknown receipt shows a sanitised error", async () => {
    const d = deps(new Error("No such receipt. [x](command:evil)"));
    await openReceipt(d, "rcpt_01");
    const msg = String(vi.mocked(d.error).mock.calls[0][0]);
    expect(msg).toContain("No such receipt.");
    expect(msg).not.toMatch(/\[|\]/);
    expect(d.openExternal).not.toHaveBeenCalled();
  });

  test("says receipts aren't connected when Lane 1's optimizer wasn't passed in", async () => {
    const d = deps(undefined, { receipts: undefined });
    await openReceipt(d, "rcpt_01");
    expect(d.error).toHaveBeenCalledWith(expect.stringContaining("aren't connected yet"));
    expect(d.askReceiptId).not.toHaveBeenCalled();
  });
});

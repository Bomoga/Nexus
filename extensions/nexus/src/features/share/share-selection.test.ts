import { describe, expect, test, vi } from "vitest";
import { fx } from "../../contracts/fixtures";
import { registerShareSelection, shareSelection } from "./share-selection";
import type { ShareDeps } from "./share-selection";

type PostArg = { channelId: string; text: string; threadTs?: string; clientId: string };

function deps(over: Record<string, unknown> = {}) {
  const d = {
    getSelection: vi.fn(() => ({ path: "src/cart.ts", startLine: 42, endLine: 48 })),
    createRef: vi.fn(async () => ({ ref: fx.codeRef, link: "nexus://coderef/ws_demo/abc/42-48/src%2Fcart.ts", snippet: "return a;" })),
    listChannels: vi.fn(async () => fx.channels),
    showQuickPick: vi.fn(async (items: { label: string }[]) => items[0]),
    showInputBox: vi.fn(async () => undefined),
    post: vi.fn(async (a: PostArg) => ({ ...fx.thread.messages[0], channelId: a.channelId, text: a.text })),
    showInfo: vi.fn(),
    showError: vi.fn(),
    revealChat: vi.fn(),
    ...over,
  };
  return d as unknown as ShareDeps & typeof d;
}

const fence = "`".repeat(3);

describe("shareSelection", () => {
  test("posts link and fenced snippet to the chosen channel and reveals it", async () => {
    const d = deps();
    await shareSelection(d);
    expect(d.createRef).toHaveBeenCalledWith("src/cart.ts", 42, 48);
    const arg = d.post.mock.calls[0][0] as PostArg;
    expect(arg.channelId).toBe(fx.channels[0].id);
    expect(arg.threadTs).toBeUndefined();
    expect(arg.text).toBe(`nexus://coderef/ws_demo/abc/42-48/src%2Fcart.ts\n${fence}\nreturn a;\n${fence}`);
    expect(arg.clientId).toBeTruthy();
    expect(d.revealChat).toHaveBeenCalledWith(fx.channels[0].id, undefined);
  });

  test("a fence inside the snippet cannot close ours; clientIds differ per call", async () => {
    const d = deps({ createRef: vi.fn(async () => ({ ref: fx.codeRef, link: "L", snippet: `a\n${fence}\nrm -rf\n${fence}` })) });
    await shareSelection(d);
    await shareSelection(d);
    const [a, b] = d.post.mock.calls.map((c) => c[0] as PostArg);
    const body = a.text.split("\n").slice(2, -1).join("\n");
    expect(body).not.toContain(fence);
    expect(a.text.endsWith(`\n${fence}`)).toBe(true);
    expect(a.clientId).not.toBe(b.clientId);
  });

  test("reply in a thread uses the entered ts", async () => {
    const d = deps({
      showQuickPick: vi.fn(async (items: { label: string }[]) => items.find((i) => /thread/i.test(i.label)) ?? items[0]),
      showInputBox: vi.fn(async () => "1762485300.000100"),
    });
    await shareSelection(d);
    expect((d.post.mock.calls[0][0] as PostArg).threadTs).toBe("1762485300.000100");
    expect(d.revealChat).toHaveBeenCalledWith(fx.channels[0].id, "1762485300.000100");
  });

  test("no selection: error, no requests", async () => {
    const d = deps({ getSelection: vi.fn(() => undefined) });
    await shareSelection(d);
    expect(d.showError).toHaveBeenCalled();
    expect(d.createRef).not.toHaveBeenCalled();
    expect(d.post).not.toHaveBeenCalled();
  });

  test("cancelled pick posts nothing", async () => {
    const d = deps({ showQuickPick: vi.fn(async () => undefined) });
    await shareSelection(d);
    expect(d.post).not.toHaveBeenCalled();
    expect(d.showError).not.toHaveBeenCalled();
  });

  test("post failure shows an error", async () => {
    const d = deps({
      post: vi.fn(async () => {
        throw new Error("rate limited");
      }),
    });
    await shareSelection(d);
    expect(d.showError).toHaveBeenCalledWith(expect.stringContaining("rate limited"));
    expect(d.revealChat).not.toHaveBeenCalled();
  });

  test("registerShareSelection registers the command id", () => {
    const registerCommand = vi.fn(() => ({ dispose() {} }));
    const context = { subscriptions: [] as unknown[] };
    registerShareSelection(context as never, { ...deps(), registerCommand } as never);
    expect(registerCommand).toHaveBeenCalledWith("nexus.shareSelectionToSlack", expect.any(Function));
    expect(context.subscriptions).toHaveLength(1);
  });
});

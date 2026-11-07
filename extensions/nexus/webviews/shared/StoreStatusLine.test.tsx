// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { Envelope } from "../../src/contracts";
import { createBridgeClient } from "./bridgeClient";
import type { Transport } from "./bridgeClient";
import { StoreStatusLine } from "./StoreStatusLine";

afterEach(cleanup);

function host(status: (() => unknown) | "fail") {
  const handlers = new Set<(e: Envelope) => void>();
  const subs: string[] = [];
  const transport: Transport = {
    listen(h) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    post(env) {
      if (env.t === "sub" && env.name === "store.subscribe") subs.push(env.id);
      if (env.t !== "req" || env.name !== "store.status") return;
      queueMicrotask(() =>
        handlers.forEach((h) =>
          status === "fail"
            ? h({ t: "res", id: env.id, ok: false, error: { code: "not_found", message: "no handler" } })
            : h({ t: "res", id: env.id, ok: true, body: status() }),
        ),
      );
    },
  };
  const emit = (body: unknown) => act(() => subs.forEach((id) => handlers.forEach((h) => h({ t: "evt", id, body }))));
  return { bridge: createBridgeClient(transport), emit };
}

describe("StoreStatusLine", () => {
  test("renders nothing while online", async () => {
    const { bridge } = host(() => ({ online: true, outboxDepth: 0 }));
    const { container } = render(<StoreStatusLine bridge={bridge} />);
    await act(async () => undefined);
    expect(container.textContent).toBe("");
  });

  test("offline shows the line with the queue depth, and omits a zero queue", async () => {
    const a = host(() => ({ online: false, outboxDepth: 3 }));
    render(<StoreStatusLine bridge={a.bridge} />);
    expect(await screen.findByText("offline · showing this machine's copy · 3 queued")).toBeTruthy();
    cleanup();
    const b = host(() => ({ online: false, outboxDepth: 0 }));
    render(<StoreStatusLine bridge={b.bridge} />);
    expect(await screen.findByText("offline · showing this machine's copy")).toBeTruthy();
  });

  test("store.subscribe flips the line on and off", async () => {
    const h = host(() => ({ online: true, outboxDepth: 0 }));
    render(<StoreStatusLine bridge={h.bridge} />);
    await act(async () => undefined);
    h.emit({ online: false, outboxDepth: 2 });
    expect(await screen.findByText(/offline/)).toBeTruthy();
    h.emit({ online: true, outboxDepth: 0 });
    await waitFor(() => expect(screen.queryByText(/offline/)).toBeNull());
  });

  test("a failing store.status renders nothing", async () => {
    const { bridge } = host("fail");
    const { container } = render(<StoreStatusLine bridge={bridge} />);
    await act(async () => undefined);
    expect(container.textContent).toBe("");
  });
});

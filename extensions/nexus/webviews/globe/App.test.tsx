// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Envelope, NexusEvent } from "../../src/contracts";
import { fx } from "../../src/contracts/fixtures";
import { createBridgeClient } from "../shared";
import type { Transport } from "../shared";
import { App } from "./App";

// The WebGL scene and the global-bridge live hook are not under test here.
vi.mock("./scene/Scene", () => ({ Scene: ({ events }: { events: unknown[] }) => <div data-testid="scene">{events.length}</div> }));
vi.mock("./scene/live", () => ({ useLiveEvents: () => undefined, useDriftNow: () => () => Date.now(), markLive: () => undefined }));

afterEach(cleanup);

/** A local host: `events.query` is answered by `query`, which may throw a coded error. */
function setup(query: () => NexusEvent[] | { code: string }, hit?: NexusEvent) {
  const handlers = new Set<(e: Envelope) => void>();
  let queries = 0;
  const transport: Transport = {
    listen(h) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    post(env) {
      if (env.t !== "req") return;
      queueMicrotask(() => {
        let res: Envelope;
        if (env.name === "events.query") {
          queries++;
          const out = query();
          res = Array.isArray(out)
            ? { t: "res", id: env.id, ok: true, body: out }
            : { t: "res", id: env.id, ok: false, error: { code: out.code as "not_found", message: "no handler for events.query" } };
        } else if (env.name === "events.search" && hit) {
          res = { t: "res", id: env.id, ok: true, body: [{ event: hit, score: 1 }] };
        } else {
          res = { t: "res", id: env.id, ok: false, error: { code: "not_found", message: env.name } };
        }
        handlers.forEach((h) => h(res));
      });
    },
  };
  return { bridge: createBridgeClient(transport), queries: () => queries };
}

describe("globe App states", () => {
  test("a not_found events.query shows the friendly line and RETRY re-requests", async () => {
    let answer: NexusEvent[] | { code: string } = { code: "not_found" };
    const h = setup(() => answer);
    render(<App bridge={h.bridge} />);
    expect(await screen.findByText("events isn't connected yet")).toBeTruthy();
    expect(screen.queryByText(/no handler/)).toBeNull();
    const before = h.queries();
    answer = [{ ...fx.event, at: new Date().toISOString() }];
    fireEvent.click(screen.getByRole("button", { name: "RETRY" }));
    await waitFor(() => expect(screen.queryByText("events isn't connected yet")).toBeNull());
    expect(h.queries()).toBe(before + 1);
  });

  test("an empty window shows one line", async () => {
    const h = setup(() => []);
    render(<App bridge={h.bridge} />);
    expect(await screen.findByText("no events in this window")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "RETRY" })).toBeNull();
  });

  test("STOP TRACKING shows ESC and Escape stops tracking", async () => {
    const e: NexusEvent = { ...fx.event, id: "tracked", title: "tracked event", at: new Date().toISOString() };
    const h = setup(() => [e], e);
    render(<App bridge={h.bridge} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Search events" }), { target: { value: "tracked" } });
    const list = await screen.findByRole("listbox", { name: "Search results" }, { timeout: 2000 });
    const row = within(list).getByRole("option");
    fireEvent.mouseDown(row);
    const stop = await screen.findByRole("button", { name: /STOP TRACKING/ });
    expect(stop.textContent).toContain("ESC");
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("button", { name: /STOP TRACKING/ })).toBeNull());
  });

  test("after a search pick with focus still in the search box, Escape stops tracking; an open dropdown only closes", async () => {
    const e: NexusEvent = { ...fx.event, id: "tracked", title: "tracked event", at: new Date().toISOString() };
    const h = setup(() => [e], e);
    render(<App bridge={h.bridge} />);
    const box = screen.getByRole("combobox", { name: "Search events" });
    box.focus();
    fireEvent.change(box, { target: { value: "tracked" } });
    await screen.findByRole("listbox", { name: "Search results" }, { timeout: 2000 });
    // Escape with the dropdown open closes it and leaves tracking alone.
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Search results" })).toBeNull();
    expect(screen.queryByRole("button", { name: /STOP TRACKING/ })).toBeNull();
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByRole("button", { name: /STOP TRACKING/ });
    expect(document.activeElement).toBe(box);
    fireEvent.keyDown(box, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("button", { name: /STOP TRACKING/ })).toBeNull());
  });
});

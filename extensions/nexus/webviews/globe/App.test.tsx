// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Envelope, NexusEvent } from "../../src/contracts";
import { fx } from "../../src/contracts/fixtures";
import { createBridgeClient } from "../shared";
import type { Transport } from "../shared";
import { App } from "./App";

// The WebGL scene and the global-bridge live hook are not under test here.
vi.mock("./scene/Scene", () => ({ Scene: ({ events, now }: { events: unknown[]; now: number }) => <div data-testid="scene" data-now={now}>{events.length}</div> }));
vi.mock("./scene/live", () => ({ useLiveEvents: () => undefined, useDriftNow: () => () => Date.now(), markLive: () => undefined }));

afterEach(cleanup);

/** A local host: `events.query` is answered by `query`, which may throw a coded error. */
function setup(query: () => NexusEvent[] | { code: string }, hit?: NexusEvent, hits?: () => NexusEvent[]) {
  const handlers = new Set<(e: Envelope) => void>();
  let queries = 0;
  let activityRequests = 0;
  const requested: string[] = [];
  const transport: Transport = {
    listen(h) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    post(env) {
      if (env.t !== "req") return;
      requested.push(env.name);
      queueMicrotask(() => {
        let res: Envelope;
        if (env.name === "events.query") {
          queries++;
          const out = query();
          res = Array.isArray(out)
            ? { t: "res", id: env.id, ok: true, body: out }
            : { t: "res", id: env.id, ok: false, error: { code: out.code as "not_found", message: "no handler for events.query" } };
        } else if (env.name === "events.search" && (hit || hits)) {
          const found = hits ? hits() : [hit as NexusEvent];
          res = { t: "res", id: env.id, ok: true, body: found.map((event) => ({ event, score: 1 })) };
        } else if (env.name === "events.activity") {
          activityRequests++;
          res = { t: "res", id: env.id, ok: true, body: [{ bucketStart: new Date(Date.now() - 30 * 60_000).toISOString(), orbit: "main", count: 2 }] };
        } else if (env.name === "ui.openTarget") {
          res = { t: "res", id: env.id, ok: true, body: {} };
        } else {
          res = { t: "res", id: env.id, ok: false, error: { code: "not_found", message: env.name } };
        }
        handlers.forEach((h) => h(res));
      });
    },
  };
  return { bridge: createBridgeClient(transport), queries: () => queries, activity: () => activityRequests, opens: () => requested.filter((n) => n === "ui.openTarget").length };
}

describe("globe App activity strip", () => {
  const sceneNow = () => Number(screen.getByTestId("scene").getAttribute("data-now"));

  test("clicking a bar pins the globe to the past, BACK TO LIVE returns to the live clock", async () => {
    const h = setup(() => [{ ...fx.event, at: new Date().toISOString() }]);
    const { container } = render(<App bridge={h.bridge} />);
    const svg = (await waitFor(() => {
      const el = container.querySelector("svg.globe-activity-svg");
      if (!el) throw new Error("no strip yet");
      return el;
    })) as SVGSVGElement;
    expect(screen.queryByRole("button", { name: "BACK TO LIVE" })).toBeNull();
    const live = sceneNow();
    svg.getBoundingClientRect = () => ({ left: 0, width: 1000, top: 0, height: 30, right: 1000, bottom: 30, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.click(svg, { clientX: 1 });
    await screen.findByRole("button", { name: "BACK TO LIVE" });
    // the first column of the 36 h window ends about 35.75 h before now
    expect(live - sceneNow()).toBeGreaterThan(35 * 3_600_000);
    fireEvent.click(screen.getByRole("button", { name: "BACK TO LIVE" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "BACK TO LIVE" })).toBeNull());
    expect(live - sceneNow()).toBeLessThan(60_000);
  });

  test("picking a search result newer than the pinned time returns to live and tracks it (no 'outside' notice)", async () => {
    const recent: NexusEvent = { ...fx.event, id: "recent", title: "recent event", at: new Date().toISOString() };
    const h = setup(() => [recent], recent);
    const { container } = render(<App bridge={h.bridge} />);
    const svg = (await waitFor(() => {
      const el = container.querySelector("svg.globe-activity-svg");
      if (!el) throw new Error("no strip yet");
      return el;
    })) as SVGSVGElement;
    svg.getBoundingClientRect = () => ({ left: 0, width: 1000, top: 0, height: 30, right: 1000, bottom: 30, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.click(svg, { clientX: 1 });
    await screen.findByRole("button", { name: "BACK TO LIVE" });
    fireEvent.change(screen.getByRole("combobox", { name: "Search events" }), { target: { value: "recent" } });
    const list = await screen.findByRole("listbox", { name: "Search results" }, { timeout: 2000 });
    fireEvent.mouseDown(within(list).getByRole("option"));
    await screen.findByRole("button", { name: /STOP TRACKING/ });
    expect(screen.queryByRole("button", { name: "BACK TO LIVE" })).toBeNull();
    expect(screen.queryByText(/outside the 30d window/)).toBeNull();
  });

  test("a window change re-queries the activity", async () => {
    const h = setup(() => []);
    render(<App bridge={h.bridge} />);
    await waitFor(() => expect(h.activity()).toBe(1));
    fireEvent.click(within(screen.getByRole("group", { name: "Time window" })).getByRole("button", { name: "24H" }));
    await waitFor(() => expect(h.activity()).toBe(2));
  });
});

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

  test("after a search pick, Enter in the search box opens the event; after typing again, Enter picks a result instead", async () => {
    const e: NexusEvent = { ...fx.event, id: "tracked", title: "tracked event", at: new Date().toISOString() };
    const h = setup(() => [e], e);
    render(<App bridge={h.bridge} />);
    const box = screen.getByRole("combobox", { name: "Search events" });
    box.focus();
    fireEvent.change(box, { target: { value: "tracked" } });
    await screen.findByRole("listbox", { name: "Search results" }, { timeout: 2000 });
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByRole("button", { name: /STOP TRACKING/ });
    expect(h.opens()).toBe(0); // the pick itself opens nothing
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(h.opens()).toBe(1));
    // A new query: Enter belongs to the search again, not to OPEN.
    fireEvent.change(box, { target: { value: "tracked again" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.opens()).toBe(1);
  });

  test("Escape with zero search hits reaches the page on the first press (stops tracking)", async () => {
    const e: NexusEvent = { ...fx.event, id: "tracked", title: "tracked event", at: new Date().toISOString() };
    let found: NexusEvent[] = [e];
    const h = setup(() => [e], undefined, () => found);
    render(<App bridge={h.bridge} />);
    const box = screen.getByRole("combobox", { name: "Search events" });
    box.focus();
    fireEvent.change(box, { target: { value: "tracked" } });
    await screen.findByRole("listbox", { name: "Search results" }, { timeout: 2000 });
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByRole("button", { name: /STOP TRACKING/ });
    // A new query that finds nothing: no dropdown is visible, so the first Escape stops tracking.
    found = [];
    fireEvent.change(box, { target: { value: "zzz" } });
    await new Promise((r) => setTimeout(r, 300));
    expect(box.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(box, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("button", { name: /STOP TRACKING/ })).toBeNull());
  });
});

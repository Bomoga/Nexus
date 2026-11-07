// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { Envelope, NexusEvent } from "../../src/contracts";
import { fx } from "../../src/contracts/fixtures";
import { createBridgeClient } from "../shared";
import type { Transport } from "../shared";
import { App } from "./App";
import { PLOT_W, laneCenterY, xFor } from "./model";
import { windowMs } from "../globe/model";

afterEach(cleanup);

type Req = Extract<Envelope, { t: "req" }>;
type Answers = Record<string, (body: Record<string, unknown>) => unknown>;

const NOW = Date.parse("2026-11-08T15:00:00Z");
const H = 3_600_000;
const SHA = (n: number) => String(n).repeat(40).slice(0, 40);
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * H).toISOString();
const ev = (over: Partial<NexusEvent>): NexusEvent => ({ ...fx.event, ...over });
const commit = (id: string, orbit: string, hoursAgo: number, title = id): NexusEvent =>
  ev({ id, kind: "commit", orbit, at: at(hoursAgo), title, target: { type: "commit", sha: SHA(id.length) } });

const EVENTS: NexusEvent[] = [
  commit("c-main", "main", 2, "main commit"),
  commit("c-l1", "lane-1", 6, "lane one commit"),
  commit("c-l2", "lane-2", 10, "lane two commit"),
  ev({ id: "m-1", kind: "merge", orbit: "main", fromOrbit: "lane-2", at: at(4), title: "merge lane-2 into main", target: { type: "commit", sha: SHA(7) } }),
  ev({ id: "s-1", kind: "agent_session", orbit: "lane-1", at: at(3), title: "agent session", target: { type: "session", sessionId: "ses_01" } }),
];
const OLD = commit("c-old", "main", 72, "three days old commit");

/** A local host: events.query filters by the requested window; subscriptions are driven by emit. */
function setup(events: NexusEvent[] = EVENTS, answers: Answers = {}) {
  const handlers = new Set<(e: Envelope) => void>();
  const posted: Envelope[] = [];
  const subs = new Map<string, string>();
  const defaults: Answers = {
    "events.query": (b) => events.filter((e) => Date.parse(e.at) >= Date.parse(String(b.from)) && Date.parse(e.at) <= Date.parse(String(b.to))),
    "events.search": () => [{ event: OLD, score: 1 }],
    "ui.openTarget": () => ({}),
    "ui.setTimeWindow": () => ({}),
  };
  const transport: Transport = {
    listen(h) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    post(env) {
      posted.push(env);
      if (env.t === "sub") subs.set(env.id, env.name);
      if (env.t !== "req") return;
      const fn = answers[env.name] ?? defaults[env.name];
      queueMicrotask(() => {
        let res: Envelope;
        try {
          res = fn ? { t: "res", id: env.id, ok: true, body: fn(env.body as Record<string, unknown>) } : { t: "res", id: env.id, ok: false, error: { code: "not_found", message: env.name } };
        } catch (e) {
          res = { t: "res", id: env.id, ok: false, error: { code: "internal", message: e instanceof Error ? e.message : String(e) } };
        }
        handlers.forEach((h) => h(res));
      });
    },
  };
  const emit = (name: string, body: unknown) =>
    act(() => {
      for (const [id, n] of subs) if (n === name) handlers.forEach((h) => h({ t: "evt", id, body }));
    });
  const reqs = (name: string) => posted.filter((e): e is Req => e.t === "req" && e.name === name);
  const subbed = (name: string) => posted.filter((e) => e.t === "sub" && e.name === name);
  return { bridge: createBridgeClient(transport), emit, reqs, subbed };
}

const marks = () => screen.queryAllByTestId("mark");
const markFor = (id: string) => marks().find((m) => m.getAttribute("data-event-id") === id)!;
const loaded = async (count: number) => waitFor(() => expect(marks().length).toBe(count));

describe("timeline view", () => {
  test("one lane per branch family, main first, with its name in the gutter", async () => {
    const { bridge } = setup();
    render(<App bridge={bridge} nowMs={NOW} />);
    await loaded(4);
    expect(screen.getAllByTestId("lane-label").map((l) => l.textContent)).toEqual(["main", "lane-1", "lane-2"]);
  });

  test("queries the current window and places marks at the x of their time", async () => {
    const { bridge, reqs } = setup();
    render(<App bridge={bridge} nowMs={NOW} />);
    await loaded(4);
    expect(reqs("events.query")[0].body).toMatchObject({ from: new Date(NOW - windowMs("36h")).toISOString() });
    const x = Number(markFor("c-main").getAttribute("data-cx"));
    expect(x).toBeCloseTo(xFor(NOW - 2 * H, NOW, windowMs("36h"), PLOT_W), 6);
    expect(Number(markFor("c-l2").getAttribute("data-cx"))).toBeLessThan(Number(markFor("c-l1").getAttribute("data-cx")));
    expect(Number(markFor("c-main").getAttribute("data-cy"))).toBe(laneCenterY(0));
    expect(Number(markFor("c-l2").getAttribute("data-cy"))).toBe(laneCenterY(2));
  });

  test("a merge connects its source lane to its target lane", async () => {
    const { bridge } = setup();
    render(<App bridge={bridge} nowMs={NOW} />);
    await loaded(4);
    const merge = screen.getByTestId("merge");
    expect(merge.getAttribute("data-from")).toBe("lane-2");
    expect(merge.getAttribute("data-to")).toBe("main");
    expect(Number(merge.getAttribute("data-from-y"))).toBe(laneCenterY(2));
    expect(Number(merge.getAttribute("data-to-y"))).toBe(laneCenterY(0));
  });

  test("clicking a mark selects it and OPEN calls ui.openTarget with its target", async () => {
    const { bridge, reqs } = setup();
    render(<App bridge={bridge} nowMs={NOW} />);
    await loaded(4);
    fireEvent.click(markFor("c-l1"));
    const strip = screen.getByRole("group", { name: "Selected event" });
    expect(within(strip).getByText("lane one commit")).toBeTruthy();
    expect(screen.getByTestId("selection")).toBeTruthy();
    fireEvent.click(within(strip).getByRole("button", { name: /open/i }));
    await waitFor(() => expect(reqs("ui.openTarget").length).toBe(1));
    expect(reqs("ui.openTarget")[0].body).toEqual(EVENTS[1].target);
  });

  test("Enter opens the selected event", async () => {
    const { bridge, reqs } = setup();
    render(<App bridge={bridge} nowMs={NOW} />);
    await loaded(4);
    fireEvent.click(markFor("c-main"));
    fireEvent.keyDown(document.body, { key: "Enter" });
    await waitFor(() => expect(reqs("ui.openTarget").length).toBe(1));
    expect(reqs("ui.openTarget")[0].body).toEqual(EVENTS[0].target);
  });

  test("a search pick outside the window widens it, requeries, and selects the event", async () => {
    const { bridge, reqs } = setup([...EVENTS, OLD]);
    render(<App bridge={bridge} nowMs={NOW} />);
    await loaded(4);
    const box = screen.getByRole("combobox");
    fireEvent.change(box, { target: { value: "old" } });
    await waitFor(() => expect(reqs("events.search").length).toBe(1));
    await screen.findByRole("listbox");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect((screen.getByLabelText("Time window") as HTMLSelectElement).value).toBe("7d"));
    await waitFor(() => expect(reqs("ui.setTimeWindow")[0]?.body).toEqual({ window: "7d" }));
    await waitFor(() => expect(markFor("c-old")).toBeTruthy());
    const strip = screen.getByRole("group", { name: "Selected event" });
    expect(within(strip).getByText("three days old commit")).toBeTruthy();
    expect(screen.getByTestId("selection").getAttribute("data-event-id")).toBe("c-old");
  });

  test("a live event adds a mark without another query", async () => {
    const { bridge, emit, reqs, subbed } = setup();
    render(<App bridge={bridge} nowMs={NOW} />);
    await loaded(4);
    await waitFor(() => expect(subbed("events.subscribe").length).toBe(1));
    emit("events.subscribe", commit("c-live", "lane-1", 0, "live commit"));
    expect(marks().length).toBe(5);
    expect(reqs("events.query").length).toBe(1);
    emit("events.subscribe", commit("c-live", "lane-1", 0, "live commit"));
    expect(marks().length).toBe(5);
  });

  test("event titles are rendered literally, never as markup", async () => {
    const evil = commit("c-evil", "main", 1, "<script>alert(1)</script>");
    const { bridge } = setup([evil]);
    const { container } = render(<App bridge={bridge} nowMs={NOW} />);
    await loaded(1);
    expect(container.querySelector("script")).toBeNull();
    expect(markFor("c-evil").querySelector("title")!.textContent).toBe("<script>alert(1)</script>");
    fireEvent.click(markFor("c-evil"));
    const strip = screen.getByRole("group", { name: "Selected event" });
    expect(strip.textContent).toContain("<script>alert(1)</script>");
    expect(container.querySelector("script")).toBeNull();
  });

  test("a failing query shows an error line", async () => {
    const { bridge } = setup(EVENTS, { "events.query": () => { throw new Error("store offline"); } });
    render(<App bridge={bridge} nowMs={NOW} />);
    expect(await screen.findByText(/store offline|not_found|internal/i)).toBeTruthy();
  });

  test("shows a truncated line when the query hit the limit", async () => {
    const many = Array.from({ length: 5000 }, (_, i) => commit(`c${i}`, "main", 1 + (i % 30) / 10));
    const { bridge } = setup(many);
    render(<App bridge={bridge} nowMs={NOW} />);
    expect(await screen.findByText(/truncated/i)).toBeTruthy();
  });
});

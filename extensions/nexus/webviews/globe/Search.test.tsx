// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { EventSearchHit, NexusEvent } from "../../src/contracts";
import { fx } from "../../src/contracts/fixtures";
import { Search } from "./Search";

const SHA = "3f2a9c1e4b7d8a6f5e0c9b2a1d4f6e8c7b5a3d21";
const old: NexusEvent = { ...fx.event, id: "e-old", title: "older cart fix", at: "2026-11-07T05:00:00Z", orbit: "lane-3" };
const mid: NexusEvent = { ...fx.event, id: "e-mid", title: "middle cart fix", at: "2026-11-07T07:30:00Z", orbit: "main" };
const hit = (event: NexusEvent): EventSearchHit => ({ event, score: 1 });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const type = (value: string) => fireEvent.change(screen.getByRole("combobox"), { target: { value } });
const settle = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe("Search", () => {
  test("debounces 150 ms and sends one request for the last query", async () => {
    const search = vi.fn().mockResolvedValue([hit(old)]);
    render(<Search search={search} onPick={vi.fn()} />);
    type("ca");
    await settle(100);
    type("cart");
    await settle(100);
    expect(search).not.toHaveBeenCalled();
    await settle(60);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith("cart");
  });

  test("an empty or whitespace query sends nothing and closes the dropdown", async () => {
    const search = vi.fn().mockResolvedValue([hit(old)]);
    render(<Search search={search} onPick={vi.fn()} />);
    type("cart");
    await settle(200);
    expect(screen.getAllByRole("option")).toHaveLength(1);
    type("   ");
    await settle(200);
    expect(search).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  test("lists newest first with title, kind, orbit, T+ and short id", async () => {
    render(<Search search={() => Promise.resolve([hit(old), hit(mid)])} onPick={vi.fn()} />);
    type("cart");
    await settle(200);
    const rows = screen.getAllByRole("option");
    expect(rows[0].textContent).toContain("middle cart fix");
    expect(rows[1].textContent).toContain("older cart fix");
    expect(rows[0].textContent).toContain("commit");
    expect(rows[0].textContent).toContain("main");
    expect(rows[0].textContent).toContain("T+04:30");
    expect(rows[0].textContent).toContain(SHA.slice(0, 7));
  });

  test("Enter picks the top result and closes", async () => {
    const onPick = vi.fn();
    render(<Search search={() => Promise.resolve([hit(old), hit(mid)])} onPick={onPick} />);
    type("cart");
    await settle(200);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(mid);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  test("arrow keys move the highlight and Enter picks it", async () => {
    const onPick = vi.fn();
    render(<Search search={() => Promise.resolve([hit(old), hit(mid)])} onPick={onPick} />);
    type("cart");
    await settle(200);
    const box = screen.getByRole("combobox");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(box, { key: "ArrowUp" });
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(old);
  });

  test("Escape closes the dropdown without picking", async () => {
    const onPick = vi.fn();
    render(<Search search={() => Promise.resolve([hit(old)])} onPick={onPick} />);
    type("cart");
    await settle(200);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
  });

  test("clicking a row picks it", async () => {
    const onPick = vi.fn();
    render(<Search search={() => Promise.resolve([hit(old), hit(mid)])} onPick={onPick} />);
    type("cart");
    await settle(200);
    fireEvent.mouseDown(screen.getAllByRole("option")[1]);
    expect(onPick).toHaveBeenCalledWith(old);
  });

  test("ignores a response that arrives for an older query", async () => {
    const first = deferred<EventSearchHit[]>();
    const second = deferred<EventSearchHit[]>();
    const search = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<Search search={search} onPick={vi.fn()} />);
    type("one");
    await settle(160);
    type("two");
    await settle(160);
    await act(async () => second.resolve([hit(mid)]));
    await act(async () => first.resolve([hit(old)]));
    const rows = screen.getAllByRole("option");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("middle cart fix");
  });

  test("shows a search error as an error status line", async () => {
    render(<Search search={() => Promise.reject(new Error("store offline"))} onPick={vi.fn()} />);
    type("cart");
    await settle(200);
    expect(screen.getByText("store offline").className).toContain("nx-tone-error");
  });

  test("slash focuses the input unless typing in an input; Ctrl+F always does", () => {
    render(
      <div>
        <Search search={vi.fn()} onPick={vi.fn()} />
        <textarea aria-label="other" />
      </div>,
    );
    const box = screen.getByRole("combobox");
    fireEvent.keyDown(document.body, { key: "/" });
    expect(document.activeElement).toBe(box);
    const other = screen.getByLabelText("other");
    other.focus();
    fireEvent.keyDown(other, { key: "/" });
    expect(document.activeElement).toBe(other);
    fireEvent.keyDown(other, { key: "f", ctrlKey: true });
    expect(document.activeElement).toBe(box);
  });
});

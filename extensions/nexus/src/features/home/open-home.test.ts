import { afterEach, describe, expect, it, vi } from "vitest";
import { HOME_DEBOUNCE_MS, HomeKeeper } from "./open-home";

afterEach(() => { vi.useRealTimers(); });

function setup(opts: { tabs?: number; openHome?: () => Promise<void> } = {}) {
  vi.useFakeTimers();
  const state = { tabs: opts.tabs ?? 0 };
  const openHome = vi.fn(opts.openHome ?? (async () => { state.tabs = 1; }));
  const errors: unknown[] = [];
  const keeper = new HomeKeeper({
    tabCount: () => state.tabs, openHome,
    schedule: (fn, ms) => setTimeout(fn, ms), cancel: h => clearTimeout(h as ReturnType<typeof setTimeout>),
    onError: e => errors.push(e),
  });
  return { keeper, state, openHome, errors };
}

describe("HomeKeeper", () => {
  it("opens the home at startup when no editor is open, after the debounce", async () => {
    const s = setup();
    s.keeper.start();
    expect(s.openHome).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HOME_DEBOUNCE_MS);
    expect(s.openHome).toHaveBeenCalledTimes(1);
  });

  it("does nothing at startup when an editor is already open", async () => {
    const s = setup({ tabs: 2 });
    s.keeper.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.openHome).not.toHaveBeenCalled();
  });

  it("reopens the home when the last editor closes, and not before the debounce", async () => {
    const s = setup({ tabs: 1 });
    s.keeper.start();
    s.state.tabs = 0;
    s.keeper.tabsChanged();
    await vi.advanceTimersByTimeAsync(HOME_DEBOUNCE_MS - 1);
    expect(s.openHome).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.openHome).toHaveBeenCalledTimes(1);
  });

  it("debounces a burst of tab changes into one open", async () => {
    const s = setup();
    for (let i = 0; i < 5; i++) { s.keeper.tabsChanged(); await vi.advanceTimersByTimeAsync(50); }
    await vi.advanceTimersByTimeAsync(HOME_DEBOUNCE_MS);
    expect(s.openHome).toHaveBeenCalledTimes(1);
  });

  it("does not open if an editor appears during the debounce (closing one file while opening another)", async () => {
    const s = setup();
    s.keeper.tabsChanged();
    await vi.advanceTimersByTimeAsync(100);
    s.state.tabs = 1;
    s.keeper.tabsChanged();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.openHome).not.toHaveBeenCalled();
  });

  it("does not stack opens while one is still in flight", async () => {
    let finish: () => void = () => {};
    const s = setup({ openHome: () => new Promise<void>(r => { finish = r; }) });
    s.keeper.tabsChanged();
    await vi.advanceTimersByTimeAsync(HOME_DEBOUNCE_MS);
    s.keeper.tabsChanged();
    await vi.advanceTimersByTimeAsync(HOME_DEBOUNCE_MS);
    expect(s.openHome).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    s.state.tabs = 0;
    s.keeper.tabsChanged();
    await vi.advanceTimersByTimeAsync(HOME_DEBOUNCE_MS);
    expect(s.openHome).toHaveBeenCalledTimes(2);                      // a later empty state opens it again
  });

  it("reports a failing open without crashing or retrying in a loop", async () => {
    const s = setup({ openHome: async () => { throw new Error("command 'nexus.openHome' not found"); } });
    s.keeper.start();
    await vi.advanceTimersByTimeAsync(HOME_DEBOUNCE_MS);
    expect(s.errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.openHome).toHaveBeenCalledTimes(1);                       // retries only on the next tab change
  });

  it("stops after dispose", async () => {
    const s = setup();
    s.keeper.tabsChanged();
    s.keeper.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    s.keeper.tabsChanged();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.openHome).not.toHaveBeenCalled();
  });
});

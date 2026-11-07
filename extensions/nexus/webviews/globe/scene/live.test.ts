// @vitest-environment jsdom
import { createElement } from "react";
import type { ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DriftFrozen, useDriftNow } from "./live";

afterEach(() => vi.restoreAllMocks());

describe("useDriftNow", () => {
  test("advances with wall time while live, and stops while the globe is pinned (frozen)", () => {
    let perf = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => perf);
    const live = renderHook(() => useDriftNow(50_000));
    const frozen = renderHook(() => useDriftNow(50_000), {
      wrapper: ({ children }: { children: ReactNode }) => createElement(DriftFrozen.Provider, { value: true }, children),
    });
    perf += 5000;
    expect(live.result.current()).toBe(55_000);
    expect(frozen.result.current()).toBe(50_000);
  });
});

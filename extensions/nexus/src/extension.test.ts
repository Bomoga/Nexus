import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const receipts = { openReceipt: () => Promise.resolve({}) };
const registerLane1 = vi.fn((_c: unknown, _l2?: unknown) => { calls.push("lane1"); return { receipts }; });
const registerLane2 = vi.fn((_c: unknown): unknown => { calls.push("lane2"); return undefined; });
const registerLane3 = vi.fn((_c: unknown, _router?: unknown, _lane1?: unknown) => { calls.push("lane3"); });

vi.mock("vscode", () => ({}));
vi.mock("./register/lane-1", () => ({ registerLane1: (c: unknown, l: unknown) => registerLane1(c, l) }));
vi.mock("./register/lane-2", () => ({ registerLane2: (c: unknown) => registerLane2(c) }));
vi.mock("./register/lane-3", () => ({ registerLane3: (c: unknown, r: unknown, l: unknown) => registerLane3(c, r, l) }));

import { activate } from "./extension";

const context = { subscriptions: [] } as never;

describe("activate", () => {
  beforeEach(() => { calls.length = 0; vi.clearAllMocks(); });

  it("passes what registerLane2 returns into registerLane1, and registers Lane 2 before Lane 1", () => {
    const services = { router: {}, store: {} };
    registerLane2.mockImplementationOnce(() => { calls.push("lane2"); return services; });
    activate(context);
    expect(registerLane1).toHaveBeenCalledWith(context, services);
    expect(registerLane3).toHaveBeenCalledWith(context, services.router, { receipts });
    expect(calls).toEqual(["lane2", "lane1", "lane3"]);
  });
});

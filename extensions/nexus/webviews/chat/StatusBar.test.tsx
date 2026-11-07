// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { BridgeClient } from "../shared";
import type { SlackStatus } from "../../src/contracts";
import { StatusBar } from "./StatusBar";

afterEach(cleanup);

const client = (s: SlackStatus) => ({ request: vi.fn().mockResolvedValue(s), subscribe: vi.fn() }) as unknown as BridgeClient;
const base: SlackStatus = { connected: true, postsAs: { userId: "U1", name: "Adrian" }, userTokenSource: "token_vault", botName: "Nexus" };

describe("StatusBar", () => {
  test("says who posts and via which token source", async () => {
    render(<StatusBar bridge={client(base)} />);
    expect(await screen.findByText("posting as Adrian via token vault")).toBeTruthy();
  });

  test("manual token source", async () => {
    render(<StatusBar bridge={client({ ...base, userTokenSource: "manual" })} />);
    expect(await screen.findByText("posting as Adrian via manual")).toBeTruthy();
  });

  test("warns when postsAs is null", async () => {
    render(<StatusBar bridge={client({ ...base, postsAs: null, userTokenSource: "none" })} />);
    const el = await screen.findByText(/no user token/i);
    expect(el.className).toContain("nx-tone-pending");
  });
});

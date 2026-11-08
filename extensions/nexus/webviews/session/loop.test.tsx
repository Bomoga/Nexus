// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createBridgeClient } from "../shared";
import { createFakeTransport } from "../shared/fakeBridge";
import { App } from "./App";

afterEach(cleanup);

test.each([undefined, "ses_01"])("renders against the fake bridge without console errors (id %s)", async (id) => {
  const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const bridge = createBridgeClient(createFakeTransport({ liveIntervalMs: 20 }));
  const { container } = render(<App bridge={bridge} sessionId={id} />);
  await waitFor(() => expect(container.querySelectorAll('[data-testid="log-row"]').length).toBeGreaterThan(5), { timeout: 3000 });
  await new Promise((r) => setTimeout(r, 400));
  expect(err.mock.calls.map((c) => String(c[0]).slice(0, 120))).toEqual([]);
  err.mockRestore();
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { BridgeClient } from "../shared";
import { fx } from "../../src/contracts/fixtures";
import { CodeRefChip, codeRefLabel } from "./CodeRefChip";

afterEach(cleanup);

const clientWith = (open: (body: unknown) => Promise<unknown>) =>
  ({
    request: vi.fn(async (name: string, body: unknown) => {
      if (name === "coderef.open") return open(body);
      throw new Error(name);
    }),
    subscribe: vi.fn(),
  }) as unknown as BridgeClient;

describe("codeRefLabel", () => {
  test("range, single line and basename", () => {
    expect(codeRefLabel(fx.codeRef)).toBe("cart.ts:42-48 @3f2a9c1");
    expect(codeRefLabel({ ...fx.codeRef, startLine: 7, endLine: 7, path: "a/b/c.ts" })).toBe("c.ts:7 @3f2a9c1");
  });
});

describe("CodeRefChip", () => {
  test("renders the label and opens the ref on click", async () => {
    const client = clientWith(async () => ({ opened: "at_commit", stale: false }));
    render(<CodeRefChip codeRef={fx.codeRef} bridge={client} />);
    const btn = screen.getByRole("button", { name: /cart\.ts:42-48 @3f2a9c1/ });
    expect(btn.className).not.toContain("stale");
    fireEvent.click(btn);
    await waitFor(() => expect(client.request).toHaveBeenCalledWith("coderef.open", { ref: fx.codeRef }));
    expect(btn.className).not.toContain("stale");
  });

  test("keeps the stale outline after a stale response", async () => {
    const client = clientWith(async () => ({ opened: "at_commit", stale: true }));
    render(<CodeRefChip codeRef={fx.codeRef} bridge={client} />);
    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    await waitFor(() => expect(btn.className).toContain("chat-coderef--stale"));
  });

  test("a failed open shows the message in the tooltip and does not crash", async () => {
    const client = clientWith(async () => {
      throw new Error("no such commit");
    });
    render(<CodeRefChip codeRef={fx.codeRef} bridge={client} />);
    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    await waitFor(() => expect(btn.getAttribute("title")).toContain("no such commit"));
  });
});

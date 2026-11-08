// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { BridgeError } from "../shared";
import type { BridgeClient } from "../shared";
import { ChannelList } from "./ChannelList";
import { Composer } from "./Composer";
import { StatusBar } from "./StatusBar";

afterEach(cleanup);

const notFound = () => new BridgeError("not_found", "no handler for slack.channels");

describe("chat states", () => {
  test("a not_found channel list shows the friendly line and RETRY re-requests", async () => {
    const request = vi.fn().mockRejectedValueOnce(notFound()).mockResolvedValueOnce([{ id: "C1", name: "general", isPrivate: false, isMember: true, botIsMember: true }]);
    const client = { request, subscribe: vi.fn() } as unknown as BridgeClient;
    render(<ChannelList bridge={client} selectedId={undefined} onSelect={() => {}} />);
    expect(await screen.findByText("slack isn't connected yet")).toBeTruthy();
    expect(screen.queryByText(/no handler/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "RETRY" }));
    await screen.findByRole("button", { name: /general/ });
    expect(request).toHaveBeenCalledTimes(2);
  });

  test("a failing slack.status shows the friendly line and RETRY re-requests", async () => {
    const request = vi.fn().mockRejectedValueOnce(notFound()).mockResolvedValue({ connected: true, postsAs: { userId: "U1", name: "Adrian" }, userTokenSource: "manual", botName: "Nexus" });
    render(<StatusBar bridge={{ request, subscribe: vi.fn() } as unknown as BridgeClient} />);
    expect(await screen.findByText("slack isn't connected yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "RETRY" }));
    await waitFor(() => expect(screen.getByText("slack connected · token: manual")).toBeTruthy());
  });

  test("SEND shows its Enter hint", () => {
    render(<Composer onSend={() => {}} />);
    expect(screen.getByRole("button", { name: /SEND/ }).textContent).toContain("ENTER");
  });

  test("the composer says who a send posts as, or that it goes as the app", () => {
    const { rerender } = render(<Composer onSend={() => {}} identity={{ known: true, self: { userId: "U1", name: "adrian" } }} />);
    expect(screen.getByText("@adrian")).toBeTruthy();
    expect(screen.getByText(/posting as/)).toBeTruthy();
    rerender(<Composer onSend={() => {}} identity={{ known: true, self: undefined }} />);
    expect(screen.getByText("no user token: posts go as the app").className).toContain("chat-identity--app");
    rerender(<Composer onSend={() => {}} identity={{ known: false, self: undefined }} />);
    expect(screen.queryByText(/posting as|no user token/)).toBeNull();
  });
});

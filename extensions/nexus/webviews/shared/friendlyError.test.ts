import { describe, expect, test } from "vitest";
import { BridgeError } from "./bridgeClient";
import { friendlyError } from "./friendlyError";

describe("friendlyError", () => {
  test("maps bridge error codes to one short line", () => {
    expect(friendlyError(new BridgeError("not_found", "no handler for events.query"), "events")).toBe("events isn't connected yet");
    expect(friendlyError(new BridgeError("offline", "x"), "slack")).toBe("slack: offline, will retry");
    expect(friendlyError(new BridgeError("unauthorized", "x"), "slack")).toBe("slack: sign in to Nexus");
    expect(friendlyError(new BridgeError("provider_error", "boom"), "models")).toBe("models failed: boom");
  });

  test("other values use their message and never a stack", () => {
    const err = new Error("kaput");
    const line = friendlyError(err, "task");
    expect(line).toBe("task failed: kaput");
    expect(line).not.toContain("\n");
    expect(line).not.toContain(" at ");
    expect(friendlyError("plain", "task")).toBe("task failed: plain");
  });
});

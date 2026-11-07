import { describe, expect, it } from "vitest";
import { FakeBridgeServer } from "../../bridge/fake-bridge-server";
import { registerOpenExternal, safeExternalUrl } from "./open-external";

describe("ui.openExternal", () => {
  it("opens a plain https link once, normalized", async () => {
    const b = new FakeBridgeServer();
    const opened: string[] = [];
    registerOpenExternal(b, async u => { opened.push(u); return true; });
    expect(await b.call("ui.openExternal", { url: "https://example.com/a b?x=1" .replace(" ", "%20") })).toEqual({});
    expect(opened).toEqual(["https://example.com/a%20b?x=1"]);
  });

  it("refuses everything that is not a plain https link, and never calls the opener", async () => {
    const b = new FakeBridgeServer();
    let calls = 0;
    registerOpenExternal(b, async () => { calls++; return true; });
    for (const url of ["http://example.com", "https://user:pw@example.com", "javascript:alert(1)", "file:///etc/passwd",
      "vscode://nexus.nexus/x", "https://", `https://example.com/${"a".repeat(3000)}`, "https://exa mple.com"]) {
      await expect(b.call("ui.openExternal", { url })).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(calls).toBe(0);
  });

  it("reports a link the user declined to open as cancelled", async () => {
    const b = new FakeBridgeServer();
    registerOpenExternal(b, async () => false);
    await expect(b.call("ui.openExternal", { url: "https://example.com" })).rejects.toMatchObject({ code: "cancelled" });
  });

  it("validates again even when the contract check is bypassed", () => {
    expect(safeExternalUrl("http://example.com")).toBeNull();
    expect(safeExternalUrl("https://a:b@example.com")).toBeNull();
    expect(safeExternalUrl("https://example.com\u0007")).toBeNull();
    expect(safeExternalUrl("https://example.com/\nx")).toBeNull();
    expect(safeExternalUrl("https://example.com/ x")).toBeNull();
    expect(safeExternalUrl("https://example.com")).toBe("https://example.com/");
  });
});

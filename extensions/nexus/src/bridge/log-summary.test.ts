import { describe, expect, it } from "vitest";
import { summarizeLogDetail } from "./log-summary";

const stack = [
  "Error: slack conversations.replies failed: ratelimited",
  "    at safeError (node:internal/whatever:1:1)",
  "    at SlackWebClient.getThread (/Users/x/dev/nexus/extensions/nexus/out/services/slack/web-client.js:241:19)",
  "    at async Router.dispatch (/Users/x/dev/nexus/extensions/nexus/out/bridge/router.js:150:3)",
].join("\n");

describe("summarizeLogDetail", () => {
  it("names the type, code, first message line and the first frame in our own code", () => {
    expect(summarizeLogDetail({ name: "Error", message: "slack conversations.replies failed: ratelimited", stack, code: "E_SLACK" }))
      .toBe("Error [E_SLACK]: slack conversations.replies failed: ratelimited at services/slack/web-client.js:241");
  });

  it("follows causes, caps long messages to one line, and handles Windows paths", () => {
    const long = `line one\nline two ${"x".repeat(400)}`;
    const out = summarizeLogDetail({ name: "TypeError", message: long, stack: "TypeError: x\n    at f (C:\\dev\\nexus\\extensions\\nexus\\out\\a\\b.js:7:1)", cause: { name: "Error", message: "inner" } });
    expect(out).toMatch(/^TypeError: line one line two x+… at a\/b\.js:7; cause: Error: inner$/);
    expect(out).not.toContain("\n");
    expect(out.length).toBeLessThan(260);
  });

  it("summarizes real Error objects, strings, redacted views and nothing at all", () => {
    expect(summarizeLogDetail(new RangeError("too far"))).toMatch(/^RangeError: too far( at .+)?$/);
    expect(summarizeLogDetail("plain words")).toBe("plain words");
    expect(summarizeLogDetail({ redacted: true })).toBe("redacted");
    expect(summarizeLogDetail({ type: "number" })).toBe("number");
    expect([summarizeLogDetail(undefined), summarizeLogDetail(""), summarizeLogDetail(null)]).toEqual(["", "", ""]);
  });

  it("never throws, even on a hostile detail", () => {
    const hostile = new Proxy({}, { get() { throw new Error("boom"); } });
    expect(summarizeLogDetail(hostile)).toBe("unreadable detail");
    const deep: { name: string; message: string; cause?: unknown } = { name: "E", message: "0" };
    let cur = deep;
    for (let i = 1; i < 10; i++) { const next = { name: "E", message: String(i) }; cur.cause = next; cur = next; }
    expect(summarizeLogDetail(deep).split("cause:")).toHaveLength(4);   // depth-capped
  });
});

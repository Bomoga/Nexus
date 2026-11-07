import { describe, expect, it } from "vitest";
import { MAX_EVENT_DEPTH, MAX_EVENT_ITEMS, MAX_EVENT_STRING, MAX_EVENT_TOTAL, cleanString, clipText, sanitizeForEvent } from "./sanitize";

const SECRET = "sk-ant-api03-SECRETSECRETSECRET1234567890";

describe("sanitizeForEvent", () => {
  it("redacts and clips strings anywhere in the value, including object keys", () => {
    const out = sanitizeForEvent({ a: [`key ${SECRET}`], b: { c: "y".repeat(3000) }, [`k-${SECRET}`]: 1, n: 4, t: true, z: null }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain("SECRETSECRET");
    expect((out.b as { c: string }).c).toMatch(/…\[clipped \d+ chars\]$/);
    expect((out.b as { c: string }).c.length).toBeLessThanOrEqual(MAX_EVENT_STRING);
    expect(out.n).toBe(4);
    expect(out.t).toBe(true);
    expect(out.z).toBeNull();
  });

  it("never lets a secret survive at any depth: deeper values are replaced, not passed through", () => {
    let deep: unknown = SECRET;
    for (let i = 0; i < MAX_EVENT_DEPTH + 4; i++) deep = { next: deep };
    const text = JSON.stringify(sanitizeForEvent(deep));
    expect(text).not.toContain("SECRETSECRET");
    expect(text).toContain("[nested value omitted]");
  });

  it("caps arrays and objects and says how much was left out", () => {
    const arr = sanitizeForEvent(Array.from({ length: 500 }, (_, i) => i)) as unknown[];
    expect(arr).toHaveLength(MAX_EVENT_ITEMS + 1);
    expect(arr.at(-1)).toBe(`[+${500 - MAX_EVENT_ITEMS} more]`);
    const obj = sanitizeForEvent(Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, i]))) as Record<string, unknown>;
    expect(Object.keys(obj)).toHaveLength(MAX_EVENT_ITEMS + 1);
    expect(obj["[omitted]"]).toBe("30 more fields");
  });

  it("bounds the total size however it is spread", () => {
    const spread = Array.from({ length: 50 }, () => ({ s: "z".repeat(MAX_EVENT_STRING) }));
    const text = JSON.stringify(sanitizeForEvent(spread));
    expect(text.length).toBeLessThan(MAX_EVENT_TOTAL + 6000);
    expect(text).toContain("[omitted: event too large]");
  });

  it("drops what JSON cannot carry and turns non-finite numbers into null", () => {
    const out = sanitizeForEvent({ f: () => 1, u: undefined, s: Symbol("x"), big: 10n, nan: Number.NaN, inf: Infinity, ok: 1.5 }) as Record<string, unknown>;
    expect(out).toEqual({ nan: null, inf: null, ok: 1.5 });
    expect(sanitizeForEvent([undefined, () => 1])).toEqual([null, null]);
    expect(sanitizeForEvent(undefined)).toBeUndefined();
  });

  it("is idempotent", () => {
    const once = sanitizeForEvent({ a: `x ${SECRET}`, b: ["y".repeat(5000)] });
    expect(sanitizeForEvent(once)).toEqual(once);
  });
});

describe("helpers", () => {
  it("clipText and cleanString", () => {
    expect(clipText("abc", 5)).toBe("abc");
    expect(clipText("abcdef", 3)).toBe("…[clipped 6 chars]");
    expect(clipText("x".repeat(100), 60)).toBe(`${"x".repeat(28)}…[clipped 72 chars]`);
    expect(cleanString(`p ${SECRET}`)).toBe("p [REDACTED:anthropic-key]");
    expect(cleanString("x".repeat(400), 300).length).toBeLessThanOrEqual(300);
  });
});

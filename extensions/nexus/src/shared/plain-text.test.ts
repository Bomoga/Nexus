import { describe, expect, it } from "vitest";
import { plainNotificationText } from "./plain-text";

describe("plainNotificationText", () => {
  it("leaves ordinary text unchanged", () => {
    expect(plainNotificationText("Agent wants to run: npm test (model-written)")).toBe("Agent wants to run: npm test (model-written)");
  });

  it("turns square brackets into full-width ones so no markdown link can form", () => {
    const out = plainNotificationText("[APPROVE](command:workbench.action.quit)");
    expect(out).toBe("［APPROVE］(command:workbench.action.quit)");
    expect(out).not.toMatch(/[[\]]/);
  });

  it("blanks control and invisible format characters, including the RTL override", () => {
    expect(plainNotificationText("a\u202Eb\u0000c\nd\u200Be")).toBe("a b c d e");
    expect(plainNotificationText("x\u2028y\u2029z")).toBe("x y z");
  });

  it("cuts on code points, never in the middle of a surrogate pair", () => {
    const out = plainNotificationText("😀".repeat(10), 4);
    expect(out).toBe("😀😀😀😀…");
    expect(Array.from(out)).toHaveLength(5);
    expect(plainNotificationText("abc", 3)).toBe("abc");
  });

  it("defaults to 300 code points", () => {
    expect(Array.from(plainNotificationText("y".repeat(1000)))).toHaveLength(301);
  });
});

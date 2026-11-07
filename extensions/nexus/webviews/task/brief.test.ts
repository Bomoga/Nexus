import { describe, expect, test } from "vitest";
import { composeBrief, splitBrief } from "./brief";

describe("splitBrief", () => {
  test("the quote is the leading run of > lines, even without a blank line after it", () => {
    expect(splitBrief("> a\n> b\nRun it", true)).toEqual({ quote: "> a\n> b", rest: "Run it" });
  });
  test("a > line after the first non-quote line is not part of the quote", () => {
    expect(splitBrief("> a\n\nx\n> y", true)).toEqual({ quote: "> a", rest: "x\n> y" });
  });
  test("non-thread tasks have no quote", () => {
    expect(splitBrief("> a\n\nx", false)).toEqual({ quote: "", rest: "> a\n\nx" });
  });
  test("compose joins with a blank line", () => {
    expect(composeBrief("> a", "x")).toBe("> a\n\nx");
    expect(composeBrief("> a", "")).toBe("> a");
    expect(composeBrief("", "x")).toBe("x");
  });
});

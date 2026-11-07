import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { readLines } from "./jsonl";

function setup(maxLineChars?: number) {
  const input = new PassThrough();
  const lines: string[] = [];
  const onOverflow = vi.fn();
  const stop = readLines(input, l => lines.push(l), { maxLineChars, onOverflow });
  return { input, lines, onOverflow, stop };
}

describe("readLines", () => {
  it("joins a line split across chunks and handles several lines per chunk", () => {
    const { input, lines } = setup();
    input.write('{"a":');
    input.write('1}\n{"b":2}\n{"c"');
    input.write(":3}\n");
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it("skips empty lines and strips CR", () => {
    const { input, lines } = setup();
    input.write("a\r\n\r\n\nb\n");
    expect(lines).toEqual(["a", "b"]);
  });

  it("does not split a multi-byte character across chunks", () => {
    const { input, lines } = setup();
    const bytes = Buffer.from("€uro\n");
    input.write(bytes.subarray(0, 2));
    input.write(bytes.subarray(2));
    expect(lines).toEqual(["€uro"]);
  });

  it("flushes a final line with no newline when the stream ends", async () => {
    const { input, lines } = setup();
    input.end("last");
    await new Promise(r => setImmediate(r));
    expect(lines).toEqual(["last"]);
  });

  it("drops an over-long line, reports it once, and keeps serving later lines", () => {
    const { input, lines, onOverflow } = setup(10);
    input.write("ok\n");
    input.write("x".repeat(8));
    input.write("y".repeat(8));      // crosses the limit mid-line
    input.write("z".repeat(500));    // still the same line: discarded unbuffered
    input.write("\nafter\n");
    expect(lines).toEqual(["ok", "after"]);
    expect(onOverflow).toHaveBeenCalledTimes(1);
  });

  it("reports an endless line with no newline without buffering it", () => {
    const { input, lines, onOverflow } = setup(1000);
    for (let i = 0; i < 100; i++) input.write("q".repeat(1000));
    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([]);
  });

  it("stops reading when asked", () => {
    const { input, lines, stop } = setup();
    stop();
    input.write("a\n");
    expect(lines).toEqual([]);
  });
});

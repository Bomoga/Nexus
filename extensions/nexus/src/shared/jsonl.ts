import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

// JSON-lines framing shared by the extension host and the agent child process (PLAN L1-08).
// One JSON value per line, UTF-8, "\n" terminated. JSON.stringify never emits a raw newline, so framing is safe.

/** Calls onLine for every non-empty line on the stream; returns a function that stops reading. */
export function readLines(input: Readable, onLine: (line: string) => void): () => void {
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on("line", line => {
    if (line.length > 0) onLine(line);
  });
  return () => rl.close();
}

/** Writes one JSON value as a line. Returns false (without throwing) if the stream is already closed. */
export function writeLine(output: Writable, value: unknown): boolean {
  if (output.destroyed || output.writableEnded) return false;
  output.write(JSON.stringify(value) + "\n");
  return true;
}

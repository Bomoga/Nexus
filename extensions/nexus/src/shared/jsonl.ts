import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";

// JSON-lines framing shared by the extension host and the agent child process (PLAN L1-08).
// One JSON value per line, UTF-8, "\n" terminated. JSON.stringify never emits a raw newline, so framing is safe.

/** A line longer than this is dropped: a runaway child must not be able to grow the host's memory without bound. */
export const DEFAULT_MAX_LINE_CHARS = 8 * 1024 * 1024;

export interface ReadLinesOptions {
  maxLineChars?: number;
  /** Called once per over-long line, as soon as the limit is crossed (the rest of that line is discarded unbuffered). */
  onOverflow?: () => void;
}

/** Calls onLine for every non-empty line on the stream; returns a function that stops reading. */
export function readLines(input: Readable, onLine: (line: string) => void, opts: ReadLinesOptions = {}): () => void {
  const max = opts.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
  const decoder = new StringDecoder("utf8");
  let buf = "";
  let discarding = false;

  const append = (piece: string) => {
    if (discarding || piece.length === 0) return;
    if (buf.length + piece.length > max) {
      buf = "";
      discarding = true;
      opts.onOverflow?.();
      return;
    }
    buf += piece;
  };
  const endOfLine = () => {
    if (discarding) { discarding = false; return; }
    const line = buf.endsWith("\r") ? buf.slice(0, -1) : buf;
    buf = "";
    if (line.length > 0) onLine(line);
  };

  const onData = (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    let pos = 0;
    for (;;) {
      const nl = text.indexOf("\n", pos);
      if (nl === -1) { append(text.slice(pos)); return; }
      append(text.slice(pos, nl));
      endOfLine();
      pos = nl + 1;
    }
  };
  const onEnd = () => {
    append(decoder.end());
    if (buf.length > 0 || discarding) endOfLine();
  };
  input.on("data", onData);
  input.on("end", onEnd);
  return () => {
    input.off("data", onData);
    input.off("end", onEnd);
  };
}

/** Writes one JSON value as a line. Returns false (without throwing) if the stream is already closed. */
export function writeLine(output: Writable, value: unknown): boolean {
  if (output.destroyed || output.writableEnded) return false;
  output.write(JSON.stringify(value) + "\n");
  return true;
}

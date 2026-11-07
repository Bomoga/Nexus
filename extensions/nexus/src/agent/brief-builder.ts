import type { ChatMessage, CodeRef, Thread } from "../contracts";
import { redact } from "../shared/redact";

// Thread -> task brief (PLAN L1-11). Deterministic, no model call. Slack text is untrusted (CLAUDE.md §14): every line
// of it is emitted inside a "> "-quoted block under a fixed header, so it cannot start an unquoted line, and it is
// redacted and size-capped. Everything outside the block is fixed text or schema-validated data.

export const QUOTE_HEADER = "[slack thread, quoted, untrusted]";
export const TITLE_MAX = 60;
export const QUOTE_MAX_CHARS = 16_000;
const TRAILER = "Make the smallest change that fixes it, then run the tests before committing.";
const SAFE_PATH = /^[\w./@+-]{1,200}$/;
const MAX_REFS_SHOWN = 8;

export interface BuiltBrief {
  title: string;
  brief: string;
  codeRefs: CodeRef[];
}

// Control, zero-width and bidi characters that could hide or reorder text (code point ranges, inclusive).
const STRIPPED: Array<[number, number]> = [[0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2060, 0x2064], [0xfeff, 0xfeff]];

function cleanLine(line: string): string {
  let out = "";
  for (const ch of line) {
    const c = ch.codePointAt(0)!;
    if (!STRIPPED.some(([lo, hi]) => c >= lo && c <= hi)) out += ch;
  }
  return out;
}

function quote(message: ChatMessage): string[] {
  const who = cleanLine(message.author.name || message.author.id).replace(/[\]\r\n]/g, "").slice(0, 40) || "unknown";
  const lines = redact(message.text).replace(/\r\n?/g, "\n").split("\n").map(cleanLine);
  return lines.map((l, i) => `> ${i === 0 ? `[${who}] ` : ""}${l}`.trimEnd());
}

/** First 60 characters of the parent message on one line, limited to plain characters. */
export function titleFrom(parent: ChatMessage | undefined): string {
  const text = redact(parent?.text ?? "")
    .replace(/nexus:\/\/\S+/g, "")                                 // our own links are noise in a title
    .replace(/[^\p{L}\p{N} .,:;'"()#/_?!-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0) return "Task from Slack thread";
  return text.length <= TITLE_MAX ? text : `${text.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

export function buildBrief(thread: Thread): BuiltBrief {
  const parent = thread.messages.find(m => m.ts === thread.threadTs) ?? thread.messages[0];

  const quoted: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const m of thread.messages) {
    const lines = quote(m);
    const size = lines.reduce((n, l) => n + l.length + 1, 0);
    if (used + size > QUOTE_MAX_CHARS) { omitted++; continue; }
    quoted.push(...lines);
    used += size;
  }
  if (omitted > 0) quoted.push(`> [thread truncated: ${omitted} more message${omitted === 1 ? "" : "s"} not shown]`);

  // Unique code references across the thread, in order of first mention.
  const seen = new Set<string>();
  const refs: CodeRef[] = [];
  for (const m of thread.messages) {
    for (const r of m.codeRefs) {
      const key = `${r.commit}:${r.path}:${r.startLine}-${r.endLine}`;
      if (!seen.has(key)) { seen.add(key); refs.push(r); }
    }
  }
  // A code ref's path comes from a Slack message, so it is untrusted too: it is shown on a quoted line, only when it is a
  // plain path (no spaces or odd characters), and only a handful of them.
  const shown = refs.filter(r => SAFE_PATH.test(r.path)).slice(0, MAX_REFS_SHOWN);
  const refLine = shown.length > 0 ? `> [code refs] ${shown.map(r => `${r.path}:${r.startLine}-${r.endLine} @${r.commit.slice(0, 8)}`).join(", ")}` : undefined;
  const hidden = refs.length - shown.length;

  const brief = [
    `> ${QUOTE_HEADER}`,
    ...quoted,
    ...(refLine ? [refLine] : []),
    "",
    ...(hidden > 0 ? [`(${hidden} code reference${hidden === 1 ? "" : "s"} not shown)`] : []),
    TRAILER,
  ].join("\n");

  return { title: titleFrom(parent), brief, codeRefs: refs };
}

// Slack mrkdwn wire format -> readable plain text (L2-21). Pure and vscode-free. The output is plain text, never HTML, and the
// input is untrusted (section 14): nothing here executes or interprets it beyond rewriting Slack's <...> control sequences.

export interface NameResolvers {
  user?: (id: string) => string | undefined;
  channel?: (id: string) => string | undefined;
}

const MAX_SEQ = 4_000;   // a control sequence longer than this is treated as literal text
const USER_ID = /^[UW][A-Z0-9_]+$/;
const CHANNEL_ID = /^[CGD][A-Z0-9_]+$/;
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const ENTITY = /&(amp|lt|gt);/g;

/** Decodes exactly &amp; &lt; &gt;, in a single pass (so &amp;lt; becomes &lt;). */
function decode(s: string): string {
  return s.includes("&") ? s.replace(ENTITY, (_m, e: string) => (e === "amp" ? "&" : e === "lt" ? "<" : ">")) : s;
}

/**
 * Walks the text left to right. A control sequence is "<" up to the next ">" with no "<" in between; anything else is plain text.
 * Each scan stops at the next "<" or ">", so the whole walk is linear.
 */
function walk(raw: string, onText: (t: string) => void, onSeq: (inner: string) => void): void {
  let i = 0;
  let textStart = 0;
  while (i < raw.length) {
    const lt = raw.indexOf("<", i);
    if (lt < 0) break;
    let j = lt + 1;
    while (j < raw.length && raw[j] !== ">" && raw[j] !== "<") j++;
    if (j < raw.length && raw[j] === ">" && j - lt <= MAX_SEQ) {
      if (lt > textStart) onText(raw.slice(textStart, lt));
      onSeq(raw.slice(lt + 1, j));
      i = j + 1;
      textStart = i;
    } else {
      i = lt + 1;   // literal "<": the next scan starts after it (and at any "<" that stopped this one)
    }
  }
  if (textStart < raw.length) onText(raw.slice(textStart));
}

function splitLabel(inner: string): [string, string | undefined] {
  const bar = inner.indexOf("|");
  return bar < 0 ? [inner, undefined] : [inner.slice(0, bar), inner.slice(bar + 1)];
}

const WEB_SCHEME = /https?:\/\//i;
const WEB_SCHEME_ALL = /https?:\/\//gi;
/** The punctuation a chat view's linkifier trims off the end of a link (webviews/chat/MessageRow.tsx TRAILING_PUNCT). */
const LINK_TRAIL_ONLY = /^[.,;:!?)\]}"']+$/;
const RUN_BREAK = /[\s<>]/;
const TAIL = 7;   // "https:/" is the longest proper prefix of a scheme that can straddle a piece boundary

/**
 * Removes every http(s):// from a label, repeating until none is left (one pass could rebuild one: "hthttps://tps://"), so a
 * label can never be linkified to a host Slack's link does not go to. The real url is always shown next to it.
 */
function plainLabel(label: string): string {
  let prev: string;
  let out = label;
  do { prev = out; out = out.replace(WEB_SCHEME_ALL, ""); } while (out !== prev);
  return out;
}

/** Lowercases an http(s) scheme so a case-sensitive linkifier still links it. */
function lowerScheme(url: string): string {
  return url.replace(/^https?:\/\//i, m => m.toLowerCase());
}

function convertSeq(inner: string, names: NameResolvers | undefined): string {
  const first = inner[0];
  if (first === "@") {
    const [id, labelRaw] = splitLabel(inner.slice(1));
    if (USER_ID.test(id)) {
      const label = labelRaw === undefined ? "" : plainLabel(decode(labelRaw));
      return "@" + (label || names?.user?.(id) || id);
    }
  } else if (first === "#") {
    const [id, labelRaw] = splitLabel(inner.slice(1));
    if (CHANNEL_ID.test(id)) {
      const label = labelRaw === undefined ? "" : plainLabel(decode(labelRaw));
      return "#" + (label || names?.channel?.(id) || id);
    }
  } else if (first === "!") {
    const [cmd, labelRaw] = splitLabel(inner.slice(1));
    const label = labelRaw === undefined ? "" : plainLabel(decode(labelRaw));
    if (cmd === "here" || cmd === "channel" || cmd === "everyone") return "@" + cmd;
    if (cmd.startsWith("subteam^")) return label || "@" + plainLabel(decode(cmd.slice(8)));
    return label || plainLabel(decode(cmd));
  } else {
    const [urlRaw, labelRaw] = splitLabel(inner);
    const url = decode(urlRaw);
    const label = labelRaw === undefined ? "" : plainLabel(decode(labelRaw));
    if (/^nexus:\/\/(?:nexus\.nexus\/)?coderef\//.test(url)) return label || url;
    if (/^https?:\/\//i.test(url)) {
      const shown = lowerScheme(url);
      if (!label) return shown;
      const bare = url.replace(/^https?:\/\//i, "");
      if (label === bare || label === bare.replace(/\/$/, "")) return shown;
      return `${label} (${shown})`;
    }
    if (/^mailto:/i.test(url)) {
      const addr = url.slice(7);
      return !label || label === addr ? addr : `${label} (${addr})`;
    }
    if (SCHEME.test(url)) return label ? `${label} (${url})` : url;
  }
  return "<" + decode(inner) + ">";   // not a Slack control sequence: keep what was there
}

/**
 * Joins converted pieces so a chat view that linkifies the output (https?://[^\s<>]+ with trailing punctuation trimmed) never
 * links across a piece boundary: a space goes between two pieces when the run of text before the boundary holds a link and the
 * text after it is more than trailing punctuation, or when the two sides together would spell a new http(s)://. Ordinary
 * punctuation after a link ("see https://x.com.") is left alone. State is the current run (since the last whitespace, "<" or
 * ">"): whether it holds a scheme, and its last few characters, so joining is linear.
 */
class Joiner {
  private out = "";
  private runHasScheme = false;
  private tail = "";

  add(piece: string): void {
    if (!piece) return;
    const head = /^[^\s<>]*/.exec(piece)![0];
    if (this.out !== "" && head !== "" && this.needsGap(head)) {
      this.out += " ";
      this.runHasScheme = false;
      this.tail = "";
    }
    this.out += piece;
    let lastBreak = -1;
    for (let i = piece.length - 1; i >= 0; i--) { if (RUN_BREAK.test(piece[i]!)) { lastBreak = i; break; } }
    if (lastBreak >= 0) {
      const run = piece.slice(lastBreak + 1);
      this.runHasScheme = WEB_SCHEME.test(run);
      this.tail = run.slice(-TAIL);
    } else {
      const joined = this.tail + piece;
      this.runHasScheme = this.runHasScheme || WEB_SCHEME.test(joined);
      this.tail = joined.slice(-TAIL);
    }
  }

  private needsGap(head: string): boolean {
    if (this.runHasScheme && !LINK_TRAIL_ONLY.test(head)) return true;
    if (!this.tail) return false;
    const joined = this.tail + head.slice(0, TAIL + 1);
    for (const m of joined.matchAll(WEB_SCHEME_ALL)) {
      if (m.index < this.tail.length) return true;   // a scheme that starts before the boundary and ends after it
    }
    return false;
  }

  toString(): string { return this.out; }
}

/** Slack message text as the person would read it. Entities are decoded only in plain text and inside converted sequences. */
export function toDisplayText(raw: string, names?: NameResolvers): string {
  try {
    const j = new Joiner();
    walk(raw, t => j.add(decode(t)), inner => j.add(convertSeq(inner, names)));
    return j.toString();
  } catch {
    return raw;
  }
}

/** Ids of the users actually mentioned (<@U123>), in order of first appearance. Escaped lookalikes do not count. */
export function mentionedUserIds(raw: string, unlabeledOnly = false): string[] {
  const ids = new Set<string>();
  walk(raw, () => undefined, inner => {
    if (inner[0] !== "@") return;
    const [id, label] = splitLabel(inner.slice(1));
    if (USER_ID.test(id) && !(unlabeledOnly && label)) ids.add(id);   // a mention that carries its own label needs no lookup
  });
  return [...ids];
}

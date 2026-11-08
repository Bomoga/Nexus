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

function convertSeq(inner: string, names: NameResolvers | undefined): string {
  const first = inner[0];
  if (first === "@") {
    const [id, label] = splitLabel(inner.slice(1));
    if (USER_ID.test(id)) {
      if (label) return "@" + decode(label);
      return "@" + (names?.user?.(id) || id);
    }
  } else if (first === "#") {
    const [id, label] = splitLabel(inner.slice(1));
    if (CHANNEL_ID.test(id)) {
      if (label) return "#" + decode(label);
      return "#" + (names?.channel?.(id) || id);
    }
  } else if (first === "!") {
    const [cmd, labelRaw] = splitLabel(inner.slice(1));
    const label = labelRaw === undefined ? undefined : decode(labelRaw);
    if (cmd === "here" || cmd === "channel" || cmd === "everyone") return "@" + cmd;
    if (cmd.startsWith("subteam^")) return label || "@" + decode(cmd.slice(8));
    return label || decode(cmd);
  } else {
    const [urlRaw, labelRaw] = splitLabel(inner);
    const url = decode(urlRaw);
    const label = labelRaw === undefined ? undefined : decode(labelRaw);
    if (/^nexus:\/\/(?:nexus\.nexus\/)?coderef\//.test(url)) return label || url;
    if (/^https?:\/\//i.test(url)) {
      if (!label) return url;
      const bare = url.replace(/^https?:\/\//i, "");
      if (label === url || label === bare || label === bare.replace(/\/$/, "")) return url;
      return `${label} (${url})`;
    }
    if (/^mailto:/i.test(url)) {
      const addr = url.slice(7);
      return !label || label === addr ? addr : `${label} (${addr})`;
    }
    if (SCHEME.test(url)) return label ? `${label} (${url})` : url;
  }
  return "<" + decode(inner) + ">";   // not a Slack control sequence: keep what was there
}

/** Slack message text as the person would read it. Entities are decoded only in plain text and inside converted sequences. */
export function toDisplayText(raw: string, names?: NameResolvers): string {
  try {
    const out: string[] = [];
    walk(raw, t => out.push(decode(t)), inner => out.push(convertSeq(inner, names)));
    return out.join("");
  } catch {
    return raw;
  }
}

/** Ids of the users actually mentioned (<@U123>), in order of first appearance. Escaped lookalikes do not count. */
export function mentionedUserIds(raw: string): string[] {
  const ids = new Set<string>();
  walk(raw, () => undefined, inner => {
    if (inner[0] !== "@") return;
    const [id] = splitLabel(inner.slice(1));
    if (USER_ID.test(id)) ids.add(id);
  });
  return [...ids];
}

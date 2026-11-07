// Slack message text for a shared code reference. The snippet is repo text, untrusted for Slack.
import { encodeCodeRef, type CodeRef } from "../../contracts";

/** The most characters the whole message may have: also fits a Block Kit section's text. */
export const MAX_MESSAGE_CHARS = 3000;
const MAX_LABEL_CHARS = 200;

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const escapeMrkdwn = (s: string) => s.replace(/[&<>]/g, c => ESC[c]!);

/** `<link|path:start-end>` then the snippet in a code block that the snippet cannot close early. Never longer than MAX_MESSAGE_CHARS. */
export function formatCodeRefForSlack(ref: CodeRef, snippet: string): string {
  const rawLabel = `${ref.path}:${ref.startLine}-${ref.endLine}`;
  const label = escapeMrkdwn(rawLabel.length > MAX_LABEL_CHARS ? `…${rawLabel.slice(-MAX_LABEL_CHARS)}` : rawLabel).replace(/\|/g, "¦");
  const head = `<${encodeCodeRef(ref)}|${label}>\n\`\`\`\n`;
  const tail = "\n```";
  const ellipsis = "\n…";
  // Break every run of backticks first (zero-width spaces survive escaping), then escape and count per character.
  const safe = Array.from(snippet.replace(/`{2,}/g, m => m.split("").join("​")));
  const budget = MAX_MESSAGE_CHARS - head.length - tail.length;
  let body = "";
  let cut = false;
  for (const ch of safe) {
    const piece = ESC[ch] ?? ch;
    if (body.length + piece.length > budget - ellipsis.length) { cut = true; break; }
    body += piece;
  }
  return head + body + (cut ? ellipsis : "") + tail;
}

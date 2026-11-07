// Slack message text for a shared code reference. The snippet is repo text, untrusted for Slack.
import { encodeCodeRef, type CodeRef } from "../../contracts";

/** Raw snippet characters kept before escaping; far below Slack's 40,000-character message limit. */
export const MAX_SNIPPET_CHARS = 2000;

const escapeMrkdwn = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** `<link|path:start-end>` then the snippet in a code block that the snippet cannot close early. */
export function formatCodeRefForSlack(ref: CodeRef, snippet: string): string {
  const label = escapeMrkdwn(`${ref.path}:${ref.startLine}-${ref.endLine}`).replace(/\|/g, "¦");
  let body = snippet.length > MAX_SNIPPET_CHARS ? `${snippet.slice(0, MAX_SNIPPET_CHARS)}\n…` : snippet;
  body = escapeMrkdwn(body).replace(/`{2,}/g, m => m.split("").join("​"));
  const link = encodeCodeRef(ref);
  return `<${link}|${label}>\n\`\`\`\n${body}\n\`\`\``;
}

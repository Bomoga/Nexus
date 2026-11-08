// One-line summary of a log detail, for sinks that keep only the first console argument (the extension host's console
// forwarder drops the rest). vscode-free. The router hands its sink an already secret-checked view of an error (logView in
// router.ts: name, message, code, stack, cause), so this only shortens it: no message is ever longer than MAX_MESSAGE, and
// the stack is reduced to the first frame inside the extension's own output, as a relative path.

const MAX_MESSAGE = 160;
const MAX_DEPTH = 3;
const OWN_FRAME = /[\\/]extensions[\\/]nexus[\\/](?:out|dist)[\\/](?<file>[^\s():]+):(?<line>\d+)/;

interface ErrorView { name?: unknown; message?: unknown; code?: unknown; stack?: unknown; cause?: unknown; redacted?: unknown; type?: unknown }

function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function firstOwnFrame(stack: unknown): string | undefined {
  if (typeof stack !== "string") {
    return undefined;
  }
  for (const line of stack.split("\n").slice(1, 40)) {
    const m = OWN_FRAME.exec(line);
    if (m?.groups) {
      return `${m.groups.file.replace(/\\/g, "/")}:${m.groups.line}`;
    }
  }
  return undefined;
}

function summarize(detail: unknown, depth: number): string {
  if (detail === undefined || detail === null || detail === "") {
    return "";
  }
  if (typeof detail === "string") {
    return oneLine(detail, MAX_MESSAGE);
  }
  if (typeof detail !== "object") {
    return typeof detail;
  }
  const view = detail as ErrorView;
  if (view.redacted === true) {
    return "redacted";
  }
  const name = typeof view.name === "string" ? oneLine(view.name, 40) : undefined;
  const code = typeof view.code === "string" || typeof view.code === "number" ? oneLine(String(view.code), 60) : undefined;
  const message = typeof view.message === "string" && view.message ? oneLine(view.message, MAX_MESSAGE) : undefined;
  const at = firstOwnFrame(view.stack);
  if (!name && !code && !message && !at) {
    return typeof view.type === "string" ? view.type : "";
  }
  let out = [name, code ? `[${code}]` : undefined].filter(Boolean).join(" ");
  if (message) {
    out = out ? `${out}: ${message}` : message;
  }
  if (at) {
    out += ` at ${at}`;
  }
  if (depth < MAX_DEPTH && view.cause !== undefined) {
    const cause = summarize(view.cause, depth + 1);
    if (cause) {
      out += `; cause: ${cause}`;
    }
  }
  return out;
}

/** "TypeError [E_X]: message at services/slack/web-client.js:120; cause: …", or "" when there is nothing to say. Never throws. */
export function summarizeLogDetail(detail: unknown): string {
  try {
    return summarize(detail instanceof Error ? { name: detail.name, message: detail.message, code: (detail as { code?: unknown }).code, stack: detail.stack, cause: detail.cause } : detail, 0);
  } catch {
    return "unreadable detail";
  }
}

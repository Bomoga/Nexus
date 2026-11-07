/** One short line for a failed request; `what` is a short noun ("events", "slack"). Never a stack trace. */
export function friendlyError(e: unknown, what: string): string {
  const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
  const raw = e instanceof Error ? e.message : "";
  // Only the router's own no-handler reply means "not wired yet"; any other not_found is a real miss.
  if (code === "not_found") return /^no handler/.test(raw) ? `${what} isn't connected yet` : `${what}: not found`;
  if (code === "offline") return `${what}: offline`;
  if (code === "unauthorized") return `${what}: sign in to Nexus`;
  const message = e instanceof Error ? e.message : String(e);
  return `${what} failed: ${message.split("\n")[0]}`;
}

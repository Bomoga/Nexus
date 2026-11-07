/** One short line for a failed request; `what` is a short noun ("events", "slack"). Never a stack trace. */
export function friendlyError(e: unknown, what: string): string {
  const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
  if (code === "not_found") return `${what} isn't connected yet`;
  if (code === "offline") return `${what}: offline, will retry`;
  if (code === "unauthorized") return `${what}: sign in to Nexus`;
  const message = e instanceof Error ? e.message : String(e);
  return `${what} failed: ${message.split("\n")[0]}`;
}

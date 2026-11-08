// A status word with a dot: LIVE, RUNNING, AWAITING, DONE, FAILED. Status colors carry status only.
import type { AgentSession } from "../../src/contracts";

export type BadgeKind = "muted" | "ok" | "pending" | "error" | "accent" | "live";

export interface BadgeProps {
  kind?: BadgeKind;
  /** Draw the 6 px dot before the word. */
  dot?: boolean;
  children: string;
  title?: string;
}

export function Badge({ kind = "muted", dot = true, children, title }: BadgeProps) {
  return (
    <span className={kind === "muted" ? "nx-badge" : `nx-badge nx-badge--${kind}`} title={title}>
      {dot ? <span className="nx-badge-dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/** The badge for a session status: RUNNING (accent), AWAITING (pending), DONE (ok), FAILED (error), CANCELLED (muted). */
export function statusBadge(status: AgentSession["status"]): { kind: BadgeKind; label: string } {
  switch (status) {
    case "running":
      return { kind: "accent", label: "RUNNING" };
    case "awaiting_approval":
      return { kind: "pending", label: "AWAITING" };
    case "done":
      return { kind: "ok", label: "DONE" };
    case "failed":
      return { kind: "error", label: "FAILED" };
    case "cancelled":
    default:
      return { kind: "muted", label: "CANCELLED" };
  }
}

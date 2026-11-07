import type { ReactNode } from "react";

export type Tone = "muted" | "ok" | "pending" | "error";

export interface StatusLineProps {
  tone?: Tone;
  children: ReactNode;
}

export function StatusLine({ tone = "muted", children }: StatusLineProps) {
  return <div className={`nx-status-line nx-tone-${tone}`}>{children}</div>;
}

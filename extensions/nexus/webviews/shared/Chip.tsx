import type { ReactNode } from "react";
import type { Tone } from "./StatusLine";

export interface ChipProps {
  tone?: Tone;
  children: ReactNode;
}

export function Chip({ tone = "muted", children }: ChipProps) {
  return <span className={`nx-chip nx-tone-${tone}`}>{children}</span>;
}

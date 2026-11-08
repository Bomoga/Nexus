import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { Tone } from "./StatusLine";

export type ChipKind = "default" | "accent" | "ok" | "pending" | "error" | "stale";

export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** v1: a text tone. Kept for callers that still pass it; `kind` wins when both are given. */
  tone?: Tone;
  /** v2: default (bordered), accent (accent text, accent-lo border), ok, pending, error, stale (dashed, muted). */
  kind?: ChipKind;
  /** With onClick the chip is a real button (keyboard reachable); without it a span. */
  onClick?: ButtonHTMLAttributes<HTMLButtonElement>["onClick"];
  children: ReactNode;
}

export function Chip({ tone, kind, onClick, className, children, ...rest }: ChipProps) {
  const classes = ["nx-chip", kind && kind !== "default" ? `nx-chip--${kind}` : "", !kind && tone ? `nx-tone-${tone}` : !kind ? "nx-tone-muted" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  if (onClick) {
    return (
      <button type="button" className={classes} onClick={onClick} {...rest}>
        {children}
      </button>
    );
  }
  return (
    <span className={classes} title={rest.title} aria-label={rest["aria-label"]}>
      {children}
    </span>
  );
}

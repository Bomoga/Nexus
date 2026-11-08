// Kit Button (CLAUDE.md §6, design-night §3.5): uppercase label, optional keyboard hint.
// Variants: default (bordered), primary (accent fill, dark text), ghost (no border), danger (error outline).
// Sizes: md (22 px) and sm (20 px, the toolbar height). Styling lives entirely in theme.css; this picks classes.
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "default" | "primary" | "ghost" | "danger";
export type ButtonSize = "md" | "sm";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Keyboard shortcut shown beside the label, e.g. "ESC". */
  kbd?: string;
  children: ReactNode;
}

export function Button({ variant = "default", size = "md", kbd, children, className, ...rest }: ButtonProps) {
  const classes = ["nx-button", variant !== "default" ? `nx-button--${variant}` : "", size === "sm" ? "nx-button--sm" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <button type="button" className={classes} {...rest}>
      <span>{children}</span>
      {kbd ? <span className="nx-kbd">{kbd}</span> : null}
    </button>
  );
}

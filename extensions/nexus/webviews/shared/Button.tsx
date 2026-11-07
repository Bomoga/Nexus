// Seed of the kit's Button (PLAN §5.3 L3-01): uppercase label, optional keyboard hint.
// Styling lives entirely in theme.css; this component only picks classes.
import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "primary";
  /** Keyboard shortcut shown beside the label, e.g. "ESC". */
  kbd?: string;
  children: ReactNode;
}

export function Button({ variant = "default", kbd, children, className, ...rest }: ButtonProps) {
  const classes = ["nx-button", variant === "primary" ? "nx-button--primary" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <button type="button" className={classes} {...rest}>
      <span>{children}</span>
      {kbd ? <span className="nx-kbd">{kbd}</span> : null}
    </button>
  );
}

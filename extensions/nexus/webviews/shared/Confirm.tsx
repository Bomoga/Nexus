// Inline two-step action: MERGE → CONFIRM MERGE / CANCEL, reverting on its own after 5 s. No modal.
import { useEffect, useRef, useState } from "react";
import { Button } from "./Button";
import type { ButtonProps } from "./Button";

export interface ConfirmProps {
  /** First-step label ("MERGE"). */
  label: string;
  /** Second-step label; defaults to "CONFIRM <label>". */
  confirmLabel?: string;
  onConfirm: () => void;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  disabled?: boolean;
  /** Milliseconds before an unconfirmed second step reverts (5000). */
  revertMs?: number;
}

export function Confirm({ label, confirmLabel, onConfirm, variant = "primary", size = "md", disabled, revertMs = 5000 }: ConfirmProps) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!armed) return;
    timer.current = setTimeout(() => setArmed(false), revertMs);
    return () => clearTimeout(timer.current);
  }, [armed, revertMs]);

  if (!armed) {
    return (
      <Button variant={variant} size={size} disabled={disabled} onClick={() => setArmed(true)}>
        {label}
      </Button>
    );
  }
  return (
    <span className="nx-confirm" role="group" aria-label={`confirm ${label}`}>
      <Button
        variant={variant === "default" ? "primary" : variant}
        size={size}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {confirmLabel ?? `CONFIRM ${label}`}
      </Button>
      <Button variant="ghost" size={size} kbd="ESC" onClick={() => setArmed(false)}>
        CANCEL
      </Button>
    </span>
  );
}

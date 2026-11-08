import type { ReactNode } from "react";

export interface ToolbarProps {
  children: ReactNode;
  /** Controls pushed to the right edge. */
  right?: ReactNode;
  "aria-label"?: string;
}

export function Toolbar({ children, right, "aria-label": ariaLabel }: ToolbarProps) {
  return (
    <div className="nx-toolbar" role="toolbar" aria-label={ariaLabel}>
      {children}
      {right !== undefined ? <div className="nx-toolbar-right">{right}</div> : null}
    </div>
  );
}

// The 22 px header strip of a region: uppercase title, optional count in mono, free meta in the middle, actions right.
import type { ReactNode } from "react";

export interface PanelHeaderProps {
  title: string;
  /** Shown after the title in mono ("CHANNELS 4"). */
  count?: number | string;
  /** Anything between the title and the actions (badges, a mono strip). Not uppercased. */
  children?: ReactNode;
  /** 20 px controls at the right edge. */
  actions?: ReactNode;
  className?: string;
}

export function PanelHeader({ title, count, children, actions, className }: PanelHeaderProps) {
  return (
    <div className={["nx-panel-header", className ?? ""].filter(Boolean).join(" ")} role="heading" aria-level={2}>
      <span className="nx-panel-header-title">{title}</span>
      {count !== undefined ? <span className="nx-count">{count}</span> : null}
      {children !== undefined ? <span className="nx-panel-header-meta">{children}</span> : null}
      {actions !== undefined ? <span className="nx-panel-header-actions">{actions}</span> : null}
    </div>
  );
}

import type { ReactNode } from "react";

export interface ToolbarProps {
  children: ReactNode;
}

export function Toolbar({ children }: ToolbarProps) {
  return (
    <div className="nx-toolbar" role="toolbar">
      {children}
    </div>
  );
}

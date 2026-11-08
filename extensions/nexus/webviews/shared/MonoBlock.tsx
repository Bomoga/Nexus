// A wrapped <pre> with a 20 px header. Double-clicking the header selects the whole body. Text only, never HTML.
import { useRef } from "react";
import type { ReactNode } from "react";

export interface MonoBlockProps {
  /** Uppercase caption in the header ("BRIEF", "TEST OUTPUT"). */
  label: string;
  /** Mono count or size at the right of the header ("12 lines"). */
  count?: string;
  /** Header actions (20 px). */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
}

export function MonoBlock({ label, count, actions, children, className, "aria-label": ariaLabel }: MonoBlockProps) {
  const pre = useRef<HTMLPreElement>(null);
  const selectAll = () => {
    const el = pre.current;
    const sel = window.getSelection?.();
    if (!el || !sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  };
  return (
    <div className={["nx-mono-block", className ?? ""].filter(Boolean).join(" ")}>
      <div className="nx-mono-block-head" onDoubleClick={selectAll} title="double-click to select all">
        <span>{label}</span>
        {count !== undefined ? <span className="nx-count">{count}</span> : null}
        {actions}
      </div>
      <pre ref={pre} aria-label={ariaLabel ?? label}>
        {children}
      </pre>
    </div>
  );
}

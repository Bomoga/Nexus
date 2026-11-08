// A 22 px grid row with named slots: leading · title · meta · trailing. 20 px with `small` (channel list, dropdowns).
import type { HTMLAttributes, KeyboardEvent, ReactNode } from "react";

export interface ListRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "title" | "onClick"> {
  leading?: ReactNode;
  title: ReactNode;
  /** Plain-text title attribute for the truncating title cell. */
  titleText?: string;
  meta?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  small?: boolean;
  /** With onClick the row is keyboard reachable (Enter and Space activate). */
  onClick?: () => void;
}

export function ListRow({ leading, title, titleText, meta, trailing, selected, small, onClick, className, ...rest }: ListRowProps) {
  const classes = ["nx-list-row", small ? "nx-list-row--sm" : "", onClick ? "nx-clickable" : "", selected ? "is-selected" : "", className ?? ""].filter(Boolean).join(" ");
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (onClick && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      onClick();
    }
  };
  return (
    <div
      className={classes}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-pressed={onClick && selected !== undefined ? selected : undefined}
      onClick={onClick}
      onKeyDown={onClick ? onKey : undefined}
      {...rest}
    >
      <span className="nx-list-row-leading">{leading}</span>
      <span className="nx-list-row-title" title={titleText}>
        {title}
      </span>
      <span className="nx-list-row-meta">{meta}</span>
      <span className="nx-list-row-trailing">{trailing}</span>
    </div>
  );
}

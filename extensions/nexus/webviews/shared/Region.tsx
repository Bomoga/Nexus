// A bordered box with an optional PanelHeader and footer status line. Regions touch, so the screen reads as one grid.
import type { HTMLAttributes, ReactNode } from "react";
import { PanelHeader } from "./PanelHeader";
import type { PanelHeaderProps } from "./PanelHeader";

export interface RegionProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  /** Header strip; pass a string for a plain uppercase title. */
  header?: string | PanelHeaderProps;
  /** A StatusLine (or anything) pinned under the body. */
  footer?: ReactNode;
  /** Grow to fill the parent column. */
  fill?: boolean;
  /** Drop the left and right borders (the region spans the whole view). */
  flush?: boolean;
  /** Pad the body (4 px 8 px). Off for lists and tables that draw their own rows. */
  pad?: boolean;
  /** Class on the scrolling body. */
  bodyClassName?: string;
  children?: ReactNode;
}

export function Region({ header, footer, fill, flush, pad, bodyClassName, className, children, ...rest }: RegionProps) {
  const classes = ["nx-region", fill ? "nx-region--fill" : "", flush ? "nx-region--flush" : "", className ?? ""].filter(Boolean).join(" ");
  const head = typeof header === "string" ? { title: header } : header;
  return (
    <section className={classes} {...rest}>
      {head ? <PanelHeader {...head} /> : null}
      <div className={["nx-region-body", pad ? "nx-region-body--pad" : "", bodyClassName ?? ""].filter(Boolean).join(" ")}>{children}</div>
      {footer}
    </section>
  );
}

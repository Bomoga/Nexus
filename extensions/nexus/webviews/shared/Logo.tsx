import type { SVGProps } from "react";

export interface LogoProps extends Omit<SVGProps<SVGSVGElement>, "width" | "height"> {
  /** Rendered width and height in px (the mark is square). */
  size?: number;
}

/**
 * The Nexus mark (the same drawing as resources/nexus.svg): a planet with one tilted orbit. It is stroked in
 * currentColor, so a muted parent (`color: var(--nx-muted)`) gives the grey version used by empty views.
 */
export function Logo({ size = 24, className, ...rest }: LogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      className={["nx-logo", className ?? ""].filter(Boolean).join(" ")}
      {...rest}
    >
      <circle cx="12" cy="12" r="5" />
      <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(-20 12 12)" />
    </svg>
  );
}

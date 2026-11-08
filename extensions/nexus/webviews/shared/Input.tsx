import type { InputHTMLAttributes } from "react";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Uppercase label drawn inside the same 22 px box, left of the field ("SEARCH"). */
  prefix?: string;
  /** Class for the wrapping box when `prefix` is set (the input itself keeps `className`). */
  wrapClassName?: string;
}

export function Input({ className, prefix, wrapClassName, ...rest }: InputProps) {
  const input = <input className={["nx-input", className ?? ""].filter(Boolean).join(" ")} {...rest} />;
  if (!prefix) return input;
  return (
    <span className={["nx-input-wrap", wrapClassName ?? ""].filter(Boolean).join(" ")}>
      <span className="nx-input-prefix" aria-hidden="true">
        {prefix}
      </span>
      {input}
    </span>
  );
}

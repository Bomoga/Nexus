// One 22 px box of exclusive options (24H 36H 7D 30D). The active segment is filled with the accent, dark text.
export interface SegmentOption<V extends string = string> {
  value: V;
  label: string;
}

export interface SegmentedControlProps<V extends string = string> {
  options: readonly SegmentOption<V>[];
  value: V;
  onChange: (value: V) => void;
  "aria-label": string;
  className?: string;
}

export function SegmentedControl<V extends string = string>({ options, value, onChange, "aria-label": ariaLabel, className }: SegmentedControlProps<V>) {
  return (
    <div className={["nx-segmented", className ?? ""].filter(Boolean).join(" ")} role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button key={o.value} type="button" className="nx-segment" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

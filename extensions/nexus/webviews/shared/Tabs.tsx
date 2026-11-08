export interface TabItem {
  id: string;
  label: string;
  /** Shown after the label in mono ("LOG 12"). */
  count?: number;
}

export interface TabsProps {
  tabs: readonly TabItem[];
  active: string;
  onChange: (id: string) => void;
  "aria-label"?: string;
}

export function Tabs({ tabs, active, onChange, "aria-label": ariaLabel }: TabsProps) {
  return (
    <div className="nx-tabs" role="tablist" aria-label={ariaLabel}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === active}
          className={t.id === active ? "nx-tab nx-tab--active" : "nx-tab"}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.count !== undefined ? <span className="nx-count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

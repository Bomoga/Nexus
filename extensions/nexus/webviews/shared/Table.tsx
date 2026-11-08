import type { KeyboardEvent, ReactNode } from "react";

export interface TableColumn<Row> {
  key: string;
  header: string;
  /** Cell content; defaults to String(row[key]). */
  render?: (row: Row) => ReactNode;
  /** Monospace tabular numbers (SHAs, times, counts). `mono` is the same thing by its v2 name. */
  data?: boolean;
  mono?: boolean;
  /** Numeric columns are right-aligned. */
  align?: "left" | "right";
  /** Let this column shrink and truncate with an ellipsis (the cell carries the text as its title). */
  truncate?: boolean;
  /** Plain-text title for truncated cells; defaults to String(row[key]). */
  title?: (row: Row) => string;
}

export interface TableProps<Row> {
  columns: readonly TableColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  onRowClick?: (row: Row) => void;
  /** Marks a row as selected (accent tint). */
  selected?: (row: Row) => boolean;
  /** Footer cells by column key (a total row). */
  footer?: Readonly<Record<string, ReactNode>>;
  className?: string;
  "aria-label"?: string;
}

function cellClass<Row>(c: TableColumn<Row>): string | undefined {
  const classes = [c.data || c.mono ? "nx-data" : "", c.align === "right" ? "nx-right" : "", c.truncate ? "nx-truncate" : ""].filter(Boolean);
  return classes.length ? classes.join(" ") : undefined;
}

export function Table<Row>({ columns, rows, rowKey, onRowClick, selected, footer, className, "aria-label": ariaLabel }: TableProps<Row>) {
  const onKey = (row: Row) => (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onRowClick?.(row);
    }
  };
  return (
    <table className={["nx-table", className ?? ""].filter(Boolean).join(" ")} aria-label={ariaLabel}>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} scope="col" className={c.align === "right" ? "nx-right" : undefined}>
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const isSelected = selected?.(row) ?? false;
          const rowClass = [onRowClick ? "nx-clickable" : "", isSelected ? "is-selected" : ""].filter(Boolean).join(" ") || undefined;
          return (
            <tr
              key={rowKey(row)}
              className={rowClass}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={onRowClick ? onKey(row) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              aria-selected={selected ? isSelected : undefined}
            >
              {columns.map((c) => {
                const raw = String((row as Record<string, unknown>)[c.key] ?? "");
                return (
                  <td key={c.key} className={cellClass(c)} title={c.truncate ? (c.title ? c.title(row) : raw) : undefined}>
                    {c.render ? c.render(row) : raw}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
      {footer ? (
        <tfoot>
          <tr>
            {columns.map((c) => (
              <td key={c.key} className={cellClass(c)}>
                {footer[c.key] ?? ""}
              </td>
            ))}
          </tr>
        </tfoot>
      ) : null}
    </table>
  );
}

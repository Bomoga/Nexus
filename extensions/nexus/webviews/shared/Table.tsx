import type { ReactNode } from "react";

export interface TableColumn<Row> {
  key: string;
  header: string;
  /** Cell content; defaults to String(row[key]). */
  render?: (row: Row) => ReactNode;
  /** Monospace tabular numbers (SHAs, times, counts). */
  data?: boolean;
}

export interface TableProps<Row> {
  columns: readonly TableColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  onRowClick?: (row: Row) => void;
}

export function Table<Row>({ columns, rows, rowKey, onRowClick }: TableProps<Row>) {
  return (
    <table className="nx-table">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} scope="col">
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)} onClick={onRowClick ? () => onRowClick(row) : undefined}>
            {columns.map((c) => (
              <td key={c.key} className={c.data ? "nx-data" : undefined}>
                {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? "")}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

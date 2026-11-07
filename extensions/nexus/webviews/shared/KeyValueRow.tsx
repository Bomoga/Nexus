import type { ReactNode } from "react";

export interface KeyValueRowProps {
  label: string;
  children: ReactNode;
  /** Monospace tabular value. */
  data?: boolean;
}

/** One row of a key-value block. Place inside <KeyValueList>. */
export function KeyValueRow({ label, children, data }: KeyValueRowProps) {
  return (
    <tr>
      <td>{label}</td>
      <td className={data ? "nx-data" : undefined}>{children}</td>
    </tr>
  );
}

export function KeyValueList({ children }: { children: ReactNode }) {
  return (
    <table className="nx-kv">
      <tbody>{children}</tbody>
    </table>
  );
}

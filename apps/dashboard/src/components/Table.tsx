import type { ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Digits go right, so columns of numbers compare vertically. */
  align?: "start" | "end";
  render: (row: T, index: number) => ReactNode;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  minWidth,
  empty,
}: {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T, index: number) => string;
  minWidth?: number;
  empty?: ReactNode;
}) {
  if (rows.length === 0) return <>{empty ?? null}</>;

  return (
    <div className="table-scroll">
      <table className="data" style={minWidth ? { minWidth } : undefined}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} className={column.align === "end" ? "end" : undefined} scope="col">
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={rowKey(row, index)}>
              {columns.map((column) => (
                <td key={column.key} className={column.align === "end" ? "end" : undefined}>
                  {column.render(row, index)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Share of a total, drawn as a bar under the number it describes. */
export function ShareBar({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="bar-cell">
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}

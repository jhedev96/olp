import type { ReactElement, ReactNode } from 'react';
import { Card } from '../ui/card.js';

/** One DataTable column (header + per-row cell renderer). */
export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  className?: string;
}

/**
 * Shared table (presentational only — pages fetch, this renders).
 * Empty rows render a single spanning cell so tables never collapse
 * into bare borders. Card-bleed styling matches the existing pages.
 */
export function DataTable<T>({
  label,
  columns,
  rows,
  rowKey,
  emptyText,
}: {
  label: string;
  columns: ReadonlyArray<Column<T>>;
  rows: ReadonlyArray<T>;
  rowKey: (row: T, index: number) => string;
  emptyText: string;
}): ReactElement {
  return (
    <Card className="p-0">
      <table aria-label={label} className="w-full text-sm">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} scope="col" className="px-3 py-2 text-left text-xs font-medium text-neutral-400">
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-4 text-neutral-400">
                {emptyText}
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr key={rowKey(row, i)}>
                {columns.map((col) => (
                  <td key={col.key} className={col.className ?? 'px-3 py-2'}>
                    {col.cell(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </Card>
  );
}

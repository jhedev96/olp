// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from '../src/components/common/Badge.js';
import { DataTable } from '../src/components/common/DataTable.js';
import type { Column } from '../src/components/common/DataTable.js';
import { ComingSoon, EmptyState } from '../src/components/common/States.js';

describe('web badge', () => {
  it('renders tones with distinct styling', () => {
    const { rerender } = render(<Badge tone="success">Running</Badge>);
    expect(screen.getByText('Running').className).toContain('text-emerald-300');
    rerender(<Badge tone="danger">Stopped</Badge>);
    expect(screen.getByText('Stopped').className).toContain('text-red-400');
    rerender(<Badge>Plain</Badge>);
    expect(screen.getByText('Plain').className).toContain('text-neutral-300');
  });
});

describe('web coming soon', () => {
  it('renders the feature with its candidate id', () => {
    render(<ComingSoon feature="Process table" candidate="CAND-001" />);
    expect(screen.getByText('Process table')).not.toBeNull();
    expect(screen.getByText('CAND-001')).not.toBeNull();
    expect(screen.getByText('Coming soon')).not.toBeNull();
    expect(screen.getByLabelText('Process table (coming soon)').getAttribute('aria-disabled')).toBe('true');
  });
});

describe('web empty state', () => {
  it('renders title, hint and action slot', () => {
    render(<EmptyState title="No backups yet" hint="Create one above." action={<button type="button">Help</button>} />);
    expect(screen.getByText('No backups yet')).not.toBeNull();
    expect(screen.getByText('Create one above.')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Help' })).not.toBeNull();
  });
});

describe('web data table', () => {
  interface Row {
    id: string;
    name: string;
  }
  const columns: Column<Row>[] = [
    { key: 'name', header: 'Name', cell: (row) => row.name },
    { key: 'id', header: 'ID', cell: (row) => row.id, className: 'font-mono' },
  ];

  it('maps columns and rows with stable keys', () => {
    const { container } = render(
      <DataTable label="Sites" columns={columns} rows={[{ id: 'a1', name: 'web' }]} rowKey={(row) => row.id} emptyText="Empty" />,
    );
    expect(screen.getByText('Name')).not.toBeNull();
    expect(screen.getByText('web')).not.toBeNull();
    expect(screen.queryByText('Empty')).toBeNull();
    expect(container.querySelectorAll('tbody tr td')).toHaveLength(2);
  });

  it('spans the empty text across all columns', () => {
    const { container } = render(
      <DataTable label="Sites" columns={columns} rows={[]} rowKey={(_, i) => String(i)} emptyText="No sites yet" />,
    );
    const cell = screen.getByText('No sites yet');
    expect(cell.getAttribute('colspan')).toBe('2');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
  });
});

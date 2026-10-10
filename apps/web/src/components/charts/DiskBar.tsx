import type { ReactElement } from 'react';
import { Bar, BarChart, Tooltip, XAxis, YAxis } from 'recharts';

const DARK_TIP = { backgroundColor: '#151b2d', border: '1px solid #2e3447', fontSize: 12 };

/**
 * Disk usage bar (Recharts, data-only — no fetching, no animation).
 * Single stacked horizontal bar: used (brand) over free (track).
 * Fixed size (see `CpuArea` for why `ResponsiveContainer` is banned).
 */
export function DiskBar({
  label,
  used,
  total,
  width = 320,
  height = 56,
}: {
  label: string;
  used: number;
  total: number;
  width?: number;
  height?: number;
}): ReactElement {
  const clamped = Math.min(Math.max(used, 0), Math.max(total, 0));
  const percent = total <= 0 ? 0 : Math.round((clamped / total) * 100);
  const data = [{ name: label, used: clamped, free: Math.max(total - clamped, 0) }];
  return (
    <div aria-label={`${label} disk usage`}>
      <p className="text-sm text-neutral-300">
        {percent}% <span className="text-neutral-500">used</span>
      </p>
      <BarChart data={data} layout="vertical" width={width} height={height} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
        <XAxis type="number" hide={true} />
        <YAxis type="category" dataKey="name" hide={true} />
        <Tooltip contentStyle={DARK_TIP} />
        <Bar dataKey="used" stackId="disk" fill="#4edea3" radius={[6, 0, 0, 6]} isAnimationActive={false} />
        <Bar dataKey="free" stackId="disk" fill="#2e3447" radius={[0, 6, 6, 0]} isAnimationActive={false} />
      </BarChart>
    </div>
  );
}

import type { ReactElement } from 'react';
import { Cell, Pie, PieChart, Tooltip } from 'recharts';

const DARK_TIP = { backgroundColor: '#151b2d', border: '1px solid #2e3447', fontSize: 12 };

/**
 * Memory donut (Recharts, data-only — no fetching, no animation).
 * `used`/`total` share one unit (callers format the summary line).
 * Fixed size (see `CpuArea` for why `ResponsiveContainer` is banned).
 */
export function MemoryDonut({
  label,
  used,
  total,
  size = 160,
}: {
  label: string;
  used: number;
  total: number;
  size?: number;
}): ReactElement {
  const clamped = Math.min(Math.max(used, 0), Math.max(total, 0));
  const free = Math.max(total - clamped, 0);
  const percent = total <= 0 ? 0 : Math.round((clamped / total) * 100);
  const data = [
    { name: 'Used', value: clamped },
    { name: 'Free', value: free },
  ];
  return (
    <div aria-label={`${label} memory usage`} className="relative inline-block">
      <PieChart width={size} height={size}>
        <Tooltip contentStyle={DARK_TIP} />
        <Pie data={data} dataKey="value" nameKey="name" innerRadius={size * 0.32} outerRadius={size * 0.46} strokeWidth={0} isAnimationActive={false}>
          <Cell fill="#4edea3" />
          <Cell fill="#2e3447" />
        </Pie>
      </PieChart>
      <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-xl font-bold tracking-tight">
        {percent}%
      </p>
    </div>
  );
}

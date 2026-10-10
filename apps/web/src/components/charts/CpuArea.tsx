import type { ReactElement } from 'react';
import { Area, AreaChart, Tooltip, XAxis, YAxis } from 'recharts';

/** One CPU load sample (caller formats the time label, e.g. `-45s`). */
export interface CpuSample {
  t: string;
  v: number;
}

const DARK_TIP = { backgroundColor: '#151b2d', border: '1px solid #2e3447', fontSize: 12 };

/**
 * CPU load area (Recharts, data-only — no fetching, no animation).
 * Fixed size on purpose: `ResponsiveContainer` needs layout measurement,
 * which jsdom cannot do (untestable) and low-end devices pay for on
 * every resize. Callers size via props.
 */
export function CpuArea({
  label,
  samples,
  width = 320,
  height = 140,
}: {
  label: string;
  samples: CpuSample[];
  width?: number;
  height?: number;
}): ReactElement {
  const last = samples.length === 0 ? 0 : (samples[samples.length - 1]?.v ?? 0);
  return (
    <div aria-label={`${label} CPU load`}>
      <p className="text-xl font-bold tracking-tight">
        {last.toFixed(1)}
        <span className="text-sm font-normal text-neutral-400">%</span>
      </p>
      <AreaChart data={samples} width={width} height={height} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        <XAxis dataKey="t" tick={{ fontSize: 10, fill: '#86948a' }} tickLine={false} axisLine={false} minTickGap={48} />
        <YAxis domain={[0, 100]} hide={true} />
        <Tooltip contentStyle={DARK_TIP} />
        <Area type="monotone" dataKey="v" name="load %" stroke="#4edea3" fill="#4edea3" fillOpacity={0.25} strokeWidth={2} isAnimationActive={false} />
      </AreaChart>
    </div>
  );
}

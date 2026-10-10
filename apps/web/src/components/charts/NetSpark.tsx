import type { ReactElement } from 'react';
import { Line, LineChart, Tooltip } from 'recharts';

const DARK_TIP = { backgroundColor: '#151b2d', border: '1px solid #2e3447', fontSize: 12 };

/**
 * Network spark (Recharts, data-only — no fetching, no animation).
 * `down`/`up` are same-rate samples in one unit (caller formats units
 * into `unitLabel`, e.g. `MB/s`); shorter `up` pads with zero.
 * Fixed size (see `CpuArea` for why `ResponsiveContainer` is banned).
 */
export function NetSpark({
  label,
  unitLabel,
  down,
  up,
  width = 320,
  height = 96,
}: {
  label: string;
  unitLabel: string;
  down: number[];
  up: number[];
  width?: number;
  height?: number;
}): ReactElement {
  const data = down.map((d, i) => ({ i, down: d, up: up[i] ?? 0 }));
  const lastDown = down.length === 0 ? 0 : (down[down.length - 1] ?? 0);
  const lastUp = up.length === 0 ? 0 : (up[up.length - 1] ?? 0);
  return (
    <div aria-label={`${label} network throughput`}>
      <p className="text-sm text-neutral-300">
        ↓ {lastDown} {unitLabel} <span className="text-neutral-500">↑ {lastUp} {unitLabel}</span>
      </p>
      <LineChart data={data} width={width} height={height} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        <Tooltip contentStyle={DARK_TIP} />
        <Line type="monotone" dataKey="down" name={`down (${unitLabel})`} stroke="#4edea3" strokeWidth={1.5} dot={false} isAnimationActive={false} />
        <Line type="monotone" dataKey="up" name={`up (${unitLabel})`} stroke="#4cd7f6" strokeWidth={1.5} dot={false} isAnimationActive={false} />
      </LineChart>
    </div>
  );
}

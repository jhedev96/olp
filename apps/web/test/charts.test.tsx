// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CpuArea } from '../src/components/charts/CpuArea.js';
import { DiskBar } from '../src/components/charts/DiskBar.js';
import { MemoryDonut } from '../src/components/charts/MemoryDonut.js';
import { NetSpark } from '../src/components/charts/NetSpark.js';

describe('web chart wrappers', () => {
  it('maps cpu samples to area + headline value', () => {
    const { container } = render(
      <CpuArea label="Cluster" samples={[{ t: '-60s', v: 22.5 }, { t: 'now', v: 34.2 }]} />,
    );
    expect(screen.getByText('34.2')).not.toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('.recharts-area')).not.toBeNull();
  });

  it('maps used/total to donut percent', () => {
    const { container } = render(<MemoryDonut label="RAM" used={540} total={800} />);
    expect(screen.getByText('68%')).not.toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelectorAll('.recharts-pie-sector')).toHaveLength(2);
  });

  it('clamps the donut at empty and full', () => {
    const { rerender } = render(<MemoryDonut label="RAM" used={0} total={0} />);
    expect(screen.getByText('0%')).not.toBeNull();
    rerender(<MemoryDonut label="RAM" used={999} total={100} />);
    expect(screen.getByText('100%')).not.toBeNull();
  });

  it('maps used/total to stacked disk bar', () => {
    const { container } = render(<DiskBar label="UFS" used={45} total={128} />);
    expect(screen.getByText('35%')).not.toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(2);
  });

  it('maps down/up samples to spark lines + latest values', () => {
    const { container } = render(<NetSpark label="wlan0" unitLabel="MB/s" down={[1.2, 2.4]} up={[0.4, 0.8]} />);
    expect(screen.getByText(/2.4 MB\/s/)).not.toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelectorAll('.recharts-line')).toHaveLength(2);
  });

  it('labels every chart region for assistive tech', () => {
    render(
      <>
        <CpuArea label="A" samples={[]} />
        <MemoryDonut label="B" used={1} total={2} />
        <DiskBar label="C" used={1} total={2} />
        <NetSpark label="D" unitLabel="MB/s" down={[]} up={[]} />
      </>,
    );
    expect(screen.getByLabelText('A CPU load')).not.toBeNull();
    expect(screen.getByLabelText('B memory usage')).not.toBeNull();
    expect(screen.getByLabelText('C disk usage')).not.toBeNull();
    expect(screen.getByLabelText('D network throughput')).not.toBeNull();
  });
});

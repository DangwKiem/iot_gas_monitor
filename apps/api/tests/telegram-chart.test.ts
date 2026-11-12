import { expect, it } from 'vitest';
import sharp from 'sharp';
import { telegramChartSvg, renderTelegramChart } from '../src/modules/telegram-chart.js';
import type { TelegramChartData } from '../src/modules/telegram-data.js';
import { historyPeriod } from '../src/modules/telegram-bot-view.js';

function data(): TelegramChartData {
  const from = new Date('2026-11-11T17:00:00Z');
  return {
    deviceName: 'Bếp <A&B>',
    simulator: false,
    metric: 'mq7_adc',
    from,
    to: new Date(from.getTime() + 3600000),
    points: Array.from({ length: 60 }, (_, i) => ({
      time: new Date(from.getTime() + i * 60000),
      value: i === 0 ? 500 : i === 1 ? 520 : i === 30 ? 550 : null,
      min: i === 0 ? 200 : i === 1 ? 250 : i === 30 ? 300 : null,
      max: i === 0 ? 900 : i === 1 ? 950 : i === 30 ? 1000 : null,
    })),
    summary: {
      total_count: 4,
      valid_count: 3,
      invalid_count: 1,
      min: 200,
      max: 1000,
      average: 523.3,
    },
  };
}
it('defaults to a dark simple chart with five local-time ticks, rounded ADC and three statistics', () => {
  const svg = telegramChartSvg(data())!;
  expect(svg).toContain('MQ-7 · CO');
  expect(svg).toContain('Bếp &lt;A&amp;B&gt;');
  expect(svg).toContain('fill="#0b1220"');
  for (const label of [
    '00:00',
    '00:15',
    '00:30',
    '00:45',
    '01:00',
    'Trung bình',
    'Thấp nhất',
    'Cao nhất',
  ])
    expect(svg).toContain(label);
  expect(svg).toContain('12/11/2026 00:00');
  expect(svg).not.toMatch(/data-range|mẫu hợp lệ|PPM|AQI|523,3/);
  // One segment between adjacent samples; the isolated later sample remains disconnected.
  expect(svg.match(/data-series="mean"/g)).toHaveLength(1);
});
it('shows per-bucket min/max and sample count only in detailed mode', () => {
  const svg = telegramChartSvg(data(), 'detailed')!;
  expect(svg.match(/data-range="minmax"/g)).toHaveLength(3);
  expect(svg).toContain('3 mẫu hợp lệ');
  expect(svg).toContain('Vạch thấp–cao');
});
it.each(['temperature_c', 'humidity_pct', 'flame'] as const)(
  'renders correct units and state semantics for %s',
  (metric) => {
    const d = data();
    d.metric = metric;
    if (metric === 'flame')
      d.points = d.points.map((p, i) => ({
        ...p,
        value: i === 0 ? 0 : i === 1 ? 1 : i === 30 ? 0 : null,
        min: null,
        max: null,
      }));
    const svg = telegramChartSvg(d)!;
    expect(svg).toContain(
      metric === 'temperature_c' ? '°C' : metric === 'humidity_pct' ? '%RH' : 'Trạng thái',
    );
    if (metric === 'flame') {
      expect(svg).toContain('data-series="step"');
      expect(svg).toContain('Có lửa');
      expect(svg).toContain('Thiếu dữ liệu');
      expect(svg).not.toContain('Trung bình giờ');
    }
  },
);
it('keeps no-data charts empty instead of manufacturing a zero line', async () => {
  const d = data();
  d.points = d.points.map((p) => ({ ...p, value: null }));
  expect(telegramChartSvg(d)).toBeNull();
  expect(await renderTelegramChart(d)).toBeNull();
});
it('caches identical rendered pixels, coalesces concurrent work and invalidates changes', async () => {
  const d = data();
  const [a, b] = await Promise.all([renderTelegramChart(d), renderTelegramChart(d)]);
  expect(a).toBe(b);
  expect(await sharp(a!).metadata()).toMatchObject({ format: 'png', width: 900, height: 720 });
  expect(a!.length).toBeLessThan(200000);
  expect(await renderTelegramChart(d, 'detailed')).not.toEqual(a);
  const changed = data();
  changed.summary.average = 600;
  expect(await renderTelegramChart(changed)).not.toEqual(a);
});
it('compacts incident times without merging identities or crossing Vietnam dates incorrectly', () => {
  expect(historyPeriod(new Date('2026-11-12T13:48:00Z'), new Date('2026-11-12T13:49:00Z'))).toBe(
    '20:48–20:49 · 12/11/2026',
  );
  expect(historyPeriod(new Date('2026-11-12T13:48:00Z'), new Date('2026-11-12T13:48:20Z'))).toBe(
    '20:48 · 12/11/2026',
  );
  expect(historyPeriod(new Date('2026-11-12T16:59:00Z'), new Date('2026-11-12T17:01:00Z'))).toBe(
    '23:59 12/11/2026 → 00:01 13/11/2026',
  );
  expect(historyPeriod(null, null)).toBe('Chưa xác định thời gian');
});

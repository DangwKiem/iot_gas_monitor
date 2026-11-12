import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { chartMetrics, type TelegramChartData } from './telegram-data.js';
import { escapeTelegramHtml as xml, telegramTime } from './telegram-message.js';

type ChartMode = 'simple' | 'detailed';
const charts = new Map<string, { expiresAt: number; image: Promise<Buffer> }>();
const titles = {
  mq2_adc: 'MQ-2 · Khí gas',
  mq7_adc: 'MQ-7 · CO',
  flame: 'Phát hiện lửa',
  temperature_c: 'Nhiệt độ',
  humidity_pct: 'Độ ẩm',
};
const colors = {
  mq2_adc: '#34d399',
  mq7_adc: '#60a5fa',
  flame: '#fb7185',
  temperature_c: '#fb923c',
  humidity_pct: '#38bdf8',
};
const svgLabel = (text: string, length: number) => {
  const value = text
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return xml(value.length > length ? `${value.slice(0, length - 1)}…` : value);
};
function niceStep(value: number) {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const fraction = value / magnitude;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * magnitude;
}
export function telegramChartSvg(data: TelegramChartData, mode: ChartMode = 'simple') {
  const detailed = mode === 'detailed',
    flame = data.metric === 'flame';
  const adc = data.metric === 'mq2_adc' || data.metric === 'mq7_adc';
  const values = data.points.flatMap((p) =>
    p.value === null ? [] : detailed ? [p.min ?? p.value, p.max ?? p.value] : [p.value],
  );
  if (!values.length) return null;
  const minimum = Math.min(...values),
    maximum = Math.max(...values);
  const span = maximum - minimum || Math.max(Math.abs(maximum) * 0.1, 1);
  const step = flame ? 1 : Math.max(adc ? 1 : 0, niceStep((span * 1.2) / 3));
  const low = flame
    ? 0
    : Math.max(
        adc || data.metric === 'humidity_pct' ? 0 : -Infinity,
        Math.floor((minimum - span * 0.1) / step) * step,
      );
  const high = flame ? 1 : Math.max(low + step, Math.ceil((maximum + span * 0.1) / step) * step);
  const width = 900,
    height = 720,
    left = 105,
    right = 860,
    top = 175,
    bottom = 500;
  const duration = data.to.getTime() - data.from.getTime();
  const hours = duration / 3600000;
  const period = hours === 168 ? '7 ngày' : `${hours} giờ`;
  const unit = flame ? 'Trạng thái' : chartMetrics[data.metric].unit;
  const color = colors[data.metric];
  const number = (v: number | null) =>
    v === null ? '—' : v.toLocaleString('vi-VN', { maximumFractionDigits: adc ? 0 : 1 });
  const x = (time: Date) =>
    left + ((time.getTime() - data.from.getTime()) / duration) * (right - left);
  const y = (v: number) => bottom - ((v - low) / (high - low)) * (bottom - top);
  const text = (px: number, py: number, value: string, size = 26, fill = '#94a3b8', extra = '') =>
    `<text x="${px}" y="${py}" font-size="${size}" fill="${fill}" ${extra}>${value}</text>`;
  const grid: string[] = [],
    series: string[] = [],
    ranges: string[] = [];
  for (let i = 0; i <= Math.round((high - low) / step); i++) {
    const value = low + i * step,
      py = y(value);
    grid.push(
      `<line x1="${left}" x2="${right}" y1="${py}" y2="${py}" stroke="#263247" stroke-width="1"/>`,
      text(left - 16, py + 9, number(value), 24, '#94a3b8', 'text-anchor="end"'),
    );
  }
  for (let i = 0; i < 5; i++) {
    const time = new Date(data.from.getTime() + (duration * i) / 4);
    const label = telegramTime(time);
    grid.push(
      text(
        x(time),
        bottom + 43,
        hours === 168 ? label.slice(0, 5) : label.slice(11),
        24,
        '#94a3b8',
        `text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}"`,
      ),
    );
  }
  let previous: { x: number; y: number } | undefined;
  const bucketMs = duration / Math.max(1, data.points.length);
  for (const p of data.points) {
    if (p.value === null) {
      previous = undefined;
      continue;
    }
    const px = x(p.time),
      py = y(p.value);
    if (detailed && p.min != null && p.max != null)
      ranges.push(
        `<path data-range="minmax" d="M${px},${y(p.min)} V${y(p.max)}" stroke="${color}" stroke-opacity=".35" stroke-width="3"/>`,
      );
    if (previous)
      series.push(
        `<path data-series="${flame ? 'step' : 'mean'}" d="M${previous.x},${previous.y} ${flame ? `H${px} V${py}` : `L${px},${py}`}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>`,
      );
    if (flame)
      series.push(
        `<path data-series="state" d="M${px},${py} H${Math.min(right, x(new Date(p.time.getTime() + bucketMs)))}" fill="none" stroke="${color}" stroke-width="2.5"/>`,
      );
    series.push(
      `<circle cx="${px}" cy="${py}" r="${data.points.length > 60 ? 2.5 : 3.5}" fill="${color}"/>`,
    );
    previous = { x: px, y: py };
  }
  const cards = flame
    ? [
        ['Có lửa', `${data.points.filter((p) => p.value === 1).length} khoảng`],
        ['Không có lửa', `${data.points.filter((p) => p.value === 0).length} khoảng`],
        ['Thiếu dữ liệu', `${data.points.filter((p) => p.value === null).length} khoảng`],
      ]
    : [
        ['Trung bình', number(data.summary.average)],
        ['Thấp nhất', number(data.summary.min)],
        ['Cao nhất', number(data.summary.max)],
      ];
  const statistics = cards
    .map(([label, value], i) => {
      const px = 40 + i * 278;
      return `<rect x="${px}" y="580" width="264" height="96" rx="12" fill="#142035"/>${text(px + 20, 611, label!, 24)}${text(px + 20, 652, value!, 34, '#e6edf7', 'font-weight="700"')}`;
    })
    .join('');
  const aggregation = flame
    ? '0 · Không phát hiện   1 · Có lửa'
    : `Trung bình ${hours === 1 ? 'phút' : 'giờ'}${detailed ? ' · Vạch thấp–cao' : ''}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#0b1220"/>
    <g font-family="Arial, 'DejaVu Sans', sans-serif">
      ${text(40, 54, xml(titles[data.metric]), 40, '#e6edf7', 'font-weight="700"')}
      ${text(860, 53, xml(unit), 26, color, 'text-anchor="end"')}
      ${text(40, 91, `${svgLabel(data.deviceName, 48)}${data.simulator ? ' · MÔ PHỎNG' : ''}`, 26, '#cbd5e1')}
      ${text(40, 124, `${telegramTime(data.from)} — ${telegramTime(data.to)}`, 23)}
      ${text(40, 153, aggregation, 22)}${text(860, 153, period, 24, '#e6edf7', 'text-anchor="end"')}
      ${grid.join('')}${ranges.join('')}${series.join('')}${statistics}
      ${detailed ? text(450, 706, `${data.summary.valid_count.toLocaleString('vi-VN')} mẫu hợp lệ · Giờ Việt Nam`, 22, '#94a3b8', 'text-anchor="middle"') : ''}
    </g></svg>`;
}
export async function renderTelegramChart(data: TelegramChartData, mode: ChartMode = 'simple') {
  const svg = telegramChartSvg(data, mode);
  if (!svg) return null;
  const key = createHash('sha256').update(svg).digest('hex');
  const cached = charts.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    charts.delete(key);
    charts.set(key, cached);
    return cached.image;
  }
  charts.delete(key);
  while (charts.size >= 16) charts.delete(charts.keys().next().value!);
  const image = sharp(Buffer.from(svg)).png({ compressionLevel: 9, palette: true }).toBuffer();
  const entry = { expiresAt: Date.now() + 60000, image };
  charts.set(key, entry);
  try {
    return await image;
  } catch (error) {
    if (charts.get(key) === entry) charts.delete(key);
    throw error;
  }
}

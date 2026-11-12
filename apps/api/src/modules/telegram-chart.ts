import sharp from 'sharp';
import { chartMetrics, measuredNumber, type TelegramChartData } from './telegram-data.js';
import { escapeTelegramHtml as xml, telegramTime } from './telegram-message.js';

export async function renderTelegramChart(data: TelegramChartData) {
  const values = data.points.flatMap((p) =>
    p.value === null ? [] : [p.min ?? p.value, p.max ?? p.value],
  );
  if (!values.length) return null;
  const min = data.metric === 'flame' ? 0 : Math.min(...values);
  const max = data.metric === 'flame' ? 1 : Math.max(...values);
  const pad = Math.max((max - min) * 0.12, data.metric === 'flame' ? 0 : 1);
  const low = min - pad,
    high = max + pad;
  const x = (i: number) => 90 + (i / Math.max(1, data.points.length)) * 1020;
  const y = (v: number) => 420 - ((v - low) / (high - low)) * 285;
  const shape: string[] = [];
  let previous: { x: number; y: number } | undefined;
  data.points.forEach((p, i) => {
    if (p.value === null) {
      previous = undefined;
      return;
    }
    const px = x(i),
      py = y(p.value);
    if (p.min != null && p.max != null)
      shape.push(
        `<line x1="${px}" x2="${px}" y1="${y(p.min)}" y2="${y(p.max)}" stroke="#93c5fd" stroke-width="4"/>`,
      );
    if (previous)
      shape.push(
        `<path d="M${previous.x},${previous.y} ${data.metric === 'flame' ? `H${px} V${py}` : `L${px},${py}`}" fill="none" stroke="#2563eb" stroke-width="3"/>`,
      );
    shape.push(`<circle cx="${px}" cy="${py}" r="3" fill="#2563eb"/>`);
    previous = { x: px, y: py };
  });
  const labels = Array.from({ length: data.metric === 'flame' ? 2 : 5 }, (_, i) => {
    const v = low + ((high - low) * i) / (data.metric === 'flame' ? 1 : 4);
    return `<line x1="90" x2="1110" y1="${y(v)}" y2="${y(v)}" stroke="#e2e8f0"/><text x="78" y="${y(v) + 5}" text-anchor="end" font-size="16">${measuredNumber(v)}</text>`;
  });
  const metric = chartMetrics[data.metric];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="540"><rect width="1200" height="540" fill="white"/><g fill="#0f172a" font-family="sans-serif"><text x="60" y="42" font-size="26" font-weight="bold">${xml(data.deviceName.slice(0, 65))}${data.simulator ? ' · MÔ PHỎNG' : ''}</text><text x="60" y="78" font-size="20">${xml(metric.name)} · ${xml(metric.unit)}${data.metric === 'flame' ? '' : ` · TB theo ${data.points.length === 60 ? 'phút' : 'giờ'} · Vạch: thấp nhất–cao nhất`}</text><text x="60" y="108" font-size="16">${telegramTime(data.from)} → ${telegramTime(data.to)} · Giờ Việt Nam</text>${labels.join('')}${shape.join('')}<text x="90" y="457" font-size="16">${telegramTime(data.from)}</text><text x="1110" y="457" text-anchor="end" font-size="16">${telegramTime(data.to)}</text><text x="60" y="505" font-size="16">${data.metric === 'flame' ? 'Có lửa khi ít nhất một mẫu trong khoảng phát hiện lửa.' : `Trung bình: ${measuredNumber(data.summary.average)} · Thấp nhất: ${measuredNumber(data.summary.min)} · Cao nhất: ${measuredNumber(data.summary.max)} ${metric.unit}`} · ${data.summary.valid_count} mẫu hợp lệ</text></g></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

import { telegramIconHtml as icon } from './telegram-presentation.js';
import type { Database } from '@iot/database';
import { Prisma } from '@prisma/client';
import type { Stats } from '@iot/contracts';
import { ApiError } from '../lib/errors.js';
import { deviceAnalytics } from './analytics.js';
import { escapeTelegramHtml as html, telegramTime } from './telegram-message.js';

export const chartMetrics = {
  mq2_adc: { name: 'MQ-2', unit: 'ADC' },
  mq7_adc: { name: 'MQ-7', unit: 'ADC' },
  flame: { name: 'Lửa', unit: '0 = không phát hiện · 1 = phát hiện' },
  temperature_c: { name: 'Nhiệt độ', unit: '°C' },
  humidity_pct: { name: 'Độ ẩm', unit: '%RH' },
} as const;
export type ChartMetric = keyof typeof chartMetrics;
export const measuredNumber = (v: number | null) =>
  v === null ? '—' : v.toLocaleString('vi-VN', { maximumFractionDigits: 1 });
export async function requireTelegramDevice(db: Database, deviceId: string) {
  const device = await db.device.findFirst({ where: { id: deviceId, archivedAt: null } });
  if (!device) throw new ApiError(404, 'NOT_FOUND', 'Thiết bị không khả dụng.');
  return device;
}
export function reportRange(days: 1 | 7 | 30, now: Date) {
  const local = new Date(now.getTime() + 7 * 3600000);
  const midnight =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - 7 * 3600000;
  return {
    from: new Date(days === 1 ? midnight : midnight - (days - 1) * 86400000),
    to: now,
  };
}
export function nextReportTime(frequency: string, minute: number, weekday: number, now: Date) {
  if (frequency === 'off') return null;
  const local = new Date(now.getTime() + 7 * 3600000);
  let next =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) -
    7 * 3600000 +
    minute * 60000;
  if (frequency === 'weekly') next += ((weekday - local.getUTCDay() + 7) % 7) * 86400000;
  if (next <= now.getTime()) next += (frequency === 'weekly' ? 7 : 1) * 86400000;
  return new Date(next);
}
export async function telegramChartData(
  db: Database,
  deviceId: string,
  metric: ChartMetric,
  hours: 1 | 24 | 168,
  now: Date,
) {
  const device = await requireTelegramDevice(db, deviceId);
  const step = hours === 1 ? 60000 : 3600000;
  // Complete buckets give charts stable bounds and avoid partial-rollup statistics.
  const to = new Date(Math.floor(now.getTime() / step) * step);
  const from = new Date(to.getTime() - hours * 3600000);
  let points: { time: Date; value: number | null; min?: number | null; max?: number | null }[];
  let summary: Stats;
  if (metric === 'flame') {
    const rows = await db.$queryRaw<
      { time: Date; value: number | null; total: number; valid: number }[]
    >`
      SELECT date_trunc(${hours === 1 ? 'minute' : 'hour'},sampled_at,'UTC') AS time,
        MAX(CASE WHEN payload #>> '{sensors,flame,quality}'='valid'
          THEN (payload #>> '{sensors,flame,detected}')::boolean::int END)::float8 AS value,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE payload #>> '{sensors,flame,quality}'='valid'
          AND payload #>> '{sensors,flame,detected}' IS NOT NULL)::int AS valid
      FROM sensor_readings WHERE device_id=${deviceId}::uuid AND sampled_at>=${from} AND sampled_at<${to}
      GROUP BY time ORDER BY time`;
    points = rows.map((r) => ({ time: r.time, value: r.value }));
    summary = {
      total_count: rows.reduce((s, r) => s + r.total, 0),
      valid_count: rows.reduce((s, r) => s + r.valid, 0),
      invalid_count: rows.reduce((s, r) => s + r.total - r.valid, 0),
      min: null,
      max: null,
      average: null,
    };
  } else {
    const data = await deviceAnalytics(db, deviceId, {
      from: from.toISOString(),
      to: to.toISOString(),
      metric,
      bucket: hours === 1 ? 'minute' : 'hour',
    });
    points = data.series.map((p) => ({
      time: new Date(p.bucket_start),
      value: p.average,
      min: p.min,
      max: p.max,
    }));
    summary = data.summary;
  }
  const values = new Map(points.map((p) => [p.time.getTime(), p]));
  points = Array.from({ length: (hours * 3600000) / step }, (_, n) => {
    const time = new Date(from.getTime() + n * step);
    return values.get(time.getTime()) ?? { time, value: null };
  });
  return {
    deviceName: device.name,
    simulator: device.sourceKind === 'simulator',
    metric,
    from,
    to,
    points,
    summary,
  };
}
export type TelegramChartData = Awaited<ReturnType<typeof telegramChartData>>;

async function reportSensorStatistics(
  db: Database,
  deviceId: string,
  metric: Exclude<ChartMetric, 'flame'>,
  range: { from: Date; to: Date },
) {
  const query = (from: Date, to: Date) =>
    deviceAnalytics(db, deviceId, {
      from: from.toISOString(),
      to: to.toISOString(),
      metric,
      bucket: 'hour',
    });
  try {
    return await query(range.from, range.to);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'ROLLUP_ALIGNMENT_REQUIRED') throw error;
    // Completed retained hours and the current raw partial hour are disjoint.
    const boundary = new Date(Math.floor(range.to.getTime() / 3600000) * 3600000);
    if (boundary <= range.from || boundary >= range.to) throw error;
    const complete = await query(range.from, boundary),
      partial = await query(boundary, range.to);
    if (complete.adc_bits && partial.adc_bits && complete.adc_bits !== partial.adc_bits)
      throw new ApiError(409, 'INCOMPATIBLE_ADC_PROFILES', 'Không gộp số đo khác độ phân giải.');
    const a = complete.summary,
      b = partial.summary,
      valid = a.valid_count + b.valid_count;
    const minima = [a.min, b.min].filter((v): v is number => v !== null),
      maxima = [a.max, b.max].filter((v): v is number => v !== null);
    return {
      unit: complete.unit,
      summary: {
        total_count: a.total_count + b.total_count,
        valid_count: valid,
        invalid_count: a.invalid_count + b.invalid_count,
        min: minima.length ? Math.min(...minima) : null,
        max: maxima.length ? Math.max(...maxima) : null,
        average: valid
          ? ((a.average ?? 0) * a.valid_count + (b.average ?? 0) * b.valid_count) / valid
          : null,
      },
    };
  }
}

export async function telegramReport(
  db: Database,
  range: { from: Date; to: Date },
  deviceId?: string | null,
) {
  const device = deviceId ? await requireTelegramDevice(db, deviceId) : null;
  const where = { ...(device ? { deviceId: device.id } : {}), device: { archivedAt: null } };
  const activity = {
    OR: [
      { startedAt: { gte: range.from, lt: range.to } },
      { startedAt: null, firstObservedAt: { gte: range.from, lt: range.to } },
      { endedAt: { gte: range.from, lt: range.to } },
    ],
  };
  const counts = await db.$transaction(
    async (tx) => {
      const [warning, critical, active, ended, offlineEvents, offlineDevices, devices] =
        await Promise.all([
          tx.alertIncident.count({ where: { ...where, ...activity, severity: 'warning' } }),
          tx.alertIncident.count({ where: { ...where, ...activity, severity: 'critical' } }),
          tx.alertIncident.count({ where: { ...where, status: 'active' } }),
          tx.alertIncident.count({
            where: { ...where, status: 'ended', endedAt: { gte: range.from, lt: range.to } },
          }),
          tx.deviceStatusHistory.count({
            where: {
              ...where,
              newStatus: 'offline',
              reason: 'heartbeat_timeout',
              effectiveAt: { gte: range.from, lt: range.to },
            },
          }),
          tx.device.count({
            where: {
              ...(device ? { id: device.id } : {}),
              archivedAt: null,
              connectivity: 'offline',
            },
          }),
          tx.device.count({ where: { ...(device ? { id: device.id } : {}), archivedAt: null } }),
        ]);
      return { warning, critical, active, ended, offlineEvents, offlineDevices, devices };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  const lines = [
    `${icon('report')} <b>Báo cáo AirGuard IoT</b>`,
    `📟 ${device ? html(device.name) : `Tất cả thiết bị (${counts.devices})`}${device?.sourceKind === 'simulator' ? ' · MÔ PHỎNG' : ''}`,
    `🕒 ${telegramTime(range.from)} → ${telegramTime(range.to)}`,
    '',
    `🟠 WARNING: <b>${counts.warning}</b> · 🔴 CRITICAL: <b>${counts.critical}</b>`,
    'Mỗi sự cố tính theo mức cao nhất.',
    `🚨 Đang diễn ra hiện tại: <b>${counts.active}</b>`,
    `✅ Kết thúc trong kỳ: <b>${counts.ended}</b>`,
    `📡 Mất kết nối trong kỳ: <b>${counts.offlineEvents}</b> lần`,
    `OFFLINE hiện tại: <b>${counts.offlineDevices}</b> thiết bị`,
  ];
  if (device) {
    lines.push('', '<b>Cảm biến · TB / thấp nhất / cao nhất</b>');
    const { from, to } = range;
    lines.push(`Số đo: ${telegramTime(from)} → ${telegramTime(to)}`);
    for (const metric of ['mq2_adc', 'mq7_adc', 'temperature_c', 'humidity_pct'] as const) {
      let label: string;
      if (to <= from) label = 'Chưa đủ dữ liệu';
      else {
        try {
          const data = await reportSensorStatistics(db, device.id, metric, range);
          label = data.summary.valid_count
            ? `${measuredNumber(data.summary.average)} / ${measuredNumber(data.summary.min)} / ${measuredNumber(data.summary.max)} ${data.unit}`
            : 'Chưa đủ dữ liệu';
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== 'INCOMPATIBLE_ADC_PROFILES')
            throw error;
          label = 'Không gộp số đo khác độ phân giải';
        }
      }
      lines.push(`${chartMetrics[metric].name}: <b>${label}</b>`);
    }
  } else lines.push('', 'Chọn thiết bị để xem thống kê cảm biến.');
  return lines.join('\n');
}

import { telegramIconHtml as icon } from './telegram-presentation.js';
import type { Database } from '@iot/database';
import type { DeviceView } from '@iot/contracts';
import { sensorFreshness } from '@iot/contracts/freshness';
import type { TelegramConnection, User } from '@prisma/client';
import {
  includeIncident,
  incidentPresentation,
  listIncidentPage,
  type IncidentRow,
} from './incident-service.js';
import { listDevices } from './telemetry.js';
import { escapeTelegramHtml as html, telegramTime } from './telegram-message.js';
import { telegramAdvancedScreen } from './telegram-advanced-view.js';
export type { BotView, BotAction, BotButton, BotScreen } from './telegram-ui.js';
import {
  button,
  type BotView,
  type BotScreen,
  type BotButton,
  selectedLabel,
} from './telegram-ui.js';
const back = [button('⬅️ Quay lại', 'menu')];
const levels: Record<string, string> = {
  normal: 'Bình thường',
  active: 'Cảnh báo',
  warning: 'WARNING',
  critical: 'CRITICAL',
  unknown: 'Chưa xác định',
  not_configured: 'Chưa đặt ngưỡng',
};
const qualities: Record<string, string> = {
  invalid: 'Lỗi cảm biến',
  warming_up: 'Đang làm nóng',
  heating: 'Đang gia nhiệt',
};
const number = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('vi-VN', { maximumFractionDigits: 1 })
    : '—';
const localTime = (value?: string | null) => telegramTime(value ? new Date(value) : null);
const measured = (d: DeviceView) =>
  d.latest?.payload.time_quality === 'synced' ? d.latest.payload.sampled_at : null;
export function telegramDeviceStatus(device: DeviceView, now = Date.now()): string {
  const reading = device.latest;
  const s = reading?.payload.sensors;
  const a = reading?.payload.alert_snapshot;
  const freshSensor = (sensor: { age_ms: number; quality: string } | undefined, ttl = 15000) =>
    !!reading &&
    !!sensor &&
    Number.isFinite(sensor.age_ms) &&
    ['valid', 'uncalibrated'].includes(sensor.quality) &&
    sensorFreshness(reading, sensor.age_ms, now, ttl) === 'Dữ liệu mới';
  const fresh =
    !!reading &&
    !!s &&
    [s.mq2, s.mq7, s.flame, s.dht11].every((sensor, index) =>
      freshSensor(sensor, index === 1 ? 180000 : 15000),
    );
  const lastLevel = a
    ? a.flame === 'active' ||
      a.flame === 'critical' ||
      a.flame === 'warning' ||
      s?.flame?.detected === true ||
      a.gas === 'critical' ||
      a.co === 'critical'
      ? 'CRITICAL'
      : [a.gas, a.co, a.flame].some((v) => v === 'warning' || v === 'active')
        ? 'WARNING'
        : [a.gas, a.co, a.flame].every((v) => v === 'normal')
          ? 'SAFE'
          : 'CHƯA XÁC ĐỊNH'
    : 'CHƯA XÁC ĐỊNH';
  const complete =
    s &&
    [s.mq2?.adc_raw, s.mq7?.adc_raw, s.dht11?.temperature_c, s.dht11?.humidity_pct].every(
      (value) => typeof value === 'number' && Number.isFinite(value),
    ) &&
    typeof s.flame?.detected === 'boolean';
  // A failed unrelated sensor must not hide a fresh positive alarm. SAFE is
  // stricter: every required channel must be complete, fresh and normal.
  const alarmFresh =
    lastLevel === 'CRITICAL'
      ? (a?.gas === 'critical' && freshSensor(s?.mq2)) ||
        (a?.co === 'critical' && freshSensor(s?.mq7, 180000)) ||
        ((a?.flame === 'critical' ||
          a?.flame === 'active' ||
          a?.flame === 'warning' ||
          s?.flame?.detected === true) &&
          freshSensor(s?.flame))
      : lastLevel === 'WARNING' &&
        (((a?.gas === 'warning' || a?.gas === 'active') && freshSensor(s?.mq2)) ||
          ((a?.co === 'warning' || a?.co === 'active') && freshSensor(s?.mq7, 180000)));
  const current =
    device.status === 'online' && (alarmFresh || (lastLevel === 'SAFE' && fresh && complete));
  const state = (quality: string | undefined, level: string | undefined) =>
    quality && qualities[quality]
      ? qualities[quality]
      : (levels[level ?? 'unknown'] ?? 'Chưa xác định');
  const lines = [
    `${icon('status')} <b>${html(device.name)}</b>`,
    `${device.status === 'online' ? '🟢 ONLINE' : '⚫ OFFLINE'}${device.source_kind === 'simulator' ? ' · MÔ PHỎNG' : ''}`,
    `📌 Tổng thể: <b>${current ? lastLevel : 'CHƯA XÁC ĐỊNH'}</b>`,
  ];
  if (!reading) return [...lines, '', 'Chưa có dữ liệu cảm biến.'].join('\n');
  if (!current)
    lines.push(`Mức gần nhất: ${lastLevel}${fresh ? '' : ' · dữ liệu cũ hoặc chưa xác định'}`);
  lines.push(
    '',
    `MQ-2: <b>${number(s?.mq2?.adc_raw)} ADC</b> · ${state(s?.mq2?.quality, a?.gas)}`,
    `MQ-7: <b>${number(s?.mq7?.adc_raw)} ADC</b> · ${state(s?.mq7?.quality, a?.co)}`,
    `🔥 Lửa: <b>${s?.flame?.detected === true ? 'Phát hiện lửa' : s?.flame?.detected === false ? 'Không phát hiện' : 'Chưa xác định'}</b>`,
    `🌡 DHT11: <b>${number(s?.dht11?.temperature_c)} °C · ${number(s?.dht11?.humidity_pct)} %RH</b>`,
    `🕒 Cập nhật: <b>${localTime(measured(device))}</b>`,
  );
  return lines.join('\n');
}
export async function telegramBotScreen(
  db: Database,
  connection: TelegramConnection & { user: User | null },
  view: BotView,
  now: Date,
): Promise<BotScreen> {
  const allowed =
    !!connection.user?.active && ['admin', 'operator', 'viewer'].includes(connection.user.role);
  if (view.screen === 'menu')
    return {
      text:
        `${icon('home')} <b>AirGuard IoT</b>` +
        (!allowed
          ? connection.userId
            ? '\nTài khoản không có quyền truy cập.'
            : '\nLiên kết tài khoản tại Cài đặt → Telegram trên web.'
          : ''),
      rows: [
        [button('📊 Trạng thái thiết bị', 'status')],
        [button('📱 Danh sách thiết bị', 'devices')],
        [button('🚨 Cảnh báo hiện tại', 'alerts')],
        [button('📋 Lịch sử cảnh báo', 'history', { view: { screen: 'history', days: 1 } })],
        [
          button('📈 Biểu đồ cảm biến', 'chart'),
          button('📋 Báo cáo', 'report', { view: { screen: 'report', days: 1 } }),
        ],
        [button('⚙️ Cài đặt', 'settings')],
      ],
    };
  if (view.screen === 'settings' || view.screen === 'unlink') {
    if (view.screen === 'unlink' && connection.userId)
      return {
        text: '<b>Hủy liên kết Telegram?</b>',
        rows: [
          [button('Hủy liên kết', 'menu', { unlink: true }), button('Giữ liên kết', 'settings')],
        ],
      };
    if (allowed) return telegramAdvancedScreen(db, connection, view, now);
    return {
      text: `${icon('settings')} <b>Cài đặt</b>\n${allowed ? 'Đã liên kết tài khoản' : connection.userId ? 'Tài khoản không có quyền truy cập.' : 'Liên kết tại Cài đặt → Telegram trên web.'}`,
      rows: [...(connection.userId ? [[button('Hủy liên kết Telegram', 'unlink')]] : []), back],
    };
  }
  if (!allowed)
    return {
      text: connection.userId
        ? 'Bạn không có quyền truy cập.'
        : 'Liên kết tài khoản tại Cài đặt → Telegram trên web.',
      rows: [back],
    };
  if (
    [
      'chart',
      'report',
      'report-settings',
      'report-time',
      'chart-devices',
      'report-devices',
      'tracking-devices',
    ].includes(view.screen)
  )
    return telegramAdvancedScreen(db, connection, view, now);
  if (['alerts', 'history', 'incident'].includes(view.screen))
    return telegramIncidentScreen(db, connection, view, now);
  if (view.screen === 'status' && connection.selectedDeviceId) {
    const device = (await listDevices(db, 'false', connection.selectedDeviceId))[0];
    return {
      text:
        device && !device.archived_at
          ? telegramDeviceStatus(device, now.getTime())
          : 'Thiết bị không khả dụng.',
      rows: [[button('🔄 Làm mới', 'status'), button('📱 Chọn thiết bị', 'devices')], back],
    };
  }
  if (view.screen === 'history-devices') return historyDevicePicker(db, view);
  const deviceView = (page: number): BotView => ({ screen: 'devices', page });
  const count = await db.device.count({ where: { archivedAt: null } });
  const page = Math.min(Math.max(view.page ?? 0, 0), Math.max(0, Math.ceil(count / 5) - 1));
  const devices = await listDevices(db, 'false', undefined, { skip: page * 5, take: 5 });
  const text = [
    `${icon('devices')} <b>Danh sách thiết bị</b>`,
    ...devices.map(
      (device) =>
        `\n${device.status === 'online' ? '🟢' : '⚫'} <b>${html(device.name)}</b> · ${device.status === 'online' ? 'ONLINE' : 'OFFLINE'}\nCập nhật: ${localTime(measured(device))}`,
    ),
  ];
  if (!count) text.push('Chưa có thiết bị.');
  const rows = devices.map((device) => [
    button(device.name.replace(/\s+/g, ' ').slice(0, 60), 'status', { deviceId: device.id }),
  ]);
  const paging: BotButton[] = [];
  if (page > 0) paging.push(button('◀️ Trước', 'devices', { view: deviceView(page - 1) }));
  if ((page + 1) * 5 < count)
    paging.push(button('Sau ▶️', 'devices', { view: deviceView(page + 1) }));
  if (paging.length) rows.push(paging);
  rows.push([button('🔄 Làm mới', 'devices', { view: deviceView(page) })], back);
  return { text: text.join('\n'), rows };
}

async function historyDevicePicker(db: Database, view: BotView): Promise<BotScreen> {
  const page = view.page ?? 0;
  const devices = await db.device.findMany({
    where: { archivedAt: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: page * 5,
    take: 6,
    select: { id: true, name: true },
  });
  const rows = devices
    .slice(0, 5)
    .map((d) => [
      button(
        selectedLabel(d.name.replace(/\s+/g, ' ').slice(0, 60), view.deviceId === d.id),
        'history',
        { view: { ...view, screen: 'history', deviceId: d.id, page: 0, returnPage: undefined } },
      ),
    ]);
  const paging: BotButton[] = [];
  if (page > 0)
    paging.push(button('◀️ Trước', 'history-devices', { view: { ...view, page: page - 1 } }));
  if (devices.length > 5)
    paging.push(button('Sau ▶️', 'history-devices', { view: { ...view, page: page + 1 } }));
  if (paging.length) rows.push(paging);
  rows.push(
    [
      button(selectedLabel('Tất cả thiết bị', !view.deviceId), 'history', {
        view: { ...view, screen: 'history', deviceId: undefined, page: 0, returnPage: undefined },
      }),
    ],
    [
      button('⬅️ Quay lại', 'history', {
        view: { ...view, screen: 'history', page: view.returnPage ?? 0, returnPage: undefined },
      }),
      button('🏠 Trang chủ', 'menu'),
    ],
  );
  return {
    text: `${icon('devices')} <b>Lọc thiết bị</b>${!devices.length ? '\nChưa có thiết bị.' : ''}`,
    rows,
  };
}

const causeLabel: Record<string, string> = { gas: 'Khí gas', co: 'CO', flame: 'Lửa' };
function incidentLevel(i: IncidentRow) {
  const current = incidentPresentation(i).currentSeverity;
  const level = i.status === 'ended' ? i.severity : current;
  return level === 'critical'
    ? '🔴 CRITICAL'
    : level === 'warning'
      ? '🟠 WARNING'
      : '⚠️ Chưa xác định';
}
function incidentPhase(i: IncidentRow) {
  return i.status === 'ended'
    ? '✅ RESOLVED · Đã kết thúc'
    : i.acknowledgement
      ? 'ACKNOWLEDGED · Đã xem, chưa kết thúc'
      : 'ACTIVE · Đang diễn ra';
}
function historyPhase(i: IncidentRow) {
  return i.status === 'ended'
    ? 'Đã kết thúc'
    : i.acknowledgement
      ? 'Đã xem · Chưa kết thúc'
      : 'Đang diễn ra';
}
export function historyPeriod(start: Date | null, end: Date | null) {
  if (!start) return end ? `Kết thúc ${telegramTime(end)}` : 'Chưa xác định thời gian';
  const a = telegramTime(start),
    b = end ? telegramTime(end) : null;
  if (!b) return `${a.slice(11)} · ${a.slice(0, 10)}`;
  if (a.slice(0, 10) !== b.slice(0, 10))
    return `${a.slice(11)} ${a.slice(0, 10)} → ${b.slice(11)} ${b.slice(0, 10)}`;
  return `${a.slice(11)}${a.slice(11) !== b.slice(11) ? `–${b.slice(11)}` : ''} · ${a.slice(0, 10)}`;
}
function historyDetail(
  i: IncidentRow,
  connection: TelegramConnection & { user: User | null },
  view: BotView,
  parent: BotView,
): BotScreen {
  const current = incidentPresentation(i).currentSeverity;
  const level = i.status === 'ended' ? i.severity : current;
  const levelText =
    level === 'critical'
      ? '🔴 Nguy hiểm'
      : level === 'warning'
        ? '🟠 Cảnh báo'
        : '⚠️ Chưa xác định';
  const text = [
    `${icon('history')} <b>Chi tiết sự cố</b>`,
    `📟 <b>${html(i.device.name)}</b>${i.device.sourceKind === 'simulator' ? ' · MÔ PHỎNG' : ''}`,
    `Sự cố: <b>${causeLabel[i.condition] ?? 'Cảm biến'}</b>`,
    `Mức độ: <b>${levelText}</b>`,
    ...(i.status === 'active' && current !== i.severity
      ? [`Mức cao nhất: ${i.severity === 'critical' ? 'Nguy hiểm' : 'Cảnh báo'}`]
      : []),
    `Trạng thái: <b>${historyPhase(i)}</b>`,
    `Bắt đầu: ${telegramTime(i.startedAt)}`,
    ...(i.status === 'ended' ? [`Kết thúc: ${telegramTime(i.endedAt)}`] : []),
  ];
  if (i.startedAt && i.endedAt && i.endedAt >= i.startedAt) {
    const seconds = Math.floor((i.endedAt.getTime() - i.startedAt.getTime()) / 1000);
    const duration =
      seconds >= 86400
        ? `${Math.floor(seconds / 86400)} ngày ${Math.floor((seconds % 86400) / 3600)} giờ`
        : seconds >= 3600
          ? `${Math.floor(seconds / 3600)} giờ ${Math.floor((seconds % 3600) / 60)} phút`
          : seconds >= 60
            ? `${Math.floor(seconds / 60)} phút ${seconds % 60} giây`
            : seconds
              ? `${seconds} giây`
              : 'Dưới 1 giây';
    text.push(`Thời lượng: ${duration}`);
  }
  if (i.status === 'active' && i.device.connectivity === 'offline')
    text.push('📡 Thiết bị mất kết nối');
  if (i.acknowledgement) text.push(`Đã xem: ${telegramTime(i.acknowledgement.acknowledgedAt)}`);
  const rows: BotButton[][] = [];
  if (
    !i.acknowledgement &&
    connection.user &&
    ['admin', 'operator'].includes(connection.user.role)
  ) {
    rows.push([button('✅ Xác nhận đã đọc', 'incident', { view, ackIncidentId: i.id })]);
    if (i.status === 'active') text.push('Xác nhận không kết thúc sự cố hoặc tắt còi.');
  }
  rows.push(
    [
      button('⬅️ Quay lại', 'history', { view: parent }),
      button('🔄 Làm mới', 'incident', { view }),
    ],
    [button('🏠 Trang chủ', 'menu')],
  );
  return { text: text.join('\n'), rows };
}
async function compactHistory(
  db: Database,
  incidents: IncidentRow[],
  view: BotView,
  hasMore: boolean,
): Promise<BotScreen> {
  const days = view.days ?? 1,
    page = view.page ?? 0;
  const name = view.deviceId
    ? (incidents[0]?.device ??
      (await db.device.findFirst({
        where: { id: view.deviceId, archivedAt: null },
        select: { name: true, sourceKind: true },
      })))
    : null;
  const text = [
    `${icon('history')} <b>Lịch sử cảnh báo</b>`,
    `📟 ${view.deviceId ? (name ? html(name.name) : 'Thiết bị không khả dụng') : 'Tất cả thiết bị'}${name?.sourceKind === 'simulator' ? ' · MÔ PHỎNG' : ''} · ${days === 1 ? '24 giờ' : `${days} ngày`}`,
    ...(view.severity ? [`Mức cao nhất: ${view.severity.toUpperCase()}`] : []),
  ];
  const rows: BotButton[][] = [];
  incidents.forEach((i, index) => {
    const current = incidentPresentation(i).currentSeverity;
    text.push(
      `\n${index + 1}. ${incidentLevel(i).split(' ')[0]} <b>${view.deviceId ? '' : `${html(i.device.name)} · `}${causeLabel[i.condition] ?? 'Cảm biến'}</b> — ${historyPhase(i)}`,
      historyPeriod(i.startedAt, i.endedAt),
    );
    if (i.status === 'active' && current !== i.severity)
      text.push(`Cao nhất: ${i.severity.toUpperCase()}`);
    if (index % 2 === 0) rows.push([]);
    rows.at(-1)!.push(
      button(`Chi tiết #${index + 1}`, 'incident', {
        view: { ...view, screen: 'incident', incidentId: i.id, returnTo: 'history' },
      }),
    );
  });
  if (!incidents.length) text.push('\nKhông có sự cố trong khoảng đã chọn.');
  if (page > 0 || hasMore) text.push(`\nTrang ${page + 1}`);
  rows.push(
    ([1, 7, 30] as const).map((value) =>
      button(selectedLabel(value === 1 ? '24 giờ' : `${value} ngày`, days === value), 'history', {
        view: { ...view, days: value, page: 0 },
      }),
    ),
    [
      button(selectedLabel('Tất cả', !view.severity), 'history', {
        view: { ...view, severity: undefined, page: 0 },
      }),
      button(selectedLabel('🟠 WARNING', view.severity === 'warning'), 'history', {
        view: { ...view, severity: 'warning', page: 0 },
      }),
      button(selectedLabel('🔴 CRITICAL', view.severity === 'critical'), 'history', {
        view: { ...view, severity: 'critical', page: 0 },
      }),
    ],
    [
      button('📱 Lọc thiết bị', 'history-devices', {
        view: { ...view, screen: 'history-devices', page: 0, returnPage: page },
      }),
    ],
  );
  const paging: BotButton[] = [];
  if (page > 0) paging.push(button('◀️ Trước', 'history', { view: { ...view, page: page - 1 } }));
  if (hasMore) paging.push(button('Sau ▶️', 'history', { view: { ...view, page: page + 1 } }));
  if (paging.length) rows.push(paging);
  rows.push([button('🔄 Làm mới', 'history', { view }), button('🏠 Trang chủ', 'menu')]);
  return { text: text.join('\n'), rows };
}
async function telegramIncidentScreen(
  db: Database,
  connection: TelegramConnection & { user: User | null },
  view: BotView,
  now: Date,
): Promise<BotScreen> {
  const parent: BotView = {
    ...view,
    screen: view.returnTo ?? (view.screen === 'alerts' ? 'alerts' : 'history'),
    incidentId: undefined,
  };
  if (view.screen === 'incident') {
    const incident = view.incidentId
      ? await db.alertIncident.findFirst({
          where: { id: view.incidentId, device: { archivedAt: null } },
          include: includeIncident,
        })
      : null;
    if (!incident)
      return {
        text: 'Sự cố không khả dụng.',
        rows: [[button('⬅️ Quay lại', parent.screen, { view: parent })]],
      };
    if (view.returnTo === 'history') return historyDetail(incident, connection, view, parent);
    const current = incidentPresentation(incident).currentSeverity;
    const text = [
      `<b>${incidentLevel(incident)}</b>`,
      `📟 Thiết bị: <b>${html(incident.device.name)}</b>`,
      `⚠️ Cảm biến: <b>${causeLabel[incident.condition] ?? 'Cảm biến'}</b>`,
      ...(incident.status === 'active' && current !== incident.severity
        ? [`Mức cao nhất: ${incident.severity.toUpperCase()}`]
        : []),
      `📌 ${incidentPhase(incident)}`,
      `🕒 Bắt đầu: ${telegramTime(incident.startedAt)}`,
      ...(incident.status === 'ended' ? [`🕒 Kết thúc: ${telegramTime(incident.endedAt)}`] : []),
      ...(incident.device.connectivity === 'offline' && incident.status === 'active'
        ? ['📡 Thiết bị mất kết nối']
        : []),
      ...(incident.acknowledgement
        ? [`Đã xem: ${telegramTime(incident.acknowledgement.acknowledgedAt)}`]
        : []),
    ];
    const rows: BotButton[][] = [];
    if (
      !incident.acknowledgement &&
      connection.user &&
      ['admin', 'operator'].includes(connection.user.role)
    ) {
      rows.push([button('✅ Xác nhận đã đọc', 'incident', { view, ackIncidentId: incident.id })]);
      if (incident.status === 'active') text.push('Xác nhận không tắt còi hoặc kết thúc sự cố.');
    }
    rows.push([
      button('🔄 Làm mới', 'incident', { view }),
      button('⬅️ Quay lại', parent.screen, { view: parent }),
    ]);
    return { text: text.join('\n'), rows };
  }
  const history = view.screen === 'history';
  const days = view.days ?? 1;
  const page = view.page ?? 0;
  const filters = {
    status: history ? undefined : 'active',
    device_id: view.deviceId,
    severity: view.severity,
    limit: 5,
    ...(history
      ? {
          from: new Date(now.getTime() - days * 86400000).toISOString(),
          to: new Date(now.getTime() + 1).toISOString(),
        }
      : {}),
  };
  const result = await listIncidentPage(db, filters, {
    skip: page * 5,
    visibleOnly: true,
    activityWindow: history,
  });
  if (history) return compactHistory(db, result.rows, view, result.hasMore);
  const text = [
    history
      ? `📋 <b>Lịch sử cảnh báo · ${days === 1 ? '24 giờ' : `${days} ngày`}</b>`
      : `${icon('alerts')} <b>Cảnh báo hiện tại</b>`,
  ];
  if (view.deviceId) {
    const d = await db.device.findFirst({
      where: { id: view.deviceId, archivedAt: null },
      select: { name: true },
    });
    text.push(`Thiết bị: ${d ? html(d.name) : 'Không khả dụng'}`);
  }
  if (view.severity) text.push(`Lọc mức cao nhất: ${view.severity.toUpperCase()}`);
  for (const i of result.rows) {
    const current = incidentPresentation(i).currentSeverity;
    text.push(
      `\n<b>${html(i.device.name)} · ${causeLabel[i.condition] ?? 'Cảm biến'}</b>`,
      `${incidentLevel(i)} · ${incidentPhase(i)}`,
      ...(i.status === 'active' && current !== i.severity
        ? [`Cao nhất: ${i.severity.toUpperCase()}`]
        : []),
      `Bắt đầu: ${telegramTime(i.startedAt)}`,
      ...(i.status === 'ended' ? [`Kết thúc: ${telegramTime(i.endedAt)}`] : []),
    );
  }
  if (!result.rows.length)
    text.push(history ? 'Không có sự cố trong khoảng đã chọn.' : 'Không có sự cố đang diễn ra.');
  const rows = result.rows.map((i) => [
    button(
      `${i.device.name.replace(/\s+/g, ' ').slice(0, 45)} · ${causeLabel[i.condition] ?? 'Cảm biến'}`,
      'incident',
      {
        view: {
          ...view,
          screen: 'incident',
          incidentId: i.id,
          returnTo: history ? 'history' : 'alerts',
        },
      },
    ),
  ]);
  const paging: BotButton[] = [];
  if (page > 0) paging.push(button('◀️ Trước', view.screen, { view: { ...view, page: page - 1 } }));
  if (result.hasMore)
    paging.push(button('Sau ▶️', view.screen, { view: { ...view, page: page + 1 } }));
  if (paging.length) rows.push(paging);
  rows.push([button('🔄 Làm mới', view.screen, { view })], back);
  return { text: text.join('\n'), rows };
}

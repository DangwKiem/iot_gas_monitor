import type { Database } from '@iot/database';
import type { TelegramConnection, User } from '@prisma/client';
import { button, type BotView, type BotScreen, type BotButton } from './telegram-ui.js';
import { chartMetrics, telegramChartData, telegramReport, reportRange } from './telegram-data.js';
import { renderTelegramChart } from './telegram-chart.js';
import { escapeTelegramHtml as html, telegramTime } from './telegram-message.js';
import { ApiError } from '../lib/errors.js';

const home: BotButton[] = [{ text: '🏠 Trang chủ', action: { view: { screen: 'menu' } } }];
const timeText = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const frequencyText: Record<string, string> = {
  off: 'Đã tắt',
  daily: 'Hằng ngày',
  weekly: 'Hằng tuần',
};
export async function telegramAdvancedScreen(
  db: Database,
  c: TelegramConnection & { user: User | null },
  view: BotView,
  now: Date,
): Promise<BotScreen> {
  if (!c.user?.active || !['admin', 'operator', 'viewer'].includes(c.user.role))
    return { text: 'Bạn không có quyền truy cập.', rows: [home] };
  const tracked = c.trackedDeviceId
    ? await db.device.findFirst({ where: { id: c.trackedDeviceId, archivedAt: null } })
    : null;
  if (view.screen === 'settings')
    return {
      text: [
        '⚙️ <b>Cài đặt Telegram</b>',
        `Tài khoản: <b>${html(c.user.email)}</b>`,
        `Theo dõi: <b>${c.trackedDeviceId ? (tracked ? html(tracked.name) : 'Thiết bị không khả dụng') : 'Tất cả thiết bị'}</b>`,
        `WARNING: <b>${c.warningEnabled ? 'Bật' : 'Tắt'}</b>`,
        'CRITICAL: <b>Luôn bật cho thiết bị thật</b>',
        `Báo cáo: <b>${frequencyText[c.reportFrequency] ?? 'Đã tắt'}</b>${c.reportFrequency !== 'off' ? ` · ${timeText(c.reportMinute)}` : ''}`,
      ].join('\n'),
      rows: [
        [button('📱 Chọn thiết bị theo dõi', 'tracking-devices')],
        [
          button(c.warningEnabled ? 'Tắt WARNING' : 'Bật WARNING', 'settings', {
            setting: { warningEnabled: !c.warningEnabled },
          }),
        ],
        [button('📋 Báo cáo định kỳ', 'report-settings')],
        [button('🔔 Kiểm tra thông báo', 'settings', { testNotification: true })],
        [button('Hủy liên kết Telegram', 'unlink')],
        [button('🔄 Làm mới', 'settings')],
        home,
      ],
    };
  if (view.screen === 'report-settings' || view.screen === 'report-time') {
    const text = `📋 <b>Báo cáo định kỳ</b>\n${frequencyText[c.reportFrequency]} · ${timeText(c.reportMinute)} · Giờ Việt Nam${c.reportFrequency === 'weekly' ? `\n${['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'][c.reportWeekday]}` : ''}`;
    const rows: BotButton[][] = [];
    if (view.screen === 'report-settings') {
      rows.push([
        button('Hằng ngày', 'report-settings', { setting: { reportFrequency: 'daily' } }),
        button('Hằng tuần', 'report-settings', { setting: { reportFrequency: 'weekly' } }),
        button('Tắt', 'report-settings', { setting: { reportFrequency: 'off' } }),
      ]);
      if (c.reportFrequency === 'weekly')
        rows.push(
          ...Array.from({ length: 2 }, (_, i) =>
            Array.from({ length: i === 0 ? 4 : 3 }, (_, j) => {
              const day = i * 4 + j;
              return button(['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'][day]!, 'report-settings', {
                setting: { reportWeekday: day },
              });
            }),
          ),
        );
      rows.push([button('🕒 Chọn giờ nhận', 'report-time')]);
    } else {
      for (let i = 0; i < 6; i++)
        rows.push(
          Array.from({ length: 4 }, (_, j) =>
            button(`${String(i * 4 + j).padStart(2, '0')} giờ`, 'report-time', {
              setting: { reportHour: i * 4 + j },
            }),
          ),
        );
      rows.push(
        [0, 15, 30, 45].map((m) =>
          button(`${String(m).padStart(2, '0')} phút`, 'report-time', {
            setting: { reportMinute: m },
          }),
        ),
      );
    }
    rows.push(
      [button('⬅️ Quay lại', view.screen === 'report-time' ? 'report-settings' : 'settings')],
      home,
    );
    return { text, rows };
  }
  if (
    ['chart-devices', 'report-devices', 'tracking-devices'].includes(view.screen) ||
    (view.screen === 'chart' && !view.deviceId && !c.selectedDeviceId)
  ) {
    const target =
      view.screen === 'report-devices'
        ? 'report'
        : view.screen === 'tracking-devices'
          ? 'settings'
          : 'chart';
    const page = Math.max(0, view.page ?? 0);
    const devices = await db.device.findMany({
      where: { archivedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: page * 5,
      take: 6,
    });
    const rows = devices.slice(0, 5).map((d) => [
      button(
        d.name.replace(/\s+/g, ' ').slice(0, 60),
        target,
        target === 'settings'
          ? { setting: { trackedDeviceId: d.id } }
          : {
              view: { ...view, screen: target, deviceId: d.id, page: 0 },
              ...(target === 'chart' ? { deviceId: d.id } : {}),
            },
      ),
    ]);
    const paging: BotButton[] = [];
    const screen = view.screen === 'chart' ? 'chart-devices' : view.screen;
    if (page)
      paging.push(button('◀️ Trước', screen, { view: { ...view, screen, page: page - 1 } }));
    if (devices.length > 5)
      paging.push(button('Sau ▶️', screen, { view: { ...view, screen, page: page + 1 } }));
    if (paging.length) rows.push(paging);
    if (target !== 'chart')
      rows.push([
        button(
          'Tất cả thiết bị',
          target,
          target === 'settings'
            ? { setting: { trackedDeviceId: null } }
            : { view: { screen: 'report', days: view.days ?? 1 } },
        ),
      ]);
    rows.push(
      [
        button('⬅️ Quay lại', target === 'settings' ? 'settings' : target, {
          view: target === 'chart' ? { screen: 'menu' } : { ...view, screen: target, page: 0 },
        }),
      ],
      home,
    );
    return { text: `📱 <b>Chọn thiết bị</b>${!devices.length ? '\nChưa có thiết bị.' : ''}`, rows };
  }
  if (view.screen === 'report') {
    const days = view.days ?? 1;
    const text = await telegramReport(db, reportRange(days, now), view.deviceId);
    return {
      text,
      rows: [
        ([1, 7, 30] as const).map((days) =>
          button(days === 1 ? 'Hôm nay' : `${days} ngày`, 'report', { view: { ...view, days } }),
        ),
        [
          button('📱 Chọn thiết bị', 'report-devices', {
            view: { ...view, screen: 'report-devices', page: 0 },
          }),
        ],
        [button('🔄 Làm mới', 'report', { view })],
        home,
      ],
    };
  }
  const deviceId = view.deviceId ?? c.selectedDeviceId!;
  const device = await db.device.findFirst({ where: { id: deviceId, archivedAt: null } });
  const metric = view.metric,
    hours = view.hours ?? 1;
  const rows: BotButton[][] = Object.entries(chartMetrics).map(([metric, label]) => [
    button(label.name, 'chart', {
      view: { screen: 'chart', deviceId, metric: metric as keyof typeof chartMetrics, hours },
    }),
  ]);
  rows.push(
    ([1, 24, 168] as const).map((hours) =>
      button(hours === 1 ? '1 giờ' : hours === 24 ? '24 giờ' : '7 ngày', 'chart', {
        view: { ...view, screen: 'chart', deviceId, hours },
      }),
    ),
  );
  rows.push(
    [
      button('📱 Đổi thiết bị', 'chart-devices', {
        view: { ...view, screen: 'chart-devices', page: 0 },
      }),
      button('🔄 Làm mới', 'chart', { view: { ...view, deviceId } }),
    ],
    [
      button('⬅️ Quay lại', metric ? 'chart' : 'chart-devices', {
        view: metric ? { screen: 'chart', deviceId, hours } : { screen: 'chart-devices', page: 0 },
      }),
    ],
    home,
  );
  if (!device)
    return {
      text: 'Thiết bị không khả dụng.',
      rows: [[button('📱 Chọn thiết bị', 'chart-devices')], home],
    };
  let text = `📈 <b>${html(device.name)}</b>${device.sourceKind === 'simulator' ? ' · MÔ PHỎNG' : ''}`;
  if (!metric) return { text: `${text}\nChọn cảm biến.`, rows };
  try {
    const data = await telegramChartData(db, deviceId, metric, hours, now);
    const photo = await renderTelegramChart(data);
    text += `\n${chartMetrics[metric].name} · ${hours === 168 ? '7 ngày' : `${hours} giờ`}\n${telegramTime(data.from)} → ${telegramTime(data.to)}${!photo ? '\nChưa có dữ liệu hợp lệ.' : ''}`;
    return { text, rows, ...(photo ? { photo } : {}) };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return {
      text: `${text}\n${error.code === 'INCOMPATIBLE_ADC_PROFILES' ? 'Không thể gộp số đo khác độ phân giải.' : 'Không đủ dữ liệu cho khoảng đã chọn.'}`,
      rows,
    };
  }
}

import type { Database } from '@iot/database';
import type { TelegramConnection, User } from '@prisma/client';
import {
  button,
  type BotView,
  type BotScreen,
  type BotButton,
  selectedLabel,
} from './telegram-ui.js';
import { chartMetrics, telegramChartData, telegramReport, reportRange } from './telegram-data.js';
import { renderTelegramChart } from './telegram-chart.js';
import { escapeTelegramHtml as html } from './telegram-message.js';
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
  const tracked =
    view.screen === 'settings' && c.trackedDeviceId
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
    if (target === 'chart' && !view.deviceId && !c.selectedDeviceId) rows.push(home);
    else
      rows.push(
        [
          button('⬅️ Quay lại', target === 'settings' ? 'settings' : target, {
            view: { ...view, screen: target, page: 0 },
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
  if (!device)
    return {
      text: 'Thiết bị không khả dụng.',
      rows: [[button('📱 Chọn thiết bị', 'chart-devices')], home],
    };
  const metric = view.metric,
    hours = view.hours ?? 1,
    chartMode = view.chartMode ?? 'simple';
  const chartView: BotView = { screen: 'chart', deviceId, metric, hours, chartMode };
  const sensorButton = (key: keyof typeof chartMetrics, label: string) =>
    button(selectedLabel(label, metric === key), 'chart', { view: { ...chartView, metric: key } });
  const rows: BotButton[][] = [
    [sensorButton('mq2_adc', 'MQ-2'), sensorButton('mq7_adc', 'MQ-7')],
    [sensorButton('temperature_c', '🌡 Nhiệt độ'), sensorButton('humidity_pct', '💧 Độ ẩm')],
    [sensorButton('flame', '🔥 Lửa')],
    ([1, 24, 168] as const).map((value) =>
      button(selectedLabel(value === 168 ? '7 ngày' : `${value} giờ`, hours === value), 'chart', {
        view: { ...chartView, hours: value },
      }),
    ),
    [
      button(selectedLabel('Đơn giản', chartMode === 'simple'), 'chart', {
        view: { ...chartView, chartMode: 'simple' },
      }),
      button(selectedLabel('Chi tiết', chartMode === 'detailed'), 'chart', {
        view: { ...chartView, chartMode: 'detailed' },
      }),
    ],
    [
      button('📱 Đổi thiết bị', 'chart-devices', {
        view: { ...chartView, screen: 'chart-devices', page: 0 },
      }),
      button('🔄 Làm mới', 'chart', { view: chartView }),
    ],
    home,
  ];
  const text = [
    '📈 <b>Biểu đồ cảm biến</b>',
    `📟 <b>${html(device.name)}</b>${device.sourceKind === 'simulator' ? ' · MÔ PHỎNG' : ''}`,
    `Cảm biến: <b>${metric ? chartMetrics[metric].name : 'Chưa chọn'}</b>`,
    `Khoảng thời gian: <b>${hours === 168 ? '7 ngày' : `${hours} giờ`}</b>`,
  ].join('\n');
  if (!metric) return { text, rows };
  try {
    const data = await telegramChartData(db, deviceId, metric, hours, now);
    const photo = await renderTelegramChart(data, chartMode);
    return {
      text: photo ? text : `${text}\nChưa có dữ liệu hợp lệ.`,
      rows,
      ...(photo ? { photo } : {}),
    };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return {
      text: `${text}\n${error.code === 'INCOMPATIBLE_ADC_PROFILES' ? 'Không thể gộp số đo khác độ phân giải.' : 'Không đủ dữ liệu cho khoảng đã chọn.'}`,
      rows,
    };
  }
}

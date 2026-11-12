import { telegramIconHtml as icon } from './telegram-presentation.js';
export type TelegramMessageInput = {
  deviceName: string;
  location?: string | null;
  simulator: boolean;
  condition: string;
  severity: string;
  ended: boolean;
  startedAt: Date | null;
  endedAt: Date | null;
  escalation?: boolean;
  escalatedAt?: Date | null;
  delayed?: boolean;
  currentSeverity?: string;
  uncertain?: boolean;
  acknowledged?: boolean;
};

const vietnamTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Ho_Chi_Minh',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
export function telegramTime(date: Date | null) {
  if (!date) return 'Chưa xác định';
  const parts = Object.fromEntries(
    vietnamTime.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
}

export function escapeTelegramHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
function field(value: string) {
  // Keep a device name/location on one line, including imported metadata.
  return escapeTelegramHtml(
    value
      .replace(/\p{Cc}/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

export function formatTelegramMessage(input: TelegramMessageInput): string {
  const critical =
    input.condition === 'flame' ||
    (input.ended ? input.severity : (input.currentSeverity ?? input.severity)) === 'critical';
  const cause =
    input.condition === 'flame'
      ? 'Phát hiện lửa'
      : `${input.condition === 'co' ? 'CO' : input.condition === 'gas' ? 'Khí gas' : 'Cảm biến'} vượt ngưỡng ${critical ? 'nguy hiểm' : 'cảnh báo'}`;
  const escalation = !input.ended && critical && input.escalation;
  const reduced = !input.ended && !critical && input.severity === 'critical';
  const title = input.ended
    ? `${icon('resolved')} <b>RESOLVED — ĐÃ KẾT THÚC</b>`
    : critical
      ? `${icon('critical')} <b>CRITICAL — NGUY HIỂM</b>`
      : `${icon('warning')} <b>WARNING — CẢNH BÁO</b>`;
  const timeLabel = input.ended ? 'Kết thúc' : escalation ? 'Tăng mức' : 'Thời gian';
  const time = input.ended
    ? input.endedAt
    : escalation
      ? (input.escalatedAt ?? null)
      : input.startedAt;
  const status = input.ended
    ? input.delayed
      ? 'Đã kết thúc · thông báo trễ'
      : 'Đã kết thúc'
    : input.uncertain
      ? 'Chưa xác nhận kết thúc'
      : 'Đang diễn ra';
  return [
    title,
    ...(input.simulator ? ['🧪 <b>MÔ PHỎNG</b>'] : []),
    '',
    `📟 Thiết bị: <b>${field(input.deviceName)}</b>`,
    `${input.ended ? '🔍 Sự cố' : '⚠️ Phát hiện'}: <b>${cause}</b>`,
    ...(escalation ? ['⬆️ Diễn biến: <b>Tăng lên mức nguy hiểm</b>'] : []),
    ...(reduced ? ['⬇️ Diễn biến: <b>Đã giảm từ mức nguy hiểm</b>'] : []),
    `🕒 ${timeLabel}: <b>${telegramTime(time)}</b>`,
    `📌 Trạng thái: <b>${status}${!input.ended && input.acknowledged ? ' · đã xác nhận đã xem' : ''}</b>`,
    ...(!input.ended && critical && !input.simulator
      ? ['', '🚨 Rời khỏi khu vực nguy hiểm. Gọi hỗ trợ khẩn cấp.']
      : []),
  ].join('\n');
}

export function formatConnectivityMessage(input: {
  deviceName: string;
  simulator: boolean;
  online: boolean;
  time: Date;
}) {
  return [
    input.online
      ? `${icon('online')} <b>ONLINE — ĐÃ KẾT NỐI</b>`
      : `${icon('offline')} <b>OFFLINE — MẤT KẾT NỐI</b>`,
    ...(input.simulator ? ['🧪 <b>MÔ PHỎNG</b>'] : []),
    '',
    `📟 Thiết bị: <b>${field(input.deviceName)}</b>`,
    `⚠️ ${input.online ? 'Đã khôi phục kết nối' : 'Không nhận được tín hiệu từ thiết bị'}`,
    `🕒 Thời gian: <b>${telegramTime(input.time)}</b>`,
    `📌 Trạng thái: <b>${input.online ? 'ONLINE' : 'OFFLINE'}</b>`,
  ].join('\n');
}

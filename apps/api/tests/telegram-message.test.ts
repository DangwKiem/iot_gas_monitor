import { expect, it } from 'vitest';
import {
  formatTelegramMessage,
  telegramTime,
  type TelegramMessageInput,
} from '../src/modules/telegram-message.js';

const input: TelegramMessageInput = {
  deviceName: 'IOT_Gas_Monitor',
  location: '',
  simulator: false,
  condition: 'co',
  severity: 'warning',
  ended: false,
  startedAt: new Date('2026-11-11T15:41:00Z'),
  endedAt: null,
};
it('formats warning with Vietnamese local time and no internal diagnostics or invented measurements', () => {
  const message = formatTelegramMessage(input);
  expect(message).toBe(
    '🟠 <b>WARNING — CẢNH BÁO</b>\n\n📟 Thiết bị: <b>IOT_Gas_Monitor</b>\n⚠️ Phát hiện: <b>CO vượt ngưỡng cảnh báo</b>\n🕒 Thời gian: <b>11/11/2026 22:41</b>\n📌 Trạng thái: <b>Đang diễn ra</b>',
  );
  expect(message).not.toMatch(/UUID|UTC|ISO|server|PPM|AQI|backend/i);
});
it('distinguishes a critical escalation and gives a brief emergency action', () => {
  const message = formatTelegramMessage({
    ...input,
    severity: 'critical',
    escalation: true,
    escalatedAt: new Date('2026-11-11T15:42:00Z'),
  });
  expect(message).toContain('🔴 <b>CRITICAL — NGUY HIỂM</b>');
  expect(message).toContain('CO vượt ngưỡng nguy hiểm');
  expect(message).toContain('Tăng lên mức nguy hiểm');
  expect(message).toContain('Tăng mức: <b>11/11/2026 22:42</b>');
  expect(message).toContain('Rời khỏi khu vực nguy hiểm');
});
it('uses resolved state even for a queued critical alert and distinguishes delayed history', () => {
  const message = formatTelegramMessage({
    ...input,
    severity: 'critical',
    ended: true,
    endedAt: new Date('2026-11-11T15:45:00Z'),
    delayed: true,
  });
  expect(message).toContain('✅ <b>RESOLVED — ĐÃ KẾT THÚC</b>');
  expect(message).toContain('Kết thúc: <b>11/11/2026 22:45</b>');
  expect(message).toContain('Đã kết thúc · thông báo trễ');
  expect(message).not.toMatch(/Đang diễn ra|Rời khỏi|⬆️/);
});
it('does not claim a peak critical level is still current after reduction to warning', () => {
  const message = formatTelegramMessage({
    ...input,
    severity: 'critical',
    currentSeverity: 'warning',
    escalation: true,
  });
  expect(message).toContain('🟠 <b>WARNING — CẢNH BÁO</b>');
  expect(message).toContain('Đã giảm từ mức nguy hiểm');
  expect(message).not.toContain('🔴');
});
it('escapes device and location markup, normalizes newlines, and leaves only supported HTML tags', () => {
  const message = formatTelegramMessage({
    ...input,
    deviceName: '<b>Nhà & "bếp"</b>\n⚠️',
    location: '<a href="bad">Tầng 1</a>',
  });
  expect(message).toContain('&lt;b&gt;Nhà &amp; &quot;bếp&quot;&lt;/b&gt; ⚠️');
  expect(message).not.toContain('Vị trí');
  expect(message.replace(/<\/?b>/g, '')).not.toMatch(/[<>]/);
});
it('handles the UTC date boundary and midnight without inheriting the host timezone', () => {
  expect(telegramTime(new Date('2026-11-11T17:00:00Z'))).toBe('12/11/2026 00:00');
  expect(telegramTime(null)).toBe('Chưa xác định');
});
it('keeps a short simulation label and does not ask users to evacuate for a simulation', () => {
  const message = formatTelegramMessage({
    ...input,
    simulator: true,
    severity: 'critical',
    condition: 'flame',
  });
  expect(message).toContain('🧪 <b>MÔ PHỎNG</b>');
  expect(message).toContain('Phát hiện lửa');
  expect(message).not.toContain('Rời khỏi');
});
it('does not substitute a server timestamp when occurrence time is unknown', () => {
  const message = formatTelegramMessage({ ...input, startedAt: null, uncertain: true });
  expect(message).toContain('Thời gian: <b>Chưa xác định</b>');
  expect(message).toContain('Chưa xác nhận kết thúc');
});
it('keeps a fire notification critical even when a legacy snapshot labels its state as warning', () => {
  const message = formatTelegramMessage({
    ...input,
    condition: 'flame',
    severity: 'critical',
    currentSeverity: 'warning',
  });
  expect(message).toContain('🔴 <b>CRITICAL — NGUY HIỂM</b>');
  expect(message).toContain('Phát hiện lửa');
});

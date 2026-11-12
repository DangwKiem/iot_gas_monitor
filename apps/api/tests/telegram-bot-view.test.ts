import { expect, it } from 'vitest';
import { telemetrySchema, type DeviceView } from '@iot/contracts';
import type { Database } from '@iot/database';
import type { TelegramConnection, User } from '@prisma/client';
import { samplePayload } from '../../../packages/contracts/tests/fixture.js';
import { telegramDeviceStatus, telegramBotScreen } from '../src/modules/telegram-bot-view.js';
const now = Date.parse('2026-11-12T01:00:00Z');
function device(): DeviceView {
  const payload = telemetrySchema.parse(samplePayload()).readings[0]!;
  payload.sampled_at = new Date(now - 1000).toISOString();
  payload.time_quality = 'synced';
  payload.alert_snapshot = {
    ...payload.alert_snapshot,
    gas: 'normal',
    co: 'normal',
    flame: 'normal',
  };
  payload.sensors.flame.detected = false;
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Bếp <A&B>',
    source_kind: 'physical',
    status: 'online',
    last_seen_at: new Date(now).toISOString(),
    latest: { id: '1', received_at: new Date(now).toISOString(), payload },
  };
}
it('shows fresh online raw ADC, temperature/humidity and SAFE without inventing concentrations', () => {
  const text = telegramDeviceStatus(device(), now);
  expect(text).toContain('Tổng thể: <b>SAFE</b>');
  expect(text).toContain('ADC');
  expect(text).toContain('12/11/2026 07:59');
  expect(text).toContain('Bếp &lt;A&amp;B&gt;');
  expect(text).not.toMatch(/PPM|AQI|aaaaaaaa|T01:/);
});
it.each(['offline', 'never_seen'] as const)('never concludes SAFE when %s', (status) => {
  const d = device();
  d.status = status;
  expect(telegramDeviceStatus(d, now)).not.toContain('Tổng thể: <b>SAFE</b>');
});
it('does not conclude SAFE for stale data, unsynced time, invalid quality or missing readings', () => {
  const stale = device();
  stale.latest!.payload.sampled_at = new Date(now - 300000).toISOString();
  const unsynced = device();
  unsynced.latest!.payload.time_quality = 'unsynced';
  unsynced.latest!.payload.sampled_at = null;
  const invalid = device();
  invalid.latest!.payload.sensors.dht11.quality = 'invalid';
  const missing = device();
  missing.latest = null;
  const partial = device();
  partial.latest!.payload.sensors.dht11.temperature_c = null;
  for (const d of [stale, unsynced, invalid, missing, partial])
    expect(telegramDeviceStatus(d, now)).toContain('Tổng thể: <b>CHƯA XÁC ĐỊNH</b>');
  expect(telegramDeviceStatus(missing, now)).toContain('Chưa có dữ liệu');
});
it.each(['warning', 'critical'] as const)('reflects an online %s state', (level) => {
  const d = device();
  d.latest!.payload.alert_snapshot.gas = level;
  expect(telegramDeviceStatus(d, now)).toContain(`Tổng thể: <b>${level.toUpperCase()}</b>`);
});
it('keeps stale critical measurements labeled as historical', () => {
  const d = device();
  d.latest!.payload.alert_snapshot.co = 'critical';
  d.status = 'offline';
  const text = telegramDeviceStatus(d, now);
  expect(text).toContain('Mức gần nhất: CRITICAL');
  expect(text).toContain('Tổng thể: <b>CHƯA XÁC ĐỊNH</b>');
});
it('never shows SAFE alongside a positive fire detection', () => {
  const d = device();
  d.latest!.payload.sensors.flame.detected = true;
  expect(telegramDeviceStatus(d, now)).toContain('Tổng thể: <b>CRITICAL</b>');
});
it('does not hide a fresh critical alarm when an unrelated sensor is missing', () => {
  const d = device();
  d.latest!.payload.alert_snapshot.gas = 'critical';
  d.latest!.payload.sensors.dht11 = {
    quality: 'invalid',
    temperature_c: null,
    humidity_pct: null,
    age_ms: 0,
  };
  expect(telegramDeviceStatus(d, now)).toContain('Tổng thể: <b>CRITICAL</b>');
  d.latest!.payload.sensors.mq2.age_ms = 20000;
  expect(telegramDeviceStatus(d, now)).toContain('Tổng thể: <b>CHƯA XÁC ĐỊNH</b>');
});
it('renders a real empty state rather than demo devices', async () => {
  const db = {
    device: { count: async () => 0, findMany: async () => [] },
    sensorReading: { findMany: async () => [] },
  } as unknown as Database;
  const connection = {
    user: { active: true, role: 'viewer' },
    selectedDeviceId: null,
  } as unknown as TelegramConnection & { user: User };
  const view = await telegramBotScreen(db, connection, { screen: 'devices' }, new Date(now));
  expect(view.text).toContain('Chưa có thiết bị.');
  expect(view.rows.flat().map((b) => b.text)).toContain('⬅️ Quay lại');
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createDatabase } from '@iot/database';
import { createApp } from '../src/app.js';
import { featureFixture } from './helpers.js';
import {
  telegramChartData,
  telegramReport,
  nextReportTime,
  reportRange,
} from '../src/modules/telegram-data.js';
import { renderTelegramChart } from '../src/modules/telegram-chart.js';
import {
  personalIncidentNotifier,
  personalConnectivityNotifier,
  queueTelegramTest,
  scheduleTelegramReports,
  deliverPersonalTelegram,
} from '../src/modules/telegram-deliveries.js';
import { telegramNotifier, deliverTelegramNotification } from '../src/modules/notifications.js';
import { processTelegramUpdate, type BotApi } from '../src/modules/telegram-bot.js';
import { unlinkTelegram } from '../src/modules/telegram-links.js';
import { TelegramApiError } from '../src/modules/telegram-client.js';
import { telegramBotScreen } from '../src/modules/telegram-bot-view.js';

it('schedules daily and weekly reports strictly in the future in Vietnam time', () => {
  const now = new Date('2026-11-12T01:30:00Z');
  expect(nextReportTime('daily', 480, 1, now)?.toISOString()).toBe('2026-11-13T01:00:00.000Z');
  expect(nextReportTime('weekly', 480, 1, now)?.toISOString()).toBe('2026-11-16T01:00:00.000Z');
  expect(nextReportTime('daily', 510, 1, now)?.toISOString()).toBe('2026-11-13T01:30:00.000Z');
  expect(nextReportTime('off', 480, 1, now)).toBeNull();
  expect(reportRange(1, now).from.toISOString()).toBe('2026-11-11T17:00:00.000Z');
  expect(reportRange(7, now).from.toISOString()).toBe('2026-11-05T17:00:00.000Z');
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('Telegram advanced integration', () => {
  const source = process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/iot_test';
  const name = `iot_tg3_${randomBytes(6).toString('hex')}`;
  const url = new URL(source);
  url.pathname = `/${name}`;
  const admin = createDatabase(source),
    db = createDatabase(url.toString());
  const app = createApp({ db, origin: 'http://localhost:5173' });
  let f: Awaited<ReturnType<typeof featureFixture>>, userId: string;
  const tg = '777123456';
  const now = new Date();
  let seq = 0,
    clock = now.getTime();
  let calls: { method: string; parameters: Record<string, unknown> }[] = [];
  let failPhoto = false;
  const api: BotApi = async (method, parameters) => {
    calls.push({ method, parameters });
    if (method === 'sendPhoto' && failPhoto) {
      failPhoto = false;
      throw new TelegramApiError('TELEGRAM_NETWORK_ERROR', true);
    }
    return method === 'answerCallbackQuery'
      ? true
      : { message_id: method === 'sendPhoto' ? 99 : 77 };
  };
  const screen = () =>
    calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').at(-1)!
      .parameters;
  const buttons = () =>
    (
      screen().reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }
    ).inline_keyboard.flat();
  const command = async (text: string) => {
    clock += 6000;
    await processTelegramUpdate(
      db,
      {
        update_id: ++seq,
        message: {
          message_id: seq,
          from: { id: Number(tg) },
          chat: { id: Number(tg), type: 'private' },
          text,
        },
      },
      api,
      new Date(clock),
    );
  };
  const click = async (text: string, data?: string) => {
    clock += 6000;
    const callback_data =
      data ?? buttons().find((b) => b.text.replace(/^✓ /, '') === text)?.callback_data;
    if (!callback_data) throw new Error(`Missing button: ${text}`);
    await processTelegramUpdate(
      db,
      {
        update_id: ++seq,
        callback_query: {
          id: `cb${seq}`,
          from: { id: Number(tg) },
          message: { message_id: 77, chat: { id: Number(tg), type: 'private' } },
          data: callback_data,
        },
      },
      api,
      new Date(clock),
    );
  };
  beforeAll(async () => {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: url.toString() },
      stdio: 'ignore',
    });
    f = await featureFixture(db, app, 'advanced');
    userId = (await db.user.findUniqueOrThrow({ where: { email: 'advanced-viewer@test.local' } }))
      .id;
  }, 30000);
  beforeEach(async () => {
    await db.telegramBotDelivery.deleteMany();
    await db.telegramConnection.deleteMany();
    await db.telegramNotification.deleteMany();
    await db.alertAcknowledgement.deleteMany();
    await db.alertState.deleteMany();
    await db.alertEvent.deleteMany();
    await db.alertIncident.deleteMany();
    await db.device.update({
      where: { id: f.deviceId },
      data: { latestId: null, archivedAt: null, sourceKind: 'physical' },
    });
    await db.sensorReading.deleteMany();
    await db.sensorRollup.deleteMany();
    await db.user.update({ where: { id: userId }, data: { active: true, role: 'viewer' } });
    await db.telegramConnection.create({
      data: {
        telegramUserId: tg,
        chatId: tg,
        userId,
        selectedDeviceId: f.deviceId,
        trackedDeviceId: f.deviceId,
      },
    });
    seq = 0;
    clock = Date.now();
    calls = [];
    failPhoto = false;
  });
  afterAll(async () => {
    await db.$disconnect();
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$disconnect();
  });
  async function readings() {
    const end = Math.floor(Date.now() / 3600000) * 3600000;
    for (const [n, value] of [20, null, 30].entries()) {
      const p = f.payload(n + 1, end - 3600000 + n * 600000).readings[0]!;
      p.sensors.dht11.temperature_c = value;
      p.sensors.dht11.quality = value === null ? 'invalid' : 'valid';
      p.sensors.flame.detected = n === 2;
      p.sensors.flame.quality = 'valid';
      await db.sensorReading.create({
        data: {
          deviceId: f.deviceId,
          bootId: f.bootId,
          bootCounter: 1n,
          seq: BigInt(n + 1),
          sampledAt: new Date(p.sampled_at!),
          receivedAt: new Date(p.sampled_at!),
          temperatureC: value,
          humidityPct: 50,
          mq2Adc: 1000 + n * 100,
          mq7Adc: 400,
          payload: p,
          payloadHash: randomUUID(),
        },
      });
    }
    return new Date(end);
  }
  async function alarm(severity = 'warning') {
    const i = await db.alertIncident.create({
      data: {
        deviceId: f.deviceId,
        condition: 'gas',
        severity,
        origin: 'snapshot',
        startedAt: new Date(),
      },
    });
    await db.alertState.create({
      data: {
        deviceId: f.deviceId,
        condition: 'gas',
        state: severity,
        incidentId: i.id,
        bootId: f.bootId,
        bootCounter: 1n,
        seq: 1n,
        updatedAt: new Date(),
      },
    });
    await db.$transaction((tx) => personalIncidentNotifier(tx, i));
    return i;
  }
  it('uses real values, bounds chart buckets, preserves gaps and emits PNG for all five metrics', async () => {
    const end = await readings();
    const data = await telegramChartData(db, f.deviceId, 'temperature_c', 1, end);
    expect(data.points).toHaveLength(60);
    expect(data.summary).toMatchObject({
      valid_count: 2,
      invalid_count: 1,
      min: 20,
      max: 30,
      average: 25,
    });
    expect(data.points.filter((p) => p.value !== null).map((p) => p.value)).toEqual([20, 30]);
    for (const metric of [
      'mq2_adc',
      'mq7_adc',
      'flame',
      'temperature_c',
      'humidity_pct',
    ] as const) {
      const d = await telegramChartData(db, f.deviceId, metric, 168, end);
      expect(d.points).toHaveLength(168);
      const png = await renderTelegramChart(d);
      expect(png?.subarray(1, 4).toString()).toBe('PNG');
      if (metric === 'flame')
        expect(d.points.filter((p) => p.value !== null).map((p) => p.value)).toEqual([1]);
    }
    const empty = await telegramChartData(
      db,
      f.deviceId,
      'mq2_adc',
      1,
      new Date(end.getTime() + 86400000),
    );
    expect(await renderTelegramChart(empty)).toBeNull();
  });
  it('uses weighted retained rollups and refuses mixed ADC resolutions', async () => {
    const end = await readings();
    await db.sensorRollup.create({
      data: {
        deviceId: f.deviceId,
        resolution: 'hour',
        timeBasis: 'sampled',
        metric: 'temperature_c',
        adcBits: 0,
        bucketStart: new Date(end.getTime() - 2 * 3600000),
        totalCount: 8,
        validCount: 8,
        valueSum: 80,
        minimum: 10,
        maximum: 10,
      },
    });
    const data = await telegramChartData(db, f.deviceId, 'temperature_c', 24, end);
    expect(data.summary.average).toBe(13);
    const row = await db.sensorReading.findFirstOrThrow();
    const p = f.payload(10).readings[0]!;
    p.sensors.mq2.adc_bits = 10;
    await db.sensorReading.update({ where: { id: row.id }, data: { payload: p } });
    await expect(telegramChartData(db, f.deviceId, 'mq2_adc', 24, end)).rejects.toMatchObject({
      code: 'INCOMPATIBLE_ADC_PROFILES',
    });
  });
  it('includes partial-hour measurements in reports and combines them with retained hours correctly', async () => {
    const end = await readings();
    const partial = await telegramReport(
      db,
      { from: new Date(end.getTime() - 45 * 60000), to: new Date(end.getTime() - 35 * 60000) },
      f.deviceId,
    );
    expect(partial).toContain('30 / 30 / 30 °C');
    await db.sensorRollup.create({
      data: {
        deviceId: f.deviceId,
        resolution: 'hour',
        timeBasis: 'sampled',
        metric: 'temperature_c',
        adcBits: 0,
        bucketStart: new Date(end.getTime() - 2 * 3600000),
        totalCount: 8,
        validCount: 8,
        valueSum: 80,
        minimum: 10,
        maximum: 10,
      },
    });
    const p = f.payload(4, end.getTime() + 5 * 60000).readings[0]!;
    await db.sensorReading.create({
      data: {
        deviceId: f.deviceId,
        bootId: f.bootId,
        bootCounter: 1n,
        seq: 4n,
        sampledAt: new Date(p.sampled_at!),
        receivedAt: new Date(p.sampled_at!),
        temperatureC: 40,
        humidityPct: 50,
        mq2Adc: 1000,
        mq7Adc: 400,
        payload: p,
        payloadHash: randomUUID(),
      },
    });
    const complete = await telegramReport(
      db,
      { from: new Date(end.getTime() - 3 * 3600000), to: new Date(end.getTime() + 30 * 60000) },
      f.deviceId,
    );
    expect(complete).toContain('15,5 / 10 / 40 °C');
  });
  it('creates accurate report counts and sensor summaries without UUID, ISO or concentrations', async () => {
    const end = await readings();
    const i = await alarm('critical');
    await db.alertIncident.create({
      data: {
        deviceId: f.deviceId,
        condition: 'co',
        severity: 'warning',
        origin: 'snapshot',
        startedAt: new Date(end.getTime() - 3600000),
        endedAt: new Date(end.getTime() - 1000),
        status: 'ended',
      },
    });
    const text = await telegramReport(
      db,
      { from: new Date(end.getTime() - 86400000), to: new Date(end.getTime() + 3600000) },
      f.deviceId,
    );
    expect(text).toContain('WARNING: <b>1</b>');
    expect(text).toContain('CRITICAL: <b>1</b>');
    expect(text).toContain('hiện tại: <b>1</b>');
    expect(text).toContain('trong kỳ: <b>1</b>');
    expect(text).toContain('25 / 20 / 30 °C');
    expect(text).not.toMatch(new RegExp(`${i.id}|PPM|AQI|T[0-9]{2}:`));
  });
  it('sends then edits chart photos and retries failed upload without replaying actions', async () => {
    clock = (await readings()).getTime();
    await command('/chart');
    await click('🌡 Nhiệt độ');
    // Include the completed previous hour even if the current minute advanced.
    await click('24 giờ');
    expect(calls.filter((c) => c.method === 'sendPhoto')).toHaveLength(1);
    expect(calls.some((c) => c.method === 'editMessageMedia')).toBe(true);
    expect(buttons().some((b) => b.text === '✓ 🌡 Nhiệt độ')).toBe(true);
    await command('/chart');
    await click('🌡 Nhiệt độ');
    expect(calls.filter((c) => c.method === 'sendPhoto')).toHaveLength(2);
    await click('🏠 Trang chủ');
    await command('/settings');
    await click('Tắt WARNING');
    await command('/settings');
    expect(screen().text).toContain('WARNING: <b>Tắt</b>');
    expect(screen().text).toContain('Luôn bật');
    await click('📋 Báo cáo định kỳ');
    await click('Hằng tuần');
    await click('T6');
    await click('🕒 Chọn giờ nhận');
    await click('09 giờ');
    await click('30 phút');
    const c = await db.telegramConnection.findUniqueOrThrow({ where: { telegramUserId: tg } });
    expect(c).toMatchObject({
      reportFrequency: 'weekly',
      reportWeekday: 5,
      reportMinute: 570,
      warningEnabled: false,
    });
    expect(c.nextReportAt).not.toBeNull();
  });
  it('retries photo transport without duplicating the text anchor', async () => {
    clock = (await readings()).getTime();
    await command('/chart');
    const cb = buttons().find((b) => b.text.replace(/^✓ /, '') === '🌡 Nhiệt độ')!.callback_data;
    failPhoto = true;
    clock += 6000;
    const update = {
      update_id: ++seq,
      callback_query: {
        id: 'failed-photo',
        from: { id: Number(tg) },
        message: { message_id: 77, chat: { id: Number(tg), type: 'private' } },
        data: cb,
      },
    };
    await expect(processTelegramUpdate(db, update, api, new Date(clock))).rejects.toMatchObject({
      code: 'TELEGRAM_NETWORK_ERROR',
    });
    await processTelegramUpdate(db, update, api, new Date(clock + 1000));
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
    expect(
      (await db.telegramConnection.findUniqueOrThrow({ where: { telegramUserId: tg } })).pending,
    ).toBe(false);
  });
  it('keeps chart controls compact and preserves every sensor, period and display mode', async () => {
    clock = (await readings()).getTime();
    await command('/chart');
    const keyboard = () =>
      (screen().reply_markup as { inline_keyboard: { text: string }[][] }).inline_keyboard;
    expect(keyboard().map((row) => row.length)).toEqual([2, 2, 1, 3, 2, 2, 1]);
    expect(keyboard()[0]!.map((b) => b.text)).toEqual(['MQ-2', 'MQ-7']);
    expect(keyboard()[1]!.map((b) => b.text)).toEqual(['🌡 Nhiệt độ', '💧 Độ ẩm']);
    const sensors = [
      ['MQ-2', 'mq2_adc'],
      ['MQ-7', 'mq7_adc'],
      ['🌡 Nhiệt độ', 'temperature_c'],
      ['💧 Độ ẩm', 'humidity_pct'],
      ['🔥 Lửa', 'flame'],
    ] as const;
    for (const [label, metric] of sensors) {
      await click(label);
      expect(buttons().some((b) => b.text === `✓ ${label}`)).toBe(true);
      for (const [period, hours] of [
        ['1 giờ', 1],
        ['24 giờ', 24],
        ['7 ngày', 168],
      ] as const) {
        await click(period);
        for (const [label, chartMode] of [
          ['Đơn giản', 'simple'],
          ['Chi tiết', 'detailed'],
        ] as const) {
          await click(label);
          expect(buttons().some((b) => b.text === `✓ ${period}`)).toBe(true);
          expect(buttons().some((b) => b.text === `✓ ${label}`)).toBe(true);
          const connection = await db.telegramConnection.findUniqueOrThrow({
            where: { telegramUserId: tg },
          });
          expect(connection.view).toMatchObject({ screen: 'chart', metric, hours, chartMode });
        }
      }
    }
    expect(calls.filter((c) => c.method === 'sendPhoto')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
    await click('📱 Đổi thiết bị');
    await click('⬅️ Quay lại');
    expect(buttons().some((b) => b.text === '✓ Chi tiết')).toBe(true);
    expect(buttons().some((b) => b.text === '✓ 7 ngày')).toBe(true);
  });
  it('shows a concise empty chart state and keeps mode changes functional', async () => {
    await command('/chart');
    await click('MQ-2');
    expect(screen().text).toContain('Chưa có dữ liệu hợp lệ.');
    await click('Chi tiết');
    await click('7 ngày');
    expect(buttons().some((b) => b.text === '✓ Chi tiết')).toBe(true);
    expect(buttons().some((b) => b.text === '✓ 7 ngày')).toBe(true);
    expect(calls.some((c) => c.method === 'sendPhoto')).toBe(false);
  });
  it('keeps same-minute incidents distinct, binds numbered details to IDs and returns to the same filtered page', async () => {
    const time = new Date('2026-11-12T13:48:00Z');
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    const connection = {
      ...(await db.telegramConnection.findUniqueOrThrow({ where: { telegramUserId: tg } })),
      user,
    };
    await db.device.update({ where: { id: f.deviceId }, data: { name: 'Bếp <A&B>' } });
    const incidents = await db.alertIncident.createManyAndReturn({
      data: Array.from({ length: 7 }, () => ({
        deviceId: f.deviceId,
        condition: 'flame',
        severity: 'critical',
        origin: 'event',
        status: 'ended',
        startedAt: time,
        endedAt: new Date(time.getTime() + 20000),
      })),
    });
    const view = {
      screen: 'history' as const,
      deviceId: f.deviceId,
      days: 1 as const,
      severity: 'critical' as const,
      page: 0,
    };
    const first = await telegramBotScreen(db, connection, view, new Date('2026-11-12T14:00:00Z'));
    expect(first.text.match(/Đã kết thúc/g) ?? []).toHaveLength(5);
    expect(first.text.match(/Bếp &lt;A&amp;B&gt;/g) ?? []).toHaveLength(1);
    expect(first.text).not.toMatch(/RESOLVED|T13:|uuid/);
    expect(first.text).toContain('20:48 · 12/11/2026');
    const details = first.rows.flat().filter((b) => b.text.startsWith('Chi tiết #'));
    expect(details.map((b) => b.text)).toEqual([
      'Chi tiết #1',
      'Chi tiết #2',
      'Chi tiết #3',
      'Chi tiết #4',
      'Chi tiết #5',
    ]);
    expect(new Set(details.map((b) => b.action.view.incidentId)).size).toBe(5);
    for (const b of details) expect(incidents.map((i) => i.id)).toContain(b.action.view.incidentId);
    expect(first.rows.slice(0, 3).map((row) => row.length)).toEqual([2, 2, 1]);
    expect(first.rows.flat().some((b) => b.text === '✓ 🔴 CRITICAL')).toBe(true);
    expect(first.rows.flat().some((b) => b.text === '◀️ Trước')).toBe(false);
    const next = first.rows.flat().find((b) => b.text === 'Sau ▶️')!.action.view;
    const second = await telegramBotScreen(db, connection, next, new Date('2026-11-12T14:00:00Z'));
    expect(second.text).toContain('Trang 2');
    expect(second.rows.flat().some((b) => b.text === 'Sau ▶️')).toBe(false);
    const secondIds = second.rows
      .flat()
      .filter((b) => b.text.startsWith('Chi tiết #'))
      .map((b) => b.action.view.incidentId);
    expect(secondIds).toHaveLength(2);
    expect(secondIds.some((id) => details.some((b) => b.action.view.incidentId === id))).toBe(
      false,
    );
    const detailView = second.rows.flat().find((b) => b.text === 'Chi tiết #2')!.action.view;
    const detail = await telegramBotScreen(
      db,
      connection,
      detailView,
      new Date('2026-11-12T14:00:00Z'),
    );
    expect(detail.text).toContain('Thời lượng: 20 giây');
    expect(detail.text).toContain('Nguy hiểm');
    expect(detail.text).not.toContain('RESOLVED');
    const back = detail.rows.flat().find((b) => b.text === '⬅️ Quay lại')!.action.view;
    expect(back).toMatchObject({ ...view, page: 1 });
    const restored = await telegramBotScreen(
      db,
      connection,
      back,
      new Date('2026-11-12T14:00:00Z'),
    );
    expect(
      restored.rows
        .flat()
        .filter((b) => b.text.startsWith('Chi tiết #'))
        .map((b) => b.action.view.incidentId),
    ).toEqual(secondIds);
    const pickerView = second.rows.flat().find((b) => b.text === '📱 Lọc thiết bị')!.action.view;
    const picker = await telegramBotScreen(
      db,
      connection,
      pickerView,
      new Date('2026-11-12T14:00:00Z'),
    );
    expect(picker.rows.flat().find((b) => b.text === '⬅️ Quay lại')!.action.view).toMatchObject({
      ...view,
      page: 1,
    });
    const other = await db.device.create({ data: { name: 'Phòng khác', sourceKind: 'physical' } });
    await db.alertIncident.create({
      data: {
        deviceId: other.id,
        condition: 'co',
        severity: 'warning',
        origin: 'event',
        status: 'ended',
        startedAt: time,
        endedAt: time,
      },
    });
    const all = await telegramBotScreen(
      db,
      connection,
      { screen: 'history' },
      new Date('2026-11-12T14:00:00Z'),
    );
    expect(all.text).toContain('Phòng khác · CO');
    expect(all.text).toContain('Bếp &lt;A&amp;B&gt; · Lửa');
  });
  it('deduplicates concurrent schedulers and sends only one report across worker restart', async () => {
    const due = new Date(Date.now() - 1000);
    await db.telegramConnection.update({
      where: { telegramUserId: tg },
      data: { reportFrequency: 'daily', reportMinute: 480, nextReportAt: due },
    });
    await Promise.all([scheduleTelegramReports(db), scheduleTelegramReports(db)]);
    expect(await db.telegramBotDelivery.count()).toBe(1);
    let sent = 0;
    const send = async () => {
      sent++;
      return { ok: true as const };
    };
    await Promise.all([deliverPersonalTelegram(db, send), deliverPersonalTelegram(db, send)]);
    await scheduleTelegramReports(db);
    await deliverPersonalTelegram(db, send);
    expect(sent).toBe(1);
  });
  it('retries timeout/429, recovers expired leases, and caps attempts', async () => {
    const c = await db.telegramConnection.findUniqueOrThrow({ where: { telegramUserId: tg } });
    await db.$transaction((tx) => queueTelegramTest(tx, c, new Date()));
    const failed = await deliverPersonalTelegram(db, async () => {
      throw new Error('timeout');
    });
    expect(failed).toMatchObject({ status: 'pending' });
    let row = await db.telegramBotDelivery.findFirstOrThrow();
    expect(
      await deliverPersonalTelegram(
        db,
        async () => ({
          ok: false,
          retryable: true,
          code: 'TELEGRAM_RATE_LIMITED',
          retryAfterSeconds: 60,
        }),
        row.nextAttemptAt,
      ),
    ).toMatchObject({ status: 'pending', cooldownMs: 60000 });
    row = await db.telegramBotDelivery.findFirstOrThrow();
    await db.telegramBotDelivery.update({
      where: { id: row.id },
      data: { status: 'sending', leaseToken: randomUUID(), leaseUntil: new Date(0) },
    });
    expect(
      await deliverPersonalTelegram(db, async () => ({ ok: true }), row.nextAttemptAt),
    ).toMatchObject({ status: 'sent' });
    await db.telegramBotDelivery.update({
      where: { id: row.id },
      data: { status: 'pending', attempts: 7, nextAttemptAt: new Date(0) },
    });
    expect(
      await deliverPersonalTelegram(db, async () => ({
        ok: false,
        retryable: true,
        code: 'TELEGRAM_NETWORK_ERROR',
      })),
    ).toMatchObject({ status: 'failed' });
  });
  it('respects WARNING preference but always delivers mandatory Critical and its resolution', async () => {
    const i = await alarm();
    await db.telegramConnection.update({
      where: { telegramUserId: tg },
      data: { warningEnabled: false, trackedDeviceId: randomUUID() },
    });
    let text = '';
    const send = async (_chat: string, t: string) => {
      text = t;
      return { ok: true as const };
    };
    expect(await deliverPersonalTelegram(db, send)).toMatchObject({ status: 'skipped' });
    expect(text).toBe('');
    const critical = await db.alertIncident.update({
      where: { id: i.id },
      data: { severity: 'critical' },
    });
    await db.alertState.updateMany({ where: { incidentId: i.id }, data: { state: 'critical' } });
    await db.$transaction((tx) => personalIncidentNotifier(tx, critical));
    await deliverPersonalTelegram(db, send);
    expect(text).toContain('CRITICAL');
    const ended = await db.alertIncident.update({
      where: { id: i.id },
      data: { status: 'ended', endedAt: new Date() },
    });
    await db.$transaction((tx) => personalIncidentNotifier(tx, ended));
    await deliverPersonalTelegram(db, send);
    expect(text).toContain('RESOLVED');
  });
  it('blocks scheduled jobs after unlink/relink, revoked accounts, disabled reports and archived devices', async () => {
    const c = await db.telegramConnection.findUniqueOrThrow({ where: { telegramUserId: tg } });
    await db.$transaction((tx) => queueTelegramTest(tx, c, new Date()));
    await db.$transaction((tx) => unlinkTelegram(tx, userId));
    await db.telegramConnection.update({ where: { telegramUserId: tg }, data: { userId } });
    let sent = 0;
    const send = async () => {
      sent++;
      return { ok: true as const };
    };
    expect(await deliverPersonalTelegram(db, send)).toMatchObject({ status: 'skipped' });
    expect(sent).toBe(0);
    const linked = await db.telegramConnection.findUniqueOrThrow({ where: { telegramUserId: tg } });
    await db.$transaction((tx) => queueTelegramTest(tx, linked, new Date()));
    await db.user.update({ where: { id: userId }, data: { active: false } });
    await deliverPersonalTelegram(db, send);
    expect(sent).toBe(0);
    await command('/report');
    expect(calls.some((c) => String(c.parameters.text).includes('Báo cáo AirGuard'))).toBe(false);
  });
  it('does not duplicate the legacy channel when it routes to a linked account', async () => {
    const i = await alarm('critical');
    await db.$transaction((tx) => telegramNotifier(true)(tx, i));
    let global = 0,
      personal = 0;
    expect(
      await deliverTelegramNotification(
        db,
        async () => {
          global++;
          return { ok: true };
        },
        new Date(),
        true,
        tg,
      ),
    ).toMatchObject({ code: 'ROUTED_TO_LINKED_ACCOUNT' });
    await deliverPersonalTelegram(db, async () => {
      personal++;
      return { ok: true };
    });
    expect({ global, personal }).toEqual({ global: 0, personal: 1 });
  });
  it('enqueues an ESP32 incident while a Telegram acknowledgement waits for the device lock', async () => {
    const i = await alarm('critical');
    await db.telegramBotDelivery.deleteMany();
    await db.user.update({ where: { id: userId }, data: { role: 'operator' } });
    await command('/alerts');
    await click(buttons().find((b) => b.text.includes('Khí gas'))!.text);
    const data = buttons().find((b) => b.text === '✅ Xác nhận đã đọc')!.callback_data;
    let acknowledging: Promise<unknown> | undefined;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM devices WHERE id=${f.deviceId}::uuid FOR UPDATE`;
      clock += 6000;
      acknowledging = processTelegramUpdate(
        db,
        {
          update_id: ++seq,
          callback_query: {
            id: 'concurrent-ack',
            from: { id: Number(tg) },
            message: { message_id: 77, chat: { id: Number(tg), type: 'private' } },
            data,
          },
        },
        api,
        new Date(clock),
      ).then(
        () => undefined,
        (error) => error,
      );
      let blocked = false;
      for (let n = 0; n < 80; n++) {
        const [row] = await db.$queryRaw<
          { blocked: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=${name} AND wait_event_type='Lock' AND query LIKE '%FROM devices%FOR UPDATE%') AS blocked`;
        if (row?.blocked) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(blocked).toBe(true);
      await personalIncidentNotifier(tx, i);
    });
    expect(await acknowledging).toBeUndefined();
    expect(await db.alertAcknowledgement.count({ where: { incidentId: i.id } })).toBe(1);
    expect(await db.telegramBotDelivery.count({ where: { incidentId: i.id } })).toBe(1);
  });
  it('cancels a queued report when settings change or the selected device is archived', async () => {
    await db.telegramConnection.update({
      where: { telegramUserId: tg },
      data: { reportFrequency: 'daily', nextReportAt: new Date(Date.now() - 1000) },
    });
    await scheduleTelegramReports(db);
    await command('/settings');
    await click('📋 Báo cáo định kỳ');
    await click('Tắt');
    expect((await db.telegramBotDelivery.findFirstOrThrow()).status).toBe('skipped');
    await db.telegramConnection.update({
      where: { telegramUserId: tg },
      data: { reportFrequency: 'weekly', nextReportAt: new Date(Date.now() - 1000) },
    });
    await scheduleTelegramReports(db);
    await db.device.update({ where: { id: f.deviceId }, data: { archivedAt: new Date() } });
    let sent = 0;
    await deliverPersonalTelegram(db, async () => {
      sent++;
      return { ok: true };
    });
    expect(sent).toBe(0);
    await db.$transaction((tx) => unlinkTelegram(tx, userId));
    expect(
      (await db.telegramConnection.findUniqueOrThrow({ where: { telegramUserId: tg } }))
        .nextReportAt,
    ).toBeNull();
  });
  it('gives clear feedback on expensive command rate limits and deduplicates notification checks', async () => {
    await command('/report');
    await processTelegramUpdate(
      db,
      {
        update_id: ++seq,
        message: {
          message_id: seq,
          from: { id: Number(tg) },
          chat: { id: Number(tg), type: 'private' },
          text: '/report',
        },
      },
      api,
      new Date(clock + 1000),
    );
    expect(screen().text).toContain('Vui lòng chờ');
    await command('/settings');
    await click('🔔 Kiểm tra thông báo');
    await click('🔔 Kiểm tra thông báo');
    expect(await db.telegramBotDelivery.count({ where: { kind: 'test' } })).toBeLessThanOrEqual(2);
    const c = await db.telegramConnection.findUniqueOrThrow({ where: { telegramUserId: tg } });
    await db.$transaction((tx) => queueTelegramTest(tx, c, new Date(clock)));
    await db.$transaction((tx) => queueTelegramTest(tx, c, new Date(clock)));
    const minute = `test:${Math.floor(clock / 60000)}`;
    expect(await db.telegramBotDelivery.count({ where: { eventKey: minute } })).toBe(1);
  });
  it('coalesces queued danger to resolved, and connection events to latest ONLINE', async () => {
    const i = await alarm('critical');
    await db.alertIncident.update({
      where: { id: i.id },
      data: { status: 'ended', endedAt: new Date() },
    });
    let text = '';
    await deliverPersonalTelegram(db, async (_c, t) => {
      text = t;
      return { ok: true };
    });
    expect(text).toContain('RESOLVED');
    for (const newStatus of ['offline', 'online']) {
      const h = await db.deviceStatusHistory.create({
        data: {
          deviceId: f.deviceId,
          previousStatus: newStatus === 'offline' ? 'online' : 'offline',
          newStatus,
          effectiveAt: new Date(),
          detectedAt: new Date(),
          reason: newStatus === 'offline' ? 'heartbeat_timeout' : 'authenticated_contact',
        },
      });
      await db.$transaction((tx) => personalConnectivityNotifier(tx, h));
    }
    let sent = 0;
    await deliverPersonalTelegram(db, async (_c, t) => {
      sent++;
      text = t;
      return { ok: true };
    });
    await deliverPersonalTelegram(db, async () => {
      sent++;
      return { ok: true };
    });
    expect(text).toContain('ONLINE');
    expect(sent).toBe(1);
  });
  it('rechecks device archival and denies chart/report access after unlink', async () => {
    await readings();
    await db.device.update({ where: { id: f.deviceId }, data: { archivedAt: new Date() } });
    await expect(telegramChartData(db, f.deviceId, 'mq2_adc', 1, new Date())).rejects.toMatchObject(
      { status: 404 },
    );
    await command('/chart');
    expect(screen().text).toContain('không khả dụng');
    await db.$transaction((tx) => unlinkTelegram(tx, userId));
    await command('/chart');
    await command('/report');
    await command('/settings');
    expect(calls.some((c) => c.method === 'sendPhoto')).toBe(false);
    expect(screen().text).toContain('Liên kết');
  });
});

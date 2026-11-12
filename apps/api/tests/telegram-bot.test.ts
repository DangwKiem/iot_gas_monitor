import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '@iot/database';
import { createApp } from '../src/app.js';
import { hashSecret, newSecret } from '../src/modules/auth.js';
import { processTelegramUpdate, type BotApi } from '../src/modules/telegram-bot.js';
import { startTelegramBot } from '../src/modules/telegram-bot-worker.js';
import { TelegramApiError } from '../src/modules/telegram-client.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('Telegram interactive bot + PostgreSQL', () => {
  const db = createDatabase(process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/iot_test');
  const app = createApp({ db, origin: 'http://localhost:5173', telegramBotKey: 'test-bot' });
  let userId: string, headers: Record<string, string>, tg: number, seq: number, clock: number;
  let calls: { method: string; parameters: Record<string, unknown> }[];
  let fail: string | undefined;
  let published: string[];
  const publish = (type: string, deviceId: string) => published.push(`${type}:${deviceId}`);
  const api: BotApi = async (method, parameters) => {
    calls.push({ method, parameters });
    if (fail === method) {
      fail = undefined;
      throw new TelegramApiError('TELEGRAM_NETWORK_ERROR', true);
    }
    return method === 'answerCallbackQuery' ? true : { message_id: 77 };
  };
  beforeEach(async () => {
    const token = newSecret();
    const user = await db.user.create({
      data: {
        email: `tg-${randomUUID()}@test.local`,
        passwordHash: 'not-a-login-fixture',
        role: 'viewer',
      },
    });
    userId = user.id;
    await db.session.create({
      data: { userId, tokenHash: hashSecret(token), expiresAt: new Date(Date.now() + 3600000) },
    });
    headers = { Cookie: `iot_session=${token}`, 'X-Requested-With': 'AirGuard' };
    tg = Number(`7${Math.floor(Math.random() * 100000000)}`);
    seq = 1;
    clock = Date.now();
    calls = [];
    fail = undefined;
    published = [];
  });
  afterAll(() => db.$disconnect());
  const command = async (text: string) => {
    const update = {
      update_id: seq++,
      message: { message_id: seq, from: { id: tg }, chat: { id: tg, type: 'private' }, text },
    };
    clock += 1000;
    await processTelegramUpdate(db, update, api, new Date(clock), publish);
    return update;
  };
  const screen = () =>
    calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).at(-1)!.parameters;
  const buttons = () =>
    (
      screen().reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }
    ).inline_keyboard.flat();
  const click = async (label: string, data?: string) => {
    const b = buttons().find((b) => b.text === label);
    if (!b && !data) throw new Error(`Button missing: ${label}`);
    clock += 1000;
    await processTelegramUpdate(
      db,
      {
        update_id: seq++,
        callback_query: {
          id: `callback-${seq}`,
          from: { id: tg },
          message: { message_id: 77, chat: { id: tg, type: 'private' } },
          data: data ?? b!.callback_data,
        },
      },
      api,
      new Date(clock),
      publish,
    );
  };
  const issue = async () => {
    const result = await request(app).post('/api/v1/telegram/link-code').set(headers);
    expect(result.status).toBe(200);
    return result.body.data.code as string;
  };
  const link = async () => {
    const code = await issue();
    await command(`/start ${code}`);
    expect(
      (await db.telegramConnection.findUniqueOrThrow({ where: { telegramUserId: String(tg) } }))
        .userId,
    ).toBe(userId);
  };
  it('shows all main buttons to /start and rejects unlinked data access without leaking devices', async () => {
    await command('/start');
    expect(buttons()).toHaveLength(7);
    await click('📱 Danh sách thiết bị');
    expect(screen().text).toContain('Liên kết tài khoản');
    await command('/status');
    expect(screen().text).toContain('Liên kết tài khoản');
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(2);
  });
  it('requires web authentication/CSRF and stores only a hash of a one-use code', async () => {
    expect((await request(app).post('/api/v1/telegram/link-code')).status).toBe(403);
    expect(
      (await request(app).post('/api/v1/telegram/link-code').set('X-Requested-With', 'AirGuard'))
        .status,
    ).toBe(401);
    const code = await issue();
    const stored = await db.telegramLinkCode.findUniqueOrThrow({ where: { userId } });
    expect(stored.tokenHash).toBe(hashSecret(code));
    expect(stored.tokenHash).not.toBe(code);
    await command(`/link ${code}`);
    expect(screen().text).toContain('Đã liên kết');
    expect(await db.telegramLinkCode.count({ where: { userId } })).toBe(0);
    tg += 1;
    await command(`/link ${code}`);
    expect(screen().text).toContain('không hợp lệ');
  });
  it('sends a new response for each command and edits only the latest response for button navigation', async () => {
    await link();
    calls = [];
    let sentId = 100;
    const transport: BotApi = async (method, parameters) => {
      calls.push({ method, parameters });
      return method === 'sendMessage' ? { message_id: ++sentId } : true;
    };
    const run = async (text: string) => {
      clock += 1000;
      const update = {
        update_id: seq++,
        message: { message_id: seq, from: { id: tg }, chat: { id: tg, type: 'private' }, text },
      };
      await processTelegramUpdate(db, update, transport, new Date(clock));
      return update;
    };
    await run('/settings');
    const oldButton = buttons().find((b) => b.text === 'Tắt WARNING')!.callback_data;
    const update = await run('/menu');
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(2);
    expect(calls.some((c) => c.method === 'editMessageText')).toBe(false);
    expect(
      (await db.telegramConnection.findUniqueOrThrow({ where: { telegramUserId: String(tg) } }))
        .messageId,
    ).toBe(102);
    const currentButton = buttons().find((b) => b.text === '📱 Danh sách thiết bị')!.callback_data;
    await processTelegramUpdate(db, update, transport, new Date(clock + 1000));
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(2);
    const callback = async (messageId: number, data: string) => {
      clock += 1000;
      await processTelegramUpdate(
        db,
        {
          update_id: seq++,
          callback_query: {
            id: `new-response-${seq}`,
            from: { id: tg },
            message: { message_id: messageId, chat: { id: tg, type: 'private' } },
            data,
          },
        },
        transport,
        new Date(clock),
      );
    };
    await callback(101, oldButton);
    expect(calls.at(-1)?.parameters.text).toContain('hết hạn');
    expect(
      (await db.telegramConnection.findUniqueOrThrow({ where: { telegramUserId: String(tg) } }))
        .warningEnabled,
    ).toBe(true);
    await callback(102, currentButton);
    expect(calls.filter((c) => c.method === 'editMessageText').at(-1)?.parameters.message_id).toBe(
      102,
    );
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(2);
  });
  it('rejects expired/replaced codes and codes whose web session has been revoked', async () => {
    const old = await issue();
    const current = await issue();
    await command(`/link ${old}`);
    expect(screen().text).toContain('không hợp lệ');
    await db.telegramLinkCode.update({ where: { userId }, data: { expiresAt: new Date(0) } });
    await command(`/link ${current}`);
    expect(screen().text).toContain('không hợp lệ');
    const fresh = await issue();
    await db.session.deleteMany({ where: { userId } });
    await command(`/link ${fresh}`);
    expect(screen().text).toContain('không hợp lệ');
  });
  it('does not silently replace another Telegram account already linked to the user', async () => {
    await link();
    const other = tg;
    const code = await issue();
    tg += 100;
    await command(`/link ${code}`);
    expect(screen().text).toContain('không hợp lệ');
    expect(
      (await db.telegramConnection.findUniqueOrThrow({ where: { userId } })).telegramUserId,
    ).toBe(String(other));
  });
  it('opens charts, reports and persistent settings from the main menu', async () => {
    await link();
    await click('📈 Biểu đồ cảm biến');
    expect(screen().text).toContain('Chọn thiết bị');
    await click('🏠 Trang chủ');
    expect(buttons()).toHaveLength(7);
    await click('📋 Báo cáo');
    expect(screen().text).toContain('Báo cáo AirGuard');
    await click('🏠 Trang chủ');
    await click('⚙️ Cài đặt');
    expect(screen().text).toContain('Tài khoản:');
    await click('Tắt WARNING');
    expect(
      (await db.telegramConnection.findUniqueOrThrow({ where: { telegramUserId: String(tg) } }))
        .warningEnabled,
    ).toBe(false);
    expect(screen().text).toContain('CRITICAL: <b>Luôn bật');
    await click('🏠 Trang chủ');
  });
  it('paginates real devices, selects one and edits its status instead of sending new messages', async () => {
    const devices = await db.device.createManyAndReturn({
      data: Array.from({ length: 7 }, (_, n) => ({
        name: `TG device ${randomUUID()} ${n}`,
        sourceKind: 'physical' as const,
      })),
    });
    await link();
    await command('/devices');
    expect(buttons().some((b) => b.text === 'Sau ▶️')).toBe(true);
    const target = devices[0]!;
    let pages = 0;
    while (!buttons().some((b) => b.text === target.name)) {
      await click('Sau ▶️');
      if (++pages > 200) throw new Error('Device not found');
    }
    await click(target.name);
    expect(screen().text).toContain(target.name);
    expect(screen().text).toContain('OFFLINE');
    expect(screen().text).toContain('Chưa có dữ liệu');
    await click('🔄 Làm mới');
    await command('/status');
    expect(screen().text).toContain(target.name);
    expect(screen().text).not.toContain(target.id);
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(3);
    await click('📱 Chọn thiết bị');
    expect(buttons().some((b) => b.text === 'Sau ▶️')).toBe(true);
  });
  it('checks account access on commands and callbacks after linking', async () => {
    await link();
    await db.user.update({ where: { id: userId }, data: { active: false } });
    await click('📱 Danh sách thiết bị');
    expect(screen().text).toBe('Bạn không có quyền truy cập.');
    await command('/status');
    expect(screen().text).toBe('Bạn không có quyền truy cập.');
  });
  it('rejects forged/expired callbacks, foreign users and wrong message IDs', async () => {
    await link();
    const data = buttons()[0]!.callback_data;
    await click('', `select:${randomUUID()}`);
    expect(calls.at(-1)?.parameters.text).toContain('hết hạn');
    await db.telegramConnection.update({
      where: { telegramUserId: String(tg) },
      data: { callbackExpiresAt: new Date(0) },
    });
    await click('', data);
    expect(calls.at(-1)?.parameters.text).toContain('hết hạn');
    tg += 1;
    await click('', data);
    expect(calls.at(-1)?.parameters.text).toContain('hết hạn');
  });
  it('does not reveal an archived selected device even when an old callback is replayed', async () => {
    await link();
    const device = await db.device.create({
      data: { name: 'Private archived sensor', sourceKind: 'physical', archivedAt: new Date() },
    });
    await db.telegramConnection.update({
      where: { telegramUserId: String(tg) },
      data: { selectedDeviceId: device.id },
    });
    await command('/status');
    expect(screen().text).toBe('Thiết bị không khả dụng.');
    expect(screen().text).not.toContain(device.name);
  });
  it('supports explicit unlink confirmation and invalidates old menus and pending codes', async () => {
    await link();
    const old = buttons()[0]!.callback_data;
    await issue();
    await command('/unlink');
    await click('Giữ liên kết');
    expect(screen().text).toContain('Tài khoản:');
    await command('/unlink');
    await click('Hủy liên kết');
    expect(screen().text).toContain('Đã hủy liên kết');
    expect(
      (await db.telegramConnection.findUniqueOrThrow({ where: { telegramUserId: String(tg) } }))
        .userId,
    ).toBeNull();
    expect(await db.telegramLinkCode.count({ where: { userId } })).toBe(0);
    await click('', old);
    expect(calls.at(-1)?.parameters.text).toContain('hết hạn');
  });
  it('lets the web unlink Telegram and rejects old callbacks afterwards', async () => {
    await link();
    const data = buttons()[0]!.callback_data;
    expect((await request(app).delete('/api/v1/telegram/link').set(headers)).status).toBe(204);
    await click('', data);
    expect(calls.at(-1)?.parameters.text).toContain('hết hạn');
    expect((await request(app).get('/api/v1/telegram/link').set(headers)).body.data.linked).toBe(
      false,
    );
  });
  it('does not spam duplicate updates or rapid button clicks', async () => {
    const update = await command('/start');
    const before = calls.length;
    await processTelegramUpdate(db, update, api, new Date(clock), publish);
    expect(calls).toHaveLength(before);
    await processTelegramUpdate(
      db,
      {
        update_id: seq++,
        callback_query: {
          id: 'rapid',
          from: { id: tg },
          message: { message_id: 77, chat: { id: tg, type: 'private' } },
          data: buttons()[0]!.callback_data,
        },
      },
      api,
      new Date(clock + 1),
    );
    expect(calls.at(-1)?.method).toBe('answerCallbackQuery');
    expect(calls.at(-1)?.parameters.text).toContain('chờ');
  });
  it('retries an interrupted command reply without consuming the link code twice', async () => {
    await command('/start');
    const code = await issue();
    fail = 'sendMessage';
    const id = seq;
    await expect(command(`/link ${code}`)).rejects.toMatchObject({
      code: 'TELEGRAM_NETWORK_ERROR',
    });
    await processTelegramUpdate(
      db,
      {
        update_id: id,
        message: {
          message_id: 99,
          from: { id: tg },
          chat: { id: tg, type: 'private' },
          text: `/link ${code}`,
        },
      },
      api,
      new Date(clock + 1000),
    );
    expect(screen().text).toContain('Đã liên kết');
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(3);
    expect(await db.telegramLinkCode.count({ where: { userId } })).toBe(0);
  });
  it('ignores group chats and answers group callbacks without exposing account data', async () => {
    await processTelegramUpdate(
      db,
      {
        update_id: 1,
        callback_query: {
          id: 'group',
          from: { id: tg },
          message: { message_id: 1, chat: { id: -1234, type: 'group' } },
          data: 'x',
        },
      },
      api,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.parameters.text).toContain('chat riêng');
  });
  it('invalidates a linked bot when the account password is changed', async () => {
    await link();
    // Admin password reset uses the existing session revocation service.
    await db.user.update({ where: { id: userId }, data: { role: 'admin' } });
    const target = await db.user.create({
      data: {
        email: `reset-${randomUUID()}@test.local`,
        passwordHash: 'not-a-login-fixture',
        role: 'viewer',
      },
    });
    await db.telegramConnection.create({
      data: { telegramUserId: String(tg + 1), chatId: String(tg + 1), userId: target.id },
    });
    expect(
      (
        await request(app)
          .patch(`/api/v1/users/${target.id}`)
          .set(headers)
          .send({ password: 'new-secure-password' })
      ).status,
    ).toBe(200);
    expect(
      (await db.telegramConnection.findUniqueOrThrow({ where: { telegramUserId: String(tg + 1) } }))
        .userId,
    ).toBeNull();
  });
  it('handles /status with no selection by opening the real device picker', async () => {
    await link();
    await command('/status');
    expect(screen().text).toContain('Danh sách thiết bị');
  });
  it('answers callbacks from a different message and keeps the current view', async () => {
    await link();
    const data = buttons()[0]!.callback_data;
    const before = calls.filter((c) => c.method === 'editMessageText').length;
    await processTelegramUpdate(
      db,
      {
        update_id: seq++,
        callback_query: {
          id: 'wrong-message',
          from: { id: tg },
          message: { message_id: 9999, chat: { id: tg, type: 'private' } },
          data,
        },
      },
      api,
      new Date(clock + 1000),
    );
    expect(calls.at(-1)?.parameters.text).toContain('hết hạn');
    expect(calls.filter((c) => c.method === 'editMessageText')).toHaveLength(before);
  });
  it('persists the polling offset, uses one owner and cancels an in-flight request on shutdown', async () => {
    const token = newSecret();
    const key = hashSecret(token);
    let polls = 0;
    const menuCalls: { method: string; parameters: Record<string, unknown> }[] = [];
    let pollStarted!: () => void;
    const entered = new Promise<void>((resolve) => {
      pollStarted = resolve;
    });
    const transport: typeof fetch = async (url, init) => {
      const method = String(url).split('/').at(-1);
      if (method === 'setMyCommands' || method === 'setChatMenuButton') {
        menuCalls.push({ method, parameters: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ ok: true, result: true }));
      }
      if (method === 'getMe')
        return new Response(
          JSON.stringify({ ok: true, result: { is_bot: true, username: 'AirGuardTestBot' } }),
        );
      if (method === 'getUpdates') {
        polls++;
        if (polls === 1)
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 100,
                  message: {
                    message_id: 1,
                    from: { id: tg },
                    chat: { id: tg, type: 'private' },
                    text: '/start',
                  },
                },
              ],
            }),
          );
        expect(JSON.parse(String(init?.body)).offset).toBe(101);
        pollStarted();
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }));
    };
    const stop = startTelegramBot(db, { token }, () => {}, transport);
    await entered;
    const otherStop = startTelegramBot(
      db,
      { token },
      () => {},
      async () => {
        throw new Error('Second worker must not poll');
      },
    );
    await otherStop();
    await stop();
    await stop();
    expect(await db.telegramBotCursor.findUniqueOrThrow({ where: { id: key } })).toMatchObject({
      offset: 101n,
      leaseToken: null,
    });
    expect(polls).toBe(2);
    expect(menuCalls.map((c) => c.method)).toEqual([
      'setMyCommands',
      'setMyCommands',
      'setChatMenuButton',
    ]);
    expect(menuCalls[0]!.parameters).toMatchObject({
      scope: { type: 'all_private_chats' },
      language_code: '',
    });
    expect(menuCalls[1]!.parameters.language_code).toBe('vi');
    expect(menuCalls[2]!.parameters).toEqual({ menu_button: { type: 'commands' } });
  });
  it('leaves a failed update unconfirmed for retry after a Telegram timeout', async () => {
    const token = newSecret();
    const key = hashSecret(token);
    let failed!: () => void;
    const done = new Promise<void>((resolve) => {
      failed = resolve;
    });
    const transport: typeof fetch = async (url) => {
      const method = String(url).split('/').at(-1);
      return new Response(
        JSON.stringify(
          method === 'getMe'
            ? { ok: true, result: { is_bot: true, username: 'AirGuardTestBot' } }
            : method === 'setMyCommands' || method === 'setChatMenuButton'
              ? { ok: true, result: true }
              : method === 'getUpdates'
                ? {
                    ok: true,
                    result: [
                      {
                        update_id: 200,
                        message: {
                          message_id: 1,
                          from: { id: tg },
                          chat: { id: tg, type: 'private' },
                          text: '/start',
                        },
                      },
                    ],
                  }
                : { ok: false, error_code: 500 },
        ),
      );
    };
    const stop = startTelegramBot(db, { token }, () => failed(), transport);
    await done;
    await stop();
    const cursor = await db.telegramBotCursor.findUniqueOrThrow({ where: { id: key } });
    expect(cursor.offset).toBe(0n);
    const connection = await db.telegramConnection.findUniqueOrThrow({
      where: { telegramUserId: String(tg) },
    });
    expect(connection.pending).toBe(true);
  });
  async function alarm() {
    const d = await db.device.create({
      data: {
        name: `TG alarm ${randomUUID().slice(0, 8)}`,
        sourceKind: 'physical',
        connectivity: 'online',
        lastSeenAt: new Date(),
      },
    });
    const incident = await db.alertIncident.create({
      data: {
        deviceId: d.id,
        condition: 'gas',
        severity: 'critical',
        origin: 'snapshot',
        startedAt: new Date(),
      },
    });
    await db.alertState.create({
      data: {
        deviceId: d.id,
        condition: 'gas',
        state: 'critical',
        incidentId: incident.id,
        bootId: randomUUID(),
        bootCounter: 1n,
        seq: 1n,
        updatedAt: new Date(),
      },
    });
    return { d, incident };
  }
  it('opens /alerts details and acknowledges through the same service as the dashboard', async () => {
    await db.user.update({ where: { id: userId }, data: { role: 'operator' } });
    await link();
    const { d, incident } = await alarm();
    await command('/alerts');
    expect(screen().text).toContain('ACTIVE');
    expect(screen().text).toContain(d.name);
    expect(screen().text).not.toContain(incident.id);
    await click(`${d.name} · Khí gas`);
    expect(screen().text).toContain('CRITICAL');
    await click('✅ Xác nhận đã đọc');
    expect(screen().text).toContain('ACKNOWLEDGED');
    expect(screen().text).toContain('chưa kết thúc');
    expect((await db.alertIncident.findUniqueOrThrow({ where: { id: incident.id } })).status).toBe(
      'active',
    );
    expect(await db.alertAcknowledgement.count({ where: { incidentId: incident.id } })).toBe(1);
    expect(published).toContain(`alert.acknowledged:${d.id}`);
    const web = await request(app).get(`/api/v1/alerts/incidents/${incident.id}`).set(headers);
    expect(web.body.data).toMatchObject({
      lifecycle: 'ACKNOWLEDGED',
      status: 'active',
      current_severity: 'critical',
    });
    await click('⬅️ Quay lại');
    expect(screen().text).toContain('ACKNOWLEDGED');
  });
  it('denies a cached acknowledgement button after permissions change and rejects archived incidents', async () => {
    await db.user.update({ where: { id: userId }, data: { role: 'operator' } });
    await link();
    const { d, incident } = await alarm();
    await command('/alerts');
    await click(`${d.name} · Khí gas`);
    await db.user.update({ where: { id: userId }, data: { role: 'viewer' } });
    await click('✅ Xác nhận đã đọc');
    expect(calls.at(-1)?.parameters.text).toContain('không có quyền');
    expect(await db.alertAcknowledgement.count({ where: { incidentId: incident.id } })).toBe(0);
    await db.user.update({ where: { id: userId }, data: { role: 'operator' } });
    await db.device.update({ where: { id: d.id }, data: { archivedAt: new Date() } });
    await click('✅ Xác nhận đã đọc');
    expect(calls.at(-1)?.parameters.text).toContain('không khả dụng');
    expect(await db.alertAcknowledgement.count({ where: { incidentId: incident.id } })).toBe(0);
    await click('🔄 Làm mới');
    expect(screen().text).toBe('Sự cố không khả dụng.');
  });
  it('keeps resolved state when an incident ends before an old acknowledge action is used', async () => {
    await db.user.update({ where: { id: userId }, data: { role: 'operator' } });
    await link();
    const { d, incident } = await alarm();
    await command('/alerts');
    await click(`${d.name} · Khí gas`);
    await db.alertIncident.update({
      where: { id: incident.id },
      data: { status: 'ended', endedAt: new Date() },
    });
    await click('✅ Xác nhận đã đọc');
    expect(screen().text).toContain('RESOLVED');
    expect((await db.alertIncident.findUniqueOrThrow({ where: { id: incident.id } })).status).toBe(
      'ended',
    );
  });
  it('filters /history by device, 24h/7d/30d and peak severity, with next/back navigation', async () => {
    await link();
    const { d, incident } = await alarm();
    const now = Date.now();
    await db.alertIncident.update({
      where: { id: incident.id },
      data: {
        severity: 'warning',
        status: 'ended',
        startedAt: new Date(now - 2 * 86400000),
        endedAt: new Date(now - 2 * 86400000 + 1000),
      },
    });
    await db.alertIncident.create({
      data: {
        deviceId: d.id,
        condition: 'co',
        severity: 'critical',
        origin: 'event',
        status: 'ended',
        startedAt: new Date(now - 10 * 86400000),
        endedAt: new Date(now - 10 * 86400000 + 1000),
      },
    });
    await command('/history');
    await click('📱 Lọc thiết bị');
    let pages = 0;
    while (!buttons().some((b) => b.text === d.name)) {
      await click('Sau ▶️');
      if (++pages > 200) throw new Error('History device missing');
    }
    await click(d.name);
    expect(screen().text).toContain('Không có sự cố');
    await click('7 ngày');
    expect(screen().text).toContain('Khí gas');
    expect(screen().text).not.toContain(' · CO');
    await click('🔴 CRITICAL');
    expect(screen().text).toContain('Không có sự cố');
    await click('30 ngày');
    expect(screen().text).toContain(' · CO');
    expect(screen().text).not.toContain(' · Khí gas');
    await click('🟠 WARNING');
    expect(screen().text).toContain('Khí gas');
    await db.alertIncident.createMany({
      data: Array.from({ length: 6 }, () => ({
        deviceId: d.id,
        condition: 'gas',
        severity: 'warning',
        origin: 'event',
        status: 'ended',
        startedAt: new Date(),
        endedAt: new Date(),
      })),
    });
    await click('🔄 Làm mới');
    expect(buttons().some((b) => b.text === 'Sau ▶️')).toBe(true);
    await click('Sau ▶️');
    expect(buttons().some((b) => b.text === '◀️ Trước')).toBe(true);
    await click('◀️ Trước');
    await click('⬅️ Quay lại');
    expect(buttons()).toHaveLength(7);
  });
  it('blocks alerts/history for unlinked and disabled accounts without reading incidents', async () => {
    await command('/alerts');
    expect(screen().text).toContain('Liên kết tài khoản');
    await command('/history');
    expect(screen().text).toContain('Liên kết tài khoản');
    await link();
    await db.user.update({ where: { id: userId }, data: { active: false } });
    await command('/alerts');
    expect(screen().text).toBe('Bạn không có quyền truy cập.');
    await command('/history');
    expect(screen().text).toBe('Bạn không có quyền truy cập.');
  });
});

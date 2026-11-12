import type { Database } from '@iot/database';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hashSecret } from './auth.js';
import { processTelegramUpdate } from './telegram-bot.js';
import { telegramRequest, TelegramApiError, type TelegramBotConfig } from './telegram-client.js';

export const telegramCommands = [
  { command: 'start', description: 'Bắt đầu và mở menu' },
  { command: 'menu', description: 'Mở menu chính' },
  { command: 'devices', description: 'Danh sách thiết bị' },
  { command: 'status', description: 'Trạng thái cảm biến' },
  { command: 'alerts', description: 'Cảnh báo hiện tại' },
  { command: 'history', description: 'Lịch sử cảnh báo' },
  { command: 'chart', description: 'Biểu đồ cảm biến' },
  { command: 'report', description: 'Báo cáo thống kê' },
  { command: 'settings', description: 'Cài đặt Telegram' },
  { command: 'link', description: 'Liên kết tài khoản' },
  { command: 'unlink', description: 'Hủy liên kết tài khoản' },
];

export function startTelegramBot(
  db: Database,
  config: TelegramBotConfig,
  log: (entry: { code: string }) => void,
  request: typeof fetch = fetch,
  publish: (type: string, deviceId: string) => void = () => {},
) {
  const id = hashSecret(config.token);
  const leaseToken = randomUUID();
  const stop = new AbortController();
  let active: Promise<void> | undefined;
  let pauseUntil = 0;
  let shutdown: Promise<void> | undefined;
  let menuReady = false;
  let menuRetryAt = 0;
  const tick = () => {
    if (stop.signal.aborted || active || Date.now() < pauseUntil) return;
    active = (async () => {
      const now = new Date();
      const cursor = await db.$transaction(async (tx) => {
        await tx.telegramBotCursor.upsert({ where: { id }, create: { id }, update: {} });
        const claim = await tx.telegramBotCursor.updateMany({
          where: { id, OR: [{ leaseToken }, { leaseUntil: null }, { leaseUntil: { lte: now } }] },
          data: { leaseToken, leaseUntil: new Date(now.getTime() + 90000) },
        });
        return claim.count ? tx.telegramBotCursor.findUniqueOrThrow({ where: { id } }) : null;
      });
      if (!cursor) return;
      const lease = new AbortController();
      const signal = AbortSignal.any([stop.signal, lease.signal]);
      let renewing = false;
      let renewal: Promise<unknown> | undefined;
      const renew = setInterval(() => {
        if (renewing) return;
        renewing = true;
        renewal = db.telegramBotCursor
          .updateMany({
            where: { id, leaseToken, leaseUntil: { gt: new Date() } },
            data: { leaseUntil: new Date(Date.now() + 90000) },
          })
          .then((result) => {
            if (!result.count) lease.abort();
          })
          .catch(() => lease.abort())
          .finally(() => {
            renewing = false;
          });
      }, 20000);
      renew.unref();
      const api = (
        method: Parameters<typeof telegramRequest>[1],
        parameters: Record<string, unknown>,
      ) => telegramRequest(config.token, method, parameters, request, signal);
      try {
        if (!menuReady && Date.now() >= menuRetryAt) {
          try {
            for (const language_code of ['', 'vi']) {
              z.literal(true).parse(
                await api('setMyCommands', {
                  commands: telegramCommands,
                  scope: { type: 'all_private_chats' },
                  language_code,
                }),
              );
            }
            z.literal(true).parse(
              await api('setChatMenuButton', { menu_button: { type: 'commands' } }),
            );
            menuReady = true;
          } catch (error) {
            if (signal.aborted) return;
            log({
              code: error instanceof TelegramApiError ? error.code : 'TELEGRAM_MENU_SETUP_FAILED',
            });
            menuRetryAt =
              Date.now() +
              Math.max(
                60000,
                error instanceof TelegramApiError ? (error.retryAfterSeconds ?? 0) * 1000 : 0,
              );
          }
        }
        if (!cursor.username) {
          const me = z
            .object({ username: z.string().regex(/^[A-Za-z0-9_]{5,32}$/), is_bot: z.literal(true) })
            .parse(await api('getMe', {}));
          await db.telegramBotCursor.updateMany({
            where: { id, leaseToken },
            data: { username: me.username },
          });
        }
        const updates = z
          .array(
            z
              .object({ update_id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
              .passthrough(),
          )
          .max(100)
          .parse(
            await api('getUpdates', {
              offset: Number(cursor.offset),
              timeout: 20,
              limit: 20,
              allowed_updates: ['message', 'callback_query'],
            }),
          );
        for (const update of updates.sort((a, b) => a.update_id - b.update_id)) {
          if (signal.aborted) break;
          try {
            await processTelegramUpdate(db, update, api, new Date(), publish);
          } catch (error) {
            if (!(error instanceof TelegramApiError) || error.retryable) throw error;
            log({ code: error.code });
          }
          const advanced = await db.telegramBotCursor.updateMany({
            where: { id, leaseToken, leaseUntil: { gt: new Date() } },
            data: { offset: BigInt(update.update_id) + 1n },
          });
          if (!advanced.count) break;
        }
      } finally {
        clearInterval(renew);
        await renewal;
      }
    })()
      .catch((error) => {
        if (stop.signal.aborted) return;
        log({ code: error instanceof TelegramApiError ? error.code : 'TELEGRAM_BOT_FAILED' });
        pauseUntil =
          Date.now() +
          Math.max(
            5000,
            error instanceof TelegramApiError ? (error.retryAfterSeconds ?? 0) * 1000 : 0,
          );
      })
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(tick, 1000);
  timer.unref();
  tick();
  return () =>
    (shutdown ??= (async () => {
      stop.abort();
      clearInterval(timer);
      await active;
      await db.telegramBotCursor.updateMany({
        where: { id, leaseToken },
        data: { leaseToken: null, leaseUntil: null },
      });
    })());
}

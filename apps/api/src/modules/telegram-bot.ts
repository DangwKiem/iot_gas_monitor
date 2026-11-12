import { nextReportTime } from './telegram-data.js';
import { queueTelegramTest } from './telegram-deliveries.js';
import type { Database } from '@iot/database';
import { acknowledgeIncident } from './incident-service.js';
import { ApiError } from '../lib/errors.js';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { consumeTelegramCode, unlinkTelegram } from './telegram-links.js';
import { telegramBotScreen, type BotView } from './telegram-bot-view.js';
import { TelegramApiError, type TelegramMethod } from './telegram-client.js';
import { escapeTelegramHtml } from './telegram-message.js';
export type BotApi = (
  method: TelegramMethod,
  parameters: Record<string, unknown>,
) => Promise<unknown>;
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const actor = z.object({ id: integer.positive(), is_bot: z.boolean().optional() });
const message = z.object({
  message_id: integer.positive(),
  chat: z.object({
    id: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    type: z.string(),
  }),
  from: actor.optional(),
  text: z.string().max(4096).optional(),
});
const updateSchema = z.object({
  update_id: integer,
  message: message.optional(),
  callback_query: z
    .object({
      id: z.string().min(1).max(200),
      from: actor,
      message: message.optional(),
      data: z.string().optional(),
    })
    .optional(),
});
const viewSchema = z.object({
  screen: z.enum([
    'menu',
    'devices',
    'status',
    'settings',
    'unlink',
    'alerts',
    'history',
    'incident',
    'history-devices',
    'chart',
    'report',
    'chart-devices',
    'report-devices',
    'tracking-devices',
    'report-settings',
    'report-time',
  ]),
  page: z.number().int().min(0).max(1000000).optional(),
  metric: z.enum(['mq2_adc', 'mq7_adc', 'flame', 'temperature_c', 'humidity_pct']).optional(),
  hours: z.union([z.literal(1), z.literal(24), z.literal(168)]).optional(),
  chartMode: z.enum(['simple', 'detailed']).optional(),
  returnPage: z.number().int().min(0).max(1000000).optional(),
  days: z.union([z.literal(1), z.literal(7), z.literal(30)]).optional(),
  severity: z.enum(['warning', 'critical']).optional(),
  deviceId: z.uuid().optional(),
  incidentId: z.uuid().optional(),
  returnTo: z.enum(['alerts', 'history']).optional(),
  notice: z.string().max(200).optional(),
});
const actionSchema = z
  .array(
    z.object({
      view: viewSchema,
      deviceId: z.uuid().optional(),
      ackIncidentId: z.uuid().optional(),
      unlink: z.boolean().optional(),
      testNotification: z.boolean().optional(),
      setting: z
        .object({
          warningEnabled: z.boolean().optional(),
          trackedDeviceId: z.uuid().nullable().optional(),
          reportFrequency: z.enum(['off', 'daily', 'weekly']).optional(),
          reportHour: z.number().int().min(0).max(23).optional(),
          reportMinute: z.number().int().min(0).max(59).optional(),
          reportWeekday: z.number().int().min(0).max(6).optional(),
        })
        .optional(),
    }),
  )
  .max(64);
export async function processTelegramUpdate(
  db: Database,
  raw: unknown,
  api: BotApi,
  now = new Date(),
  publish: (type: string, deviceId: string) => void = () => {},
) {
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) {
    const query = z
      .object({ callback_query: z.object({ id: z.string().min(1).max(200) }) })
      .safeParse(raw);
    if (query.success)
      await api('answerCallbackQuery', {
        callback_query_id: query.data.callback_query.id,
        text: 'Nút không khả dụng. Gửi /start để mở lại.',
        cache_time: 0,
      }).catch(() => {});
    return;
  }
  const update = parsed.data;
  const callback = update.callback_query;
  const m = callback?.message ?? update.message;
  const from = callback?.from ?? update.message?.from;
  const acknowledge = async (text?: string) => {
    if (callback)
      await api('answerCallbackQuery', {
        callback_query_id: callback.id,
        ...(text ? { text } : {}),
        cache_time: 0,
      }).catch(() => {});
  };
  if (!m || !from || from.is_bot || m.chat.type !== 'private' || m.chat.id !== from.id) {
    await acknowledge('Chỉ hỗ trợ chat riêng với bot.');
    return;
  }
  const telegramUserId = String(from.id);
  const chatId = String(m.chat.id);
  try {
    await db.telegramConnection.upsert({
      where: { telegramUserId },
      create: { telegramUserId, chatId },
      update: {},
    });
    const decision = await db.$transaction(async (tx) => {
      // Serialize interactions while allowing incident enqueue's foreign-key check.
      await tx.$queryRaw`SELECT telegram_user_id FROM telegram_connections WHERE telegram_user_id=${telegramUserId} FOR NO KEY UPDATE`;
      const connection = await tx.telegramConnection.findUniqueOrThrow({
        where: { telegramUserId },
        include: { user: true },
      });
      if (BigInt(update.update_id) <= connection.lastUpdateId)
        return { render: connection.pending };
      if (connection.nextAllowedAt && connection.nextAllowedAt > now)
        return { render: false, toast: 'Vui lòng chờ một chút.' };
      let view: BotView & { notice?: string } = { screen: 'menu' };
      let selectedDeviceId = connection.selectedDeviceId;
      let publishDeviceId: string | undefined;
      if (callback) {
        const match = callback.data?.match(/^ag_([A-Za-z0-9_-]{16})_(\d{1,2})$/);
        const actions = actionSchema.safeParse(connection.actions);
        const action = match && actions.success ? actions.data[Number(match[2])] : undefined;
        if (
          !action ||
          match![1] !== connection.callbackToken ||
          !connection.callbackExpiresAt ||
          connection.callbackExpiresAt <= now ||
          m.message_id !== connection.messageId
        )
          return { render: false, toast: 'Menu đã hết hạn. Gửi /start để mở lại.' };
        view = action.view;
        if (action.setting || action.testNotification) {
          if (
            !connection.user?.active ||
            !['admin', 'operator', 'viewer'].includes(connection.user.role)
          )
            return { render: false, toast: 'Bạn không có quyền truy cập.' };
          if (action.setting) {
            const setting = action.setting;
            if (
              setting.trackedDeviceId &&
              !(await tx.device.findFirst({
                where: { id: setting.trackedDeviceId, archivedAt: null },
              }))
            )
              return { render: false, toast: 'Thiết bị không khả dụng.' };
            const reportFrequency = setting.reportFrequency ?? connection.reportFrequency;
            const reportMinute =
              (setting.reportHour ?? Math.floor(connection.reportMinute / 60)) * 60 +
              (setting.reportMinute ?? connection.reportMinute % 60);
            const reportWeekday = setting.reportWeekday ?? connection.reportWeekday;
            const scheduleChanged =
              setting.reportFrequency !== undefined ||
              setting.reportHour !== undefined ||
              setting.reportMinute !== undefined ||
              setting.reportWeekday !== undefined;
            await tx.telegramConnection.update({
              where: { telegramUserId },
              data: {
                warningEnabled: setting.warningEnabled,
                trackedDeviceId: setting.trackedDeviceId,
                reportFrequency,
                reportMinute,
                reportWeekday,
                ...(scheduleChanged
                  ? {
                      nextReportAt: nextReportTime(
                        reportFrequency,
                        reportMinute,
                        reportWeekday,
                        now,
                      ),
                    }
                  : {}),
              },
            });
            if (scheduleChanged || setting.trackedDeviceId !== undefined)
              await tx.telegramBotDelivery.updateMany({
                where: {
                  connectionId: telegramUserId,
                  kind: 'report',
                  status: { in: ['pending', 'sending'] },
                },
                data: {
                  status: 'skipped',
                  leaseToken: null,
                  leaseUntil: null,
                  lastErrorCode: 'REPORT_SETTINGS_CHANGED',
                },
              });
            await tx.auditLog.create({
              data: {
                userId: connection.userId,
                resourceType: 'user',
                resourceId: connection.userId,
                action: 'telegram.settings_updated',
                metadata: {
                  warning_enabled: setting.warningEnabled,
                  report_frequency: setting.reportFrequency,
                },
              },
            });
          }
          if (action.testNotification) {
            await queueTelegramTest(tx, connection, now);
            view = { screen: 'settings', notice: 'Đã yêu cầu kiểm tra thông báo.' };
          }
        }
        if (action.ackIncidentId) {
          if (!connection.userId)
            return { render: false, toast: 'Bạn không có quyền xác nhận sự cố.' };
          try {
            publishDeviceId = (
              await acknowledgeIncident(tx, action.ackIncidentId, connection.userId, '', true)
            ).deviceId;
          } catch (error) {
            if (error instanceof ApiError && [403, 404].includes(error.status))
              return { render: false, toast: error.message };
            throw error;
          }
        }

        if (action.unlink && connection.userId) {
          await unlinkTelegram(tx, connection.userId);
          selectedDeviceId = null;
          view = { screen: 'menu', notice: 'Đã hủy liên kết Telegram.' };
        } else if (action.deviceId) {
          if (
            !connection.user?.active ||
            !['admin', 'operator', 'viewer'].includes(connection.user.role)
          )
            return { render: false, toast: 'Bạn không có quyền truy cập.' };
          const device = await tx.device.findFirst({
            where: { id: action.deviceId, archivedAt: null },
            select: { id: true },
          });
          if (!device) return { render: false, toast: 'Thiết bị không khả dụng.' };
          selectedDeviceId = device.id;
        }
      } else {
        const [rawCommand, code] = (m.text ?? '').trim().split(/\s+/);
        const command = rawCommand?.split('@')[0]?.toLowerCase();
        if ((command === '/link' || command === '/start') && code) {
          const linked = await consumeTelegramCode(tx, telegramUserId, code, now);
          view = {
            screen: 'menu',
            notice: linked ? 'Đã liên kết tài khoản.' : 'Mã liên kết không hợp lệ hoặc đã hết hạn.',
          };
          if (linked) selectedDeviceId = null;
        } else if (command === '/start' || command === '/menu') view = { screen: 'menu' };
        else if (command === '/devices') view = { screen: 'devices' };
        else if (command === '/alerts') view = { screen: 'alerts' };
        else if (command === '/history') view = { screen: 'history', days: 1 };
        else if (command === '/chart') view = { screen: 'chart' };
        else if (command === '/report') view = { screen: 'report', days: 1 };
        else if (command === '/settings') view = { screen: 'settings' };
        else if (command === '/status') view = { screen: 'status' };
        else if (command === '/unlink') view = { screen: 'unlink' };
        else if (command === '/link')
          view = { screen: 'menu', notice: 'Tạo mã liên kết tại Cài đặt → Telegram trên web.' };
      }
      let heavy = view.screen === 'report' || (view.screen === 'chart' && view.metric);
      if (heavy && connection.queryAllowedAt && connection.queryAllowedAt > now) {
        if (callback) return { render: false, toast: 'Vui lòng chờ vài giây trước khi thử lại.' };
        view = { screen: 'menu', notice: 'Vui lòng chờ vài giây trước khi thử lại.' };
        heavy = false;
      }
      await tx.telegramConnection.update({
        where: { telegramUserId },
        data: {
          selectedDeviceId,
          ...(!callback
            ? {
                messageId: null,
                photoMessageId: null,
                callbackToken: '',
                callbackExpiresAt: null,
                actions: [],
              }
            : {}),
          ...(heavy ? { queryAllowedAt: new Date(now.getTime() + 5000) } : {}),
          view,
          lastUpdateId: BigInt(update.update_id),
          pending: true,
          nextAllowedAt: new Date(now.getTime() + 700),
        },
      });
      return { render: true, publishDeviceId };
    });
    if ('publishDeviceId' in decision && decision.publishDeviceId)
      publish('alert.acknowledged', decision.publishDeviceId);
    await acknowledge('toast' in decision ? decision.toast : undefined);
    if (!decision.render) return;
    const connection = await db.telegramConnection.findUniqueOrThrow({
      where: { telegramUserId },
      include: { user: true },
    });
    const view = viewSchema.safeParse(connection.view);
    const screen = await telegramBotScreen(
      db,
      connection,
      view.success ? view.data : { screen: 'menu' },
      now,
    );
    const stillAllowed = () =>
      db.telegramConnection.findFirst({
        where: {
          telegramUserId,
          userId: connection.userId,
          linkVersion: connection.linkVersion,
          ...(connection.userId && connection.user?.active
            ? { user: { active: true, role: { in: ['admin', 'operator', 'viewer'] } } }
            : {}),
        },
      });
    if (!(await stillAllowed())) return;
    if (view.success && view.data.notice)
      screen.text = `${escapeTelegramHtml(view.data.notice)}\n\n${screen.text}`;
    if (
      view.success &&
      view.data.screen !== 'menu' &&
      !screen.rows.flat().some((b) => b.action.view.screen === 'menu')
    )
      screen.rows.push([{ text: '🏠 Trang chủ', action: { view: { screen: 'menu' } } }]);
    const callbackToken = randomBytes(12).toString('base64url');
    const actions = screen.rows.flatMap((row) => row.map((button) => button.action));
    let index = 0;
    const keyboard = screen.rows.map((row) =>
      row.map((button) => ({ text: button.text, callback_data: `ag_${callbackToken}_${index++}` })),
    );
    const saved = await db.telegramConnection.updateMany({
      where: { telegramUserId, lastUpdateId: connection.lastUpdateId, userId: connection.userId },
      data: { callbackToken, actions, callbackExpiresAt: new Date(now.getTime() + 900000) },
    });
    if (!saved.count) return;
    const parameters = {
      chat_id: chatId,
      text: screen.text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard },
      link_preview_options: { is_disabled: true },
    };
    let messageId = connection.messageId;
    if (messageId) {
      try {
        await api('editMessageText', { ...parameters, message_id: messageId });
      } catch (error) {
        if (!(error instanceof TelegramApiError)) throw error;
        if (error.code === 'TELEGRAM_MESSAGE_GONE') messageId = null;
        else if (error.code !== 'TELEGRAM_NOT_MODIFIED') throw error;
      }
    }
    if (!messageId) {
      const result = z
        .object({ message_id: integer.positive() })
        .safeParse(await api('sendMessage', parameters));
      if (!result.success) throw new TelegramApiError('TELEGRAM_RESPONSE_INVALID', true);
      messageId = result.data.message_id;
      // Keep the new reply when a later photo upload needs to retry.
      const checkpoint = await db.telegramConnection.updateMany({
        where: { telegramUserId, lastUpdateId: connection.lastUpdateId, callbackToken },
        data: { messageId },
      });
      if (!checkpoint.count) return;
    }
    if (screen.photo && (await stillAllowed())) {
      const activeDeviceId = view.success
        ? (view.data.deviceId ?? connection.selectedDeviceId)
        : null;
      if (
        activeDeviceId &&
        (await db.device.findFirst({ where: { id: activeDeviceId, archivedAt: null } }))
      ) {
        const caption = '📈 Biểu đồ AirGuard IoT · Giờ Việt Nam';
        let photoMessageId = connection.photoMessageId;
        if (photoMessageId) {
          try {
            await api('editMessageMedia', {
              chat_id: chatId,
              message_id: photoMessageId,
              photo: screen.photo,
              media: { type: 'photo', media: 'attach://photo', caption },
            });
          } catch (error) {
            if (error instanceof TelegramApiError && error.code === 'TELEGRAM_MESSAGE_GONE')
              photoMessageId = null;
            else if (!(error instanceof TelegramApiError && error.code === 'TELEGRAM_NOT_MODIFIED'))
              throw error;
          }
        }
        if (!photoMessageId) {
          const sent = z
            .object({ message_id: integer.positive() })
            .parse(await api('sendPhoto', { chat_id: chatId, photo: screen.photo, caption }));
          photoMessageId = sent.message_id;
        }
        await db.telegramConnection.updateMany({
          where: {
            telegramUserId,
            linkVersion: connection.linkVersion,
            lastUpdateId: connection.lastUpdateId,
            callbackToken,
          },
          data: { photoMessageId },
        });
      }
    }
    await db.telegramConnection.updateMany({
      where: { telegramUserId, lastUpdateId: connection.lastUpdateId, callbackToken },
      data: { messageId, pending: false },
    });
  } catch (error) {
    await acknowledge('Không thể xử lý. Vui lòng thử lại.');
    throw error;
  }
}

import type { Prisma } from '@prisma/client';
import type { Router } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import type { FeatureContext } from '../lib/context.js';
import { ApiError } from '../lib/errors.js';
import { hashSecret } from './auth.js';

export const clearedTelegramLink = {
  userId: null,
  selectedDeviceId: null,
  callbackToken: '',
  callbackExpiresAt: null,
  actions: [],
  view: { screen: 'menu' },
  pending: false,
  trackedDeviceId: null,
  warningEnabled: true,
  reportFrequency: 'off',
  nextReportAt: null,
  queryAllowedAt: null,
  photoMessageId: null,
};
export async function unlinkTelegram(tx: Prisma.TransactionClient, userId: string) {
  const codes = await tx.telegramLinkCode.deleteMany({ where: { userId } });
  const connections = await tx.telegramConnection.updateMany({
    where: { userId },
    data: { ...clearedTelegramLink, linkVersion: randomUUID() },
  });
  if (codes.count || connections.count)
    await tx.auditLog.create({
      data: {
        userId,
        resourceType: 'user',
        resourceId: userId,
        action: 'telegram.unlinked',
        metadata: {},
      },
    });
}
export async function consumeTelegramCode(
  tx: Prisma.TransactionClient,
  telegramUserId: string,
  code: string,
  now: Date,
) {
  if (!/^[A-Za-z0-9_-]{32}$/.test(code)) return false;
  const candidate = await tx.telegramLinkCode.findUnique({
    where: { tokenHash: hashSecret(code) },
  });
  if (!candidate) return false;
  await tx.$queryRaw`SELECT id FROM users WHERE id=${candidate.userId}::uuid FOR UPDATE`;
  const current = await tx.telegramLinkCode.findUnique({
    where: { tokenHash: hashSecret(code) },
    include: { user: true, session: true },
  });
  if (
    !current ||
    !current.user.active ||
    current.expiresAt <= now ||
    current.session.expiresAt <= now ||
    current.session.userId !== current.userId
  )
    return false;
  const other = await tx.telegramConnection.findUnique({ where: { userId: current.userId } });
  const chat = await tx.telegramConnection.findUniqueOrThrow({ where: { telegramUserId } });
  if (
    (other && other.telegramUserId !== telegramUserId) ||
    (chat.userId && chat.userId !== current.userId)
  )
    return false;
  await tx.telegramConnection.update({
    where: { telegramUserId },
    data: { userId: current.userId, selectedDeviceId: null },
  });
  await tx.telegramLinkCode.delete({ where: { userId: current.userId } });
  await tx.auditLog.create({
    data: {
      userId: current.userId,
      resourceType: 'user',
      resourceId: current.userId,
      action: 'telegram.linked',
      metadata: {},
    },
  });
  return true;
}
export function registerTelegramLinks(
  router: Router,
  { db, reply }: FeatureContext,
  botKey?: string,
) {
  router.get('/telegram/link', async (_req, res) => {
    const connection = await db.telegramConnection.findUnique({
      where: { userId: res.locals.session.user.id as string },
    });
    const cursor = botKey ? await db.telegramBotCursor.findUnique({ where: { id: botKey } }) : null;
    reply(res, { enabled: !!botKey, linked: !!connection, bot_username: cursor?.username ?? null });
  });
  router.post(
    '/telegram/link-code',
    rateLimit({
      windowMs: 60000,
      limit: 10,
      keyGenerator: (_req, res) => res.locals.session.user.id as string,
      handler: (_req, res) =>
        res
          .status(429)
          .json({ error: { code: 'RATE_LIMITED', message: 'Vui lòng chờ trước khi tạo mã mới.' } }),
    }),
    async (_req, res) => {
      if (!botKey) throw new ApiError(409, 'TELEGRAM_BOT_DISABLED', 'Telegram hiện chưa khả dụng.');
      const userId = res.locals.session.user.id as string;
      const sessionId = res.locals.session.sessionId as string;
      const code = randomBytes(24).toString('base64url');
      const expiresAt = new Date(Date.now() + 300000);
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id=${userId}::uuid FOR UPDATE`;
        const session = await tx.session.findUnique({
          where: { id: sessionId },
          include: { user: true },
        });
        if (!session?.user.active || session.expiresAt <= new Date())
          throw new ApiError(401, 'UNAUTHORIZED', 'Vui lòng đăng nhập lại.');
        await tx.telegramLinkCode.upsert({
          where: { userId },
          create: { userId, sessionId, tokenHash: hashSecret(code), expiresAt },
          update: { sessionId, tokenHash: hashSecret(code), expiresAt },
        });
      });
      reply(res, { code, expires_at: expiresAt.toISOString() });
    },
  );
  router.delete('/telegram/link', async (_req, res) => {
    const userId = res.locals.session.user.id as string;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id=${userId}::uuid FOR UPDATE`;
      await unlinkTelegram(tx, userId);
    });
    res.status(204).end();
  });
}

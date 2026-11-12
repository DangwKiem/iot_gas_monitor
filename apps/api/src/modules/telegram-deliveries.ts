import type { Database } from '@iot/database';
import type { Prisma, TelegramConnection } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { nextReportTime, telegramReport } from './telegram-data.js';
import { incidentPresentation } from './incident-service.js';
import { formatConnectivityMessage, formatTelegramMessage } from './telegram-message.js';
import { sendTelegram, type TelegramBotConfig, type TelegramResult } from './telegram-client.js';
import type { AlertNotifier, ConnectivityNotifier } from './notifications.js';

const canRead = (c: { user: { active: boolean; role: string } | null }) =>
  !!c.user?.active && ['admin', 'operator', 'viewer'].includes(c.user.role);
export const personalIncidentNotifier: AlertNotifier = async (tx, incident) => {
  const device = await tx.device.findUniqueOrThrow({ where: { id: incident.deviceId } });
  if (device.archivedAt) return;
  const connections = await tx.telegramConnection.findMany({
    where: { user: { active: true } },
    include: { user: true },
  });
  const severity = incident.status === 'ended' ? 'resolved' : incident.severity;
  const recipients = connections.filter(
    (c) => canRead(c) && (device.sourceKind === 'physical' || c.trackedDeviceId === device.id),
  );
  if (recipients.length)
    await tx.telegramBotDelivery.createMany({
      data: recipients.map((c) => ({
        connectionId: c.telegramUserId,
        linkVersion: c.linkVersion,
        kind: 'incident',
        incidentId: incident.id,
        severity,
        eventKey: `incident:${incident.id}:${severity}`,
        expiresAt: new Date(Date.now() + 21600000),
      })),
      skipDuplicates: true,
    });
};
export const personalConnectivityNotifier: ConnectivityNotifier = async (tx, history) => {
  const device = await tx.device.findUniqueOrThrow({ where: { id: history.deviceId } });
  if (device.archivedAt || !['online', 'offline'].includes(history.newStatus)) return;
  const connections = await tx.telegramConnection.findMany({
    where: { user: { active: true } },
    include: { user: true },
  });
  const recipients = connections.filter(
    (c) =>
      canRead(c) &&
      (!c.trackedDeviceId || c.trackedDeviceId === device.id) &&
      (device.sourceKind === 'physical' || c.trackedDeviceId === device.id),
  );
  if (recipients.length)
    await tx.telegramBotDelivery.createMany({
      data: recipients.map((c) => ({
        connectionId: c.telegramUserId,
        linkVersion: c.linkVersion,
        kind: 'connectivity',
        statusHistoryId: history.id,
        severity: history.newStatus,
        eventKey: `connection:${history.id}`,
        expiresAt: new Date(Date.now() + 21600000),
      })),
      skipDuplicates: true,
    });
};
export async function queueTelegramTest(
  tx: Prisma.TransactionClient,
  c: TelegramConnection,
  now: Date,
) {
  const eventKey = `test:${Math.floor(now.getTime() / 60000)}`;
  await tx.telegramBotDelivery.upsert({
    where: {
      connectionId_linkVersion_eventKey: {
        connectionId: c.telegramUserId,
        linkVersion: c.linkVersion,
        eventKey,
      },
    },
    create: {
      connectionId: c.telegramUserId,
      linkVersion: c.linkVersion,
      eventKey,
      kind: 'test',
      expiresAt: new Date(now.getTime() + 3600000),
    },
    update: {},
  });
}

export async function scheduleTelegramReports(db: Database, now = new Date()) {
  return db.$transaction(async (tx) => {
    const due = await tx.$queryRaw<{ telegram_user_id: string }[]>`
      SELECT telegram_user_id FROM telegram_connections WHERE report_frequency<>'off' AND next_report_at<=${now}
      ORDER BY next_report_at LIMIT 20 FOR UPDATE SKIP LOCKED`;
    for (const row of due) {
      const c = await tx.telegramConnection.findUniqueOrThrow({
        where: { telegramUserId: row.telegram_user_id },
        include: { user: true },
      });
      if (!canRead(c)) {
        await tx.telegramConnection.update({
          where: { telegramUserId: c.telegramUserId },
          data: { reportFrequency: 'off', nextReportAt: null },
        });
        continue;
      }
      const periodTo = new Date(c.nextReportAt!.getTime() - c.reportMinute * 60000);
      const periodFrom = new Date(
        periodTo.getTime() - (c.reportFrequency === 'weekly' ? 7 : 1) * 86400000,
      );
      await tx.telegramBotDelivery.upsert({
        where: {
          connectionId_linkVersion_eventKey: {
            connectionId: c.telegramUserId,
            linkVersion: c.linkVersion,
            eventKey: `report:${c.reportFrequency}:${c.nextReportAt!.toISOString()}`,
          },
        },
        create: {
          connectionId: c.telegramUserId,
          linkVersion: c.linkVersion,
          eventKey: `report:${c.reportFrequency}:${c.nextReportAt!.toISOString()}`,
          kind: 'report',
          periodFrom,
          periodTo,
          expiresAt: new Date(now.getTime() + 48 * 3600000),
        },
        update: {},
      });
      await tx.telegramConnection.update({
        where: { telegramUserId: c.telegramUserId },
        data: {
          nextReportAt: nextReportTime(c.reportFrequency, c.reportMinute, c.reportWeekday, now),
        },
      });
    }
    return due.length;
  });
}
export async function deliverPersonalTelegram(
  db: Database,
  send: (chatId: string, text: string) => Promise<TelegramResult>,
  now = new Date(),
) {
  const leaseToken = randomUUID();
  const row = await db.$transaction(async (tx) => {
    const idle = { OR: [{ status: 'pending' }, { status: 'sending', leaseUntil: { lte: now } }] };
    await tx.telegramBotDelivery.updateMany({
      where: { ...idle, expiresAt: { lte: now } },
      data: {
        status: 'expired',
        leaseToken: null,
        leaseUntil: null,
        lastErrorCode: 'DELIVERY_EXPIRED',
      },
    });
    await tx.telegramBotDelivery.updateMany({
      where: { ...idle, attempts: { gte: 8 } },
      data: { status: 'failed', leaseToken: null, leaseUntil: null, lastErrorCode: 'MAX_ATTEMPTS' },
    });
    const [candidate] = await tx.$queryRaw<{ id: string; connection_id: string }[]>`
      SELECT d.id,d.connection_id FROM telegram_bot_deliveries d WHERE attempts<8 AND expires_at>${now}
      AND ((status='pending' AND next_attempt_at<=${now}) OR (status='sending' AND lease_until<=${now}))
      AND NOT EXISTS (SELECT 1 FROM telegram_bot_deliveries b WHERE b.connection_id=d.connection_id AND b.status='sending' AND b.lease_until>${now})
      ORDER BY CASE WHEN kind='incident' AND severity='critical' THEN 0 WHEN kind='incident' THEN 1 ELSE 2 END,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (!candidate) return null;
    const locked = await tx.$queryRaw<
      { telegram_user_id: string }[]
    >`SELECT telegram_user_id FROM telegram_connections WHERE telegram_user_id=${candidate.connection_id} FOR UPDATE SKIP LOCKED`;
    if (
      !locked.length ||
      (await tx.telegramBotDelivery.count({
        where: {
          connectionId: candidate.connection_id,
          status: 'sending',
          leaseUntil: { gt: now },
        },
      }))
    )
      return null;
    return tx.telegramBotDelivery.update({
      where: { id: candidate.id },
      data: {
        status: 'sending',
        attempts: { increment: 1 },
        leaseToken,
        leaseUntil: new Date(now.getTime() + 90000),
      },
    });
  });
  if (!row) return { processed: false as const };
  const skip = async (code: string) => {
    await db.telegramBotDelivery.updateMany({
      where: { id: row.id, leaseToken, status: 'sending' },
      data: { status: 'skipped', leaseToken: null, leaseUntil: null, lastErrorCode: code },
    });
    return {
      processed: true as const,
      notificationId: row.id,
      status: 'skipped',
      code,
      cooldownMs: 0,
    };
  };
  const getRecipient = () =>
    db.telegramConnection.findUnique({
      where: { telegramUserId: row.connectionId },
      include: { user: true },
    });
  const c = await getRecipient();
  if (!c || !canRead(c) || c.linkVersion !== row.linkVersion) return skip('LINK_REVOKED');
  let text: string;
  let covered: Prisma.TelegramBotDeliveryWhereInput | undefined;
  let deviceId: string | undefined;
  let mandatory = false;
  if (row.kind === 'incident') {
    const i = await db.alertIncident.findUnique({
      where: { id: row.incidentId! },
      include: { device: true, states: true, acknowledgement: true },
    });
    if (!i || i.device.archivedAt) return skip('DEVICE_UNAVAILABLE');
    deviceId = i.deviceId;
    mandatory = i.severity === 'critical';
    if (
      !mandatory &&
      (!c.warningEnabled || (c.trackedDeviceId && c.trackedDeviceId !== i.deviceId))
    )
      return skip('WARNING_DISABLED');
    if (i.device.sourceKind === 'simulator' && c.trackedDeviceId !== i.deviceId)
      return skip('SIMULATOR_NOT_SELECTED');
    const p = incidentPresentation(i);
    text = formatTelegramMessage({
      deviceName: i.device.name,
      simulator: i.device.sourceKind === 'simulator',
      condition: i.condition,
      severity: i.severity,
      currentSeverity: p.currentSeverity ?? undefined,
      ended: i.status === 'ended',
      startedAt: i.startedAt,
      endedAt: i.endedAt,
      acknowledged: !!i.acknowledgement,
      uncertain:
        !p.currentSeverity ||
        i.device.connectivity !== 'online' ||
        !i.device.lastSeenAt ||
        i.device.lastSeenAt.getTime() + Math.max(30000, i.device.reportingIntervalMs * 3) <=
          now.getTime(),
      delayed: !(await db.telegramBotDelivery.count({
        where: {
          connectionId: c.telegramUserId,
          linkVersion: c.linkVersion,
          incidentId: i.id,
          status: 'sent',
        },
      })),
    });
    if (i.status === 'ended' || row.severity === 'critical')
      covered = { incidentId: i.id, ...(i.status === 'ended' ? {} : { severity: 'warning' }) };
  } else if (row.kind === 'connectivity') {
    const original = await db.deviceStatusHistory.findUnique({
      where: { id: row.statusHistoryId! },
    });
    if (!original) return skip('DEVICE_UNAVAILABLE');
    const latest = await db.deviceStatusHistory.findFirstOrThrow({
      where: { deviceId: original.deviceId },
      orderBy: { id: 'desc' },
      include: { device: true },
    });
    deviceId = latest.deviceId;
    if (latest.device.archivedAt || (c.trackedDeviceId && c.trackedDeviceId !== deviceId))
      return skip('DEVICE_UNAVAILABLE');
    text = formatConnectivityMessage({
      deviceName: latest.device.name,
      simulator: latest.device.sourceKind === 'simulator',
      online: latest.newStatus === 'online',
      time: latest.effectiveAt,
    });
    covered = { statusHistory: { deviceId, id: { lte: latest.id } } };
  } else if (row.kind === 'report') {
    if (c.reportFrequency === 'off') return skip('REPORT_DISABLED');
    if (
      c.trackedDeviceId &&
      !(await db.device.findFirst({ where: { id: c.trackedDeviceId, archivedAt: null } }))
    )
      return skip('DEVICE_UNAVAILABLE');
    text = await telegramReport(
      db,
      { from: row.periodFrom!, to: row.periodTo! },
      c.trackedDeviceId,
    );
  } else text = '✅ <b>Telegram đã sẵn sàng nhận thông báo.</b>';
  // Check again after aggregation, immediately before handing data to Telegram.
  const current = await getRecipient();
  if (
    !current ||
    !canRead(current) ||
    current.linkVersion !== row.linkVersion ||
    (!mandatory && current.trackedDeviceId !== c.trackedDeviceId) ||
    (row.kind === 'report' &&
      (current.reportFrequency === 'off' || current.reportFrequency !== c.reportFrequency))
  )
    return skip('LINK_OR_SETTINGS_CHANGED');
  if (deviceId && !(await db.device.findFirst({ where: { id: deviceId, archivedAt: null } })))
    return skip('DEVICE_UNAVAILABLE');
  if (row.kind === 'incident' && !mandatory && !current.warningEnabled)
    return skip('WARNING_DISABLED');
  if (
    !(await db.telegramBotDelivery.count({
      where: {
        id: row.id,
        leaseToken,
        status: 'sending',
        leaseUntil: { gt: new Date(Math.max(now.getTime(), Date.now()) + 15000) },
      },
    }))
  )
    return {
      processed: true as const,
      notificationId: row.id,
      status: 'lease_lost',
      code: 'LEASE_LOST',
      cooldownMs: 1000,
    };
  let result: TelegramResult;
  try {
    result = await send(current.chatId, text);
  } catch {
    result = { ok: false, retryable: true, code: 'TELEGRAM_NETWORK_ERROR' };
  }
  const completed = new Date(Math.max(now.getTime(), Date.now()));
  const status = result.ok
    ? 'sent'
    : row.expiresAt <= completed
      ? 'expired'
      : result.retryable && row.attempts < 8
        ? 'pending'
        : 'failed';
  const retryMs = result.ok
    ? 0
    : Math.max(
        (result.retryAfterSeconds ?? 0) * 1000,
        Math.min(5000 * 2 ** (row.attempts - 1), 900000),
      );
  const updated = await db.$transaction(async (tx) => {
    const updated = await tx.telegramBotDelivery.updateMany({
      where: { id: row.id, leaseToken, status: 'sending' },
      data: {
        status,
        leaseToken: null,
        leaseUntil: null,
        sentAt: result.ok ? completed : null,
        lastErrorCode: result.ok ? null : result.code,
        nextAttemptAt: new Date(completed.getTime() + retryMs),
      },
    });
    if (updated.count && result.ok && covered)
      await tx.telegramBotDelivery.updateMany({
        where: {
          ...covered,
          connectionId: row.connectionId,
          linkVersion: row.linkVersion,
          id: { not: row.id },
          OR: [{ status: 'pending' }, { status: 'sending', leaseUntil: { lte: completed } }],
        },
        data: {
          status: 'skipped',
          leaseToken: null,
          leaseUntil: null,
          lastErrorCode: 'COVERED_BY_LATEST',
        },
      });
    return updated;
  });
  return {
    processed: true as const,
    notificationId: row.id,
    status: updated.count ? status : 'lease_lost',
    code: result.ok ? null : result.code,
    cooldownMs: !result.ok && result.code === 'TELEGRAM_RATE_LIMITED' ? retryMs : 1000,
  };
}

export function startPersonalTelegramWorker(
  db: Database,
  config: TelegramBotConfig,
  log: (entry: { notification_id?: string; status?: string; code?: string | null }) => void,
) {
  let active: Promise<void> | undefined,
    stopped = false,
    pauseUntil = 0,
    scheduledAt = 0;
  const controller = new AbortController();
  const tick = () => {
    if (stopped || active || Date.now() < pauseUntil) return;
    active = (async () => {
      try {
        if (Date.now() - scheduledAt >= 30000) {
          await scheduleTelegramReports(db);
          scheduledAt = Date.now();
        }
        const result = await deliverPersonalTelegram(db, (chatId, text) =>
          sendTelegram(
            { token: config.token, chatId, includeSimulators: true },
            text,
            fetch,
            controller.signal,
          ),
        );
        if (result.processed) {
          pauseUntil = Date.now() + result.cooldownMs;
          log({ notification_id: result.notificationId, status: result.status, code: result.code });
        }
      } catch {
        log({ code: 'TELEGRAM_PERSONAL_WORKER_FAILED' });
        pauseUntil = Date.now() + 5000;
      }
    })().finally(() => {
      active = undefined;
    });
  };
  const timer = setInterval(tick, 1000);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    controller.abort();
    await active;
  };
}

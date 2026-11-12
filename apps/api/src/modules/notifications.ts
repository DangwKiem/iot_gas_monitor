import type { Database } from '@iot/database';
import type { AlertIncident, DeviceStatusHistory, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { sendTelegram, type TelegramResult, type TelegramConfig } from './telegram-client.js';
import { incidentPresentation } from './incident-service.js';
import { formatConnectivityMessage, formatTelegramMessage } from './telegram-message.js';
export type AlertNotifier = (
  tx: Prisma.TransactionClient,
  incident: AlertIncident,
  transition?: 'ended',
) => Promise<void>;
export function telegramNotifier(includeSimulators: boolean): AlertNotifier {
  return async (tx, incident) => {
    if (!['warning', 'critical'].includes(incident.severity)) return;
    const device = await tx.device.findUniqueOrThrow({ where: { id: incident.deviceId } });
    if (device.sourceKind === 'simulator' && !includeSimulators) return;
    const now = new Date();
    const severity = incident.status === 'ended' ? 'resolved' : incident.severity;
    await tx.telegramNotification.upsert({
      where: { incidentId_severity: { incidentId: incident.id, severity } },
      create: {
        incidentId: incident.id,
        severity,
        createdAt: now,
        nextAttemptAt: now,
        expiresAt: new Date(now.getTime() + 6 * 3600000),
      },
      update: {},
    });
  };
}

export type ConnectivityNotifier = (
  tx: Prisma.TransactionClient,
  history: DeviceStatusHistory,
) => Promise<void>;
export function telegramConnectivityNotifier(includeSimulators: boolean): ConnectivityNotifier {
  return async (tx, history) => {
    if (!['online', 'offline'].includes(history.newStatus)) return;
    const device = await tx.device.findUniqueOrThrow({ where: { id: history.deviceId } });
    if (device.archivedAt || (device.sourceKind === 'simulator' && !includeSimulators)) return;
    await tx.telegramNotification.upsert({
      where: { statusHistoryId: history.id },
      create: {
        statusHistoryId: history.id,
        severity: history.newStatus,
        expiresAt: new Date(Date.now() + 21600000),
      },
      update: {},
    });
  };
}
export async function deliverTelegramNotification(
  db: Database,
  send: (text: string) => Promise<TelegramResult>,
  now = new Date(),
  includeSimulators = true,
  linkedChatId?: string,
) {
  const leaseToken = randomUUID();
  const row = await db.$transaction(async (tx) => {
    const idle = { OR: [{ status: 'pending' }, { status: 'sending', leaseUntil: { lte: now } }] };
    if (!includeSimulators)
      await tx.telegramNotification.updateMany({
        where: {
          AND: [
            idle,
            {
              OR: [
                { incident: { device: { sourceKind: 'simulator' } } },
                { statusHistory: { device: { sourceKind: 'simulator' } } },
              ],
            },
          ],
        },
        data: {
          status: 'skipped',
          leaseToken: null,
          leaseUntil: null,
          lastErrorCode: 'SIMULATOR_NOT_ALLOWED',
        },
      });
    await tx.telegramNotification.updateMany({
      where: { AND: [idle, { statusHistory: { device: { archivedAt: { not: null } } } }] },
      data: {
        status: 'skipped',
        leaseToken: null,
        leaseUntil: null,
        lastErrorCode: 'DEVICE_ARCHIVED',
      },
    });
    await tx.telegramNotification.updateMany({
      where: { ...idle, expiresAt: { lte: now } },
      data: {
        status: 'expired',
        leaseToken: null,
        leaseUntil: null,
        lastErrorCode: 'DELIVERY_EXPIRED',
      },
    });
    await tx.telegramNotification.updateMany({
      where: { ...idle, attempts: { gte: 8 }, expiresAt: { gt: now } },
      data: { status: 'failed', leaseToken: null, leaseUntil: null, lastErrorCode: 'MAX_ATTEMPTS' },
    });
    const [candidate] = await tx.$queryRaw<
      { id: string; incidentId: string | null; deviceId: string | null }[]
    >`
      SELECT n.id,n.incident_id AS "incidentId",p.device_id AS "deviceId" FROM telegram_notifications n
      LEFT JOIN alert_incidents i ON i.id=n.incident_id
      LEFT JOIN device_status_history p ON p.id=n.status_history_id
      WHERE n.attempts<8 AND n.expires_at>${now}
      AND ((n.status='pending' AND n.next_attempt_at<=${now}) OR (n.status='sending' AND n.lease_until<=${now}))
      AND NOT EXISTS (SELECT 1 FROM telegram_notifications busy LEFT JOIN device_status_history bp ON bp.id=busy.status_history_id
        WHERE busy.status='sending' AND busy.lease_until>${now} AND
        ((n.incident_id IS NOT NULL AND busy.incident_id=n.incident_id) OR (n.status_history_id IS NOT NULL AND bp.device_id=p.device_id)))
      AND (n.severity<>'warning' OR i.status='ended' OR NOT EXISTS (SELECT 1 FROM telegram_notifications higher
        WHERE higher.incident_id=n.incident_id AND higher.severity='critical' AND higher.status IN ('pending','sending')))
      ORDER BY CASE WHEN i.status='active' AND n.severity='critical' THEN 0 WHEN n.incident_id IS NOT NULL THEN 1 ELSE 2 END,
        n.created_at,n.id LIMIT 1 FOR UPDATE OF n SKIP LOCKED`;
    if (!candidate) return null;
    const parent = candidate.incidentId
      ? await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM alert_incidents WHERE id=${candidate.incidentId}::uuid FOR UPDATE SKIP LOCKED`
      : await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM devices WHERE id=${candidate.deviceId}::uuid FOR UPDATE SKIP LOCKED`;
    if (!parent.length) return null;
    const scope = candidate.incidentId
      ? { incidentId: candidate.incidentId }
      : { statusHistory: { deviceId: candidate.deviceId! } };
    if (
      await tx.telegramNotification.count({
        where: { ...scope, status: 'sending', leaseUntil: { gt: now } },
      })
    )
      return null;
    return tx.telegramNotification.update({
      where: { id: candidate.id },
      data: {
        status: 'sending',
        attempts: { increment: 1 },
        leaseToken,
        leaseUntil: new Date(now.getTime() + 30000),
      },
    });
  });
  if (!row) return { processed: false as const };
  if (linkedChatId) {
    const connection = await db.telegramConnection.findFirst({
      where: {
        chatId: linkedChatId,
        user: { active: true, role: { in: ['admin', 'operator', 'viewer'] } },
      },
    });
    const routed = connection
      ? await db.telegramBotDelivery.findFirst({
          where: {
            connectionId: connection.telegramUserId,
            linkVersion: connection.linkVersion,
            ...(row.incidentId
              ? { incidentId: row.incidentId, severity: row.severity }
              : { statusHistoryId: row.statusHistoryId }),
          },
        })
      : null;
    if (routed) {
      await db.telegramNotification.updateMany({
        where: { id: row.id, status: 'sending', leaseToken },
        data: {
          status: 'skipped',
          leaseToken: null,
          leaseUntil: null,
          lastErrorCode: 'ROUTED_TO_LINKED_ACCOUNT',
        },
      });
      return {
        processed: true as const,
        notificationId: row.id,
        status: 'skipped',
        code: 'ROUTED_TO_LINKED_ACCOUNT',
        cooldownMs: 0,
      };
    }
  }
  let text: string;
  let covered: Prisma.TelegramNotificationWhereInput | undefined;
  let coveredCode: string | undefined;
  if (row.incidentId) {
    const incident = await db.alertIncident.findUniqueOrThrow({
      where: { id: row.incidentId },
      include: {
        device: true,
        states: true,
        acknowledgement: true,
        events: {
          where: { transition: { in: ['started', 'escalated'] } },
          orderBy: { id: 'desc' },
          take: 2,
        },
        notifications: { where: { status: 'sent' } },
      },
    });
    const presentation = incidentPresentation(incident);
    const escalation = incident.events.find(
      (event) =>
        event.transition === 'escalated' ||
        (event.transition === 'started' &&
          event.payload &&
          typeof event.payload === 'object' &&
          !Array.isArray(event.payload) &&
          event.payload.severity === 'critical'),
    );
    const isEscalation =
      row.severity === 'critical' &&
      !!(
        escalation?.transition === 'escalated' ||
        (await db.telegramNotification.count({
          where: { incidentId: incident.id, severity: 'warning' },
        }))
      );
    text = formatTelegramMessage({
      deviceName: incident.device.name,
      simulator: incident.device.sourceKind === 'simulator',
      condition: incident.condition,
      severity: incident.severity,
      ended: incident.status === 'ended',
      startedAt: incident.startedAt,
      endedAt: incident.endedAt,
      escalation: isEscalation,
      escalatedAt: escalation?.occurredAt,
      delayed: !incident.notifications.length,
      currentSeverity: presentation.currentSeverity ?? undefined,
      acknowledged: !!incident.acknowledgement,
      uncertain:
        !presentation.currentSeverity ||
        incident.device.connectivity !== 'online' ||
        !!incident.device.archivedAt ||
        !incident.device.lastSeenAt ||
        incident.device.lastSeenAt.getTime() +
          Math.max(30000, incident.device.reportingIntervalMs * 3) <=
          now.getTime(),
    });
    if (incident.status === 'ended' || row.severity === 'critical') {
      covered = {
        incidentId: incident.id,
        ...(incident.status === 'ended' ? {} : { severity: 'warning' }),
      };
      coveredCode = incident.status === 'ended' ? 'COVERED_BY_RESOLVED' : 'COVERED_BY_CRITICAL';
    }
  } else {
    const latest = await db.$transaction(
      async (tx) => {
        const original = await tx.deviceStatusHistory.findUniqueOrThrow({
          where: { id: row.statusHistoryId! },
        });
        return tx.deviceStatusHistory.findFirstOrThrow({
          where: { deviceId: original.deviceId },
          orderBy: { id: 'desc' },
          include: { device: true },
        });
      },
      { isolationLevel: 'RepeatableRead' },
    );
    if (latest.device.archivedAt) {
      const updated = await db.telegramNotification.updateMany({
        where: { id: row.id, status: 'sending', leaseToken },
        data: {
          status: 'skipped',
          leaseToken: null,
          leaseUntil: null,
          lastErrorCode: 'DEVICE_ARCHIVED',
        },
      });
      return {
        processed: true as const,
        notificationId: row.id,
        status: updated.count ? 'skipped' : 'lease_lost',
        code: 'DEVICE_ARCHIVED',
        cooldownMs: 0,
      };
    }
    text = formatConnectivityMessage({
      deviceName: latest.device.name,
      simulator: latest.device.sourceKind === 'simulator',
      online: latest.newStatus === 'online',
      time: latest.effectiveAt,
    });
    covered = { statusHistory: { deviceId: latest.deviceId, id: { lte: latest.id } } };
    coveredCode = 'COVERED_BY_CONNECTIVITY';
  }
  let result: TelegramResult;
  try {
    result = await send(text);
  } catch {
    result = { ok: false, retryable: true, code: 'TELEGRAM_NETWORK_ERROR' };
  }
  const finishedAt = new Date(Math.max(now.getTime(), Date.now()));
  const expired = row.expiresAt <= finishedAt;
  const status = result.ok
    ? 'sent'
    : expired
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
  const code = result.ok ? null : result.code;
  const updated = await db.$transaction(async (tx) => {
    const updated = await tx.telegramNotification.updateMany({
      where: { id: row.id, status: 'sending', leaseToken },
      data: {
        status,
        leaseToken: null,
        leaseUntil: null,
        sentAt: result.ok ? finishedAt : null,
        lastErrorCode: code,
        nextAttemptAt: new Date(finishedAt.getTime() + retryMs),
      },
    });
    if (updated.count && result.ok && covered) {
      await tx.telegramNotification.updateMany({
        where: {
          ...covered,
          id: { not: row.id },
          OR: [{ status: 'pending' }, { status: 'sending', leaseUntil: { lte: finishedAt } }],
        },
        data: { status: 'skipped', leaseToken: null, leaseUntil: null, lastErrorCode: coveredCode },
      });
    }
    return updated;
  });
  return {
    processed: true as const,
    notificationId: row.id,
    status: updated.count ? status : 'lease_lost',
    code,
    cooldownMs: !result.ok && result.code === 'TELEGRAM_RATE_LIMITED' ? retryMs : 1000,
  };
}

export function startTelegramWorker(
  db: Database,
  config: TelegramConfig,
  log: (entry: { notification_id?: string; status?: string; code?: string | null }) => void,
) {
  let stopped = false;
  let pauseUntil = 0;
  let active: Promise<void> | undefined;
  const controller = new AbortController();
  const tick = () => {
    if (stopped || active || Date.now() < pauseUntil) return;
    active = (async () => {
      try {
        const result = await deliverTelegramNotification(
          db,
          (text) => sendTelegram(config, text, fetch, controller.signal),
          new Date(),
          config.includeSimulators,
          config.routeLinkedChats ? config.chatId : undefined,
        );
        if (result.processed) {
          pauseUntil = Date.now() + result.cooldownMs;
          log({ notification_id: result.notificationId, status: result.status, code: result.code });
        }
      } catch {
        log({ code: 'TELEGRAM_WORKER_FAILED' });
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

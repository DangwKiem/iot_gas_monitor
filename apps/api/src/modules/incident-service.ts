import type { Database } from '@iot/database';
import type { Prisma } from '@prisma/client';
import { incidentQuerySchema } from '@iot/contracts';
import { ApiError } from '../lib/errors.js';
import { audit, lockDevice } from '../lib/context.js';

export const includeIncident = {
  device: {
    select: {
      name: true,
      sourceKind: true,
      archivedAt: true,
      connectivity: true,
      lastSeenAt: true,
      reportingIntervalMs: true,
    },
  },
  states: { select: { state: true } },
  acknowledgement: { include: { user: { select: { id: true, email: true } } } },
} satisfies Prisma.AlertIncidentInclude;
export type IncidentRow = Prisma.AlertIncidentGetPayload<{ include: typeof includeIncident }>;
export function incidentPresentation(i: {
  status: string;
  severity: string;
  condition: string;
  states: { state: string }[];
  acknowledgement: unknown;
}) {
  const state = i.states[0]?.state;
  const currentSeverity =
    i.status === 'ended'
      ? null
      : state === 'warning' || state === 'critical'
        ? i.condition === 'flame'
          ? 'critical'
          : state
        : state === 'active'
          ? i.severity
          : null;
  return {
    currentSeverity,
    lifecycle: i.status === 'ended' ? 'RESOLVED' : i.acknowledgement ? 'ACKNOWLEDGED' : 'ACTIVE',
  };
}
export function incidentView(i: IncidentRow) {
  const presentation = incidentPresentation(i);
  return {
    id: i.id,
    external_id: i.externalId,
    device_id: i.deviceId,
    device_name: i.device.name,
    source_kind: i.device.sourceKind,
    condition: i.condition,
    severity: i.severity,
    status: i.status,
    origin: i.origin,
    current_severity: presentation.currentSeverity,
    lifecycle: presentation.lifecycle,
    started_at: i.startedAt?.toISOString() ?? null,
    ended_at: i.endedAt?.toISOString() ?? null,
    first_observed_at: i.firstObservedAt.toISOString(),
    acknowledgement: i.acknowledgement
      ? {
          acknowledged_at: i.acknowledgement.acknowledgedAt.toISOString(),
          note: i.acknowledgement.note,
          user: i.acknowledgement.user,
        }
      : null,
  };
}
export async function listIncidentPage(
  db: Database,
  filters: unknown,
  options: { skip?: number; visibleOnly?: boolean; activityWindow?: boolean } = {},
) {
  const q = incidentQuerySchema.parse(filters);
  const period = q.from
    ? [
        { startedAt: { gte: new Date(q.from), lt: new Date(q.to!) } },
        { startedAt: null, firstObservedAt: { gte: new Date(q.from), lt: new Date(q.to!) } },
        ...(options.activityWindow
          ? [{ endedAt: { gte: new Date(q.from), lt: new Date(q.to!) } }]
          : []),
      ]
    : undefined;
  const where: Prisma.AlertIncidentWhereInput = {
    deviceId: q.device_id,
    condition: q.condition,
    severity: q.severity,
    status: q.status,
    ...(options.visibleOnly ? { device: { archivedAt: null } } : {}),
    ...(q.acknowledged
      ? { acknowledgement: q.acknowledged === 'true' ? { isNot: null } : { is: null } }
      : {}),
    ...(q.cursor ? { ordinal: { lt: BigInt(q.cursor) } } : {}),
    ...(period ? { OR: period } : {}),
  };
  const rows = await db.alertIncident.findMany({
    where,
    include: includeIncident,
    orderBy: { ordinal: 'desc' },
    skip: options.skip,
    take: q.limit + 1,
  });
  const page = rows.slice(0, q.limit);
  return {
    rows: page,
    hasMore: rows.length > q.limit,
    nextCursor: rows.length > q.limit ? String(page.at(-1)!.ordinal) : null,
  };
}
export async function acknowledgeIncident(
  tx: Prisma.TransactionClient,
  id: string,
  userId: string,
  note = '',
  visibleOnly = false,
) {
  const user = await tx.user.findUnique({ where: { id: userId } });
  if (!user?.active || !['admin', 'operator'].includes(user.role))
    throw new ApiError(403, 'FORBIDDEN', 'Bạn không có quyền xác nhận sự cố.');
  const incident = await tx.alertIncident.findUnique({ where: { id } });
  if (!incident) throw new ApiError(404, 'NOT_FOUND', 'Sự cố không khả dụng.');
  const device = await lockDevice(tx, incident.deviceId);
  if (visibleOnly && device.archivedAt)
    throw new ApiError(403, 'FORBIDDEN', 'Sự cố không khả dụng.');
  const existing = await tx.alertAcknowledgement.findUnique({ where: { incidentId: id } });
  if (existing) return { ack: existing, deviceId: incident.deviceId };
  const ack = await tx.alertAcknowledgement.create({ data: { incidentId: id, userId, note } });
  await audit(tx, userId, incident.deviceId, 'incident.acknowledged', { incident_id: id });
  return { ack, deviceId: incident.deviceId };
}

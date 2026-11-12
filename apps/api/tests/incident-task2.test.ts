import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import webpush from 'web-push';
import { createDatabase } from '@iot/database';
import { createApp } from '../src/app.js';
import { featureFixture } from './helpers.js';
import {
  telegramNotifier,
  telegramConnectivityNotifier,
  deliverTelegramNotification,
} from '../src/modules/notifications.js';
import { reconcileOffline } from '../src/modules/presence.js';
import { listIncidentPage } from '../src/modules/incident-service.js';
import { webPushNotifier, deliverWebPush } from '../src/modules/web-push.js';
import { runMaintenance } from '../src/modules/maintenance.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'Task 2 incident lifecycle and Telegram queue',
  () => {
    const sourceUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/iot_test';
    const name = `iot_task2_${randomBytes(6).toString('hex')}`;
    const targetUrl = new URL(sourceUrl);
    targetUrl.pathname = `/${name}`;
    const adminDb = createDatabase(sourceUrl);
    const db = createDatabase(targetUrl.toString());
    const pair = webpush.generateVAPIDKeys();
    const push = {
      publicKey: pair.publicKey,
      privateKey: pair.privateKey,
      subject: 'mailto:test@airguard.local',
    };
    const notifyConnectivity = telegramConnectivityNotifier(true);
    const app = createApp({
      db,
      origin: 'http://localhost:5173',
      webPush: push,
      notifyConnectivity,
      notify: async (tx, i, transition) => {
        await telegramNotifier(true)(tx, i);
        await webPushNotifier()(tx, i, transition);
      },
    });
    let f: Awaited<ReturnType<typeof featureFixture>>;
    beforeAll(async () => {
      await adminDb.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
      execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
        env: { ...process.env, DATABASE_URL: targetUrl.toString() },
        stdio: 'ignore',
      });
      f = await featureFixture(db, app, 'task2');
    }, 30000);
    beforeEach(async () => {
      await db.telegramNotification.deleteMany();
      await db.webPushSubscription.deleteMany();
    });
    afterAll(async () => {
      await db.$disconnect();
      await adminDb.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await adminDb.$disconnect();
    });
    async function device(label = 'Task2 sensor') {
      const d = await request(app)
        .post('/api/v1/devices')
        .set(f.headers.admin!)
        .send({ name: label, source_kind: 'physical' });
      expect(d.status).toBe(201);
      const key = await request(app)
        .post(`/api/v1/devices/${d.body.data.id}/credentials`)
        .set(f.headers.admin!);
      expect(key.status).toBe(201);
      return {
        id: d.body.data.id as string,
        headers: { Authorization: `DeviceKey ${key.body.data.key}` },
      };
    }
    const sample = async (
      d: Awaited<ReturnType<typeof device>>,
      seq: number,
      gas: 'normal' | 'warning' | 'critical',
      co: 'normal' | 'warning' | 'critical' = 'normal',
    ) => {
      const p = f.payload(seq);
      p.device_id = d.id;
      p.readings[0]!.alert_snapshot.gas = gas;
      p.readings[0]!.alert_snapshot.co = co;
      p.readings[0]!.alert_snapshot.buzzer_commanded_on = gas === 'critical' || co === 'critical';
      const result = await request(app).post('/api/v1/device/telemetry').set(d.headers).send(p);
      expect(result.status).toBe(200);
      return p;
    };
    const heartbeat = async (d: Awaited<ReturnType<typeof device>>) => {
      const result = await request(app).post('/api/v1/device/heartbeat').set(d.headers).send({
        schema_version: 1,
        device_id: d.id,
        boot_id: f.bootId,
        boot_counter: '1',
        uptime_ms: '90000',
        firmware_version: 'test',
      });
      expect(result.status).toBe(200);
    };
    const incident = async (deviceId: string, condition = 'gas') =>
      db.alertIncident.findFirstOrThrow({
        where: { deviceId, condition },
        orderBy: { ordinal: 'desc' },
      });
    it('retains connection history referenced by the outbox during retention', async () => {
      const d = await device();
      const old = new Date('2024-01-01T00:00:00Z');
      const linked = await db.deviceStatusHistory.create({
        data: {
          deviceId: d.id,
          previousStatus: 'online',
          newStatus: 'offline',
          effectiveAt: old,
          detectedAt: old,
          reason: 'heartbeat_timeout',
        },
      });
      await db.telegramNotification.create({
        data: {
          statusHistoryId: linked.id,
          severity: 'offline',
          expiresAt: old,
          status: 'expired',
        },
      });
      const preview = await runMaintenance(db);
      expect(preview.eligible_status).toBe(0);
      const result = await runMaintenance(db, { apply: true });
      expect(result.pruned_status).toBe(0);
      expect(await db.deviceStatusHistory.findUnique({ where: { id: linked.id } })).not.toBeNull();
    });
    it('keeps one incident through Warning/Critical/Warning/Critical/Normal with idempotent events and bounded notification types', async () => {
      const d = await device();
      await sample(d, 1, 'normal');
      await sample(d, 2, 'warning');
      const first = await incident(d.id);
      await sample(d, 2, 'warning');
      await sample(d, 3, 'warning');
      await sample(d, 4, 'critical');
      await sample(d, 5, 'warning');
      await sample(d, 6, 'critical');
      await sample(d, 7, 'normal');
      await sample(d, 7, 'normal');
      expect(await db.alertIncident.count({ where: { deviceId: d.id } })).toBe(1);
      expect(
        await db.alertEvent.count({ where: { incidentId: first.id, transition: 'escalated' } }),
      ).toBe(2);
      expect(
        await db.alertEvent.count({ where: { incidentId: first.id, transition: 'deescalated' } }),
      ).toBe(1);
      const jobs = await db.telegramNotification.findMany({ where: { incidentId: first.id } });
      expect(jobs.map((j) => j.severity).sort()).toEqual(['critical', 'resolved', 'warning']);
      const view = await request(app)
        .get(`/api/v1/alerts/incidents/${first.id}`)
        .set(f.headers.viewer!);
      expect(view.body.data).toMatchObject({
        id: first.id,
        status: 'ended',
        severity: 'critical',
        current_severity: null,
        lifecycle: 'RESOLVED',
      });
    });
    it('does not merge independent gas/CO incidents or end an incident when acknowledged', async () => {
      const d = await device();
      await sample(d, 1, 'critical', 'warning');
      const gas = await incident(d.id);
      const co = await incident(d.id, 'co');
      expect(gas.id).not.toBe(co.id);
      expect(
        (
          await request(app)
            .post(`/api/v1/alerts/incidents/${gas.id}/acknowledgements`)
            .set(f.headers.viewer!)
        ).status,
      ).toBe(403);
      for (let n = 0; n < 2; n++)
        expect(
          (
            await request(app)
              .post(`/api/v1/alerts/incidents/${gas.id}/acknowledgements`)
              .set(f.headers.operator!)
          ).status,
        ).toBe(200);
      expect(await db.alertAcknowledgement.count({ where: { incidentId: gas.id } })).toBe(1);
      expect((await incident(d.id)).status).toBe('active');
      expect((await incident(d.id, 'co')).status).toBe('active');
      const detail = await request(app)
        .get(`/api/v1/alerts/incidents/${gas.id}`)
        .set(f.headers.viewer!);
      expect(detail.body.data.lifecycle).toBe('ACKNOWLEDGED');
      const last = await db.device.findUniqueOrThrow({ where: { id: d.id } });
      const reading = await db.sensorReading.findUniqueOrThrow({ where: { id: last.latestId! } });
      expect(
        (reading.payload as { alert_snapshot: { buzzer_commanded_on: boolean } }).alert_snapshot
          .buzzer_commanded_on,
      ).toBe(true);
      expect(await db.telegramNotification.count({ where: { incidentId: gas.id } })).toBe(1);
    });
    it('resolves a warning without requiring critical and sends only resolved history when delivery is delayed', async () => {
      const d = await device();
      await sample(d, 1, 'warning');
      await sample(d, 2, 'normal');
      const messages: string[] = [];
      const worker = () =>
        deliverTelegramNotification(db, async (text) => {
          messages.push(text);
          return { ok: true };
        });
      await Promise.all([worker(), worker()]);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('RESOLVED — ĐÃ KẾT THÚC');
      expect(messages[0]).toContain('thông báo trễ');
      expect(messages[0]).not.toContain('Đang diễn ra');
      expect((await worker()).processed).toBe(false);
      expect(await db.telegramNotification.count({ where: { status: 'sent' } })).toBe(1);
      expect(
        await db.telegramNotification.count({ where: { lastErrorCode: 'COVERED_BY_RESOLVED' } }),
      ).toBe(1);
    });
    it('retains failed critical delivery, honors rate limits and reloads resolved status after restart', async () => {
      const d = await device();
      await sample(d, 1, 'critical');
      const now = new Date();
      const first = await deliverTelegramNotification(
        db,
        async () => {
          throw new Error('timeout');
        },
        now,
      );
      expect(first).toMatchObject({ status: 'pending', code: 'TELEGRAM_NETWORK_ERROR' });
      const limited = await deliverTelegramNotification(
        db,
        async () => ({
          ok: false,
          retryable: true,
          code: 'TELEGRAM_RATE_LIMITED',
          retryAfterSeconds: 30,
        }),
        new Date(now.getTime() + 6000),
      );
      expect(limited).toMatchObject({ status: 'pending' });
      const row = await db.telegramNotification.findFirstOrThrow();
      expect(row.attempts).toBe(2);
      expect(row.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(now.getTime() + 36000);
      await sample(d, 2, 'normal');
      let message = '';
      await deliverTelegramNotification(
        db,
        async (text) => {
          message = text;
          return { ok: true };
        },
        new Date(now.getTime() + 40000),
      );
      expect(message).toContain('RESOLVED');
      expect(message).not.toContain('Đang diễn ra');
      expect(await db.telegramNotification.count({ where: { status: 'sent' } })).toBe(1);
    });
    it('stops retrying exhausted delivery without deleting its audit record', async () => {
      const d = await device();
      await sample(d, 1, 'critical');
      const row = await db.telegramNotification.findFirstOrThrow();
      await db.telegramNotification.update({ where: { id: row.id }, data: { attempts: 7 } });
      await deliverTelegramNotification(db, async () => ({
        ok: false,
        retryable: true,
        code: 'TELEGRAM_NETWORK_ERROR',
      }));
      expect(
        await db.telegramNotification.findUniqueOrThrow({ where: { id: row.id } }),
      ).toMatchObject({ attempts: 8, status: 'failed', lastErrorCode: 'TELEGRAM_NETWORK_ERROR' });
      expect((await deliverTelegramNotification(db, async () => ({ ok: true }))).processed).toBe(
        false,
      );
    });
    it('queues exactly one OFFLINE and recovery ONLINE without resolving gas incidents', async () => {
      const d = await device();
      await sample(d, 1, 'warning');
      const active = await incident(d.id);
      await deliverTelegramNotification(db, async () => ({ ok: true }));
      const now = new Date();
      await db.device.update({
        where: { id: d.id },
        data: { lastSeenAt: new Date(now.getTime() - 31000) },
      });
      expect(await reconcileOffline(db, now, notifyConnectivity)).toContain(d.id);
      expect(await reconcileOffline(db, now, notifyConnectivity)).not.toContain(d.id);
      expect(await db.telegramNotification.count({ where: { severity: 'offline' } })).toBe(1);
      const queued = await db.telegramNotification.findFirstOrThrow({
        where: { severity: 'offline' },
      });
      let message = '';
      await deliverTelegramNotification(
        db,
        async (text) => {
          message = text;
          return { ok: true };
        },
        queued.nextAttemptAt,
      );
      expect(message).toContain('OFFLINE — MẤT KẾT NỐI');
      expect(message).not.toContain('SAFE');
      expect((await db.alertIncident.findUniqueOrThrow({ where: { id: active.id } })).status).toBe(
        'active',
      );
      await heartbeat(d);
      await heartbeat(d);
      expect(await db.telegramNotification.count({ where: { severity: 'online' } })).toBe(1);
      await deliverTelegramNotification(db, async (text) => {
        message = text;
        return { ok: true };
      });
      expect(message).toContain('ONLINE — ĐÃ KẾT NỐI');
      expect(message).not.toContain('SAFE');
      expect((await db.alertIncident.findUniqueOrThrow({ where: { id: active.id } })).status).toBe(
        'active',
      );
    });
    it('coalesces stale offline/recovery jobs using latest connection history and keeps failures pending', async () => {
      const d = await device();
      await sample(d, 1, 'normal');
      const now = new Date();
      await db.device.update({
        where: { id: d.id },
        data: { lastSeenAt: new Date(now.getTime() - 31000) },
      });
      await reconcileOffline(db, now, notifyConnectivity);
      await heartbeat(d);
      await deliverTelegramNotification(db, async () => ({
        ok: false,
        retryable: true,
        code: 'TELEGRAM_NETWORK_ERROR',
      }));
      expect(await db.telegramNotification.count({ where: { status: 'skipped' } })).toBe(0);
      const messages: string[] = [];
      const worker = () =>
        deliverTelegramNotification(
          db,
          async (text) => {
            messages.push(text);
            return { ok: true };
          },
          new Date(Date.now() + 6000),
        );
      await Promise.all([worker(), worker()]);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('ONLINE — ĐÃ KẾT NỐI');
      expect(messages[0]).not.toContain('OFFLINE');
      expect(
        await db.telegramNotification.count({
          where: { lastErrorCode: 'COVERED_BY_CONNECTIVITY' },
        }),
      ).toBe(1);
    });
    it('rolls back the presence transition when transactional queue persistence fails', async () => {
      const d = await device();
      await sample(d, 1, 'normal');
      const now = new Date();
      await db.device.update({
        where: { id: d.id },
        data: { lastSeenAt: new Date(now.getTime() - 31000) },
      });
      await expect(
        reconcileOffline(db, now, async (tx, history) => {
          await notifyConnectivity(tx, history);
          throw new Error('outbox unavailable');
        }),
      ).rejects.toThrow('outbox unavailable');
      expect((await db.device.findUniqueOrThrow({ where: { id: d.id } })).connectivity).toBe(
        'online',
      );
      expect(
        await db.telegramNotification.count({ where: { statusHistory: { deviceId: d.id } } }),
      ).toBe(0);
      await reconcileOffline(db, now, notifyConnectivity);
      expect(
        await db.telegramNotification.count({ where: { statusHistory: { deviceId: d.id } } }),
      ).toBe(1);
    });
    it('filters history by activity window, device and peak severity', async () => {
      const d = await device();
      const now = new Date();
      const old = await db.alertIncident.create({
        data: {
          deviceId: d.id,
          condition: 'co',
          severity: 'critical',
          origin: 'event',
          status: 'ended',
          startedAt: new Date(now.getTime() - 40 * 86400000),
          endedAt: new Date(now.getTime() - 1000),
        },
      });
      const common = {
        from: new Date(now.getTime() - 86400000).toISOString(),
        to: now.toISOString(),
        device_id: d.id,
        severity: 'critical',
        limit: 5,
      };
      const result = await listIncidentPage(db, common, {
        visibleOnly: true,
        activityWindow: true,
      });
      expect(result.rows.map((i) => i.id)).toContain(old.id);
      expect(
        (
          await listIncidentPage(
            db,
            { ...common, severity: 'warning' },
            { visibleOnly: true, activityWindow: true },
          )
        ).rows,
      ).toHaveLength(0);
    });
    it('uses the same current severity, acknowledgement and resolved state on API, Telegram and Web Push', async () => {
      for (const role of ['operator', 'viewer'] as const) {
        const keys = webpush.generateVAPIDKeys();
        expect(
          (
            await request(app)
              .post('/api/v1/push/subscription')
              .set(f.headers[role]!)
              .send({
                application_server_key: push.publicKey,
                include_simulators: true,
                subscription: {
                  endpoint: `https://fcm.googleapis.com/fcm/send/task2-${role}`,
                  expirationTime: null,
                  keys: { p256dh: keys.publicKey, auth: 'AAAAAAAAAAAAAAAAAAAAAA' },
                },
              })
          ).status,
        ).toBe(200);
      }
      const d = await device();
      await sample(d, 1, 'warning');
      await sample(d, 2, 'critical');
      await sample(d, 3, 'warning');
      const i = await incident(d.id);
      const api = await request(app).get(`/api/v1/alerts/incidents/${i.id}`).set(f.headers.viewer!);
      expect(api.body.data).toMatchObject({
        severity: 'critical',
        current_severity: 'warning',
        lifecycle: 'ACTIVE',
      });
      let telegram = '';
      await deliverTelegramNotification(db, async (text) => {
        telegram = text;
        return { ok: true };
      });
      expect(telegram).toContain('WARNING — CẢNH BÁO');
      expect(telegram).toContain('Đã giảm từ mức nguy hiểm');
      const bodies: unknown[] = [];
      const deliver = () =>
        deliverWebPush(db, push, async (_target, payload) => {
          bodies.push(payload);
          return { ok: true };
        });
      await deliver();
      expect(bodies[0]).toMatchObject({ severity: 'warning', ended: false, acknowledged: false });
      await request(app)
        .post(`/api/v1/alerts/incidents/${i.id}/acknowledgements`)
        .set(f.headers.operator!);
      await deliver();
      expect(bodies[1]).toMatchObject({ severity: 'warning', ended: false, acknowledged: true });
      await sample(d, 4, 'normal');
      await deliver();
      expect(bodies[2]).toMatchObject({ severity: 'resolved', ended: true, acknowledged: true });
      await deliverTelegramNotification(db, async (text) => {
        telegram = text;
        return { ok: true };
      });
      expect(telegram).toContain('RESOLVED — ĐÃ KẾT THÚC');
    });
  },
);

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createDatabase } from '@iot/database';
import { createApp } from '../src/app.js';
import { featureFixture } from './helpers.js';
import { telegramNotifier } from '../src/modules/notifications.js';
import { defaultAlertPolicy } from '@iot/contracts';
import { hashSecret } from '../src/modules/auth.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('threshold warning and critical lifecycle', () => {
  const db = createDatabase(process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/iot_test');
  const app = createApp({ db, origin: 'http://localhost:5173', notify: telegramNotifier(true) });
  let f: Awaited<ReturnType<typeof featureFixture>>;
  beforeAll(async () => {
    f = await featureFixture(db, app, 'thresholds');
  });
  afterAll(() => db.$disconnect());

  it('preserves critical transitions in a queued batch and does not duplicate incidents on retry', async () => {
    const queued = await featureFixture(db, app, 'queued-critical');
    const batch = queued.payload(3);
    batch.readings = ['normal', 'critical', 'normal'].map((gas, i) => {
      const reading = queued.payload(i + 1).readings[0]!;
      reading.alert_snapshot.gas = gas as 'normal' | 'critical';
      return reading;
    });
    const send = () =>
      request(app).post('/api/v1/device/telemetry').set(queued.deviceHeaders).send(batch);
    const result = await send();
    expect(result.status).toBe(200);
    expect(result.body.data.accepted.map((entry: { seq: string }) => entry.seq)).toEqual([
      '1',
      '2',
      '3',
    ]);
    const incident = await db.alertIncident.findFirstOrThrow({
      where: { deviceId: queued.deviceId, condition: 'gas' },
    });
    expect(incident).toMatchObject({ severity: 'critical', status: 'ended' });
    expect(await db.alertEvent.count({ where: { incidentId: incident.id } })).toBe(2);
    const retry = await send();
    expect(retry.status).toBe(200);
    expect(retry.body.data.accepted.every((entry: { duplicate: boolean }) => entry.duplicate)).toBe(
      true,
    );
    expect(await db.sensorReading.count({ where: { deviceId: queued.deviceId } })).toBe(3);
    expect(
      await db.alertIncident.count({ where: { deviceId: queued.deviceId, condition: 'gas' } }),
    ).toBe(1);
    const active = queued.payload(5);
    active.readings = [queued.payload(4).readings[0]!, active.readings[0]!];
    active.readings[0]!.alert_snapshot.gas = 'normal';
    active.readings[1]!.alert_snapshot.gas = 'critical';
    expect(
      (await request(app).post('/api/v1/device/telemetry').set(queued.deviceHeaders).send(active))
        .status,
    ).toBe(200);
    const view = await request(app)
      .get(`/api/v1/devices/${queued.deviceId}`)
      .set(queued.headers.viewer!);
    expect(view.body.data.latest.payload.seq).toBe('5');
    expect(view.body.data.latest.payload.alert_snapshot.gas).toBe('critical');
    expect(
      await db.alertIncident.count({
        where: { deviceId: queued.deviceId, condition: 'gas', status: 'active' },
      }),
    ).toBe(1);
  });

  it('escalates the same incident, notifies each severity once, and preserves incidents on faults', async () => {
    const send = async (seq: number, state: string, invalid = false) => {
      const payload = f.payload(seq);
      payload.readings[0]!.alert_snapshot.gas = state;
      if (invalid)
        Object.assign(payload.readings[0]!.sensors.mq2, {
          quality: 'invalid',
          adc_raw: null,
          adc_pin_mv: null,
        });
      return request(app).post('/api/v1/device/telemetry').set(f.deviceHeaders).send(payload);
    };
    expect((await send(1, 'warning')).status).toBe(200);
    const first = await db.alertIncident.findFirstOrThrow({
      where: { deviceId: f.deviceId, condition: 'gas' },
    });
    expect(first.severity).toBe('warning');
    expect((await send(2, 'critical')).status).toBe(200);
    expect((await send(2, 'critical')).status).toBe(200);
    expect((await send(3, 'warning')).status).toBe(200);
    const states = await request(app)
      .get(`/api/v1/alerts/states?device_id=${f.deviceId}`)
      .set(f.headers.viewer!);
    expect(
      states.body.data.find((s: { condition: string }) => s.condition === 'gas').severity,
    ).toBe('warning');
    expect(
      await db.alertIncident.count({ where: { deviceId: f.deviceId, condition: 'gas' } }),
    ).toBe(1);
    expect((await db.alertIncident.findUniqueOrThrow({ where: { id: first.id } })).severity).toBe(
      'critical',
    );
    expect(
      await db.alertEvent.count({ where: { incidentId: first.id, transition: 'escalated' } }),
    ).toBe(1);
    const jobs = await db.telegramNotification.findMany({
      where: { incidentId: first.id },
      orderBy: { severity: 'asc' },
    });
    expect(jobs.map((j) => j.severity)).toEqual(['critical', 'warning']);
    expect((await send(4, 'normal', true)).status).toBe(200);
    expect((await db.alertIncident.findUniqueOrThrow({ where: { id: first.id } })).status).toBe(
      'active',
    );
    expect((await send(5, 'normal')).status).toBe(200);
    expect((await db.alertIncident.findUniqueOrThrow({ where: { id: first.id } })).status).toBe(
      'ended',
    );
    expect((await send(0, 'critical')).status).toBe(200);
    expect(
      await db.alertIncident.count({ where: { deviceId: f.deviceId, status: 'active' } }),
    ).toBe(0);
  });

  it('always records flame activation as critical', async () => {
    const payload = f.payload(6);
    payload.readings[0]!.sensors.flame.detected = true;
    payload.readings[0]!.alert_snapshot.flame = 'critical';
    const result = await request(app)
      .post('/api/v1/device/telemetry')
      .set(f.deviceHeaders)
      .send(payload);
    expect(result.status).toBe(200);
    expect(
      (
        await db.alertIncident.findFirstOrThrow({
          where: { deviceId: f.deviceId, condition: 'flame' },
        })
      ).severity,
    ).toBe('critical');
  });

  it('versions threshold configuration and preserves it when an older client changes only the interval', async () => {
    const url = `/api/v1/devices/${f.deviceId}/config`;
    const policy = structuredClone(defaultAlertPolicy);
    policy.gas.warning_on = 3250;
    const saved = await request(app)
      .put(url)
      .set(f.headers.admin!)
      .send({
        expected_version: 1,
        config: { reporting_interval_ms: 5000, alert_policy: policy },
      });
    expect(saved.status).toBe(200);
    const changed = await request(app)
      .put(url)
      .set(f.headers.admin!)
      .send({
        expected_version: 2,
        config: { reporting_interval_ms: 10000 },
      });
    expect(changed.status).toBe(200);
    expect(changed.body.data.config.alert_policy).toEqual(policy);
    expect(changed.body.data.content_hash).toBe(
      hashSecret(JSON.stringify(changed.body.data.config)),
    );
    const transport = await request(app).get('/api/v1/device/config').set(f.deviceHeaders);
    expect(transport.body.data.content_hash).toBe(changed.body.data.content_hash);
  });
});

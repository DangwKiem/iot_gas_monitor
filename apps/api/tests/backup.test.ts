import { afterAll, describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createDatabase } from '@iot/database';
import {
  backupDatabase,
  restoreDatabase,
  requireRecentBackup,
} from '../../../tools/operations/backup.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('encrypted PostgreSQL backup/restore drill', () => {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/iot_test';
  const db = createDatabase(url);
  afterAll(() => db.$disconnect());
  it('restores schema and fixture to an isolated empty database without overwriting existing tables', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'iot-restore-test-'));
    const name = `iot_restore_${randomBytes(6).toString('hex')}`;
    const targetUrl = new URL(url);
    targetUrl.pathname = `/${name}`;
    const passphrase = randomBytes(32).toString('hex');
    const marker = `restore-${name}@test.local`;
    const linkedUser = await db.user.create({
      data: { email: marker, passwordHash: 'not-a-login-password', role: 'viewer' },
    });
    const connection = await db.telegramConnection.create({
      data: {
        telegramUserId: name,
        chatId: name,
        userId: linkedUser.id,
        reportFrequency: 'daily',
        nextReportAt: new Date(Date.now() + 3600000),
      },
    });
    const personal = await db.telegramBotDelivery.create({
      data: {
        connectionId: name,
        linkVersion: connection.linkVersion,
        kind: 'report',
        eventKey: 'report:restore-test',
        periodFrom: new Date(Date.now() - 86400000),
        periodTo: new Date(),
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    const device = await db.device.create({
      data: { name: `Restore ${name}`, sourceKind: 'simulator' },
    });
    const incident = await db.alertIncident.create({
      data: { deviceId: device.id, condition: 'flame', severity: 'critical', origin: 'event' },
    });
    const notification = await db.telegramNotification.create({
      data: {
        incidentId: incident.id,
        severity: 'critical',
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    const target = createDatabase(targetUrl.toString());
    try {
      await db.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
      const file = join(folder, 'database.backup.enc');
      await backupDatabase(url, file, passphrase);
      await requireRecentBackup(file, passphrase, url);
      await expect(requireRecentBackup(file, passphrase, targetUrl.toString())).rejects.toThrow();
      await restoreDatabase(targetUrl.toString(), file, passphrase);
      expect(await target.user.findUnique({ where: { email: marker } })).not.toBeNull();
      expect(await target.session.count()).toBe(0);
      expect(
        (await target.telegramConnection.findUniqueOrThrow({ where: { telegramUserId: name } }))
          .userId,
      ).toBeNull();
      const restoredConnection = await target.telegramConnection.findUniqueOrThrow({
        where: { telegramUserId: name },
      });
      expect(restoredConnection).toMatchObject({ reportFrequency: 'off', nextReportAt: null });
      expect(restoredConnection.linkVersion).not.toBe(connection.linkVersion);
      expect(
        await target.telegramBotDelivery.findUniqueOrThrow({ where: { id: personal.id } }),
      ).toMatchObject({ status: 'failed', lastErrorCode: 'RESTORE_REVIEW_REQUIRED' });
      expect(
        await target.telegramNotification.findUniqueOrThrow({ where: { id: notification.id } }),
      ).toMatchObject({ status: 'failed', lastErrorCode: 'RESTORE_REVIEW_REQUIRED' });
      expect(await target.$queryRaw`SELECT 1 FROM sensor_rollups LIMIT 1`).toBeInstanceOf(Array);
      await expect(restoreDatabase(targetUrl.toString(), file, passphrase)).rejects.toThrow(
        /trống/,
      );
    } finally {
      await db.telegramBotDelivery.deleteMany({ where: { id: personal.id } });
      await db.telegramNotification.deleteMany({ where: { id: notification.id } });
      await target.$disconnect();
      await db.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await rm(folder, { recursive: true, force: true });
    }
  }, 60000);
});

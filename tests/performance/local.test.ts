import { it, describe, expect } from 'vitest';
import { chromium } from '@playwright/test';
import { createServer as reservePort } from 'node:net';
import { createServer as createVite } from 'vite';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import argon2 from 'argon2';
import { z } from 'zod';
import { createDatabase } from '@iot/database';
import { createRuntime } from '../../apps/api/src/runtime.js';
import { buildPayload } from '../../tools/device-simulator/src/payload.js';

const seconds = z.coerce
  .number()
  .int()
  .min(10)
  .max(86400)
  .parse(process.env.LOAD_DURATION_SECONDS ?? 60);
const interval = z.coerce
  .number()
  .int()
  .min(1000)
  .max(60000)
  .parse(process.env.LOAD_INTERVAL_MS ?? 5000);
const p95 = (numbers: number[]) =>
  [...numbers].sort((a, b) => a - b)[Math.max(0, Math.ceil(numbers.length * 0.95) - 1)] ?? 0;

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'isolated 10-device / 5-browser acceptance runner',
  () => {
    it(
      'measures HTTP ingestion, visible browser updates, duplicates and memory across the configured duration',
      async () => {
        const db = createDatabase(process.env.TEST_DATABASE_URL!);
        const password = randomUUID();
        const reservation = reservePort();
        await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
        const address = reservation.address();
        if (!address || typeof address === 'string') throw new Error('No web port');
        const port = address.port;
        await new Promise<void>((done) => reservation.close(() => done()));
        const origin = `http://127.0.0.1:${port}`;
        const httpStatus: Record<string, number> = {};
        const runtime = createRuntime(db, origin, {
          onRequest: (entry) => {
            httpStatus[entry.status] = (httpStatus[entry.status] ?? 0) + 1;
          },
        });
        await new Promise<void>((done) => runtime.http.listen(0, '127.0.0.1', done));
        const apiAddress = runtime.http.address();
        if (!apiAddress || typeof apiAddress === 'string') throw new Error('No API port');
        const apiUrl = `http://127.0.0.1:${apiAddress.port}`;
        const vite = await createVite({
          root: resolve('apps/web'),
          configFile: resolve('apps/web/vite.config.ts'),
          server: {
            host: '127.0.0.1',
            port,
            strictPort: true,
            proxy: { '/api': apiUrl, '/socket.io': { target: apiUrl, ws: true } },
          },
        });
        const browser = await chromium.launch();
        const httpTimes: number[] = [];
        const uiTimes: number[] = [];
        const memory: { at: number; rss: number; heap: number }[] = [];
        const pageErrors: string[] = [];
        const socketEvents = Array.from({ length: 5 }, () => 0);
        let sent = 0;
        let received = 0;
        let cycles = 0;
        try {
          await vite.listen();
          await db.user.create({
            data: {
              email: 'load@test.local',
              passwordHash: await argon2.hash(password),
              role: 'admin',
            },
          });
          const login = async () => {
            const res = await fetch(`${apiUrl}/api/v1/auth/login`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'AirGuard' },
              body: JSON.stringify({ email: 'load@test.local', password }),
            });
            if (!res.ok) throw new Error('Load login failed');
            return res.headers.getSetCookie()[0]!.split(';')[0]!.split('=')[1]!;
          };
          let cookie = await login();
          const adminHeaders = {
            Cookie: `iot_session=${cookie}`,
            'X-Requested-With': 'AirGuard',
            'Content-Type': 'application/json',
          };
          const devices: { id: string; key: string; bootId: string }[] = [];
          for (let i = 0; i < 10; i++) {
            const response = await fetch(`${apiUrl}/api/v1/devices`, {
              method: 'POST',
              headers: adminHeaders,
              body: JSON.stringify({ name: `Load simulator ${i}`, source_kind: 'simulator' }),
            });
            const device = (await response.json()).data;
            const credential = await fetch(`${apiUrl}/api/v1/devices/${device.id}/credentials`, {
              method: 'POST',
              headers: adminHeaders,
            });
            const key = (await credential.json()).data.key as string;
            devices.push({ id: device.id as string, key, bootId: randomUUID() });
          }
          const pages = await Promise.all(
            Array.from({ length: 5 }, async (_, index) => {
              const context = await browser.newContext();
              await context.addCookies([
                {
                  name: 'iot_session',
                  value: cookie,
                  url: origin,
                  httpOnly: true,
                  sameSite: 'Lax',
                },
              ]);
              const page = await context.newPage();
              page.on('pageerror', (e) => pageErrors.push(e.message));
              page.on('websocket', (socket) =>
                socket.on('framereceived', ({ payload }) => {
                  if (String(payload).includes('telemetry.created'))
                    socketEvents[index] = socketEvents[index]! + 1;
                }),
              );
              await page.goto(origin);
              await page.getByText('Realtime kết nối', { exact: true }).waitFor();
              return page;
            }),
          );
          const started = performance.now();
          await expect
            .poll(
              () =>
                runtime.io.of('/monitoring').adapter.rooms.get(`device:${devices[0]!.id}`)?.size ??
                0,
            )
            .toBe(5);
          let refreshed = started;
          while (performance.now() - started < seconds * 1000) {
            if (performance.now() - refreshed > 6 * 3600000) {
              cookie = await login();
              for (const page of pages) {
                await page.context().addCookies([
                  {
                    name: 'iot_session',
                    value: cookie,
                    url: origin,
                    httpOnly: true,
                    sameSite: 'Lax',
                  },
                ]);
                await page.reload();
              }
              refreshed = performance.now();
            }
            cycles++;
            const cycleStart = performance.now();
            const temperature = 20 + (cycles % 50);
            await Promise.all(
              devices.map(async (d) => {
                const payload = buildPayload({
                  deviceId: d.id,
                  bootId: d.bootId,
                  bootCounter: '1',
                  seq: String(cycles),
                  uptime: cycles * interval,
                  now: new Date(),
                });
                payload.readings[0]!.sensors.dht11.temperature_c = temperature;
                const before = performance.now();
                sent++;
                const response = await fetch(`${apiUrl}/api/v1/device/telemetry`, {
                  method: 'POST',
                  headers: {
                    Authorization: `DeviceKey ${d.key}`,
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify(payload),
                  signal: AbortSignal.timeout(10000),
                });
                httpTimes.push(performance.now() - before);
                if (response.ok) received++;
              }),
            );
            await Promise.all(
              pages.map(async (page) => {
                await page.waitForFunction(
                  (value) =>
                    document
                      .querySelector('[aria-label="Nhiệt độ"] .reading-value')
                      ?.textContent?.trim()
                      .startsWith(`${value} `),
                  temperature,
                  { timeout: 10000, polling: 50 },
                );
                if (cycles > 2) uiTimes.push(performance.now() - cycleStart);
              }),
            );
            memory.push({
              at: Math.round(performance.now() - started),
              rss: process.memoryUsage().rss,
              heap: process.memoryUsage().heapUsed,
            });
            if (memory.length > 2000) memory.splice(1, 1);
            await delay(Math.max(0, interval - (performance.now() - cycleStart)));
          }
          const report = {
            created_at: new Date().toISOString(),
            node: process.version,
            platform: process.platform,
            duration_seconds: seconds,
            interval_ms: interval,
            devices: 10,
            browsers: 5,
            cycles,
            sent,
            received,
            unique_rows: await db.sensorReading.count(),
            ingestion_p95_ms: p95(httpTimes),
            request_to_visible_ui_warm_p95_ms: p95(uiTimes),
            memory,
            http_status: httpStatus,
            socket_events_per_browser: socketEvents,
            page_errors: pageErrors,
            measurement:
              'UI timing begins before HTTP request, a conservative upper bound, not an exact DB-commit timestamp; DOM observed every 50 ms.',
          };
          await mkdir('reports', { recursive: true });
          await writeFile(`reports/load-${Date.now()}.json`, JSON.stringify(report, null, 2));
          expect(received / sent).toBeGreaterThanOrEqual(0.99);
          expect(report.unique_rows).toBe(received);
          expect(report.ingestion_p95_ms).toBeLessThanOrEqual(1000);
          if (uiTimes.length)
            expect(report.request_to_visible_ui_warm_p95_ms).toBeLessThanOrEqual(2000);
          expect(pageErrors).toEqual([]);
        } catch (error) {
          console.info(
            JSON.stringify({
              cycles,
              sent,
              received,
              http_status: httpStatus,
              socket_events_per_browser: socketEvents,
            }),
          );
          throw error;
        } finally {
          await browser.close();
          await vite.close();
          await new Promise<void>((done) => runtime.io.close(() => done()));
          await db.$disconnect();
        }
      },
      seconds * 1000 + 120000,
    );
  },
);

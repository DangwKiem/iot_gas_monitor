import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from '@playwright/test';
import { createServer as createPortServer } from 'node:net';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { resolve } from 'node:path';
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '@iot/database';
import { createRuntime } from '../../apps/api/src/runtime.js';
import { buildPayload } from '../../tools/device-simulator/src/payload.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('real browser + API + PostgreSQL', () => {
  const db = createDatabase(process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/iot_test');
  const password = randomUUID();
  let runtime: ReturnType<typeof createRuntime>;
  let vite: ViteDevServer;
  let browser: Browser;
  let origin: string;
  let apiUrl: string;
  beforeAll(async () => {
    // Reserve an available local web port, then require Vite to bind exactly it.
    const reservation = createPortServer();
    await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const port = address.port;
    await new Promise<void>((done) => reservation.close(() => done()));
    origin = `http://127.0.0.1:${port}`;
    // Browser uses 127.0.0.1 while configured frontend origin uses localhost.
    runtime = createRuntime(db, `http://localhost:${port}`);
    await new Promise<void>((done) => runtime.http.listen(0, '127.0.0.1', done));
    const apiAddress = runtime.http.address();
    if (!apiAddress || typeof apiAddress === 'string') throw new Error('No API port');
    apiUrl = `http://127.0.0.1:${apiAddress.port}`;
    vite = await createViteServer({
      root: resolve('apps/web'),
      configFile: resolve('apps/web/vite.config.ts'),
      server: {
        host: '127.0.0.1',
        port,
        strictPort: true,
        proxy: { '/api': apiUrl, '/socket.io': { target: apiUrl, ws: true } },
      },
    });
    await vite.listen();
    await db.user.create({
      data: {
        email: 'browser@test.local',
        passwordHash: await argon2.hash(password),
        role: 'admin',
      },
    });
    browser = await chromium.launch();
  }, 60000);
  afterAll(async () => {
    await browser?.close();
    await vite?.close();
    if (runtime) await new Promise<void>((done) => runtime.io.close(() => done()));
    await db.$disconnect();
  });

  it('registers a simulator, receives telemetry, renders a chart and logs out', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin);
    await page.getByLabel('Email', { exact: true }).fill('browser@test.local');
    await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
    await page.getByRole('heading', { name: 'Tổng quan hệ thống' }).waitFor();
    const sessionCookie = (await page.context().cookies()).find((c) => c.name === 'iot_session');
    expect(sessionCookie?.httpOnly).toBe(true);
    expect(await page.evaluate(() => document.cookie.includes('iot_session'))).toBe(false);
    await page.reload();
    await page.getByRole('heading', { name: 'Tổng quan hệ thống' }).waitFor();
    await page.getByText('Realtime kết nối', { exact: true }).waitFor();
    await page.getByRole('navigation').getByRole('link', { name: 'Thiết bị', exact: true }).click();
    await page.getByLabel('Tên thiết bị').fill('Browser simulator');
    await page.getByRole('button', { name: 'Thêm thiết bị' }).click();
    await page.getByRole('button', { name: 'Cấp key' }).click();
    const keyPanel = page.getByRole('region', { name: 'Credential mới' });
    const key = await keyPanel.locator('code').first().innerText();
    const device = await db.device.findFirstOrThrow({ where: { name: 'Browser simulator' } });
    const payload = buildPayload({
      deviceId: device.id,
      bootId: randomUUID(),
      bootCounter: '1',
      seq: '1',
      uptime: 5000,
      now: new Date(),
    });
    const response = await fetch(`${apiUrl}/api/v1/device/telemetry`, {
      method: 'POST',
      headers: { Authorization: `DeviceKey ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(200);
    await page.getByRole('button', { name: 'Đã lưu, đóng' }).click();
    await page.getByRole('navigation').getByRole('link', { name: 'Giám sát trực tiếp' }).click();
    await page
      .getByText('Dữ liệu mô phỏng — không phải số đo phần cứng', { exact: true })
      .waitFor();
    await page.getByLabel('Nhiệt độ', { exact: true }).waitFor();
    expect(await page.getByLabel('Nhiệt độ', { exact: true }).innerText()).toContain('27.1');
    await page.getByRole('img', { name: /Biểu đồ nhiệt độ/ }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click();
    await page.getByRole('button', { name: 'Đăng nhập', exact: true }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: 'Đăng nhập', exact: true }).waitFor();
    expect(await db.session.count({ where: { user: { email: 'browser@test.local' } } })).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 60000);
});

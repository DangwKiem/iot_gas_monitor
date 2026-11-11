import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from '@playwright/test';
import { createServer as createPortServer } from 'node:net';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '@iot/database';
import { createRuntime } from '../../apps/api/src/runtime.js';
import { buildPayload } from '../../tools/device-simulator/src/payload.js';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';

describe.skipIf(!process.env.TEST_DATABASE_URL)('real browser + API + PostgreSQL', () => {
  const db = createDatabase(process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/iot_test');
  const password = randomUUID();
  let runtime: ReturnType<typeof createRuntime>;
  let vite: ViteDevServer;
  let browser: Browser;
  let origin: string;
  let apiUrl: string;
  let simulatorId: string;
  let simulatorKey: string;
  let simulatorBootId: string;
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
    await page.getByText('Đã kết nối trực tiếp', { exact: true }).waitFor();
    await page.getByRole('navigation').getByRole('link', { name: 'Thiết bị', exact: true }).click();
    await page.getByLabel('Tên thiết bị').fill('Browser simulator');
    await page.getByLabel('Nguồn dữ liệu').selectOption('simulator');
    await page.getByRole('button', { name: 'Thêm thiết bị' }).click();
    await page.getByRole('button', { name: 'Cấp khóa' }).click();
    const keyPanel = page.getByRole('region', { name: 'Khóa kết nối mới' });
    const key = await keyPanel.locator('code').first().innerText();
    const device = await db.device.findFirstOrThrow({ where: { name: 'Browser simulator' } });
    simulatorId = device.id;
    simulatorKey = key;
    simulatorBootId = randomUUID();
    const payload = buildPayload({
      deviceId: device.id,
      bootId: simulatorBootId,
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
    await page.getByText('Dữ liệu mô phỏng', { exact: true }).waitFor();
    await page.getByLabel('Nhiệt độ', { exact: true }).waitFor();
    expect(await page.getByLabel('Nhiệt độ', { exact: true }).innerText()).toContain('27.1');
    await page.getByRole('img', { name: /Biểu đồ nhiệt độ/ }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), {
        timeout: 5000,
      })
      .toBe(true);
    await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click();
    await page.getByRole('button', { name: 'Đăng nhập', exact: true }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: 'Đăng nhập', exact: true }).waitFor();
    expect(await db.session.count({ where: { user: { email: 'browser@test.local' } } })).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 60000);

  it('manages incidents, analytics export, versioned configuration, keys and archive from the web', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(origin);
    await page.getByLabel('Email', { exact: true }).fill('browser@test.local');
    await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
    await page.getByRole('heading', { name: 'Tổng quan hệ thống' }).waitFor();
    const send = async (seq: number, active: boolean) => {
      const payload = buildPayload({
        deviceId: simulatorId,
        bootId: simulatorBootId,
        bootCounter: '1',
        seq: String(seq),
        uptime: seq * 5000,
        now: new Date(),
      });
      payload.readings[0]!.sensors.flame.detected = active;
      payload.readings[0]!.alert_snapshot.flame = active ? 'active' : 'normal';
      payload.readings[0]!.alert_snapshot.buzzer_commanded_on = active;
      expect(
        (
          await fetch(`${apiUrl}/api/v1/device/telemetry`, {
            method: 'POST',
            headers: {
              Authorization: `DeviceKey ${simulatorKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
          })
        ).status,
      ).toBe(200);
    };
    await send(2, true);
    await page
      .getByRole('navigation')
      .getByRole('link', { name: 'Cảnh báo & sự cố', exact: true })
      .click({ timeout: 5000 });
    await page.getByRole('link', { name: 'Chi tiết', exact: true }).first().click();
    await page.getByLabel('Ghi chú xác nhận').fill('Đã kiểm tra từ dashboard');
    await page.getByRole('button', { name: 'Xác nhận đã xem', exact: true }).click();
    await page.getByText('Đã xác nhận', { exact: true }).waitFor();
    const incident = await db.alertIncident.findFirstOrThrow({
      where: { deviceId: simulatorId, condition: 'flame' },
    });
    expect(incident.status).toBe('active');
    await send(3, false);
    await page.getByText('Đã kết thúc', { exact: true }).first().waitFor();
    await page
      .getByRole('navigation')
      .getByRole('link', { name: 'Phân tích & lịch sử', exact: true })
      .click();
    await page.getByRole('heading', { name: 'Phân tích & lịch sử', exact: true }).waitFor();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Xuất CSV', exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^readings-.*\.csv$/);
    expect(await readFile((await download.path())!, 'utf8')).toContain('simulator');
    await page.getByRole('navigation').getByRole('link', { name: 'Thiết bị', exact: true }).click();
    await page.getByRole('link', { name: 'Browser simulator', exact: true }).click();
    await page.getByLabel('Chu kỳ gửi (giây)').fill('10');
    await page.locator('input[name="gas_warning_on"]').fill('3250');
    const savedConfig = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        response.url().endsWith(`/devices/${simulatorId}/config`),
    );
    await page.getByRole('button', { name: 'Lưu cấu hình', exact: true }).click();
    expect((await savedConfig).ok()).toBe(true);
    await page.getByText('Đang chờ thiết bị cập nhật', { exact: true }).waitFor();
    const configResponse = await fetch(`${apiUrl}/api/v1/device/config`, {
      headers: { Authorization: `DeviceKey ${simulatorKey}` },
    });
    const config = (await configResponse.json()).data;
    expect(config.version).toBe(2);
    expect(config.config.alert_policy.gas.warning_on).toBe(3250);
    expect(config.config.alert_policy.co.critical_on).toBe(1500);
    expect(
      (
        await fetch(`${apiUrl}/api/v1/device/config/ack`, {
          method: 'POST',
          headers: {
            Authorization: `DeviceKey ${simulatorKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            version: config.version,
            content_hash: config.content_hash,
            status: 'applied',
          }),
        })
      ).status,
    ).toBe(200);
    await page.getByText('Thiết bị đã áp dụng cấu hình', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Đổi khóa', exact: true }).first().click();
    await page.getByRole('region', { name: 'Khóa kết nối mới' }).waitFor();
    await page.getByRole('button', { name: 'Đã lưu, đóng', exact: true }).click();
    await page.getByRole('button', { name: 'Lưu trữ thiết bị', exact: true }).click();
    await page.getByText('Thiết bị đã lưu trữ', { exact: true }).waitFor();
    expect(
      (
        await fetch(`${apiUrl}/api/v1/device/config`, {
          headers: { Authorization: `DeviceKey ${simulatorKey}` },
        })
      ).status,
    ).toBe(403);
    await page.getByRole('button', { name: 'Khôi phục thiết bị', exact: true }).click();
    await page.getByRole('button', { name: 'Lưu trữ thiết bị', exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), {
        timeout: 5000,
      })
      .toBe(true);
    await page
      .getByRole('navigation')
      .getByRole('link', { name: 'Phân tích & lịch sử', exact: true })
      .click();
    await page
      .getByRole('img', {
        name: 'Biểu đồ dữ liệu cảm biến',
        exact: true,
      })
      .waitFor();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), {
        timeout: 5000,
      })
      .toBe(true);
    await page
      .getByRole('navigation')
      .getByRole('link', { name: 'Cảnh báo & sự cố', exact: true })
      .click();
    await page.getByRole('link', { name: 'Chi tiết', exact: true }).first().waitFor();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), {
        timeout: 5000,
      })
      .toBe(true);
    expect(pageErrors).toEqual([]);
    await page.close();
  }, 90000);
  it('updates physical-device warning and critical cards and the global alarm banner in realtime', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    try {
      await page.goto(origin);
      await page.getByLabel('Email', { exact: true }).fill('browser@test.local');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
      await page.getByRole('heading', { name: 'Tổng quan hệ thống' }).waitFor();
      const headers = { 'X-Requested-With': 'AirGuard' };
      const created = await page.request.post(`${origin}/api/v1/devices`, {
        headers,
        data: { name: 'ESP32 alerts', source_kind: 'physical' },
      });
      expect(created.status()).toBe(201);
      const deviceId = (await created.json()).data.id as string;
      const credential = await page.request.post(
        `${origin}/api/v1/devices/${deviceId}/credentials`,
        { headers },
      );
      expect(credential.status()).toBe(201);
      const key = (await credential.json()).data.key as string;
      const boot = randomUUID();
      const upload = async (seq: number, level: 'warning' | 'critical' | 'normal') => {
        const input = buildPayload({
          deviceId,
          bootId: boot,
          bootCounter: '1',
          seq: String(seq),
          uptime: seq * 5000,
          now: new Date(),
        });
        input.readings[0]!.alert_snapshot.gas = level;
        input.readings[0]!.alert_snapshot.co = 'normal';
        input.readings[0]!.alert_snapshot.buzzer_commanded_on = level !== 'normal';
        input.readings[0]!.sensors.mq2.adc_raw =
          level === 'critical' ? 3800 : level === 'warning' ? 3300 : 2800;
        input.readings[0]!.sensors.mq7.adc_raw = 600;
        const response = await page.request.post(`${origin}/api/v1/device/telemetry`, {
          headers: { Authorization: `DeviceKey ${key}` },
          data: input,
        });
        expect(response.status()).toBe(200);
      };
      await upload(1, 'warning');
      await page.reload();
      await page.getByLabel('Thiết bị đang xem').selectOption(deviceId);
      await expect
        .poll(() => page.getByLabel('MQ-2', { exact: true }).getAttribute('class'))
        .toContain('sensor-warning');
      await upload(2, 'critical');
      await expect
        .poll(() => page.getByLabel('MQ-2', { exact: true }).getAttribute('class'))
        .toContain('sensor-critical');
      await page.getByRole('alert').filter({ hasText: 'Critical' }).waitFor();
      const incident = await db.alertIncident.findFirstOrThrow({
        where: { deviceId, condition: 'gas' },
      });
      expect(incident.severity).toBe('critical');
      expect(
        await db.alertEvent.count({ where: { incidentId: incident.id, transition: 'escalated' } }),
      ).toBe(1);
      await upload(3, 'normal');
      await expect
        .poll(() => page.getByLabel('MQ-2', { exact: true }).getAttribute('class'))
        .toContain('sensor-normal');
      expect(
        (await db.alertIncident.findUniqueOrThrow({ where: { id: incident.id } })).status,
      ).toBe('ended');
    } finally {
      await page.close();
    }
  }, 60000);

  it('admin creates and locks users while self-service password change revokes browser sessions', async () => {
    const adminPage = await browser.newPage();
    await adminPage.goto(origin);
    await adminPage.getByLabel('Email', { exact: true }).fill('browser@test.local');
    await adminPage.getByLabel('Mật khẩu', { exact: true }).fill(password);
    await adminPage.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
    await adminPage
      .getByRole('navigation')
      .getByRole('link', { name: 'Tài khoản', exact: true })
      .click({ timeout: 5000 });
    const initial = randomUUID();
    const updated = randomUUID();
    await adminPage.getByLabel('Email tài khoản mới').fill('viewer-browser@test.local');
    await adminPage.getByLabel('Mật khẩu ban đầu').fill(initial);
    await adminPage.getByRole('button', { name: 'Tạo tài khoản', exact: true }).click();
    const row = adminPage.getByRole('row').filter({ hasText: 'viewer-browser@test.local' });
    await row.getByRole('button', { name: 'Khóa', exact: true }).waitFor();
    const viewer = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await viewer.goto(origin);
    await viewer.getByLabel('Email', { exact: true }).fill('viewer-browser@test.local');
    await viewer.getByLabel('Mật khẩu', { exact: true }).fill(initial);
    await viewer.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
    await viewer.getByRole('heading', { name: 'Tổng quan hệ thống', exact: true }).waitFor();
    expect(
      await viewer
        .getByRole('navigation')
        .getByRole('link', { name: 'Tài khoản', exact: true })
        .count(),
    ).toBe(0);
    await viewer
      .getByRole('navigation')
      .getByRole('link', { name: 'Cài đặt', exact: true })
      .click();
    await viewer.getByLabel('Mật khẩu hiện tại', { exact: true }).first().fill(initial);
    await viewer.getByLabel('Mật khẩu mới', { exact: true }).fill(updated);
    await viewer.getByLabel('Nhập lại mật khẩu mới', { exact: true }).fill(updated);
    await viewer.getByRole('button', { name: 'Đổi mật khẩu', exact: true }).click();
    await viewer.getByRole('button', { name: 'Đăng nhập', exact: true }).waitFor();
    await viewer.getByLabel('Email', { exact: true }).fill('viewer-browser@test.local');
    await viewer.getByLabel('Mật khẩu', { exact: true }).fill(updated);
    await viewer.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
    await viewer.getByText('Đã kết nối trực tiếp', { exact: true }).waitFor();
    await row.getByRole('button', { name: 'Khóa', exact: true }).click();
    await viewer
      .getByRole('button', { name: 'Đăng nhập', exact: true })
      .waitFor({ timeout: 10000 });
    await adminPage
      .getByRole('navigation')
      .getByRole('link', { name: 'Nhật ký quản trị', exact: true })
      .click();
    await adminPage
      .getByRole('cell', { name: 'Cập nhật tài khoản', exact: true })
      .first()
      .waitFor();
    await viewer.close();
    await adminPage.close();
  }, 60000);
  it('displays a native push notification when this browser permits notification delivery', async ({
    skip,
  }) => {
    const temporary =
      process.platform === 'win32' && process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, 'Temp', 'opencode')
        : tmpdir();
    await mkdir(temporary, { recursive: true });
    const profile = await mkdtemp(join(temporary, 'iot-webpush-browser-'));
    const context = await chromium.launchPersistentContext(profile, {
      headless: true,
      permissions: ['notifications'],
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const registered = new Promise<string>((resolve) => {
      cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
        const row = registrations.find((r) => r.scopeURL === `${origin}/` && !r.isDeleted);
        if (row) resolve(row.registrationId);
      });
    });
    try {
      await cdp.send('ServiceWorker.enable');
      await page.goto(origin);
      await page.getByLabel('Email', { exact: true }).fill('browser@test.local');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
      await page.getByText('Đã kết nối trực tiếp', { exact: true }).waitFor();
      await context.grantPermissions(['notifications'], { origin });
      if ((await page.evaluate(() => Notification.permission)) !== 'granted')
        skip(
          'Native Notification.permission is denied by this headless browser despite permission override; no delivery claim.',
        );
      await page.evaluate(async () => {
        await navigator.serviceWorker.register('/push-sw.js', { scope: '/' });
        await navigator.serviceWorker.ready;
      });
      await cdp.send('ServiceWorker.deliverPushMessage', {
        origin,
        registrationId: await registered,
        data: JSON.stringify({
          severity: 'critical',
          incident_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          simulator: true,
          ended: false,
          url: '/app/alerts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        }),
      });
      await expect
        .poll(
          () =>
            page.evaluate(async () => {
              const row = await navigator.serviceWorker.getRegistration('/push-sw.js');
              return ((await row?.getNotifications()) ?? []).map((n) => ({
                title: n.title,
                body: n.body,
              }));
            }),
          { timeout: 10000 },
        )
        .toEqual([
          {
            title: 'AirGuard — CRITICAL',
            body: 'MÔ PHỎNG · Có cập nhật cảnh báo cần xem. Mở AirGuard và đăng nhập để xem chi tiết.',
          },
        ]);
    } finally {
      await page
        .evaluate(async () => {
          const row = await navigator.serviceWorker.getRegistration('/push-sw.js');
          for (const n of (await row?.getNotifications()) ?? []) n.close();
        })
        .catch(() => {});
      await cdp.detach();
      await context.close();
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30000);
  it('serves and activates the real push service worker while settings explain disabled backend configuration', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(origin);
      await page.getByLabel('Email', { exact: true }).fill('browser@test.local');
      await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
      await page
        .getByRole('navigation')
        .getByRole('link', { name: 'Cài đặt', exact: true })
        .click();
      await page.getByRole('heading', { name: 'Thông báo trình duyệt', exact: true }).waitFor();
      await page.getByText(/Thông báo trình duyệt hiện chưa khả dụng/).waitFor();
      expect(await page.getByRole('button', { name: 'Bật thông báo', exact: true }).count()).toBe(
        0,
      );
      const worker = await page.evaluate(async () => {
        await navigator.serviceWorker.register('/push-sw.js', { scope: '/' });
        const row = await navigator.serviceWorker.ready;
        return { secure: isSecureContext, scope: row.scope, script: row.active?.scriptURL };
      });
      expect(worker).toEqual({ secure: true, scope: `${origin}/`, script: `${origin}/push-sw.js` });
    } finally {
      await page.close();
    }
  });
});

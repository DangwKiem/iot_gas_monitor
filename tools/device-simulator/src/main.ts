import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { buildPayload } from './payload.js';

const input = z
  .object({
    SIM_DEVICE_ID: z.uuid(),
    SIM_DEVICE_KEY: z.string().regex(/^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/),
    SIM_API_URL: z.url().default('http://127.0.0.1:4000'),
    SIM_INTERVAL_MS: z.coerce.number().int().min(1000).max(60000).default(5000),
  })
  .parse(process.env);
const apiUrl = new URL(input.SIM_API_URL);
if (
  apiUrl.protocol !== 'https:' &&
  !(apiUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(apiUrl.hostname))
)
  throw new Error('Chỉ cho phép HTTP loopback hoặc HTTPS.');
const bootId = randomUUID();
// Milliseconds is persistent enough for simulator starts, not a firmware counter implementation.
const bootCounter = String(Date.now());
const started = performance.now();
let running = true;
process.on('SIGINT', () => {
  running = false;
});
process.on('SIGTERM', () => {
  running = false;
});
console.log('SIMULATOR — dữ liệu mô phỏng, không phải số đo phần cứng. Ctrl+C để dừng.');
let seq = 0n;
while (running) {
  const payload = buildPayload({
    deviceId: input.SIM_DEVICE_ID,
    bootId,
    bootCounter,
    seq: String(++seq),
    uptime: Math.floor(performance.now() - started),
    now: new Date(),
  });
  let backoff = 1000;
  while (running) {
    try {
      const response = await fetch(new URL('/api/v1/device/telemetry', apiUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `DeviceKey ${input.SIM_DEVICE_KEY}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) {
        console.log(`Đã nhận mẫu mô phỏng seq=${seq}`);
        break;
      }
      if (response.status >= 400 && response.status < 500 && response.status !== 429)
        throw new Error(`Lỗi không retry: HTTP ${response.status}. Kiểm tra ID/key/contract.`);
      console.warn(`Server HTTP ${response.status}; đang chờ gửi lại cùng mẫu.`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Lỗi không retry:')) throw error;
      console.warn('Không liên lạc được API; sẽ gửi lại cùng mẫu.');
    }
    await setTimeout(backoff + Math.random() * 500);
    backoff = Math.min(backoff * 2, 60000);
    // Keep immutable reading identity/content; update only transmission metadata on retry.
    payload.transmission.sent_uptime_ms = String(Math.floor(performance.now() - started));
  }
  if (running) await setTimeout(input.SIM_INTERVAL_MS);
}

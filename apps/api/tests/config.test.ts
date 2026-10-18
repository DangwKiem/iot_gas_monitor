import { expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

it('rejects missing database configuration instead of silently using another database', () => {
  expect(() => parseConfig({})).toThrow();
});
it('disables Telegram by default and requires complete explicit credentials when enabled', () => {
  const base = { DATABASE_URL: 'postgresql://localhost/iot' };
  expect(parseConfig(base)).toMatchObject({ telegram: undefined });
  expect(() => parseConfig({ ...base, TELEGRAM_ENABLED: 'true' })).toThrow();
  expect(() => parseConfig({ ...base, TELEGRAM_ENABLED: 'false-ish' })).toThrow();
  expect(
    parseConfig({
      ...base,
      TELEGRAM_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: '123456789:abcdefghijklmnopqrstuvwxyz_123456789',
      TELEGRAM_CHAT_ID: '-1001234567890',
      TELEGRAM_INCLUDE_SIMULATORS: 'true',
    }),
  ).toMatchObject({ telegram: { chatId: '-1001234567890', includeSimulators: true } });
});
it('binds loopback by default and accepts only an exact web origin', () => {
  const config = parseConfig({
    DATABASE_URL: 'postgresql://localhost/iot',
    WEB_ORIGIN: 'http://localhost:5173',
  });
  expect(config.host).toBe('127.0.0.1');
  expect(config.port).toBe(4000);
  expect(() =>
    parseConfig({ DATABASE_URL: 'postgresql://localhost/iot', WEB_ORIGIN: '*' }),
  ).toThrow();
});

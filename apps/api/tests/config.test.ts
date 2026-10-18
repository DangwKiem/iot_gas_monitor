import { expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

it('rejects missing database configuration instead of silently using another database', () => {
  expect(() => parseConfig({})).toThrow();
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

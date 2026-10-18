import pino from 'pino';
import { createDatabase } from '@iot/database';
import { parseConfig } from './config.js';
import { createRuntime } from './runtime.js';

const config = parseConfig(process.env);
const log = pino({
  level: config.logLevel,
  redact: [
    'password',
    'token',
    'key',
    'authorization',
    'databaseUrl',
    'telegram.token',
    'telegram.chatId',
  ],
});
const db = createDatabase(config.databaseUrl);
await db.$connect();
log.info(
  {
    telegram_enabled: !!config.telegram,
    include_simulators: config.telegram?.includeSimulators ?? false,
  },
  'notification_config',
);
const runtime = createRuntime(db, config.origin, {
  secureCookies:
    process.env.NODE_ENV === 'production' || new URL(config.origin).protocol === 'https:',
  onRequest: (entry) => log.info(entry, 'http_request'),
  onFailure: (entry) => log.error(entry, 'request_failed'),
  telegram: config.telegram,
  onNotification: (entry) =>
    entry.code ? log.warn(entry, 'telegram_delivery') : log.info(entry, 'telegram_delivery'),
});
runtime.http.listen(config.port, config.host, () =>
  log.info({ host: config.host, port: config.port }, 'API local sẵn sàng'),
);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(1), 10000).unref();
  await runtime.stopNotifications();
  await new Promise<void>((resolve) => runtime.io.close(() => resolve()));
  await db.$disconnect();
  clearTimeout(deadline);
}
process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});

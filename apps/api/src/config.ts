import { z } from 'zod';

export function parseConfig(env: Record<string, string | undefined>) {
  const input = z
    .object({
      DATABASE_URL: z
        .string()
        .url()
        .refine((v) => /^postgres(ql)?:\/\//.test(v)),
      WEB_ORIGIN: z
        .url()
        .refine((v) => {
          const u = new URL(v);
          return ['http:', 'https:'].includes(u.protocol) && u.origin === v;
        })
        .default('http://localhost:5173'),
      HOST: z.string().default('127.0.0.1'),
      PORT: z.coerce.number().int().min(1).max(65535).default(4000),
      LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
      TELEGRAM_ENABLED: z.enum(['true', 'false']).default('false'),
      TELEGRAM_BOT_TOKEN: z.string().optional(),
      TELEGRAM_CHAT_ID: z.string().optional(),
      TELEGRAM_INCLUDE_SIMULATORS: z.enum(['true', 'false']).default('false'),
    })
    .superRefine((value, ctx) => {
      if (value.TELEGRAM_ENABLED !== 'true') return;
      if (!/^\d{5,20}:[A-Za-z0-9_-]{30,100}$/.test(value.TELEGRAM_BOT_TOKEN ?? ''))
        ctx.addIssue({
          code: 'custom',
          path: ['TELEGRAM_BOT_TOKEN'],
          message: 'Cần bot token Telegram hợp lệ khi bật thông báo.',
        });
      if (!/^-?[1-9]\d{0,19}$/.test(value.TELEGRAM_CHAT_ID ?? ''))
        ctx.addIssue({
          code: 'custom',
          path: ['TELEGRAM_CHAT_ID'],
          message: 'Cần chat ID dạng số (âm cho group/supergroup).',
        });
    })
    .parse(env);
  return {
    databaseUrl: input.DATABASE_URL,
    origin: input.WEB_ORIGIN,
    host: input.HOST,
    port: input.PORT,
    logLevel: input.LOG_LEVEL,
    telegram:
      input.TELEGRAM_ENABLED === 'true'
        ? {
            token: input.TELEGRAM_BOT_TOKEN!,
            chatId: input.TELEGRAM_CHAT_ID!,
            includeSimulators: input.TELEGRAM_INCLUDE_SIMULATORS === 'true',
          }
        : undefined,
  };
}

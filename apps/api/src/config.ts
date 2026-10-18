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
    })
    .parse(env);
  return {
    databaseUrl: input.DATABASE_URL,
    origin: input.WEB_ORIGIN,
    host: input.HOST,
    port: input.PORT,
    logLevel: input.LOG_LEVEL,
  };
}

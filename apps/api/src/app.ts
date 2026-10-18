import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import argon2 from 'argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { Database } from '@iot/database';
import { createDeviceSchema, loginSchema, telemetrySchema, counterSchema } from '@iot/contracts';
import { ApiError } from './lib/errors.js';
import {
  authenticateDevice,
  authenticateUser,
  hashSecret,
  newSecret,
  SESSION_COOKIE,
} from './modules/auth.js';
import { ingest, listDevices, readingView } from './modules/telemetry.js';
import { openapi } from './openapi.js';
import { allowedWebOrigins } from './lib/origins.js';

export function createApp({
  db,
  origin,
  secureCookies = new URL(origin).protocol === 'https:',
  onTelemetry = () => {},
  onLogout = () => {},
  onRequest = () => {},
  onFailure = () => {},
}: {
  db: Database;
  origin: string;
  secureCookies?: boolean;
  onTelemetry?: (deviceId: string) => void;
  onLogout?: (sessionId: string) => void;
  onRequest?: (entry: { request_id: string; method: string; status: number }) => void;
  onFailure?: (entry: { request_id: string; code: string }) => void;
}) {
  const app = express();
  const origins = allowedWebOrigins(origin);
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: secureCookies,
    path: '/',
  };
  app.disable('x-powered-by');
  app.use(helmet());
  app.use((req, res, next) => {
    res.locals.requestId = randomUUID();
    res.setHeader('X-Request-Id', res.locals.requestId);
    res.setHeader('Cache-Control', 'no-store');
    res.on('finish', () =>
      onRequest({
        request_id: res.locals.requestId as string,
        method: req.method,
        status: res.statusCode,
      }),
    );
    if (req.headers.origin && !origins.includes(req.headers.origin))
      return next(new ApiError(403, 'ORIGIN_DENIED', 'Origin không được phép.'));
    next();
  });
  app.use(cors({ origin: origins, credentials: true }));
  app.use(express.json({ limit: '64kb' }));
  const reply = (res: express.Response, data: unknown, extra = {}) =>
    res.json({
      data,
      meta: { request_id: res.locals.requestId, server_time: new Date().toISOString(), ...extra },
    });
  const limitMessage = (_req: express.Request, res: express.Response) =>
    res.status(429).json({
      error: { code: 'RATE_LIMITED', message: 'Quá nhiều yêu cầu. Vui lòng thử lại sau.' },
      meta: { request_id: res.locals.requestId },
    });
  app.use(
    '/api',
    rateLimit({
      windowMs: 60000,
      limit: 600,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: limitMessage,
    }),
  );
  // A custom header cannot be sent by a cross-site HTML form. Cross-origin fetch
  // preflight is restricted by the exact Origin allowlist above, including login.
  app.use('/api/v1', (req, _res, next) => {
    const deviceRoute = req.path.startsWith('/device/');
    if (
      !deviceRoute &&
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      !req.headers.authorization &&
      req.get('X-Requested-With') !== 'AirGuard'
    )
      return next(new ApiError(403, 'CSRF_REJECTED', 'Thiếu header xác minh yêu cầu ứng dụng.'));
    next();
  });
  app.post(
    '/api/v1/auth/login',
    rateLimit({ windowMs: 60000, limit: 10, handler: limitMessage }),
    async (req, res) => {
      const input = loginSchema.parse(req.body);
      const user = await db.user.findUnique({ where: { email: input.email } });
      if (!user?.active || !(await argon2.verify(user.passwordHash, input.password)))
        throw new ApiError(401, 'INVALID_LOGIN', 'Email hoặc mật khẩu không đúng.');
      const token = newSecret();
      const expiresAt = new Date(Date.now() + 8 * 3600000);
      await db.session.create({
        data: { userId: user.id, tokenHash: hashSecret(token), expiresAt },
      });
      res.cookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: 8 * 3600000 });
      reply(res, {
        expires_at: expiresAt.toISOString(),
        user: { id: user.id, email: user.email, role: user.role },
      });
    },
  );
  app.get('/health/live', (_req, res) => reply(res, { status: 'ok' }));
  app.get('/openapi.json', (_req, res) => res.json(openapi));
  app.get('/health/ready', async (_req, res) => {
    await db.$queryRaw`SELECT 1`;
    reply(res, { status: 'ready' });
  });

  app.post('/api/v1/device/telemetry', async (req, res) => {
    const key = await authenticateDevice(db, req.headers.authorization);
    const input = telemetrySchema.parse(req.body);
    if (input.device_id !== key.deviceId)
      throw new ApiError(403, 'DEVICE_MISMATCH', 'Key không thuộc thiết bị này.');
    const result = await ingest(db, key.keyId, input);
    reply(res, { accepted: result.accepted });
    if (result.created.length > 0) onTelemetry(input.device_id);
  });

  app.use('/api/v1', async (req, res, next) => {
    const session = await authenticateUser(db, req.headers.authorization, req.headers.cookie);
    res.locals.session = session;
    next();
  });
  app.get('/api/v1/auth/session', (_req, res) =>
    reply(res, {
      user: res.locals.session.user,
      expires_at: res.locals.session.expiresAt.toISOString(),
    }),
  );
  app.post('/api/v1/auth/logout', async (_req, res) => {
    const sessionId = res.locals.session.sessionId as string;
    await db.session.delete({ where: { id: sessionId } });
    res.clearCookie(SESSION_COOKIE, cookieOptions);
    onLogout(sessionId);
    res.status(204).end();
  });
  const admin: express.RequestHandler = (_req, res, next) => {
    if (res.locals.session.user.role !== 'admin')
      return next(new ApiError(403, 'FORBIDDEN', 'Chỉ admin được thực hiện thao tác này.'));
    next();
  };
  app.get('/api/v1/devices', async (_req, res) => reply(res, await listDevices(db)));
  app.post('/api/v1/devices', admin, async (req, res) => {
    const input = createDeviceSchema.parse(req.body);
    const device = await db.device.create({
      data: { name: input.name, sourceKind: input.source_kind },
    });
    res.status(201);
    reply(res, { id: device.id, name: device.name, source_kind: device.sourceKind });
  });
  app.post('/api/v1/devices/:id/credentials', admin, async (req, res) => {
    const deviceId = z.uuid().parse(req.params.id);
    if (!(await db.device.findUnique({ where: { id: deviceId } })))
      throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy thiết bị.');
    const keyId = randomBytes(12).toString('base64url');
    const secret = newSecret();
    await db.deviceCredential.create({ data: { deviceId, keyId, secretHash: hashSecret(secret) } });
    res.status(201);
    reply(res, { key_id: keyId, key: `${keyId}.${secret}` });
  });
  app.delete('/api/v1/devices/:id/credentials/:keyId', admin, async (req, res) => {
    const deviceId = z.uuid().parse(req.params.id);
    const keyId = z
      .string()
      .regex(/^[A-Za-z0-9_-]{16}$/)
      .parse(req.params.keyId);
    const result = await db.deviceCredential.updateMany({
      where: { deviceId, keyId },
      data: { revokedAt: new Date() },
    });
    if (!result.count) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy key.');
    res.status(204).end();
  });
  app.get('/api/v1/devices/:id/readings/latest', async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const device = await db.device.findUnique({ where: { id } });
    if (!device) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy thiết bị.');
    const latest =
      device.latestId === null
        ? null
        : await db.sensorReading.findUnique({ where: { id: device.latestId } });
    reply(res, latest ? readingView(latest) : null);
  });
  app.get('/api/v1/devices/:id/readings', async (req, res) => {
    const deviceId = z.uuid().parse(req.params.id);
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(1000).default(120),
        cursor: counterSchema.optional(),
      })
      .parse(req.query);
    if (!(await db.device.findUnique({ where: { id: deviceId } })))
      throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy thiết bị.');
    const rows = await db.sensorReading.findMany({
      where: { deviceId, ...(query.cursor ? { id: { lt: BigInt(query.cursor) } } : {}) },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    reply(res, page.map(readingView), {
      next_cursor: rows.length > query.limit ? page.at(-1)!.id.toString() : null,
    });
  });
  app.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'Endpoint không tồn tại.')));
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (res.headersSent) return;
    const invalidJson = error instanceof SyntaxError && 'body' in error;
    const oversized =
      typeof error === 'object' &&
      error !== null &&
      'type' in error &&
      error.type === 'entity.too.large';
    const status =
      error instanceof ApiError
        ? error.status
        : error instanceof ZodError
          ? 422
          : invalidJson
            ? 400
            : oversized
              ? 413
              : 503;
    const code =
      error instanceof ApiError
        ? error.code
        : error instanceof ZodError
          ? 'VALIDATION_ERROR'
          : invalidJson
            ? 'INVALID_JSON'
            : oversized
              ? 'PAYLOAD_TOO_LARGE'
              : 'SERVICE_UNAVAILABLE';
    if (status >= 500) onFailure({ request_id: res.locals.requestId as string, code });
    res.status(status).json({
      error: {
        code,
        message:
          error instanceof ApiError
            ? error.message
            : error instanceof ZodError
              ? 'Dữ liệu không hợp lệ.'
              : 'Không thể xử lý yêu cầu.',
        ...(error instanceof ZodError
          ? { details: error.issues.map((i) => ({ path: i.path, message: i.message })) }
          : {}),
      },
      meta: { request_id: res.locals.requestId },
    });
  };
  app.use(errors);
  return app;
}

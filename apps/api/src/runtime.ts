import { createServer } from 'node:http';
import { Server } from 'socket.io';
import type { Database } from '@iot/database';
import { createApp } from './app.js';
import { authenticateUser } from './modules/auth.js';
import { z } from 'zod';
import { allowedWebOrigins } from './lib/origins.js';

export function createRuntime(
  db: Database,
  origin: string,
  logging: {
    onRequest?: (entry: { request_id: string; method: string; status: number }) => void;
    onFailure?: (entry: { request_id: string; code: string }) => void;
    secureCookies?: boolean;
  } = {},
) {
  const app = createApp({
    db,
    origin,
    ...logging,
    onTelemetry: (deviceId) =>
      io
        .of('/monitoring')
        .to(`device:${deviceId}`)
        .emit('telemetry.created', {
          version: 1,
          event_id: crypto.randomUUID(),
          type: 'telemetry.created',
          emitted_at: new Date().toISOString(),
          device_id: deviceId,
          data: { refetch: true },
        }),
    onLogout: (sessionId) =>
      io.of('/monitoring').in(`session:${sessionId}`).disconnectSockets(true),
  });
  const http = createServer(app);
  const origins = allowedWebOrigins(origin);
  const io = new Server(http, {
    cors: { origin: origins, credentials: true },
    maxHttpBufferSize: 16384,
    allowRequest: (req, done) =>
      done(null, !req.headers.origin || origins.includes(req.headers.origin)),
  });
  const namespace = io.of('/monitoring');
  namespace.use(async (socket, next) => {
    try {
      socket.data.session = await authenticateUser(db, undefined, socket.request.headers.cookie);
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });
  namespace.on('connection', (socket) => {
    const session = socket.data.session as Awaited<ReturnType<typeof authenticateUser>>;
    void socket.join(`session:${session.sessionId}`);
    const expiry = setTimeout(
      () => socket.disconnect(true),
      Math.max(0, session.expiresAt.getTime() - Date.now()),
    );
    expiry.unref();
    socket.on('disconnect', () => clearTimeout(expiry));
    const subscribeSchema = z.strictObject({ device_ids: z.array(z.uuid()).min(1).max(100) });
    socket.on('devices.subscribe', async (payload: unknown, ack: unknown) => {
      if (typeof ack !== 'function') return;
      const parsed = subscribeSchema.safeParse(payload);
      if (!parsed.success) return ack({ error: 'VALIDATION_ERROR', accepted_device_ids: [] });
      try {
        await authenticateUser(db, undefined, socket.request.headers.cookie);
        const devices = await db.device.findMany({
          where: { id: { in: parsed.data.device_ids } },
          select: { id: true },
        });
        const accepted = devices.map((d) => d.id);
        // Group-scoped v1: all authenticated roles can read all devices.
        await socket.join(accepted.map((id) => `device:${id}`));
        ack({
          accepted_device_ids: accepted,
          rejected_device_ids: parsed.data.device_ids.filter((id) => !accepted.includes(id)),
        });
      } catch {
        socket.disconnect(true);
      }
    });
    socket.on('devices.unsubscribe', (payload: unknown) => {
      const parsed = subscribeSchema.safeParse(payload);
      if (parsed.success)
        for (const id of parsed.data.device_ids) void socket.leave(`device:${id}`);
    });
  });
  return { app, http, io };
}

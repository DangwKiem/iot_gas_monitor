import { z } from 'zod';
import { telemetrySchema, createDeviceSchema } from '@iot/contracts';

const success = { description: 'Response envelope: data + meta(request_id, server_time).' };
const errors = {
  '401': { description: 'Không có phiên hoặc key hợp lệ.' },
  '403': { description: 'Không có quyền hoặc Origin không được phép.' },
  '422': { description: 'Payload hoặc query không hợp lệ.' },
  '429': { description: 'Rate limit; tôn trọng Retry-After.' },
  '503': { description: 'Dependency không sẵn sàng; retry có backoff.' },
};
const operation = (summary: string, security = [{ UserSession: [] as string[] }]) => ({
  summary,
  security,
  responses: { '200': success, ...errors },
});
const deviceId = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};

export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'AirGuard Local API',
    version: '0.1.0',
    description:
      'Lát cắt local: auth, devices, credentials và raw telemetry. Web dùng cookie HttpOnly; mọi request ghi của web (kể cả login) cần X-Requested-With: AirGuard và Origin thuộc allowlist. Chưa có firmware, calibrated PPM, incident history hoặc cloud.',
  },
  paths: {
    '/health/live': { get: { ...operation('Process health', []), responses: { '200': success } } },
    '/health/ready': { get: operation('PostgreSQL readiness', []) },
    '/api/v1/auth/login': {
      post: {
        ...operation('Đăng nhập, đặt cookie HttpOnly 8 giờ; JSON chỉ trả user và expires_at', []),
        parameters: [
          {
            name: 'X-Requested-With',
            in: 'header',
            required: true,
            schema: { type: 'string', const: 'AirGuard' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string', minLength: 1, maxLength: 128 },
                },
              },
            },
          },
        },
      },
    },
    '/api/v1/auth/session': { get: operation('Thông tin phiên hiện tại') },
    '/api/v1/auth/logout': {
      post: {
        ...operation('Thu hồi phiên và ngắt socket'),
        responses: { '204': { description: 'Đã đăng xuất.' }, ...errors },
      },
    },
    '/api/v1/devices': {
      get: operation('Tối đa 100 thiết bị của nhóm; kèm latest và source_kind do server quản lý'),
      post: {
        ...operation('Đăng ký thiết bị — chỉ admin'),
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CreateDevice' } },
          },
        },
        responses: { '201': success, ...errors },
      },
    },
    '/api/v1/devices/{id}/credentials': {
      parameters: [deviceId],
      post: {
        ...operation('Cấp key riêng — chỉ admin, secret trả một lần'),
        responses: { '201': success, ...errors },
      },
    },
    '/api/v1/devices/{id}/credentials/{keyId}': {
      parameters: [
        deviceId,
        { name: 'keyId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      delete: { ...operation('Thu hồi key — chỉ admin'), responses: { '204': success, ...errors } },
    },
    '/api/v1/devices/{id}/readings/latest': {
      parameters: [deviceId],
      get: operation('Snapshot theo boot/sequence mới nhất; null nếu chưa có'),
    },
    '/api/v1/devices/{id}/readings': {
      parameters: [deviceId],
      get: {
        ...operation('History theo thứ tự nhận giảm dần; meta.next_cursor để tải tiếp'),
        parameters: [
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 1000, default: 120 },
          },
          { name: 'cursor', in: 'query', schema: { type: 'string', pattern: '^[0-9]+$' } },
        ],
      },
    },
    '/api/v1/device/telemetry': {
      post: {
        ...operation(
          'Nhận 1–20 mẫu raw, 64 KiB; ACK sau commit. Retry phải giữ nguyên record.',
          [],
        ),
        security: [{ DeviceKey: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Telemetry' } } },
        },
        responses: {
          '200': { description: 'data.accepted[] gồm boot_id, seq, duplicate.' },
          '409': { description: 'Identity/boot conflict; toàn batch rollback.' },
          '413': { description: 'Payload quá lớn.' },
          ...errors,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      UserSession: {
        type: 'apiKey',
        in: 'cookie',
        name: 'iot_session',
        description:
          'Cookie HttpOnly từ login, SameSite=Lax, hết hạn 8 giờ; Secure khi dùng HTTPS/production. JSON không trả token.',
      },
      DeviceKey: {
        type: 'apiKey',
        in: 'header',
        name: 'Authorization',
        description: 'DeviceKey <key_id>.<secret>',
      },
    },
    schemas: {
      Telemetry: z.toJSONSchema(telemetrySchema),
      CreateDevice: z.toJSONSchema(createDeviceSchema),
    },
  },
};

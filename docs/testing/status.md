# Trạng thái kiểm thử — lát cắt local đầu tiên

## Môi trường

- Windows, Node.js 24.18.0, npm 11.16.0.
- Docker Desktop Linux Engine 29.6.1.
- PostgreSQL 17 trong container test riêng, password ngẫu nhiên cho mỗi lần chạy.
- Prisma 7.10.1, Vitest 5.0.5; versions cụ thể còn lại được khóa trong package-lock.json.
- Chromium do Playwright cài; browser tests không thay thế kiểm thử trên hardware.
- Workspace không có Git repository/commit tại thời điểm triển khai.

## Những gì đã được kiểm tra

- Contract: ADC giới hạn theo độ phân giải, raw PPM null, invalid sensor dùng null, humidity range, schema version, signed BIGINT và đồng bộ timestamp.
- API/PostgreSQL: login, session hash, role restrictions, device key hash/revoke, device ID scope, batch validation, concurrent duplicate, atomic rollback, delayed ordering, bounded cursor history.
- Boundary errors: Origin allowlist, malformed JSON, database không liên lạc được trả 503, log/response không lộ secret.
- Realtime: từ chối socket không có session, subscribe theo device, event sau commit, disconnect khi logout.
- UI: login success/error, empty state không tạo số đo giả, nhãn simulator, invalid không biến thành zero, stale không biến thành dữ liệu mới.
- Browser end-to-end thật: tạo simulator, cấp key, upload HTTP vào API thật, hiển thị sensor/chart, viewport 390 px không tràn ngang, logout xóa server session; không có pageerror trong luồng.
- TypeScript strict, ESLint, Vite build và dependency audit.

## Lệnh tái chạy

Kết quả lần xác minh local:

| Lệnh                       | Kết quả                                                                      |
| -------------------------- | ---------------------------------------------------------------------------- |
| `npm test`                 | 31 pass, 24 skip do cần runner DB/browser                                    |
| `npm run test:integration` | 34 pass, gồm API/Socket/session với PostgreSQL thật và config/logging/Origin |
| `npm run test:e2e`         | 1 pass trong Chromium thật                                                   |
| `npm run lint`             | Pass                                                                         |
| `npm run build`            | Typecheck + frontend build pass                                              |
| `npm audit`                | 0 vulnerabilities được báo tại thời điểm chạy                                |

Các suite config/logging chạy lại ở nhiều lệnh; không cộng tổng các lần chạy thành số test độc lập.

```powershell
npm run db:generate
npm test
npm run test:integration
npx playwright install chromium
npm run test:e2e
npm run lint
npm run build
npm run format:check
npm audit
```

`npm test` mặc định skip API/Socket/browser tests cần TEST_DATABASE_URL. Hai runner `test:integration` và `test:e2e` thực thi các suite đó với database biệt lập, không sử dụng database development. Đọc số pass/skip từ output tương ứng, không coi skip là pass.

Các kiểm thử được viết và quan sát fail trước phần implementation tương ứng; browser E2E còn dùng để xác minh luồng tích hợp thật.

## Chưa kiểm tra / chưa đạt cổng nghiệm thu đầy đủ

- Chưa chạy 60 phút telemetry, 24 giờ soak, tải 10 thiết bị/5 browser hoặc đo percentile latency theo AC.
- Chưa chạy backup/restore drill, retention/rollup hoặc deployment smoke ngoài LAN.
- Chưa có incident history/acknowledgement, analytics/export, heartbeat/config workflow hoặc quản lý tài khoản đầy đủ để kiểm thử.
- Chưa có firmware, wiring, heater, calibration, sensor integration, cảnh báo cục bộ hoặc hardware-in-the-loop.
- Chưa triển khai hoặc kiểm thử cloud. Không suy diễn availability/SLA từ test local.

## Regression: Origin local và phiên đăng nhập sau refresh

- Đã quan sát test fail trước khi sửa: loopback alias bị 403, không có cookie, frontend không bootstrap session.
- Bổ sung Origin tests: localhost/127.0.0.1 cùng port/scheme được phép; port/scheme/domain khác và null Origin bị chặn.
- Bổ sung PostgreSQL session tests: HttpOnly/host-only/expiry, token không trả trong JSON, cookie phục hồi session, anti-CSRF, logout/revoke, expired session và Secure trên HTTPS.
- Browser E2E cấu hình origin localhost nhưng mở bằng 127.0.0.1, reload sau login vẫn vào dashboard và realtime kết nối. Cookie không đọc được từ document.cookie; reload sau logout vẫn ở trang login.
- Không thay đổi hoặc reset database development; kiểm thử DB/browser vẫn dùng container riêng.

Đây là bằng chứng cho lát cắt đầu tiên, không phải tuyên bố hoàn thành toàn bộ PLAN.md.

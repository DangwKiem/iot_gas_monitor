# AirGuard — IoT Gas Monitor

Dashboard giám sát tín hiệu cảm biến phục vụ nghiên cứu/học tập. **Không phải thiết bị an toàn sinh mạng được chứng nhận.** Không quy đổi tín hiệu MQ chưa hiệu chuẩn thành PPM/AQI.

## Trạng thái hiện tại

Lát cắt local đầu tiên gồm:

- Express/TypeScript, PostgreSQL thật qua Prisma, migration.
- Login, session cookie HttpOnly 8 giờ (giữ qua refresh), roles, admin bootstrap.
- Đăng ký thiết bị thật/simulator; cấp và thu hồi device key, DB chỉ lưu hash.
- Batch ingestion, validation, duplicate/concurrency, atomic rollback và ordering.
- Danh sách thiết bị, snapshot mới nhất, lịch sử cursor.
- Socket.IO có authentication và room; realtime invalidation sau commit.
- React dashboard tiếng Việt, theme, overview, monitoring/chart, thiết bị, snapshot cảnh báo, settings.
- Simulator gửi dữ liệu mô phỏng có nhãn. Không tự seed số đo vào dashboard.

Chưa có firmware/cloud, alert event history/ack, analytics/export, retention jobs và user management đầy đủ. Xem [PLAN.md](PLAN.md) và [các quyết định triển khai](docs/architecture/decisions.md).

## Yêu cầu

- Node.js **24 LTS** (tối thiểu 22.12).
- npm.
- Docker Desktop chạy Linux containers; bật Docker Engine trước khi khởi động PostgreSQL.
- Cổng local: API `4000`, Vite `5173`, PostgreSQL `15432`.

## Chạy local

Các lệnh chạy từ thư mục gốc project, tương thích PowerShell.

### 1. Dependencies và cấu hình

```powershell
npm ci
Copy-Item .env.example .env
```

Chỉnh `.env`:

- Tự chọn `POSTGRES_PASSWORD`, sửa cùng password trong `DATABASE_URL` (URL-encode nếu có ký tự đặc biệt).
- Điền `ADMIN_EMAIL`, `ADMIN_PASSWORD` ít nhất 12 ký tự, tối đa 128.
- Giữ `WEB_ORIGIN=http://localhost:5173`; backend cũng cho phép alias `http://127.0.0.1:5173` cùng scheme/port. Không tự cho phép domain, scheme hoặc port khác.
- Không commit `.env`, password hoặc key. Không cần tài khoản cloud.

### 2. PostgreSQL và migration

```powershell
docker compose up -d --wait postgres
npm run db:generate
npm run db:migrate
npm run admin:create
```

Bootstrap không ghi đè tài khoản đã có. Sau khi tạo thành công, xóa giá trị `ADMIN_PASSWORD` trong `.env`.

### 3. Backend và frontend

```powershell
npm run dev
```

Mở **http://localhost:5173**, đăng nhập bằng tài khoản vừa tạo.

- API bind loopback mặc định; `/health/live` và `/health/ready` ở http://127.0.0.1:4000.
- Vite proxy `/api` và `/socket.io` sang backend.
- OpenAPI cho endpoints đã có: http://127.0.0.1:4000/openapi.json. Các semantic checks như ADC/quality và ordering còn được thực thi bằng Zod/service.
- HTTP chỉ dành cho môi trường local. ESP32/Internet về sau phải dùng TLS verification.
- Phiên dùng cookie HttpOnly, host-only, SameSite=Lax và lưu tối đa 8 giờ. Refresh hoặc mở lại tab cùng hostname không cần đăng nhập lại trong thời hạn này. `localhost` và `127.0.0.1` có cookie riêng; nên dùng nhất quán một địa chỉ.
- Browser tự khôi phục phiên qua `/api/v1/auth/session`, không lưu token/password vào localStorage. Các request ghi dùng `X-Requested-With: AirGuard` chống CSRF; Socket.IO dùng cùng cookie.
- HTTPS hoặc `NODE_ENV=production` bật thuộc tính Secure; HTTP chỉ dành cho local. Đăng xuất xóa cookie và thu hồi phiên trong DB. Nếu server không phản hồi, UI báo chưa thể đăng xuất thay vì giả thành công.

### 4. Kết nối simulator

1. Trang **Thiết bị** → thêm nguồn **Simulator — dữ liệu mô phỏng**.
2. Bấm **Cấp key**; lưu ID và key được hiển thị một lần.
3. Điền vào `.env`: `SIM_DEVICE_ID`, `SIM_DEVICE_KEY`.
4. Mở terminal khác:

```powershell
npm run simulate
```

Mẫu gửi mỗi 5 giây. Xem Overview hoặc Giám sát trực tiếp để thấy ADC/nhiệt độ/độ ẩm mô phỏng. Gas/CO giữ `not_configured`. Không mô phỏng thành nồng độ đo thật.

Simulator retry cùng nội dung khi timeout/5xx. Bản đầu tạo mẫu tuần tự, không mô phỏng đầy đủ buffer firmware. Dừng Ctrl+C; dashboard chuyển offline sau khoảng 30–35 giây, khi polling hoạt động.

**Quan trọng:** source_kind được server lưu lúc đăng ký. Không dùng key của thiết bị thật để chạy simulator.

### 5. Dừng local

Ctrl+C trong các terminal. Dừng database nhưng giữ dữ liệu:

```powershell
docker compose stop postgres
```

Không chạy `docker compose down -v` nếu muốn giữ database. Trước thay đổi dữ liệu quan trọng cần backup; bản đầu chưa tự động backup.

## Kiểm tra chất lượng

```powershell
npm test
npm run test:integration
npx playwright install chromium
npm run test:e2e
npm run typecheck
npm run lint
npm run build
npm run format:check
npm audit
```

- `npm test`: contract/unit/frontend; integration DB skip khi không có `TEST_DATABASE_URL`.
- `npm run test:integration`: Docker phải chạy; runner tạo PostgreSQL container riêng với credential ngẫu nhiên, apply migration, chạy API/Socket tests rồi xóa đúng container thử nghiệm. Không sửa/xóa database development.
- `npm run test:e2e`: container PostgreSQL riêng + API/Vite + Chromium thật; đăng nhập → tạo simulator/key → upload → chart → viewport mobile → logout. Cài Chromium bằng lệnh trên trước lần chạy đầu.
- Chưa có kiểm thử firmware, HIL hoặc load/soak dài hạn. Kết quả đã chạy: [docs/testing/status.md](docs/testing/status.md).

## Contract tích hợp firmware

Contract thực thi tại `packages/contracts/src/index.ts`, payload ví dụ tại `packages/contracts/tests/fixture.ts` (dữ liệu thử nghiệm).

```text
POST /api/v1/device/telemetry
Content-Type: application/json
Authorization: DeviceKey <key_id>.<secret>
```

- Payload gồm schema_version, device_id, transmission và readings (1–20 mẫu), tối đa 64 KiB.
- Identity: device_id + boot_id + seq; seq/boot_counter/uptime là chuỗi số.
- Sensor lỗi gửi null và quality; không gửi NaN, không thay lỗi bằng zero.
- ADC raw có adc_bits; adc_pin_mv là điện áp tại chân ADC.
- PPM hiện phải null; heater_control có thể unverified/unsupported/controlled nhưng chưa chứng nhận phép đo.
- Backend trả accepted theo từng boot_id/seq, duplicate flag; chỉ sau DB commit.
- 401/403 kiểm tra key/quyền; 409 identity conflict; 422 payload/time lỗi; 429 chờ Retry-After; timeout/5xx retry cùng record.
- Firmware phải giữ boot_counter tăng bền. Factory reset cần quy trình reprovision; không tái sử dụng counter với boot_id khác.

Contract chưa khóa cho hardware release. GPIO, mạch nguồn/heater, calibration và cảnh báo local sẽ xác minh khi có thông tin phần cứng.

## Cấu trúc

```text
apps/api             Express API, auth, telemetry, Socket.IO
apps/web             React/Vite/Tailwind dashboard
packages/contracts   Zod schemas và shared types
packages/database    Prisma schema, SQL migration, DB client
tools/device-simulator  Nguồn dữ liệu mô phỏng
tests/run-integration.ts  PostgreSQL integration runner biệt lập
docs/architecture    Quyết định và giới hạn triển khai
```

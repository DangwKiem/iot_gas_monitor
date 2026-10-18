# AirGuard — IoT Gas Monitor

Dashboard giám sát tín hiệu cảm biến phục vụ nghiên cứu/học tập. **Không phải thiết bị an toàn sinh mạng được chứng nhận.** Không quy đổi tín hiệu MQ chưa hiệu chuẩn thành PPM/AQI.

## Trạng thái hiện tại

Phần mềm local hiện gồm:

- Express/TypeScript, PostgreSQL thật qua Prisma, migration.
- Login, session cookie HttpOnly 8 giờ (giữ qua refresh), roles, admin bootstrap.
- Quản lý metadata/lưu trữ thiết bị; key list/expiry/rotation/revoke, DB chỉ lưu hash.
- Batch ingestion, validation, duplicate/concurrency, atomic rollback và ordering.
- Danh sách thiết bị, snapshot mới nhất, lịch sử cursor.
- Socket.IO có authentication và room; realtime invalidation sau commit.
- Incident/event history, bộ lọc, timeline và acknowledgement có danh tính; không tắt còi qua web.
- Analytics min/max/average/count, so sánh kỳ trước, lịch sử theo thời gian và CSV chống formula injection.
- Cấu hình chu kỳ gửi có version/expected_version/hash/ETag/ACK, heartbeat và lịch sử kết nối.
- React dashboard tiếng Việt, theme, overview, monitoring/chart, sự cố, analytics, quản trị thiết bị/key/config.
- Simulator gửi dữ liệu mô phỏng có nhãn. Không tự seed số đo vào dashboard.
- Telegram warning/critical qua outbox PostgreSQL, chống gửi lặp theo sự cố/mức độ, retry/backoff; cấu hình bằng `.env`, mặc định tắt và không gửi simulator nếu chưa cho phép.
- Quản lý tài khoản/đổi mật khẩu, khóa/quyền thu hồi sessions, nhật ký quản trị; retention/rollup có dry-run, backup mã hóa và restore vào DB trống riêng; CI checks và load runner 10 thiết bị/5 browser.

Firmware/cloud vẫn hoãn. Retention/backup chỉ chạy bằng lệnh hoặc lịch do người vận hành chọn, không tự xóa dữ liệu development. Xem [PLAN.md](PLAN.md), [runbook phần mềm](docs/operations/local-runbook.md), [các quyết định triển khai](docs/architecture/decisions.md) và [API/workflow](docs/api/monitoring.md). Các bài nghiệm thu dài hạn chưa được suy từ test chức năng.

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

Mặc định mẫu gửi mỗi 5 giây. Simulator tự nhận cấu hình chu kỳ từ server, xác minh hash và gửi ACK; chỉnh ở **Thiết bị → tên thiết bị → Cấu hình thiết bị** (1–60 giây). `SIM_INTERVAL_MS` chỉ là giá trị dự phòng trước khi tải được cấu hình. Xem Overview hoặc Giám sát trực tiếp để thấy ADC/nhiệt độ/độ ẩm mô phỏng. Gas/CO giữ `not_configured`. Không mô phỏng thành nồng độ đo thật.

Simulator retry cùng nội dung khi timeout/5xx. Tạo mẫu tuần tự, chưa mô phỏng đầy đủ durable event/buffer firmware. Dừng Ctrl+C; dashboard chuyển offline sau max(30 giây, 3 × chu kỳ đã áp dụng), cộng tối đa khoảng 5 giây phát hiện.

**Quan trọng:** source_kind được server lưu lúc đăng ký. Không dùng key của thiết bị thật để chạy simulator.

#### Mô phỏng cảnh báo nguy hiểm

Dừng simulator cũ bằng Ctrl+C rồi chạy (giữ `SIM_DEVICE_ID`/`SIM_DEVICE_KEY` của nguồn **Simulator** trong `.env`):

```powershell
npm run simulate -- --scenario danger
```

Chu kỳ lặp 10 mẫu: **1–2 bình thường → 3–6 Gas/CO/Flame active, còi mô phỏng bật → 7–10 phục hồi, còi mô phỏng tắt**. Với chu kỳ gửi 5 giây, cảnh báo đầu tiên xuất hiện sau khoảng 10 giây, kéo dài khoảng 20 giây; tốc độ thay đổi theo cấu hình chu kỳ truyền đã áp dụng.

Mở **Giám sát trực tiếp** để xem snapshot và **Cảnh báo & sự cố** để thử timeline/acknowledge/kết thúc. Mỗi vòng tạo ba sự cố; acknowledge không kết thúc cảnh báo. Không có âm thanh hay lệnh tới còi vật lý. Kịch bản không dựa trên ADC/PPM, gas vẫn `uncalibrated`, PPM luôn null và MQ-7 heater vẫn `unverified`. Không dùng để xác nhận an toàn phần cứng.

`npm run simulate` (hoặc `--scenario normal`) giữ chế độ cũ: Gas/CO `not_configured`, không tự tạo cảnh báo. Nếu dừng giữa pha active, sự cố có thể còn chưa kết thúc cho tới khi thiết bị gửi trạng thái normal; offline không tự đóng incident.

### Dùng các màn hình mới

- **Cảnh báo & sự cố**: lọc thiết bị/điều kiện/mức độ/trạng thái/xác nhận/thời gian; mở chi tiết để xem timeline. Operator/admin được xác nhận đã xem; không đóng incident hay tắt còi.
- **Analytics & lịch sử**: chọn khoảng giờ, cơ sở thời gian đo/nhận, đại lượng và bucket; so sánh kỳ trước và tải CSV. Gas chỉ hiển thị ADC thô. Mẫu thiếu/lỗi không thành số 0.
- **Thiết bị → tên thiết bị**: sửa vị trí/mô tả; cấp/đổi/thu hồi key và hạn dùng; xem desired/applied config, phiên bản/ACK và lịch sử online/offline. Lưu trữ giữ dữ liệu nhưng chặn key; khôi phục chỉ mở lại key còn hiệu lực.
- Khi nâng cấp checkout cũ, dừng API rồi chạy `npm run db:generate` và `npm run db:migrate` trước khi khởi động lại; migration bổ sung giữ nguyên users/telemetry và khởi tạo config v1 cho thiết bị cũ. Backup trước khi migrate database có dữ liệu quan trọng.

### Nhận cảnh báo qua bot Telegram

1. Tạo bot bằng **@BotFather** trong Telegram, giữ token riêng tư.
2. Nhắn `/start` cho bot (hoặc thêm bot vào group và cấp quyền gửi tin); lấy `chat_id` từ `getUpdates` của bot. Chat ID group/supergroup thường là số âm. Không đưa token vào ảnh chụp, Git hoặc gửi trong chat này.
3. Điền các biến sau vào `.env` ignored:

```dotenv
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=<token-cua-bot>
TELEGRAM_CHAT_ID=<chat-id-dang-so>
TELEGRAM_INCLUDE_SIMULATORS=true
```

4. Chạy `npm run db:generate`, `npm run db:migrate`, khởi động lại `npm run dev`.
5. Để thử cảnh báo giả lập: `npm run simulate -- --scenario danger`. Mỗi vòng có hai warning Gas/CO và một critical Flame. Đặt `TELEGRAM_INCLUDE_SIMULATORS=false` khi chỉ muốn nhận từ thiết bị thật.

Gửi khi có incident mới hoặc backend ghi nhận nâng mức; không gửi mỗi mẫu telemetry, không gửi riêng khi acknowledge/phục hồi. Worker xử lý sau DB commit, hàng đợi tồn tại qua restart; lỗi gửi không chặn ingestion và không điều khiển còi. Token/chat ID không nằm trong DB/log; tin có tên/vị trí thiết bị, condition, severity, thời gian UTC, ID sự cố và nhãn mô phỏng.

Telegram phụ thuộc Internet, không bảo đảm giao đúng một lần khi timeout/tiến trình crash sau khi Telegram đã nhận. Không dùng thay cảnh báo cục bộ. Chi tiết retry, trạng thái lỗi và restore tại [runbook](docs/operations/local-runbook.md#telegram-warningcritical).

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
npm run test:load
npm run typecheck
npm run lint
npm run build
npm run format:check
npm audit
```

- `npm test`: contract/unit/frontend; integration DB skip khi không có `TEST_DATABASE_URL`.
- `npm run test:integration`: Docker phải chạy; runner tạo PostgreSQL container riêng với credential ngẫu nhiên, apply migration, chạy API/Socket tests rồi xóa đúng container thử nghiệm. Không sửa/xóa database development.
- `npm run test:e2e`: container PostgreSQL riêng + API/Vite + Chromium thật; kiểm tra login/refresh/realtime/mobile/logout, incident/ack/timeline, CSV download, cấu hình/ACK, rotation key và lưu trữ/khôi phục. Cài Chromium bằng lệnh trên trước lần chạy đầu.
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

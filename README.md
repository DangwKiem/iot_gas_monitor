# AirGuard — IoT Gas Monitor

Hệ thống giám sát tín hiệu cảm biến môi trường/gas, có dashboard tiếng Việt và thông báo Telegram. Hiện chạy **local trên máy tính bằng simulator**, chưa cần ESP32 để thử phần mềm.

> **Giới hạn an toàn:** Đây là dự án nghiên cứu/học tập, không phải thiết bị cảnh báo an toàn sinh mạng được chứng nhận. MQ-2/MQ-7 hiện chỉ hiển thị tín hiệu ADC thô, **không quy đổi PPM/AQI**. Firmware, đấu dây và cảnh báo cục bộ trên phần cứng chưa triển khai.

## Mục lục

- [Trạng thái hiện tại](#trạng-thái-hiện-tại)
- [Chuẩn bị trước khi cài](#chuẩn-bị-trước-khi-cài)
- [Cài đặt lần đầu trên Windows](#cài-đặt-lần-đầu-trên-windows)
- [Tạo thiết bị và chạy simulator](#tạo-thiết-bị-và-chạy-simulator)
- [Thử cảnh báo nguy hiểm](#thử-cảnh-báo-nguy-hiểm)
- [Cấu hình Telegram](#cấu-hình-telegram)
- [Sử dụng dashboard](#sử-dụng-dashboard)
- [Chạy lại hằng ngày và dừng hệ thống](#chạy-lại-hằng-ngày-và-dừng-hệ-thống)
- [Cập nhật mã nguồn mà giữ dữ liệu](#cập-nhật-mã-nguồn-mà-giữ-dữ-liệu)
- [Backup, restore và retention](#backup-restore-và-retention)
- [Kiểm thử và CI](#kiểm-thử-và-ci)
- [Xử lý lỗi thường gặp](#xử-lý-lỗi-thường-gặp)
- [Cấu trúc project và tài liệu kỹ thuật](#cấu-trúc-project-và-tài-liệu-kỹ-thuật)

## Trạng thái hiện tại

| Hạng mục            | Đã có                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Backend/database    | Node.js, TypeScript, Express, Prisma, PostgreSQL, migrations                                                       |
| Đăng nhập/tài khoản | Session cookie HttpOnly 8 giờ, giữ qua refresh; admin/operator/viewer; tạo, khóa, đổi quyền, đổi email/mật khẩu    |
| Thiết bị và key     | Đăng ký nguồn thật/simulator; metadata, lưu trữ/khôi phục; cấp key, expiry, rotation, thu hồi; chỉ lưu hash secret |
| Telemetry           | Batch ingestion, validation, transaction, dedup và chống cập nhật lùi do mẫu đến muộn                              |
| Giám sát            | Overview, sensor quality/freshness, chart, realtime Socket.IO và REST refetch                                      |
| Sự cố               | Incident/event history, timeline, bộ lọc, xác nhận đã xem có danh tính; không tắt còi qua web                      |
| Analytics/CSV       | Lọc thời gian, min/max/average, so sánh kỳ trước, CSV có quality/source/timestamps và chống formula injection      |
| Cấu hình            | Chu kỳ gửi có version/hash/ETag/ACK, phân biệt mong muốn và đã áp dụng; heartbeat/status history                   |
| Simulator           | Chế độ bình thường và cảnh báo nguy hiểm có nhãn mô phỏng; tự tải/ACK cấu hình chu kỳ gửi                          |
| Telegram            | Warning/critical qua hàng đợi PostgreSQL, chống tạo job lặp theo sự cố/mức độ, retry/backoff; mặc định tắt         |
| Vận hành            | Nhật ký quản trị; backup mã hóa/restore DB riêng; retention/rollup có dry-run; CI và load runner                   |

**Chưa hoàn thành/nghiệm thu:** firmware ESP32 và HIL, xác minh nguồn/heater/hiệu chuẩn, cloud, tải 30 phút/soak 24 giờ, lịch backup/maintenance ngoài hệ điều hành và phân trang lịch sử config trên 100 phiên bản gần nhất. Không tự chạy purge, không tự xóa backup. Có công cụ không đồng nghĩa đã vượt mọi tiêu chí nghiệm thu trong [PLAN.md](PLAN.md).

### Các thành phần chạy như thế nào?

```text
Simulator ──HTTP──> API Node.js ──> PostgreSQL trong Docker
                       │
                       ├── REST / Socket.IO ──> Dashboard trên trình duyệt
                       └── Hàng đợi thông báo ──HTTPS──> Telegram (nếu bật)
```

- **Docker** hiện chỉ dùng để chạy PostgreSQL và công cụ PostgreSQL cho backup/test. Backend/frontend không tự chạy trong container.
- **Backend/API** nhận dữ liệu, kiểm tra quyền, lưu DB và xử lý sự cố.
- **Frontend/dashboard** là trang web xem dữ liệu và quản trị.
- **Simulator** là chương trình giả lập thiết bị, chỉ gửi dữ liệu khi bạn chạy nó.
- Không cần tài khoản cloud để làm theo hướng dẫn này. Chỉ Telegram cần Internet và tài khoản Telegram nếu muốn bật thông báo.

## Chuẩn bị trước khi cài

Hướng dẫn chính dùng **Windows 10/11 và PowerShell**, đã kiểm thử với Node.js 24 và Docker Desktop Linux Engine.

### Cài các công cụ

| Công cụ         | Cách cài/lưu ý                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Git             | Tải từ [git-scm.com](https://git-scm.com/downloads/win), dùng để clone/cập nhật repository                                                                                                 |
| Node.js + npm   | Tải [Node.js 24 LTS](https://nodejs.org/en/download); npm đi kèm Node.js. Project yêu cầu tối thiểu Node.js 22.12                                                                          |
| Docker Desktop  | Cài theo [hướng dẫn Windows chính thức](https://docs.docker.com/desktop/setup/install/windows-install/); dùng **Linux containers**, thiết lập WSL 2/virtualization theo yêu cầu của Docker |
| Trình soạn thảo | Notepad có sẵn hoặc [VS Code](https://code.visualstudio.com/), không bắt buộc dùng IDE cụ thể                                                                                              |

Không cần cài PostgreSQL trực tiếp trên Windows và chưa cần cài Arduino IDE/PlatformIO.

Sau khi cài, mở **terminal mới** để nhận PATH rồi kiểm tra:

```powershell
git --version
node --version
npm --version
docker --version
docker compose version
```

Nếu báo không nhận diện lệnh, kiểm tra cài đặt/PATH trước khi tiếp tục. Nếu PowerShell chặn `npm.ps1`, dùng `npm.cmd` thay `npm`, `npx.cmd` thay `npx` trong các lệnh bên dưới; không cần tắt chính sách bảo mật toàn máy.

### Cổng mặc định

| Thành phần | Địa chỉ/cổng trên máy tính |
| ---------- | -------------------------- |
| Dashboard  | `http://localhost:5173`    |
| API        | `http://127.0.0.1:4000`    |
| PostgreSQL | `127.0.0.1:15432`          |

PostgreSQL **bên trong container** dùng 5432 nhưng kết nối **từ Windows** phải dùng 15432. Người mới nên giữ các cổng mặc định: Vite proxy hiện trỏ cố định tới API 4000.

## Cài đặt lần đầu trên Windows

> Tất cả lệnh dưới đây chạy từ **thư mục gốc `iot_gas_monitor` có file `package.json`**, trừ lệnh clone/cd. Chạy từng bước, đọc kết quả và xử lý lỗi trước khi sang bước tiếp theo.

### Bước 1 — Lấy mã nguồn

Mở PowerShell tại thư mục muốn lưu project, rồi chạy:

```powershell
git clone https://github.com/DangwKiem/iot_gas_monitor.git
cd iot_gas_monitor
```

Nếu đã có project, chỉ mở terminal tại thư mục đó, không clone lồng thêm một bản. Nếu tải bằng ZIP, giải nén trước rồi mở terminal tại thư mục chứa `package.json`; các lệnh cập nhật bằng Git ở phần sau chỉ áp dụng cho bản clone.

Kiểm tra đang đứng đúng chỗ:

```powershell
Get-Location
Test-Path package.json
```

Lệnh cuối phải trả `True`.

### Bước 2 — Cài thư viện

```powershell
npm ci
```

Chờ lệnh kết thúc thành công. Lần đầu cần Internet để tải dependencies. Dùng `npm ci` để cài đúng versions trong `package-lock.json`; không tự chạy `npm audit fix --force` hoặc nâng major dependencies để xử lý lỗi setup.

### Bước 3 — Tạo file cấu hình `.env`

Chỉ tạo nếu chưa có, tránh ghi đè cấu hình/secrets đang sử dụng:

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
```

Chỉnh các mục bắt buộc:

| Biến                | Điền gì?                                                              |
| ------------------- | --------------------------------------------------------------------- |
| `POSTGRES_USER`     | Giữ `iot` nếu không có nhu cầu đổi                                    |
| `POSTGRES_DB`       | Giữ `iot_monitor`                                                     |
| `POSTGRES_PASSWORD` | Tự chọn mật khẩu DB đủ dài/ngẫu nhiên, không dùng giá trị placeholder |
| `DATABASE_URL`      | Cùng user/password/DB ở trên, host `127.0.0.1`, port `15432`          |
| `ADMIN_EMAIL`       | Email dùng đăng nhập admin đầu tiên; không yêu cầu gửi email xác minh |
| `ADMIN_PASSWORD`    | Mật khẩu admin do bạn tự chọn, **12–128 ký tự**; nên khác mật khẩu DB |

Cấu trúc URL database:

```text
postgresql://<POSTGRES_USER>:<PASSWORD_DA_URL_ENCODE>@127.0.0.1:15432/<POSTGRES_DB>?schema=public
```

**Thay các phần trong `<...>` bằng giá trị của bạn; không để nguyên dấu ngoặc.**

- `POSTGRES_PASSWORD` dùng mật khẩu gốc; phần password trong `DATABASE_URL` phải biểu diễn cùng mật khẩu đó. Nếu chứa ký tự đặc biệt, cần URL-encode, ví dụ `@` → `%40`, `#` → `%23`. Người mới có thể chọn mật khẩu DB ngẫu nhiên dài chỉ gồm chữ/số để không cần encode.
- Giữ `HOST=127.0.0.1`, `PORT=4000`, `WEB_ORIGIN=http://localhost:5173`, `SIM_API_URL=http://127.0.0.1:4000`.
- Ban đầu để trống `SIM_DEVICE_ID`, `SIM_DEVICE_KEY`, `BACKUP_PASSPHRASE`, `RESTORE_DATABASE_URL`; sẽ điền khi cần chức năng tương ứng.
- Giữ `TELEGRAM_ENABLED=false` và token/chat ID trống nếu chưa dùng Telegram. Không bật `true` khi chưa có đủ credentials.
- Lưu đúng tên **`.env`**, không phải `.env.txt`. Có thể kiểm tra bằng `Test-Path .env`.
- `.env` được Git bỏ qua. Không gửi ảnh chụp, copy toàn bộ file lên chat/issue hoặc commit secrets. `.env.example` chỉ là mẫu công khai.

> Nếu đã có database từ lần chạy trước, **không tùy tiện đổi `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`**. Các biến Docker này dùng để khởi tạo volume lần đầu, không tự đổi tài khoản/mật khẩu bên trong DB có sẵn.

### Bước 4 — Mở Docker và khởi động PostgreSQL

1. Mở **Docker Desktop** từ Start Menu.
2. Đợi Docker báo engine đã chạy. Nếu được hỏi, dùng Linux containers.
3. Trong terminal gốc project, kiểm tra:

```powershell
docker version
```

Phải có cả thông tin **Client và Server**. Chỉ thấy Client hoặc lỗi `dockerDesktopLinuxEngine` nghĩa là engine chưa sẵn sàng. Với bản Docker hỗ trợ Desktop CLI, có thể dùng `docker desktop start`; cách mở ứng dụng từ Start Menu vẫn áp dụng được.

Khởi động DB:

```powershell
docker compose up -d --wait postgres
docker compose ps
```

Lần đầu Docker sẽ tải image `postgres:17-alpine`, có thể mất vài phút. Thành công khi service `postgres` ở trạng thái **healthy**, port hiển thị `127.0.0.1:15432->5432/tcp`.

- `-d`: DB chạy nền; đóng terminal không tự tắt container.
- `--wait`: đợi health check trước khi chuyển sang bước tiếp theo.
- Dữ liệu được giữ trong Docker named volume, không mất khi chỉ stop/start container.

**Không tiếp tục nếu DB chưa healthy.** Đây là bước thường bị quên sau khi khởi động lại máy, dẫn tới lỗi 503/P1001.

### Bước 5 — Tạo Prisma Client và áp dụng migration

```powershell
npm run db:generate
npm run db:migrate
```

- `db:generate` tạo Prisma Client từ schema, không tự tạo bảng database.
- `db:migrate` tạo/cập nhật bảng theo migration đã commit, dùng kết nối trong `.env`.
- Bản hiện tại có các migration nền tảng, monitoring, operations và Telegram. Sau khi chạy xong không được còn lỗi kết nối/thiếu bảng.
- Chạy lại `db:migrate` khi DB đã mới nhất là bình thường; không cần reset.

Nếu cần xem trạng thái:

```powershell
node --env-file=.env node_modules/prisma/build/index.js migrate status
```

Kết quả mong đợi là `Database schema is up to date!`.

### Bước 6 — Tạo admin đầu tiên

Đảm bảo `ADMIN_EMAIL`/`ADMIN_PASSWORD` trong `.env` đã điền, rồi chạy:

```powershell
npm run admin:create
```

Thành công sẽ báo `Đã tạo admin`. Sau đó:

1. Lưu mật khẩu đăng nhập ở nơi riêng/an toàn.
2. Mở `.env`, xóa **giá trị** `ADMIN_PASSWORD`, giữ dòng `ADMIN_PASSWORD=`.
3. Không cần chạy bootstrap mỗi lần mở ứng dụng. Admin đã nằm trong PostgreSQL.

Bootstrap **không ghi đè** user/password/role đã có. Nếu báo tài khoản đã tồn tại, dùng mật khẩu hiện tại để đăng nhập; đổi `ADMIN_PASSWORD` rồi chạy lại không phải cách reset mật khẩu. Khi đã đăng nhập, có thể đổi mật khẩu tại **Cài đặt** hoặc nhờ admin khác đặt lại tại **Tài khoản**.

### Bước 7 — Chạy backend và frontend

Trong **terminal 1**, tại gốc project:

```powershell
npm run dev
```

Giữ terminal này mở. Lệnh chạy cả API và Vite; thường thấy log `[api]` và `[web]`. Đợi API báo sẵn sàng và Vite hiện URL cổng 5173.

Mở **http://localhost:5173** trên trình duyệt, đăng nhập bằng tài khoản ở bước 6. Lúc chưa có thiết bị/dữ liệu, dashboard trống là đúng, hệ thống không tự tạo số đo giả.

Có thể mở các URL sau để kiểm tra hoặc chạy trong terminal khác:

```powershell
curl.exe --silent --show-error http://127.0.0.1:4000/health/live
curl.exe --silent --show-error http://127.0.0.1:4000/health/ready
```

- `live` trả `data.status = "ok"`: tiến trình API đang chạy.
- `ready` trả `data.status = "ready"` và HTTP 200: API truy cập được PostgreSQL.
- `live` thành công **không thay thế** việc kiểm tra `ready`.
- OpenAPI: http://127.0.0.1:4000/openapi.json.

Các URL API không phải trang đăng nhập dashboard. Vite tự proxy `/api` và `/socket.io` tới backend, không cần sửa code frontend để chạy mặc định.

### Checklist hoàn thành cài đặt cơ bản

- [ ] `docker compose ps` cho thấy PostgreSQL healthy.
- [ ] Migration đã chạy, không còn lỗi thiếu bảng.
- [ ] Tạo được admin và đăng nhập được tại `http://localhost:5173`.
- [ ] `/health/ready` trả 200.
- [ ] Terminal `npm run dev` vẫn đang mở.

## Tạo thiết bị và chạy simulator

### 1. Đăng ký thiết bị mô phỏng

Trên dashboard, dùng tài khoản admin:

1. Vào **Thiết bị**.
2. Nhập tên, ví dụ `Simulator phòng 301`.
3. Chọn nguồn **Simulator — dữ liệu mô phỏng**.
4. Nhấn **Thêm thiết bị**.
5. Tại dòng vừa tạo, nhấn **Cấp key**.
6. Copy **Device ID** và **toàn bộ key** đang hiển thị.

Key có dạng `<key_id>.<secret>`; `key_id` riêng lẻ không đủ để simulator xác thực. Secret chỉ hiển thị một lần. Nếu đã đóng mà chưa lưu, cấp key mới và thu hồi key cũ không sử dụng; không thể xem lại secret từ DB.

### 2. Điền cấu hình simulator

Mở `.env`, chỉ cập nhật hai dòng:

```dotenv
SIM_DEVICE_ID=<device-id-vua-tao>
SIM_DEVICE_KEY=<toan-bo-key-vua-cap>
```

Thay placeholder bằng giá trị thật, lưu file. Không dùng key của **Thiết bị thật** để chạy simulator; source do server quản lý, không đổi nhãn sau khi tạo.

### 3. Chạy trong terminal riêng

Mở **terminal 2**, cũng tại thư mục gốc project:

```powershell
npm run simulate
```

Giữ terminal này mở. Khi thành công sẽ thấy `Đã nhận mẫu mô phỏng seq=...`. Đây là HTTP ACK từ backend, không phải dữ liệu được tự nhét vào browser.

Quay lại **Tổng quan** hoặc **Giám sát trực tiếp**, chọn đúng thiết bị. Bạn sẽ thấy nhãn mô phỏng, nhiệt độ/độ ẩm và ADC thô. Realtime kết nối giúp tự cập nhật, REST polling hỗ trợ lấy lại dữ liệu khi mất realtime.

### Chu kỳ gửi và dừng simulator

- Mặc định gửi khoảng 5 giây/mẫu. Simulator tự tải cấu hình từ API, kiểm tra hash và gửi ACK.
- Đổi tại **Thiết bị → bấm tên thiết bị → Cấu hình thiết bị → Chu kỳ gửi (giây)**, giới hạn 1–60 giây.
- `Mong muốn: v...` là cấu hình đã lưu trên server; `Đã áp dụng: v...` là phiên bản thiết bị/simulator đã ACK. Không coi lưu trên web là đã áp dụng ngay.
- `SIM_INTERVAL_MS` chỉ là giá trị dự phòng trước khi đồng bộ, không ghi đè cấu hình server đã tải thành công.
- Dừng simulator bằng `Ctrl+C`. Trạng thái offline xuất hiện sau `max(30 giây, 3 × chu kỳ đã áp dụng)`, cộng tối đa khoảng 5 giây phát hiện khi server chạy.
- Online chỉ nói thiết bị có liên lạc, không bảo đảm mọi cảm biến hợp lệ hoặc dữ liệu còn mới.

Chế độ mặc định giữ Gas/CO `not_configured`, không tự tạo cảnh báo và không phát tiếng còi thật.

## Thử cảnh báo nguy hiểm

Dừng simulator đang chạy bằng `Ctrl+C`, sau đó chạy:

```powershell
npm run simulate -- --scenario danger
```

Không chạy hai simulator cùng lúc với cùng Device ID khi làm bài thử đơn giản này.

| Pha lặp 10 mẫu | Trạng thái mô phỏng                        |
| -------------- | ------------------------------------------ |
| Mẫu 1–2        | Bình thường                                |
| Mẫu 3–6        | Gas/CO/Flame active, lệnh còi mô phỏng bật |
| Mẫu 7–10       | Phục hồi, lệnh còi mô phỏng tắt            |

Với chu kỳ 5 giây, cảnh báo đầu tiên xuất hiện sau khoảng 10 giây và pha active kéo dài khoảng 20 giây. Nếu đổi chu kỳ truyền, thời gian pha cũng thay đổi.

- Mở **Cảnh báo & sự cố** để thấy ba incident mỗi vòng, xem chi tiết/timeline.
- Snapshot hiện gán **Gas/CO = warning**, **Flame = critical**. Không có ngưỡng ADC cao hơn để tự nâng Gas/CO lên critical; API event có thể mang mức critical theo contract.
- Admin/operator có thể **Xác nhận đã xem**. Đây không phải lệnh tắt còi hoặc kết thúc incident.
- Đây là kịch bản lập trình sẵn, không dựa trên nồng độ đo thật. Gas vẫn `uncalibrated`, `concentration_ppm=null`, heater MQ-7 `unverified`; không có lệnh tới còi vật lý.
- Nếu dừng trong pha active, incident có thể còn chưa kết thúc. Offline hoặc chuyển về chế độ Gas/CO `not_configured` không tự đóng nó; cần nhận trạng thái normal hợp lệ. Chạy lại kịch bản danger sẽ có pha normal đầu vòng.

## Cấu hình Telegram

Phần này **không bắt buộc** để dùng dashboard/simulator. Backend phải chạy, có Internet và truy cập được Telegram API. Không cần mở port inbound hoặc triển khai cloud cho bot gửi tin.

### Bước 1 — Tạo bot và mở cuộc chat

1. Mở Telegram, tìm bot chính thức **@BotFather**.
2. Gửi `/newbot`, làm theo hướng dẫn đặt tên/username và lưu token được cấp.
3. Mở bot vừa tạo, nhấn **Start** hoặc gửi `/start`.

Token là mật khẩu điều khiển bot. Không commit, gửi vào chat này, chụp màn hình công khai hoặc dùng token mẫu trong code. Nếu lộ token, thu hồi/tạo lại qua BotFather rồi cập nhật `.env`.

### Bước 2 — Lấy `chat_id`

`chat_id` là **ID cuộc trò chuyện nhận cảnh báo**, không phải ID của bot.

Sau khi nhắn bot, trên máy cá nhân mở URL sau, thay placeholder bằng token thật:

```text
https://api.telegram.org/bot<TOKEN_CUA_BAN>/getUpdates
```

URL chứa token; ưu tiên cửa sổ riêng tư để hạn chế lưu lịch sử, không chia sẻ URL/ảnh chụp thanh địa chỉ. Trong JSON, tìm phần `message.chat`:

```json
{
  "chat": {
    "id": 123456789,
    "type": "private"
  }
}
```

Số trên chỉ minh họa. Copy **ID trong kết quả của bạn**.

- Nếu `"result": []`: nhắn lại `/start` hoặc một tin cho bot rồi tải lại URL.
- Nếu muốn gửi vào nhóm: thêm bot, cho phép gửi tin, gửi `/start@TenBot` trong nhóm rồi xem `message.chat` của nhóm. ID nhóm/supergroup thường âm, cần giữ dấu `-`.
- Nếu bot đã có webhook và `getUpdates` báo conflict, không tự gỡ webhook của ứng dụng khác. Dùng bot riêng cho project hoặc xử lý với người đang quản lý bot đó.
- Channel cần bot có quyền admin; chat ID cấu hình hiện yêu cầu dạng số, không dùng username `@...`.

### Bước 3 — Điền `.env` và khởi động lại backend

```dotenv
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=<token-cua-ban>
TELEGRAM_CHAT_ID=<chat-id-dang-so>
TELEGRAM_INCLUDE_SIMULATORS=true
```

Thay các placeholder, lưu file. Đặt `TELEGRAM_INCLUDE_SIMULATORS=true` để nhận cảnh báo giả lập; đặt `false` nếu chỉ muốn nhận từ nguồn phần cứng.

Trong terminal 1, dừng `npm run dev` bằng `Ctrl+C` và chạy lại:

```powershell
npm run dev
```

Vào log `[api]`, dòng `notification_config` cho biết tính năng có bật và có nhận simulator hay không, không in token/chat ID. Nếu bật Telegram mà token/chat ID thiếu/sai định dạng, API sẽ từ chối khởi động thay vì giả vờ đã cấu hình.

### Bước 4 — Thử nhận tin

Trong terminal 2, chạy mới kịch bản:

```powershell
npm run simulate -- --scenario danger
```

Đến pha active, bot có thể gửi hai warning Gas/CO và một critical Flame, có nhãn **MÔ PHỎNG**. Worker gửi tuần tự nên các tin không nhất thiết tới cùng lúc. Đây không phải còi hoặc lệnh điều khiển phần cứng.

**Cách gửi hiện tại:**

- Chỉ gửi tới **một `TELEGRAM_CHAT_ID` đã cấu hình**. Người khác `/start` bot không tự được đăng ký nhận. Nếu dùng ID nhóm, các thành viên nhóm có thể xem tin.
- Tạo job theo incident/mức độ mới hoặc khi backend ghi nhận nâng mức; không gửi mỗi sample, không gửi riêng khi acknowledge/phục hồi. Mỗi vòng danger tạo các incident mới nên vẫn có thể gửi lại mỗi vòng.
- Không tự gửi bù mọi incident đã xảy ra khi tính năng tắt. Để thử, tạo sự cố mới sau khi cấu hình.
- Outbox nằm trong PostgreSQL; worker gửi sau commit, có retry/lease/TTL. Lỗi Telegram không chặn telemetry ACK hoặc tắt cảnh báo.
- Telegram phụ thuộc mạng, có thể giao trùng nếu mất ACK hoặc crash sau khi Telegram đã nhận; không cam kết exactly-once và không thay thế cảnh báo cục bộ.

Chi tiết mã lỗi, retry và trạng thái DB tại [runbook Telegram](docs/operations/local-runbook.md#telegram-warningcritical).

## Sử dụng dashboard

### Phân quyền

| Quyền      | Thao tác chính                                                           |
| ---------- | ------------------------------------------------------------------------ |
| `viewer`   | Đọc dữ liệu, lịch sử, analytics; quản lý email/mật khẩu của mình         |
| `operator` | Như viewer, thêm quyền xác nhận đã xem sự cố                             |
| `admin`    | Thêm quản trị tài khoản, thiết bị, key, cấu hình và đọc nhật ký quản trị |

Các tài khoản hiện thuộc cùng một nhóm đọc thiết bị; chưa có phân quyền riêng từng thiết bị.

### Các màn hình

- **Tổng quan:** số thiết bị, kết nối, incident chưa kết thúc và sensor của thiết bị đang chọn.
- **Giám sát trực tiếp:** snapshot/quality/freshness và chart nhiệt độ/độ ẩm từ tối đa 120 mẫu gần nhận nhất. Dữ liệu lỗi hiển thị thiếu, không giả thành số 0.
- **Cảnh báo & sự cố:** lọc nguồn/điều kiện/mức độ/trạng thái/xác nhận/thời gian; mở chi tiết xem timeline, người/thời điểm xác nhận. Chưa kết thúc không khẳng định nguy hiểm vẫn đang xảy ra khi nguồn đã offline.
- **Analytics & lịch sử:** chọn thiết bị, khoảng giờ, time basis, metric, bucket, so sánh kỳ trước và xuất CSV.
- **Thiết bị → tên thiết bị:** metadata/vị trí/mô tả, key, config versions/ACK, lịch sử kết nối, lưu trữ/khôi phục. Lưu trữ giữ dữ liệu nhưng chặn device transport; khôi phục chỉ cho key còn hiệu lực hoạt động lại.
- **Tài khoản / Nhật ký quản trị:** chỉ admin. Đổi role/khóa/reset password thu hồi các session/socket liên quan; không tự khóa/hạ quyền tài khoản đang dùng hoặc làm mất admin cuối cùng.
- **Cài đặt:** theme, đổi email/mật khẩu bằng mật khẩu hiện tại. Sau khi đổi email/mật khẩu phải đăng nhập lại; không có nút web tắt còi.

### Đọc biểu đồ analytics và dùng CSV

- **Bucket** là khoảng gom mẫu 1 phút/1 giờ/1 ngày UTC, không phải một mẫu sensor. Mỗi điểm chứa Average/Min/Max của các mẫu đủ điều kiện trong khoảng đó.
- Chỉ có một bucket có dữ liệu thì có thể chỉ thấy một chấm; Min/Max/Average gần nhau có thể chồng lên nhau. Chọn **1 phút** và nhấn **Áp dụng bộ lọc** để nhìn rõ hơn.
- Chọn từ/đến bao gồm thời điểm simulator đang gửi. Khi xem lâu, cập nhật mốc **Đến** rồi áp dụng; tải lại dữ liệu không tự kéo dài khoảng giờ đã chọn.
- Khoảng lọc là `[từ, đến)`, tối đa 90 ngày/request; UI nhập giờ local rồi đổi UTC. `sampled` dựa trên thời điểm đo đã đồng bộ, `received` dựa trên lúc server nhận. Mẫu chưa đồng bộ giờ không xuất hiện trong lọc sampled.
- **Lọc độ phân giải ADC (bit)** chỉ lọc dữ liệu lịch sử MQ-2/MQ-7, không cấu hình ADC ESP32. Simulator dùng **12 bit** (0–4095). Để trống để tự kiểm tra; dữ liệu nhiều độ phân giải không được gộp, khi đó chọn bit cụ thể.
- Invalid/warming_up/heating không được tính như số đo hợp lệ. ADC `uncalibrated` chỉ cho phép xem thống kê tín hiệu thô, không biến thành PPM/AQI. Bucket thiếu mẫu là gap, không phải 0.
- CSV xuất mọi sensor theo bộ lọc thời gian, không chỉ metric đang chọn; giới hạn 100.000 dòng. Nếu báo quá lớn, thu hẹp khoảng. Nếu raw đã được tổng hợp/xóa theo retention, CSV có thể bị từ chối thay vì xuất thiếu; dùng analytics hoặc chọn khoảng raw còn lưu.

### Đăng nhập và giữ phiên

Phiên dùng cookie HttpOnly, host-only, SameSite=Lax, thời hạn 8 giờ; refresh không cần đăng nhập lại khi còn hiệu lực. Browser không lưu token/password vào localStorage.

Nên dùng nhất quán **`http://localhost:5173`**. `localhost` và `127.0.0.1` có cookie riêng; chuyển hostname có thể phải đăng nhập lại. Cookie Secure bật trên HTTPS/production; hướng dẫn này chạy HTTP local nên không tự đặt `NODE_ENV=production` để khởi động demo.

## Chạy lại hằng ngày và dừng hệ thống

### Sau khi tắt/mở lại máy

Không cần tạo lại admin, thiết bị hoặc key, cũng không cần copy lại `.env`.

1. Mở Docker Desktop, đợi engine chạy.
2. Tại gốc project:

   ```powershell
   docker compose up -d --wait postgres
   docker compose ps
   ```

3. Terminal 1:

   ```powershell
   npm run dev
   ```

4. Terminal 2, nếu muốn tạo dữ liệu:

   ```powershell
   npm run simulate
   ```

   Hoặc dùng `npm run simulate -- --scenario danger` để thử cảnh báo.

5. Mở `http://localhost:5173`. Nếu lỗi, kiểm tra `/health/ready` trước.

### Dừng mà không mất dữ liệu

1. `Ctrl+C` tại terminal simulator.
2. `Ctrl+C` tại terminal `npm run dev`; chấp nhận kết thúc batch nếu terminal Windows hỏi.
3. Có thể dừng DB để giải phóng tài nguyên:

   ```powershell
   docker compose stop postgres
   ```

> **Không dùng `docker compose down -v`, `prisma migrate reset`, xóa Docker volume hoặc xóa DB để “sửa lỗi kết nối”.** Những thao tác đó có thể làm mất dữ liệu. Stop/start container không cần xóa volume. Đổi tên thư mục/project Compose có thể khiến bạn nhìn thấy một volume khác; DB trống mới không nhất thiết nghĩa là volume cũ đã bị xóa.

## Cập nhật mã nguồn mà giữ dữ liệu

Dừng backend/simulator; backup trước nếu DB có dữ liệu quan trọng. Với bản clone Git và working tree không có thay đổi chưa xử lý:

```powershell
git pull --ff-only
npm ci
npm run db:generate
docker compose up -d --wait postgres
npm run db:migrate
npm run dev
```

- Nếu `git pull --ff-only` báo conflict/diverged hoặc có sửa local, dừng lại để kiểm tra; không dùng `git reset --hard` để bỏ qua.
- So sánh `.env.example` sau cập nhật và **bổ sung những dòng mới** vào `.env` hiện tại; không copy đè toàn bộ `.env`.
- Không chạy lại `admin:create` nếu đã có tài khoản. Device ID/key và dữ liệu vẫn nằm trong DB hiện tại.
- `db:generate` và `db:migrate` là hai việc khác nhau; chỉ generate sẽ không tạo bảng mới, ví dụ `telegram_notifications`.

## Backup, restore và retention

Không cần làm phần này để demo lần đầu, nhưng nên backup trước migration hoặc thay đổi dữ liệu quan trọng. Docker cần chạy; các công cụ dùng PostgreSQL 17 trong container tạm, không cần cài `pg_dump` trên Windows.

### Backup mã hóa

1. Điền `BACKUP_PASSPHRASE` trong `.env` hoặc environment, tối thiểu **20 ký tự** đủ ngẫu nhiên. Lưu passphrase ở nơi riêng với file backup; mất passphrase sẽ không giải mã được.
2. Tại gốc project:

   ```powershell
   New-Item -ItemType Directory -Force backups
   $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
   $backupFile = "backups/local-$stamp.backup.enc"
   npm run db:backup -- --file "$backupFile"
   ```

3. Chỉ coi thành công khi lệnh báo đã tạo backup và kết thúc không lỗi. Copy bản mã hóa tới nơi lưu riêng; không commit backup hoặc passphrase. Công cụ không ghi đè file cũ.

Backup stream mã hóa AES-256-GCM, không phải CSV. Hiện chưa tự cài scheduler hoặc xoay vòng bản sao; người vận hành phải chủ động lên lịch và thử restore.

### Restore vào DB riêng để kiểm tra

**Không restore đè DB đang dùng.** Công cụ yêu cầu target trống và khác DB nguồn.

1. Nếu giữ user mặc định `iot`, có thể tạo một DB thử mới trong container:

   ```powershell
   docker compose exec postgres createdb -U iot iot_restore_check
   ```

   Nếu đã đổi `POSTGRES_USER`, thay `iot` bằng user đó. Nếu DB tên này đã tồn tại, không xóa nó tùy tiện; chọn một tên DB thử mới khác.

2. Điền `RESTORE_DATABASE_URL` với cùng host/port/credentials phù hợp nhưng DB target là tên vừa tạo. **Giữ `DATABASE_URL` trỏ DB nguồn**, không đổi ứng dụng sang bản restore trong bước thử.
3. Với passphrase đúng, chạy bằng tên file backup thực tế:

   ```powershell
   npm run db:restore -- --file "backups/<TEN_FILE_DA_TAO>.backup.enc"
   ```

4. Kiểm tra schema/dữ liệu/chức năng trên DB target riêng trước khi tính đến chuyển kết nối. Web sessions khôi phục bị thu hồi; pending Telegram jobs khôi phục bị chặn để tránh phát lại tin cũ. Rà soát lại key thiết bị đã từng revoke sau thời điểm backup nếu phục hồi cho sự cố thật.

Quy trình vận hành đầy đủ và các lưu ý RPO/RTO: [local runbook](docs/operations/local-runbook.md).

### Retention/rollup — mặc định không xóa

Xem trước:

```powershell
npm run db:maintenance
```

Kết quả có `dry_run: true`, số raw/audit/status đủ điều kiện; không xóa dữ liệu. Chỉ khi đã xem báo cáo, có backup cùng DB hợp lệ trong 24 giờ và chấp nhận xóa raw cũ mới dùng `--apply` theo [runbook](docs/operations/local-runbook.md#retention-và-rollup).

Chính sách khi apply: raw 14 ngày (giữ bản ghi latest), rollup phút 90 ngày/giờ 365 ngày, audit 180 ngày, status 365 ngày. Raw chỉ xóa cùng transaction đã tạo rollup; incident/event/ack vẫn giữ. **Rollup không phải backup và không khôi phục được từng mẫu raw.**

## Kiểm thử và CI

Không bắt buộc chạy toàn bộ tests để mở demo, nhưng nên chạy khi sửa code hoặc chuẩn bị bàn giao.

| Lệnh                              | Yêu cầu và mục đích                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `npm test`                        | Unit/contract/frontend; skip suites cần DB/browser/load nếu không có `TEST_DATABASE_URL`       |
| `npm run test:integration`        | Docker đang chạy; PostgreSQL test riêng, API/Socket, outbox, retention, backup/restore drill   |
| `npx playwright install chromium` | Cài Chromium cho tests; chỉ cần lần đầu hoặc khi Playwright yêu cầu cập nhật                   |
| `npm run test:e2e`                | Docker + Chromium; browser thật kiểm tra các luồng dashboard/quyền/session                     |
| `npm run test:load`               | Docker + Chromium; mặc định 60 giây, 10 simulator và 5 trang browser; report JSON ở `reports/` |
| `npm run typecheck`               | Kiểm tra TypeScript                                                                            |
| `npm run lint`                    | Kiểm tra ESLint                                                                                |
| `npm run build`                   | Typecheck và build frontend, không phải lệnh khởi chạy toàn bộ hệ thống production             |
| `npm run format:check`            | Kiểm tra định dạng; `npm run format` sẽ sửa định dạng file                                     |
| `npm audit`                       | Kiểm tra cảnh báo dependency tại thời điểm chạy                                                |

Runner DB/browser/load tự tạo và xóa đúng container PostgreSQL test của mình, không dùng DB development trong `.env`. Để tái chạy theo cấu hình chuẩn, không tự đặt `TEST_DATABASE_URL` trỏ vào DB có dữ liệu quan trọng. `skip` không phải `pass`.

**Bằng chứng đã ghi trong repo:** 39 unit/contract/frontend/config tests pass, 80 integration tests pass, 3 E2E pass và load smoke 60 giây nhận 120/120 mẫu. Đây là kết quả các lần xác minh đã ghi, không phải tuyên bố mọi máy đều có cùng hiệu năng hoặc README vừa chạy lại toàn bộ tests. Telegram transport tests dùng phản hồi giả lập, chưa thay thế kiểm tra giao tin tới bot thật. Xem [trạng thái kiểm thử](docs/testing/status.md).

Chưa nghiệm thu đủ tải 30 phút, telemetry 60 phút, ≥1.000 UI updates và soak 24 giờ. Cách chạy bài dài tại [runbook](docs/operations/local-runbook.md#ci-và-kiểm-thử-nghiệm-thu).

Workflow [GitHub Actions](https://github.com/DangwKiem/iot_gas_monitor/actions) nằm ở `.github/workflows/ci.yml`: checks, integration, E2E, load smoke và audit; **không deploy cloud**. Kiểm tra kết quả của commit hiện tại ở tab Actions, không suy rằng push thành công đồng nghĩa CI xanh.

## Xử lý lỗi thường gặp

### 1. `dockerDesktopLinuxEngine`, không kết nối được Docker daemon

Docker Desktop chưa mở/chưa khởi động xong hoặc đang dùng sai engine. Mở Docker Desktop, dùng Linux containers, chờ engine chạy rồi kiểm tra:

```powershell
docker version
docker compose up -d --wait postgres
docker compose ps
```

Nếu Docker yêu cầu WSL/virtualization/restart Windows, làm theo hướng dẫn chính thức. Không xóa volume để xử lý lỗi daemon.

### 2. `SERVICE_UNAVAILABLE`, HTTP 503, `P1001` hoặc simulator retry liên tục

`SERVICE_UNAVAILABLE` là lỗi tổng quát, không tự chứng minh là lỗi key hay Telegram. Kiểm tra theo thứ tự:

1. Docker Engine có chạy không?
2. `docker compose ps` có service PostgreSQL healthy không?
3. `.env` dùng đúng DB host `127.0.0.1`/port `15432` không?
4. Backend `npm run dev` còn chạy không? `/health/ready` trả gì?
5. Migration đã áp dụng và Prisma Client đã generate chưa?

Nếu DB chỉ đang tắt:

```powershell
docker compose up -d --wait postgres
```

Sau khi DB healthy, khởi động lại backend nếu đã dừng, kiểm tra `ready`, rồi chạy simulator. Dòng `Chưa đồng bộ được cấu hình; giữ chu kỳ hiện tại...` có thể đi cùng lỗi API/DB, không nhất thiết do cấu hình chu kỳ sai. Không đổi key hoặc xóa DB trước khi biết nguyên nhân.

### 3. `P2021`, `relation ... does not exist`, thiếu bảng mới

Dừng API/simulator, giữ nguyên DB rồi chạy:

```powershell
npm run db:generate
npm run db:migrate
```

Mở lại `npm run dev`. Nếu vẫn lỗi, kiểm tra migration status và DB URL có trỏ nhầm database không; không dùng reset để che lỗi.

### 4. Password authentication failed / `P1000`

Kiểm tra password gốc trong `POSTGRES_PASSWORD` và password URL-encoded trong `DATABASE_URL` có khớp DB đang tồn tại không. Sửa `.env` không tự đổi password của volume PostgreSQL đã khởi tạo. Nếu mới đổi `.env` sau khi đã có dữ liệu, dùng lại credentials cũ hoặc thực hiện đổi password bằng quyền quản trị DB có kiểm soát; không xóa volume để lấy lại quyền truy cập.

### 5. `.env` không tìm thấy, thiếu `DATABASE_URL`, Zod validation hoặc Node không nhận `--env-file`

- Đứng tại thư mục gốc và chạy `Test-Path .env`; kiểm tra không lưu nhầm `.env.txt`.
- Chỉ copy `.env.example` nếu chưa có `.env`; thay các placeholder bắt buộc.
- Kiểm tra `node --version`, ưu tiên Node.js 24 LTS, mở lại terminal sau khi cài.
- Khi chưa dùng Telegram, giữ `TELEGRAM_ENABLED=false`; không điền `yes`, `1` hoặc bật true mà thiếu token/chat ID.
- Sau khi sửa `.env`, khởi động lại tiến trình đọc các biến đó. Biến environment đã đặt sẵn trong terminal có thể ghi đè `.env`; mở terminal mới nếu cấu hình thực tế khác file.

### 6. Cổng 4000/5173/15432 bị chiếm, `EADDRINUSE`

Có thể đang mở một bản server/DB khác. Đóng bản do bạn khởi chạy bằng `Ctrl+C` hoặc kiểm tra ứng dụng đang giữ port; không tắt tiến trình không xác định. Giữ cổng mặc định nếu có thể. Nếu đổi API port, phải đồng bộ cả `.env`, `SIM_API_URL` và Vite proxy trong `apps/web/vite.config.ts`; chỉ đổi một chỗ sẽ làm dashboard không truy cập API.

### 7. Simulator HTTP 401/403/409/422

| Mã  | Kiểm tra                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 401 | Key có đầy đủ `<key_id>.<secret>`, đúng `.env`, chưa revoke/hết hạn không?                                                                                   |
| 403 | Device ID có thuộc key đó không, thiết bị có đang lưu trữ không?                                                                                             |
| 409 | Boot/sequence/incident identity conflict; không chạy hai simulator cùng Device ID, dừng bản cũ trước khi mở bản mới                                          |
| 422 | Payload/time không hợp lệ; kiểm tra đồng hồ máy tính. Sau mất mạng quá lâu, mẫu cũ có thể vượt cửa sổ nhận 24 giờ; dừng và chạy mới simulator để lấy mẫu mới |

Nếu cấp/đổi key, lưu lại `.env` và chạy mới simulator. Khi nghi key lộ, thu hồi ngay và cấp key mới; không gửi key lên chat để nhờ kiểm tra.

### 8. Dashboard trống, chart chỉ có một chấm hoặc không tự cập nhật

Không có simulator chạy thì không có mẫu mới. Kiểm tra log `Đã nhận mẫu...`, thiết bị đang chọn và nhãn source. Với analytics, chọn khoảng giờ chứa dữ liệu, bucket **1 phút**, nhấn **Áp dụng bộ lọc**. Một điểm có thể đơn giản là chỉ một bucket có mẫu; không suy rằng cảm biến hỏng. Kiểm tra badge realtime và `/health/ready` nếu cả dữ liệu mới nhất cũng không cập nhật.

### 9. Đăng nhập lại sau refresh/đổi địa chỉ

Dùng nhất quán `http://localhost:5173`, không chuyển qua lại hostname. Phiên hết 8 giờ, logout, khóa user, đổi quyền/email/password đều có thể yêu cầu đăng nhập lại. Không đặt production/Secure cookie trên HTTP local; không xử lý bằng cách lưu token vào localStorage.

### 10. Telegram không gửi

- Backend có chạy và Internet có truy cập được Telegram không?
- Bot đã được `/start`, đúng numeric `chat_id`, có quyền gửi vào nhóm chưa?
- Đã bật `TELEGRAM_ENABLED=true` và restart API chưa?
- Nếu thử simulator, đã bật `TELEGRAM_INCLUDE_SIMULATORS=true` chưa?
- Có incident mới sau khi bật không? Bình thường/unknown/not_configured không tạo notification; acknowledge không tự gửi tin.
- Kiểm tra log `notification_config` và `telegram_delivery`: 400 thường liên quan chat/request, 401 token, 403 quyền/bot bị chặn, 429 là giới hạn tốc độ.

Worker có backoff, không phải mọi tin đều tới ngay. Sửa cấu hình/quyền rồi tạo sự cố thử mới; không công khai log/URL chứa token. Chi tiết hàng đợi và truy vấn chẩn đoán tại [runbook](docs/operations/local-runbook.md#telegram-warningcritical).

## Cấu trúc project và tài liệu kỹ thuật

```text
apps/api/              REST API, auth/RBAC, telemetry, incidents, Telegram worker, Socket.IO
apps/web/              React/Vite/Tailwind dashboard tiếng Việt
packages/contracts/    Zod schemas và shared types
packages/database/     Prisma schema, migrations, database client
tools/device-simulator/ Nguồn dữ liệu mô phỏng
tools/operations/      Backup/restore mã hóa và maintenance CLI
tests/e2e/             Chromium E2E
tests/performance/     Load/soak runner
tests/run-integration.ts PostgreSQL test runner biệt lập
.github/workflows/     CI checks, không deploy
docs/                  API, quyết định kiến trúc, runbook và bằng chứng kiểm thử
```

Stack frontend: React, Vite, Tailwind, Recharts, TanStack Query. Backend: Node.js/TypeScript, Express, Socket.IO, Zod, Prisma/PostgreSQL. Backend mặc định bind loopback; chưa tự mở cho ESP32 hoặc máy khác trong LAN truy cập. HTTP hiện chỉ dùng cho local, không phải cấu hình production.

### Contract cho bước tích hợp firmware sau này

- Endpoint telemetry: `POST /api/v1/device/telemetry`, JSON, header `Authorization: DeviceKey <key_id>.<secret>`.
- 1–20 readings/batch, tối đa 64 KiB; `device_id + boot_id + seq` là identity, counter/uptime truyền chuỗi số. Retry phải giữ nội dung record, ACK chỉ sau commit.
- Mẫu lỗi gửi null kèm quality, không NaN/giả zero. ADC có adc_bits/adc_pin_mv; gas `concentration_ppm` bắt buộc null. Mẫu UTC hợp lệ nhận trong cửa sổ 24 giờ, cho phép tương lai tối đa 60 giây.
- Schemas thực thi ở `packages/contracts/src/`; fixture thử nghiệm ở `packages/contracts/tests/fixture.ts`. Event/heartbeat/config/ACK và các quy tắc khác có trong [API/workflow](docs/api/monitoring.md).
- Chưa có firmware/hardware release hoặc sơ đồ GPIO được nghiệm thu. Cần xác minh nguồn/điện áp tín hiệu, heater MQ-7, calibration và policy cảnh báo trước khi dùng phần cứng thật; không lấy cấu hình simulator làm ngưỡng an toàn.

Tài liệu đọc thêm:

- [PLAN.md](PLAN.md): roadmap, acceptance criteria và các phần còn lại.
- [Quyết định triển khai](docs/architecture/decisions.md): auth, ordering, giới hạn và Telegram.
- [API/workflow](docs/api/monitoring.md): endpoints, schemas và semantics.
- [Local runbook](docs/operations/local-runbook.md): backup/restore, maintenance, tải dài hạn và chẩn đoán.
- [Trạng thái kiểm thử](docs/testing/status.md): bằng chứng đã chạy và kiểm thử chưa hoàn thành.

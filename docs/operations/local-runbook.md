# Vận hành phần mềm local v0.3

Firmware ESP32 và kết nối Wi-Fi có hướng dẫn tại [firmware](../../firmware/README.md). Cloud chưa triển khai. Các lệnh chạy tại thư mục gốc repository. Không commit `.env`, NetworkConfig.h, passphrase, key hoặc backup. Docker Desktop Linux Engine phải hoạt động.

## Nâng cấp

1. Dừng API/simulator; backup trước khi migrate DB có dữ liệu quan trọng.
2. `npm ci`, `npm run db:generate`, `npm run db:migrate`.
3. `npm run dev`; dùng nhất quán `http://localhost:5173`.
4. Kiểm tra `/health/ready`, đăng nhập, thiết bị/latest/history, realtime và các trang quản trị.

Migration `202610180003_operations` bổ sung rollup/audit resource, không tự xóa raw hoặc tài khoản. Không chạy `migrate reset`/`docker compose down -v` để nâng cấp.

## Tài khoản và audit

- Admin mở **Tài khoản** để tạo viewer/operator/admin, đổi quyền, khóa/mở khóa, đặt lại mật khẩu. Mật khẩu 12–128 ký tự; email được chuẩn hóa chữ thường. Không có mật khẩu mặc định public.
- Không tự khóa/hạ quyền tài khoản đang dùng; không loại bỏ admin cuối cùng. Không xóa tài khoản để giữ liên kết audit/acknowledgements.
- Trong **Cài đặt**, mọi người được đổi email/mật khẩu bằng mật khẩu hiện tại. Cả hai thao tác thu hồi mọi phiên; đăng nhập lại sau khi đổi.
- Đổi role, active hoặc reset password thu hồi tất cả session/socket của tài khoản mục tiêu. Login và thay đổi mật khẩu được khóa theo user để không tạo phiên mới từ mật khẩu đã bị thay trong lúc request đang chạy.
- **Nhật ký quản trị** chỉ admin, có lọc action/resource và cursor; không lưu mật khẩu/raw key. Khóa user không tắt cảnh báo/còi hay thu hồi key thiết bị.

## Backup mã hóa

Đặt `BACKUP_PASSPHRASE` trong môi trường terminal hoặc `.env` ignored, tối thiểu 20 ký tự đủ ngẫu nhiên. Không đặt passphrase vào tham số lệnh, ảnh chụp hoặc file cùng nơi backup. Nếu mất passphrase sẽ không giải mã được.

```powershell
New-Item -ItemType Directory -Force backups
npm run db:backup -- --file backups/local-20261018.backup.enc
```

- Công cụ dùng PostgreSQL 17 `pg_dump` từ container tạm, truyền credential qua environment, không qua command line và không in stderr chứa connection details.
- Backup là custom-format dump được stream mã hóa AES-256-GCM; scrypt + salt ngẫu nhiên, nonce ngẫu nhiên, header được xác thực. Không tạo file plaintext trên disk.
- Xác minh GCM sau ghi, chỉ công bố file cuối khi pg_dump thành công. Không ghi đè file cũ; file tạm thất bại được dọn theo đúng tên.
- Passphrase không thay thế quyền filesystem: giữ backup trong thư mục riêng, ACL chỉ cho tài khoản quản trị. Copy bản mã hóa ra ổ/điểm lưu riêng để tránh mất cùng ổ DB.
- Đề xuất lịch hàng ngày, giữ tối thiểu 7 bản ngày/4 bản tuần ở nơi riêng. Hiện không cài scheduler OS hoặc tự xóa backup; người vận hành chọn lịch và kiểm tra dung lượng. Mục tiêu RPO ≤24 giờ/RTO ≤4 giờ chỉ được công nhận sau đo drill và vận hành lịch thật.

## Restore drill — không ghi đè database development

Chuẩn bị database PostgreSQL **trống, khác DB nguồn** bằng công cụ quản trị. Điền `RESTORE_DATABASE_URL` trong terminal hoặc `.env` ignored. Tài khoản restore phải có quyền tạo bảng/schema.

```powershell
npm run db:restore -- --file backups/local-20261018.backup.enc
```

Công cụ xác thực toàn bộ backup trước restore, từ chối DB nguồn hoặc target có bảng, chạy pg_restore trong một transaction và không dùng `--clean`. Các session web khôi phục được xóa để cookie cũ không có hiệu lực trở lại. Không tự chuyển app sang target. Sau restore kiểm tra migrations, counts và các chức năng auth/latest/history/incident/config, rồi mới cân nhắc chuyển kết nối có kiểm soát. Backup chứa credential thiết bị dạng hash: nếu phục hồi bản cũ trong sự cố thật, cần rà soát/revoke/cấp lại key từng bị thu hồi sau thời điểm backup.

`npm run test:integration` có drill tự động trong PostgreSQL test: tạo DB target tên ngẫu nhiên riêng, backup mã hóa, restore, kiểm tra fixture/schema/sessions và từ chối restore đè; xóa đúng DB test. Không reset DB development.

## Retention và rollup

Mặc định **không tự chạy purge**. Xem trước:

```powershell
npm run db:maintenance
```

Chỉ khi đã đọc báo cáo và có backup cùng DB mới trong 24 giờ:

```powershell
npm run db:maintenance -- --apply --backup backups/local-20261018.backup.enc --batch-size 1000
```

- Một lần chỉ xử lý tối đa 1–5000 raw rows (mặc định 1000), nhận theo `received_at` cũ hơn 14 ngày. Không xóa bản ghi đang được device.latest tham chiếu dù cũ.
- Chỉ xóa raw trong cùng transaction đã cộng rollup của đúng những row bị xóa. Crash/rollback không mất raw và không double-count. Khóa advisory ngăn hai maintenance workers chạy chồng.
- Tạo rollup 1 phút/1 giờ, tách sampled/received, device, metric và adc_bits. Giữ sum/count để average được tính có trọng số, không lấy trung bình của các trung bình. Invalid/warming_up/heating chỉ tăng total/invalid, không biến thành giá trị 0. Không tạo PPM/AQI hoặc ngưỡng gas.
- Rollup phút giữ 90 ngày, giờ 365 ngày. Audit hết 180 ngày và status hết 365 ngày được dọn theo batch. Incident/event/ack giữ nguyên lâu hơn mức dự kiến tối thiểu 12 tháng; chưa bật tự xóa chứng cứ sự cố. Expired web sessions được dọn.
- Chạy lại theo batch cho tới khi backlog raw hết. Lập lịch maintenance sau backup hàng ngày nếu muốn vận hành dài hạn; không chạy --apply trên DB quan trọng nếu chưa thử restore backup.
- Analytics gộp raw còn lại + rollup của raw đã xóa, không tính đôi. Có `uses_rollups` trong response và nhãn trên UI. Với dữ liệu đã tổng hợp, cần from/to đúng đầu phút/giờ tương ứng; chọn bucket giờ/ngày nếu rollup phút hết hạn. Bộ lọc mỗi request vẫn tối đa 90 ngày.
- History chỉ trả raw còn lưu; không thể phục hồi từng mẫu từ rollup. CSV từ chối khoảng có raw đã được tổng hợp thay vì âm thầm xuất file thiếu. Rollup không phải backup.

## CI và kiểm thử nghiệm thu

Workflow `.github/workflows/ci.yml` chỉ kiểm tra, không deploy: npm ci, generate, format/lint/build, unit, PostgreSQL integration + encrypted restore drill, Chromium E2E, load smoke và audit. Chưa chạy trên GitHub cho tới khi bạn push.

```powershell
npm test
npm run test:integration
npx playwright install chromium
npm run test:e2e
npm run test:load
```

Load smoke mặc định **60 giây**, 10 simulator gửi mỗi 5 giây và **5 trang Chromium thật** kết nối realtime. Tạo DB/container test riêng, không dùng `.env` development. Báo cáo JSON dưới `reports/` (ignored); CI upload report không chứa key/password. Đo HTTP ingestion P95, thời gian request → giá trị xuất hiện trên UI sau 2 vòng warmup, counts và memory Node. Đây là phép đo bảo thủ bao gồm cả HTTP/commit, không phải timestamp DB commit chính xác; không báo thành AC02 đủ 1000 updates nếu chưa đủ số mẫu. Memory report không bao gồm toàn bộ Chromium/PostgreSQL.

Bài 30 phút:

```powershell
$env:LOAD_DURATION_SECONDS='1800'
npm run test:load
Remove-Item Env:LOAD_DURATION_SECONDS
```

Soak 24 giờ hoặc bài 60 phút dùng `LOAD_DURATION_SECONDS=86400` hoặc `3600`. Runner tự làm mới browser cookie mỗi 6 giờ, giữ dữ liệu trong DB test cho tới khi kết thúc. Các bài dài phải chạy đủ thời lượng, kiểm tra report và kiểm tra trend bộ nhớ; smoke 60 giây không thay thế nghiệm thu 30 phút/24 giờ. Giữ máy thức, đủ dung lượng Docker và không tắt Docker/terminal giữa chừng. Ctrl+C có thể cần kiểm tra container `iot-test-*` do phiên đó tạo; không xóa container không xác định.

## Khi có lỗi

- 401: session hết hạn/bị thu hồi hoặc key sai/hết hạn. Đăng nhập lại hoặc cấp key đúng thiết bị.
- 409 config: tải lại phiên bản trước khi lưu; 409 CSV retention: thu hẹp khoảng raw hoặc xem analytics.
- 422 rollup alignment: chỉnh from/to về đầu phút/giờ, không dùng thống kê bucket một phần làm số chính xác.
- 503: kiểm tra Docker/PostgreSQL và `/health/ready`; không retry vô hạn mutation quản trị không có identity.
- Backup/restore thất bại: công cụ không in secrets; kiểm tra Docker/PG version/quyền/file/passphrase. Không bỏ qua kiểm tra GCM và không restore đè để “thử”.

## Telegram warning/critical

### Cấu hình và bật/tắt

- `TELEGRAM_ENABLED=false` mặc định: không tạo outbox mới và không chạy worker. Bật `true` yêu cầu đồng thời bot token hợp lệ và chat ID dạng số, nếu thiếu sẽ chặn khởi động để tránh giả vờ đã cấu hình.
- `TELEGRAM_BOT_TOKEN` từ @BotFather; `TELEGRAM_CHAT_ID` là private chat/group/supergroup/channel ID dạng chuỗi số, group thường âm. Người dùng phải nhắn `/start` trước cho private bot; group/channel phải cho bot quyền gửi tin (channel cần admin).
- Có thể lấy chat ID bằng API chính thức `getUpdates` sau khi nhắn bot. Không in/chia sẻ URL chứa token; nếu bot đã có webhook do ứng dụng khác quản lý, không tự gỡ webhook hoặc dùng chung token tùy tiện. Chỉ gửi token cho backend qua `.env` ignored hoặc biến môi trường.
- `TELEGRAM_INCLUDE_SIMULATORS=false` mặc định; bật `true` để thử `npm run simulate -- --scenario danger`. Tin có nhãn MÔ PHỎNG rõ ràng; không đánh đồng với cảnh báo phần cứng. Tắt include-simulators sẽ đánh dấu pending simulator jobs `skipped`, không gửi bù chúng.
- Khởi động lại API sau khi đổi biến môi trường. Tắt toàn bộ Telegram ngừng gửi nhưng không xóa lịch sử outbox. Khi bật lại, pending chưa hết TTL có thể được gửi; không tự backfill các incident cũ đã xảy ra khi tính năng bị tắt.

### Khi nào gửi

Outbox unique `(incident_id,severity)`: một notification warning và tối đa một critical cho cùng incident. Tạo khi nhận active snapshot mới, started event hoặc backend ghi nhận nâng mức severity. Liên kết snapshot/event cùng incident không nhân tin. Retry telemetry/event không tạo thêm notification. Mỗi sự cố mới sau phục hồi có ID mới nên được gửi lại.

Không tự xét ngưỡng ADC/PPM và không đổi chính sách severity: snapshot Flame critical, Gas/CO warning; event có thể mang critical theo contract hiện tại. Không thêm transition escalation mới vào firmware contract. Không gửi riêng thông báo kết thúc/acknowledgement và không cung cấp lệnh Telegram tắt còi/điều khiển thiết bị.

Tin plain text, không bật HTML/Markdown parse mode hoặc link preview; chứa nguồn, device ID/tên/vị trí, condition, mức được thông báo, incident ID, occurrence/observation UTC. Nếu incident đã kết thúc trước khi worker gửi, tin nói rõ là sự kiện lịch sử, không giả thành nguy hiểm đang diễn ra. Không gửi sensor PPM/AQI suy diễn, raw key, mật khẩu hoặc thông tin tài khoản đăng nhập.

### Độ bền và retry

- Enqueue trong cùng transaction với incident; rollback thì không có notification. HTTP telemetry ACK sau commit, không đợi Telegram.
- Worker chỉ claim outbox đã commit; lease 30 giây, `FOR UPDATE SKIP LOCKED`, lease token bảo vệ cập nhật từ worker cũ. Pending/lease hết hạn có thể tiếp tục sau restart. Một worker xử lý tuần tự, polling 1 giây.
- HTTPS cố định `api.telegram.org`, timeout 10 giây; lỗi mạng/5xx retry exponential từ 5 giây, cap 15 phút, tối đa 8 attempts, TTL notification 6 giờ. 429 tôn trọng retry_after (giới hạn tối đa 24 giờ); worker tạm dừng tương ứng, TTL vẫn có hiệu lực.
- 400/401/403 và lỗi 4xx không transient sẽ `failed`; kiểm tra chat ID, token, `/start`, quyền nhóm/bot bị chặn rồi tạo sự cố thử mới. Không log error gốc, Telegram response description hoặc URL chứa token. Log chỉ có notification ID/status/code.
- Telegram không có idempotency key cho sendMessage. Nếu đã nhận nhưng HTTP ACK bị mất hoặc tiến trình crash trước khi ghi sent, retry có thể gửi trùng. Đây là at-least-once best effort, không phải exactly-once/SLA. Incident ID trong tin giúp đối chiếu.
- Nếu restore backup, pending/sending outbox khôi phục bị đánh dấu `failed`/`RESTORE_REVIEW_REQUIRED` để tránh phát lại hàng loạt thông báo cũ; không tự khôi phục gửi cho các hàng này. Sent history giữ nguyên. Sau restore cần migrate schema còn thiếu trước khi bật worker.

### Chẩn đoán

Log startup `notification_config` cho biết enabled/include_simulators, không lộ credentials. Log `telegram_delivery` có trạng thái hoặc mã lỗi. Các trạng thái DB: pending, sending, sent, failed, expired, skipped. Có thể kiểm tra bằng SQL quản trị read-only:

```sql
SELECT id, incident_id, severity, status, attempts, next_attempt_at,
       sent_at, last_error_code
FROM telegram_notifications
ORDER BY created_at DESC LIMIT 30;
```

Nếu không có hàng: kiểm tra bật tính năng, loại simulator, sự cố có phải mới hay không và transaction có thành công. Nếu pending: kiểm tra backend/Internet và next_attempt_at. 401 thường token sai/hết hiệu lực; 403 bot bị chặn/không có quyền; 400 có thể sai chat ID. Không đăng token hoặc response chứa dữ liệu riêng tư lên issue. Chưa có inbound webhook, bot commands, quản lý nhiều chat hoặc UI cấu hình token; không cần mở port Telegram vào máy local.

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

Outbox unique `(incident_id,severity)`: tối đa một `warning`, một `critical` và một `resolved` cho cùng incident. `resolved` chỉ là mức thông báo Telegram; severity thực tế của incident vẫn là warning/critical. Tạo cùng transaction khi sự cố bắt đầu, tăng mức hoặc kết thúc. Retry snapshot/event và liên kết snapshot/event không nhân tin; acknowledge không gửi tin. Mỗi sự cố mới sau phục hồi có ID riêng.

Tin dùng [Telegram HTML](https://core.telegram.org/bots/api#html-style), escape tên/vị trí và tắt link preview. Tiêu đề thống nhất: 🟠 WARNING — CẢNH BÁO, 🔴 CRITICAL — NGUY HIỂM, ✅ RESOLVED — ĐÃ KẾT THÚC. Nội dung gồm tên thiết bị, nguyên nhân, thời gian `DD/MM/YYYY HH:mm` theo `Asia/Ho_Chi_Minh`, trạng thái; simulator giữ nhãn MÔ PHỎNG. Không hiển thị UUID, server-observed time, UTC ISO, raw key hoặc thông tin tài khoản. Thời điểm xảy ra không xác định thì ghi “Chưa xác định”, không thay bằng thời điểm server nhận. Dữ liệu kỹ thuật vẫn nằm trong incident/event/outbox và log nội bộ.

Worker đọc lại sự cố trước mỗi lần gửi, gồm retry. Nếu đã kết thúc, chỉ gửi bản tóm tắt đã kết thúc; chưa từng gửi thành công thì ghi rõ “thông báo trễ”. Sau khi bản tóm tắt gửi thành công, các job còn chờ cùng sự cố chuyển `skipped`/`COVERED_BY_RESOLVED`. Nếu Warning và Critical cùng chờ khi sự cố còn mở, ưu tiên Critical, rồi đánh dấu Warning `COVERED_BY_CRITICAL` sau thành công. Không gộp job khi gửi thất bại hoặc mất lease. Không xóa các bản ghi để chống trùng.

Tăng mức có dòng “Tăng lên mức nguy hiểm”; nếu đã giảm về Warning trước lúc gửi, tin phản ánh Warning hiện tại và ghi “Đã giảm từ mức nguy hiểm”. Thiết bị mất liên lạc hoặc dữ liệu chưa xác định không được coi là sự cố đã hết; tin ghi “Chưa xác nhận kết thúc”. Critical đang diễn ra từ thiết bị thật giữ hướng dẫn khẩn cấp một dòng; simulator và tin đã kết thúc không yêu cầu sơ tán. Tham khảo [hướng dẫn CO của CDC](https://www.cdc.gov/niosh/carbon-monoxide/about/) cho hành động ra nơi thoáng khí và gọi hỗ trợ y tế/khẩn cấp. Các lưu ý an toàn chi tiết nằm trong tài liệu, không lặp lại trong từng tin.

Không tự xét ngưỡng hoặc suy diễn PPM/AQI; không thay đổi logic đánh giá nguy hiểm, điều khiển còi hoặc luồng Web Push. Không cung cấp lệnh Telegram điều khiển thiết bị. Chạy `npm run db:migrate` trước khi chạy phiên bản mới để áp dụng migration `202611120001_telegram_resolved`; migration chỉ mở rộng mức thông báo, không xóa/sửa lịch sử incident.

### Độ bền và retry

- Enqueue trong cùng transaction với incident; rollback thì không có notification. HTTP telemetry ACK sau commit, không đợi Telegram.
- Worker chỉ claim outbox đã commit; lease 30 giây, `FOR UPDATE SKIP LOCKED`, lease token bảo vệ cập nhật từ worker cũ. Pending/lease hết hạn có thể tiếp tục sau restart. Khóa cả incident khi claim và không claim job khác của incident đang có lease còn hạn; worker khác vẫn xử lý incident khác. Polling 1 giây.
- HTTPS cố định `api.telegram.org`, timeout 10 giây; lỗi mạng/5xx retry exponential từ 5 giây, cap 15 phút, tối đa 8 attempts, TTL notification 6 giờ. 429 tôn trọng retry_after (giới hạn tối đa 24 giờ); worker tạm dừng tương ứng, TTL vẫn có hiệu lực.
- 400/401/403 và lỗi 4xx không transient sẽ `failed`; kiểm tra chat ID, token, `/start`, quyền nhóm/bot bị chặn rồi tạo sự cố thử mới. Không log error gốc, Telegram response description hoặc URL chứa token. Log chỉ có notification ID/status/code.
- Telegram không có idempotency key cho sendMessage. Nếu đã nhận nhưng HTTP ACK bị mất hoặc tiến trình crash trước khi ghi sent, retry có thể gửi trùng. Đây là at-least-once best effort, không phải exactly-once/SLA. Incident ID chỉ lưu nội bộ để đối chiếu, không hiển thị trong tin.
- Nếu restore backup, pending/sending outbox khôi phục bị đánh dấu `failed`/`RESTORE_REVIEW_REQUIRED` để tránh phát lại hàng loạt thông báo cũ; không tự khôi phục gửi cho các hàng này. Sent history giữ nguyên. Sau restore cần migrate schema còn thiếu trước khi bật worker.

### Chẩn đoán

Log startup `notification_config` cho biết enabled/include_simulators, không lộ credentials. Log `telegram_delivery` có trạng thái hoặc mã lỗi. Các trạng thái DB: pending, sending, sent, failed, expired, skipped. Có thể kiểm tra bằng SQL quản trị read-only:

```sql
SELECT id, incident_id, severity, status, attempts, next_attempt_at,
       sent_at, last_error_code
FROM telegram_notifications
ORDER BY created_at DESC LIMIT 30;
```

Nếu không có hàng: kiểm tra bật tính năng, loại simulator, sự cố có phải mới hay không và transaction có thành công. Nếu pending: kiểm tra backend/Internet và next_attempt_at. 401 thường token sai/hết hiệu lực; 403 bot bị chặn/không có quyền; 400 có thể sai chat ID. Không đăng token hoặc response chứa dữ liệu riêng tư lên issue. Chưa có inbound webhook, gửi cảnh báo tới nhiều chat hoặc UI cấu hình token; không cần mở port Telegram vào máy local.

## Telegram Bot tương tác — lượt 1

- Chạy `npm run db:generate` và `npm run db:migrate` để thêm `202611120002_telegram_bot` (liên kết, mã một lần, menu và cursor polling). Không thêm dependency. Bật `TELEGRAM_BOT_ENABLED=true` và giữ `TELEGRAM_BOT_TOKEN` ở backend, sau đó khởi động lại API. `TELEGRAM_ENABLED`/`TELEGRAM_CHAT_ID` vẫn cấu hình kênh cảnh báo một chiều độc lập, không cần chat ID để chỉ chạy menu.
- Bot dùng [getUpdates long polling](https://core.telegram.org/bots/api#getupdates); không mở endpoint webhook. Không tự xóa webhook đang có. Chỉ dùng token không có webhook hoặc consumer khác. Mã `TELEGRAM_HTTP_409` có thể do xung đột consumer/webhook. Log chỉ ghi mã lỗi, không ghi token, chat ID, mã liên kết hoặc nội dung update.
- Trên web: **Cài đặt → Telegram → Liên kết Telegram**. Mã ngẫu nhiên 192 bit chỉ lưu SHA-256, hết hạn sau 5 phút, dùng một lần và gắn với phiên web còn hiệu lực. Gửi `/link MÃ` trong chat riêng, hoặc dùng nút Mở Telegram sau khi bot đã nhận diện username qua getMe. Không chuyển tiếp mã cho người khác. Tạo mã mới thay mã cũ; hết phiên/đăng xuất làm mã chờ mất hiệu lực.
- `/start` có sáu nút menu. `/devices` phân trang 5 thiết bị, chọn để xem chi tiết; `/status` dùng thiết bị đã chọn hoặc mở danh sách. Callback mang mã ngẫu nhiên, gắn với Telegram user/chat/message và action lưu phía server, hết hạn sau 15 phút. Callback không nhận UUID thiết bị hoặc user ID từ client. Kiểm tra lại tài khoản/quyền và thiết bị chưa lưu trữ khi xem/chọn/làm mới.
- Quyền hiện tại là **RBAC một nhóm**: admin/operator/viewer đang hoạt động cùng đọc các thiết bị. Chưa có ACL theo thiết bị trong hệ thống web; bot không tự tạo mô hình quyền khác. Tài khoản bị khóa và thiết bị lưu trữ không thể xem từ menu cũ. Đổi email, mật khẩu, vai trò hoặc khóa tài khoản qua API hiện có sẽ hủy liên kết bot cùng các phiên đăng nhập. Có thể hủy tại Cài đặt trên web hoặc `/unlink`/Cài đặt trong bot với bước xác nhận.
- Cảnh báo hiện tại và Lịch sử cảnh báo đã hoạt động từ lượt 2 (xem dưới). Biểu đồ, báo cáo và cài đặt đã hoàn thiện ở lượt 3 (xem dưới). Cài đặt bot hiện có chức năng hủy liên kết. Không thêm điều khiển thiết bị/còi/ngưỡng qua Telegram.
- Số đo dùng cùng service/backend và kiểm tra độ mới với dashboard. MQ-2/MQ-7 hiển thị ADC; không tạo PPM/AQI. SAFE chỉ hiển thị khi ONLINE, dữ liệu mới, đủ cảm biến và snapshot đều normal. OFFLINE hoặc kênh cảnh báo đã cũ/chưa xác định có tổng thể CHƯA XÁC ĐỊNH, kèm mức gần nhất nếu có. Cảm biến khác thiếu/lỗi không được che một cảnh báo mới hợp lệ; dữ liệu thiếu không bao giờ đủ để kết luận SAFE. Thời gian theo Asia/Ho_Chi_Minh; thời điểm đo chưa biết không được coi là số đo mới.
- Mỗi lệnh chat gửi một phản hồi mới ngay bên dưới lệnh; các nút điều hướng cập nhật phản hồi hiện tại bằng editMessageText. Lệnh mới vô hiệu hóa nút cũ và tạo ảnh biểu đồ mới cho lượt xem mới. Update bị lặp không chạy lại thao tác; pending render được thử lại khi lỗi mạng. Có giới hạn thao tác theo người dùng, mã liên kết theo tài khoản và giới hạn API hiện có. Polling có cursor bền vững, lease một owner với heartbeat/abort khi mất lease, backoff/429 và shutdown hủy long poll. Telegram không có idempotency key: timeout sau khi đã nhận tin đầu tiên vẫn có thể gây gửi lại; đây không phải exactly-once.
- Restore backup hủy liên kết, mã chờ (qua xóa session) và nút cũ để tránh phục hồi quyền Telegram đã bị thu hồi. Không tự gửi tin thật trong kiểm thử. Chưa kiểm tra bot/chat thật nếu chưa cấu hình và bật polling.

## Telegram Bot — quản lý sự cố, lượt 2

- Chạy `npm run db:generate` và `npm run db:migrate`. Hai migration mới: `202611120003_telegram_connectivity` thêm đích lịch sử kết nối vào outbox, `202611120004_incident_deescalation` cho phép ghi nhận giảm mức. Đã áp dụng trên DB local; không reset dữ liệu. Không cần biến môi trường hoặc dependency mới. Cảnh báo tự động dùng `TELEGRAM_ENABLED`, token/chat ID hiện có; lệnh bot dùng `TELEGRAM_BOT_ENABLED`. Khởi động lại API sau khi triển khai.
- `/alerts`: danh sách sự cố đang mở, phân trang 5 mục, xem chi tiết, làm mới và xác nhận đã đọc. Admin/operator được xác nhận; viewer chỉ xem. Xác nhận và web dùng chung bản ghi/audit, phát realtime sau commit. ACKNOWLEDGED vẫn chưa kết thúc và không tắt còi. RESOLVED chỉ đến từ dữ liệu thiết bị hợp lệ, không đến từ ACK hay OFFLINE.
- `/history`: 24 giờ/7 ngày/30 ngày, lọc thiết bị và mức cao nhất Warning/Critical, phân trang, xem bắt đầu/kết thúc. Khoảng thời gian gồm sự cố bắt đầu hoặc kết thúc trong kỳ; thời điểm bắt đầu không biết dùng first-observed nội bộ để lọc nhưng không hiển thị thời điểm đó như thời gian xảy ra. Quyền kế thừa RBAC của web, không bao gồm thiết bị lưu trữ. Mỗi callback kiểm tra lại quyền thực tế.
- `NORMAL → WARNING → CRITICAL → WARNING → NORMAL` giữ cùng incident cho cùng thiết bị/điều kiện. `severity` giữ mức cao nhất; `AlertState` giữ mức hiện tại; timeline có `escalated`/`deescalated`. Dữ liệu unknown/lỗi/mất kết nối giữ sự cố chưa kết thúc. Bộ đọc/ACK dùng chung `incident-service.ts` cho REST và bot; Telegram/Web Push đọc cùng trạng thái ngay trước khi gửi. Web Push cũ đang chờ không hiện Critical nếu sự cố đã kết thúc; các mức dùng cùng notification tag theo incident. Chính sách enqueue Web Push vẫn giữ warning/critical, không thêm push riêng cho recovery/ACK.
- Chống spam: unique incident/loại sự kiện, tối đa một Warning, một Critical và một Resolved cho một sự cố liên tục. Tái tăng Critical được ghi vào timeline nhưng không gửi Critical lặp trong cùng sự cố. Snapshot/event duplicate giữ nguyên identity; coalesce chỉ sau giao tin thành công. Lease/khóa theo incident hoặc thiết bị kết nối ngăn hai worker xử lý đồng thời cùng phạm vi. Giới hạn retry/TTL và giới hạn at-least-once đã nêu phía trên vẫn áp dụng.
- OFFLINE dùng timeout hiện có `max(30 giây, 3 × reporting_interval_ms)`, kiểm tra định kỳ 5 giây và khi đọc danh sách. Enqueue cùng transaction với chuyển trạng thái; mỗi bản ghi status history chỉ có một job. Chỉ gửi ONLINE khi phục hồi từ OFFLINE, không gửi cho thiết bị vừa xuất hiện lần đầu. Worker đọc trạng thái kết nối mới nhất; OFFLINE đang chờ nhưng thiết bị đã phục hồi được tóm tắt ONLINE, gộp job cũ sau thành công. Thiết bị lưu trữ không phát cảnh báo mất kết nối. Kết nối phục hồi không đồng nghĩa SAFE hoặc kết thúc sự cố khí gas.
- Không sửa firmware, ngưỡng hoặc còi. Giữ hysteresis MQ hiện có và debounce Flame 50 ms; không thêm độ trễ phía server vào cảnh báo Critical. Không tạo PPM/AQI. Biểu đồ, báo cáo và cài đặt nâng cao được bổ sung ở lượt 3 (xem dưới).
- Lịch sử kết nối đã có notification tham chiếu được giữ lại khi maintenance dọn dữ liệu. Bản ghi failed/expired vẫn lưu để truy vết, không retry vô hạn; việc phát lại sau lỗi terminal cần kiểm tra vận hành. Không thể bảo đảm exactly-once nếu Telegram đã nhận tin nhưng phản hồi bị mất.

## Telegram Bot — lượt 3

Chạy `npm install`, `npm run db:generate`, `npm run db:migrate` để thêm sharp và migration `202611120005_telegram_advanced` (cài đặt + outbox cá nhân). Không có biến môi trường mới; bot cần `TELEGRAM_BOT_ENABLED=true` và token backend như trước. Khởi động lại API và gửi `/start` để thay menu cũ.

- `/chart`: chọn thiết bị, cảm biến, 1 giờ/24 giờ/7 ngày; ảnh PNG có trung bình và min/max, giữ khoảng trống thiếu dữ liệu. Flame là có/không, MQ là ADC. Sử dụng cùng analytics với web; số điểm tối đa 168.
- `/report`: hôm nay/7/30 ngày; chọn thiết bị để có TB/min/max. Số sự cố theo mức cao nhất, trạng thái hiện tại và số kết thúc/mất kết nối trong kỳ được ghi rõ.
- `/settings`: xem tài khoản, theo dõi một/tất cả thiết bị, WARNING và lịch báo cáo. Lịch mặc định tắt; có hằng ngày/tuần, ngày trong tuần, giờ và phút 00/15/30/45, theo giờ Việt Nam. Critical thiết bị thật luôn được nhận, không có chức năng tắt còi. Kiểm tra thông báo tối đa một job/phút.
- Worker backend tự tổng hợp ngày/7 ngày đã hoàn tất trước ngày gửi; không cần scheduler OS. Bảo vệ bằng DB locks/unique event-key, retry tối đa 8 lần/backoff/429, báo cáo TTL 48 giờ. Hủy liên kết/đổi quyền/hủy lịch/restore chặn job cũ. Telegram vẫn có giới hạn at-least-once khi mất HTTP ACK.
- Cảnh báo cá nhân dùng cùng incident/presence hiện có. Kênh global trùng chat liên kết được route tới cá nhân để cài đặt WARNING có hiệu lực và tránh trùng; các group/channel khác không đổi. Truy vấn biểu đồ/báo cáo giới hạn 5 giây/tài khoản.

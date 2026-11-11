# Trạng thái kiểm thử — phần mềm v0.6

## Cảnh báo theo ngưỡng — 11/11/2026

- `npm test` đạt 52 bài, bỏ qua 82 bài cần runner database/browser riêng. `npm run test:integration` đạt 94 bài với PostgreSQL biệt lập. Chromium E2E đạt 5 bài, bỏ qua 1 bài native Notification theo giới hạn headless đã ghi bên dưới.
- Build, TypeScript, ESLint và format check đạt. Firmware 0.3.0 build được với cả ngõ Flame AO và D0 bằng ESP32 Arduino 3.3.11.
- Kiểm thử C++ chạy trong container Linux đạt các biên Warning/Critical, hysteresis, chiều tín hiệu Flame, retry/ACK, cấu hình canonical, từ chối ngưỡng sai và lỗi cấp phát bộ nhớ. Payload/cấu hình do C++ tạo được kiểm tra trực tiếp bằng schemas TypeScript.
- API/DB kiểm tra nâng cùng sự cố Warning → Critical, lịch sử escalated, dedup thông báo từng mức, hạ mức hiện tại, giữ sự cố khi cảm biến lỗi, kết thúc bằng mẫu hợp lệ và bỏ qua trạng thái cũ. Client chỉ đổi chu kỳ vẫn giữ ngưỡng đã lưu.
- Browser kiểm tra thẻ màu Warning/Critical, banner toàn cục, cập nhật realtime, lưu ngưỡng, ACK cấu hình, đăng xuất và các luồng quản trị cũ. Giao diện đã bỏ ghi chú nghiên cứu và giải thích kỹ thuật thừa.
- Migration `202611110001_alert_escalation` đã áp dụng vào database local, giữ dữ liệu hiện có.
- Chưa nạp firmware 0.3.0 lên board thật hoặc kiểm tra giao thông báo qua provider thật. Log của người dùng cho thấy Flame AO đang ADC_CLIPPED, cần xử lý điện áp/ngõ vào. Ngưỡng mặc định là ADC, chưa phải giới hạn nồng độ được hiệu chuẩn. MQ-7 heater vẫn unverified.

## Firmware ESP32 Wi-Fi — 11/11/2026

- Firmware `esp32-0.2.0` có worker Wi-Fi/API riêng với vòng đọc cảm biến, queue RAM giới hạn, retry giữ nguyên reading, boot counter NVS, kiểm tra ACK và tải/hash/ACK cấu hình chu kỳ gửi.
- Đã build cấu hình mặc định và cấu hình có Wi-Fi/Device ID/key giả bằng Arduino CLI 1.5.1, ESP32 Arduino 3.3.11 và DHT 1.4.7. Bản có mạng liên kết đầy đủ dùng 1.061.296 byte flash và 48.784 byte biến toàn cục. Cấu hình kiểm thử nằm trong thư mục tạm, không ghi đè cấu hình của người dùng.
- Kiểm thử API/DB/Socket.IO với PostgreSQL container biệt lập đã đạt. Payload theo định dạng firmware dùng thiết bị physical, time_quality unsynced, sequence lớn hơn 2^53. Kiểm tra cấp key, hash/ACK config, lưu reading, retry không nhân row, REST latest, realtime invalidation và invalid/null sensors. Payload ở bài này được tạo từ fixture API, chưa lấy từ ESP32 thật.
- Chương trình kiểm thử encoder C++ trên máy tính biên dịch được nhưng Windows Application Control chặn thực thi. Không tính kiểm thử runtime encoder và fault injection đó là pass.
- Chưa nạp bản Wi-Fi lên ESP32, thử Wi-Fi/HTTP/HTTPS từ board thật, mất mạng/reboot/queue overflow hoặc đo ảnh hưởng tác vụ mạng lên vòng cảm biến/còi. Xem [hướng dẫn kết nối](../../firmware/README.md#kết-nối-esp32-với-web-local) để cấu hình SSID, key và API LAN.

## Web Push — lần kiểm tra bổ sung

- `npm test`: 48 pass, 78 skip (các test cần DB/browser chạy bằng runner riêng).
- `npm run test:integration`: 91 pass, DB PostgreSQL container riêng; migration Web Push áp dụng thành công.
- `npm run test:e2e`: 4 pass, 1 skip. Service worker thật được phục vụ/kích hoạt, trang Cài đặt giải thích backend-disabled. Test notification native skip vì Chromium headless trả `Notification.permission=denied` dù Permissions API được override thành granted; không giả kết quả giao tin.
- Build/typecheck và lint đạt. Unit tests kiểm tra handler push/click, URL same-origin, payload lỗi, thao tác opt-in/out UI và VAPID/transport classification. Integration kiểm tra auth, ownership, endpoint/key validation, transactional dedup, lease đồng thời, retry/410, simulator opt-in mặc định tắt, logout và hết phiên.
- Chưa xác minh gửi/giao qua provider thật, Firefox/Safari/Edge hay hành vi khi đóng trình duyệt trên OS thật. Cần thử thủ công theo README sau khi quản trị viên cấu hình VAPID riêng.
- Mặc định Web Push tắt. Chưa tự tạo/lưu private key hoặc thay đổi `.env`; migration development cần chạy theo README.

## Môi trường

- Windows, Node.js 24.18.0, npm 11.16.0.
- Docker Desktop Linux Engine 29.6.1.
- PostgreSQL 17 trong container test riêng, password ngẫu nhiên cho mỗi lần chạy.
- Prisma 7.10.1, Vitest 5.0.5; versions cụ thể còn lại được khóa trong package-lock.json.
- Chromium do Playwright cài; browser tests không thay thế kiểm thử trên hardware.
- Repository đã có baseline trên GitHub; thay đổi v0.2/v0.3 đang ở working tree, chưa tự commit/push.

## Những gì đã được kiểm tra

- Contract: ADC giới hạn theo độ phân giải, raw PPM null, invalid sensor dùng null, humidity range, schema version, signed BIGINT và đồng bộ timestamp.
- API/PostgreSQL: login, session hash, role restrictions, device key hash/revoke, device ID scope, batch validation, concurrent duplicate, atomic rollback, delayed ordering, bounded cursor history.
- Boundary errors: Origin allowlist, malformed JSON, database không liên lạc được trả 503, log/response không lộ secret.
- Realtime: từ chối socket không có session, subscribe theo device, event sau commit, disconnect khi logout.
- UI: login success/error, empty state không tạo số đo giả, nhãn simulator, invalid không biến thành zero, stale không biến thành dữ liệu mới.
- Browser end-to-end thật: tạo simulator, cấp key, upload HTTP vào API thật, hiển thị sensor/chart, viewport 390 px không tràn ngang, logout xóa server session; không có pageerror trong luồng.
- TypeScript strict, ESLint, Vite build và dependency audit.
- Incident lifecycle: snapshot active/unknown/normal, concurrent retry, acknowledgement có role/user/time và không tắt còi, delayed snapshot không mở lại; event ended-before-started, dedup/identity conflict, liên kết snapshot/event bằng incident UUID, boot conflict rollback.
- Device management: metadata và source bất biến, key list/cursor/expiry/revoke/rotation overlap, config version locking + hash/ETag/ACK, simulator tự nhận cấu hình, heartbeat không giả sensor, archive/restore và audit/status history.
- Analytics/export: thời gian [from,to), cursor, valid/invalid count và null stats, so sánh kỳ trước, mixed ADC resolution bị chặn, CSV giữ source/quality/timestamps và chống formula injection; UI không nối qua bucket thiếu mẫu.
- Browser: timeline/ack/end refetch, tải CSV thật, lưu config và nhận ACK, rotation key và archive/restore.
- Accounts: admin tạo/list/role/lock, self-service email/password bằng current password, revoke sessions/socket, chặn tự khóa/hạ quyền, duplicate email/weak password và audit không có secrets; browser kiểm tra viewer không thấy admin navigation.
- Retention: dry-run không ghi/xóa, raw→minute/hour transaction và rerun không double-count, giữ latest, weighted average + invalid counts, không xuất CSV thiếu khi raw đã tổng hợp, partial bucket bị từ chối; audit/status hết hạn bị dọn nhưng giữ incident evidence.
- Backup: mã hóa/xác thực, sai passphrase hoặc sửa ciphertext bị từ chối; PostgreSQL custom dump/restore vào DB trống riêng có fixture/schema, thu hồi sessions, từ chối restore đè.
- CSV limit: tạo 100.001 raw rows trong DB test, xác nhận trả JSON 413 trước khi stream file.

## Lệnh tái chạy

Kết quả lần xác minh local:

| Lệnh                       | Kết quả                                                                     |
| -------------------------- | --------------------------------------------------------------------------- |
| `npm test`                 | 39 pass, 69 skip do cần runner DB/browser/load                              |
| `npm run test:integration` | 80 pass với PostgreSQL thật, gồm Telegram/outbox và encrypted restore drill |
| `npm run test:e2e`         | 3 pass trong Chromium thật                                                  |
| `npm run test:load`        | 1 pass; 60 giây, 10 simulator/5 Chromium pages, 120/120 mẫu, 120 rows       |
| `npm run lint`             | Pass                                                                        |
| `npm run build`            | Typecheck + frontend build pass                                             |
| `npm audit`                | 0 vulnerabilities được báo tại thời điểm chạy                               |

Các suite config/logging chạy lại ở nhiều lệnh; không cộng tổng các lần chạy thành số test độc lập. Load report local `reports/load-1792312816146.json`: ingestion P95 533,86 ms; request → DOM warm P95 771,20 ms. Chỉ 120 mẫu/60 giây, chưa phải AC02 ≥1000 updates hoặc bài 30 phút/24 giờ. Timing bắt đầu trước HTTP request, là upper bound bảo thủ chứ không phải timestamp DB commit chính xác. Memory chỉ đo Node, không suy thành chứng minh không leak toàn hệ thống.

Simulator danger: unit test kiểm tra ranh giới pha normal/active/recovery và vòng lặp, retry ổn định, gas raw/PPM null; integration dùng payload thật để tạo ba incident có source simulator, retry không nhân đôi và normal đóng đủ ba incident (sáu transition events). Đã quan sát cả unit và integration fail trước khi thêm kịch bản. E2E phía trên là lần kiểm tra giao diện v0.2; không chạy lại browser riêng cho CLI danger.

```powershell
npm run db:generate
npm test
npm run test:integration
npx playwright install chromium
npm run test:e2e
npm run test:load
npm run lint
npm run build
npm run format:check
npm audit
```

`npm test` mặc định skip API/Socket/browser tests cần TEST_DATABASE_URL. Hai runner `test:integration` và `test:e2e` thực thi các suite đó với database biệt lập, không sử dụng database development. Đọc số pass/skip từ output tương ứng, không coi skip là pass.

Các kiểm thử được viết và quan sát fail trước phần implementation tương ứng; browser E2E còn dùng để xác minh luồng tích hợp thật.

## Chưa kiểm tra / chưa đạt cổng nghiệm thu đầy đủ

- Chưa chạy đủ 60 phút telemetry, 30 phút tải 10 thiết bị/5 browser, 24 giờ soak hoặc ≥1000 UI updates theo AC; hiện chỉ có smoke 60 giây và runner để tái chạy các bài dài.
- Chưa đo RPO/RTO bằng lịch backup thực tế, backup offsite hoặc deployment smoke ngoài LAN. Drill backup/restore local đã chạy; không suy thành SLA vận hành.
- Đã thử chặn vượt 100.000 CSV rows, chưa đo throughput/memory xuất đúng 100.000 dòng hoặc range 90 ngày đầy tải; sự cố dài hạn qua nhiều boot chưa được soak.
- Workflow CI đã có nhưng chưa push/chạy trên GitHub. Scheduler OS, backup rotation và phân trang config trên 100 phiên bản gần nhất chưa tự triển khai.
- Có firmware bench và Wi-Fi, nhưng wiring, heater, calibration, sensor integration, cảnh báo cục bộ và hardware-in-the-loop chưa được nghiệm thu trên phần cứng thật.
- Chưa triển khai hoặc kiểm thử cloud. Không suy diễn availability/SLA từ test local.

## Regression: Origin local và phiên đăng nhập sau refresh

- Đã quan sát test fail trước khi sửa: loopback alias bị 403, không có cookie, frontend không bootstrap session.
- Bổ sung Origin tests: localhost/127.0.0.1 cùng port/scheme được phép; port/scheme/domain khác và null Origin bị chặn.
- Bổ sung PostgreSQL session tests: HttpOnly/host-only/expiry, token không trả trong JSON, cookie phục hồi session, anti-CSRF, logout/revoke, expired session và Secure trên HTTPS.
- Browser E2E cấu hình origin localhost nhưng mở bằng 127.0.0.1, reload sau login vẫn vào dashboard và realtime kết nối. Cookie không đọc được từ document.cookie; reload sau logout vẫn ở trang login.
- Không thay đổi hoặc reset database development; kiểm thử DB/browser vẫn dùng container riêng.

Đây là bằng chứng cho lát cắt đầu tiên, không phải tuyên bố hoàn thành toàn bộ PLAN.md.

## Regression realtime phát hiện qua load runner

- Quan sát load fail: socket connected nhưng UI mất khoảng 5 giây vì frontend devices.subscribe không truyền ACK callback, server bỏ qua subscription.
- Sau sửa ACK, burst invalidations từ 10 thiết bị tạo quá nhiều refetch; bổ sung batcher 250 ms, coalesce query keys, không starvation khi event liên tục và hủy timer khi disconnect/unmount. Unit batcher đã fail trước implementation.
- Runner kiểm tra đủ 5 browser join room thiết bị, sau đó đo cập nhật DOM thật với polling 50 ms (không phụ thuộc rAF của tab nền). Không nới ngưỡng 1 giây ingestion / 2 giây UI để làm test pass.
- Chromium E2E chạy lại 3 pass sau thay đổi; load 60 giây pass. Có các report fail cũ trong thư mục ignored reports để đối chiếu.
- Migration operations đã áp dụng vào DB local, không reset dữ liệu. Chỉ chạy maintenance dry-run ở DB development; apply/delete chỉ được kiểm thử trong DB test biệt lập.

## Telegram notifications v0.4

- Đã quan sát tests fail trước implementation: config opt-in/credentials, plain text POST đúng API, retry_after và lỗi network không lộ token; queue incident/severity, escalation, concurrent lease/reclaim và backoff.
- PostgreSQL kiểm tra rollback outbox sau khi một condition khác conflict, retry telemetry/event không nhân job, simulator filter, hết TTL, lỗi 403/exhausted attempts ngừng retry, tắt include-simulator skip pending cũ.
- Encrypted restore drill kiểm tra pending/sending outbox khôi phục bị đánh dấu RESTORE_REVIEW_REQUIRED, tránh phát lại backup.
- Transport tests dùng fake HTTP responses cho Telegram để không gửi tin ngoài ý muốn; database/transaction/lease là PostgreSQL thật, có cả physical-device fixture để kiểm tra lọc simulator không chặn thiết bị thật. **Chưa kiểm tra gửi tới Telegram bot/chat thật**; cần cấu hình credentials người dùng. Không coi 80 pass là Telegram đã giao tin thành công.
- Migration Telegram đã áp dụng vào DB local, giữ nguyên dữ liệu. Mặc định tính năng tắt cho tới khi bật và điền environment; không đưa token/chat ID vào source hoặc log.

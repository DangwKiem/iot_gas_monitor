# Trạng thái kiểm thử — phần mềm v0.6

## Telegram Bot — lượt 3, 12/11/2026

- Hoàn thiện menu và `/chart`, `/report`, `/settings`; không còn mục Chưa khả dụng. Lượt 1/2 vẫn có liên kết, trạng thái thiết bị, alerts/ACK và history dùng chung incident với web/push.
- Biểu đồ 5 cảm biến, 1 giờ/24 giờ/7 ngày, tối đa 60/24/168 điểm. MQ/DHT dùng chung analytics với REST, gồm rollup, weighted statistics và kiểm tra độ phân giải ADC. Đường trung bình có vạch min/max; thiếu dữ liệu giữ khoảng trống. Flame lấy MAX trạng thái trong từng khoảng từ raw còn lưu. PNG tạo tại backend bằng sharp, không cần Chromium trong production; upload multipart và sửa lại ảnh khi đổi khoảng.
- Báo cáo hôm nay/7/30 ngày: sự cố theo mức cao nhất, đang mở hiện tại, kết thúc trong kỳ, lần OFFLINE và thiết bị đang offline; chọn thiết bị để xem TB/min/max. Thống kê gồm cả phần giờ hiện tại, kết hợp rollup/raw không tính trùng. Không có mẫu hợp lệ thì thông báo thiếu dữ liệu, không sinh PPM/AQI.
- Cài đặt DB: tài khoản liên kết, theo dõi một/tất cả thiết bị, WARNING, báo cáo ngày/tuần/tắt, giờ và phút 00/15/30/45, ngày trong tuần, kiểm tra nhận tin, hủy liên kết. CRITICAL của thiết bị thật luôn bật và không điều khiển còi. Mô phỏng chỉ tự gửi khi người dùng chọn theo dõi thiết bị đó.
- Lịch Asia/Ho_Chi_Minh nằm trong worker backend; khóa hàng DB và unique link-generation/event-key chống scheduler/worker chạy chồng. Tối đa 8 lần thử, backoff/429, TTL 6 giờ cho cảnh báo và 48 giờ cho báo cáo. Khi khởi động lại, xử lý một kỳ đang đến hạn và chuyển tới lịch kế tiếp; không phát lại hàng loạt kỳ đã bỏ lỡ. Báo cáo tự động gồm ngày/7 ngày đã hoàn tất trước ngày gửi.
- Kiểm tra lại quyền, liên kết và thiết bị trước gửi; hủy liên kết/đổi quyền thay link-version, ngừng báo cáo và vô hiệu hóa job cũ. Đổi lịch hủy báo cáo đang chờ. Restore thu hồi liên kết, tắt lịch và đánh dấu outbox khôi phục cần rà soát. Kênh Telegram global trùng chat liên kết được chuyển sang outbox cá nhân, không gửi hai bản; group/global khác vẫn giữ nguyên.
- Test mới: PNG cả 5 cảm biến, khoảng trống, rollup/profile ADC, thống kê, các màn hình/cài đặt giờ, upload lỗi/retry, scheduler đồng thời/restart, timeout/429/max-attempt, WARNING-off không chặn Critical/Resolved, hủy liên kết/đổi quyền/archive, rate limit và backup/restore. API Telegram giả lập; PostgreSQL và ảnh PNG là thật. Chưa nghiệm thu gửi ảnh/báo cáo tới Telegram thật hoặc soak dài hạn. Telegram sendMessage không có idempotency key nên mất phản hồi sau khi đã nhận tin vẫn có thể gây trùng.
- Migration `202611120005_telegram_advanced` đã áp dụng local, giữ nguyên dữ liệu. Cài dependencies bằng `npm install`, generate/migrate như trước. Không thêm biến môi trường; dùng `TELEGRAM_BOT_ENABLED=true` và token hiện có. Báo cáo mặc định tắt; bật tại `/settings`. Không thay firmware/ngưỡng/còi.
- Production audit sau vá body-parser/fast-uri: 0 vulnerabilities. Full audit còn 7 moderate trong nhánh typescript-eslint/minimatch của dev tooling, bản sửa được npm đề xuất thay đổi nhánh phiên bản; chưa ép cập nhật công cụ lint.

Kết quả nghiệm thu lượt 3: PostgreSQL **176/176 đạt**; unit **81 đạt** (các ca DB/browser/load dùng runner riêng); E2E Chromium **5 đạt, 1 bỏ qua** vì native Notification ở headless. Typecheck, ESLint, build và format đạt. Có kiểm thử khóa đồng thời giữa enqueue ESP32 và ACK Telegram; dùng NO KEY UPDATE để FK enqueue không chặn vòng ngược qua device. API local đã khởi động lại và health trả 200, bot giữ lease polling.

File quan trọng lượt 3: `apps/api/src/modules/telegram-data.ts`, `telegram-chart.ts`, `telegram-advanced-view.ts`, `telegram-ui.ts`, `telegram-deliveries.ts` (mới); `telegram-bot.ts`, `telegram-bot-view.ts`, `telegram-client.ts`, `telegram-links.ts`, `analytics.ts`, `notifications.ts`, `maintenance.ts`, `apps/api/src/runtime.ts`; `packages/database/prisma/schema.prisma` và migration `202611120005_telegram_advanced`; `tools/operations/backup.ts`; `apps/web/src/pages/AuditPage.tsx`; `apps/api/tests/telegram-advanced.test.ts`, `telegram-client.test.ts`, `telegram-bot.test.ts`, `backup.test.ts`; `package.json`, `package-lock.json` và tài liệu vận hành/kiểm thử.

## Telegram Bot — lượt 2, 12/11/2026

- Chuỗi Warning → Critical → Warning → Critical → Normal giữ một incident, timeline gồm hai escalated và một deescalated; retry snapshot/event không nhân incident hoặc outbox. Warning → Normal và Critical → Resolved đều có bản tóm tắt kết thúc.
- Hai điều kiện gas/CO độc lập, ACK idempotent đúng quyền và phát realtime; ACK không đổi trạng thái sự cố hoặc buzzer snapshot. Callback cũ bị từ chối sau đổi quyền/archived; sự cố kết thúc trước ACK vẫn RESOLVED. Chưa liên kết/tài khoản vô hiệu hóa không xem được alerts/history.
- `/alerts`: danh sách/chi tiết/xác nhận/quay lại/làm mới. `/history`: 24 giờ/7 ngày/30 ngày, thiết bị, peak Warning/Critical, phân trang, chi tiết và quay lại. HTML được escape; giờ Việt Nam; không lộ UUID hoặc thời điểm kỹ thuật.
- Queue: timeout, 429/backoff, giới hạn 8 lần, restart/reclaim, worker đồng thời, coalesce chỉ sau thành công, tin đã kết thúc nằm trong queue, mất lease và rollback enqueue. Telegram API dùng fake transport, không gửi tin thử thật.
- Presence: một OFFLINE cho mỗi chuyển trạng thái và ONLINE phục hồi, không spam initial contact, không đóng gas incident; stale offline đọc latest online khi gửi. Rollback nếu ghi outbox lỗi. Retention giữ status-history có FK notification, dry-run đếm đúng dữ liệu được phép dọn.
- Đồng bộ: REST/Telegram/Web Push cùng mức hiện tại, mức cao nhất, ACK và resolved; service worker dùng cùng tag theo incident và ưu tiên resolved. Web Push vẫn giữ chính sách enqueue hiện có; không thêm recovery/ACK push riêng.
- Kết quả: `npm test` 78 đạt, 123 bỏ qua cho runner riêng; `npm run test:integration` 157/157 đạt trên PostgreSQL biệt lập; E2E Chromium 5 đạt, 1 native Notification bỏ qua vì headless. Typecheck/build/lint/format đều đạt. Không sửa firmware hoặc dependency, không thêm Task 3.
- Hai migration lượt 2 đã áp dụng vào database local: `202611120003_telegram_connectivity`, `202611120004_incident_deescalation`, không reset dữ liệu. Không cần cấu hình mới. Không xác nhận giao tin thật tới Telegram; mất phản hồi sau khi Telegram nhận tin vẫn có thể gây trùng vì API không hỗ trợ idempotency key.

Các file của lượt 2:

- Service/lifecycle/outbox: `apps/api/src/modules/incident-service.ts` (mới), `alerts.ts`, `notifications.ts`, `telegram-message.ts`, `presence.ts`, `maintenance.ts`, `web-push.ts`.
- Bot: `apps/api/src/modules/telegram-bot-view.ts`, `telegram-bot.ts`, `telegram-bot-worker.ts`.
- Wiring backend: `apps/api/src/app.ts`, `runtime.ts`, `lib/context.ts`, `modules/devices.ts`, `modules/telemetry.ts`.
- Contract/database: `packages/contracts/src/features.ts`, `packages/database/prisma/schema.prisma`, `packages/database/prisma/migrations/202611120003_telegram_connectivity/migration.sql`, `202611120004_incident_deescalation/migration.sql`.
- Web: `apps/web/src/components/FeatureUI.tsx`, `pages/AlertsPage.tsx`, `pages/IncidentPage.tsx`, `public/push-sw.js`.
- Tests: `apps/api/tests/incident-task2.test.ts` (mới), `telegram-bot.test.ts`, `telegram-message.test.ts`, `telegram.test.ts`, `apps/web/src/lib/push-service-worker.test.ts`.
- Tài liệu: `docs/operations/local-runbook.md`, `docs/api/monitoring.md`, `docs/architecture/decisions.md`, `docs/testing/status.md`.

## Telegram Bot tương tác — lượt 1, 12/11/2026

- Đã kiểm tra `/start`, `/devices`, `/status`, toàn bộ sáu nút menu, quay lại/làm mới, chọn thiết bị và phân trang. Ba mục cảnh báo hiện tại/lịch sử/biểu đồ chỉ có trạng thái Chưa khả dụng, không triển khai lượt 2/3.
- Liên kết qua web bằng mã một lần: auth/CSRF, hash mã, hết hạn/thay mã, thu hồi session, từ chối gắn đè tài khoản Telegram khác. Hủy trên web/bot, xác nhận/hủy thao tác, vô hiệu hóa nút cũ; đổi mật khẩu/quyền/khóa tài khoản và restore thu hồi liên kết.
- Kiểm tra quyền ở lệnh/callback, tài khoản không hoạt động, thiết bị lưu trữ, callback giả/hết hạn/sai người/sai tin nhắn, update trùng và bấm nhanh. Polling kiểm tra offset bền vững, chỉ một owner, retry update chưa xác nhận khi timeout, abort và shutdown idempotent.
- Trạng thái dùng số đo backend và cùng hàm freshness với dashboard: ONLINE/OFFLINE, dữ liệu thiếu/cũ/unsynced/lỗi cảm biến, SAFE/WARNING/CRITICAL, phát hiện lửa không đi cùng kết luận SAFE, escape HTML, giờ Việt Nam. Không sinh PPM/AQI.
- `npm test`: 77 đạt, 107 bỏ qua cho runner riêng. Bộ backend với PostgreSQL biệt lập đạt 140 kiểm thử; ca bổ sung cảm biến lỗi không che cảnh báo Critical mới cũng đạt qua unit test. Chromium E2E đạt 5, bỏ qua 1 native Notification do headless. Build/typecheck/lint/format đạt. Telegram API giả lập trong kiểm thử; không gửi tin thật.
- Migration `202611120002_telegram_bot` đã áp dụng local. `TELEGRAM_BOT_ENABLED` mặc định false; cần bật và khởi động lại API với bot token hợp lệ để dùng menu thật. Không tự gỡ webhook hoặc thay consumer của token.
- Phạm vi quyền kế thừa RBAC một nhóm hiện có; chưa có ACL riêng từng thiết bị. Chưa kiểm tra bot/chat Telegram thật.

Các file của lượt 1:

- Bot/API: `apps/api/src/modules/telegram-bot.ts`, `telegram-bot-view.ts`, `telegram-bot-worker.ts`, `telegram-links.ts`, `telegram-client.ts`, `telemetry.ts`, `users.ts`; `apps/api/src/app.ts`, `config.ts`, `runtime.ts`, `server.ts`, `openapi.ts`.
- Web: `apps/web/src/components/TelegramSettings.tsx`, `apps/web/src/pages/SettingsPage.tsx`, `AuditPage.tsx`, `apps/web/src/styles.css`, `apps/web/src/lib/freshness.ts`.
- Dữ liệu dùng chung: `packages/contracts/src/freshness.ts`, `index.ts`, `packages/contracts/package.json`; `packages/database/prisma/schema.prisma`, `packages/database/prisma/migrations/202611120002_telegram_bot/migration.sql`; `tools/operations/backup.ts`.
- Kiểm thử: `apps/api/tests/telegram-bot.test.ts`, `telegram-bot-view.test.ts`, `telegram-client.test.ts`, `config.test.ts`, `backup.test.ts`; `apps/web/src/components/TelegramSettings.test.tsx`.
- Cấu hình/tài liệu: `.env.example`, `docs/operations/local-runbook.md`, `docs/api/monitoring.md`, `docs/testing/status.md`.

## Telegram — 12/11/2026

- Nội dung HTML được tách khỏi worker; kiểm tra escape tên/vị trí, giờ Asia/Ho_Chi_Minh, mốc qua ngày/00:00, thời gian không xác định, WARNING/CRITICAL/RESOLVED, tăng/giảm mức và nhãn mô phỏng. Không sinh PPM/AQI hoặc lộ UUID/timestamp kỹ thuật.
- PostgreSQL thật kiểm tra cả chuỗi snapshot Warning → Critical → Normal và durable event kết thúc đến trước sự kiện bắt đầu; retry không nhân queue, gửi trễ chỉ còn một bản tóm tắt đã kết thúc.
- Worker kiểm tra lease theo incident, ưu tiên Critical, gộp các job sau thành công; lỗi mạng/429 không đánh dấu job khác là đã bao phủ. Worker mất lease không được ghi đè kết quả hoặc gộp job. Giữ nguyên backoff, timeout, TTL, giới hạn attempts và lịch sử terminal.
- `npm test`: 61 đạt, 88 bỏ qua do cần runner database/browser riêng. `npm run test:integration`: 109 đạt trên PostgreSQL biệt lập; typecheck, lint và format đạt. Không gửi Telegram thật trong các kiểm thử.
- Migration `202611120001_telegram_resolved` đã áp dụng trên DB local, chỉ mở rộng constraint mức thông báo. Đối chiếu trước/sau giữ nguyên 139 incidents, 299 events và 145 notifications. Chưa xác nhận giao tin tới bot/chat Telegram thật.

## Kiểm tra còi — firmware 0.3.1

- Thêm lựa chọn DC/PWM, cấu hình tần số và lệnh Serial `d`/`p`/`t` kích thử 2 giây. GPIO25 chỉ thay cấu hình khi đổi mode và chỉ cập nhật duty/mức khi lệnh thay đổi.
- Build ESP32 Arduino 3.3.11 đạt với cả `kBuzzerUsePwm=false` và true. Mặc định giữ DC cho KY-012 active. Không thay đổi ngưỡng hoặc luồng backend/frontend.
- Có báo lỗi attach/write PWM trong Serial. Chưa xác nhận âm thanh trên module thực tế của người dùng; cần kiểm tra nguồn, pinout, polarity và mức điều khiển.

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

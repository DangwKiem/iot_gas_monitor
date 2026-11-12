# Quyết định cho lát cắt local đầu tiên

## Phạm vi

Triển khai dọc: đăng nhập → đăng ký thiết bị → cấp key → nhận telemetry → PostgreSQL → Socket.IO → dashboard. Firmware và cloud chưa triển khai.

## Session

Theo yêu cầu sửa mất đăng nhập sau refresh: opaque token ngẫu nhiên 256 bit được lưu trong cookie HttpOnly `iot_session`, Path=/, host-only, SameSite=Lax, Max-Age=8 giờ. Database chỉ lưu SHA-256. HTTPS hoặc NODE_ENV=production bật Secure; HTTP local không bật Secure để browser dùng được. Login JSON chỉ trả user/expiry, không trả token; frontend gọi session endpoint khi khởi động. Không lưu token/password vào localStorage hoặc sessionStorage. Không thay đổi schema DB.

Origin allowlist chỉ thêm hai alias localhost/127.0.0.1 nếu WEB_ORIGIN là loopback, giữ nguyên scheme/port. Domain ngoài loopback chỉ được chấp thuận chính xác theo cấu hình. CORS cho phép credentials với Origin cụ thể, không wildcard. Mọi request ghi của web, kể cả login, cần X-Requested-With: AirGuard; device API dùng DeviceKey độc lập và không phụ thuộc cookie. Explicit bearer credentials vẫn được chấp nhận cho API clients để tương thích, nhưng browser không nhận hoặc sử dụng bearer token.

Logout chỉ hiển thị thành công khi server thu hồi phiên, hoặc phiên đã hết hiệu lực; lỗi kết nối cho phép thử lại. Cookie riêng theo hostname nên người dùng cần dùng nhất quán localhost hoặc 127.0.0.1.

## Thiết bị và phép đo

- Mọi tài khoản thuộc cùng một nhóm đọc thiết bị; chỉ admin tạo thiết bị/cấp–thu hồi key.
- `source_kind` lấy từ database, không cho thiết bị tự nhận mình là hardware/simulator trong payload.
- Contract v1 chỉ nhận tín hiệu gas raw; `concentration_ppm` bắt buộc null.
- Quality và sensor age độc lập kết nối online/offline.
- Counter truyền chuỗi số, giới hạn signed BIGINT. `boot_counter` tăng bền mỗi boot; factory reset phải xử lý reprovision trước dùng lại. Simulator dùng thời gian khởi chạy làm counter và không đại diện thiết kế firmware.
- Một boot_counter không được đổi boot_id. Server khóa row device trong transaction để tuần tự hóa ingestion và chống race.
- Batch có conflict rollback toàn bộ; duplicate hợp lệ trả ACK. Chỉ ACK sau commit.
- Retry content không đổi; transmission uptime có thể đổi.
- Mẫu có UTC hợp lệ chỉ nhận trong 24 giờ, cho phép lệch tương lai tối đa 60 giây. Mẫu chưa sync chỉ nhận từ boot hiện tại với uptime xác định được tuổi ≤24 giờ.

## Realtime

- Namespace `/monitoring`, xác thực bằng cookie HttpOnly gửi trong handshake; áp dụng cùng Origin allowlist.
- `devices.subscribe` có ACK và kiểm tra device IDs; scope đọc chung theo nhóm v1.
- `telemetry.created` là sự kiện invalidation sau commit: envelope version/event_id/type/emitted_at/device_id; `data.refetch=true`. Không cam kết chuyển phát bền.
- Browser refetch snapshot/history sau reconnect và polling định kỳ.
- Logout xóa session trong DB và ngắt sockets của session; socket tự ngắt khi hết hạn.
- Online/offline theo last_seen và max(30 giây, 3 × chu kỳ đã applied). Reconciler mỗi 5 giây và GET danh sách ghi durable status history; hiệu lực timeout và lúc phát hiện được lưu riêng.
- Alert/device/config events cũng là invalidation sau commit. Acknowledge chỉ lưu danh tính/thời gian/ghi chú, không sửa telemetry, không gửi lệnh tắt còi.

## Bổ sung local v0.2

- Migration thứ hai thêm incident/event/state/ack, config versions/ACK, key expiry/rotation metadata, device metadata/archive, status history và audit; không xóa dữ liệu cũ. Backfill immutable config v1 (5 giây) cho thiết bị hiện có.
- Snapshot mới tạo/kết thúc incident theo boot/sequence; lỗi sensor/unknown/offline không đóng incident. Durable events dùng stable incident_id/event_id, transaction và dedup; hỗ trợ ended đến trước started. Snapshot và event liên kết bằng incident_ids; không đoán khi identity mơ hồ.
- Cấu hình chỉ cho phép chu kỳ gửi 1–60 giây, không safety controls. expected_version tránh lost update, hash/ETag phục vụ thiết bị, applied ACK độc lập desired. Simulator tích hợp tải/verify/ACK.
- Metadata/archive và key/config mutations chỉ admin; operator/admin acknowledge; viewer chỉ đọc. Key secret trả một lần, expiry/revoke kiểm tra mỗi request. Archive giữ lịch sử nhưng chặn device transport.
- Analytics/CSV dùng SQL aggregation và snapshot transaction, một device mỗi request; ADC mixed bit bị chặn. Khoảng [from,to) tối đa 90 ngày, chart khoảng 2000 điểm, CSV 100.000 dòng stream theo chunk, chống formula injection. Chỉ tính mẫu valid/uncalibrated có giá trị; không công bố PPM/AQI.
- Chi tiết giao thức, giới hạn và workflow tại [monitoring API](../api/monitoring.md).

## Các hạng mục chưa hoàn thành

- Phân trang lịch sử config trên 100 phiên bản gần nhất.
- Lịch backup/maintenance ngoài OS, backup offsite và rotation theo chính sách vận hành; code công cụ local đã có, không tự cài lịch hoặc xóa backup.
- HIL, tải/soak dài hạn, firmware và cloud.

Incident history không thay thế snapshot mới nhất: cả hai đều phân biệt dữ liệu mô phỏng và trạng thái có thể cũ. Chưa nghiệm thu policy/threshold gas/CO cho phần cứng.

## Bổ sung local v0.3

- Admin quản lý tài khoản, tất cả roles có đổi email/mật khẩu bằng reauthentication. Khóa/role/reset thu hồi sessions và sockets; login khóa row user và kiểm tra lại password hash/email/active trước khi tạo phiên. Advisory lock tuần tự hóa thay đổi admin; không tự khóa/hạ quyền hoặc mất admin cuối.
- Audit được khái quát resource_type/resource_id, device_id có thể null cho user/maintenance; có UI admin và cursor. Không ghi bí mật.
- Retention explicit CLI mặc định dry-run; apply yêu cầu backup xác thực cùng DB ≤24 giờ. Delete raw + cộng rollup trong cùng transaction; chỉ aggregate row thực sự bị xóa và giữ latest. Phút/giờ tách time basis, metric, ADC bit; analytics weighted sum/count không double-count và từ chối bucket một phần. Không sửa diễn giải gas/CO.
- Raw 14 ngày, phút 90 ngày, giờ 365 ngày, audit 180 ngày, status 365 ngày khi apply. **Quyết định an toàn:** incident/event/ack chưa tự purge, giữ lâu hơn mức tối thiểu dự kiến trong PLAN. Không tự cài scheduler hoặc backup rotation.
- Backup stream mã hóa AES-256-GCM/scrypt; header authenticated, xác minh trước restore, chỉ restore DB trống riêng và thu hồi web sessions khôi phục. CI có checks/test/restore drill/load smoke, không deploy.
- Regression realtime: frontend phải gửi ACK callback cho devices.subscribe, đúng hợp đồng server. Có kết nối socket nhưng không join room sẽ chỉ còn REST polling; load test kiểm tra room subscription và giá trị DOM cập nhật.

## Telegram opt-in v0.4

- Bổ sung theo yêu cầu người dùng: warning/critical notifications qua Telegram. Chỉ backend giữ token/chat ID trong environment; không mở webhook, không gửi secrets ra browser hoặc log.
- Transactional PostgreSQL outbox unique incident/severity; enqueue cùng incident và chỉ worker đọc sau commit. Telegram không nằm trong đường HTTP ACK ingestion. Không gửi mỗi sample hoặc acknowledge; gửi thêm resolved khi kết thúc (từ 12/11/2026). Không đổi ngưỡng/severity phần cứng.
- Mặc định tắt, simulator mặc định bị loại. Khi bật gửi simulator, HTML có nhãn MÔ PHỎNG, escape dữ liệu động và không suy diễn nồng độ; tắt lại sẽ skip pending simulator jobs.
- Worker có lease/reclaim, bounded retry/backoff/429 retry_after, timeout và TTL. Best effort at-least-once: Telegram sendMessage không có idempotency key, vẫn có thể trùng nếu mất ACK hoặc crash sau khi đã gửi.
- Restore đánh dấu pending/sending jobs `RESTORE_REVIEW_REQUIRED` để không phát lại backup cũ. Xem [runbook](../operations/local-runbook.md#telegram-warningcritical). Chưa xác nhận gửi Telegram thật khi chưa cấu hình bot/chat của người dùng.

## Telegram và incident — lượt 2, 12/11/2026

Tái sử dụng incident/state/ack, presence và PostgreSQL outbox; không thêm broker, dependency hoặc engine xét nguy hiểm. Tách service đọc/ACK dùng chung cho REST và bot; mức hiện tại từ AlertState, mức cao nhất ở incident. ACKNOWLEDGED là cách trình bày acknowledgement, không tạo trạng thái kết thúc giả. Giảm mức/re-escalation có timeline riêng cùng incident; dedup notification vẫn theo incident/severity để hạn chế dao động quanh ngưỡng.

Outbox thêm đích status-history bằng FK nullable và check exactly-one-target. Giữ tham chiếu lịch sử khi maintenance. OFFLINE/ONLINE đi cùng transaction chuyển presence; initial contact không tạo notification. Worker đọc latest presence và incident ngay trước gửi, success-only coalescing, khóa phạm vi incident/device, không thay logic firmware hoặc Web Push enqueue. Telegram không hỗ trợ sendMessage idempotency key nên mất phản hồi sau giao tin vẫn có thể gây trùng; không tuyên bố exactly-once.

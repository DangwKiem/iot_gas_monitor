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
- Online/offline tính từ last_seen ở mỗi GET, polling 5 giây. Chưa có status history/job phát sự kiện presence.

## Các hạng mục chưa hoàn thành

- Alert incident/event history, acknowledgement, audit và status history.
- Heartbeat/config endpoints, config version workflow.
- Credential list/expiry và UI quản trị key đầy đủ (API revoke key đã có).
- Analytics theo khoảng thời gian, CSV và aggregation/retention jobs.
- User management ngoài admin bootstrap, đổi mật khẩu.
- OpenAPI chi tiết cho toàn bộ roadmap, backup/restore automation, CI.
- HIL, tải/soak dài hạn, firmware và cloud.

Dashboard cảnh báo hiện tại chỉ hiển thị snapshot và ghi rõ có thể là dữ liệu cũ; không giả lịch sử hay nút acknowledge chưa được triển khai.

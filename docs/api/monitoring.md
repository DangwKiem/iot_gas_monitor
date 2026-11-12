# Monitoring v0.6

Đường dẫn bên dưới có prefix `/api/v1`. OpenAPI tại `/openapi.json`; schemas thực thi trong `packages/contracts/src`. Web dùng session cookie và `X-Requested-With: AirGuard` cho mutation. Device endpoints chỉ dùng `Authorization: DeviceKey <key_id>.<secret>`.

## Thiết bị và key

- `GET /devices?archived=false|true|all`: tối đa 100 thiết bị; mặc định không gồm lưu trữ.
- `GET /devices/:id`: metadata, source, latest, last_seen và trạng thái; đọc được dữ liệu thiết bị lưu trữ.
- `PATCH /devices/:id` (admin): `name`, `location`, `description`, `archived`. Source bất biến. Không hard-delete lịch sử.
- `GET /devices/:id/credentials` (admin): chỉ metadata, `limit` 1–100 (mặc định 30), `cursor` là key_id từ `meta.next_cursor`. Có trạng thái active/expired/revoked và last_used, không trả hash/secret.
- `POST /devices/:id/credentials` (admin): `{ "label": "ESP32", "expires_at": "...UTC..." }`; label/expiry không bắt buộc. Chỉ trả key lúc tạo. Tối đa 20 key hoạt động/thiết bị.
- `POST /devices/:id/credentials/:keyId/rotate` (admin): cùng payload, thêm `overlap_minutes` 1–1440 (mặc định 60). Tạo key mới; hạn key cũ là min(hạn hiện tại, now + overlap). Cần tự cài key mới cho thiết bị, không tự chuyển secret.
- `DELETE /devices/:id/credentials/:keyId` (admin): thu hồi, idempotent. Expiry/revoke kiểm tra trên mỗi request. Thiết bị lưu trữ bị chặn dù key còn hiệu lực; khôi phục không hồi sinh key đã hết hạn/thu hồi.

Các thay đổi quản trị và xác nhận sự cố ghi audit log trong cùng transaction. Audit không chứa raw key. Chưa có màn hình audit riêng.

## Cấu hình có version

1. `GET /devices/:id/config`: desired, applied_version, 100 versions và 100 ACK gần nhất.
2. `PUT /devices/:id/config` (admin): `{ "expected_version": 1, "config": { "reporting_interval_ms": 10000 } }`. Mỗi lần lưu tạo version mới bất biến; expected_version cũ trả 409, không ghi đè thay đổi người khác.
3. `GET /device/config`: device tải `{version,config,content_hash}`. `If-None-Match` với ETag đã nhận trả 304 nếu không đổi. Hash SHA-256 của JSON canonical theo thứ tự field trong schema: `{"reporting_interval_ms":10000}`.
4. `POST /device/config/ack`: `{ "version": 2, "content_hash": "<64 hex>", "status": "applied", "reason": "" }`. Version/hash phải tồn tại/khớp. `status` có thể `rejected`; retry cùng device/version/status không tạo ACK mới. ACK applied cũ không làm giảm applied_version. ACK là báo cáo từ thiết bị, không phải bằng chứng kiểm thử phần cứng.

Cấu hình hỗ trợ chu kỳ **1–60 giây** và trường `alert_policy` tùy chọn với ngưỡng ADC. Cấu hình cũ chỉ có chu kỳ gửi giữ nguyên định dạng/hash. Khi cập nhật riêng chu kỳ, server giữ policy đang có. Firmware 0.3.0 và simulator kiểm tra hash của JSON canonical, áp dụng và ACK; firmware lưu cấu hình vào NVS trước ACK.

```json
{
  "reporting_interval_ms": 5000,
  "alert_policy": {
    "gas": { "warning_on": 3200, "warning_off": 2900, "critical_on": 3700, "critical_off": 3400 },
    "co": { "warning_on": 1000, "warning_off": 900, "critical_on": 1500, "critical_off": 1300 },
    "flame": { "alarm_on": 1000, "alarm_off": 1500, "active_below": true }
  }
}
```

ADC trong khoảng 0–4094. Gas/CO cần `warning_off < warning_on ≤ critical_off < critical_on`. Flame cần `alarm_on < alarm_off` nếu active_below, hoặc chiều ngược lại nếu active-high. Không suy ra PPM/AQI từ các ngưỡng ADC. Cấu hình không có lệnh tắt còi hoặc thay heater.

Telemetry nhận thêm snapshot `warning` và `critical`, cùng các giá trị cũ `active`, `normal`, `unknown`, `not_configured`. Snapshot `active` cũ vẫn có severity gas/CO warning, Flame critical. Các mức mới cập nhật severity hiện tại; incident giữ mức cao nhất và thêm sự kiện `escalated` khi tăng Warning → Critical. Hàng đợi Telegram/Web Push được enqueue trong cùng transaction và dedup theo incident/severity. Snapshot lỗi/unknown không kết thúc incident. `/alerts/states` giữ state active cho client cũ và bổ sung severity hiện tại.

## Kết nối

`POST /device/heartbeat` nhận `schema_version:1`, `device_id`, `boot_id`, `boot_counter`, `uptime_ms`, `firmware_version`; counter/uptime là chuỗi số như telemetry. Không tạo bản ghi sensor hoặc làm mới giá trị sensor cũ. Telemetry, heartbeat, event và config ACK thành công cập nhật last_seen.

Ngưỡng offline là **max(30 giây, 3 × chu kỳ đã áp dụng)**. Reconciler local chạy mỗi 5 giây; GET danh sách cũng reconcile. Lưu thời điểm hiệu lực và lúc server phát hiện trong `GET /devices/:id/status-history` (cursor/limit). Sau thời gian server ngừng chạy chỉ biết lúc timeout lý thuyết và lúc quan sát lại, không tái tạo mọi lần reconnect đã bỏ lỡ. Online không có nghĩa cảm biến hợp lệ.

## Sự cố và event

- `GET /alerts/incidents`: lọc `device_id`, `condition=gas|co|flame`, `severity=warning|critical`, `status=active|ended`, `acknowledged=true|false`, `from/to`; phân trang theo thứ tự tạo giảm dần với cursor, limit 1–100 (mặc định 30).
- `GET /alerts/incidents/:id`: timeline theo boot/sequence, thời điểm đo và server nhận, acknowledgement.
- `POST /alerts/incidents/:id/acknowledgements` (operator/admin): `{ "note": "Đã kiểm tra" }`, tối đa 500 ký tự. Xác nhận cấp incident; lần đầu thắng ngay cả khi gửi đồng thời. Lưu người/thời gian/ghi chú, **không tắt còi hoặc kết thúc sự cố**.
- `GET /alerts/states?device_id=...`: trạng thái quan sát và unresolved; unknown/not_configured/mất kết nối không tự kết thúc incident.
- `GET /alerts/events`: event log theo server nhận giảm dần; bộ lọc condition/severity/status áp dụng qua incident. Dùng cursor/limit như incidents; `from/to` theo received_at.

### Snapshot tương thích contract cũ

Snapshot active mới mở một incident cho mỗi device/condition; normal mới kết thúc. Snapshot normal trong khi sensor invalid/warming_up/heating được coi unknown, không đóng incident. Không dùng ADC để tự phát hiện ngưỡng gas/CO. Flame mặc định critical, gas/CO warning chỉ là nhãn vận hành, không phải kết luận nồng độ. Snapshot cũ/duplicate không mở lại sự cố. Trạng thái active chưa có ended được hiển thị **chưa kết thúc**, không khẳng định nguy hiểm hiện tại khi thiết bị offline.

Nếu firmware có durable events, thêm `alert_snapshot.incident_ids` ví dụ `{ "flame": "<incident UUID>" }`. Cùng ID phải được giữ qua retry, snapshot và event của một sự cố; mỗi sự cố mới dùng ID mới. Không tái sử dụng ID giữa gas/co/flame. Khi chuyển từ snapshot không có ID sang events, server chỉ tự liên kết nếu boot/sequence bắt đầu khớp; trường hợp mơ hồ trả 409 thay vì đoán.

### Event gửi bù khi offline

`POST /device/events`:

```json
{
  "schema_version": 1,
  "device_id": "<device UUID>",
  "events": [
    {
      "event_id": "<event UUID>",
      "incident_id": "<incident UUID>",
      "condition": "flame",
      "severity": "critical",
      "transition": "started",
      "boot_id": "<boot UUID>",
      "boot_counter": "1",
      "seq": "42",
      "occurred_at": "2026-10-18T08:00:00.000Z"
    }
  ]
}
```

- 1–50 events, giới hạn body 64 KiB. Transition `started|ended`. Retry giữ nguyên event_id và toàn bộ event; đổi nội dung trả 409 và rollback cả batch. Mỗi transition của một incident chỉ có một durable event_id.
- Event cùng incident có thể đến ended trước started; server giữ incident ended và bổ sung started sau, không mở lại. Sắp thứ tự gửi theo occurrence khi có thể. Nếu có incident khác đang mở cùng điều kiện, cần gửi ended của nó trước started của incident mới; server không tự ghép các ID khác nhau.
- `occurred_at` UTC hoặc null khi chưa đồng bộ. Nếu có timestamp: không cũ hơn 24 giờ, không tương lai quá 60 giây. Start không được sau end. Counter/seq theo signed BIGINT; boot identity không được mâu thuẫn boot hiện tại.
- ACK `data.accepted[]` trả event_id/duplicate sau commit. Log sự cố durable trong PostgreSQL; Socket.IO chỉ báo refetch, không phải hàng đợi event bền.
- Snapshot fallback không thể tái dựng sự cố ngắn không có mẫu trong lúc offline. Migration không dựng incident giả từ telemetry cũ; lịch sử mới bắt đầu khi nhận snapshot/event sau nâng cấp.

## Lịch sử, analytics và CSV

Khoảng thời gian **[from,to)** là UTC ISO-8601, phải có đủ hai đầu và tối đa 90 ngày. Giao diện nhập giờ local rồi đổi UTC. `time_basis=sampled` mặc định, hoặc `received`. Mẫu chưa đồng bộ thời gian bị loại khi lọc sampled, vẫn có thể tra received. History không truyền from/to vẫn trả dữ liệu gần nhất.

- `GET /devices/:id/readings`: from/to/time_basis, cursor và limit 1–1000 (mặc định 120). Thứ tự ID nhận giảm dần, không phải thời điểm đo. Bao gồm mẫu lỗi để đối soát.
- `GET /devices/:id/analytics`: bắt buộc from/to; `metric=temperature_c|humidity_pct|mq2_adc|mq7_adc`, `bucket=minute|hour|day` UTC; `compare=previous` tùy chọn để so với kỳ trước cùng độ dài. Tối đa khoảng 2000 buckets. Trả min/max/average, total/valid/invalid_count và series. Không có mẫu dùng null, không giả 0; UI hiển thị gap cho bucket thiếu mẫu.
- Thống kê chỉ tính giá trị khác null có quality valid/uncalibrated; invalid/warming_up/heating bị loại. `uncalibrated` cho phép xem ADC thô, không cho phép suy ra nồng độ. Nếu có nhiều adc_bits, trả 409; chọn `adc_bits=12` (8–16) để lọc profile. Không so ADC giữa các thiết bị; độ phân giải giống nhau không đảm bảo calibration/điện áp tham chiếu giống nhau.
- `GET /devices/:id/readings/export`: bắt buộc from/to, cùng time_basis; xuất **mọi sensor**, không chỉ metric đang chọn. UTF-8 BOM, CSV có quote/escape, công thức nguy hiểm được prefix dấu `'`. Tối đa 100.000 dòng, quá giới hạn trả 413 trước khi gửi file. Stream theo trang 1000 dòng trong snapshot transaction tối đa 60 giây; nếu stream gián đoạn phải tải lại.
- CSV giữ unit trong tên cột (°C, %RH, ADC và bit), quality/age, timestamp UTC, source_kind, boot/seq, firmware/config version. Không có PPM/AQI. Metadata, dữ liệu simulator và mẫu lỗi không bị tráo thành dữ liệu đo thật.

## Giới hạn còn lại

### Tài khoản và audit v0.3

- `GET /users/me`: tài khoản hiện tại, không có hash/password.
- `PATCH /users/me`: `{email,current_password}`, email chuẩn hóa; thu hồi toàn bộ session/socket.
- `PUT /users/me/password`: `{current_password,new_password}`, mật khẩu mới 12–128 ký tự; 204, thu hồi toàn bộ session/socket và cần đăng nhập lại.
- `GET /users` (admin): cursor UUID/limit 1–100, mặc định 30.
- `POST /users` (admin): `{email,password,role}`; role mặc định viewer, email trùng trả 409.
- `PATCH /users/:id` (admin): role/active/password tùy chọn; ít nhất một trường. Không cho tự khóa/hạ quyền, không được làm mất admin cuối cùng; thay đổi thu hồi sessions.
- `GET /audit-logs` (admin): cursor BIGINT/limit, lọc resource_type/resource_id/device_id/action. Chỉ metadata được chọn, không trả passwords/key secrets.

### Retention v0.3

Analytics tự kết hợp raw còn lưu và rollup của raw đã xóa, trả `uses_rollups`. Khi có rollup, from/to cần căn đầu phút/giờ theo resolution; không thể tính chính xác một phần bucket đã mất raw. CSV trả 409 nếu khoảng đã được tổng hợp để tránh file thiếu. History là raw-only; cảnh báo giới hạn giữ dữ liệu nằm trong runbook.

Maintenance mặc định dry-run, apply cần backup mã hóa xác thực cùng DB trong 24 giờ. Raw 14 ngày (giữ latest), rollup phút 90 ngày/giờ 365 ngày, audit 180 ngày/status 365 ngày; incident/event/ack giữ nguyên để không tự xóa chứng cứ. Công cụ backup/restore và cách chạy tại [runbook](../operations/local-runbook.md).

### Telegram v0.4

Warning/critical gửi qua outbox PostgreSQL khi bật `TELEGRAM_ENABLED` và cấu hình bot token/chat ID. Một outbox entry cho mỗi incident/mức thông báo (warning, critical, resolved), không gửi mỗi sample hoặc acknowledge; simulator phải opt-in riêng. Tin HTML gọn, giờ Việt Nam, đọc lại trạng thái trước mỗi lần gửi; các job đã được bản tóm tắt thành công bao phủ được giữ trong outbox với trạng thái skipped. Queue cùng transaction với incident, worker gửi sau commit; lỗi Telegram không đổi ACK ingest. Không thêm REST endpoint hoặc inbound webhook cho bot. Xem [runbook](../operations/local-runbook.md#telegram-warningcritical) cho retry/expiry/secret handling và giới hạn at-least-once.

Chưa có firmware/HIL, chính sách cảnh báo phần cứng được nghiệm thu, email/SMS, dịch vụ push khác ngoài Telegram hoặc cloud. Không tự cài scheduler OS, không auto-purge DB development và không tự xóa backup. Các kiểm thử local không thay thế soak/load dài hạn hay chứng nhận an toàn.

## Web Push (tùy chọn)

- `GET /api/v1/push/config`: yêu cầu phiên; trả `enabled`, `public_key` (hoặc null), `session_bound=true`. Không trả private key.
- `GET /api/v1/push/subscription`: chỉ đăng ký phiên hiện tại hoặc null; trả ID, endpoint hash, simulator opt-in, VAPID public key và session expiry, không trả endpoint/auth keys.
- `POST /api/v1/push/subscription`: body `{subscription:{endpoint,keys:{p256dh,auth},expirationTime:null},application_server_key,include_simulators:false}`. Mọi role đăng nhập được opt-in. Yêu cầu header CSRF/Origin như các web mutation khác. Chỉ provider HTTPS trong allowlist, key P-256 hợp lệ/cặp VAPID hiện hành. Endpoint thuộc phiên còn hiệu lực của tài khoản khác bị từ chối 409; cùng user có thể chuyển sang phiên mới. Tối đa 20 đăng ký/tài khoản.
- `DELETE /api/v1/push/subscription`: idempotent, 204, chỉ phiên hiện tại; browser tự unsubscribe/đóng notifications phía client.
- Warning/critical enqueue trong transaction incident, unique `(incident_id,severity,subscription_id)`, không backfill. Simulator cần opt-in riêng; ACK/recovery không gửi thông báo riêng. Logout/thu hồi session cascade xóa subscription/delivery; hết phiên và đổi VAPID chặn gửi. Provider có thể giao tin đã nhận sau thu hồi.
- Retry/lease/TTL và hướng dẫn cấu hình: xem [README](../../README.md#thông-báo-web-push). Endpoint/auth keys chỉ lưu backend, không log; backup phải mã hóa.

### Telegram Bot tương tác — lượt 1

Các endpoint dùng session/bearer và CSRF/Origin như API web hiện có:

- `GET /api/v1/telegram/link`: `enabled`, `linked`, `bot_username`; không trả chat ID hoặc mã liên kết.
- `POST /api/v1/telegram/link-code`: trả mã một lần và `expires_at`, hiệu lực 5 phút, tối đa 10 lần/phút/tài khoản; bot cần được bật. Mã chỉ được lưu hash và ràng buộc phiên web còn hiệu lực.
- `DELETE /api/v1/telegram/link`: 204, hủy liên kết/mã chờ/menu cũ. Chỉ thao tác trên tài khoản đang xác thực.

`/start`, `/devices`, `/status`, `/alerts`, `/history`, `/chart`, `/report`, `/settings`, `/link`, `/unlink` chạy trong chat riêng qua long polling; không có REST inbound Telegram công khai. Xem runbook cho cấu hình, quyền nhóm hiện có, retry và phạm vi lượt 1.

### Sự cố và Telegram — lượt 2

- Incident REST thêm `current_severity: warning|critical|null` và `lifecycle: ACTIVE|ACKNOWLEDGED|RESOLVED`. Các trường cũ giữ nguyên: `severity` là mức cao nhất, `status` là active/ended. Current null không phải SAFE. ACK không thay status hoặc snapshot/buzzer.
- Timeline thêm transition nội bộ `deescalated`; lần tái tăng mức có thêm `escalated`, vẫn cùng Incident ID. Device durable event contract vẫn chỉ `started|ended`, không đổi firmware/API ingestion.
- Bot `/alerts` và `/history` dùng chung reader/ACK với REST và RBAC một nhóm hiện có. History bot có cửa sổ hoạt động 24 giờ/7 ngày/30 ngày (bắt đầu hoặc kết thúc trong kỳ), device, peak-severity và offset pagination. REST giữ nguyên cursor/date semantics hiện có. Không có endpoint inbound Telegram mới.
- Outbox Telegram đích duy nhất: incident + warning/critical/resolved hoặc status-history + offline/online. DB check constraint/FK bảo vệ phân loại và unique status-history chống lặp. Presence không thay incident. Cùng worker/lease/retry/TTL, đọc lại trạng thái trước gửi và gộp sau thành công.

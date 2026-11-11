# Nạp GasMonitor lên ESP32

Sketch `GasMonitor/GasMonitor.ino` chạy trên ESP32 DevKitC với ESP32-WROOM-32. Có thể đọc Serial, điều khiển LED/còi tại chỗ và gửi telemetry qua Wi-Fi tới API để dashboard hiển thị. Bộ Arduino ESP32 đã dùng để build là 3.3.11, kèm thư viện Adafruit DHT 1.4.7. Các thư viện mạng, Preferences và cJSON có trong bộ ESP32 này.

## Chân theo sơ đồ

| Tín hiệu           | GPIO       | Điều kiện trước khi nối                                                                                                                              |
| ------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| MQ-2 AO            | 34         | Xác minh toàn dải điện áp AO với module cấp 5 V.                                                                                                     |
| MQ-7 AO            | 35         | Xác minh toàn dải điện áp AO với module cấp 5 V.                                                                                                     |
| Flame AO           | 32         | Xác minh toàn dải AO ở nguồn cấp thực tế của module.                                                                                                 |
| DHT11 DATA         | 18         | DATA phải được kéo lên 3,3 V hoặc đi qua mạch chuyển mức phù hợp. Kiểm tra pull-up có sẵn trên module nếu dùng loại 3 chân.                          |
| KY-012 S/PWM       | 25         | Chỉ nối trực tiếp nếu chân S nhận logic 3,3 V và không đưa 5 V về GPIO. Nếu cần tầng driver, xác minh mức kích và đặt `kBuzzerActiveHigh` theo mạch. |
| LED xanh, đỏ, vàng | 27, 14, 13 | Mỗi LED nối tiếp một điện trở 330 Ω như sơ đồ, cathode về GND.                                                                                       |

**Trước khi cấp nguồn theo sơ đồ, tháo dây AO của MQ-2, MQ-7 và Flame, dây DATA của DHT11 và dây S của còi khỏi ESP32 nếu chưa xác minh mức điện áp.** Module cấp 5 V có thể đưa 5 V hoặc gần 5 V lên tín hiệu. Tắt kênh trong phần mềm vẫn để điện áp đi vào chân vật lý. Khi xác minh, cần có căn cứ cho dải tín hiệu trong toàn bộ điều kiện hoạt động, kể cả lúc khởi động. Một lần đo trong không khí bình thường chưa đủ để xác nhận dải AO.

Sketch đo trực tiếp tại GPIO và không dùng cầu chia 10 kΩ/15 kΩ. Nếu AO vượt dải ADC, để dây AO rời ESP32. Để đọc tín hiệu đó mà không dùng cầu chia, cần phần cứng nhận analog đúng dải điện áp của module và có giao tiếp tương thích 3,3 V. Nếu DHT11 thực tế hỗ trợ cấp 3,3 V, có thể dùng 3,3 V cho cả nguồn và pull-up DATA. Kiểm tra nhãn chân trên module thực tế vì thứ tự chân trên các module có thể khác hình. Các mạch tín hiệu cần GND chung.

## Arduino IDE

1. Mở `GasMonitor/GasMonitor.ino`. Trong Boards Manager, cài `esp32 by Espressif Systems`. Trong Library Manager, cài `DHT sensor library by Adafruit` và dependency `Adafruit Unified Sensor`.
2. Chọn **ESP32 Dev Module** và cổng COM của board. Để kiểm tra lần đầu, dùng USB với board và các LED. Kiểm tra các cờ đọc cảm biến, điều khiển còi và kiểu ngõ vào Flame trong `GasMonitor/BenchConfig.h` theo mạch thực tế.
3. Bấm **Upload**, rồi mở **Serial Monitor** ở **115200 baud**. Gửi ký tự `t` để LED đỏ sáng khoảng 300 ms. Còi chỉ được kích nếu đã bật `kDriveBuzzer`.
4. Sau khi xác minh điện áp của từng kênh, tắt nguồn, nối kênh đó, bật cờ tương ứng trong `BenchConfig.h`, rồi nạp lại. Serial báo ADC thô 12 bit và mV tại GPIO mỗi giây. Kênh analog lấy trung bình 20 mẫu, DHT11 cập nhật khoảng 2 giây một lần. `ADC_CLIPPED` báo cửa sổ đo có mẫu chạm trần ADC.

## Kết nối ESP32 với web local

Luồng dữ liệu là ESP32 → API trên máy tính ở cổng 4000 → PostgreSQL → dashboard ở cổng 5173. Máy tính và ESP32 cần liên lạc được trên cùng mạng LAN. ESP32-WROOM-32 dùng Wi-Fi 2,4 GHz.

1. Trong `.env` ở thư mục gốc, đặt `HOST=0.0.0.0`, giữ `PORT=4000` và `WEB_ORIGIN=http://localhost:5173`. Chạy `docker compose up -d postgres`, `npm run db:migrate`, rồi `npm run dev`. Nếu server đang chạy, khởi động lại để nhận HOST mới.
2. Dùng `ipconfig` tìm IPv4 của adapter Wi-Fi có gateway. Ví dụ `192.168.23.103` thì địa chỉ API là `http://192.168.23.103:4000`. Mở `http://192.168.23.103:4000/health/ready` trên điện thoại cùng Wi-Fi để kiểm tra đường mạng trước. Kết quả phải có `data.status` bằng `ready`.
3. Mở `http://localhost:5173` trên máy tính, đăng nhập admin, vào **Thiết bị**. Tạo thiết bị với nguồn dữ liệu **Thiết bị thật**, rồi bấm **Cấp key**. Lưu Device ID và toàn bộ key dạng `key_id.secret` hiển thị một lần.
4. Trong thư mục `GasMonitor`, mở `NetworkConfig.h`. Nếu file chưa có, sao chép `NetworkConfig.example.h` thành `NetworkConfig.h`. Điền cấu hình như ví dụ dưới đây. File `NetworkConfig.h` được Git bỏ qua để giữ thông tin Wi-Fi và key ở máy của bạn.

```cpp
constexpr char kWifiSsid[] = "TEN_WIFI_2_4_GHZ";
constexpr char kWifiPassword[] = "MAT_KHAU_WIFI";
constexpr char kApiBaseUrl[] = "http://192.168.23.103:4000";
constexpr char kDeviceId[] = "DEVICE_ID_LAY_TREN_WEB";
constexpr char kDeviceKey[] = "KEY_ID.SECRET_LAY_TREN_WEB";
constexpr bool kAllowLanHttp = true;
constexpr char kApiRootCa[] = "";
```

5. Bật từng cảm biến đã kiểm tra điện áp trong `BenchConfig.h`, rồi mở `GasMonitor.ino` và Upload lại toàn bộ sketch. Giữ tất cả file `.h` và `.cpp` trong thư mục `GasMonitor` để Arduino IDE biên dịch cùng nhau.
6. Mở Serial Monitor 115200 baud. Khi thành công sẽ có `NET Wi-Fi connected`, `NET config v1, interval 5000 ms` và `NET ACK seq=...`. Trên web, thiết bị chuyển Online và trang chi tiết/Giám sát hiển thị mẫu mới. Cảm biến đang tắt hoặc đọc lỗi hiển thị thiếu dữ liệu.

HTTP LAN truyền DeviceKey dạng rõ và chỉ dành cho mạng riêng tin cậy. Firmware giới hạn HTTP tới IP riêng 10.x, 172.16–31.x hoặc 192.168.x và cần `kAllowLanHttp=true`. Với HTTPS, đặt `kApiBaseUrl` theo hostname chứng chỉ, điền CA PEM vào `kApiRootCa` và cần đồng bộ giờ qua NTP để kiểm tra chứng chỉ. URL cấu hình là gốc API, không có `/api/v1`, dấu `/` cuối hoặc cổng 5173.

### Khi chưa thấy dữ liệu

| Dấu hiệu                                 | Cách kiểm tra                                                                                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NET disabled`                           | Điền `NetworkConfig.h` và Upload lại.                                                                                                                            |
| `NET waiting for Wi-Fi`                  | Kiểm tra SSID, mật khẩu và Wi-Fi 2,4 GHz. Guest Wi-Fi có thể chặn thiết bị liên lạc với nhau.                                                                    |
| Wi-Fi đã kết nối nhưng HTTP âm           | Kiểm tra IPv4 máy tính, cổng 4000, `HOST=0.0.0.0`, server đã restart, Windows Firewall và VPN.                                                                   |
| Điện thoại không mở được `/health/ready` | Cho phép Node.js qua Windows Firewall trên mạng Private hoặc thêm rule TCP 4000 giới hạn LocalSubnet. Chọn mạng gia đình tin cậy là Private.                     |
| HTTP 401                                 | Key sai, hết hạn hoặc bị thu hồi. Lấy toàn bộ `key_id.secret`, không chép thêm tiền tố `DeviceKey `.                                                             |
| HTTP 403                                 | Device ID không khớp key hoặc thiết bị đang lưu trữ.                                                                                                             |
| HTTP 409                                 | Kiểm tra thông báo lỗi API và provisioning. Xóa flash/NVS có thể làm boot counter quay về đầu. Khi reprovision, tạo thiết bị mới hoặc xử lý counter có chủ đích. |
| HTTP 422                                 | Kiểm tra phiên bản firmware/API, Device ID và dữ liệu contract.                                                                                                  |
| HTTP 503                                 | Kiểm tra PostgreSQL và `/health/ready`.                                                                                                                          |
| Online nhưng số đo trống                 | Bật đúng cảm biến trong `BenchConfig.h` sau khi kiểm tra tín hiệu, Upload lại, xem lỗi DHT/ADC trong Serial.                                                     |

Firmware dừng gửi khi gặp 401/403/409/422 để bạn sửa lỗi cấu hình rồi khởi động lại. Lỗi kết nối, 429 và 5xx được retry cùng mẫu với backoff có jitter. Chỉ bỏ mẫu khỏi hàng đợi khi ACK khớp boot ID và sequence.

## Ngưỡng và trạng thái cảnh báo

Firmware 0.3.0 đánh giá số đo cảm biến trực tiếp. Ngưỡng mặc định dùng số đếm ADC 12 bit và được khai báo trong `GasMonitor/AlertPolicy.h`.

| Điều kiện  | Warning | Nhả Warning | Critical | Nhả Critical |
| ---------- | ------- | ----------- | -------- | ------------ |
| Gas / MQ-2 | ≥ 3200  | ≤ 2900      | ≥ 3700   | ≤ 3400       |
| CO / MQ-7  | ≥ 1000  | ≤ 900       | ≥ 1500   | ≤ 1300       |

Flame AO mặc định kích hoạt Critical ở ADC ≤ 1000 và nhả ở ADC ≥ 1500, tương ứng module giảm tín hiệu khi phát hiện lửa. Trên web có thể đổi chiều tín hiệu và ngưỡng theo module thực tế. Các ngưỡng ADC này là cấu hình ban đầu dựa trên tín hiệu đã quan sát, chưa phải ngưỡng nồng độ được hiệu chuẩn. MQ-7 vẫn báo heater `unverified` và gas/CO vẫn có đơn vị ADC.

Vào **Thiết bị → Chi tiết thiết bị → Cấu hình thiết bị** để chỉnh ngưỡng và chu kỳ gửi. Firmware kiểm tra SHA-256, lưu cấu hình vào NVS rồi xác nhận. Thay ngưỡng trên web được thiết bị lấy lại khoảng 5 giây một lần khi kết nối hoạt động. Khi khởi động mất mạng, thiết bị dùng cấu hình đã lưu. Cấu hình chỉ có chu kỳ gửi từ các phiên bản trước vẫn được hỗ trợ và dùng các ngưỡng mặc định trên.

| Trạng thái tại thiết bị                       | LED            | Còi khi đã bật điều khiển |
| --------------------------------------------- | -------------- | ------------------------- |
| Có dữ liệu hợp lệ, chưa kích hoạt             | Xanh           | Tắt                       |
| Warning                                       | Vàng           | Ngắt quãng                |
| Critical hoặc phát hiện lửa                   | Đỏ             | Liên tục                  |
| Thiếu/lỗi cảm biến, chưa có cảnh báo đang giữ | Vàng nhấp nháy | Tắt                       |

Lỗi cảm biến giữ cảnh báo cục bộ đang có cho tới khi xuất hiện mẫu hợp lệ đạt ngưỡng nhả. Web đánh dấu dữ liệu thiếu và giữ sự cố chưa kết thúc. Warning tăng lên Critical sẽ nâng mức cùng sự cố, thêm lịch sử và enqueue thông báo mức mới. Khi giảm về Warning, mức hiện tại giảm theo; lịch sử vẫn giữ mức cao nhất của sự cố. Xác nhận đã xem độc lập với việc kết thúc cảnh báo.

## Flame đang báo ADC_CLIPPED

Trong log đã cung cấp, ngõ AO của Flame liên tục chạm trần ADC. Kiểm tra điện áp AO trước khi đặt ngưỡng hoặc tiếp tục nối GPIO32. Phần mềm cần một tín hiệu nằm trong dải điện áp được ESP32 hỗ trợ.

Firmware cũng hỗ trợ đầu ra số D0 của module Flame. Nếu module thực tế hỗ trợ nguồn 3,3 V và D0 có mức điện tương thích ESP32, có thể dùng cách nối sau.

1. Tắt nguồn. Tháo dây AO khỏi GPIO32.
2. Cấp nguồn module Flame bằng 3,3 V theo thông số module, GND chung, nối D0 vào GPIO32.
3. Đặt `kFlameUseDigital = true` trong `BenchConfig.h`. Đặt `kFlameActiveLow` theo polarity D0 của module, mặc định là true.
4. Nạp lại firmware. D0 được lọc ổn định 50 ms và tín hiệu phát hiện lửa tạo Critical. Ngưỡng AO trên web chỉ áp dụng khi dùng ngõ analog.

Không đổi cờ sang digital khi vẫn giữ dây AO. Không nối tín hiệu kéo lên 5 V vào GPIO32. Nếu module cần 5 V và D0 cũng lên 5 V, cần giao tiếp chuyển mức phù hợp.

## Hành vi truyền dữ liệu

- Cảm biến/LED/còi và tác vụ mạng chạy độc lập. Mỗi lần đổi mức cảnh báo sẽ enqueue mẫu ngay, ngoài chu kỳ gửi định kỳ.
- Hàng đợi RAM giữ tối đa 12 mẫu chờ và 1 mẫu đang gửi. Khi đầy, Serial ghi sequence bị mất. Khởi động lại sẽ mất hàng đợi RAM. Mẫu quá 24 giờ bị bỏ theo cửa sổ API.
- Boot counter tăng và ghi NVS trước khi kết nối. Boot ID mới mỗi lần khởi động. Retry giữ nguyên nội dung reading và chỉ cập nhật uptime của transmission.
- Khi đã có giờ NTP, firmware gửi thời điểm đo UTC. Trước khi đồng bộ, mẫu có `sampled_at=null`, `time_quality=unsynced`; API xác định tuổi theo uptime.
- Mẫu lỗi gửi null cùng quality. ADC chạm trần vẫn được báo lỗi. Firmware không suy ra nồng độ PPM/AQI từ ADC.
- Thông báo Telegram/Web Push được xử lý bởi backend theo cấu hình trong README gốc. Firmware gửi mức warning/critical của từng điều kiện; Flame phát hiện luôn là critical.

Tham chiếu phần cứng. [GPIO ESP32](https://documentation.espressif.com/esp32_datasheet_en.html) · [Dải ADC Arduino ESP32](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/adc.html) · [MQ-7 Winsen](https://cdn.sparkfun.com/datasheets/Sensors/Biometric/MQ-7%20Ver1.3%20-%20Manual.pdf)

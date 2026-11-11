#include "TelemetryNetwork.h"
#include "AlertPolicyJson.h"

#include <Arduino.h>
#include <HTTPClient.h>
#include <NetworkClientSecure.h>
#include <Preferences.h>
#include <WiFi.h>
#include <cctype>
#include <cJSON.h>
#include <esp_random.h>
#include <esp_timer.h>
#include <mbedtls/sha256.h>

#if __has_include("NetworkConfig.h")
#include "NetworkConfig.h"
#else
#include "NetworkConfig.example.h"
#endif

namespace {
constexpr uint64_t kMaxSampleAgeMs = 86400000;
constexpr uint64_t kMaxCounter = 9223372036854775807ULL;
QueueHandle_t sampleQueue = nullptr;
portMUX_TYPE configurationMux = portMUX_INITIALIZER_UNLOCKED;
TelemetryConfiguration activeConfiguration;
char bootId[37];
uint64_t bootCounter = 0;
uint64_t sequence = 0;
bool stopped = false;

uint64_t uptimeMs() {
  return static_cast<uint64_t>(esp_timer_get_time()) / 1000;
}

bool validDeviceId(const char* text) {
  if (strlen(text) != 36) return false;
  for (int i = 0; i < 36; ++i) {
    const bool separator = i == 8 || i == 13 || i == 18 || i == 23;
    if (separator ? text[i] != '-' : !isxdigit(static_cast<unsigned char>(text[i]))) return false;
  }
  return true;
}

bool validKey(const char* key) {
  if (strlen(key) != 60 || key[16] != '.') return false;
  for (int i = 0; i < 60; ++i) {
    if (i == 16) continue;
    const unsigned char c = key[i];
    if (!isalnum(c) && c != '_' && c != '-') return false;
  }
  return true;
}

bool validApiUrl() {
  const String url(kApiBaseUrl);
  const bool https = url.startsWith("https://");
  if (!https && !url.startsWith("http://")) return false;
  const String authority = url.substring(https ? 8 : 7);
  if (authority.isEmpty() || authority.indexOf('/') >= 0 || authority.indexOf('@') >= 0 ||
      authority.indexOf('?') >= 0 || authority.indexOf('#') >= 0 ||
      authority.indexOf(' ') >= 0 || authority.indexOf('\r') >= 0 || authority.indexOf('\n') >= 0) return false;
  if (https) return strlen(kApiRootCa) > 0;
  if (!kAllowLanHttp) return false;
  const int portAt = authority.indexOf(':');
  const String host = portAt < 0 ? authority : authority.substring(0, portAt);
  IPAddress ip;
  if (!ip.fromString(host)) return false;
  return ip[0] == 10 || (ip[0] == 172 && ip[1] >= 16 && ip[1] <= 31) ||
         (ip[0] == 192 && ip[1] == 168);
}

int apiRequest(const char* path, const char* body, String& response) {
  NetworkClient plainClient;
  NetworkClientSecure secureClient;
  HTTPClient http;
  const bool https = String(kApiBaseUrl).startsWith("https://");
  NetworkClient* client = &plainClient;
  if (https) {
    secureClient.setCACert(kApiRootCa);
    secureClient.setHandshakeTimeout(5);
    client = &secureClient;
  }
  if (!http.begin(*client, String(kApiBaseUrl) + path)) return -1;
  http.setConnectTimeout(3000);
  http.setTimeout(3000);
  http.useHTTP10(true);
  http.setReuse(false);
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
  http.addHeader("Authorization", String("DeviceKey ") + kDeviceKey);
  int status;
  if (body) {
    http.addHeader("Content-Type", "application/json");
    status = http.POST(String(body));
  } else {
    status = http.GET();
  }
  // Express JSON responses have Content-Length. Bound allocation for error responses too.
  const int length = http.getSize();
  if (status > 0 && length >= 0 && length <= 4096) response = http.getString();
  http.end();
  return status;
}

void checkFatalStatus(int status) {
  if (status == 401 || status == 403 || status == 409 || status == 422) {
    stopped = true;
    Serial.printf("NET STOP HTTP %d: check device ID/key, archive status and boot identity; restart after fixing.\n", status);
  }
}

bool syncConfig() {
  String response;
  const int status = apiRequest("/api/v1/device/config", nullptr, response);
  if (status != 200) {
    checkFatalStatus(status);
    Serial.printf("NET config HTTP %d\n", status);
    return false;
  }
  cJSON* root = cJSON_Parse(response.c_str());
  const cJSON* data = cJSON_GetObjectItemCaseSensitive(root, "data");
  const cJSON* version = cJSON_GetObjectItemCaseSensitive(data, "version");
  const cJSON* config = cJSON_GetObjectItemCaseSensitive(data, "config");
  const char* hash = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(data, "content_hash"));
  TelemetryConfiguration parsed;
  const bool valid = cJSON_IsNumber(version) && version->valuedouble == version->valueint &&
                     version->valueint >= telemetryConfiguration().version && hash && strlen(hash) == 64 &&
                     parseTelemetryConfiguration(config, version->valueint, parsed);
  if (!valid) {
    cJSON_Delete(root);
    Serial.println("NET invalid config response");
    return false;
  }
  char* canonical = canonicalConfiguration(parsed, cJSON_HasObjectItem(config, "alert_policy"));
  if (!canonical) {
    cJSON_Delete(root);
    return false;
  }
  unsigned char digest[32];
  char calculatedHash[65];
  const int hashed = mbedtls_sha256(reinterpret_cast<const unsigned char*>(canonical), strlen(canonical), digest, 0);
  if (hashed != 0) {
    cJSON_free(canonical);
    cJSON_Delete(root);
    return false;
  }
  for (int i = 0; i < 32; ++i) snprintf(calculatedHash + i * 2, 3, "%02x", digest[i]);
  if (strcmp(hash, calculatedHash) != 0) {
    cJSON_free(canonical);
    cJSON_Delete(root);
    Serial.println("NET config hash mismatch");
    return false;
  }
  const String saved = String("{\"version\":") + parsed.version + ",\"config\":" + canonical + "}";
  cJSON_free(canonical);
  Preferences preferences;
  if (!preferences.begin("airguard", false)) {
    cJSON_Delete(root);
    return false;
  }
  const bool persisted = preferences.getString("configuration") == saved ||
                         preferences.putString("configuration", saved) == saved.length();
  preferences.end();
  if (!persisted) {
    cJSON_Delete(root);
    Serial.println("NET cannot persist alert configuration");
    return false;
  }
  portENTER_CRITICAL(&configurationMux);
  activeConfiguration = parsed;
  portEXIT_CRITICAL(&configurationMux);
  char ack[160];
  snprintf(ack, sizeof(ack), "{\"version\":%d,\"content_hash\":\"%s\",\"status\":\"applied\"}",
           version->valueint, calculatedHash);
  cJSON_Delete(root);
  response = "";
  const int ackStatus = apiRequest("/api/v1/device/config/ack", ack, response);
  checkFatalStatus(ackStatus);
  if (ackStatus != 200) return false;
  cJSON* ackRoot = cJSON_Parse(response.c_str());
  const cJSON* ackData = cJSON_GetObjectItemCaseSensitive(ackRoot, "data");
  const bool accepted = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(ackData, "accepted"));
  cJSON_Delete(ackRoot);
  if (!accepted) return false;
  Serial.printf("NET config v%d, interval %lu ms\n", parsed.version, static_cast<unsigned long>(parsed.intervalMs));
  return true;
}

void networkTask(void*) {
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(kWifiSsid, kWifiPassword);
  bool connected = false;
  bool haveSample = false;
  bool configSynced = false;
  TelemetrySample pending;
  uint64_t lastWifiAttempt = uptimeMs();
  uint64_t nextConfigAt = 0;
  uint64_t nextUploadAt = 0;
  uint32_t backoffMs = 1000;
  while (true) {
    vTaskDelay(pdMS_TO_TICKS(50));
    if (stopped) continue;
    const uint64_t now = uptimeMs();
    if (WiFi.status() != WL_CONNECTED) {
      if (connected) Serial.println("NET Wi-Fi disconnected; local monitoring continues");
      connected = false;
      if (now - lastWifiAttempt >= 15000) {
        WiFi.reconnect();
        lastWifiAttempt = now;
        Serial.println("NET waiting for Wi-Fi");
      }
      continue;
    }
    if (!connected) {
      connected = true;
      Serial.printf("NET Wi-Fi connected, ESP32 IP=%s\n", WiFi.localIP().toString().c_str());
      configTime(0, 0, "pool.ntp.org", "time.google.com");
      nextConfigAt = 0;
    }
    // TLS certificate validation also checks certificate validity dates.
    if (String(kApiBaseUrl).startsWith("https://") && time(nullptr) < 1735689600) continue;
    if (now >= nextConfigAt) {
      const bool synced = syncConfig();
      if (synced) configSynced = true;
      nextConfigAt = uptimeMs() + (synced ? 5000 : 10000);
    }
    if (!configSynced || stopped) continue;
    if (!haveSample) haveSample = xQueueReceive(sampleQueue, &pending, 0) == pdTRUE;
    const uint64_t uploadNow = uptimeMs();
    if (!haveSample || uploadNow < nextUploadAt) continue;
    if (uploadNow - pending.uptimeMs > kMaxSampleAgeMs) {
      Serial.printf("NET dropped expired seq=%llu\n", static_cast<unsigned long long>(pending.sequence));
      haveSample = false;
      continue;
    }
    char* body = encodeTelemetry(pending, kDeviceId, bootId, bootCounter, uptimeMs());
    if (!body) {
      nextUploadAt = now + 1000;
      continue;
    }
    String response;
    const int status = apiRequest("/api/v1/device/telemetry", body, response);
    cJSON_free(body);
    if (status == 200 && telemetryAcknowledged(response.c_str(), bootId, pending.sequence)) {
      Serial.printf("NET ACK seq=%llu\n", static_cast<unsigned long long>(pending.sequence));
      haveSample = false;
      backoffMs = 1000;
      nextUploadAt = 0;
    } else {
      checkFatalStatus(status);
      Serial.printf("NET telemetry HTTP %d; keeping seq=%llu for retry\n", status,
                    static_cast<unsigned long long>(pending.sequence));
      nextUploadAt = uptimeMs() + backoffMs + esp_random() % 500;
      backoffMs = min(backoffMs * 2, static_cast<uint32_t>(60000));
    }
  }
}
}

void startTelemetryNetwork() {
  Preferences stored;
  if (stored.begin("airguard", true)) {
    const String saved = stored.getString("configuration");
    stored.end();
    cJSON* root = cJSON_Parse(saved.c_str());
    const cJSON* version = cJSON_GetObjectItemCaseSensitive(root, "version");
    TelemetryConfiguration restored;
    if (cJSON_IsNumber(version) && version->valuedouble == version->valueint &&
        parseTelemetryConfiguration(cJSON_GetObjectItemCaseSensitive(root, "config"), version->valueint, restored)) {
      activeConfiguration = restored;
    }
    cJSON_Delete(root);
  }

  if (!strlen(kWifiSsid) || !strlen(kDeviceId) || !strlen(kDeviceKey)) {
    Serial.println("NET disabled: fill NetworkConfig.h, then upload again");
    return;
  }
  if (!validDeviceId(kDeviceId) || !validKey(kDeviceKey) || !validApiUrl()) {
    Serial.println("NET invalid configuration: check ID/key and API URL without trailing slash");
    return;
  }
  Preferences preferences;
  if (!preferences.begin("airguard", false)) {
    Serial.println("NET cannot open boot counter storage");
    return;
  }
  if (preferences.isKey("boot_counter") && preferences.getType("boot_counter") != PT_U64) {
    preferences.end();
    Serial.println("NET invalid boot counter storage; check provisioning");
    return;
  }
  const uint64_t previous = preferences.getULong64("boot_counter", 0);
  if (previous >= kMaxCounter || preferences.putULong64("boot_counter", previous + 1) != sizeof(uint64_t)) {
    preferences.end();
    Serial.println("NET cannot persist boot counter");
    return;
  }
  bootCounter = previous + 1;
  preferences.end();
  uint8_t bytes[16];
  esp_fill_random(bytes, sizeof(bytes));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  snprintf(bootId, sizeof(bootId), "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
           bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
           bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]);
  sampleQueue = xQueueCreate(12, sizeof(TelemetrySample));
  if (!sampleQueue) {
    Serial.println("NET cannot allocate telemetry queue");
    return;
  }
  if (xTaskCreate(networkTask, "airguard-network", 12288, nullptr, 1, nullptr) != pdPASS) {
    vQueueDelete(sampleQueue);
    sampleQueue = nullptr;
    Serial.println("NET cannot start network worker");
  }
}

void enqueueTelemetry(TelemetrySample sample) {
  if (!sampleQueue) return;
  sample.sequence = ++sequence;
  if (xQueueSend(sampleQueue, &sample, 0) != pdTRUE) {
    Serial.printf("NET queue full, dropped seq=%llu\n", static_cast<unsigned long long>(sample.sequence));
  }
}

uint32_t telemetryIntervalMs() {
  return telemetryConfiguration().intervalMs;
}

TelemetryConfiguration telemetryConfiguration() {
  portENTER_CRITICAL(&configurationMux);
  const TelemetryConfiguration current = activeConfiguration;
  portEXIT_CRITICAL(&configurationMux);
  return current;
}

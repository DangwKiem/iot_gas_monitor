#include "TelemetryProtocol.h"

#include <cJSON.h>
#include <cmath>
#include <cstdio>
#include <cstring>

namespace {
bool addCounter(cJSON* object, const char* name, uint64_t value) {
  char text[21];
  snprintf(text, sizeof(text), "%llu", static_cast<unsigned long long>(value));
  return cJSON_AddStringToObject(object, name, text) != nullptr;
}

bool addGas(cJSON* sensors, const char* name, const GasSignal& signal) {
  cJSON* sensor = cJSON_AddObjectToObject(sensors, name);
  bool ok = sensor != nullptr;
  const bool valid = signal.valid && signal.raw >= 0 && signal.raw < 4095 &&
                     signal.millivolts <= 3300;
  if (valid) {
    ok &= cJSON_AddNumberToObject(sensor, "adc_raw", signal.raw) != nullptr;
    ok &= cJSON_AddNumberToObject(sensor, "adc_pin_mv", signal.millivolts) != nullptr;
  } else {
    ok &= cJSON_AddNullToObject(sensor, "adc_raw") != nullptr;
    ok &= cJSON_AddNullToObject(sensor, "adc_pin_mv") != nullptr;
  }
  ok &= cJSON_AddNumberToObject(sensor, "adc_bits", 12) != nullptr;
  ok &= cJSON_AddStringToObject(sensor, "quality", valid ? "uncalibrated" : "invalid") != nullptr;
  ok &= cJSON_AddNumberToObject(sensor, "age_ms", signal.ageMs) != nullptr;
  ok &= cJSON_AddNullToObject(sensor, "concentration_ppm") != nullptr;
  return ok;
}
}

namespace {
bool addReading(cJSON* readings, const TelemetrySample& sample,
                const char* bootId, uint64_t bootCounter) {
  bool ok = true;
  cJSON* reading = cJSON_CreateObject();
  if (!reading || !cJSON_AddItemToArray(readings, reading)) {
    cJSON_Delete(reading);
    return false;
  }
  ok &= cJSON_AddStringToObject(reading, "boot_id", bootId) != nullptr;
  ok &= addCounter(reading, "boot_counter", bootCounter);
  ok &= addCounter(reading, "seq", sample.sequence);
  if (sample.sampledAt[0]) {
    ok &= cJSON_AddStringToObject(reading, "sampled_at", sample.sampledAt) != nullptr;
  } else {
    ok &= cJSON_AddNullToObject(reading, "sampled_at") != nullptr;
  }
  ok &= addCounter(reading, "uptime_ms", sample.uptimeMs);
  ok &= cJSON_AddStringToObject(reading, "time_quality", sample.sampledAt[0] ? "synced" : "unsynced") != nullptr;
  ok &= cJSON_AddStringToObject(reading, "firmware_version", kFirmwareVersion) != nullptr;
  ok &= cJSON_AddNumberToObject(reading, "config_version", sample.configVersion) != nullptr;
  cJSON* sensors = cJSON_AddObjectToObject(reading, "sensors");
  cJSON* dht = cJSON_AddObjectToObject(sensors, "dht11");
  const bool dhtValid = sample.dhtValid && std::isfinite(sample.temperature) &&
                        std::isfinite(sample.humidity) && sample.temperature >= -40 &&
                        sample.temperature <= 125 && sample.humidity >= 0 && sample.humidity <= 100;
  if (dhtValid) {
    ok &= cJSON_AddNumberToObject(dht, "temperature_c", sample.temperature) != nullptr;
    ok &= cJSON_AddNumberToObject(dht, "humidity_pct", sample.humidity) != nullptr;
  } else {
    ok &= cJSON_AddNullToObject(dht, "temperature_c") != nullptr;
    ok &= cJSON_AddNullToObject(dht, "humidity_pct") != nullptr;
  }
  ok &= cJSON_AddStringToObject(dht, "quality", dhtValid ? "valid" : "invalid") != nullptr;
  ok &= cJSON_AddNumberToObject(dht, "age_ms", sample.dhtAgeMs) != nullptr;
  ok &= addGas(sensors, "mq2", sample.mq2);
  ok &= addGas(sensors, "mq7", sample.mq7);
  ok &= cJSON_AddStringToObject(cJSON_GetObjectItemCaseSensitive(sensors, "mq7"),
                          "heater_control", "unverified") != nullptr;
  cJSON* flame = cJSON_AddObjectToObject(sensors, "flame");
  if (sample.flameValid) {
    ok &= cJSON_AddBoolToObject(flame, "detected", sample.flameDetected) != nullptr;
  } else {
    ok &= cJSON_AddNullToObject(flame, "detected") != nullptr;
  }
  ok &= cJSON_AddStringToObject(flame, "quality", sample.flameValid ? "valid" : "invalid") != nullptr;
  ok &= cJSON_AddNumberToObject(flame, "age_ms", sample.flameAgeMs) != nullptr;
  cJSON* alerts = cJSON_AddObjectToObject(reading, "alert_snapshot");
  ok &= cJSON_AddStringToObject(alerts, "gas", alertLevelName(sample.gasLevel)) != nullptr;
  ok &= cJSON_AddStringToObject(alerts, "co", alertLevelName(sample.coLevel)) != nullptr;
  const char* flameState = "unknown";
  if (sample.flameValid) flameState = sample.flameDetected ? "critical" : "normal";
  ok &= cJSON_AddStringToObject(alerts, "flame", flameState) != nullptr;
  ok &= cJSON_AddBoolToObject(alerts, "buzzer_commanded_on", sample.buzzerCommandedOn) != nullptr;
  return ok;
}
}

char* encodeTelemetryBatch(const TelemetrySample* samples, size_t count, const char* deviceId,
                           const char* bootId, uint64_t bootCounter, uint64_t sentUptimeMs) {
  if (!samples || count == 0 || count > kMaxTelemetryBatch) return nullptr;
  cJSON* root = cJSON_CreateObject();
  if (!root) return nullptr;
  bool ok = cJSON_AddNumberToObject(root, "schema_version", 1) != nullptr;
  ok &= cJSON_AddStringToObject(root, "device_id", deviceId) != nullptr;
  cJSON* transmission = cJSON_AddObjectToObject(root, "transmission");
  ok &= cJSON_AddStringToObject(transmission, "current_boot_id", bootId) != nullptr;
  ok &= addCounter(transmission, "current_boot_counter", bootCounter);
  ok &= addCounter(transmission, "sent_uptime_ms", sentUptimeMs);
  cJSON* readings = cJSON_AddArrayToObject(root, "readings");
  if (!readings) ok = false;
  for (size_t i = 0; ok && i < count; ++i) ok = addReading(readings, samples[i], bootId, bootCounter);
  char* output = ok ? cJSON_PrintUnformatted(root) : nullptr;
  cJSON_Delete(root);
  return output;
}

char* encodeTelemetry(const TelemetrySample& sample, const char* deviceId,
                      const char* bootId, uint64_t bootCounter, uint64_t sentUptimeMs) {
  return encodeTelemetryBatch(&sample, 1, deviceId, bootId, bootCounter, sentUptimeMs);
}

bool telemetryBatchAcknowledged(const char* response, const char* bootId,
                                const TelemetrySample* samples, size_t count) {
  if (!samples || count == 0 || count > kMaxTelemetryBatch) return false;
  cJSON* root = cJSON_Parse(response);
  const cJSON* data = cJSON_GetObjectItemCaseSensitive(root, "data");
  const cJSON* accepted = cJSON_GetObjectItemCaseSensitive(data, "accepted");
  bool ok = cJSON_IsArray(accepted) && cJSON_GetArraySize(accepted) == static_cast<int>(count);
  for (size_t i = 0; ok && i < count; ++i) {
    const cJSON* entry = cJSON_GetArrayItem(accepted, static_cast<int>(i));
    const char* receivedBoot = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(entry, "boot_id"));
    const char* receivedSequence = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(entry, "seq"));
    char expectedSequence[21];
    snprintf(expectedSequence, sizeof(expectedSequence), "%llu", static_cast<unsigned long long>(samples[i].sequence));
    ok = receivedBoot && receivedSequence && strcmp(receivedBoot, bootId) == 0 &&
         strcmp(receivedSequence, expectedSequence) == 0;
  }
  cJSON_Delete(root);
  return ok;
}

bool telemetryAcknowledged(const char* response, const char* bootId, uint64_t sequence) {
  TelemetrySample sample;
  sample.sequence = sequence;
  return telemetryBatchAcknowledged(response, bootId, &sample, 1);
}

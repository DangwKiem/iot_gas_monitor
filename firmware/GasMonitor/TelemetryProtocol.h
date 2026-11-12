#pragma once

#include <cstdint>
#include <cstddef>
#include "AlertPolicy.h"

constexpr const char* kFirmwareVersion = "esp32-0.3.2";
constexpr size_t kMaxTelemetryBatch = 8;

struct GasSignal {
  bool valid = false;
  int raw = 0;
  uint32_t millivolts = 0;
  uint32_t ageMs = 0;
};

// Queue items contain values only, with no pointers into the live sensor state.
struct TelemetrySample {
  uint64_t sequence = 0;
  uint64_t uptimeMs = 0;
  char sampledAt[25]{};
  int configVersion = 1;
  bool dhtValid = false;
  float temperature = 0;
  float humidity = 0;
  uint32_t dhtAgeMs = 0;
  GasSignal mq2;
  GasSignal mq7;
  AlertLevel gasLevel = AlertLevel::Unknown;
  AlertLevel coLevel = AlertLevel::Unknown;
  bool flameValid = false;
  bool flameDetected = false;
  uint32_t flameAgeMs = 0;
  bool buzzerCommandedOn = false;
};

// The caller owns the returned allocation and releases it with cJSON_free().
char* encodeTelemetry(const TelemetrySample& sample, const char* deviceId,
                      const char* bootId, uint64_t bootCounter, uint64_t sentUptimeMs);
bool telemetryAcknowledged(const char* response, const char* bootId, uint64_t sequence);
char* encodeTelemetryBatch(const TelemetrySample* samples, size_t count, const char* deviceId,
                           const char* bootId, uint64_t bootCounter, uint64_t sentUptimeMs);
bool telemetryBatchAcknowledged(const char* response, const char* bootId,
                                const TelemetrySample* samples, size_t count);

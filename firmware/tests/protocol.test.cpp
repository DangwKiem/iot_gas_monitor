#include "../GasMonitor/TelemetryProtocol.h"
#include "../GasMonitor/AlertPolicyJson.h"
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace {
int allocationBudget = -1;
bool allocationFailed = false;
void* limitedMalloc(size_t size) {
  if (allocationBudget == 0) { allocationFailed = true; return nullptr; }
  if (allocationBudget > 0) --allocationBudget;
  return std::malloc(size);
}
}

int main(int argc, char** argv) {
  assert(argc == 2);
  const char* device = "11111111-1111-4111-8111-111111111111";
  const char* boot = "22222222-2222-4222-8222-222222222222";
  TelemetrySample sample;
  sample.sequence = 9007199254740993ULL;
  sample.uptimeMs = 10000;
  sample.dhtValid = true; sample.temperature = 27.5; sample.humidity = 51;
  sample.mq2 = {true, 3300, 2700, 20};
  sample.mq7 = {true, 1600, 1000, 20};
  sample.gasLevel = AlertLevel::Warning;
  sample.coLevel = AlertLevel::Critical;
  sample.flameValid = true; sample.flameDetected = true; sample.buzzerCommandedOn = true;
  char* body = encodeTelemetry(sample, device, boot, 7, 10010);
  char* retry = encodeTelemetry(sample, device, boot, 7, 20000);
  assert(body && retry);
  cJSON* original = cJSON_Parse(body);
  cJSON* resent = cJSON_Parse(retry);
  assert(cJSON_Compare(cJSON_GetObjectItem(original, "readings"), cJSON_GetObjectItem(resent, "readings"), true));
  cJSON_Delete(original); cJSON_Delete(resent); cJSON_free(retry);
  char ack[256];
  snprintf(ack, sizeof(ack), "{\"data\":{\"accepted\":[{\"boot_id\":\"%s\",\"seq\":\"9007199254740993\",\"duplicate\":true}]}}", boot);
  assert(telemetryAcknowledged(ack, boot, sample.sequence));
  assert(!telemetryAcknowledged(ack, boot, sample.sequence + 1));
  assert(!telemetryAcknowledged("invalid-json", boot, sample.sequence));
  assert(!telemetryAcknowledged("{}", boot, sample.sequence));

  TelemetryConfiguration config;
  char* canonical = canonicalConfiguration(config, true);
  assert(canonical);
  cJSON* parsedJson = cJSON_Parse(canonical);
  TelemetryConfiguration parsed;
  assert(parseTelemetryConfiguration(parsedJson, 2, parsed));
  assert(parsed.version == 2 && parsed.alerts.gas.warningOn == 3200 && parsed.alerts.co.criticalOn == 1500);
  cJSON_SetNumberValue(cJSON_GetObjectItem(cJSON_GetObjectItem(cJSON_GetObjectItem(parsedJson, "alert_policy"), "gas"), "warning_off"), 4000);
  assert(!parseTelemetryConfiguration(parsedJson, 3, parsed));
  assert(parsed.version == 2);
  cJSON_Delete(parsedJson);
  char* legacy = canonicalConfiguration(config, false);
  assert(strcmp(legacy, "{\"reporting_interval_ms\":5000}") == 0);
  cJSON_free(legacy);

  FILE* fixtures = fopen(argv[1], "wb");
  assert(fixtures);
  fprintf(fixtures, "{\"payload\":%s,\"config\":%s}", body, canonical);
  fclose(fixtures);
  cJSON_free(body); cJSON_free(canonical);

  cJSON_Hooks hooks{limitedMalloc, std::free};
  cJSON_InitHooks(&hooks);
  for (int allowed = 0; allowed < 300; ++allowed) {
    allocationBudget = allowed; allocationFailed = false;
    char* output = encodeTelemetry(sample, device, boot, 7, 30000);
    if (allocationFailed) assert(!output);
    cJSON_free(output);
    allocationBudget = allowed; allocationFailed = false;
    output = canonicalConfiguration(config, true);
    if (allocationFailed) assert(!output);
    cJSON_free(output);
  }
  cJSON_InitHooks(nullptr);
  puts("PASS firmware thresholds, protocol/ACK/retry, config canonicalization/validation and allocation failures");
}

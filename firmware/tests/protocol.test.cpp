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

  TelemetrySample batch[kMaxTelemetryBatch];
  for (size_t i = 0; i < kMaxTelemetryBatch; ++i) {
    batch[i] = sample;
    batch[i].sequence += i;
    batch[i].uptimeMs += i * 100;
    batch[i].gasLevel = i == 1 ? AlertLevel::Critical : AlertLevel::Normal;
    batch[i].coLevel = AlertLevel::Normal;
    batch[i].flameDetected = false;
  }
  char* batched = encodeTelemetryBatch(batch, 3, device, boot, 7, 20000);
  char* retriedBatch = encodeTelemetryBatch(batch, 3, device, boot, 7, 30000);
  assert(batched && retriedBatch);
  original = cJSON_Parse(batched);
  resent = cJSON_Parse(retriedBatch);
  assert(cJSON_Compare(cJSON_GetObjectItem(original, "readings"), cJSON_GetObjectItem(resent, "readings"), true));
  assert(cJSON_GetArraySize(cJSON_GetObjectItem(original, "readings")) == 3);
  assert(strcmp(cJSON_GetStringValue(cJSON_GetObjectItem(cJSON_GetObjectItem(cJSON_GetArrayItem(cJSON_GetObjectItem(original, "readings"), 1), "alert_snapshot"), "gas")), "critical") == 0);
  cJSON_Delete(original); cJSON_Delete(resent); cJSON_free(retriedBatch);
  cJSON* batchAck = cJSON_CreateObject();
  cJSON* accepted = cJSON_AddArrayToObject(cJSON_AddObjectToObject(batchAck, "data"), "accepted");
  for (size_t i = 0; i < 3; ++i) {
    cJSON* entry = cJSON_CreateObject();
    assert(cJSON_AddItemToArray(accepted, entry));
    assert(cJSON_AddStringToObject(entry, "boot_id", boot));
    char seq[21];
    snprintf(seq, sizeof(seq), "%llu", static_cast<unsigned long long>(batch[i].sequence));
    assert(cJSON_AddStringToObject(entry, "seq", seq));
    assert(cJSON_AddBoolToObject(entry, "duplicate", true));
  }
  char* batchAckText = cJSON_PrintUnformatted(batchAck);
  assert(telemetryBatchAcknowledged(batchAckText, boot, batch, 3));
  assert(!telemetryBatchAcknowledged(batchAckText, device, batch, 3));
  assert(!telemetryBatchAcknowledged(batchAckText, boot, batch, 2));
  cJSON_free(batchAckText);
  cJSON_SetValuestring(cJSON_GetObjectItem(cJSON_GetArrayItem(accepted, 1), "seq"), "999");
  batchAckText = cJSON_PrintUnformatted(batchAck);
  assert(!telemetryBatchAcknowledged(batchAckText, boot, batch, 3));
  cJSON_free(batchAckText); cJSON_Delete(batchAck);
  assert(!encodeTelemetryBatch(nullptr, 1, device, boot, 7, 20000));
  assert(!encodeTelemetryBatch(batch, 0, device, boot, 7, 20000));
  assert(!encodeTelemetryBatch(batch, kMaxTelemetryBatch + 1, device, boot, 7, 20000));
  char* largestBatch = encodeTelemetryBatch(batch, kMaxTelemetryBatch, device, boot, 7, 20000);
  assert(largestBatch && strlen(largestBatch) < 64000);
  cJSON_free(largestBatch);

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

  const char* localApi = "http://192.168.1.10:4000";
  const char* cloudApi = "https://airguard.example";
  TelemetryConfiguration localConfig;
  localConfig.version = 5;
  localConfig.intervalMs = 7000;
  localConfig.alerts.gas.warningOn = 3100;
  char* saved = serializeStoredConfiguration(localConfig, true, localApi, device);
  assert(saved);
  cJSON* stored = cJSON_Parse(saved);
  cJSON_free(saved);
  TelemetryConfiguration restored;
  assert(restoreStoredConfiguration(stored, localApi, device, restored));
  assert(restored.version == 5 && restored.intervalMs == 7000 && restored.alerts.gas.warningOn == 3100);
  TelemetryConfiguration fresh;
  assert(!restoreStoredConfiguration(stored, cloudApi, device, fresh));
  assert(!restoreStoredConfiguration(stored, localApi, boot, fresh));
  assert(fresh.version == 1 && fresh.intervalMs == 5000 && fresh.alerts.gas.warningOn == 3200);
  cJSON_SetNumberValue(cJSON_GetObjectItemCaseSensitive(stored, "version"), 5.5);
  assert(!restoreStoredConfiguration(stored, localApi, device, fresh));
  cJSON_Delete(stored);
  stored = cJSON_Parse("{\"version\":5,\"config\":{\"reporting_interval_ms\":7000}}");
  assert(!restoreStoredConfiguration(stored, cloudApi, device, fresh));
  cJSON_Delete(stored);
  stored = cJSON_Parse("{\"reporting_interval_ms\":5000}");
  assert(parseTelemetryConfiguration(stored, 1, fresh));
  cJSON_Delete(stored);
  saved = serializeStoredConfiguration(fresh, false, cloudApi, device);
  assert(saved);
  stored = cJSON_Parse(saved);
  cJSON_free(saved);
  assert(restoreStoredConfiguration(stored, cloudApi, device, restored));
  assert(restored.version == 1 && restored.intervalMs == 5000);
  assert(!restoreStoredConfiguration(nullptr, cloudApi, device, fresh));
  cJSON_Delete(stored);

  FILE* fixtures = fopen(argv[1], "wb");
  assert(fixtures);
  fprintf(fixtures, "{\"payload\":%s,\"batch\":%s,\"config\":%s}", body, batched, canonical);
  fclose(fixtures);
  cJSON_free(body); cJSON_free(batched); cJSON_free(canonical);

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
    allocationBudget = allowed; allocationFailed = false;
    output = serializeStoredConfiguration(config, true, cloudApi, device);
    if (allocationFailed) assert(!output);
    cJSON_free(output);
    allocationBudget = allowed; allocationFailed = false;
    output = encodeTelemetryBatch(batch, 3, device, boot, 7, 30000);
    if (allocationFailed) assert(!output);
    cJSON_free(output);
  }
  cJSON_InitHooks(nullptr);
  puts("PASS firmware thresholds, ordered batch/ACK/retry, config validation, device/server cache binding and allocation failures");
}

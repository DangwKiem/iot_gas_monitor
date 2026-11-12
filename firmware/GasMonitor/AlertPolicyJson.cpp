#include "AlertPolicyJson.h"

#include <cstring>

namespace {
bool integerField(const cJSON* object, const char* name, int& value) {
  const cJSON* field = cJSON_GetObjectItemCaseSensitive(object, name);
  if (!cJSON_IsNumber(field) || field->valuedouble != field->valueint) return false;
  value = field->valueint;
  return true;
}

bool parseGas(const cJSON* object, GasThresholds& t) {
  return integerField(object, "warning_on", t.warningOn) &&
         integerField(object, "warning_off", t.warningOff) &&
         integerField(object, "critical_on", t.criticalOn) &&
         integerField(object, "critical_off", t.criticalOff) && validGasThresholds(t);
}

bool addGas(cJSON* policy, const char* name, const GasThresholds& t) {
  cJSON* gas = cJSON_AddObjectToObject(policy, name);
  return gas && cJSON_AddNumberToObject(gas, "warning_on", t.warningOn) &&
         cJSON_AddNumberToObject(gas, "warning_off", t.warningOff) &&
         cJSON_AddNumberToObject(gas, "critical_on", t.criticalOn) &&
         cJSON_AddNumberToObject(gas, "critical_off", t.criticalOff);
}
}

bool parseTelemetryConfiguration(const cJSON* config, int version, TelemetryConfiguration& output) {
  TelemetryConfiguration parsed;
  int period;
  if (version < 1 || !integerField(config, "reporting_interval_ms", period) || period < 1000 || period > 60000)
    return false;
  parsed.version = version;
  parsed.intervalMs = period;
  const cJSON* policy = cJSON_GetObjectItemCaseSensitive(config, "alert_policy");
  if (policy) {
    const cJSON* flame = cJSON_GetObjectItemCaseSensitive(policy, "flame");
    const cJSON* below = cJSON_GetObjectItemCaseSensitive(flame, "active_below");
    if (!parseGas(cJSON_GetObjectItemCaseSensitive(policy, "gas"), parsed.alerts.gas) ||
        !parseGas(cJSON_GetObjectItemCaseSensitive(policy, "co"), parsed.alerts.co) ||
        !integerField(flame, "alarm_on", parsed.alerts.flame.alarmOn) ||
        !integerField(flame, "alarm_off", parsed.alerts.flame.alarmOff) || !cJSON_IsBool(below)) return false;
    parsed.alerts.flame.activeBelow = cJSON_IsTrue(below);
    if (!validFlameThresholds(parsed.alerts.flame)) return false;
  }
  output = parsed;
  return true;
}

char* canonicalConfiguration(const TelemetryConfiguration& config, bool includePolicy) {
  cJSON* root = cJSON_CreateObject();
  if (!root) return nullptr;
  bool ok = cJSON_AddNumberToObject(root, "reporting_interval_ms", config.intervalMs) != nullptr;
  if (includePolicy) {
    cJSON* policy = cJSON_AddObjectToObject(root, "alert_policy");
    ok &= addGas(policy, "gas", config.alerts.gas);
    ok &= addGas(policy, "co", config.alerts.co);
    cJSON* flame = cJSON_AddObjectToObject(policy, "flame");
    ok &= cJSON_AddNumberToObject(flame, "alarm_on", config.alerts.flame.alarmOn) != nullptr;
    ok &= cJSON_AddNumberToObject(flame, "alarm_off", config.alerts.flame.alarmOff) != nullptr;
    ok &= cJSON_AddBoolToObject(flame, "active_below", config.alerts.flame.activeBelow) != nullptr;
  }
  char* text = ok ? cJSON_PrintUnformatted(root) : nullptr;
  cJSON_Delete(root);
  return text;
}

char* serializeStoredConfiguration(const TelemetryConfiguration& config, bool includePolicy,
                                   const char* apiBaseUrl, const char* deviceId) {
  if (!apiBaseUrl || !deviceId) return nullptr;
  char* canonical = canonicalConfiguration(config, includePolicy);
  if (!canonical) return nullptr;
  cJSON* root = cJSON_CreateObject();
  const bool ok = root && cJSON_AddStringToObject(root, "api_base_url", apiBaseUrl) &&
                  cJSON_AddStringToObject(root, "device_id", deviceId) &&
                  cJSON_AddNumberToObject(root, "version", config.version) &&
                  cJSON_AddRawToObject(root, "config", canonical);
  cJSON_free(canonical);
  char* text = ok ? cJSON_PrintUnformatted(root) : nullptr;
  cJSON_Delete(root);
  return text;
}

bool restoreStoredConfiguration(const cJSON* stored, const char* apiBaseUrl,
                                const char* deviceId, TelemetryConfiguration& output) {
  const char* savedApi = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(stored, "api_base_url"));
  const char* savedDevice = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(stored, "device_id"));
  int version;
  return apiBaseUrl && deviceId && savedApi && savedDevice &&
         strcmp(savedApi, apiBaseUrl) == 0 && strcmp(savedDevice, deviceId) == 0 &&
         integerField(stored, "version", version) &&
         parseTelemetryConfiguration(cJSON_GetObjectItemCaseSensitive(stored, "config"), version, output);
}

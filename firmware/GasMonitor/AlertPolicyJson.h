#pragma once

#include <cJSON.h>
#include "AlertPolicy.h"

bool parseTelemetryConfiguration(const cJSON* config, int version, TelemetryConfiguration& output);
char* canonicalConfiguration(const TelemetryConfiguration& config, bool includePolicy);
char* serializeStoredConfiguration(const TelemetryConfiguration& config, bool includePolicy,
                                   const char* apiBaseUrl, const char* deviceId);
bool restoreStoredConfiguration(const cJSON* stored, const char* apiBaseUrl,
                                const char* deviceId, TelemetryConfiguration& output);

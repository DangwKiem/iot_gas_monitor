#pragma once

#include <cJSON.h>
#include "AlertPolicy.h"

bool parseTelemetryConfiguration(const cJSON* config, int version, TelemetryConfiguration& output);
char* canonicalConfiguration(const TelemetryConfiguration& config, bool includePolicy);

#pragma once

#include "TelemetryProtocol.h"

void startTelemetryNetwork();
void enqueueTelemetry(TelemetrySample sample);
uint32_t telemetryIntervalMs();
TelemetryConfiguration telemetryConfiguration();

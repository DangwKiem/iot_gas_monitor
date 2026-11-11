#pragma once

#include <cstdint>

enum class AlertLevel { Normal, Warning, Critical, Unknown, NotConfigured };

struct GasThresholds {
  int warningOn;
  int warningOff;
  int criticalOn;
  int criticalOff;
};

struct FlameThresholds {
  int alarmOn;
  int alarmOff;
  bool activeBelow;
};

struct AlertPolicy {
  GasThresholds gas{3200, 2900, 3700, 3400};
  GasThresholds co{1000, 900, 1500, 1300};
  FlameThresholds flame{1000, 1500, true};
};

struct TelemetryConfiguration {
  int version = 1;
  uint32_t intervalMs = 5000;
  AlertPolicy alerts;
};

constexpr bool validGasThresholds(const GasThresholds& t) {
  return t.warningOff >= 0 && t.warningOff < t.warningOn &&
         t.warningOn <= t.criticalOff && t.criticalOff < t.criticalOn && t.criticalOn < 4095;
}

constexpr bool validFlameThresholds(const FlameThresholds& t) {
  return t.alarmOn >= 0 && t.alarmOn < 4095 && t.alarmOff >= 0 && t.alarmOff < 4095 &&
         (t.activeBelow ? t.alarmOn < t.alarmOff : t.alarmOn > t.alarmOff);
}

constexpr AlertLevel nextGasLevel(int value, AlertLevel previous, const GasThresholds& t) {
  if (value >= t.criticalOn || (previous == AlertLevel::Critical && value > t.criticalOff))
    return AlertLevel::Critical;
  if (value >= t.warningOn ||
      ((previous == AlertLevel::Warning || previous == AlertLevel::Critical) && value > t.warningOff))
    return AlertLevel::Warning;
  return AlertLevel::Normal;
}

constexpr bool nextFlameState(int value, bool active, const FlameThresholds& t) {
  if (t.activeBelow) return active ? value < t.alarmOff : value <= t.alarmOn;
  return active ? value > t.alarmOff : value >= t.alarmOn;
}

constexpr const char* alertLevelName(AlertLevel level) {
  switch (level) {
    case AlertLevel::Normal: return "normal";
    case AlertLevel::Warning: return "warning";
    case AlertLevel::Critical: return "critical";
    case AlertLevel::Unknown: return "unknown";
    case AlertLevel::NotConfigured: return "not_configured";
  }
  return "unknown";
}

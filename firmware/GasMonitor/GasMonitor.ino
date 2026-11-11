#include <Arduino.h>
#include <DHT.h>
#include <driver/gpio.h>
#include <esp_timer.h>
#include <time.h>

#include "BenchConfig.h"
#include "TelemetryNetwork.h"

constexpr uint8_t kMq2Pin = 34;
constexpr uint8_t kMq7Pin = 35;
constexpr uint8_t kFlamePin = 32;
constexpr uint8_t kDht11Pin = 18;
constexpr uint8_t kBuzzerPin = 25;
constexpr uint8_t kGreenPin = 27;
constexpr uint8_t kRedPin = 14;
constexpr uint8_t kYellowPin = 13;

constexpr uint8_t kAdcBits = 12;
constexpr int kAdcMax = (1 << kAdcBits) - 1;
constexpr uint8_t kAdcSamples = 20;
constexpr uint32_t kAdcPeriodMs = 10;
constexpr uint32_t kDhtPeriodMs = 2000;
constexpr uint32_t kReportPeriodMs = 1000;
constexpr uint32_t kOutputTestMs = 2000;
static_assert(kBuzzerToneHz >= 100 && kBuzzerToneHz <= 10000, "Buzzer tone must be 100-10000 Hz");

struct AnalogChannel {
  const char* name;
  uint8_t pin;
  bool enabled;
  uint32_t rawSum = 0;
  uint32_t millivoltSum = 0;
  bool clipped = false;
  bool ready = false;
  bool valid = false;
  int raw = 0;
  uint32_t millivolts = 0;

  AnalogChannel(const char* name, uint8_t pin, bool enabled)
      : name(name), pin(pin), enabled(enabled) {}

  void begin() const {
    if (enabled) analogSetPinAttenuation(pin, ADC_11db);
  }

  void sample() {
    if (!enabled) return;
    const int count = analogRead(pin);
    rawSum += count;
    millivoltSum += analogReadMilliVolts(pin);
    clipped |= count == kAdcMax;
  }

  void finishWindow() {
    if (!enabled) return;
    raw = (rawSum + kAdcSamples / 2) / kAdcSamples;
    millivolts = (millivoltSum + kAdcSamples / 2) / kAdcSamples;
    ready = true;
    valid = !clipped;
    rawSum = 0;
    millivoltSum = 0;
    clipped = false;
  }

  void print() const {
    Serial.printf("%s GPIO%u: ", name, static_cast<unsigned>(pin));
    if (!enabled) {
      Serial.println("DISABLED");
    } else if (!ready) {
      Serial.println("WAITING");
    } else if (!valid) {
      Serial.println("ADC_CLIPPED");
    } else {
      Serial.printf("ADC=%d, GPIO=%lu mV\n", raw, static_cast<unsigned long>(millivolts));
    }
  }
};

AnalogChannel mq2("MQ-2", kMq2Pin, kReadMq2);
AnalogChannel mq7("MQ-7", kMq7Pin, kReadMq7);
AnalogChannel flame("FLAME", kFlamePin, kReadFlame && !kFlameUseDigital);
DHT dht(kDht11Pin, DHT11);

uint32_t lastAdcMs = 0;
uint32_t lastDhtMs = 0;
uint32_t lastReportMs = 0;
uint32_t lastUploadMs = 0;
uint32_t lastAnalogMs = 0;
uint32_t outputTestStartedMs = 0;
uint8_t samples = 0;
float temperature = NAN;
float humidity = NAN;
bool dhtReady = false;
bool dhtValid = false;
AlertLevel gasLevel = AlertLevel::Normal;
AlertLevel coLevel = AlertLevel::Normal;
AlertLevel sentGasLevel = AlertLevel::Unknown;
AlertLevel sentCoLevel = AlertLevel::Unknown;
AlertLevel sentFlameLevel = AlertLevel::Unknown;
bool flameAlarm = false;
bool flameCandidate = false;
bool flameCandidateReady = false;
uint32_t flameCandidateSince = 0;
uint32_t lastFlameMs = 0;
bool outputTest = false;
bool outputTestPwm = false;
bool buzzerPwmAttached = false;
bool buzzerOutputKnown = false;
bool buzzerLastOn = false;
bool buzzerLastPwm = false;
bool buzzerDriverFault = false;

void sampleAnalog(uint32_t now) {
  if (now - lastAdcMs < kAdcPeriodMs) return;
  lastAdcMs = now;
  mq2.sample();
  mq7.sample();
  flame.sample();
  if (++samples < kAdcSamples) return;
  samples = 0;
  mq2.finishWindow();
  mq7.finishWindow();
  flame.finishWindow();
  lastAnalogMs = now;
  const AlertPolicy policy = telemetryConfiguration().alerts;
  // Retain the local alarm during a sensor fault until a valid recovery reading arrives.
  if (mq2.valid) gasLevel = nextGasLevel(mq2.raw, gasLevel, policy.gas);
  if (mq7.valid) coLevel = nextGasLevel(mq7.raw, coLevel, policy.co);
  if (!kFlameUseDigital && flame.valid) {
    flameAlarm = nextFlameState(flame.raw, flameAlarm, policy.flame);
    lastFlameMs = now;
  }
}

void sampleDigitalFlame(uint32_t now) {
  if (!kReadFlame || !kFlameUseDigital) return;
  const bool detected = digitalRead(kFlamePin) == (kFlameActiveLow ? LOW : HIGH);
  if (!flameCandidateReady || detected != flameCandidate) {
    flameCandidate = detected;
    flameCandidateSince = now;
    flameCandidateReady = true;
  }
  if (now - flameCandidateSince >= 50) {
    flameAlarm = detected;
    flame.valid = true;
    lastFlameMs = now;
  }
}

void sampleDht(uint32_t now) {
  if (!kReadDht11 || now - lastDhtMs < kDhtPeriodMs) return;
  lastDhtMs = now;
  humidity = dht.readHumidity(true);
  temperature = dht.readTemperature();
  dhtReady = true;
  dhtValid = isfinite(temperature) && temperature >= -40 && temperature <= 125 &&
             isfinite(humidity) && humidity >= 0 && humidity <= 100;
}

AlertLevel currentGasLevel() {
  if (!kReadMq2) return AlertLevel::NotConfigured;
  return mq2.valid ? gasLevel : AlertLevel::Unknown;
}

AlertLevel currentCoLevel() {
  if (!kReadMq7) return AlertLevel::NotConfigured;
  return mq7.valid ? coLevel : AlertLevel::Unknown;
}

AlertLevel currentFlameLevel() {
  if (!kReadFlame) return AlertLevel::NotConfigured;
  if (!flame.valid) return AlertLevel::Unknown;
  return flameAlarm ? AlertLevel::Critical : AlertLevel::Normal;
}

bool criticalAlarm() {
  return gasLevel == AlertLevel::Critical || coLevel == AlertLevel::Critical || flameAlarm;
}

bool warningAlarm() {
  return gasLevel == AlertLevel::Warning || coLevel == AlertLevel::Warning;
}

void publishSample(uint32_t now) {
  const TelemetryConfiguration config = telemetryConfiguration();
  const AlertLevel gas = currentGasLevel();
  const AlertLevel co = currentCoLevel();
  const AlertLevel fire = currentFlameLevel();
  const bool changed = gas != sentGasLevel || co != sentCoLevel || fire != sentFlameLevel;
  if (!changed && now - lastUploadMs < config.intervalMs) return;
  lastUploadMs = now;
  sentGasLevel = gas;
  sentCoLevel = co;
  sentFlameLevel = fire;
  TelemetrySample sample;
  sample.configVersion = config.version;
  sample.uptimeMs = static_cast<uint64_t>(esp_timer_get_time()) / 1000;
  const time_t capturedAt = time(nullptr);
  if (capturedAt >= 1735689600) {
    struct tm utc;
    gmtime_r(&capturedAt, &utc);
    strftime(sample.sampledAt, sizeof(sample.sampledAt), "%Y-%m-%dT%H:%M:%SZ", &utc);
  }
  sample.dhtValid = kReadDht11 && dhtValid;
  sample.temperature = temperature;
  sample.humidity = humidity;
  sample.dhtAgeMs = min(now - lastDhtMs, static_cast<uint32_t>(86400000));
  const uint32_t analogAgeMs = min(now - lastAnalogMs, static_cast<uint32_t>(86400000));
  sample.mq2 = {mq2.enabled && mq2.valid, mq2.raw, mq2.millivolts, analogAgeMs};
  sample.mq7 = {mq7.enabled && mq7.valid, mq7.raw, mq7.millivolts, analogAgeMs};
  sample.gasLevel = gas;
  sample.coLevel = co;
  sample.flameValid = kReadFlame && flame.valid;
  sample.flameDetected = flameAlarm;
  sample.flameAgeMs = min(now - lastFlameMs, static_cast<uint32_t>(86400000));
  sample.buzzerCommandedOn = kDriveBuzzer && (criticalAlarm() || warningAlarm() || outputTest);
  enqueueTelemetry(sample);
}

bool sensorsReady() {
  return (kReadMq2 || kReadMq7 || kReadFlame || kReadDht11) &&
         (!mq2.enabled || mq2.valid) && (!mq7.enabled || mq7.valid) &&
         (!kReadFlame || flame.valid) && (!kReadDht11 || dhtValid);
}

void setBuzzer(bool on) {
  if (!kDriveBuzzer) return;
  const bool usePwm = outputTest ? outputTestPwm : kBuzzerUsePwm;
  if (buzzerOutputKnown && on == buzzerLastOn && usePwm == buzzerLastPwm) return;

  if (!buzzerOutputKnown || usePwm != buzzerLastPwm) {
    if (buzzerPwmAttached) {
      ledcDetach(kBuzzerPin);
      buzzerPwmAttached = false;
    }
    buzzerDriverFault = false;
    if (usePwm) {
      buzzerPwmAttached = ledcAttach(kBuzzerPin, kBuzzerToneHz, 8);
      buzzerDriverFault = !buzzerPwmAttached;
    }
    if (!usePwm || buzzerDriverFault) {
      gpio_set_level(static_cast<gpio_num_t>(kBuzzerPin), kBuzzerActiveHigh ? LOW : HIGH);
      pinMode(kBuzzerPin, OUTPUT);
    }
  }

  if (!buzzerDriverFault) {
    if (usePwm) {
      const uint32_t idleDuty = kBuzzerActiveHigh ? 0 : 255;
      buzzerDriverFault = !ledcWrite(kBuzzerPin, on ? 128 : idleDuty);
    } else {
      digitalWrite(kBuzzerPin, on == kBuzzerActiveHigh ? HIGH : LOW);
    }
    if (buzzerDriverFault) Serial.println("BUZZER DRIVER_ERROR: cannot write PWM output");
  } else if (!buzzerOutputKnown || usePwm != buzzerLastPwm) {
    Serial.println("BUZZER DRIVER_ERROR: cannot attach PWM on GPIO25");
  }
  buzzerOutputKnown = true;
  buzzerLastOn = on;
  buzzerLastPwm = usePwm;
}

void updateOutputs() {
  const bool critical = criticalAlarm() || outputTest;
  const bool warning = warningAlarm();
  const bool ready = sensorsReady();
  digitalWrite(kRedPin, critical ? HIGH : LOW);
  digitalWrite(kGreenPin, !critical && !warning && ready ? HIGH : LOW);
  const bool yellow = !critical && (warning || (!ready && millis() % 1000 < 500));
  digitalWrite(kYellowPin, yellow ? HIGH : LOW);
  setBuzzer(critical || (warning && millis() % 1000 < 250));
}

void report() {
  Serial.println("--- AIRGUARD ---");
  mq2.print();
  mq7.print();
  if (kReadFlame && kFlameUseDigital) {
    Serial.printf("FLAME GPIO32: digital=%s\n", alertLevelName(currentFlameLevel()));
  } else {
    flame.print();
  }
  Serial.print("DHT11 GPIO18: ");
  if (!kReadDht11) {
    Serial.println("DISABLED");
  } else if (!dhtReady) {
    Serial.println("WAITING");
  } else if (!dhtValid) {
    Serial.println("INVALID");
  } else {
    Serial.printf("%.1f C, %.1f %%RH\n", temperature, humidity);
  }
  Serial.printf("Gas=%s, CO=%s, Flame=%s, Buzzer=%s, BuzzerMode=%s\n",
                alertLevelName(currentGasLevel()), alertLevelName(currentCoLevel()),
                alertLevelName(currentFlameLevel()),
                !kDriveBuzzer ? "DISABLED" : buzzerDriverFault ? "DRIVER_ERROR" : (criticalAlarm() || warningAlarm() || outputTest) ? "ON" : "OFF",
                (outputTest ? outputTestPwm : kBuzzerUsePwm) ? "PWM" : "DC");
}

void setup() {
  Serial.begin(115200);
  pinMode(kRedPin, OUTPUT);
  pinMode(kYellowPin, OUTPUT);
  pinMode(kGreenPin, OUTPUT);
  updateOutputs();
  analogReadResolution(kAdcBits);
  mq2.begin();
  mq7.begin();
  flame.begin();
  if (kReadFlame && kFlameUseDigital) pinMode(kFlamePin, INPUT_PULLUP);
  if (kReadDht11) dht.begin();
  const uint32_t now = millis();
  lastAdcMs = lastDhtMs = lastReportMs = now;
  lastUploadMs = now;
  Serial.println("AirGuard | 115200 baud | t: configured buzzer, d: DC test, p: PWM test (2 seconds)");
  startTelemetryNetwork();
}

void loop() {
  const uint32_t now = millis();
  if (outputTest && now - outputTestStartedMs >= kOutputTestMs) outputTest = false;
  if (Serial.available()) {
    const int command = Serial.read();
    if (!outputTest && (command == 't' || command == 'd' || command == 'p')) {
      outputTest = true;
      outputTestPwm = command == 'p' || (command == 't' && kBuzzerUsePwm);
      outputTestStartedMs = now;
      buzzerOutputKnown = false;
      Serial.printf("BUZZER TEST %s on GPIO25 for %lu ms\n", outputTestPwm ? "PWM" : "DC", static_cast<unsigned long>(kOutputTestMs));
    }
  }
  sampleAnalog(now);
  sampleDigitalFlame(now);
  sampleDht(now);
  updateOutputs();
  publishSample(now);
  if (now - lastReportMs >= kReportPeriodMs) {
    lastReportMs = now;
    report();
  }
  delay(1);
}

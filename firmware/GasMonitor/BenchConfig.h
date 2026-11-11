#pragma once

#include <cstdint>

// Enable each channel only after confirming its signal is compatible with the ESP32.
constexpr bool kReadMq2 = true;
constexpr bool kReadMq7 = true;
constexpr bool kReadFlame = true;
constexpr bool kReadDht11 = true;
constexpr bool kDriveBuzzer = true;
constexpr bool kBuzzerActiveHigh = true;
constexpr bool kBuzzerUsePwm = false;
constexpr uint32_t kBuzzerToneHz = 2500;
constexpr bool kFlameUseDigital = true;
constexpr bool kFlameActiveLow = true;

// ADC thresholds are in AlertPolicy.h and can be overridden from the device settings page.

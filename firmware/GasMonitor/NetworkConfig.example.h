#pragma once

// Copy this file to NetworkConfig.h and fill in your own values.
constexpr char kWifiSsid[] = "";
constexpr char kWifiPassword[] = "";
constexpr char kApiBaseUrl[] = "";
constexpr char kDeviceId[] = "";
constexpr char kDeviceKey[] = "";  // key_id.secret, without the DeviceKey prefix

// HTTP is allowed only to a private IPv4 address on your trusted local network.
constexpr bool kAllowLanHttp = false;
// For HTTPS, paste the server's trusted root CA certificate here.
#include "ApiRootCa.h"

#include "../GasMonitor/AlertPolicy.h"

constexpr AlertPolicy policy;
static_assert(validGasThresholds(policy.gas));
static_assert(validGasThresholds(policy.co));
static_assert(validFlameThresholds(policy.flame));
static_assert(nextGasLevel(3199, AlertLevel::Normal, policy.gas) == AlertLevel::Normal);
static_assert(nextGasLevel(3200, AlertLevel::Normal, policy.gas) == AlertLevel::Warning);
static_assert(nextGasLevel(3000, AlertLevel::Warning, policy.gas) == AlertLevel::Warning);
static_assert(nextGasLevel(2900, AlertLevel::Warning, policy.gas) == AlertLevel::Normal);
static_assert(nextGasLevel(3700, AlertLevel::Normal, policy.gas) == AlertLevel::Critical);
static_assert(nextGasLevel(3500, AlertLevel::Critical, policy.gas) == AlertLevel::Critical);
static_assert(nextGasLevel(3400, AlertLevel::Critical, policy.gas) == AlertLevel::Warning);
static_assert(nextGasLevel(2900, AlertLevel::Critical, policy.gas) == AlertLevel::Normal);
static_assert(nextGasLevel(1000, AlertLevel::Normal, policy.co) == AlertLevel::Warning);
static_assert(nextGasLevel(1500, AlertLevel::Normal, policy.co) == AlertLevel::Critical);
static_assert(nextGasLevel(1300, AlertLevel::Critical, policy.co) == AlertLevel::Warning);
static_assert(nextGasLevel(900, AlertLevel::Warning, policy.co) == AlertLevel::Normal);
static_assert(nextFlameState(1000, false, policy.flame));
static_assert(nextFlameState(1200, true, policy.flame));
static_assert(!nextFlameState(1500, true, policy.flame));
constexpr FlameThresholds rising{2000, 1500, false};
static_assert(nextFlameState(2000, false, rising));
static_assert(!nextFlameState(1500, true, rising));
static_assert(!validGasThresholds({3200, 3200, 3700, 3400}));
static_assert(!validGasThresholds({3200, 2900, 4095, 3400}));

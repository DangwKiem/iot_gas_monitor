import { expect, it } from 'vitest';
import {
  alertPolicySchema,
  defaultAlertPolicy,
  deviceConfigSchema,
  telemetrySchema,
} from '../src/index.js';
import { samplePayload } from './fixture.js';

it('validates ADC hysteresis and preserves old config serialization', () => {
  expect(alertPolicySchema.parse(defaultAlertPolicy)).toEqual(defaultAlertPolicy);
  expect(deviceConfigSchema.parse({ reporting_interval_ms: 5000 })).toEqual({
    reporting_interval_ms: 5000,
  });
  for (const gas of [
    { ...defaultAlertPolicy.gas, warning_off: 3200 },
    { ...defaultAlertPolicy.gas, critical_off: 3000 },
    { ...defaultAlertPolicy.gas, critical_on: 4095 },
  ])
    expect(alertPolicySchema.safeParse({ ...defaultAlertPolicy, gas }).success).toBe(false);
  expect(
    alertPolicySchema.safeParse({
      ...defaultAlertPolicy,
      flame: { alarm_on: 1000, alarm_off: 1500, active_below: false },
    }).success,
  ).toBe(false);
});

it('accepts explicit warning and critical snapshots while preserving old active reports', () => {
  for (const state of ['active', 'warning', 'critical']) {
    const input = samplePayload();
    input.readings[0]!.alert_snapshot.gas = state;
    expect(telemetrySchema.safeParse(input).success).toBe(true);
  }
});

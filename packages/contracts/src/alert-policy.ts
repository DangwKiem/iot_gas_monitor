import { z } from 'zod';

const adc = z.number().int().min(0).max(4094);
export const gasThresholdsSchema = z
  .strictObject({ warning_on: adc, warning_off: adc, critical_on: adc, critical_off: adc })
  .refine(
    (v) =>
      v.warning_off < v.warning_on &&
      v.warning_on <= v.critical_off &&
      v.critical_off < v.critical_on,
    'Cần ngưỡng nhả Warning < Warning ≤ ngưỡng nhả Critical < Critical',
  );
export const flameThresholdsSchema = z
  .strictObject({ alarm_on: adc, alarm_off: adc, active_below: z.boolean() })
  .refine(
    (v) => (v.active_below ? v.alarm_on < v.alarm_off : v.alarm_on > v.alarm_off),
    'Ngưỡng bật và nhả phải phù hợp chiều tín hiệu cảm biến lửa',
  );
export const alertPolicySchema = z.strictObject({
  gas: gasThresholdsSchema,
  co: gasThresholdsSchema,
  flame: flameThresholdsSchema,
});
export type AlertPolicy = z.infer<typeof alertPolicySchema>;
export const defaultAlertPolicy: AlertPolicy = {
  gas: { warning_on: 3200, warning_off: 2900, critical_on: 3700, critical_off: 3400 },
  co: { warning_on: 1000, warning_off: 900, critical_on: 1500, critical_off: 1300 },
  flame: { alarm_on: 1000, alarm_off: 1500, active_below: true },
};

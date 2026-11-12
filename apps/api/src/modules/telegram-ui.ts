import type { ChartMetric } from './telegram-data.js';
export type BotView = {
  screen:
    | 'menu'
    | 'devices'
    | 'status'
    | 'settings'
    | 'unlink'
    | 'alerts'
    | 'history'
    | 'incident'
    | 'history-devices'
    | 'chart'
    | 'report'
    | 'chart-devices'
    | 'report-devices'
    | 'tracking-devices'
    | 'report-settings'
    | 'report-time';
  page?: number;
  days?: 1 | 7 | 30;
  severity?: 'warning' | 'critical';
  deviceId?: string;
  incidentId?: string;
  returnTo?: 'alerts' | 'history';
  metric?: ChartMetric;
  hours?: 1 | 24 | 168;
};
export type BotAction = {
  view: BotView;
  deviceId?: string;
  ackIncidentId?: string;
  unlink?: boolean;
  setting?: {
    warningEnabled?: boolean;
    trackedDeviceId?: string | null;
    reportFrequency?: 'off' | 'daily' | 'weekly';
    reportHour?: number;
    reportMinute?: number;
    reportWeekday?: number;
  };
  testNotification?: boolean;
};
export type BotButton = { text: string; action: BotAction };
export type BotScreen = { text: string; rows: BotButton[][]; photo?: Buffer };
export const button = (
  text: string,
  screen: BotView['screen'],
  extra: Partial<BotAction> = {},
): BotButton => ({ text, action: { view: { screen }, ...extra } });

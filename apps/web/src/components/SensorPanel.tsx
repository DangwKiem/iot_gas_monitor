import type { DeviceView } from '@iot/contracts';
import { Thermometer, Droplets, Wind, Flame, Activity } from 'lucide-react';
import { qualityText } from './FeatureUI.js';
import { sensorFreshness } from '../lib/freshness.js';
import { useEffect, useState } from 'react';

export const alertText = {
  normal: 'Bình thường',
  active: 'Đang cảnh báo',
  warning: 'Warning · Cảnh báo',
  critical: 'Critical · Nguy cấp',
  unknown: 'Chưa xác định',
  not_configured: 'Chưa đặt ngưỡng',
};

export function SensorPanel({ device, now }: { device: DeviceView; now?: number }) {
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const reading = device.latest;
  return (
    <section aria-label={`Cảm biến ${device.name}`}>
      {device.source_kind === 'simulator' ? (
        <div className="notice simulation">
          <Activity size={16} /> Dữ liệu mô phỏng
        </div>
      ) : null}
      {!reading ? (
        <div className="empty">
          <Activity size={30} />
          <h3>Chưa có dữ liệu cảm biến</h3>
        </div>
      ) : (
        <>
          <div className="sensor-grid">
            {[
              {
                title: 'Nhiệt độ',
                value: reading.payload.sensors.dht11.temperature_c,
                unit: '°C',
                sensor: reading.payload.sensors.dht11,
                icon: Thermometer,
                color: 'orange',
              },
              {
                title: 'Độ ẩm',
                value: reading.payload.sensors.dht11.humidity_pct,
                unit: '%RH',
                sensor: reading.payload.sensors.dht11,
                icon: Droplets,
                color: 'blue',
              },
              {
                title: 'MQ-2',
                value: reading.payload.sensors.mq2.adc_raw,
                unit: 'ADC',
                sensor: reading.payload.sensors.mq2,
                icon: Wind,
                color: 'teal',
                level: reading.payload.alert_snapshot.gas,
              },
              {
                title: 'MQ-7',
                value: reading.payload.sensors.mq7.adc_raw,
                unit: 'ADC',
                sensor: reading.payload.sensors.mq7,
                icon: Wind,
                color: 'purple',
                level: reading.payload.alert_snapshot.co,
              },
            ].map(({ title, value, unit, sensor, icon: Icon, color, level }) => (
              <article
                className={`panel sensor-card sensor-${level ?? 'normal'}`}
                key={title}
                aria-label={title}
              >
                <div className="sensor-heading">
                  <span>
                    {title === 'MQ-2' ? 'Khí gas · MQ-2' : title === 'MQ-7' ? 'CO · MQ-7' : title}
                  </span>
                  <span className={`icon-box ${color}`}>
                    <Icon size={20} />
                  </span>
                </div>
                <div className="reading-value">
                  {value === null ? '—' : Math.round(value * 10) / 10} <small>{unit}</small>
                </div>
                <p>{qualityText[sensor.quality]}</p>
                {level ? <span className={`badge level-${level}`}>{alertText[level]}</span> : null}
                <span className="freshness">
                  {sensorFreshness(
                    reading,
                    sensor.age_ms,
                    now ?? clock,
                    title === 'MQ-7' ? 180000 : 15000,
                  )}
                </span>
              </article>
            ))}
          </div>
          <div className="panel alert-strip">
            <Flame size={22} />
            <div>
              <strong>Cảm biến lửa</strong>
              <p>
                {reading.payload.sensors.flame.detected === null
                  ? 'Chưa xác định'
                  : reading.payload.sensors.flame.detected
                    ? 'Phát hiện lửa'
                    : 'Không phát hiện'}
              </p>
            </div>
            <span className={`badge level-${reading.payload.alert_snapshot.flame}`}>
              {alertText[reading.payload.alert_snapshot.flame]}
            </span>
            <span className="muted">
              Còi: {reading.payload.alert_snapshot.buzzer_commanded_on ? 'Bật' : 'Tắt'}
            </span>
          </div>
        </>
      )}
    </section>
  );
}

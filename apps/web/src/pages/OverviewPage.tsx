import { Cpu, Radio, Server, Bell, ArrowUpRight } from 'lucide-react';
import { Link } from 'react-router';
import type { DeviceView } from '@iot/contracts';
import { SensorPanel } from '../components/SensorPanel.js';
import { dateText } from '../components/FeatureUI.js';

export default function OverviewPage({
  devices,
  selectedId,
  onSelect,
  activeIncidents,
}: {
  devices: DeviceView[];
  selectedId: string;
  onSelect: (id: string) => void;
  activeIncidents: number | null;
}) {
  const selected = devices.find((d) => d.id === selectedId) ?? devices[0];
  const online = devices.filter((d) => d.status === 'online').length;
  return (
    <>
      <div className="page-title">
        <div>
          <h1>Tổng quan hệ thống</h1>
        </div>
      </div>
      <div className="stats-grid">
        {[
          {
            title: 'Tổng thiết bị',
            value: devices.length,
            icon: Cpu,
          },
          {
            title: 'Đã kết nối',
            value: online,
            icon: Radio,
          },
          {
            title: 'Chưa kết nối',
            value: devices.length - online,
            icon: Server,
          },
          {
            title: 'Sự cố chưa kết thúc',
            value: activeIncidents,
            icon: Bell,
          },
        ].map(({ title, value, icon: Icon }) => (
          <article className="panel stat-card" key={title}>
            <span>
              {title}
              <Icon size={18} />
            </span>
            <strong>{value ?? '—'}</strong>
          </article>
        ))}
      </div>
      <div className="section-heading">
        <div>
          <h2>Dữ liệu cảm biến</h2>
          <p className="muted">
            {selected ? `Cập nhật: ${dateText(selected.last_seen_at)}` : null}
          </p>
        </div>
        {selected ? (
          <label className="device-select">
            Thiết bị đang xem
            <select value={selected.id} onChange={(e) => onSelect(e.target.value)}>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.source_kind === 'simulator' ? ' · Mô phỏng' : ''}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {selected ? (
        <SensorPanel device={selected} />
      ) : (
        <div className="panel empty">
          <Cpu size={34} />
          <h3>Chưa có thiết bị</h3>
          <Link className="primary" to="/app/devices">
            Quản lý thiết bị
            <ArrowUpRight size={16} />
          </Link>
        </div>
      )}
    </>
  );
}

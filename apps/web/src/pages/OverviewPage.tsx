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
          <span className="eyebrow">SYSTEM OVERVIEW</span>
          <h1>Tổng quan hệ thống</h1>
          <p>Quan sát kết nối và dữ liệu cảm biến tại một nơi.</p>
        </div>
      </div>
      <div className="stats-grid">
        {[
          {
            title: 'Tổng thiết bị',
            value: devices.length,
            icon: Cpu,
            caption: 'Thiết bị đang quản lý',
          },
          {
            title: 'Đang online',
            value: online,
            icon: Radio,
            caption: 'Thiết bị đang kết nối',
          },
          {
            title: 'Chưa online',
            value: devices.length - online,
            icon: Server,
            caption: 'Offline hoặc chưa từng kết nối',
          },
          {
            title: 'Sự cố chưa kết thúc',
            value: activeIncidents,
            icon: Bell,
            caption: 'Xác nhận đã xem không đóng sự cố',
          },
        ].map(({ title, value, icon: Icon, caption }) => (
          <article className="panel stat-card" key={title}>
            <span>
              {title}
              <Icon size={18} />
            </span>
            <strong>{value ?? '—'}</strong>
            <small>{caption}</small>
          </article>
        ))}
      </div>
      <div className="section-heading">
        <div>
          <h2>Dữ liệu cảm biến</h2>
          <p className="muted">
            {selected
              ? `${selected.name} · Nhận cuối: ${dateText(selected.last_seen_at)}`
              : 'Chọn một nguồn dữ liệu để bắt đầu'}
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
          <p>Thêm thiết bị để bắt đầu giám sát.</p>
          <Link className="primary" to="/app/devices">
            Quản lý thiết bị
            <ArrowUpRight size={16} />
          </Link>
        </div>
      )}
    </>
  );
}

import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react';
import { NavLink, Navigate, Route, Routes, Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import {
  Activity,
  LayoutDashboard,
  Radio,
  Cpu,
  Settings,
  LogOut,
  ShieldCheck,
  Bell,
  ArrowUpRight,
  Plus,
  KeyRound,
  Sun,
  Moon,
  Server,
} from 'lucide-react';
import type { DeviceView, UserView } from '@iot/contracts';
import { api, HttpError } from './lib/api.js';
import { SensorPanel, alertText } from './components/SensorPanel.js';

const MonitoringChart = lazy(() => import('./pages/MonitoringChart.js'));
type Session = { user: UserView; expires_at: string };
const date = (value: string | null) =>
  value ? new Date(value).toLocaleString('vi-VN') : 'Chưa có';
const statusText = { online: 'Online', offline: 'Offline', never_seen: 'Chưa kết nối' };

function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const login = useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      api<Session>('/auth/login', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: onLogin,
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    login.mutate({ email: String(data.get('email')), password: String(data.get('password')) });
  }
  return (
    <main className="login-layout">
      <section className="login-brand">
        <div className="brand">
          <span className="brand-icon">
            <Activity />
          </span>{' '}
          AirGuard<span className="brand-sub">MONITOR</span>
        </div>
        <span className="eyebrow">IOT OBSERVABILITY PLATFORM</span>
        <h1>
          Dữ liệu rõ ràng.
          <br />
          <span>Giám sát chủ động.</span>
        </h1>
        <p>Theo dõi thiết bị và tín hiệu cảm biến trên một không gian làm việc thống nhất.</p>
        <div className="login-feature">
          <Radio size={20} />
          <span>Telemetry thời gian thực</span>
        </div>
        <div className="login-feature">
          <ShieldCheck size={20} />
          <span>Truy cập được phân quyền</span>
        </div>
        <div className="research-note">
          Dự án nghiên cứu và học tập. Không thay thế thiết bị cảnh báo an toàn đạt chứng nhận.
        </div>
      </section>
      <section className="login-form-area">
        <form onSubmit={submit} className="login-form panel">
          <span className="eyebrow">CHÀO MỪNG TRỞ LẠI</span>
          <h2>Đăng nhập</h2>
          <p className="muted">Sử dụng tài khoản được quản trị viên cấp.</p>
          <label>
            Email
            <input
              name="email"
              type="email"
              autoComplete="username"
              required
              placeholder="ban@example.com"
            />
          </label>
          <label>
            Mật khẩu
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
              placeholder="Nhập mật khẩu"
            />
          </label>
          {login.isError ? (
            <p className="error" role="alert">
              {login.error.message}
            </p>
          ) : null}
          <button className="primary full" disabled={login.isPending}>
            {login.isPending ? 'Đang xác thực…' : 'Đăng nhập'}
          </button>
          <p className="caption">
            Giữ đăng nhập tối đa 8 giờ bằng cookie bảo mật. Refresh trang không cần đăng nhập lại.
          </p>
        </form>
      </section>
    </main>
  );
}

function Devices({ devices, session }: { devices: DeviceView[]; session: Session }) {
  const queryClient = useQueryClient();
  const [newKey, setNewKey] = useState<{ key: string; key_id: string; deviceId: string } | null>(
    null,
  );
  const create = useMutation({
    mutationFn: (input: { name: string; source_kind: string }) =>
      api('/devices', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['devices'] }),
  });
  const issue = useMutation({
    mutationFn: async (deviceId: string) => ({
      ...(await api<{ key: string; key_id: string }>(`/devices/${deviceId}/credentials`, {
        method: 'POST',
      })),
      deviceId,
    }),
    onSuccess: setNewKey,
  });
  const revoke = useMutation({
    mutationFn: () =>
      api(`/devices/${newKey!.deviceId}/credentials/${newKey!.key_id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => setNewKey(null),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    create.mutate(
      { name: String(data.get('name')), source_kind: String(data.get('source_kind')) },
      { onSuccess: () => form.reset() },
    );
  }
  return (
    <>
      <div className="page-title">
        <div>
          <span className="eyebrow">DEVICE MANAGEMENT</span>
          <h1>Thiết bị</h1>
          <p>Quản lý nguồn dữ liệu và credential riêng của từng thiết bị.</p>
        </div>
        <Cpu size={32} />
      </div>
      {session.user.role === 'admin' ? (
        <form onSubmit={submit} className="panel inline-form">
          <label>
            Tên thiết bị
            <input name="name" required maxLength={80} placeholder="Ví dụ: Phòng thí nghiệm 01" />
          </label>
          <label>
            Nguồn dữ liệu
            <select name="source_kind">
              <option value="simulator">Simulator — dữ liệu mô phỏng</option>
              <option value="physical">Thiết bị thật</option>
            </select>
          </label>
          <button className="primary" disabled={create.isPending}>
            <Plus size={16} />
            Thêm thiết bị
          </button>
        </form>
      ) : null}
      {create.isError || issue.isError || revoke.isError ? (
        <p className="error" role="alert">
          {create.error?.message ?? issue.error?.message ?? revoke.error?.message}
        </p>
      ) : null}
      {newKey ? (
        <section className="panel key-panel" aria-label="Credential mới">
          <h2>Key chỉ hiển thị một lần</h2>
          <p>
            Lưu vào cấu hình local của thiết bị hoặc simulator. Không đưa vào Git hay gửi ảnh công
            khai.
          </p>
          <code>{newKey.key}</code>
          <p>
            Device ID: <code>{newKey.deviceId}</code>
          </p>
          <div className="button-row">
            <button onClick={() => setNewKey(null)}>Đã lưu, đóng</button>
            <button
              className="danger-button"
              onClick={() => revoke.mutate()}
              disabled={revoke.isPending}
            >
              Thu hồi key này
            </button>
          </div>
        </section>
      ) : null}
      <div className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>Thiết bị</th>
              <th>Nguồn</th>
              <th>Kết nối</th>
              <th>Liên lạc cuối</th>
              <th>Credential</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id}>
                <td>
                  <strong>{d.name}</strong>
                  <small className="device-id">{d.id}</small>
                </td>
                <td>
                  <span className={`badge ${d.source_kind === 'simulator' ? 'simulation' : ''}`}>
                    {d.source_kind === 'simulator' ? 'Mô phỏng' : 'Phần cứng'}
                  </span>
                </td>
                <td>
                  <span className={`status-dot ${d.status}`} />
                  {statusText[d.status]}
                </td>
                <td>{date(d.last_seen_at)}</td>
                <td>
                  {session.user.role === 'admin' ? (
                    <button
                      onClick={() => issue.mutate(d.id)}
                      disabled={issue.isPending || newKey !== null}
                    >
                      <KeyRound size={15} />
                      Cấp key
                    </button>
                  ) : (
                    'Chỉ admin'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!devices.length ? (
          <div className="empty">
            <h3>Chưa có thiết bị</h3>
            <p>Thêm simulator để kiểm thử trước khi có firmware.</p>
          </div>
        ) : null}
      </div>
    </>
  );
}

export function App() {
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [connected, setConnected] = useState(false);
  const [theme, setTheme] = useState(() =>
    localStorage.getItem('airguard.theme.v1') === 'light' ? 'light' : 'dark',
  );
  const queryClient = useQueryClient();
  const sessionQuery = useQuery({
    queryKey: ['session'],
    queryFn: async () => {
      try {
        return await api<Session>('/auth/session');
      } catch (error) {
        if (error instanceof HttpError && error.status === 401) return null;
        throw error;
      }
    },
    retry: false,
    staleTime: 60000,
    refetchInterval: 60000,
  });
  const session = sessionQuery.data ?? null;
  const devicesQuery = useQuery({
    queryKey: ['devices', session?.user.id],
    queryFn: () => api<DeviceView[]>('/devices'),
    enabled: session !== null,
    refetchInterval: 5000,
  });
  const devices = devicesQuery.data ?? [];
  const deviceIds = devices.map((d) => d.id).join(',');
  const userId = session?.user.id;
  const expiresAt = session?.expires_at;
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setTimeout(
      () => {
        void queryClient.invalidateQueries({ queryKey: ['session'] });
      },
      Math.max(0, Date.parse(expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [expiresAt, queryClient]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('airguard.theme.v1', theme);
  }, [theme]);
  useEffect(() => {
    if (!userId) return;
    const socket = io('/monitoring', { withCredentials: true, autoConnect: false });
    socket.on('connect', () => {
      setConnected(true);
      if (deviceIds) socket.emit('devices.subscribe', { device_ids: deviceIds.split(',') });
      void queryClient.invalidateQueries({ queryKey: ['devices'] });
      void queryClient.invalidateQueries({ queryKey: ['readings'] });
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));
    socket.on('telemetry.created', () => {
      void queryClient.invalidateQueries({ queryKey: ['devices'] });
      void queryClient.invalidateQueries({ queryKey: ['readings'] });
    });
    socket.connect();
    return () => {
      socket.disconnect();
    };
  }, [userId, deviceIds, queryClient]);

  async function logout() {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 401)) {
        setLogoutError('Chưa đăng xuất được khỏi server. Vui lòng kiểm tra kết nối và thử lại.');
        return;
      }
    }
    await queryClient.cancelQueries();
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' });
    queryClient.setQueryData(['session'], null);
    setSelectedId('');
    setLogoutError(null);
  }
  if (sessionQuery.isPending)
    return (
      <main className="login-form-area">
        <div role="status">Đang kiểm tra phiên đăng nhập…</div>
      </main>
    );
  if (sessionQuery.isError)
    return (
      <main className="login-form-area">
        <section className="panel settings-panel">
          <p role="alert">Không kiểm tra được phiên: {sessionQuery.error.message}</p>
          <button onClick={() => void sessionQuery.refetch()}>Thử lại</button>
        </section>
      </main>
    );
  if (!session) return <Login onLogin={(value) => queryClient.setQueryData(['session'], value)} />;
  const selected = devices.find((d) => d.id === selectedId) ?? devices[0];
  const online = devices.filter((d) => d.status === 'online').length;
  const active = devices.reduce(
    (count, d) =>
      count +
      (d.latest
        ? ['gas', 'co', 'flame'].filter(
            (key) => d.latest!.payload.alert_snapshot[key as 'gas' | 'co' | 'flame'] === 'active',
          ).length
        : 0),
    0,
  );
  const selector = devices.length ? (
    <label className="device-select">
      Thiết bị đang xem
      <select value={selected?.id ?? ''} onChange={(e) => setSelectedId(e.target.value)}>
        {devices.map((d) => (
          <option value={d.id} key={d.id}>
            {d.name}
            {d.source_kind === 'simulator' ? ' · Mô phỏng' : ''}
          </option>
        ))}
      </select>
    </label>
  ) : null;
  return (
    <div className="app-layout">
      <aside className="sidebar">
        <Link to="/app/overview" className="brand">
          <span className="brand-icon">
            <Activity />
          </span>
          AirGuard
        </Link>
        <span className="sidebar-label">KHÔNG GIAN GIÁM SÁT</span>
        <nav aria-label="Điều hướng chính">
          {[
            ['/app/overview', LayoutDashboard, 'Tổng quan'],
            ['/app/monitoring', Radio, 'Giám sát trực tiếp'],
            ['/app/alerts', Bell, 'Cảnh báo hiện tại'],
            ['/app/devices', Cpu, 'Thiết bị'],
            ['/app/settings', Settings, 'Cài đặt'],
          ].map(([path, Icon, label]) => {
            const NavIcon = Icon as typeof Activity;
            return (
              <NavLink key={String(path)} to={String(path)}>
                <NavIcon size={19} />
                {String(label)}
              </NavLink>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-tag">
            <Server size={16} />
            <span>Môi trường local</span>
          </div>
          <p>
            Dự án nghiên cứu IoT
            <br />
            Không dùng thay hệ thống an toàn đạt chứng nhận.
          </p>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span className="breadcrumb">
            Workspace <span>/</span> Giám sát môi trường
          </span>
          <div className="topbar-actions">
            <span className={`badge ${connected ? 'success' : ''}`}>
              <span className={`status-dot ${connected ? 'online' : 'offline'}`} />
              {connected ? 'Realtime kết nối' : 'Đang dùng REST / mất realtime'}
            </span>
            <button
              aria-label="Đổi giao diện"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button aria-label="Đăng xuất" onClick={() => void logout()}>
              <LogOut size={18} />
            </button>
            <div className="avatar">{session.user.email.slice(0, 1).toUpperCase()}</div>
          </div>
        </header>
        <main className="content">
          {logoutError ? (
            <p className="notice error" role="alert">
              {logoutError}
            </p>
          ) : null}
          {devicesQuery.isError ? (
            <div className="notice error" role="alert">
              Không tải được dữ liệu: {devicesQuery.error.message}. Trạng thái kết nối thiết bị chưa
              được xác minh. <button onClick={() => void devicesQuery.refetch()}>Thử lại</button>
              <button onClick={() => void logout()}>Đăng nhập lại</button>
            </div>
          ) : null}
          {devicesQuery.isPending ? (
            <div className="skeleton" aria-label="Đang tải thiết bị" />
          ) : null}
          <Routes>
            <Route path="/app/devices" element={<Devices devices={devices} session={session} />} />
            <Route
              path="/app/settings"
              element={
                <>
                  <div className="page-title">
                    <div>
                      <span className="eyebrow">PREFERENCES</span>
                      <h1>Cài đặt</h1>
                      <p>Tài khoản và giao diện làm việc.</p>
                    </div>
                  </div>
                  <section className="panel settings-panel">
                    <h2>Tài khoản</h2>
                    <p>{session.user.email}</p>
                    <span className="badge">Quyền: {session.user.role}</span>
                    <h2>Giao diện</h2>
                    <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
                      Chuyển sang chế độ {theme === 'dark' ? 'sáng' : 'tối'}
                    </button>
                    <h2>Chính sách cảnh báo</h2>
                    <p className="muted">
                      Không cung cấp lệnh tắt còi từ dashboard. Ngưỡng gas/CO chưa được cấu hình khi
                      chưa có căn cứ đo lường.
                    </p>
                    <h2>Phiên đăng nhập</h2>
                    <p className="muted">
                      Phiên được lưu bằng cookie HttpOnly, hết hạn sau 8 giờ. Refresh trang không
                      cần đăng nhập lại. Đăng xuất sẽ thu hồi phiên trên server.
                    </p>
                  </section>
                </>
              }
            />
            <Route
              path="/app/alerts"
              element={
                <>
                  <div className="page-title">
                    <div>
                      <span className="eyebrow">ALERT SNAPSHOT</span>
                      <h1>Cảnh báo hiện tại</h1>
                      <p>
                        Snapshot firmware gần nhất, không phải lịch sử sự cố. Dữ liệu cũ không chứng
                        minh tình trạng hiện tại.
                      </p>
                    </div>
                  </div>
                  <div className="panel table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Thiết bị</th>
                          <th>Gas</th>
                          <th>CO</th>
                          <th>Flame</th>
                          <th>Thời điểm đo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {devices.map((d) => (
                          <tr key={d.id}>
                            <td>
                              {d.name}
                              {d.source_kind === 'simulator' ? (
                                <span className="badge simulation">Mô phỏng</span>
                              ) : null}
                            </td>
                            {(['gas', 'co', 'flame'] as const).map((c) => (
                              <td key={c}>
                                <span
                                  className={`badge ${d.latest?.payload.alert_snapshot[c] === 'active' ? 'danger' : ''}`}
                                >
                                  {d.latest
                                    ? alertText[d.latest.payload.alert_snapshot[c]]
                                    : 'Chưa có dữ liệu'}
                                </span>
                              </td>
                            ))}
                            <td>{date(d.latest?.payload.sampled_at ?? null)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!devices.length ? <div className="empty">Chưa có thiết bị</div> : null}
                  </div>
                </>
              }
            />
            <Route
              path="/app/monitoring"
              element={
                <>
                  <div className="page-title">
                    <div>
                      <span className="eyebrow">LIVE MONITORING</span>
                      <h1>Giám sát trực tiếp</h1>
                      <p>Tín hiệu cảm biến, chất lượng và thời điểm cập nhật.</p>
                    </div>
                    {selector}
                  </div>
                  {selected ? (
                    <>
                      <SensorPanel device={selected} />
                      <section className="panel chart-panel">
                        <div className="section-heading">
                          <h2>Nhiệt độ & độ ẩm</h2>
                          <span className="badge">120 mẫu gần nhận nhất</span>
                        </div>
                        <Suspense fallback={<div className="skeleton" />}>
                          <MonitoringChart deviceId={selected.id} />
                        </Suspense>
                      </section>
                    </>
                  ) : (
                    <div className="empty">
                      <h3>Chưa có thiết bị</h3>
                      <Link to="/app/devices">Thêm thiết bị</Link>
                    </div>
                  )}
                </>
              }
            />
            <Route
              path="/app/overview"
              element={
                <>
                  <div className="page-title">
                    <div>
                      <span className="eyebrow">SYSTEM OVERVIEW</span>
                      <h1>Tổng quan hệ thống</h1>
                      <p>Quan sát kết nối và dữ liệu cảm biến tại một nơi.</p>
                    </div>
                    <span className="badge">
                      <span className="status-dot online" />
                      Local workspace
                    </span>
                  </div>
                  <div className="stats-grid">
                    {[
                      {
                        title: 'Tổng thiết bị',
                        value: devices.length,
                        icon: Cpu,
                        caption: 'Nguồn dữ liệu đã đăng ký',
                      },
                      {
                        title: 'Đang online',
                        value: online,
                        icon: Radio,
                        caption: 'Có liên lạc trong 30 giây',
                      },
                      {
                        title: 'Chưa online',
                        value: devices.length - online,
                        icon: Server,
                        caption: 'Offline hoặc chưa từng kết nối',
                      },
                      {
                        title: 'Điều kiện cảnh báo',
                        value: active,
                        icon: Bell,
                        caption: 'Theo snapshot gần nhất, có thể cũ',
                      },
                    ].map(({ title, value, icon: Icon, caption }) => (
                      <article className="panel stat-card" key={title}>
                        <span>
                          {title}
                          <Icon size={18} />
                        </span>
                        <strong>{value}</strong>
                        <small>{caption}</small>
                      </article>
                    ))}
                  </div>
                  <div className="section-heading">
                    <div>
                      <h2>Dữ liệu cảm biến</h2>
                      <p className="muted">
                        {selected
                          ? `${selected.name} · Nhận cuối: ${date(selected.last_seen_at)}`
                          : 'Chọn một nguồn dữ liệu để bắt đầu'}
                      </p>
                    </div>
                    {selector}
                  </div>
                  {selected ? (
                    <SensorPanel device={selected} />
                  ) : (
                    <div className="panel empty">
                      <Cpu size={34} />
                      <h3>Chưa có thiết bị</h3>
                      <p>Đăng ký simulator hoặc ESP32. Dashboard không tự tạo dữ liệu.</p>
                      <Link className="primary" to="/app/devices">
                        Quản lý thiết bị
                        <ArrowUpRight size={16} />
                      </Link>
                    </div>
                  )}
                  <div className="notice">
                    <ShieldCheck size={18} />
                    <span>
                      MQ-2/MQ-7 đang dùng tín hiệu thô. Chưa công bố nồng độ khí hoặc chỉ số chất
                      lượng không khí.
                    </span>
                  </div>
                </>
              }
            />
            <Route path="*" element={<Navigate to="/app/overview" replace />} />
          </Routes>
          <footer>
            AirGuard Monitor <span>•</span> Nghiên cứu & học tập <span>•</span> Firmware tích hợp
            sau
          </footer>
        </main>
      </div>
    </div>
  );
}

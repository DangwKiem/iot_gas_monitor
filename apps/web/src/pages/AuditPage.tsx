import { useState, type FormEvent } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { AuditView, UserView } from '@iot/contracts';
import { apiPage } from '../lib/api.js';
import { PageTitle, LoadState, dateText, roleText } from '../components/FeatureUI.js';

const actionText: Record<string, string> = {
  'user.created': 'Tạo tài khoản',
  'user.updated': 'Cập nhật tài khoản',
  'user.password_changed': 'Đổi mật khẩu',
  'user.email_changed': 'Đổi email',
  'device.created': 'Thêm thiết bị',
  'device.updated': 'Cập nhật thiết bị',
  'credential.created': 'Cấp khóa kết nối',
  'credential.rotated': 'Đổi khóa kết nối',
  'credential.revoked': 'Thu hồi khóa kết nối',
  'config.created': 'Cập nhật cấu hình',
  'incident.acknowledged': 'Xác nhận sự cố',
  'maintenance.applied': 'Bảo trì dữ liệu',
};
const resourceText: Record<string, string> = {
  user: 'Tài khoản',
  device: 'Thiết bị',
  maintenance: 'Bảo trì',
};
const fieldText: Record<string, string> = {
  role: 'Quyền',
  active: 'Hoạt động',
  password_reset: 'Đặt lại mật khẩu',
  name: 'Tên',
  location: 'Vị trí',
  description: 'Mô tả',
  archived: 'Lưu trữ',
  source_kind: 'Loại thiết bị',
  key_id: 'Mã khóa',
  replaces_key_id: 'Thay thế khóa',
  version: 'Phiên bản',
  content_hash: 'Mã xác thực cấu hình',
  config: 'Cấu hình',
  reporting_interval_ms: 'Chu kỳ gửi (ms)',
  alert_policy: 'Ngưỡng cảnh báo',
  gas: 'Khí gas',
  co: 'CO',
  flame: 'Lửa',
  warning_on: 'Kích hoạt Warning',
  warning_off: 'Tắt Warning',
  critical_on: 'Kích hoạt Critical',
  critical_off: 'Tắt Critical',
  alarm_on: 'Kích hoạt',
  alarm_off: 'Tắt cảnh báo',
  active_below: 'Tín hiệu giảm khi phát hiện',
  note: 'Ghi chú',
  incident_id: 'Mã sự cố',
  condition: 'Loại cảnh báo',
  removed: 'Số bản ghi đã xóa',
  raw_days: 'Số ngày lưu dữ liệu chi tiết',
  batch_size: 'Số bản ghi mỗi lượt',
};
function AuditDetails({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <>—</>;
  if (typeof value === 'boolean') return <>{value ? 'Có' : 'Không'}</>;
  if (typeof value !== 'object') {
    const text = String(value);
    return (
      <>
        {roleText[text as keyof typeof roleText] ??
          { physical: 'Thiết bị thật', simulator: 'Mô phỏng' }[text] ??
          text}
      </>
    );
  }
  return (
    <dl className="audit-details">
      {Object.entries(value).map(([key, entry]) => (
        <div key={key}>
          <dt>{fieldText[key] ?? key.replaceAll('_', ' ')}</dt>
          <dd>
            <AuditDetails value={entry} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default function AuditPage({ user }: { user: UserView }) {
  const [filter, setFilter] = useState('');
  const logs = useInfiniteQuery({
    queryKey: ['audit', filter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      apiPage<AuditView[]>(
        `/audit-logs?limit=30&${filter}${pageParam ? `&cursor=${pageParam}` : ''}`,
      ),
    getNextPageParam: (page) => page.meta.next_cursor ?? undefined,
    enabled: user.role === 'admin',
  });
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = new URLSearchParams();
    for (const [key, value] of new FormData(e.currentTarget)) {
      if (!value) continue;
      const text = String(value);
      q.set(
        key,
        key === 'action'
          ? (Object.keys(actionText).find((code) => actionText[code] === text) ?? text)
          : text,
      );
    }
    setFilter(q.toString());
  }
  if (user.role !== 'admin') return <p role="alert">Bạn cần quyền quản trị để xem nhật ký.</p>;
  return (
    <>
      <PageTitle title="Nhật ký quản trị" />
      <form className="panel filter-grid" onSubmit={submit}>
        <label>
          Đối tượng
          <select name="resource_type">
            <option value="">Tất cả</option>
            <option value="user">Tài khoản</option>
            <option value="device">Thiết bị</option>
            <option value="maintenance">Bảo trì</option>
          </select>
        </label>
        <label>
          Mã đối tượng
          <input name="resource_id" maxLength={100} />
        </label>
        <label>
          Hành động
          <input name="action" list="audit-actions" maxLength={100} />
          <datalist id="audit-actions">
            {Object.values(actionText).map((label) => (
              <option key={label} value={label} />
            ))}
          </datalist>
        </label>
        <button>Lọc nhật ký</button>
      </form>
      <LoadState pending={logs.isPending} error={logs.error} retry={() => void logs.refetch()} />
      <div className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>Thời gian</th>
              <th>Người thực hiện</th>
              <th>Hành động</th>
              <th>Đối tượng</th>
              <th>Chi tiết</th>
            </tr>
          </thead>
          <tbody>
            {logs.data?.pages
              .flatMap((p) => p.data)
              .map((a) => (
                <tr key={a.id}>
                  <td>{dateText(a.created_at)}</td>
                  <td>{a.user?.email ?? 'Tác vụ hệ thống'}</td>
                  <td>{actionText[a.action] ?? 'Thao tác quản trị'}</td>
                  <td>{resourceText[a.resource_type] ?? 'Khác'}</td>
                  <td>
                    <details>
                      <summary>Xem chi tiết</summary>
                      <dl className="audit-details">
                        <div>
                          <dt>Mã đối tượng</dt>
                          <dd>{a.resource_id ?? '—'}</dd>
                        </div>
                        {!actionText[a.action] ? (
                          <div>
                            <dt>Hành động</dt>
                            <dd>{a.action}</dd>
                          </div>
                        ) : null}
                      </dl>
                      <AuditDetails value={a.metadata} />
                    </details>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        {logs.data?.pages.every((page) => !page.data.length) ? (
          <div className="empty">Chưa có hoạt động phù hợp.</div>
        ) : null}
      </div>
      {logs.hasNextPage ? (
        <button
          className="load-more"
          disabled={logs.isFetchingNextPage}
          onClick={() => void logs.fetchNextPage()}
        >
          Tải thêm nhật ký
        </button>
      ) : null}
    </>
  );
}

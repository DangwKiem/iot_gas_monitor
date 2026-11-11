import { userMessage } from '../lib/api.js';

export const dateText = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString('vi-VN') : 'Chưa xác định';
export const conditionText = { gas: 'Khí gas', co: 'CO', flame: 'Lửa' };
export const roleText = {
  admin: 'Quản trị viên',
  operator: 'Nhân viên vận hành',
  viewer: 'Người xem',
};
export const connectionText: Record<string, string> = {
  online: 'Đã kết nối',
  offline: 'Mất kết nối',
  never_seen: 'Chưa kết nối',
};
export const qualityText = {
  valid: 'Hợp lệ',
  invalid: 'Lỗi cảm biến',
  warming_up: 'Đang làm nóng',
  uncalibrated: 'Chưa hiệu chuẩn',
  heating: 'Đang gia nhiệt',
};
export function PageTitle({ title }: { title: string }) {
  return (
    <div className="page-title">
      <div>
        <h1>{title}</h1>
      </div>
    </div>
  );
}
export function LoadState({
  pending,
  error,
  retry,
}: {
  pending?: boolean;
  error?: Error | null;
  retry?: () => void;
}) {
  if (pending) return <div className="skeleton" role="status" aria-label="Đang tải dữ liệu" />;
  if (error)
    return (
      <div className="notice error" role="alert">
        {userMessage(error)}
        {retry ? <button onClick={retry}>Thử lại</button> : null}
      </div>
    );
  return null;
}

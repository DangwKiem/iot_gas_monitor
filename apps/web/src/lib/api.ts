export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
const errorText: Record<string, string> = {
  UNAUTHORIZED: 'Vui lòng đăng nhập lại.',
  WEB_PUSH_DISABLED: 'Thông báo trình duyệt hiện chưa khả dụng.',
  VAPID_KEY_CHANGED: 'Không thể bật thông báo. Tải lại trang rồi thử lại.',
  INVALID_PUSH_KEY: 'Không thể bật thông báo. Tải lại trang rồi thử lại.',
  PUSH_EXPIRED: 'Vui lòng bật lại thông báo.',
  PUSH_ENDPOINT_OWNED: 'Trình duyệt này đang nhận thông báo cho tài khoản khác.',
  PUSH_LIMIT: 'Đã đạt giới hạn 20 trình duyệt nhận thông báo cho tài khoản này.',
  ROLLUP_ALIGNMENT_REQUIRED:
    'Chọn mốc thời gian tròn phút hoặc giờ (UTC), hoặc nhóm dữ liệu nhỏ hơn.',
  ROLLUP_RESOLUTION_UNAVAILABLE: 'Không còn dữ liệu theo phút. Hãy nhóm theo giờ hoặc ngày.',
  INCOMPATIBLE_ADC_PROFILES: 'Hãy chọn một độ phân giải ADC để phân tích.',
  RAW_DATA_RETAINED_AS_ROLLUP:
    'Không đủ dữ liệu chi tiết để xuất CSV. Hãy chọn khoảng thời gian ngắn hơn.',
  INVALID_CURSOR: 'Danh sách đã thay đổi. Tải lại trang rồi thử lại.',
  CONFIG_VERSION_CONFLICT: 'Cấu hình đã thay đổi. Tải lại rồi lưu lại.',
  VALIDATION_ERROR: 'Thông tin chưa hợp lệ. Kiểm tra các trường và thử lại.',
};
export function userMessage(error: Error) {
  if (error instanceof HttpError) {
    if (error.code && errorText[error.code]) return errorText[error.code];
    if (error.status >= 500) return 'Không thể xử lý yêu cầu. Vui lòng thử lại.';
    return error.message.replaceAll('key', 'khóa').replaceAll('admin', 'quản trị viên');
  }
  if (error instanceof TypeError || error.name === 'TimeoutError' || error.name === 'AbortError')
    return 'Không thể kết nối. Vui lòng thử lại.';
  if (
    ['NotAllowedError', 'NotSupportedError', 'InvalidStateError', 'OperationError'].includes(
      error.name,
    )
  )
    return 'Không thể bật thông báo. Kiểm tra quyền thông báo trong trình duyệt rồi thử lại.';
  return error.message;
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  return (await apiPage<T>(path, options)).data;
}
export type ApiPage<T> = {
  data: T;
  meta: { next_cursor?: string | null; request_id?: string; server_time?: string };
};
export async function apiPage<T>(path: string, options: RequestInit = {}): Promise<ApiPage<T>> {
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      'X-Requested-With': 'AirGuard',
      ...options.headers,
    },
  });
  if (response.status === 204) return { data: undefined as T, meta: {} };
  const body = (await response.json()) as ApiPage<T> & {
    error?: { message: string; code?: string };
  };
  if (!response.ok)
    throw new HttpError(
      response.status,
      body.error?.message ?? 'Không thể kết nối. Vui lòng thử lại.',
      body.error?.code,
    );
  return body;
}

export async function downloadCsv(path: string, filename: string) {
  const response = await fetch(`/api/v1${path}`, {
    credentials: 'include',
    headers: { 'X-Requested-With': 'AirGuard' },
  });
  if (!response.ok) {
    const body = (await response.json()) as { error?: { message: string; code?: string } };
    throw new HttpError(
      response.status,
      body.error?.message ?? 'Không thể xuất CSV. Vui lòng thử lại.',
      body.error?.code,
    );
  }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

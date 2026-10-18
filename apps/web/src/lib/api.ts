export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      'X-Requested-With': 'AirGuard',
      ...options.headers,
    },
  });
  if (response.status === 204) return undefined as T;
  const body = (await response.json()) as { data?: T; error?: { message: string } };
  if (!response.ok)
    throw new HttpError(response.status, body.error?.message ?? 'Không thể liên lạc API.');
  return body.data as T;
}

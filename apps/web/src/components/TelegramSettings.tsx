import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { LoadState } from './FeatureUI.js';
export function TelegramSettings() {
  const [code, setCode] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const status = useQuery({
    queryKey: ['telegram-link'],
    queryFn: () =>
      api<{ enabled: boolean; linked: boolean; bot_username: string | null }>('/telegram/link'),
    refetchInterval: 5000,
  });
  const issue = useMutation({
    mutationFn: () => api<{ code: string }>('/telegram/link-code', { method: 'POST' }),
    onSuccess: (data) => setCode(data.code),
  });
  const unlink = useMutation({
    mutationFn: () => api('/telegram/link', { method: 'DELETE' }),
    onSuccess: async () => {
      setCode(null);
      setConfirm(false);
      await status.refetch();
    },
  });
  return (
    <section className="panel feature-section" aria-label="Telegram">
      <h2>Telegram</h2>
      <LoadState
        pending={status.isPending}
        error={status.error ?? issue.error ?? unlink.error}
        retry={() => void status.refetch()}
      />
      {status.data ? (
        <>
          <p>
            {status.data.linked
              ? 'Đã liên kết tài khoản'
              : status.data.enabled
                ? 'Chưa liên kết tài khoản'
                : 'Telegram hiện chưa khả dụng.'}
          </p>
          {status.data.linked ? (
            confirm ? (
              <>
                <p>Hủy liên kết Telegram?</p>
                <div className="button-row">
                  <button
                    className="danger-button"
                    disabled={unlink.isPending}
                    onClick={() => unlink.mutate()}
                  >
                    Hủy liên kết
                  </button>
                  <button onClick={() => setConfirm(false)}>Giữ liên kết</button>
                </div>
              </>
            ) : (
              <button onClick={() => setConfirm(true)}>Hủy liên kết Telegram</button>
            )
          ) : status.data.enabled ? (
            <>
              <button disabled={issue.isPending} onClick={() => issue.mutate()}>
                {code ? 'Tạo mã mới' : 'Liên kết Telegram'}
              </button>
              {code ? (
                <>
                  <p className="caption">Gửi lệnh này cho bot trong 5 phút:</p>
                  <code className="telegram-link-code">/link {code}</code>
                  {status.data.bot_username ? (
                    <p>
                      <a
                        href={`https://t.me/${status.data.bot_username}?start=${code}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Mở Telegram
                      </a>
                    </p>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

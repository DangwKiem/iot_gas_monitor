import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import type { PushConfigView, PushSubscriptionView } from '@iot/contracts';
import { api } from '../lib/api.js';
import {
  supportsWebPush,
  browserPushStatus,
  enableBrowserPush,
  disableBrowserPush,
} from '../lib/web-push.js';
import { LoadState } from './FeatureUI.js';

export function PushSettings() {
  const [choice, setChoice] = useState<boolean | undefined>();
  const supported = supportsWebPush();
  const settings = useQuery({
    queryKey: ['web-push-settings'],
    queryFn: async () => {
      const config = await api<PushConfigView>('/push/config');
      if (!config.enabled) return { config, server: null, local: null };
      const [server, local] = await Promise.all([
        api<PushSubscriptionView | null>('/push/subscription'),
        browserPushStatus(),
      ]);
      return { config, server, local };
    },
  });
  const includeSimulators = choice ?? settings.data?.server?.include_simulators ?? false;
  const enable = useMutation({
    mutationFn: () => enableBrowserPush(settings.data!.config.public_key!, includeSimulators),
    onSuccess: () => settings.refetch(),
  });
  const disable = useMutation({
    mutationFn: disableBrowserPush,
    onSuccess: () => settings.refetch(),
  });
  const active =
    !!settings.data?.server &&
    !!settings.data?.local &&
    settings.data.server.endpoint_hash === settings.data.local.endpointHash &&
    settings.data.server.vapid_public_key === settings.data.config.public_key &&
    settings.data.local.publicKey === settings.data.config.public_key;
  return (
    <section className="panel feature-section" aria-label="Thông báo trình duyệt">
      <h2>Thông báo trình duyệt</h2>
      <LoadState
        pending={settings.isPending}
        error={settings.error ?? enable.error ?? disable.error}
        retry={() => void settings.refetch()}
      />
      {settings.data?.config.enabled && !supported ? (
        <p className="notice">
          Không thể bật thông báo tại đây. Hãy dùng trình duyệt hỗ trợ và kết nối bảo mật.
        </p>
      ) : null}
      {settings.data && !settings.data.config.enabled ? (
        <p className="notice">Thông báo trình duyệt hiện chưa khả dụng.</p>
      ) : null}
      {settings.data?.config.enabled && supported ? (
        <>
          <p role="status">
            {active ? 'Đang nhận thông báo trên trình duyệt này' : 'Thông báo đang tắt'}
          </p>
          {Notification.permission === 'denied' ? (
            <p className="notice">
              Thông báo bị chặn. Cho phép thông báo trong cài đặt trình duyệt rồi thử lại.
            </p>
          ) : null}
          <label className="check-label">
            <input
              type="checkbox"
              checked={includeSimulators}
              onChange={(e) => setChoice(e.target.checked)}
            />
            Nhận cả cảnh báo mô phỏng
          </label>
          <div className="button-row">
            <button
              className="primary"
              disabled={
                enable.isPending || disable.isPending || Notification.permission === 'denied'
              }
              onClick={() => enable.mutate()}
            >
              {active ? 'Lưu tùy chọn' : 'Bật thông báo'}
            </button>
            <button
              disabled={enable.isPending || disable.isPending}
              onClick={() => disable.mutate()}
            >
              Tắt thông báo
            </button>
            <button onClick={() => void settings.refetch()}>Kiểm tra lại</button>
          </div>
        </>
      ) : null}
    </section>
  );
}

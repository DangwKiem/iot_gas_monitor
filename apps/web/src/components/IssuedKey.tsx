import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { LoadState } from './FeatureUI.js';

export type IssuedCredential = { key: string; key_id: string; deviceId: string };
export function IssuedKey({ issued, close }: { issued: IssuedCredential; close: () => void }) {
  const client = useQueryClient();
  const revoke = useMutation({
    mutationFn: () =>
      api(`/devices/${issued.deviceId}/credentials/${issued.key_id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['credentials', issued.deviceId] });
      close();
    },
  });
  return (
    <section className="panel key-panel" aria-label="Khóa kết nối mới">
      <h2>Khóa kết nối mới</h2>
      <p>Khóa chỉ hiển thị một lần. Hãy lưu lại và giữ bí mật.</p>
      <code>{issued.key}</code>
      <p>
        Mã thiết bị: <code>{issued.deviceId}</code>
      </p>
      <div className="button-row">
        <button onClick={close}>Đã lưu, đóng</button>
        <button
          className="danger-button"
          disabled={revoke.isPending}
          onClick={() => revoke.mutate()}
        >
          Thu hồi khóa này
        </button>
      </div>
      <LoadState error={revoke.error} />
    </section>
  );
}

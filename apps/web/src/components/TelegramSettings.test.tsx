// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TelegramSettings } from './TelegramSettings.js';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup(enabled = true, initial = false) {
  let linked = initial;
  const methods: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    methods.push(init?.method ?? 'GET');
    expect(init?.headers).toMatchObject({ 'X-Requested-With': 'AirGuard' });
    if (init?.method === 'DELETE') {
      linked = false;
      return new Response(null, { status: 204 });
    }
    return new Response(
      JSON.stringify({
        data: url.endsWith('/link-code')
          ? { code: 'a'.repeat(32) }
          : { enabled, linked, bot_username: 'AirGuardTestBot' },
      }),
    );
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TelegramSettings />
    </QueryClientProvider>,
  );
  return {
    methods,
    client,
    link: () => {
      linked = true;
    },
  };
}
it('issues a code only on a click, shows the command/deep link and clears it after linking', async () => {
  const state = setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Liên kết Telegram' }));
  expect(await screen.findByText(`/link ${'a'.repeat(32)}`)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Mở Telegram' })).toHaveAttribute(
    'href',
    `https://t.me/AirGuardTestBot?start=${'a'.repeat(32)}`,
  );
  state.link();
  await state.client.invalidateQueries({ queryKey: ['telegram-link'] });
  expect(await screen.findByText('Đã liên kết tài khoản')).toBeInTheDocument();
  expect(screen.queryByText(`/link ${'a'.repeat(32)}`)).not.toBeInTheDocument();
});
it('requires explicit unlink confirmation and supports canceling', async () => {
  const state = setup(true, true);
  fireEvent.click(await screen.findByRole('button', { name: 'Hủy liên kết Telegram' }));
  expect(state.methods).not.toContain('DELETE');
  fireEvent.click(screen.getByRole('button', { name: 'Giữ liên kết' }));
  fireEvent.click(screen.getByRole('button', { name: 'Hủy liên kết Telegram' }));
  fireEvent.click(screen.getByRole('button', { name: 'Hủy liên kết' }));
  await waitFor(() => expect(state.methods).toContain('DELETE'));
  expect(await screen.findByText('Chưa liên kết tài khoản')).toBeInTheDocument();
});
it('does not expose linking actions when the interactive bot is disabled', async () => {
  setup(false);
  expect(await screen.findByText('Telegram hiện chưa khả dụng.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Liên kết Telegram' })).not.toBeInTheDocument();
});

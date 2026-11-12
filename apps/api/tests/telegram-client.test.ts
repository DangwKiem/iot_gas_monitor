import { expect, it } from 'vitest';
import { sendTelegram, telegramRequest } from '../src/modules/telegram-client.js';

const config = {
  token: '123456789:abcdefghijklmnopqrstuvwxyz_123456789',
  chatId: '-1001234567890',
  includeSimulators: true,
};
it.each(['sendPhoto', 'editMessageMedia'] as const)(
  'uploads PNG as multipart for %s',
  async (method) => {
    const png = Buffer.from([137, 80, 78, 71]);
    const result = await telegramRequest(
      config.token,
      method,
      {
        chat_id: config.chatId,
        photo: png,
        ...(method === 'editMessageMedia'
          ? {
              message_id: 10,
              media: { type: 'photo', media: 'attach://photo', caption: 'Biểu đồ' },
            }
          : { caption: 'Biểu đồ' }),
      },
      async (url, init) => {
        expect(String(url).endsWith(`/${method}`)).toBe(true);
        expect(init?.headers).toBeUndefined();
        const form = init!.body as FormData;
        expect(form).toBeInstanceOf(FormData);
        const file = form.get('photo') as File;
        expect(file.type).toBe('image/png');
        expect(Buffer.from(await file.arrayBuffer())).toEqual(png);
        if (method === 'editMessageMedia')
          expect(JSON.parse(String(form.get('media')))).toMatchObject({
            type: 'photo',
            media: 'attach://photo',
          });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 10 } }));
      },
    );
    expect(result).toEqual({ message_id: 10 });
  },
);
it('sends HTML to the fixed Telegram API without enabling link previews', async () => {
  let sent: { url: string; body: Record<string, unknown> } | undefined;
  const result = await sendTelegram(config, '<b>device &amp; simulation</b>', async (url, init) => {
    sent = { url: String(url), body: JSON.parse(String(init?.body)) };
    expect(init?.method).toBe('POST');
    expect(init?.signal).toBeDefined();
    return new Response(JSON.stringify({ ok: true, result: { message_id: 123 } }), { status: 200 });
  });
  expect(result).toEqual({ ok: true });
  expect(sent?.url).toBe(`https://api.telegram.org/bot${config.token}/sendMessage`);
  expect(sent?.body).toMatchObject({
    chat_id: config.chatId,
    text: '<b>device &amp; simulation</b>',
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
});
it('honors Telegram retry_after but treats invalid/blocked credentials as permanent failures', async () => {
  const limited = await sendTelegram(
    config,
    'test',
    async () =>
      new Response(
        JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 30 } }),
        { status: 429 },
      ),
  );
  expect(limited).toMatchObject({ ok: false, retryable: true, retryAfterSeconds: 30 });
  const denied = await sendTelegram(
    config,
    'test',
    async () =>
      new Response(
        JSON.stringify({ ok: false, error_code: 403, description: `private ${config.token}` }),
        { status: 403 },
      ),
  );
  expect(denied).toMatchObject({ ok: false, retryable: false });
  expect(JSON.stringify(denied)).not.toContain(config.token);
});
it('never exposes token-bearing URLs or response bodies from network errors', async () => {
  const result = await sendTelegram(config, 'test', async () => {
    throw new Error(`fetch failed https://api.telegram.org/bot${config.token}`);
  });
  expect(result).toMatchObject({ ok: false, retryable: true });
  expect(JSON.stringify(result)).not.toContain(config.token);
});

it('handles known edit outcomes without leaking descriptions or bot secrets', async () => {
  for (const [description, code] of [
    ['message is not modified', 'TELEGRAM_NOT_MODIFIED'],
    ['message to edit not found', 'TELEGRAM_MESSAGE_GONE'],
  ]) {
    await expect(
      telegramRequest(
        config.token,
        'editMessageText',
        {},
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error_code: 400,
              description: `${description} ${config.token}`,
            }),
            { status: 400 },
          ),
      ),
    ).rejects.toMatchObject({ code, retryable: false });
  }
});
it('bounds long polling time and sanitizes timeout/network failures', async () => {
  const result = telegramRequest(
    config.token,
    'getUpdates',
    { timeout: 20 },
    async (_url, init) => {
      expect(init?.signal).toBeDefined();
      throw new DOMException(config.token, 'TimeoutError');
    },
  );
  await expect(result).rejects.toMatchObject({ code: 'TELEGRAM_NETWORK_ERROR', retryable: true });
});

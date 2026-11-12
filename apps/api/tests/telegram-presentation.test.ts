import { beforeEach, afterEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { telegramRequest } from '../src/modules/telegram-client.js';
import {
  configureTelegramPresentation,
  verifyTelegramIcons,
  telegramIconHtml,
  telegramButtonPresentation,
  unicodeTelegramPresentation,
  type TelegramIconName,
} from '../src/modules/telegram-presentation.js';
import { escapeTelegramHtml, formatTelegramMessage } from '../src/modules/telegram-message.js';

// Real IDs from the configured pack; no fabricated production emoji identifiers.
const ids = JSON.parse(
  readFileSync(new URL('../src/config/telegram-icons.json', import.meta.url), 'utf8'),
).icons as Record<TelegramIconName, string>;
const token = '123456789:abcdefghijklmnopqrstuvwxyz_123456789';
beforeEach(() =>
  configureTelegramPresentation({ customEmojiEnabled: false, buttonStylesEnabled: false }, ids),
);
afterEach(() =>
  configureTelegramPresentation({ customEmojiEnabled: false, buttonStylesEnabled: false }, ids),
);
const verify = async () => {
  configureTelegramPresentation({ customEmojiEnabled: true, buttonStylesEnabled: true }, ids);
  await verifyTelegramIcons(async (values) =>
    values.map((custom_emoji_id) => ({ custom_emoji_id, type: 'custom_emoji' })),
  );
};
const payload = (chat_id = 'private-chat') => ({
  chat_id,
  text: `${telegramIconHtml('home')} <b>AirGuard</b>`,
  parse_mode: 'HTML',
  reply_markup: {
    inline_keyboard: [
      [{ ...telegramButtonPresentation('🏠 Trang chủ'), callback_data: 'ag_abcdefghijklmnop_5' }],
    ],
  },
});

it('keeps Unicode when disabled or before metadata validation, and rejects invalid configured IDs', async () => {
  expect(telegramIconHtml('home')).toBe('🏠');
  expect(telegramButtonPresentation('🏠 Trang chủ')).toEqual({ text: '🏠 Trang chủ' });
  configureTelegramPresentation(
    { customEmojiEnabled: true, buttonStylesEnabled: true },
    { home: 'not-an-id', settings: '"><script>' },
  );
  let calls = 0;
  await verifyTelegramIcons(async () => {
    calls++;
    return [];
  });
  expect(calls).toBe(0);
  expect(telegramIconHtml('home')).toBe('🏠');
});
it('validates each custom ID against Telegram metadata and caches validation', async () => {
  configureTelegramPresentation({ customEmojiEnabled: true, buttonStylesEnabled: true }, ids);
  expect(telegramIconHtml('home')).toBe('🏠');
  let calls = 0;
  const lookup = async () => {
    calls++;
    return [
      { type: 'custom_emoji', custom_emoji_id: ids.home },
      { type: 'regular', custom_emoji_id: ids.settings },
    ];
  };
  await Promise.all([verifyTelegramIcons(lookup), verifyTelegramIcons(lookup)]);
  await verifyTelegramIcons(lookup);
  expect(calls).toBe(1);
  expect(telegramIconHtml('home')).toBe(`<tg-emoji emoji-id="${ids.home}">🏠</tg-emoji>`);
  expect(telegramIconHtml('settings')).toBe('⚙️');
  expect(telegramButtonPresentation('✓ 🏠 Trang chủ')).toMatchObject({
    text: '✓ Trang chủ',
    icon_custom_emoji_id: ids.home,
    style: 'primary',
  });
  expect(telegramButtonPresentation('Hủy liên kết').style).toBe('danger');
  expect(telegramButtonPresentation('✅ Xác nhận đã đọc').style).toBe('success');
  expect(telegramButtonPresentation('🚨 Cảnh báo hiện tại').style).toBeUndefined();
});
it('falls back when metadata fails without exposing API errors or tokens', async () => {
  const logs: string[] = [];
  configureTelegramPresentation(
    { customEmojiEnabled: true, buttonStylesEnabled: true },
    ids,
    (code) => logs.push(code),
  );
  await verifyTelegramIcons(async () => {
    throw new Error(token);
  });
  expect(telegramIconHtml('chart')).toBe('📈');
  expect(logs).toEqual(['TELEGRAM_CUSTOM_EMOJI_UNAVAILABLE']);
  expect(JSON.stringify(logs)).not.toContain(token);
});
it('sends valid HTML and native button icon/style without changing callback data', async () => {
  await verify();
  let body: Record<string, unknown> | undefined;
  const result = await telegramRequest(token, 'sendMessage', payload(), async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 10 } }));
  });
  expect(result).toEqual({ message_id: 10 });
  expect(String(body?.text)).toContain('<tg-emoji emoji-id=');
  const button = (body?.reply_markup as { inline_keyboard: Record<string, unknown>[][] })
    .inline_keyboard[0]![0]!;
  expect(button).toEqual({
    text: 'Trang chủ',
    icon_custom_emoji_id: ids.home,
    style: 'primary',
    callback_data: 'ag_abcdefghijklmnop_5',
  });
});
it('retries an explicit eligibility rejection once as Unicode and remembers fallback per chat', async () => {
  await verify();
  const bodies: Record<string, unknown>[] = [];
  const transport: typeof fetch = async (_url, init) => {
    const p = JSON.parse(String(init?.body));
    bodies.push(p);
    return bodies.length === 1
      ? new Response(
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: 'Custom emoji are not allowed for this bot',
          }),
          { status: 400 },
        )
      : new Response(JSON.stringify({ ok: true, result: { message_id: 10 } }));
  };
  await telegramRequest(token, 'sendMessage', payload(), transport);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toMatchObject({
    text: '🏠 <b>AirGuard</b>',
    reply_markup: {
      inline_keyboard: [[{ text: '🏠 Trang chủ', callback_data: 'ag_abcdefghijklmnop_5' }]],
    },
  });
  expect(JSON.stringify(bodies[1])).not.toMatch(/tg-emoji|icon_custom_emoji_id|"style"/);
  await telegramRequest(token, 'editMessageText', { ...payload(), message_id: 10 }, transport);
  expect(bodies).toHaveLength(3);
  expect(String(bodies[2]!.text)).not.toContain('tg-emoji');
  await telegramRequest(token, 'sendMessage', payload('other-chat'), transport);
  expect(String(bodies[3]!.text)).toContain('tg-emoji');
});
it('does not loop if the Unicode fallback is also rejected', async () => {
  await verify();
  let calls = 0;
  await expect(
    telegramRequest(token, 'sendMessage', payload(), async () => {
      calls++;
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: 400,
          description:
            calls === 1 ? 'icon_custom_emoji_id is unsupported' : `invalid HTML ${token}`,
        }),
        { status: 400 },
      );
    }),
  ).rejects.toMatchObject({ code: 'TELEGRAM_HTTP_400', retryable: false });
  expect(calls).toBe(2);
});
it.each([429, 500, 403] as const)(
  'preserves normal queue behavior for HTTP %s instead of retrying presentation',
  async (status) => {
    await verify();
    let calls = 0;
    await expect(
      telegramRequest(token, 'sendMessage', payload(), async () => {
        calls++;
        return new Response(
          JSON.stringify({
            ok: false,
            error_code: status,
            description: status === 403 ? 'bot was blocked by the user' : 'temporary failure',
            parameters: { retry_after: 90 },
          }),
          { status },
        );
      }),
    ).rejects.toMatchObject(
      status === 429
        ? { code: 'TELEGRAM_RATE_LIMITED', retryable: true, retryAfterSeconds: 90 }
        : { code: `TELEGRAM_HTTP_${status}`, retryable: status === 500 },
    );
    expect(calls).toBe(1);
  },
);
it('does not retry an ambiguous network failure as a presentation downgrade', async () => {
  await verify();
  let calls = 0;
  const result = telegramRequest(token, 'sendMessage', payload(), async () => {
    calls++;
    throw new Error(`https://api.telegram.org/bot${token}`);
  });
  await expect(result).rejects.toMatchObject({ code: 'TELEGRAM_NETWORK_ERROR', retryable: true });
  expect(calls).toBe(1);
});
it('preserves Unicode fallbacks in photo captions and escapes dynamic names', async () => {
  await verify();
  const rich = {
    caption: `${telegramIconHtml('chart')} ${escapeTelegramHtml('<b>Kitchen & Home</b>')}`,
    media: { type: 'photo', caption: telegramIconHtml('chart') },
    photo: Buffer.from([137, 80, 78, 71]),
    ...payload(),
  };
  const plain = unicodeTelegramPresentation(rich);
  expect(plain.caption).toBe('📈 &lt;b&gt;Kitchen &amp; Home&lt;/b&gt;');
  expect(plain.photo).toBe(rich.photo);
  expect(plain.media).toMatchObject({ caption: '📈' });
  const message = formatTelegramMessage({
    deviceName: '🏠 <tg-emoji emoji-id="123">X</tg-emoji>',
    simulator: false,
    condition: 'gas',
    severity: 'critical',
    ended: false,
    startedAt: new Date(),
    endedAt: null,
  });
  expect(message).toContain('🏠 &lt;tg-emoji');
  expect(message).toContain('🔴');
});

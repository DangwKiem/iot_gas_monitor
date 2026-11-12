import {
  verifyTelegramIcons,
  hasTelegramPresentation,
  unicodeTelegramPresentation,
  presentationUnavailable,
  disableChatPresentation,
  isPresentationRejection,
} from './telegram-presentation.js';
export type TelegramConfig = {
  token: string;
  chatId: string;
  includeSimulators: boolean;
  routeLinkedChats?: boolean;
};
export type TelegramBotConfig = { token: string };
export type TelegramResult =
  { ok: true } | { ok: false; retryable: boolean; code: string; retryAfterSeconds?: number };
export type TelegramMethod =
  | 'sendMessage'
  | 'editMessageText'
  | 'answerCallbackQuery'
  | 'getUpdates'
  | 'getMe'
  | 'getCustomEmojiStickers'
  | 'getStickerSet'
  | 'getForumTopicIconStickers'
  | 'setMyCommands'
  | 'setChatMenuButton'
  | 'getMyCommands'
  | 'getChatMenuButton'
  | 'sendPhoto'
  | 'editMessageMedia';
export class TelegramApiError extends Error {
  constructor(
    public code: string,
    public retryable: boolean,
    public retryAfterSeconds?: number,
  ) {
    super(code);
  }
}
export async function telegramRequest<T>(
  token: string,
  method: TelegramMethod,
  parameters: object,
  request: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<T> {
  let payload = parameters;
  if (['sendMessage', 'editMessageText', 'sendPhoto', 'editMessageMedia'].includes(method)) {
    await verifyTelegramIcons((ids) =>
      telegramRequest(token, 'getCustomEmojiStickers', { custom_emoji_ids: ids }, request, signal),
    );
    if (presentationUnavailable(payload)) payload = unicodeTelegramPresentation(payload);
  }
  const perform = async (payload: object, canFallback: boolean): Promise<T> => {
    try {
      let body: string | FormData = JSON.stringify(payload);
      if ('photo' in payload && payload.photo instanceof Uint8Array) {
        const form = new FormData();
        for (const [key, value] of Object.entries(payload)) {
          if (key === 'photo') continue;
          form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
        }
        form.append(
          'photo',
          new Blob([new Uint8Array(payload.photo).buffer], { type: 'image/png' }),
          'chart.png',
        );
        body = form;
      }
      const response = await request(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        redirect: 'error',
        ...(typeof body === 'string' ? { headers: { 'Content-Type': 'application/json' } } : {}),
        body,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(method === 'getUpdates' ? 35000 : 10000)])
          : AbortSignal.timeout(method === 'getUpdates' ? 35000 : 10000),
      });
      const raw: unknown = await response.json().catch(() => null);
      const data = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
      if (response.ok && data.ok === true && data.result !== undefined) return data.result as T;
      const status =
        Number.isInteger(data.error_code) &&
        Number(data.error_code) >= 400 &&
        Number(data.error_code) < 600
          ? Number(data.error_code)
          : response.status;
      if (
        canFallback &&
        hasTelegramPresentation(payload) &&
        isPresentationRejection(status, data.description)
      ) {
        disableChatPresentation(payload);
        return perform(unicodeTelegramPresentation(payload), false);
      }
      if (status === 429) {
        const params =
          typeof data.parameters === 'object' && data.parameters !== null
            ? (data.parameters as Record<string, unknown>)
            : {};
        const retry =
          Number.isInteger(params.retry_after) && Number(params.retry_after) > 0
            ? Math.min(Number(params.retry_after), 86400)
            : 30;
        throw new TelegramApiError('TELEGRAM_RATE_LIMITED', true, retry);
      }
      // Classify known edit outcomes internally; never propagate the description.
      if (
        ['editMessageText', 'editMessageMedia'].includes(method) &&
        status === 400 &&
        typeof data.description === 'string'
      ) {
        if (data.description.includes('message is not modified'))
          throw new TelegramApiError('TELEGRAM_NOT_MODIFIED', false);
        if (
          data.description.includes('message to edit not found') ||
          data.description.includes("message can't be edited")
        )
          throw new TelegramApiError('TELEGRAM_MESSAGE_GONE', false);
      }
      throw new TelegramApiError(
        status >= 400 ? `TELEGRAM_HTTP_${status}` : 'TELEGRAM_RESPONSE_INVALID',
        status === 408 || status >= 500 || status < 400,
      );
    } catch (error) {
      if (error instanceof TelegramApiError) throw error;
      // Bot URLs and Telegram response bodies can contain secrets or private data.
      throw new TelegramApiError('TELEGRAM_NETWORK_ERROR', true);
    }
  };
  return perform(payload, true);
}
export async function sendTelegram(
  config: TelegramConfig,
  text: string,
  request: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<TelegramResult> {
  try {
    const result = await telegramRequest<{ message_id: number }>(
      config.token,
      'sendMessage',
      {
        chat_id: config.chatId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      },
      request,
      signal,
    );
    if (!result || !Number.isInteger(result.message_id))
      return { ok: false, retryable: true, code: 'TELEGRAM_RESPONSE_INVALID' };
    return { ok: true };
  } catch (error) {
    const failure =
      error instanceof TelegramApiError
        ? error
        : new TelegramApiError('TELEGRAM_NETWORK_ERROR', true);
    return {
      ok: false,
      retryable: failure.retryable,
      code: failure.code,
      ...(failure.retryAfterSeconds ? { retryAfterSeconds: failure.retryAfterSeconds } : {}),
    };
  }
}

import { readFileSync } from 'node:fs';

const unicode = {
  home: '🏠',
  status: '📊',
  devices: '📱',
  chart: '📈',
  history: '📋',
  alerts: '🚨',
  settings: '⚙️',
  report: '📋',
  back: '⬅️',
  previous: '◀️',
  next: '▶️',
  refresh: '🔄',
  ack: '✅',
  warning: '🟠',
  critical: '🔴',
  resolved: '✅',
  online: '🟢',
  offline: '📡',
} as const;
export type TelegramIconName = keyof typeof unicode;
export type TelegramButtonStyle = 'primary' | 'success' | 'danger';
export type TelegramPresentationOptions = {
  customEmojiEnabled: boolean;
  buttonStylesEnabled: boolean;
};
type Lookup = (ids: string[]) => Promise<unknown>;
type WireButton = {
  text: string;
  icon_custom_emoji_id?: string;
  style?: TelegramButtonStyle;
  [key: string]: unknown;
};
const idPattern = /^[1-9]\d{0,19}$/;
let configured: Partial<Record<TelegramIconName, string>> = {};
try {
  const raw: unknown = JSON.parse(
    readFileSync(new URL('../config/telegram-icons.json', import.meta.url), 'utf8'),
  );
  const icons = (raw as { icons?: unknown })?.icons;
  if (icons && typeof icons === 'object' && !Array.isArray(icons))
    for (const name of Object.keys(unicode) as TelegramIconName[]) {
      const id = (icons as Record<string, unknown>)[name];
      if (typeof id === 'string' && idPattern.test(id)) configured[name] = id;
    }
} catch {
  /* Missing or malformed presentation config keeps the Unicode interface usable. */
}
let options: TelegramPresentationOptions = {
  customEmojiEnabled: false,
  buttonStylesEnabled: false,
};
let verified = new Set<string>(),
  verifyAfter = 0,
  inFlight: Promise<void> | undefined;
const degradedChats = new Map<string, number>();
let onFallback: (code: string) => void = () => {};
export function configureTelegramPresentation(
  value: TelegramPresentationOptions,
  ids?: Partial<Record<TelegramIconName, string>>,
  reportFallback?: (code: string) => void,
) {
  options = { ...value };
  verified = new Set();
  verifyAfter = 0;
  inFlight = undefined;
  degradedChats.clear();
  onFallback = reportFallback ?? (() => {});
  if (ids !== undefined)
    configured = Object.fromEntries(
      Object.entries(ids).filter(
        ([name, id]) =>
          Object.hasOwn(unicode, name) && typeof id === 'string' && idPattern.test(id),
      ),
    );
}
export async function verifyTelegramIcons(lookup: Lookup) {
  if (!options.customEmojiEnabled || Date.now() < verifyAfter) return;
  if (inFlight) return inFlight;
  const ids = [...new Set(Object.values(configured))];
  if (!ids.length) {
    verifyAfter = Date.now() + 300000;
    return;
  }
  inFlight = (async () => {
    try {
      const result = await lookup(ids);
      if (!Array.isArray(result)) throw new Error('INVALID_EMOJI_RESPONSE');
      const allowed = new Set(ids);
      verified = new Set(
        result.flatMap((s) =>
          s && typeof s === 'object' && s.type === 'custom_emoji' && allowed.has(s.custom_emoji_id)
            ? [s.custom_emoji_id as string]
            : [],
        ),
      );
      verifyAfter = Date.now() + 3600000;
    } catch {
      verified.clear();
      verifyAfter = Date.now() + 300000;
      onFallback('TELEGRAM_CUSTOM_EMOJI_UNAVAILABLE');
    }
  })().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}
function customId(name: TelegramIconName) {
  const id = configured[name];
  return options.customEmojiEnabled && id && verified.has(id) && Date.now() < verifyAfter
    ? id
    : undefined;
}
export function telegramIconHtml(name: TelegramIconName) {
  const id = customId(name);
  return id ? `<tg-emoji emoji-id="${id}">${unicode[name]}</tg-emoji>` : unicode[name];
}
const labels: Record<string, TelegramIconName> = {
  '🏠 Trang chủ': 'home',
  '📊 Trạng thái thiết bị': 'status',
  '📱 Danh sách thiết bị': 'devices',
  '📱 Chọn thiết bị': 'devices',
  '📱 Đổi thiết bị': 'devices',
  '📱 Lọc thiết bị': 'devices',
  '📱 Chọn thiết bị theo dõi': 'devices',
  '📈 Biểu đồ cảm biến': 'chart',
  '📋 Lịch sử cảnh báo': 'history',
  '🚨 Cảnh báo hiện tại': 'alerts',
  '⚙️ Cài đặt': 'settings',
  '📋 Báo cáo': 'report',
  '📋 Báo cáo định kỳ': 'report',
  '⬅️ Quay lại': 'back',
  '◀️ Trước': 'previous',
  'Sau ▶️': 'next',
  '🔄 Làm mới': 'refresh',
  '✅ Xác nhận đã đọc': 'ack',
};
export function telegramButtonPresentation(
  text: string,
  icon?: TelegramIconName,
  style?: TelegramButtonStyle,
): WireButton {
  const selected = text.startsWith('✓ ') ? '✓ ' : '';
  const label = selected ? text.slice(2) : text;
  const name = icon ?? labels[label],
    id = name ? customId(name) : undefined;
  const styled =
    style ??
    (label === 'Hủy liên kết'
      ? 'danger'
      : label === '✅ Xác nhận đã đọc'
        ? 'success'
        : label === '🏠 Trang chủ'
          ? 'primary'
          : undefined);
  let value = text;
  if (id && name) {
    const glyph = unicode[name];
    const plain = label.startsWith(glyph)
      ? label.slice(glyph.length).trimStart()
      : label.endsWith(glyph)
        ? label.slice(0, -glyph.length).trimEnd()
        : label;
    value = selected + plain;
  }
  return {
    text: value,
    ...(id ? { icon_custom_emoji_id: id } : {}),
    ...(options.buttonStylesEnabled && styled ? { style: styled } : {}),
  };
}
function plainHtml(text: unknown) {
  return typeof text === 'string'
    ? text.replace(/<tg-emoji\s+emoji-id="[1-9]\d{0,19}">([^<>]*)<\/tg-emoji>/g, '$1')
    : text;
}
export function unicodeTelegramPresentation(parameters: object): Record<string, unknown> {
  const result = { ...parameters } as Record<string, unknown>;
  for (const field of ['text', 'caption'])
    if (field in result) result[field] = plainHtml(result[field]);
  if (result.media && typeof result.media === 'object')
    result.media = {
      ...result.media,
      caption: plainHtml((result.media as Record<string, unknown>).caption),
    };
  const markup = result.reply_markup as { inline_keyboard?: WireButton[][] } | undefined;
  if (markup?.inline_keyboard)
    result.reply_markup = {
      ...markup,
      inline_keyboard: markup.inline_keyboard.map((row) =>
        row.map((button) => {
          const id = button.icon_custom_emoji_id,
            plain = { ...button };
          delete plain.icon_custom_emoji_id;
          delete plain.style;
          if (id) {
            const name = (Object.keys(unicode) as TelegramIconName[]).find(
              (name) => configured[name] === id,
            );
            if (name) {
              const selected = plain.text.startsWith('✓ ') ? '✓ ' : '';
              plain.text = `${selected}${unicode[name]} ${selected ? plain.text.slice(2) : plain.text}`;
            }
          }
          return plain;
        }),
      ),
    };
  return result;
}
export function hasTelegramPresentation(parameters: object) {
  const p = parameters as Record<string, unknown>;
  const markup = p.reply_markup as { inline_keyboard?: WireButton[][] } | undefined;
  return (
    [p.text, p.caption, (p.media as Record<string, unknown> | undefined)?.caption].some(
      (v) => typeof v === 'string' && v.includes('<tg-emoji '),
    ) || !!markup?.inline_keyboard?.flat().some((b) => b.icon_custom_emoji_id || b.style)
  );
}
export function presentationUnavailable(parameters: object) {
  const key = String((parameters as Record<string, unknown>).chat_id ?? '');
  const until = degradedChats.get(key) ?? 0;
  if (until > Date.now()) return true;
  degradedChats.delete(key);
  return false;
}
export function disableChatPresentation(parameters: object) {
  const key = String((parameters as Record<string, unknown>).chat_id ?? '');
  if (degradedChats.size >= 128) degradedChats.delete(degradedChats.keys().next().value!);
  degradedChats.set(key, Date.now() + 3600000);
  onFallback('TELEGRAM_PRESENTATION_FALLBACK');
}
export function isPresentationRejection(status: number, description: unknown) {
  return (
    [400, 403].includes(status) &&
    typeof description === 'string' &&
    /custom.?emoji|emoji.?id|tg-emoji|premium|button.?style|field.*style|unsupported.*(icon|style)|can't parse entities/i.test(
      description,
    )
  );
}

import type { EventEnvelope, EventStoreReader } from 'cortico/core/types.ts';

export const QQ_SOURCES = ['qq', 'qqbot'] as const;
export type QQSource = typeof QQ_SOURCES[number];
interface QQEvent {
  source: QQSource;
  cursor: number;
  ts: string;
  target: string;
  kind: 'group' | 'private';
  id: string;
}
export interface QQMessage extends QQEvent {
  deliveryCursor: number;
  senderId: string;
  messageId: string;
  body: string;
  mentioned: boolean;
  addressed: boolean;
  key: string;
}
export interface QQReceipt extends QQEvent {
  messageId: string;
  body: string;
  key: string;
}
export interface QQRecall extends QQEvent { messageId?: string }

export function isQQSource(source: unknown): source is QQSource {
  return source === 'qq' || source === 'qqbot';
}

/** QQ platform message IDs may be signed; account and conversation IDs must be positive. */
export function qqPlatformId(value: unknown): string | undefined {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return;
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^-?\d{1,20}$/u.test(String(value))) return;
  return BigInt(value).toString();
}
function positiveId(value: unknown): string | undefined {
  const id = qqPlatformId(value);
  return id && /^[1-9]\d*$/u.test(id) ? id : undefined;
}
function address(value: unknown): Pick<QQEvent, 'target' | 'kind' | 'id'> | null {
  if (typeof value !== 'string') return null;
  const match = /^(group|private):([1-9]\d{0,19})$/u.exec(value);
  return match ? { target: value, kind: match[1] as QQEvent['kind'], id: match[2] } : null;
}
function conversation(event: EventEnvelope): Pick<QQEvent, 'target' | 'kind' | 'id'> | null {
  if (event.source === 'qqbot') return address(event.meta?.conv);
  const conv = event.meta?.conv as { kind?: unknown; id?: unknown } | undefined;
  if (conv?.kind !== 'group' && conv?.kind !== 'private') return null;
  const id = positiveId(conv.id);
  return id ? { kind: conv.kind, id, target: `${conv.kind}:${id}` } : null;
}
function validEvent(event: EventEnvelope): event is EventEnvelope & { source: QQSource } {
  return isQQSource(event.source) && event.origin === 'external'
    && Number.isSafeInteger(event.cursor) && event.cursor > 0 && Number.isFinite(Date.parse(event.ts));
}
function ignoredMessage(event: EventEnvelope): boolean {
  const meta = event.meta;
  return meta?.history === true || meta?.self === true || meta?.role === 'assistant' || meta?.role === 'system'
    || meta?.sender === '对话' || meta?.inputRejected === true || meta?.sourceTimeKnown === false || meta?.replyAllowed === false;
}
function messageBody(event: EventEnvelope, senderId: string, messageId: string): string | null {
  const text = event.text;
  if (event.source === 'qq') {
    const prefix = /^#(-?\d{1,20}) \[/u.exec(text);
    if (!prefix || qqPlatformId(prefix[1]) !== messageId) return null;
    const delimiter = `(${senderId}): `;
    const offset = text.indexOf(delimiter);
    return offset > text.indexOf('] ') && text.indexOf('] ') >= 0 ? text.slice(offset + delimiter.length) : null;
  }
  const conv = conversation(event)!;
  if (!text.startsWith(conv.kind === 'group' ? '【QQ群 ' : '【QQ私聊 ')) return null;
  const offset = text.indexOf('：#');
  const header = text.slice(0, offset);
  const sender = event.meta?.sender;
  if (offset < 0 || typeof sender !== 'string' || !sender.endsWith(`(QQ:${senderId})`)
    || /[\r\n]/u.test(header) || !header.endsWith(`${sender}${conv.kind === 'private' ? '】' : ''}`)
    || !header.includes('】')) return null;
  const remainder = text.slice(offset + 2);
  const match = /^(-?\d{1,20}) ([\s\S]*)$/u.exec(remainder);
  return match && qqPlatformId(match[1]) === messageId ? match[2] : null;
}
function directMessage(event: EventEnvelope, allowArchive: boolean): QQMessage | null {
  if (!validEvent(event) || event.type !== 'qq.message' || ignoredMessage(event)
    || (!allowArchive && event.contextDelivery === 'archive-only')) return null;
  const conv = conversation(event);
  const senderId = positiveId(event.source === 'qq' ? event.meta?.user_id : event.meta?.user);
  const messageId = qqPlatformId(event.source === 'qq' ? event.meta?.message_id : event.meta?.platformMessageId);
  if (!conv || !senderId || messageId === undefined || (conv.kind === 'private' && conv.id !== senderId)) return null;
  if (event.source === 'qqbot' && event.senderKey !== conv.target) return null;
  const sourceTs = event.meta?.sourceTs;
  if (sourceTs !== undefined && (typeof sourceTs !== 'string' || Date.parse(sourceTs) !== Date.parse(event.ts))) return null;
  const rendered = messageBody(event, senderId, messageId);
  if (rendered === null) return null;
  // Base QQ exposes rendered mentions; qqbot exposes the OneBot segment-derived atMe flag.
  const baseMention = /@[^\r\n@]+?\(你\)/u;
  const mentioned = event.source === 'qqbot' ? event.meta?.atMe === true : baseMention.test(rendered);
  const body = (event.source === 'qqbot'
    ? mentioned ? rendered.replace(/^\s*@我/u, '') : rendered
    : rendered.replace(/^\s*@[^\r\n@]+?\(你\)/u, '')).trim();
  return { source: event.source, cursor: event.cursor, deliveryCursor: event.cursor, ts: event.ts,
    ...conv, senderId, messageId, body, mentioned, addressed: conv.kind === 'private' || mentioned,
    key: `${event.source}:${conv.target}:${messageId}` };
}

/** A deferred qqbot message is actionable only with its original archived event as provenance. */
export function parseQQMessage(event: EventEnvelope, store?: Pick<EventStoreReader, 'get'>): QQMessage | null {
  if (event.meta?.sourceCursor === undefined) return directMessage(event, false);
  if (!validEvent(event) || event.source !== 'qqbot' || event.type !== 'qq.message' || ignoredMessage(event)
    || event.contextDelivery === 'archive-only' || event.meta.replyAllowed !== true) return null;
  const cursor = event.meta.sourceCursor;
  if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor <= 0 || cursor >= event.cursor) return null;
  const original = store?.get(cursor);
  if (!original || original.source !== event.source || original.contextDelivery !== 'archive-only'
    || original.meta?.sourceCursor !== undefined) return null;
  const parsed = directMessage(original, true);
  const conv = conversation(event);
  const sourceTs = event.meta.sourceTs;
  if (!parsed || !conv || conv.target !== parsed.target || event.senderKey !== parsed.target
    || positiveId(event.meta.user) !== parsed.senderId || qqPlatformId(event.meta.platformMessageId) !== parsed.messageId
    || event.meta.atMe !== original.meta?.atMe || typeof sourceTs !== 'string'
    || Date.parse(sourceTs) !== Date.parse(original.ts)
    || event.text !== `【原消息时间 ${sourceTs}】\n${original.text}`) return null;
  return { ...parsed, deliveryCursor: event.cursor };
}

/** Final currently has no successful-send event; qqbot receipts are accepted only with ProMAX's delivery proof. */
export function parseQQReceipt(event: EventEnvelope): QQReceipt | null {
  if (!validEvent(event)) return null;
  const conv = conversation(event);
  if (!conv) return null;
  let body: string | undefined;
  let messageId: string | undefined;
  if (event.source === 'qq' && event.type === 'qq.self') {
    messageId = qqPlatformId(event.meta?.message_id);
    const delimiter = '] 你: ', offset = event.text.indexOf(delimiter);
    const prefix = /^#(-?\d{1,20}) \[/u.exec(event.text);
    if (prefix && qqPlatformId(prefix[1]) === messageId && offset >= 0) body = event.text.slice(offset + delimiter.length);
  } else if (event.source === 'qqbot' && event.type === 'qq.sent' && event.meta?.delivery === 'confirmed'
    && event.meta.self === true && event.meta.role === 'assistant' && event.meta.textOnly === true
    && event.senderKey === conv.target && typeof event.meta.text === 'string') {
    messageId = qqPlatformId(event.meta.messageId);
    body = event.meta.text;
    // ProMAX marks forwarded bundles textOnly even though the receipt contains only a generated summary.
    if (/^\[合并转发\] \d+ 条原消息$/u.test(body)) return null;
  }
  if (messageId === undefined || !body?.trim()) return null;
  return { source: event.source, cursor: event.cursor, ts: event.ts, ...conv, messageId, body,
    key: `${event.source}:${conv.target}:${messageId}` };
}

/** qqbot recalls omit the platform ID; callers must treat that conversation's later recall as ambiguous. */
export function parseQQRecall(event: EventEnvelope): QQRecall | null {
  if (!validEvent(event) || event.type !== 'qq.recall') return null;
  const conv = event.source === 'qqbot' ? address(event.senderKey) : conversation(event);
  if (!conv) return null;
  const messageId = event.source === 'qq' ? qqPlatformId(event.meta?.message_id) : undefined;
  if (event.source === 'qq' && messageId === undefined) return null;
  return { source: event.source, cursor: event.cursor, ts: event.ts, ...conv,
    ...(messageId !== undefined ? { messageId } : {}) };
}

export function qqWithdrawal(message: QQMessage | QQReceipt, store: EventStoreReader): 'withdrawn' | 'ambiguous' | null {
  const cursors = new Set([message.cursor, ...('deliveryCursor' in message ? [message.deliveryCursor] : [])]);
  const fromCursor = message.cursor + 1;
  if (store.range({ source: 'core', origin: 'internal', fromCursor }).some(event => event.type === 'core.withdrawal'
    && typeof event.meta?.cursor === 'number' && cursors.has(event.meta.cursor))) return 'withdrawn';
  const recalls = store.range({ source: message.source, origin: 'external', fromCursor })
    .map(parseQQRecall).filter(recall => recall?.target === message.target);
  if (recalls.some(recall => recall?.messageId === message.messageId)) return 'withdrawn';
  return recalls.some(recall => recall?.messageId === undefined) ? 'ambiguous' : null;
}

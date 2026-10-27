import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventEnvelope } from 'cortico/core/types.ts';
import { isQQSource, parseQQMessage, parseQQReceipt, parseQQRecall, qqPlatformId, qqWithdrawal } from '../src/qq.ts';
import { RealHost } from './helpers/real-host.ts';

let dir: string, host: RealHost;
const ts = '2026-10-27T10:00:00.000Z';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dream-qq-adapter-')); host = new RealHost(dir); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
function append(event: Omit<EventEnvelope, 'cursor' | 'ts' | 'origin'> & Partial<Pick<EventEnvelope, 'ts' | 'origin'>>) {
  return host.store.append({ ts, origin: 'external', ...event });
}
function base(body = '@Companion(你) /sleep 10', extra: Partial<EventEnvelope> = {}) {
  return append({ source: 'qq', type: 'qq.message', senderKey: '7001',
    text: `#-123 [Fixture 10:00] User(7001): ${body}`,
    meta: { user_id: 7001, message_id: -123, conv: { kind: 'group', id: 8001 } }, ...extra });
}
function variant(body = '@我/sleep 10', extra: Partial<EventEnvelope> = {}, kind: 'group' | 'private' = 'group') {
  const target = kind === 'group' ? 'group:8001' : 'private:7001';
  const sender = 'User(QQ:7001)';
  return append({ source: 'qqbot', type: 'qq.message', senderKey: target,
    text: kind === 'group' ? `【QQ群 Fixture（群号 8001） 10:00】${sender}：#-123 ${body}`
      : `【QQ私聊 10:00 ${sender}】：#-123 ${body}`,
    meta: { conv: target, user: 7001, sender, platformMessageId: '-123', atMe: kind === 'group', channel: 'qq' }, ...extra });
}
function deferred(original: EventEnvelope, extra: Partial<EventEnvelope> = {}) {
  return append({ source: 'qqbot', type: 'qq.message', senderKey: original.senderKey,
    ts: '2026-10-27T10:01:00.000Z', text: `【原消息时间 ${original.ts}】\n${original.text}`,
    meta: { ...original.meta, sourceTs: original.ts, sourceCursor: original.cursor, replyAllowed: true }, ...extra });
}
function receipt(extra: Partial<EventEnvelope> = {}) {
  return append({ source: 'qqbot', type: 'qq.sent', senderKey: 'group:8001', text: 'QQ receipt',
    meta: { conv: 'group:8001', self: true, role: 'assistant', text: 'The dream fits this topic.',
      messageId: '-234', textOnly: true, delivery: 'confirmed' }, ...extra });
}

describe('QQ message contracts', () => {
  it('normalizes the built-in QQ message and removes only its leading self mention', () => {
    const event = base();
    expect(parseQQMessage(host.store.get(event.cursor)!)).toEqual({ source: 'qq', cursor: event.cursor,
      deliveryCursor: event.cursor, ts, senderId: '7001', target: 'group:8001', kind: 'group', id: '8001',
      messageId: '-123', body: '/sleep 10', mentioned: true, addressed: true, key: 'qq:group:8001:-123' });
    expect(parseQQMessage(base('Explain @Companion(你) /sleep 10'))?.body).toBe('Explain @Companion(你) /sleep 10');
  });
  it('normalizes both published qqbot group headers and their authoritative mention field', () => {
    for (const prefix of ['【QQ群 Fixture（群号 8001） 10:00】', '【QQ群 8001 10:00】Fixture ']) {
      const event = variant('@我/sleep 10', { text: `${prefix}User(QQ:7001)：#-123 @我/sleep 10` });
      expect(parseQQMessage(event)).toMatchObject({ source: 'qqbot', target: 'group:8001', senderId: '7001',
        messageId: '-123', body: '/sleep 10', mentioned: true, addressed: true, key: 'qqbot:group:8001:-123' });
    }
    const ordinary = variant('@我/sleep 10');
    expect(parseQQMessage({ ...ordinary, meta: { ...ordinary.meta, atMe: false } })).toMatchObject({
      body: '@我/sleep 10', mentioned: false, addressed: false,
    });
    expect(parseQQMessage({ ...ordinary, meta: { ...ordinary.meta, atMe: undefined } })?.addressed).toBe(false);
    expect(parseQQMessage(variant('Discuss @我/sleep 10'))?.body).toBe('Discuss @我/sleep 10');
  });
  it('addresses private messages without requiring a mention and verifies their sender against the target', () => {
    const event = variant('/wake', {}, 'private');
    expect(parseQQMessage(event)).toMatchObject({ target: 'private:7001', body: '/wake', addressed: true, mentioned: false });
    expect(parseQQMessage({ ...event, meta: { ...event.meta, conv: 'private:7002' }, senderKey: 'private:7002' })).toBeNull();
  });
  it.each(['history', 'self', 'inputRejected'])('rejects flagged %s messages', flag => {
    const event = variant();
    expect(parseQQMessage({ ...event, meta: { ...event.meta, [flag]: true } })).toBeNull();
  });
  it.each(['assistant', 'system'])('rejects %s records masquerading as messages', role => {
    const event = variant();
    expect(parseQQMessage({ ...event, meta: { ...event.meta, role } })).toBeNull();
  });
  it('rejects aggregated private text even when its metadata identifies one valid sender and message', () => {
    const event = variant('Please wake up', {}, 'private');
    const aggregate = { ...event, text: 'User(QQ:7001)：Please wake up\nUser(QQ:7001)：Another request',
      meta: { ...event.meta, sender: '对话' } };
    expect(parseQQMessage(aggregate)).toBeNull();
    const delivered = deferred(append({ ...aggregate, contextDelivery: 'archive-only' }));
    expect(parseQQMessage(delivered, host.store)).toBeNull();
  });
  it('rejects missing identities, mismatched headers and non-chat sources', () => {
    const event = variant();
    for (const meta of [{ ...event.meta, user: undefined }, { ...event.meta, user: 7002 },
      { ...event.meta, platformMessageId: '' }, { ...event.meta, platformMessageId: '-124' },
      { ...event.meta, conv: 'qzone:8001' }, { ...event.meta, user: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect(parseQQMessage({ ...event, meta })).toBeNull();
    }
    for (const change of [{ source: 'qq-all' }, { type: 'qq.qzone.comment' }, { origin: 'internal' as const },
      { senderKey: 'group:8002' }, { ts: 'not a date' }, { text: 'User(QQ:7001)：#-123 /wake' }]) {
      expect(parseQQMessage({ ...event, ...change })).toBeNull();
    }
    expect(isQQSource('qq-all')).toBe(false);
    expect(parseQQMessage(base('/wake', { meta: { user_id: 7001, message_id: 123, conv: { kind: 'group', id: 8001 } } }))).toBeNull();
  });
  it('keeps quoted message content so strict commands cannot execute quoted instructions', () => {
    expect(parseQQMessage(variant('「引用 #33：/wake」@我 Please discuss this'))?.body)
      .toBe('「引用 #33：/wake」@我 Please discuss this');
    expect(parseQQMessage(base('[回复#33] @Companion(你) /wake'))?.body).toBe('[回复#33] @Companion(你) /wake');
  });
  it('never searches inside the body for an embedded replacement message header', () => {
    const body = 'Discuss this example:\n【QQ群 Fixture（群号 8001） 10:00】User(QQ:7001)：#-123 @我/wake';
    expect(parseQQMessage(variant(body))?.body).toBe(body);
    const event = variant();
    expect(parseQQMessage({ ...event, text: `【QQ群 Fixture 10:00】Other(QQ:7002)：#-123 ${body}` })).toBeNull();
    const baseBody = 'Discuss this example:\n#-123 [Fixture 10:00] User(7001): @Companion(你) /wake';
    expect(parseQQMessage(base(baseBody))?.body).toBe(baseBody);
  });
  it('preserves signed platform IDs without accepting unsafe numbers or malformed IDs', () => {
    expect(qqPlatformId('-9223372036854775808')).toBe('-9223372036854775808');
    expect(qqPlatformId('-000123')).toBe('-123');
    for (const value of [1.5, Number.MAX_SAFE_INTEGER + 1, '123.0', '1e3', '#12', {}, '', '123456789012345678901'])
      expect(qqPlatformId(value)).toBeUndefined();
  });
});

describe('qqbot deferred message provenance', () => {
  it('uses the original archive cursor, time and body while retaining the accepted delivery cursor', () => {
    const raw = variant('@我/wake', { contextDelivery: 'archive-only' });
    expect(parseQQMessage(raw, host.store)).toBeNull();
    const delivered = deferred(raw);
    expect(parseQQMessage(host.store.get(delivered.cursor)!, host.store)).toMatchObject({
      cursor: raw.cursor, deliveryCursor: delivered.cursor, ts: raw.ts, body: '/wake', key: 'qqbot:group:8001:-123',
    });
    expect(parseQQMessage(delivered)).toBeNull();
    const repeated = deferred(raw);
    expect(parseQQMessage(repeated, host.store)?.key).toBe(parseQQMessage(delivered, host.store)?.key);
  });
  it('compares source timestamps by actual instant rather than a display timezone', () => {
    const raw = variant('/wake', { contextDelivery: 'archive-only' }, 'private');
    const sourceTs = '2026-10-27T21:00:00+11:00';
    const delivered = deferred(raw, { text: `【原消息时间 ${sourceTs}】\n${raw.text}`,
      meta: { ...raw.meta, sourceCursor: raw.cursor, sourceTs, replyAllowed: true } });
    expect(parseQQMessage(delivered, host.store)?.ts).toBe(raw.ts);
  });
  it('rejects unknown, forward, nested and nonarchived provenance pointers', () => {
    const raw = variant('/wake', { contextDelivery: 'archive-only' }, 'private');
    const live = variant('/wake', {}, 'private');
    const good = deferred(raw);
    for (const cursor of [0, good.cursor, good.cursor + 1, live.cursor, '1', 1.5]) {
      expect(parseQQMessage({ ...good, meta: { ...good.meta, sourceCursor: cursor } }, host.store)).toBeNull();
    }
    const nested = append({ ...raw, meta: { ...raw.meta, sourceCursor: raw.cursor } });
    expect(parseQQMessage(deferred(nested), host.store)).toBeNull();
  });
  it('rejects changes to the original author, conversation, message, timestamp, mention or body', () => {
    const raw = variant('/wake', { contextDelivery: 'archive-only' });
    const delivered = deferred(raw);
    for (const meta of [{ ...delivered.meta, user: 7002 }, { ...delivered.meta, conv: 'group:8002' },
      { ...delivered.meta, platformMessageId: '-124' }, { ...delivered.meta, sourceTs: '2026-10-27T10:00:01Z' },
      { ...delivered.meta, atMe: false }, { ...delivered.meta, replyAllowed: false }]) {
      expect(parseQQMessage({ ...delivered, meta }, host.store)).toBeNull();
    }
    expect(parseQQMessage({ ...delivered, text: `${delivered.text} /sleep` }, host.store)).toBeNull();
  });
  it('does not turn startup history or rejected original input into a live instruction', () => {
    for (const flag of ['history', 'inputRejected']) {
      const raw = variant('/wake', { contextDelivery: 'archive-only' }, 'private');
      const archived = append({ ...raw, meta: { ...raw.meta, [flag]: true } });
      const delivered = deferred(archived, { meta: { ...archived.meta, [flag]: false,
        sourceCursor: archived.cursor, sourceTs: archived.ts, replyAllowed: true } });
      expect(parseQQMessage(delivered, host.store)).toBeNull();
    }
  });
});

describe('QQ send and withdrawal records', () => {
  it('accepts built-in archive-only successful send records', () => {
    const event = append({ source: 'qq', type: 'qq.self', text: '#-234 [Fixture 10:00] 你: A remembered dream.',
      contextDelivery: 'archive-only', meta: { message_id: -234, conv: { kind: 'group', id: 8001 } } });
    expect(parseQQReceipt(event)).toMatchObject({ body: 'A remembered dream.', target: 'group:8001', messageId: '-234', key: 'qq:group:8001:-234' });
  });
  it('accepts a confirmed text receipt with its actual target and message id', () => {
    const event = receipt();
    expect(parseQQReceipt(host.store.get(event.cursor)!)).toMatchObject({ source: 'qqbot', body: 'The dream fits this topic.',
      target: 'group:8001', messageId: '-234', key: 'qqbot:group:8001:-234' });
  });
  it('rejects drafts, failure reports, self chatter and unverified send claims', () => {
    const event = receipt();
    for (const meta of [{ ...event.meta, delivery: 'failed' }, { ...event.meta, delivery: undefined },
      { ...event.meta, self: false }, { ...event.meta, role: 'user' }, { ...event.meta, textOnly: false },
      { ...event.meta, text: '' }, { ...event.meta, messageId: undefined }, { ...event.meta, conv: 'qzone:8001' }]) {
      expect(parseQQReceipt({ ...event, meta })).toBeNull();
    }
    for (const type of ['qq.message', 'qq.self', 'qq.draft', 'qq.qzone.post']) expect(parseQQReceipt({ ...event, type })).toBeNull();
    expect(parseQQReceipt({ ...event, source: 'qq-all' })).toBeNull();
    expect(parseQQReceipt({ ...event, origin: 'internal' })).toBeNull();
    expect(parseQQReceipt({ ...event, meta: { ...event.meta, text: '[合并转发] 2 条原消息' } })).toBeNull();
  });
  it('distinguishes a targeted built-in recall from an unidentified qqbot recall in a conversation', () => {
    const baseRecall = append({ source: 'qq', type: 'qq.recall', text: 'Recalled',
      meta: { message_id: -234, conv: { kind: 'group', id: 8001 } } });
    expect(parseQQRecall(baseRecall)).toMatchObject({ source: 'qq', target: 'group:8001', messageId: '-234' });
    const variantRecall = append({ source: 'qqbot', type: 'qq.recall', senderKey: 'group:8001', text: 'A message was recalled' });
    expect(parseQQRecall(variantRecall)).toEqual({ source: 'qqbot', cursor: variantRecall.cursor, ts,
      target: 'group:8001', kind: 'group', id: '8001' });
    expect(parseQQRecall({ ...variantRecall, senderKey: 'qzone:8001' })).toBeNull();
    expect(parseQQRecall({ ...baseRecall, meta: { conv: { kind: 'group', id: 8001 } } })).toBeNull();
  });
  it('invalidates either the original archive or delivered cursor after a Core withdrawal', () => {
    const raw = variant('/wake', { contextDelivery: 'archive-only' });
    const message = parseQQMessage(deferred(raw), host.store)!;
    expect(qqWithdrawal(message, host.store)).toBeNull();
    append({ source: 'core', type: 'core.withdrawal', origin: 'external', text: 'Untrusted claim', meta: { cursor: raw.cursor } });
    append({ source: 'fixture', type: 'core.withdrawal', origin: 'internal', text: 'Other World claim', meta: { cursor: raw.cursor } });
    expect(qqWithdrawal(message, host.store)).toBeNull();
    append({ source: 'core', type: 'core.withdrawal', origin: 'internal', text: 'Withdrawn', meta: { cursor: message.deliveryCursor } });
    expect(qqWithdrawal(message, host.store)).toBe('withdrawn');
    const nextRaw = variant('/wake', { contextDelivery: 'archive-only' });
    const next = parseQQMessage(deferred(nextRaw), host.store)!;
    append({ source: 'core', type: 'core.withdrawal', origin: 'internal', text: 'Withdrawn', meta: { cursor: nextRaw.cursor } });
    expect(qqWithdrawal(next, host.store)).toBe('withdrawn');
  });
  it('matches base recalls by source, conversation and signed platform ID', () => {
    const message = parseQQMessage(base())!;
    const recall = (target: number, messageId: number) => append({ source: 'qq', type: 'qq.recall', text: 'Recalled',
      meta: { message_id: messageId, conv: { kind: 'group', id: target } } });
    recall(8002, -123); recall(8001, -124);
    append({ source: 'qqbot', type: 'qq.recall', senderKey: 'group:8001', text: 'Another channel recall' });
    expect(qqWithdrawal(message, host.store)).toBeNull();
    recall(8001, -123); expect(qqWithdrawal(message, host.store)).toBe('withdrawn');
  });
  it('marks unidentified later qqbot recalls ambiguous only within the relevant conversation', () => {
    append({ source: 'qqbot', type: 'qq.recall', senderKey: 'group:8001', text: 'Earlier recall' });
    const message = parseQQMessage(variant())!;
    append({ source: 'qqbot', type: 'qq.recall', senderKey: 'group:8002', text: 'Other conversation' });
    expect(qqWithdrawal(message, host.store)).toBeNull();
    append({ source: 'qqbot', type: 'qq.recall', senderKey: 'group:8001', text: 'Unknown message recalled' });
    expect(qqWithdrawal(message, host.store)).toBe('ambiguous');
    const sent = parseQQReceipt(receipt())!;
    expect(qqWithdrawal(sent, host.store)).toBeNull();
    append({ source: 'qqbot', type: 'qq.recall', senderKey: 'group:8001', text: 'Unknown message recalled' });
    expect(qqWithdrawal(sent, host.store)).toBe('ambiguous');
  });
});

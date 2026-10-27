import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventEnvelope } from 'cortico/core/types.ts';
import { DreamUsage, DREAM_USAGE_TTL_MS, type DreamIncomingRef } from '../src/usage.ts';
import { RealHost } from './helpers/real-host.ts';

let dir: string, now: number, host: RealHost, usage: DreamUsage;
const dream = { id: 'dream-fixture', createdAt: '2026-10-25T10:00:00.000Z' };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dream-qq-usage-'));
  now = Date.parse('2026-10-27T10:00:00.000Z');
  host = new RealHost(dir); usage = new DreamUsage(host.store, () => now);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
function append(event: Omit<EventEnvelope, 'cursor' | 'origin' | 'ts'> & Partial<Pick<EventEnvelope, 'ts' | 'origin'>>) {
  return host.store.append({ ts: new Date(now).toISOString(), origin: 'external', ...event });
}
function incoming(messageId = '101', target = 'group:8001', extra: Partial<EventEnvelope> = {}) {
  const sender = 'Fixture(QQ:7001)', body = 'The observatory dream fits our topic.';
  const prefix = target.startsWith('private:') ? `【QQ私聊 10:00 ${sender}】` : `【QQ群 Fixture（群号 ${target.slice(6)}） 10:00】${sender}`;
  return append({ source: 'qqbot', type: 'qq.message', senderKey: target,
    text: `${prefix}：#${messageId} ${body}`,
    meta: { conv: target, user: 7001, platformMessageId: messageId, atMe: false, role: 'member', channel: 'qq', sender }, ...extra });
}
function sent(messageId = '201', target = 'group:8001', extra: Partial<EventEnvelope> = {}) {
  const body = 'In that dream, the observatory floated among paper clouds.';
  return append({ source: 'qqbot', type: 'qq.sent', senderKey: target,
    text: `【QQ发送回执｜本账号已发送】${body}\n这是实际发送记录，不是对方的新消息，无需回复本回执。`,
    meta: { conv: target, self: true, role: 'assistant', text: body, messageId, textOnly: true, delivery: 'confirmed' }, ...extra });
}
function prepare(messageId = '101', target = 'group:8001') {
  return usage.prepare(dream, { source: 'qqbot', messageId, target });
}
function deferred(raw: EventEnvelope, extra: Partial<EventEnvelope> = {}) {
  const { cursor: _cursor, ...event } = raw;
  return append({ ...event, contextDelivery: 'deliver', ts: new Date(now).toISOString(),
    text: `【原消息时间 ${raw.ts}】\n${raw.text}`,
    meta: { ...raw.meta, sourceTs: raw.ts, sourceCursor: raw.cursor, replyAllowed: true }, ...extra });
}
function recall(target = 'group:8001') {
  return append({ source: 'qqbot', type: 'qq.recall', senderKey: target, text: `${target} 中 7001 撤回了一条消息` });
}

describe('QQ variant dream usage receipts', () => {
  it.each(['group:8001', 'private:7001'])('verifies ProMAX confirmed text receipts in %s and preserves retry identity', target => {
    const original = incoming('101', target), token = prepare('101', target), output = sent('201', target);
    const result = usage.verify(dream.id, token.usageToken, { messageId: '201' });
    expect(result).toEqual({ replyKey: `qqbot:${target}:201`, source: 'qqbot', target,
      incomingCursor: original.cursor, eventCursor: output.cursor });
    expect(usage.verify(dream.id, token.usageToken, { messageId: '201' })).toEqual(result);
  });
  it('reports the missing success-event contract without treating a Final self message as proof', () => {
    incoming(); const token = prepare();
    append({ source: 'qqbot', type: 'qq.message', senderKey: 'group:8001', text: '【你发给 Fixture】A reply.',
      meta: { conv: 'group:8001', role: 'assistant', self: true } });
    expect(() => usage.verify(dream.id, token.usageToken, { messageId: '201' })).toThrow('requires a confirmed qq.sent event');
  });
  it.each([
    { delivery: 'failed' }, { delivery: undefined }, { self: false }, { role: 'user' }, { textOnly: false },
    { messageId: undefined }, { text: '' }, { conv: 'group:9001' },
  ])('rejects unproven or mismatched ProMAX output (%j)', patch => {
    incoming(); const token = prepare();
    sent('201', 'group:8001', { meta: { conv: 'group:8001', self: true, role: 'assistant', text: 'A reply.',
      messageId: '201', textOnly: true, delivery: 'confirmed', ...patch } });
    expect(() => usage.verify(dream.id, token.usageToken, { messageId: '201' })).toThrow('No matching successful output');
  });
  it('keeps base QQ and qqbot platform IDs in separate channels', () => {
    incoming(); const token = prepare();
    append({ source: 'qq', type: 'qq.self', text: '#201 [Fixture 10:00] 你: A reply.',
      meta: { conv: { kind: 'group', id: 8001 }, message_id: 201, user_id: 7002 } });
    expect(() => usage.verify(dream.id, token.usageToken, { messageId: '201' })).toThrow('requires a confirmed qq.sent');
  });
  it('uses deferred ProMAX provenance once when the original is archived and delivery repeats', () => {
    const original = incoming('101', 'group:8001', { contextDelivery: 'archive-only' });
    deferred(original); deferred(original);
    const token = prepare(); sent();
    expect(token.incomingCursor).toBe(original.cursor);
    expect(usage.verify(dream.id, token.usageToken, { messageId: '201' }).incomingCursor).toBe(original.cursor);
  });
  it('rejects deferred messages whose original timestamp expired', () => {
    const original = incoming('101', 'group:8001', { contextDelivery: 'archive-only' });
    now += DREAM_USAGE_TTL_MS + 1;
    deferred(original);
    expect(() => prepare()).toThrow('unavailable');
  });
  it.each([
    { history: true }, { self: true }, { role: 'assistant' }, { sender: '对话' }, { inputRejected: true }, { replyAllowed: false },
  ])('rejects background, aggregated, self and blocked input (%j)', patch => {
    incoming('101', 'group:8001', { meta: { conv: 'group:8001', user: 7001, platformMessageId: '101',
      atMe: false, role: 'member', channel: 'qq', sender: 'Fixture(QQ:7001)', ...patch } });
    expect(() => prepare()).toThrow('unavailable');
  });
  it('does not grant credit for duplicate receipts or replay a receipt sent before reading', () => {
    incoming(); const token = prepare(), output = sent(); sent();
    expect(usage.verify(dream.id, token.usageToken, { messageId: '201' }).eventCursor).toBe(output.cursor);
    incoming('102'); const later = prepare('102'); sent();
    expect(() => usage.verify(dream.id, later.usageToken, { messageId: '201' })).toThrow('before this dream read');
  });
  it('rejects conflicting bodies recorded for one QQ platform receipt', () => {
    incoming(); const token = prepare(); sent();
    sent('201', 'group:8001', { meta: { conv: 'group:8001', self: true, role: 'assistant', text: 'Different reply.',
      messageId: '201', textOnly: true, delivery: 'confirmed' } });
    expect(() => usage.verify(dream.id, token.usageToken, { messageId: '201' })).toThrow('ambiguous');
  });
  it('does not restore withdrawn QQ evidence through a duplicate success record', () => {
    incoming(); const token = prepare(), output = sent();
    append({ source: 'core', type: 'core.withdrawal', origin: 'internal', text: 'Withdrawn', meta: { cursor: output.cursor } });
    sent();
    expect(() => usage.verify(dream.id, token.usageToken, { messageId: '201' })).toThrow('No matching successful output');
  });
  it('rejects ProMAX merged-forward receipts that do not contain the actual reply text', () => {
    incoming(); const token = prepare();
    sent('201', 'group:8001', { meta: { conv: 'group:8001', self: true, role: 'assistant', text: '[合并转发] 2 条原消息',
      messageId: '201', textOnly: true, delivery: 'confirmed' } });
    expect(() => usage.verify(dream.id, token.usageToken, { messageId: '201' })).toThrow('No matching successful output');
  });
  it('rejects automatic dream sharing to the incoming target', () => {
    incoming(); const token = prepare();
    append({ source: 'dream', type: 'dream.share', origin: 'internal', text: 'Share suggestion',
      meta: { recordId: dream.id, target: 'group:8001' } });
    sent();
    expect(() => usage.verify(dream.id, token.usageToken, { messageId: '201' })).toThrow('Automatic dream sharing');
  });
  it('rejects scoring when a QQ recall cannot identify which message was withdrawn', () => {
    incoming(); const token = prepare(); sent(); recall();
    expect(() => usage.verify(dream.id, token.usageToken, { messageId: '201' })).toThrow('recall record lacks a platform message ID');
    expect(() => prepare()).toThrow('recall record lacks a platform message ID');
  });
  it('ignores unidentified recalls from other conversations and earlier recalls', () => {
    recall(); incoming(); const token = prepare(); sent(); recall('group:9001');
    expect(usage.verify(dream.id, token.usageToken, { messageId: '201' }).replyKey).toBe('qqbot:group:8001:201');
  });
  it('rejects a deferred input after Core withdraws its original archived message', () => {
    const original = incoming('101', 'group:8001', { contextDelivery: 'archive-only' });
    deferred(original); const token = prepare(); sent();
    append({ source: 'core', type: 'core.withdrawal', origin: 'internal', text: 'Withdrawn', meta: { cursor: original.cursor } });
    expect(() => usage.verify(dream.id, token.usageToken, { messageId: '201' })).toThrow('no longer available');
  });
  it('excludes Qzone, forward expansions and qq-all from conversation evidence', () => {
    for (const type of ['qzone.comment', 'qq.qzone', 'qq.forward']) incoming('101', 'group:8001', { type });
    incoming('101', 'group:8001', { source: 'qq-all' });
    expect(() => prepare()).toThrow('unavailable');
    expect(() => usage.prepare(dream, { source: 'qq-all', messageId: '101' } as unknown as DreamIncomingRef)).toThrow('Only QQ and desktop');
    incoming(); const token = prepare(); sent('201', 'group:8001', { type: 'qzone.sent' });
    expect(() => usage.verify(dream.id, token.usageToken, { messageId: '201' })).toThrow('No matching successful output');
  });
});

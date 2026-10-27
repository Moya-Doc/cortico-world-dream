import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventEnvelope } from 'cortico/core/types.ts';
import { DreamUsage, DREAM_USAGE_TOKEN_LIMIT, DREAM_USAGE_TTL_MS, type DreamIncomingRef } from '../src/usage.ts';
import { RealHost } from './helpers/real-host.ts';

let dir: string, now: number, host: RealHost, usage: DreamUsage;
const dream = { id: 'dream-fixture', createdAt: '2026-10-25T10:00:00.000Z' };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dream-usage-'));
  now = Date.parse('2026-10-27T10:00:00.000Z');
  host = new RealHost(dir); usage = new DreamUsage(host.store, () => now);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
function append(event: Omit<EventEnvelope, 'cursor' | 'origin' | 'ts'> & Partial<Pick<EventEnvelope, 'ts' | 'origin'>>) {
  return host.store.append({ ts: new Date(now).toISOString(), origin: 'external', ...event });
}
function incomingLocal(text = 'That reminds me of your dream.', extra: Partial<EventEnvelope> = {}) {
  return append({ source: 'desktop-pet', type: 'desktop-pet.message', text, meta: { text }, ...extra });
}
function outgoingLocal(text = 'In that dream, the observatory floated among paper clouds.', extra: Partial<EventEnvelope> = {}) {
  return append({ source: 'desktop-pet', type: 'desktop-pet.self', text, meta: { kind: 'say', beats: [{ text }] }, ...extra });
}
function qq(messageId: number | string, kind: 'message' | 'self' = 'message', target = 8001, body = 'The observatory dream fits our topic.', extra: Partial<EventEnvelope> = {}) {
  return append({ source: 'qq', type: `qq.${kind}`,
    text: `#${messageId} [Fixture 10:00] ${kind === 'self' ? '你' : 'User(7001)'}: ${body}`,
    meta: { message_id: messageId, user_id: kind === 'self' ? 7002 : 7001, conv: { kind: 'group', id: target } }, ...extra });
}
function prepareLocal() {
  const event = incomingLocal();
  return usage.prepare(dream, { source: 'desktop-pet', eventCursor: event.cursor });
}
function share(recordId = dream.id, target = 'group:8001') {
  return append({ source: 'dream', type: 'dream.share', origin: 'internal', text: 'Share suggestion', meta: { recordId, target } });
}

describe('verified dream conversation usage', () => {
  it('verifies a later desktop say record while keeping retry identity stable', () => {
    const token = prepareLocal();
    expect(() => usage.verify(dream.id, token.usageToken, { text: 'Not sent.' })).toThrow('No matching successful output');
    const sent = outgoingLocal();
    const result = usage.verify(dream.id, token.usageToken, { text: sent.text });
    expect(result).toEqual({ replyKey: `desktop-pet:test-run:${sent.cursor}`, source: 'desktop-pet',
      eventCursor: sent.cursor, incomingCursor: token.incomingCursor });
    expect(usage.verify(dream.id, token.usageToken, { text: sent.text })).toEqual(result);
    outgoingLocal('Another answer.');
    expect(() => usage.verify(dream.id, token.usageToken, { text: 'Another answer.' })).toThrow('already identifies another reply');
  });
  it('verifies QQ platform receipts within the original conversation without command ownership', () => {
    const incoming = qq(-123);
    const token = usage.prepare(dream, { source: 'qq', messageId: '-123' });
    qq(124, 'self', 9001);
    expect(() => usage.verify(dream.id, token.usageToken, { messageId: '124' })).toThrow('No matching successful output');
    const sent = qq(125, 'self');
    expect(usage.verify(dream.id, token.usageToken, { messageId: '125' })).toEqual({
      replyKey: 'qq:group:8001:125', source: 'qq', eventCursor: sent.cursor, incomingCursor: incoming.cursor, target: 'group:8001',
    });
  });
  it('verifies private QQ targets and preserves their distinct reply identity', () => {
    const meta = { message_id: 1, user_id: 7001, conv: { kind: 'private', id: 7001 } };
    qq(1, 'message', 8001, 'A topic', { meta });
    const token = usage.prepare(dream, { source: 'qq', messageId: '1', target: 'private:7001' });
    qq(2, 'self', 8001, 'A response', { meta: { ...meta, message_id: 2 } });
    expect(usage.verify(dream.id, token.usageToken, { messageId: '2' }).replyKey).toBe('qq:private:7001:2');
  });
  it.each(['2026-10-27T05:00:00-05:00', '2026-10-27T21:00:00+11:00'])('finds a recent QQ message across timestamp offsets (%s)', ts => {
    const incoming = qq(1, 'message', 8001, 'Topic', { ts });
    const token = usage.prepare(dream, { source: 'qq', messageId: '1' });
    qq(2, 'self', 8001, 'Response', { ts });
    expect(usage.verify(dream.id, token.usageToken, { messageId: '2' }).incomingCursor).toBe(incoming.cursor);
  });
  it('rejects ambiguous incoming QQ ids unless their conversation is specified', () => {
    qq(123); qq(123, 'message', 9001);
    expect(() => usage.prepare(dream, { source: 'qq', messageId: '123' })).toThrow('ambiguous');
    expect(usage.prepare(dream, { source: 'qq', messageId: '123', target: 'group:9001' }).target).toBe('group:9001');
  });
  it('requires a read before the actual reply and rejects supplied channel-mismatched references', () => {
    outgoingLocal('Already sent.');
    const token = prepareLocal();
    expect(() => usage.verify(dream.id, token.usageToken, { text: 'Already sent.' })).toThrow('No matching successful output');
    expect(() => usage.verify(dream.id, token.usageToken, { messageId: '1' })).toThrow('exact text');
    qq(1); const q = usage.prepare(dream, { source: 'qq', messageId: '1' });
    expect(() => usage.verify(dream.id, q.usageToken, { text: 'A response' })).toThrow('QQ sent message id');
  });
  it('rejects duplicate local output text instead of choosing an arbitrary reply', () => {
    const token = prepareLocal(); outgoingLocal('Same response.'); outgoingLocal('Same response.');
    expect(() => usage.verify(dream.id, token.usageToken, { text: 'Same response.' })).toThrow('ambiguous');
  });
  it('requires a supported incoming channel and rejects console records', () => {
    const event = append({ source: 'console', type: 'console.message', origin: 'internal', text: 'Fixture', meta: { body: 'Fixture' } });
    expect(() => usage.prepare(dream, { source: 'console', eventCursor: event.cursor } as unknown as DreamIncomingRef)).toThrow('Only QQ and desktop');
    expect(() => usage.prepare(dream, { source: 'desktop-pet', eventCursor: event.cursor })).toThrow('unavailable');
  });
  it.each([
    { type: 'desktop-pet.touch', meta: { text: 'not a chat' } },
    { type: 'desktop-pet.self', meta: { text: 'not incoming' } },
    { origin: 'internal' as const },
    { contextDelivery: 'archive-only' as const },
    { meta: { text: '   ' } },
  ])('rejects ineligible incoming events (%j)', extra => {
    const event = incomingLocal('A topic', extra);
    expect(() => usage.prepare(dream, { source: 'desktop-pet', eventCursor: event.cursor })).toThrow('unavailable');
  });
  it('accepts desktop speech as a topical incoming message', () => {
    const event = incomingLocal('Spoken topic', { type: 'desktop-pet.speech' });
    expect(usage.prepare(dream, { source: 'desktop-pet', eventCursor: event.cursor }).incomingCursor).toBe(event.cursor);
  });
  it('requires an older dream, a recent incoming message and a live token', () => {
    const event = incomingLocal();
    const ref = { source: 'desktop-pet' as const, eventCursor: event.cursor };
    expect(() => usage.prepare({ ...dream, createdAt: event.ts }, ref)).toThrow('saved before');
    const token = usage.prepare(dream, ref); outgoingLocal('Sent.');
    now += DREAM_USAGE_TTL_MS;
    expect(() => usage.verify(dream.id, token.usageToken, { text: 'Sent.' })).toThrow('expired');
    now++;
    expect(() => usage.prepare(dream, ref)).toThrow('expired');
  });
  it('rejects forged future timestamps and wrong dream ids', () => {
    const future = incomingLocal('Topic', { ts: new Date(now + 2000).toISOString() });
    expect(() => usage.prepare(dream, { source: 'desktop-pet', eventCursor: future.cursor })).toThrow('unavailable');
    const token = prepareLocal(); outgoingLocal('Sent.');
    expect(() => usage.verify('another-dream', token.usageToken, { text: 'Sent.' })).toThrow('unknown or expired');
  });
  it('rejects withdrawn incoming messages before preparing and after reading', () => {
    const first = incomingLocal();
    append({ source: 'core', type: 'core.withdrawal', origin: 'internal', text: 'Withdrawn', meta: { cursor: first.cursor } });
    expect(() => usage.prepare(dream, { source: 'desktop-pet', eventCursor: first.cursor })).toThrow('withdrawn');
    const token = prepareLocal();
    append({ source: 'desktop-pet', type: 'desktop-pet.self', text: 'Withdrawn', meta: { kind: 'withdrawn', cursor: token.incomingCursor } });
    outgoingLocal('Sent.');
    expect(() => usage.verify(dream.id, token.usageToken, { text: 'Sent.' })).toThrow('no longer available');
  });
  it('rejects recalled QQ incoming and outgoing messages', () => {
    qq(1); const token = usage.prepare(dream, { source: 'qq', messageId: '1' }); qq(2, 'self');
    append({ source: 'qq', type: 'qq.recall', text: 'Recalled', meta: { message_id: 2, conv: { kind: 'group', id: 8001 } } });
    expect(() => usage.verify(dream.id, token.usageToken, { messageId: '2' })).toThrow('No matching successful output');
    append({ source: 'qq', type: 'qq.recall', text: 'Recalled', meta: { message_id: 1, conv: { kind: 'group', id: 8001 } } });
    expect(() => usage.verify(dream.id, token.usageToken, { messageId: '2' })).toThrow('no longer available');
  });
  it('ignores withdrawal claims from another World or an external core event', () => {
    const incoming = qq(1);
    append({ source: 'desktop-pet', type: 'desktop-pet.self', text: 'Other channel record', meta: { kind: 'withdrawn', cursor: incoming.cursor } });
    append({ source: 'fixture', type: 'core.withdrawal', origin: 'internal', text: 'Other World', meta: { cursor: incoming.cursor } });
    append({ source: 'core', type: 'core.withdrawal', origin: 'external', text: 'External claim', meta: { cursor: incoming.cursor } });
    const token = usage.prepare(dream, { source: 'qq', messageId: '1' });
    const sent = qq(2, 'self');
    append({ source: 'core', type: 'core.withdrawal', origin: 'external', text: 'External claim', meta: { cursor: sent.cursor } });
    expect(usage.verify(dream.id, token.usageToken, { messageId: '2' }).replyKey).toBe('qq:group:8001:2');
  });
  it.each(['activity', 'ask', 'say'])('rejects non-text or non-say output (%s)', kind => {
    const token = prepareLocal();
    outgoingLocal('Not a valid output', { meta: { kind, beats: [{ text: '' }] } });
    expect(() => usage.verify(dream.id, token.usageToken, { text: 'Not a valid output' })).toThrow('No matching successful output');
  });
  it('rejects sharing suggestions for the same record and target after the incoming topic', () => {
    qq(1); const token = usage.prepare(dream, { source: 'qq', messageId: '1' }); share(); qq(2, 'self');
    expect(() => usage.verify(dream.id, token.usageToken, { messageId: '2' })).toThrow('Automatic dream sharing');
    qq(3); const fresh = usage.prepare(dream, { source: 'qq', messageId: '3' }); qq(4, 'self');
    expect(usage.verify(dream.id, fresh.usageToken, { messageId: '4' }).replyKey).toBe('qq:group:8001:4');
  });
  it('does not classify another dream, target or later suggestion as this reply sharing', () => {
    qq(1); const token = usage.prepare(dream, { source: 'qq', messageId: '1' });
    share('another-dream'); share(dream.id, 'group:9001'); qq(2, 'self'); share();
    expect(usage.verify(dream.id, token.usageToken, { messageId: '2' }).replyKey).toBe('qq:group:8001:2');
  });
  it('bounds pending tokens and invalidates all of them on reset', () => {
    const event = incomingLocal(), ref = { source: 'desktop-pet' as const, eventCursor: event.cursor };
    const first = usage.prepare(dream, ref);
    let last = first;
    for (let i = 0; i < DREAM_USAGE_TOKEN_LIMIT; i++) last = usage.prepare(dream, ref);
    outgoingLocal('Sent.');
    expect(() => usage.verify(dream.id, first.usageToken, { text: 'Sent.' })).toThrow('unknown or expired');
    expect(usage.verify(dream.id, last.usageToken, { text: 'Sent.' }).source).toBe('desktop-pet');
    usage.reset();
    expect(() => usage.verify(dream.id, last.usageToken, { text: 'Sent.' })).toThrow('unknown or expired');
  });
});

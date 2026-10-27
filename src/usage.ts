import { randomUUID } from 'node:crypto';
import type { EventEnvelope, EventStoreReader } from 'cortico/core/types.ts';

export const DREAM_USAGE_TTL_MS = 5 * 60_000;
export const DREAM_USAGE_TOKEN_LIMIT = 256;
export interface UsageDream { id: string; createdAt: string }
export type DreamIncomingRef = { source: 'qq'; messageId: string; target?: string }
  | { source: 'desktop-pet'; eventCursor: number };
export interface DreamReplyRef { messageId?: string; text?: string }
export interface PreparedDreamUsage {
  usageToken: string; source: DreamIncomingRef['source']; incomingCursor: number; target?: string; expiresAt: string;
}
export interface VerifiedDreamUsage {
  replyKey: string; source: DreamIncomingRef['source']; eventCursor: number; incomingCursor: number; target?: string;
}
interface PendingUsage {
  dreamId: string; source: DreamIncomingRef['source']; incomingCursor: number; target?: string;
  afterCursor: number; expiresAt: number; verifiedKey?: string;
}

function platformId(value: unknown): string | undefined {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return;
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^-?\d{1,20}$/u.test(String(value))) return;
  return BigInt(value).toString();
}
function conversation(event: EventEnvelope): string | undefined {
  const conv = event.meta?.conv as { kind?: unknown; id?: unknown } | undefined;
  if (conv?.kind !== 'group' && conv?.kind !== 'private') return;
  const id = platformId(conv.id);
  return id && /^[1-9]\d*$/u.test(id) ? `${conv.kind}:${id}` : undefined;
}
function targetInput(value: unknown): string | undefined {
  if (value === undefined) return;
  if (typeof value !== 'string' || !/^(group|private):[1-9]\d{0,19}$/u.test(value)) throw new Error('Invalid QQ conversation.');
  return value;
}
function incomingText(event: EventEnvelope): string | undefined {
  if (event.origin !== 'external') return;
  if (event.source === 'desktop-pet' && ['desktop-pet.message', 'desktop-pet.speech'].includes(event.type))
    return typeof event.meta?.text === 'string' ? event.meta.text : undefined;
  if (event.source === 'qq' && event.type === 'qq.message') {
    const userId = platformId(event.meta?.user_id);
    if (!userId || !/^[1-9]\d*$/u.test(userId)) return;
    const delimiter = `(${userId}): `, offset = event.text.indexOf(delimiter);
    return offset >= 0 ? event.text.slice(offset + delimiter.length) : undefined;
  }
}
function outgoingText(event: EventEnvelope): string | undefined {
  if (event.origin !== 'external') return;
  if (event.source === 'desktop-pet' && event.type === 'desktop-pet.self' && event.meta?.kind === 'say') {
    const beats = event.meta.beats;
    return Array.isArray(beats) && beats.every(beat => beat && typeof beat.text === 'string')
      ? beats.map(beat => beat.text).join('') : undefined;
  }
  if (event.source === 'qq' && event.type === 'qq.self') {
    const delimiter = '] 你: ', offset = event.text.indexOf(delimiter);
    return offset >= 0 ? event.text.slice(offset + delimiter.length) : undefined;
  }
}

/** Verifies channel output records. Topic relevance and dream references remain the model's judgment. */
export class DreamUsage {
  private readonly tokens = new Map<string, PendingUsage>();
  constructor(private readonly store: EventStoreReader, private readonly now: () => number) {}

  reset(): void { this.tokens.clear(); }
  private prune(): void {
    for (const [token, pending] of this.tokens) if (pending.expiresAt <= this.now()) this.tokens.delete(token);
  }
  private recent(event: EventEnvelope): boolean {
    const at = Date.parse(event.ts);
    return Number.isFinite(at) && at <= this.now() + 1000 && this.now() - at <= DREAM_USAGE_TTL_MS;
  }
  private withdrawn(event: EventEnvelope): boolean {
    const fromCursor = event.cursor + 1;
    if (this.store.range({ source: 'core', origin: 'internal', fromCursor })
      .some(item => item.type === 'core.withdrawal' && item.meta?.cursor === event.cursor)) return true;
    const channel = this.store.range({ source: event.source, origin: 'external', fromCursor });
    return event.source === 'desktop-pet'
      ? channel.some(item => item.type === 'desktop-pet.self' && item.meta?.kind === 'withdrawn' && item.meta.cursor === event.cursor)
      : channel.some(item => item.type === 'qq.recall' && platformId(item.meta?.message_id) === platformId(event.meta?.message_id)
        && conversation(item) === conversation(event));
  }
  private incoming(value: unknown): EventEnvelope {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('An incoming message reference is required.');
    const ref = value as Record<string, unknown>;
    if (ref.source !== 'qq' && ref.source !== 'desktop-pet') throw new Error('Only QQ and desktop pet conversation references can earn dream usage credit.');
    let candidates: EventEnvelope[];
    if (ref.source === 'qq') {
      const id = platformId(ref.messageId), target = targetInput(ref.target);
      if (id === undefined) throw new Error('A QQ platform message id is required.');
      candidates = this.store.range({ source: 'qq', fromTs: new Date(this.now() - DREAM_USAGE_TTL_MS).toISOString() })
        .filter(event => event.type === 'qq.message' && platformId(event.meta?.message_id) === id
          && conversation(event) && (target === undefined || conversation(event) === target));
    } else {
      if (typeof ref.eventCursor !== 'number' || !Number.isSafeInteger(ref.eventCursor) || ref.eventCursor < 1) throw new Error('An incoming event cursor is required.');
      const event = this.store.get(ref.eventCursor);
      candidates = event?.source === ref.source ? [event] : [];
    }
    const usable = candidates.filter(event => this.recent(event) && event.contextDelivery !== 'archive-only'
      && incomingText(event)?.trim() && !this.withdrawn(event));
    if (usable.length !== 1) throw new Error('The incoming message is unavailable, expired, withdrawn or ambiguous.');
    return usable[0]!;
  }

  prepare(dream: UsageDream, ref: DreamIncomingRef): PreparedDreamUsage {
    this.prune();
    const incoming = this.incoming(ref);
    const created = Date.parse(dream.createdAt);
    if (!Number.isFinite(created) || created >= Date.parse(incoming.ts))
      throw new Error('Only a dream saved before the incoming conversation can earn usage credit.');
    const usageToken = randomUUID(), expiresAt = this.now() + DREAM_USAGE_TTL_MS;
    const pending: PendingUsage = { dreamId: dream.id, source: incoming.source as DreamIncomingRef['source'], incomingCursor: incoming.cursor,
      afterCursor: this.store.latestCursor(), expiresAt, ...(incoming.source === 'qq' ? { target: conversation(incoming)! } : {}) };
    while (this.tokens.size >= DREAM_USAGE_TOKEN_LIMIT) this.tokens.delete(this.tokens.keys().next().value!);
    this.tokens.set(usageToken, pending);
    return { usageToken, source: pending.source, incomingCursor: pending.incomingCursor,
      ...(pending.target ? { target: pending.target } : {}), expiresAt: new Date(expiresAt).toISOString() };
  }

  verify(dreamId: string, usageToken: string, value: DreamReplyRef): VerifiedDreamUsage {
    this.prune();
    const pending = typeof usageToken === 'string' ? this.tokens.get(usageToken) : undefined;
    if (!pending || pending.dreamId !== dreamId) throw new Error('The dream usage token is unknown or expired. Read the dream for the current conversation first.');
    const incoming = this.store.get(pending.incomingCursor);
    if (!incoming || this.withdrawn(incoming)) throw new Error('The original conversation message is no longer available.');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('An actual outgoing reply reference is required.');
    const reply = value as Record<string, unknown>;
    const id = platformId(reply.messageId);
    if (pending.source === 'qq' ? id === undefined || reply.text !== undefined
      : typeof reply.text !== 'string' || !reply.text.trim() || reply.text.length > 20_000 || reply.messageId !== undefined)
      throw new Error('Use the QQ sent message id, or the exact text emitted by the local channel.');
    const candidates = this.store.range({ source: pending.source, fromCursor: pending.afterCursor + 1 })
      .filter(event => this.recent(event) && outgoingText(event)?.trim()
        && (pending.source === 'qq' ? conversation(event) === pending.target && platformId(event.meta?.message_id) === id
          : outgoingText(event) === reply.text)
        && !this.withdrawn(event));
    if (!candidates.length) throw new Error('No matching successful output record is available yet. Do not score an unsent reply.');
    if (candidates.length !== 1) throw new Error('The outgoing reply reference is ambiguous.');
    const event = candidates[0]!;
    const sharing = pending.source === 'qq' && this.store.range({ source: 'dream', fromCursor: incoming.cursor + 1, toCursor: event.cursor })
      .some(item => item.type === 'dream.share' && item.origin === 'internal' && item.meta?.recordId === dreamId
        && (item.meta?.target === pending.target || (pending.target?.startsWith('group:') && item.meta?.groupId === pending.target.slice(6))
          || (pending.target?.startsWith('private:') && item.meta?.privateId === pending.target.slice(8))));
    if (sharing) throw new Error('Automatic dream sharing does not earn usage credit. Wait for a new conversation topic.');
    const replyKey = pending.source === 'qq' ? `qq:${pending.target}:${id}`
      : `${pending.source}:${event.run ?? 'legacy'}:${event.cursor}`;
    if (pending.verifiedKey && pending.verifiedKey !== replyKey) throw new Error('This usage token already identifies another reply.');
    pending.verifiedKey = replyKey;
    return { replyKey, source: pending.source, eventCursor: event.cursor, incomingCursor: incoming.cursor,
      ...(pending.target ? { target: pending.target } : {}) };
  }
}

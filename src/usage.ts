import { randomUUID } from 'node:crypto';
import type { EventEnvelope, EventStoreReader } from 'cortico/core/types.ts';
import { isQQSource, parseQQMessage, parseQQReceipt, qqPlatformId, qqWithdrawal,
  type QQMessage, type QQReceipt, type QQSource } from './qq.ts';

export const DREAM_USAGE_TTL_MS = 5 * 60_000;
export const DREAM_USAGE_TOKEN_LIMIT = 256;
export interface UsageDream { id: string; createdAt: string }
export type DreamIncomingRef = { source: QQSource; messageId: string; target?: string }
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
  incomingDeliveryCursor: number; afterCursor: number; expiresAt: number; verifiedKey?: string;
}
interface IncomingUsage { event: EventEnvelope; qq?: QQMessage }
const ambiguousRecall = 'The QQ recall record lacks a platform message ID. Dream usage cannot be verified for this conversation.';
function targetInput(value: unknown): string | undefined {
  if (value === undefined) return;
  if (typeof value !== 'string' || !/^(group|private):[1-9]\d{0,19}$/u.test(value)) throw new Error('Invalid QQ conversation.');
  return value;
}
function incomingLocalText(event: EventEnvelope): string | undefined {
  if (event.origin !== 'external') return;
  if (event.source === 'desktop-pet' && ['desktop-pet.message', 'desktop-pet.speech'].includes(event.type))
    return typeof event.meta?.text === 'string' ? event.meta.text : undefined;
}
function outgoingLocalText(event: EventEnvelope): string | undefined {
  if (event.origin !== 'external') return;
  if (event.source === 'desktop-pet' && event.type === 'desktop-pet.self' && event.meta?.kind === 'say') {
    const beats = event.meta.beats;
    return Array.isArray(beats) && beats.every(beat => beat && typeof beat.text === 'string')
      ? beats.map(beat => beat.text).join('') : undefined;
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
  private recent(event: { ts: string }): boolean {
    const at = Date.parse(event.ts);
    return Number.isFinite(at) && at <= this.now() + 1000 && this.now() - at <= DREAM_USAGE_TTL_MS;
  }
  private withdrawal(event: EventEnvelope, qq?: QQMessage | QQReceipt): 'withdrawn' | 'ambiguous' | null {
    if (qq) return qqWithdrawal(qq, this.store);
    const fromCursor = event.cursor + 1;
    if (this.store.range({ source: 'core', origin: 'internal', fromCursor })
      .some(item => item.type === 'core.withdrawal' && item.meta?.cursor === event.cursor)) return 'withdrawn';
    const channel = this.store.range({ source: event.source, origin: 'external', fromCursor });
    return channel.some(item => item.type === 'desktop-pet.self'
      && item.meta?.kind === 'withdrawn' && item.meta.cursor === event.cursor) ? 'withdrawn' : null;
  }
  private incoming(value: unknown): IncomingUsage {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('An incoming message reference is required.');
    const ref = value as Record<string, unknown>;
    if (!isQQSource(ref.source) && ref.source !== 'desktop-pet') throw new Error('Only QQ and desktop pet conversation references can earn dream usage credit.');
    let candidates: IncomingUsage[];
    if (isQQSource(ref.source)) {
      const id = qqPlatformId(ref.messageId), target = targetInput(ref.target);
      if (id === undefined) throw new Error('A QQ platform message id is required.');
      candidates = this.store.range({ source: ref.source, fromTs: new Date(this.now() - DREAM_USAGE_TTL_MS).toISOString() })
        .flatMap(event => {
          const qq = parseQQMessage(event, this.store);
          return qq && qq.messageId === id && this.recent(qq) && (target === undefined || qq.target === target) ? [{ event, qq }] : [];
        });
      const identities = new Map<string, IncomingUsage>();
      for (const candidate of candidates) {
        const previous = identities.get(candidate.qq!.key);
        if (previous && (previous.qq!.senderId !== candidate.qq!.senderId || previous.qq!.body !== candidate.qq!.body
          || previous.qq!.ts !== candidate.qq!.ts)) throw new Error('The incoming QQ message identity is ambiguous.');
        if (!previous) identities.set(candidate.qq!.key, candidate);
      }
      candidates = [...identities.values()];
    } else {
      if (typeof ref.eventCursor !== 'number' || !Number.isSafeInteger(ref.eventCursor) || ref.eventCursor < 1) throw new Error('An incoming event cursor is required.');
      const event = this.store.get(ref.eventCursor);
      candidates = event?.source === ref.source ? [{ event }] : [];
    }
    const usable = candidates.filter(({ event, qq }) => {
      if (!this.recent(qq ?? event) || event.contextDelivery === 'archive-only' || !(qq?.body ?? incomingLocalText(event))?.trim()) return false;
      const withdrawal = this.withdrawal(event, qq);
      if (withdrawal === 'ambiguous') throw new Error(ambiguousRecall);
      return !withdrawal;
    });
    if (usable.length !== 1) throw new Error('The incoming message is unavailable, expired, withdrawn or ambiguous.');
    return usable[0]!;
  }

  prepare(dream: UsageDream, ref: DreamIncomingRef): PreparedDreamUsage {
    this.prune();
    const incoming = this.incoming(ref);
    const created = Date.parse(dream.createdAt);
    if (!Number.isFinite(created) || created >= Date.parse((incoming.qq ?? incoming.event).ts))
      throw new Error('Only a dream saved before the incoming conversation can earn usage credit.');
    const usageToken = randomUUID(), expiresAt = this.now() + DREAM_USAGE_TTL_MS;
    const pending: PendingUsage = { dreamId: dream.id, source: incoming.event.source as DreamIncomingRef['source'],
      incomingCursor: incoming.qq?.cursor ?? incoming.event.cursor, incomingDeliveryCursor: incoming.event.cursor,
      afterCursor: this.store.latestCursor(), expiresAt, ...(incoming.qq ? { target: incoming.qq.target } : {}) };
    while (this.tokens.size >= DREAM_USAGE_TOKEN_LIMIT) this.tokens.delete(this.tokens.keys().next().value!);
    this.tokens.set(usageToken, pending);
    return { usageToken, source: pending.source, incomingCursor: pending.incomingCursor,
      ...(pending.target ? { target: pending.target } : {}), expiresAt: new Date(expiresAt).toISOString() };
  }

  verify(dreamId: string, usageToken: string, value: DreamReplyRef): VerifiedDreamUsage {
    this.prune();
    const pending = typeof usageToken === 'string' ? this.tokens.get(usageToken) : undefined;
    if (!pending || pending.dreamId !== dreamId) throw new Error('The dream usage token is unknown or expired. Read the dream for the current conversation first.');
    const incoming = this.store.get(pending.incomingDeliveryCursor);
    const qqIncoming = incoming && isQQSource(pending.source) ? parseQQMessage(incoming, this.store) : undefined;
    const withdrawal = incoming && this.withdrawal(incoming, qqIncoming ?? undefined);
    if (withdrawal === 'ambiguous') throw new Error(ambiguousRecall);
    if (!incoming || (isQQSource(pending.source) && !qqIncoming) || withdrawal) throw new Error('The original conversation message is no longer available.');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('An actual outgoing reply reference is required.');
    const reply = value as Record<string, unknown>;
    const id = qqPlatformId(reply.messageId);
    if (isQQSource(pending.source) ? id === undefined || reply.text !== undefined
      : typeof reply.text !== 'string' || !reply.text.trim() || reply.text.length > 20_000 || reply.messageId !== undefined)
      throw new Error('Use the QQ sent message id, or the exact text emitted by the local channel.');
    const previousQQ = isQQSource(pending.source) ? this.store.range({ source: pending.source, toCursor: pending.afterCursor })
      .map(parseQQReceipt).find(receipt => receipt !== null && receipt.target === pending.target && receipt.messageId === id) : undefined;
    if (previousQQ) throw new Error('The QQ reply was already sent before this dream read. Do not score a replayed receipt.');
    let qqCopyWithdrawn = false;
    let candidates = this.store.range({ source: pending.source, fromCursor: pending.afterCursor + 1 })
      .filter(event => {
        const receipt = isQQSource(pending.source) ? parseQQReceipt(event) : undefined;
        if (!this.recent(event) || (isQQSource(pending.source)
          ? !receipt?.body.trim() || receipt.target !== pending.target || receipt.messageId !== id
          : outgoingLocalText(event) !== reply.text)) return false;
        const withdrawn = this.withdrawal(event, receipt ?? undefined);
        if (withdrawn === 'ambiguous') throw new Error(ambiguousRecall);
        if (receipt && withdrawn) qqCopyWithdrawn = true;
        return !withdrawn;
      });
    if (qqCopyWithdrawn) candidates = [];
    if (isQQSource(pending.source) && candidates.length > 1) {
      const first = parseQQReceipt(candidates[0]!)!;
      if (candidates.every(event => parseQQReceipt(event)!.body === first.body)) candidates = [candidates[0]!];
    }
    if (!candidates.length) throw new Error(pending.source === 'qqbot'
      ? 'No matching successful output record is available yet. QQ scoring requires a confirmed qq.sent event; the active QQ World may not provide this receipt. A tool return or self message cannot replace it.'
      : 'No matching successful output record is available yet. Do not score an unsent reply.');
    if (candidates.length !== 1) throw new Error('The outgoing reply reference is ambiguous.');
    const event = candidates[0]!;
    const sharing = isQQSource(pending.source) && this.store.range({ source: 'dream', fromCursor: pending.incomingCursor + 1, toCursor: event.cursor })
      .some(item => item.type === 'dream.share' && item.origin === 'internal' && item.meta?.recordId === dreamId
        && (item.meta?.target === pending.target || (pending.target?.startsWith('group:') && item.meta?.groupId === pending.target.slice(6))
          || (pending.target?.startsWith('private:') && item.meta?.privateId === pending.target.slice(8))));
    if (sharing) throw new Error('Automatic dream sharing does not earn usage credit. Wait for a new conversation topic.');
    const replyKey = isQQSource(pending.source) ? `${pending.source}:${pending.target}:${id}`
      : `${pending.source}:${event.run ?? 'legacy'}:${event.cursor}`;
    if (pending.verifiedKey && pending.verifiedKey !== replyKey) throw new Error('This usage token already identifies another reply.');
    pending.verifiedKey = replyKey;
    return { replyKey, source: pending.source, eventCursor: event.cursor, incomingCursor: pending.incomingCursor,
      ...(pending.target ? { target: pending.target } : {}) };
  }
}

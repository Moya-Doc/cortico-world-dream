import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventEnvelope, ToolCallContext } from 'cortico/core/types.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { DREAM_RETENTION_MS, DreamArchive } from '../src/archive.ts';
import { DREAM_DEFAULTS } from '../src/config.ts';
import { DREAM } from '../src/definition.ts';
import { DreamWorld } from '../src/world.ts';
import { RealHost } from './helpers/real-host.ts';

let dir: string, now: number, host: RealHost, world: DreamWorld | undefined;
let context: ReturnType<typeof fakeWorldContext<ReturnType<typeof DREAM.defaults>>>;
const source = { title: 'Public observation', url: 'https://news.example.test/observation', content: 'A new formation was observed.' };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dream-archive-world-'));
  now = Date.parse('2026-10-27T03:00:00.000Z');
  context = fakeWorldContext(DREAM, { scratchDir: dir });
  Object.assign(context.cfg, { collectorOrder: [], idleEnabled: false, daydreamEnabled: false,
    sleepScheduleEnabled: false, dreamMode: 'probability', dreamProbability: 0 });
  host = new RealHost(dir); world = undefined;
});
afterEach(async () => { await world?.stop(); rmSync(dir, { recursive: true, force: true }); });
function archive() { return new DreamArchive(join(context.dataDir, 'dream')); }
function savedDream(createdAt = now - 1000, queueShare = false) {
  return archive().append('An observatory floated above a paper sea.', [], [source], createdAt, 'The paper observatory', { kind: 'sleep', queueShare });
}
async function start() {
  world = new DreamWorld({ context, now: () => now, pollMs: 1000000 });
  await world.start(host);
}
async function invoke(name: string, args: Record<string, unknown> = {}) {
  const outcome = await world!.tools().find(tool => tool.name === name)!.handler(args, {} as ToolCallContext);
  return JSON.parse(typeof outcome === 'string' ? outcome : outcome.text);
}
function localIncoming(text = 'That observatory story reminds me of your dream.') {
  return host.store.append({ source: 'desktop-pet', type: 'desktop-pet.message', origin: 'external',
    ts: new Date(now).toISOString(), text, meta: { text } });
}
function localOutput(text: string) {
  return host.store.append({ source: 'desktop-pet', type: 'desktop-pet.self', origin: 'external',
    ts: new Date(now).toISOString(), text, meta: { kind: 'say', beats: [{ text }] } });
}
function qq(messageId: string, kind: 'message' | 'self' = 'message', extra: Partial<EventEnvelope> = {}) {
  const text = kind === 'message' ? 'Could that observatory be like your dream?' : 'My dream had an observatory above a paper sea.';
  return host.store.append({ source: 'qq', type: `qq.${kind}`, origin: 'external', ts: new Date(now).toISOString(),
    text: `#${messageId} [Fixture 03:00] ${kind === 'self' ? '你' : 'User(7001)'}: ${text}`,
    meta: { message_id: messageId, user_id: kind === 'self' ? 7002 : 7001, conv: { kind: 'group', id: 8001 } }, ...extra });
}
async function prepareLocal(id: string) {
  const incoming = localIncoming();
  return invoke('dream_read', { id, replyTo: { source: 'desktop-pet', eventCursor: incoming.cursor } });
}

describe('World archive maintenance', () => {
  it('removes expired queued dreams before startup can offer them for sharing', async () => {
    const expired = savedDream(now - DREAM_RETENTION_MS - 1, true);
    context.cfg.dreamTalkEnabled = true; context.cfg.dreamTalkGroups = '8001';
    await start();
    expect(world!.state().dreams).toEqual([]);
    expect(archive().get(expired.id)).toBeUndefined();
    expect(archive().pendingShares()).toEqual([]);
    expect(host.store.range({ source: 'dream' }).filter(event => event.type === 'dream.share')).toEqual([]);
  });

  it('retains an exact thirty-day record at startup and removes it at the next minute maintenance', async () => {
    const dream = savedDream(now - DREAM_RETENTION_MS);
    await start();
    expect(archive().get(dream.id)).toBeDefined();
    now += 59999; await world!.tick();
    expect(archive().get(dream.id)).toBeDefined();
    now++; await world!.tick();
    expect(archive().get(dream.id)).toBeUndefined();
    expect(JSON.parse(world!.envPromptVars()['dream.index'])).toEqual([]);
  });

  it('prunes immediately for model queries and returns no stale body on reads', async () => {
    const dream = savedDream(now - DREAM_RETENTION_MS);
    await start(); now++;
    expect(await invoke('dream_query', { query: 'observatory' })).toEqual([]);
    expect(await invoke('dream_read', { id: dream.id })).toEqual({ error: 'Dream not found.' });
    expect(archive().get(dream.id)).toBeUndefined();
  });

  it('returns score and classification for deep dreams after ordinary retention expires', async () => {
    const oldTime = now - DREAM_RETENTION_MS * 2;
    const dream = savedDream(oldTime);
    const promoted = archive().markUsed(dream.id, 'verified:prior', oldTime + 1, 0).record;
    await start();
    const rows = await invoke('dream_query', { query: 'paper' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: dream.id, score: promoted.score, tier: 'deep', promotedAt: promoted.promotedAt });
    expect(await invoke('dream_read', { id: dream.id })).toEqual(promoted);
    now += DREAM_RETENTION_MS; await world!.tick();
    expect(world!.state().dreams[0]).toEqual(promoted);
  });
});

describe('World verified dream usage', () => {
  it('scores an actual desktop reply only after a prepared read and deduplicates tool retries', async () => {
    const dream = savedDream(); await start();
    const read = await prepareLocal(dream.id);
    const text = 'That topic brings back the paper sea beneath my dream observatory.';
    await expect(invoke('dream_mark_used', { id: dream.id, usageToken: read.usage.usageToken, reply: { text } }))
      .rejects.toThrow('No matching successful output');
    expect(archive().get(dream.id)?.score).toBe(0);
    const secondRead = await invoke('dream_read', { id: dream.id,
      replyTo: { source: 'desktop-pet', eventCursor: read.usage.incomingCursor } });
    localOutput(text);
    const counted = await invoke('dream_mark_used', { id: dream.id, usageToken: read.usage.usageToken, reply: { text } });
    expect(counted).toMatchObject({ incremented: true, promoted: false, record: { id: dream.id, score: 1, tier: 'ordinary' } });
    expect(await invoke('dream_mark_used', { id: dream.id, usageToken: read.usage.usageToken, reply: { text } }))
      .toMatchObject({ incremented: false, record: { score: 1 } });
    expect(await invoke('dream_mark_used', { id: dream.id, usageToken: secondRead.usage.usageToken, reply: { text } }))
      .toMatchObject({ incremented: false, record: { score: 1 } });
    expect(archive().get(dream.id)?.score).toBe(1);
    const persisted = JSON.parse(readFileSync(join(context.dataDir, 'dream/archive.json'), 'utf8'));
    expect(persisted.usageReceipts).toHaveLength(1);
    expect(JSON.stringify(persisted.usageReceipts)).not.toContain(text);
  });

  it('promotes on the fourth valid use at the default threshold and keeps deep status when it is raised', async () => {
    const dream = savedDream(); await start();
    const threshold = DREAM_DEFAULTS.deepDreamThreshold;
    for (let use = 1; use <= threshold + 1; use++) {
      now += 1000;
      const read = await prepareLocal(dream.id);
      const text = `The observatory in that old dream fits our topic ${use}.`;
      localOutput(text);
      const marked = await invoke('dream_mark_used', { id: dream.id, usageToken: read.usage.usageToken, reply: { text } });
      expect(marked.record.score).toBe(use);
      expect(marked.record.tier).toBe(use > threshold ? 'deep' : 'ordinary');
      expect(marked.promoted).toBe(use > threshold);
    }
    const promotedAt = archive().get(dream.id)!.promotedAt;
    context.cfg.deepDreamThreshold = threshold + 10;
    now += DREAM_RETENTION_MS + 1;
    const read = await prepareLocal(dream.id), text = 'That old dream still matches this new topic.';
    localOutput(text);
    expect(await invoke('dream_mark_used', { id: dream.id, usageToken: read.usage.usageToken, reply: { text } }))
      .toMatchObject({ incremented: true, promoted: false,
        record: { score: threshold + 2, tier: 'deep', promotedAt } });
  });

  it('verifies QQ sent IDs without granting or requiring sleep command ownership', async () => {
    const dream = savedDream(); await start();
    expect(context.cfg.qqUsers).toBe('');
    qq('101');
    const read = await invoke('dream_read', { id: dream.id, replyTo: { source: 'qq', messageId: '101', target: 'group:8001' } });
    qq('102', 'self', { type: 'qq.draft' });
    await expect(invoke('dream_mark_used', { id: dream.id, usageToken: read.usage.usageToken, reply: { messageId: '102' } }))
      .rejects.toThrow('No matching successful output');
    qq('103', 'self');
    expect(await invoke('dream_mark_used', { id: dream.id, usageToken: read.usage.usageToken, reply: { messageId: '103' } }))
      .toMatchObject({ incremented: true, record: { score: 1 } });
    expect(archive().get(dream.id)?.score).toBe(1);
  });

  it('keeps ordinary reads and actual automatic QQ sharing unscored', async () => {
    const dream = savedDream(now - 1000, true);
    qq('201');
    context.cfg.dreamTalkEnabled = true; context.cfg.dreamTalkGroups = '8001';
    await start();
    expect(host.store.range({ source: 'dream' }).filter(event => event.type === 'dream.share')).toHaveLength(1);
    const ordinary = await invoke('dream_read', { id: dream.id });
    expect(ordinary.usage).toBeUndefined();
    expect((await invoke('dream_query', { query: 'paper' }))[0].score).toBe(0);
    const read = await invoke('dream_read', { id: dream.id, replyTo: { source: 'qq', messageId: '201', target: 'group:8001' } });
    qq('202', 'self');
    await expect(invoke('dream_mark_used', { id: dream.id, usageToken: read.usage.usageToken, reply: { messageId: '202' } }))
      .rejects.toThrow('Automatic dream sharing');
    expect(archive().get(dream.id)?.score).toBe(0);
  });

  it('rejects console references and unprepared score reports', async () => {
    const dream = savedDream(); await start();
    const incoming = host.store.append({ source: 'console', type: 'console.message', origin: 'internal',
      ts: new Date(now).toISOString(), text: '[console] Tell me about the observatory dream.', meta: { body: 'Tell me about the observatory dream.' } });
    await expect(invoke('dream_read', { id: dream.id, replyTo: { source: 'console', eventCursor: incoming.cursor } }))
      .rejects.toThrow('Only QQ and desktop');
    await expect(invoke('dream_mark_used', { id: dream.id, usageToken: 'not-prepared', reply: { text: 'A dream reply.' } }))
      .rejects.toThrow('unknown or expired');
    expect(archive().get(dream.id)?.score).toBe(0);
  });

  it('rejects prepared tokens after sleeping and waking without carrying them into the next conversation', async () => {
    const dream = savedDream(); await start();
    const read = await prepareLocal(dream.id);
    await world!.sleep(10);
    await expect(invoke('dream_mark_used', { id: dream.id, usageToken: read.usage.usageToken, reply: { text: 'A dream reply.' } }))
      .rejects.toThrow('only while awake');
    await world!.wake(); localOutput('A dream reply.');
    await expect(invoke('dream_mark_used', { id: dream.id, usageToken: read.usage.usageToken, reply: { text: 'A dream reply.' } }))
      .rejects.toThrow('unknown or expired');
    expect(archive().get(dream.id)?.score).toBe(0);
  });
});

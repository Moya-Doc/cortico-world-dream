import { mkdtempSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlEventStore } from 'cortico/core/event-store.ts';
import type { EventEnvelope, PushOptions, ToolCallContext, WorldHost } from 'cortico/core/types.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { DreamArchive } from '../src/archive.ts';
import type { DreamConfigSection } from '../src/config.ts';
import { DREAM } from '../src/definition.ts';
import type { SearchClient, SearchResult } from '../src/search.ts';
import { DreamWorld } from '../src/world.ts';
import { RealHost } from './helpers/real-host.ts';

class PolicyHost extends RealHost {
  beforeShare?: () => void;
  afterShare?: () => void;
  constructor(dir: string, run: number) {
    super(dir);
    this.store = new JsonlEventStore({ dataDir: dir, run: `r-20261025-120000-${run.toString(16).padStart(4, '0')}`, timezone: 'UTC' });
  }
  override async pushEvent(event: Parameters<WorldHost['pushEvent']>[0], opts?: PushOptions): Promise<EventEnvelope> {
    if (event.type === 'dream.share') this.beforeShare?.();
    const saved = await super.pushEvent(event, opts);
    if (event.type === 'dream.share') this.afterShare?.();
    return saved;
  }
}
const article: SearchResult = { title: 'A public observatory opens', url: 'https://news.example.org/observatory', content: 'The observatory opened to the public.' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(options: { cfg?: Partial<DreamConfigSection>; search?: SearchClient['search']; random?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dream-sleep-policy-'));
  const context = { ...fakeWorldContext(DREAM, { scratchDir: dir }), timezone: 'UTC' };
  Object.assign(context.cfg, { qqUsers: '7001' }, options.cfg); context.secret = () => 'fixture-key';
  let now = Date.parse('2026-10-25T12:00:00Z');
  const instances: DreamWorld[] = [];
  const create = () => {
    const host = new PolicyHost(context.dataDir, instances.length + 1);
    const world = new DreamWorld({ context, now: () => now, random: options.random ?? (() => 0), pollMs: 100000,
      search: { search: options.search ?? (async () => [structuredClone(article)]), close: async () => {} } });
    instances.push(world); return { world, host };
  };
  const current = create(); await current.world.start(current.host);
  cleanups.push(async () => { for (const world of instances) await world.stop(); rmSync(dir, { recursive: true, force: true }); });
  return { ...current, context, create, setNow: (value: string) => { now = Date.parse(value); },
    now: () => now, archive: () => new DreamArchive(join(context.dataDir, 'dream')) };
}
async function tool(world: DreamWorld, name: string, args: Record<string, unknown> = {}) {
  const result = await world.tools().find(item => item.name === name)!.handler({ cycleId: world.state().cycleId, ...args }, {} as ToolCallContext);
  return JSON.parse(typeof result === 'string' ? result : result.text);
}
const events = (host: PolicyHost, type: string) => host.store.range({ source: 'dream' }).filter(event => event.type === `dream.${type}`);
function qq(host: PolicyHost, now: number, body: string, user = 7001, privateMessage = false) {
  const messageId = 10000 + host.store.latestCursor();
  return host.store.append({ source: 'qq', type: 'qq.message', senderKey: String(user), origin: 'external', ts: new Date(now).toISOString(),
    text: `#${messageId} [${privateMessage ? '私聊' : '群「Fixture」'} 12:00] User(${user}): ${body}`,
    meta: { message_id: messageId, user_id: user, sender_name: 'User', conv: { kind: privateMessage ? 'private' : 'group', id: privateMessage ? user : 9001 } } });
}
function touch(host: PolicyHost, now: number, woke: boolean) {
  return host.store.append({ source: 'desktop-pet', type: 'desktop-pet.touch', senderKey: 'desktop-pet.touch', origin: 'external',
    ts: new Date(now).toISOString(), text: '[touch] The operator poked the pet.', meta: { touch: { kind: 'poke', count: 1, woke, crashed: false } } });
}
async function collectAndRecord(world: DreamWorld) {
  const found = await tool(world, 'dream_search', { query: 'public observatory opening' });
  return tool(world, 'dream_record', { title: 'The floating observatory', text: 'An observatory floated over a silver sea.',
    sourceIds: found.sources.map((source: { id: string }) => source.id) });
}
async function alarm(world: DreamWorld, time = '12:00', topic = 'Public observatories') {
  await world.webUi().invoke!('dream', 'saveDaydreamAlarm', [{ time, topic }]);
  return world.state().daydreamAlarms.find(item => item.time === time)!;
}

describe('sleep interruption policy', () => {
  it('cancels sleep and pending collection when the body reports touch.woke=true', async () => {
    const pending = deferred<SearchResult[]>(); let signal: AbortSignal | undefined;
    const { world, host, now } = await fixture({ search: async (_query, current) => { signal = current; return pending.promise; } });
    await world.sleep(); const cycleId = world.state().cycleId;
    const searching = tool(world, 'dream_search', { query: 'public observatories' }); const rejected = expect(searching).rejects.toThrow();
    touch(host, now(), true); await world.tick();
    expect(signal?.aborted).toBe(true); expect(world.state()).toMatchObject({ sleeping: false, dreaming: false });
    pending.resolve([article]); await rejected;
    expect(world.state()).toMatchObject({ dreams: [], quota: { dailyUsed: 0 } });
    await expect(tool(world, 'dream_record', { cycleId, title: 'Old dream', text: 'Old text', sourceIds: [] })).rejects.toThrow('no longer active');
    expect(events(host, 'woke')).toHaveLength(1);
  });

  it('keeps sleeping after a touch with woke=false', async () => {
    const { world, host, now } = await fixture(); await world.sleep(); const cycleId = world.state().cycleId;
    touch(host, now(), false); await world.tick();
    expect(world.state()).toMatchObject({ sleeping: true, dreaming: true, cycleId }); expect(events(host, 'woke')).toEqual([]);
  });

  it.each([
    ['ordinary owner group message', 'Hello', 7001, false],
    ['owner name mention', 'Coo, hello', 7001, false],
    ['owner group wake command without a self mention', '醒来', 7001, false],
    ['ordinary owner private message', 'Hello', 7001, true],
    ['ordinary other user message', 'Hello Coo', 8002, false],
  ])('keeps sleeping for %s', async (_label, body, user, privateMessage) => {
    const { world, host, now } = await fixture(); await world.sleep(); const cycleId = world.state().cycleId;
    qq(host, now(), body, user, privateMessage); await world.tick();
    expect(world.state()).toMatchObject({ sleeping: true, dreaming: true, cycleId });
    expect(events(host, 'woke')).toEqual([]); expect(events(host, 'sleep_reply')).toEqual([]);
  });

  it.each([
    ['other user wake mention', '@Coo(你) 醒来', 8002],
    ['owner ordinary mention', '@Coo(你) Hello', 7001],
  ])('only suggests a sleep phrase for %s', async (_label, body, user) => {
    const { world, host, now } = await fixture(); await world.sleep(); const cycleId = world.state().cycleId;
    const message = qq(host, now(), body, user); await world.tick(); await world.tick();
    expect(world.state()).toMatchObject({ sleeping: true, dreaming: true, cycleId }); expect(events(host, 'woke')).toEqual([]);
    expect(events(host, 'sleep_reply')).toHaveLength(1);
    expect(events(host, 'sleep_reply')[0]).toMatchObject({ origin: 'external', meta: { eventCursor: message.cursor } });
    expect(host.store.range({ source: 'qq' })).toHaveLength(1);
  });

  it.each([false, true])('accepts an owner explicit wake command with private=%s', async privateMessage => {
    const { world, host, now } = await fixture(); await world.sleep();
    qq(host, now(), privateMessage ? '醒来' : '@Coo(你) 醒来', 7001, privateMessage); await world.tick();
    expect(world.state()).toMatchObject({ sleeping: false, dreaming: false }); expect(events(host, 'woke')).toHaveLength(1);
    expect(events(host, 'sleep_reply')).toEqual([]);
  });

  it('requires explicit intent for the QQ wake tool and never lets nonowners override identity checks', async () => {
    const { world, host, now } = await fixture(); await world.sleep();
    const ordinary = qq(host, now(), '@Coo(你) Hello');
    await expect(tool(world, 'dream_wake', { eventCursor: ordinary.cursor })).rejects.toThrow('explicit owner wake request');
    const outsider = qq(host, now(), '@Coo(你) Please wake up now', 8002);
    await expect(tool(world, 'dream_wake', { eventCursor: outsider.cursor, explicitWakeRequest: true })).rejects.toThrow('authorized');
    const unaddressed = qq(host, now(), 'Please wake up now');
    await expect(tool(world, 'dream_wake', { eventCursor: unaddressed.cursor, explicitWakeRequest: true })).rejects.toThrow('authorized');
    expect(world.state().sleeping).toBe(true);
    const request = qq(host, now(), '@Coo(你) Coo，请结束休息，陪我说句话');
    await tool(world, 'dream_wake', { eventCursor: request.cursor, explicitWakeRequest: true });
    expect(world.state()).toMatchObject({ sleeping: false, dreaming: false });
  });

  it('does not give a private dream-sharing recipient permission to wake or command sleep', async () => {
    const { world, host, now } = await fixture({ cfg: { dreamTalkEnabled: true, dreamTalkPrivates: '8002' } });
    await world.sleep();
    const request = qq(host, now(), '醒来', 8002, true); await world.tick();
    expect(world.state().sleeping).toBe(true);
    await expect(tool(world, 'dream_wake', { eventCursor: request.cursor, explicitWakeRequest: true })).rejects.toThrow('authorized');
    expect((await tool(world, 'dream_status'))).toMatchObject({ qqOwners: ['7001'], sharing: { privates: ['8002'] } });
  });
});

describe('scheduled daydream topics', () => {
  it('reuses each alarm topic every day without consuming a sleep material processing flag', async () => {
    const { world, setNow, host } = await fixture({ cfg: { daydreamEnabled: true } });
    await world.webUi().invoke!('dream', 'addMaterial', ['Sleep-only topic']);
    const first = await alarm(world, '12:00', 'Public observatories'); const second = await alarm(world, '12:01', 'Public gardens');
    await world.tick(); let status = await tool(world, 'dream_status');
    expect(status).toMatchObject({ sleeping: false, dreamKind: 'daydream', daydreamAlarm: first, materials: [] });
    await expect(tool(world, 'dream_search', { query: 'sleep topic', materialId: world.state().materials[0].id })).rejects.toThrow('alarm topic');
    const one = await collectAndRecord(world);
    expect(one).toMatchObject({ kind: 'daydream', alarmId: first.id, topic: first.topic, materialIds: [] });
    setNow('2026-10-25T12:01:00Z'); await world.tick(); status = await tool(world, 'dream_status');
    expect(status.daydreamAlarm).toEqual(second); await collectAndRecord(world);
    setNow('2026-10-26T12:00:00Z'); await world.tick(); status = await tool(world, 'dream_status');
    expect(status.daydreamAlarm).toEqual(first); await collectAndRecord(world);
    expect(world.state().materials[0].lastProcessedDate).toBeNull(); expect(events(host, 'requested')).toHaveLength(3);
  });

  it('migrates old times to empty topics and waits for explicit topic configuration', async () => {
    let requests = 0;
    const { world, create, host } = await fixture({ cfg: { daydreamEnabled: true, daydreamTimes: '12:00,12:01' },
      search: async () => { requests++; return [article]; } });
    expect(world.state().daydreamAlarms.map(item => ({ time: item.time, topic: item.topic }))).toEqual([
      { time: '12:00', topic: '' }, { time: '12:01', topic: '' },
    ]);
    await world.tick(); expect(world.state().dreaming).toBe(false); expect(events(host, 'requested')).toEqual([]); expect(requests).toBe(0);
    const original = world.state().daydreamAlarms[0];
    await world.webUi().invoke!('dream', 'saveDaydreamAlarm', [{ id: original.id, time: original.time, topic: 'Public observatories' }]);
    await world.tick(); expect((await tool(world, 'dream_status')).daydreamAlarm.topic).toBe('Public observatories');
    await world.stop(); const restarted = create(); await restarted.world.start(restarted.host); await restarted.world.tick();
    expect(restarted.world.state().daydreamAlarms).toHaveLength(2); expect(restarted.world.state().dreaming).toBe(false);
    expect(events(restarted.host, 'requested')).toHaveLength(1);
  });
});

describe('dream sharing suggestions', () => {
  it('waits for wake before recommending a private recipient and records only one suggestion across restart', async () => {
    const { world, host, archive, create } = await fixture({ cfg: { dreamTalkEnabled: true, dreamTalkPrivates: '8001' } });
    await world.sleep(); const saved = await collectAndRecord(world);
    expect(events(host, 'share')).toEqual([]); expect(archive().pendingShares()).toEqual([{ recordId: saved.id }]);
    await world.wake();
    expect(events(host, 'share')).toHaveLength(1);
    expect(events(host, 'share')[0]).toMatchObject({ meta: { recordId: saved.id, target: 'private:8001', privateId: '8001' } });
    expect(events(host, 'share')[0].meta).not.toHaveProperty('groupId');
    await world.stop(); const restarted = create(); await restarted.world.start(restarted.host); await restarted.world.tick();
    expect(events(restarted.host, 'share')).toHaveLength(1); expect(restarted.host.store.range({ source: 'qq' })).toEqual([]);
  });

  it.each([[0, 'group:9001'], [0.3, 'group:9002'], [0.6, 'private:9001'], [0.9, 'private:8002']] as const)
    ('chooses one target from both recipient lists at random=%s', async (random, target) => {
      const { world, host } = await fixture({ cfg: { daydreamEnabled: true, dreamTalkEnabled: true,
        dreamTalkGroups: '9001,9002,9001', dreamTalkPrivates: '9001,8002,8002' }, random: () => random });
      await alarm(world); await world.tick(); await collectAndRecord(world);
      expect(events(host, 'share')).toHaveLength(1); expect(events(host, 'share')[0].meta?.target).toBe(target);
      expect(host.store.range({ source: 'qq' })).toEqual([]);
      expect((await tool(world, 'dream_status')).sharing).toEqual({ enabled: true, groups: ['9001', '9002'], privates: ['9001', '8002'] });
    });

  it('waits for sleep to end, selects one group and never duplicates the event across ticks or restart', async () => {
    const { world, host, archive, create } = await fixture({ cfg: { dreamTalkEnabled: true, dreamTalkGroups: '9001,9002,9003' }, random: () => 0.6 });
    await world.sleep(); const saved = await collectAndRecord(world);
    expect(archive().pendingShares()).toEqual([{ recordId: saved.id }]); expect(events(host, 'share')).toEqual([]);
    await world.tick(); expect(events(host, 'share')).toEqual([]); await world.wake();
    expect(events(host, 'share')).toHaveLength(1);
    expect(events(host, 'share')[0]).toMatchObject({ meta: { recordId: saved.id, groupId: '9002' }, origin: 'internal' });
    expect(archive().pendingShares()).toEqual([]); await world.tick(); await world.stop();
    const restarted = create(); await restarted.world.start(restarted.host); await restarted.world.tick();
    expect(events(restarted.host, 'share')).toHaveLength(1); expect(restarted.host.store.range({ source: 'qq' })).toEqual([]);
  });

  it('offers an awake daydream immediately after saving', async () => {
    const { world, host } = await fixture({ cfg: { daydreamEnabled: true, dreamTalkEnabled: true, dreamTalkGroups: '9001' } });
    await alarm(world); await world.tick(); const saved = await collectAndRecord(world);
    expect(world.state()).toMatchObject({ sleeping: false, dreaming: false });
    expect(events(host, 'share')).toHaveLength(1); expect(events(host, 'share')[0].meta?.recordId).toBe(saved.id);
  });

  it.each([
    [false, '9001'], [true, ''], [true, '0'], [true, '9001,not-a-group'],
  ])('does not queue sharing with enabled=%s and groups=%s', async (enabled, groups) => {
    const { world, archive, host } = await fixture({ cfg: { dreamTalkEnabled: enabled, dreamTalkGroups: groups } });
    expect((await tool(world, 'dream_status')).sharing.enabled).toBe(false);
    await world.sleep(); await collectAndRecord(world); await world.wake();
    expect(archive().pendingShares()).toEqual([]); expect(events(host, 'share')).toEqual([]);
  });

  it.each(['disable', 'delete'] as const)('clears pending suggestions after %s without refunding collection quota', async action => {
    const { world, context, archive, host } = await fixture({ cfg: { dreamTalkEnabled: true, dreamTalkGroups: '9001' } });
    await world.sleep(); const saved = await collectAndRecord(world); const used = world.state().quota.dailyUsed;
    expect(archive().pendingShares()).toHaveLength(1);
    if (action === 'disable') context.cfg.dreamTalkEnabled = false;
    else await world.webUi().invoke!('dream', 'removeDream', [saved.id]);
    await world.tick(); expect(archive().pendingShares()).toEqual([]); expect(world.state().quota.dailyUsed).toBe(used);
    await world.wake(); expect(events(host, 'share')).toEqual([]);
  });

  it('retains the selected group when retrying a failed notification', async () => {
    let choice = 0;
    const { world, host, archive } = await fixture({ cfg: { dreamTalkEnabled: true, dreamTalkGroups: '9001,9002' }, random: () => choice });
    await world.sleep(); const saved = await collectAndRecord(world);
    host.beforeShare = () => { throw new Error('Fixture event delivery unavailable'); };
    await expect(world.wake()).rejects.toThrow('Fixture event delivery unavailable');
    expect(archive().pendingShares()[0]).toMatchObject({ recordId: saved.id, selectedGroupId: '9001' });
    choice = 0.9; host.beforeShare = undefined; await world.tick();
    expect(events(host, 'share')).toHaveLength(1); expect(events(host, 'share')[0].meta?.groupId).toBe('9001');
  });

  it('drops a prepared suggestion if its chosen group leaves the configured list', async () => {
    const { world, host, archive, context } = await fixture({ cfg: { dreamTalkEnabled: true, dreamTalkGroups: '9001,9002' } });
    await world.sleep(); await collectAndRecord(world);
    host.beforeShare = () => { throw new Error('Fixture event delivery unavailable'); };
    await expect(world.wake()).rejects.toThrow(); expect(archive().pendingShares()[0].selectedGroupId).toBe('9001');
    context.cfg.dreamTalkGroups = '9002'; host.beforeShare = undefined; await world.tick();
    expect(archive().pendingShares()).toEqual([]); expect(events(host, 'share')).toEqual([]);
  });

  it('keeps a private target on retry and drops it when removed even if an identically numbered group remains', async () => {
    const { world, host, archive } = await fixture({ cfg: { dreamTalkEnabled: true, dreamTalkGroups: '8001', dreamTalkPrivates: '8001,8002' }, random: () => 0.5 });
    await world.sleep(); await collectAndRecord(world);
    host.beforeShare = () => { throw new Error('Fixture event delivery unavailable'); };
    await expect(world.wake()).rejects.toThrow();
    expect(archive().pendingShares()[0]).toMatchObject({ selectedPrivateId: '8001' });
    await expect(world.tick()).rejects.toThrow();
    expect(archive().pendingShares()[0]).toMatchObject({ selectedPrivateId: '8001' });
    await world.webUi().invoke!('qq-talk', 'saveQQConfig', [{ dreamTalkPrivates: '8002' }]);
    host.beforeShare = undefined; await world.tick();
    expect(archive().pendingShares()).toEqual([]); expect(events(host, 'share')).toEqual([]);
  });

  it('recovers a legacy group event without a canonical target field after restart', async () => {
    const { world, host, archive, create, now } = await fixture({ cfg: { dreamTalkEnabled: true, dreamTalkGroups: '9001' } });
    await world.sleep(); const saved = await collectAndRecord(world);
    host.beforeShare = () => { throw new Error('Fixture event delivery unavailable'); };
    await expect(world.wake()).rejects.toThrow();
    host.store.append({ source: 'dream', type: 'dream.share', origin: 'internal', ts: new Date(now()).toISOString(),
      text: 'A legacy sharing suggestion.', meta: { recordId: saved.id, groupId: '9001' } });
    await world.stop(); const restarted = create(); await restarted.world.start(restarted.host); await restarted.world.tick();
    expect(events(restarted.host, 'share')).toHaveLength(1); expect(archive().pendingShares()).toEqual([]);
  });

  it.each(['group', 'private'] as const)('recovers a saved %s share event after the archive mark fails without emitting it again', async kind => {
    const { world, host, context, archive, create } = await fixture({ cfg: { dreamTalkEnabled: true,
      ...(kind === 'group' ? { dreamTalkGroups: '9001' } : { dreamTalkPrivates: '8001' }) } });
    await world.sleep(); const saved = await collectAndRecord(world);
    const file = join(context.dataDir, 'dream', 'archive.json'); const backup = `${file}.fixture-backup`;
    host.afterShare = () => { renameSync(file, backup); mkdirSync(file); };
    await expect(world.wake()).rejects.toThrow(); expect(events(host, 'share')).toHaveLength(1);
    rmSync(file, { recursive: true }); renameSync(backup, file); host.afterShare = undefined;
    expect(archive().pendingShares()[0]).toMatchObject({ recordId: saved.id,
      ...(kind === 'group' ? { selectedGroupId: '9001' } : { selectedPrivateId: '8001' }) });
    await world.stop(); const restarted = create(); await restarted.world.start(restarted.host); await restarted.world.tick();
    expect(events(restarted.host, 'share')).toHaveLength(1); expect(archive().pendingShares()).toEqual([]);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { DREAM } from '../src/definition.ts';
import { DREAM_SECRET } from '../src/config.ts';
import { collectorPatch, collectorReadiness } from '../src/collection.ts';
import { DreamWorld } from '../src/world.ts';
import { SearchError, type SearchClient, type SearchOptions, type SearchResult } from '../src/search.ts';
import { strings, configLabels } from '../src/strings.ts';
import { RealHost } from './helpers/real-host.ts';

const article: SearchResult = { title: 'Public fixture', url: 'https://news.example.org/item', content: 'Public news fixture.' };
class ControlledSearch implements SearchClient {
  requests: Array<{ query: string; options: SearchOptions | undefined }> = [];
  result: SearchResult[] = [article];
  failure?: Error;
  pending?: { entered: Promise<void>; release: () => void; started: () => void; released: Promise<void> };
  hold() {
    let started!: () => void;
    let release!: () => void;
    this.pending = { entered: new Promise(resolve => { started = resolve; }), released: new Promise(resolve => { release = resolve; }),
      started: () => started(), release: () => release() };
    return this.pending;
  }
  async search(query: string, signal: AbortSignal, options?: SearchOptions) {
    this.requests.push({ query, options });
    const pending = this.pending;
    if (pending) {
      pending.started();
      await Promise.race([pending.released, new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new SearchError('Search cancelled.')), { once: true });
        if (signal.aborted) reject(new SearchError('Search cancelled.'));
      })]);
    }
    signal.throwIfAborted();
    if (this.failure) throw this.failure;
    return this.result;
  }
  async close() { this.pending?.release(); }
}

let dir: string;
let context: ReturnType<typeof fakeWorldContext<ReturnType<typeof DREAM.defaults>>>;
let world: DreamWorld;
let host: RealHost;
let search: ControlledSearch;
let key: string;
let now: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dream-collection-status-'));
  context = fakeWorldContext(DREAM, { scratchDir: dir });
  now = Date.parse('2026-10-24T02:00:00Z'); key = '';
  context.secret = name => name === DREAM_SECRET ? key : '';
  context.storeSecret = (name, value) => { if (name === DREAM_SECRET) key = value; };
  host = new RealHost(dir); search = new ControlledSearch();
  world = new DreamWorld({ context, now: () => now, search, pollMs: 100000 });
});
afterEach(async () => { search.pending?.release(); await world.stop(); rmSync(dir, { recursive: true, force: true }); });
async function invoke(method: string, args: unknown[] = [], panel = 'dream') {
  return await world.webUi('en').invoke!(panel, method, args) as ReturnType<DreamWorld['state']>;
}
async function tool(name: string, args: Record<string, unknown>) {
  return JSON.parse(await world.tools().find(item => item.name === name)!.handler(args, {} as ToolCallContext) as string);
}
function egoConfig() {
  context.cfg.egoExecutableFile = '/Applications/Fixture Browser.app'; context.cfg.collectorOrder = ['ego'];
}

describe('collection configuration readiness', () => {
  it('shows exactly one offline lamp with the missing configuration, without exposing credentials', () => {
    const decl = world.webUi('en');
    expect(decl.lamps).toHaveLength(1);
    expect(decl.lamps![0]).toMatchObject({ label: strings('en').collectionConfigTitle, state: 'offline' });
    expect(decl.lamps![0].hint).not.toContain(configLabels('en').egoEnabled);
    expect(decl.lamps![0].hint).toContain(strings('en').keyTitle);
    key = 'fixture-secret';
    expect(world.webUi('en').lamps![0]).toMatchObject({ state: 'online' });
    expect(JSON.stringify(world.state())).not.toContain(key);
  });
  it('uses saved ego configuration for the lamp before a live connection has been checked', () => {
    egoConfig(); key = 'fixture-secret';
    expect(world.state().egoConnection.connected).toBe(false);
    expect(world.state().readiness).toEqual({ ready: true, backend: 'ego', missing: [] });
    expect(world.webUi().lamps![0].state).toBe('online');
  });
  it('chooses the first configured selected method and does not require a browser executable', () => {
    key = 'fixture-secret';
    expect(world.state().readiness).toMatchObject({ ready: true, backend: 'tavily' });
    context.cfg.collectorOrder = ['ego', 'tavily']; context.cfg.egoExecutableFile = 'invalid/path';
    expect(world.state().readiness).toMatchObject({ ready: true, backend: 'tavily' });
    context.cfg.collectorOrder = ['ego'];
    expect(world.state().readiness).toMatchObject({ ready: false, backend: null });
    context.cfg.collectorOrder = ['tavily']; key = '';
    expect(world.state().readiness).toMatchObject({ ready: false, backend: null });
    context.cfg.collectorOrder = ['browser'];
    expect(world.state().readiness).toEqual({ ready: true, backend: 'browser', missing: [] });
  });
  it.each([
    { egoRequestTimeoutMs: 0 }, { egoMaxChars: 0 }, { egoExecutableFile: 'relative/path' },
    { egoConnectionMode: 'unknown' }, { egoHelperDir: 'relative/path' },
  ])('does not report malformed required fields as complete: %j', patch => {
    egoConfig(); Object.assign(context.cfg, patch);
    expect(collectorReadiness(context.cfg, '', 'en').readiness.ready).toBe(false);
    expect(world.webUi().lamps![0].state).toBe('offline');
  });
  it('keeps collection settings on their own panel and excludes secrets and Profile IDs from public patches', async () => {
    expect(world.webUi().panels?.map(panel => panel.id)).toEqual(['dream', 'collection-settings', 'qq-talk']);
    expect(world.state().collectorConfig).not.toHaveProperty('egoProfileId');
    await invoke('saveCollectorConfig', [{ collectorOrder: ['browser'], maxResults: 7 }], 'collection-settings');
    expect(context.cfg).toMatchObject({ collectorOrder: ['browser'], maxResults: 7 });
    for (const patch of [{ apiKey: 'secret' }, { egoProfileId: 'arbitrary' }, { enabled: true }, { maxResults: 1.5 }, { backend: 'browser' }, { egoEnabled: true }, { collectorOrder: ['ego', 'ego'] }]) {
      await expect(invoke('saveCollectorConfig', [patch], 'collection-settings')).rejects.toThrow(strings('en').configInvalid);
    }
    expect(context.cfg.maxResults).toBe(7);
    expect(() => collectorPatch({ maxResults: 3, apiKey: 'secret' })).toThrow();
  });
});

describe('independent connection tests', () => {
  it('collects directly without events, dream records, designated-material progress, or recent collection success', async () => {
    key = 'fixture-secret'; await world.start(host);
    await invoke('addMaterial', ['Private designated topic']);
    const before = world.state(); const cursor = host.store.latestCursor();
    const state = await invoke('testConnection', [], 'collection-settings');
    expect(state.connectionTest).toMatchObject({ status: 'ok', backend: 'tavily', resultCount: 1, checkedAt: new Date(now).toISOString(), error: null });
    expect(search.requests[0]?.query).toMatch(/^current public news \d{4}-\d{2}-\d{2}$/);
    expect(search.requests[0]?.options?.backend).toBe('tavily');
    expect(state.materials).toEqual(before.materials); expect(state.dreams).toEqual(before.dreams);
    expect(state.collection.lastSuccessAt).toBeNull(); expect(state.phase).toBe('awake');
    expect(host.store.latestCursor()).toBe(cursor);
    expect(JSON.stringify(state.connectionTest)).not.toContain(article.content);
  });
  it('reports a valid empty response as a connection success with zero results', async () => {
    key = 'fixture-secret'; search.result = []; await world.start(host);
    expect((await invoke('testConnection')).connectionTest).toMatchObject({ status: 'ok', resultCount: 0 });
  });
  it('reports a known service failure but never returns raw unexpected error text', async () => {
    key = 'fixture-secret'; await world.start(host);
    search.failure = new SearchError('News API returned HTTP 401.');
    expect((await invoke('testConnection')).connectionTest.error).toBe(search.failure.message);
    search.failure = new Error('credential secret path user data');
    expect((await invoke('testConnection')).connectionTest.error).toBe(strings('en').error);
  });
  it('requires an enabled World and complete current-mode configuration before contacting a service', async () => {
    key = 'fixture-secret';
    expect((await invoke('testConnection')).connectionTest.error).toBe(strings('en').collectorStopped);
    await world.start(host); key = '';
    expect((await invoke('testConnection')).connectionTest.error).toContain(strings('en').collectionNotConfigured);
    expect(search.requests).toEqual([]);
  });
  it.each(['wake', 'stop', 'configuration'] as const)('cancels an ongoing connection test on %s', async action => {
    key = 'fixture-secret'; await world.start(host);
    const pending = search.hold(); const test = invoke('testConnection'); await pending.entered;
    expect(world.state().connectionTest.status).toBe('testing');
    if (action === 'wake') await world.wake();
    else if (action === 'stop') await world.stop();
    else await invoke('saveCollectorConfig', [{ maxResults: 4 }]);
    await test;
    expect(world.state().connectionTest.status).not.toBe('ok');
    expect(world.state().collection.lastSuccessAt).toBeNull();
    expect(world.state().dreams).toEqual([]);
  });
  it('rejects overlapping tests and dream collections until the active request has ended', async () => {
    key = 'fixture-secret'; await world.start(host); await world.sleep();
    const pending = search.hold(); const test = invoke('testConnection'); await pending.entered;
    await expect(invoke('testConnection')).rejects.toThrow(strings('en').collectionBusy);
    await expect(tool('dream_search', { cycleId: world.state().cycleId, query: 'Public news' })).rejects.toThrow('already running');
    pending.release(); await test;
    expect(search.requests).toHaveLength(1);
  });
  it('honors an explicit wake message while an awake connection test is running', async () => {
    key = 'fixture-secret'; await world.start(host);
    const pending = search.hold(); const test = invoke('testConnection'); await pending.entered;
    await host.pushEvent({ type: 'console.message', source: 'console', senderKey: 'operator', origin: 'internal',
      ts: new Date(now).toISOString(), text: '醒来', meta: { body: '醒来' } });
    await world.tick(); await test;
    expect(world.state('en').connectionTest.error).toBe(strings('en').testCancelled);
  });
});

describe('dream collection progress', () => {
  it('reports the World phases and marks success only after a real collection returns sources', async () => {
    key = 'fixture-secret'; await world.start(host);
    expect(world.state().phase).toBe('awake');
    await world.sleep(); expect(world.state().phase).toBe('waiting');
    const cycleId = world.state().cycleId;
    const pending = search.hold(); const collecting = tool('dream_search', { cycleId, query: 'Public news' });
    await pending.entered; expect(world.state().phase).toBe('collecting');
    await expect(invoke('testConnection')).rejects.toThrow(strings('en').collectionBusy);
    pending.release(); const results = await collecting;
    expect(world.state()).toMatchObject({ phase: 'generating', collection: { status: 'ok', lastSuccessAt: new Date(now).toISOString() } });
    await tool('dream_record', { cycleId, title: 'A fictional journey', text: 'A fictional dream.', sourceIds: results.sources.map((source: { id: string }) => source.id) });
    expect(world.state().phase).toBe('sleeping');
    await world.wake(); expect(world.state().phase).toBe('awake');
  });
  it('retains the previous success time across exhausted rounds and later failures', async () => {
    key = 'fixture-secret'; await world.start(host); await world.sleep();
    const cycleId = world.state().cycleId;
    await tool('dream_search', { cycleId, query: 'Public news' });
    const success = world.state().collection.lastSuccessAt;
    now += 1000; search.result = [];
    expect(await tool('dream_search', { cycleId, query: 'Public news' })).toMatchObject({ exhausted: true, skipped: false });
    expect(world.state().collection.lastSuccessAt).toBe(success);
    search.failure = new SearchError('News API returned HTTP 429.');
    await world.sleep();
    expect(await tool('dream_search', { cycleId: world.state().cycleId, query: 'Public news' })).toMatchObject({ exhausted: true, skipped: true });
    expect(world.state().collection).toMatchObject({ status: 'error', lastSuccessAt: success, error: search.failure.message });
    search.failure = undefined; search.result = [article];
    await world.sleep(); await tool('dream_search', { cycleId: world.state().cycleId, query: 'Public news' });
    expect(world.state().error).toBeNull();
  });
  it('cancels real collection before applying changed configuration', async () => {
    key = 'fixture-secret'; await world.start(host); await world.sleep();
    const pending = search.hold();
    const collection = tool('dream_search', { cycleId: world.state().cycleId, query: 'Public news' });
    const failed = expect(collection).rejects.toThrow(); await pending.entered;
    await invoke('saveCollectorConfig', [{ collectorOrder: ['browser'] }]); await failed;
    expect(context.cfg.collectorOrder).toEqual(['browser']);
    expect(world.state()).toMatchObject({ dreaming: false, collection: { status: 'idle', lastSuccessAt: null } });
  });
});

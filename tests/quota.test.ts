import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { DREAM } from '../src/definition.ts';
import { DREAM_DEFAULTS } from '../src/config.ts';
import { DreamArchive } from '../src/archive.ts';
import { DreamWorld } from '../src/world.ts';
import type { SearchClient, SearchResult } from '../src/search.ts';
import { BrowserFixture } from './helpers/ego-bridge.ts';
import { RealHost } from './helpers/real-host.ts';

function news(name: string, content = `Public report about ${name}.`): SearchResult {
  return { title: name, url: `https://news.example.org/${name}`, content };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(options: { ego?: boolean; search?: SearchClient['search']; now?: string; timezone?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dream-quota-'));
  const context = { ...fakeWorldContext(DREAM, { scratchDir: dir }), timezone: options.timezone ?? 'UTC' };
  context.secret = () => 'fixture-key'; context.cfg.egoEnabled = Boolean(options.ego);
  let now = Date.parse(options.now ?? '2026-10-24T12:00:00Z');
  const browser = new BrowserFixture();
  const host = new RealHost(dir);
  const instances: DreamWorld[] = [];
  const create = () => {
    const world = new DreamWorld({ context, now: () => now, egoBridge: browser,
      search: { search: options.search ?? (async () => [news('observatory')]), close: async () => {} },
      pollMs: 100000 });
    instances.push(world); return world;
  };
  const world = create(); await world.start(host);
  cleanups.push(async () => {
    browser.pending?.release();
    for (const item of instances) await item.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { world, context, browser, host, create, setNow: (value: string) => { now = Date.parse(value); } };
}
async function tool(world: DreamWorld, name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) {
  const result = await world.tools().find(item => item.name === name)!.handler({ cycleId: world.state().cycleId, ...args }, { signal } as ToolCallContext);
  return JSON.parse(typeof result === 'string' ? result : result.text);
}
const search = (world: DreamWorld, args: Record<string, unknown> = {}) => tool(world, 'dream_search', { query: 'public observatory news', ...args });
const record = (world: DreamWorld, sourceIds: string[]) => tool(world, 'dream_record', {
  title: 'The floating observatory', text: 'A silver observatory floated above the sea.', sourceIds,
});

describe('dream source quotas', () => {
  it('reports configured defaults to the model and panel', async () => {
    const { world } = await fixture();
    const expected = { cycleUsed: 0, cycleLimit: DREAM_DEFAULTS.maxSourcesPerDream, dailyUsed: 0, dailyLimit: DREAM_DEFAULTS.maxSourcesPerDay,
      remaining: Math.min(DREAM_DEFAULTS.maxSourcesPerDream, DREAM_DEFAULTS.maxSourcesPerDay) };
    expect(world.state().quota).toMatchObject(expected);
    expect((await tool(world, 'dream_status')).quota).toEqual(world.state().quota);
  });

  it('clips each request and accepts only distinct URLs within the remaining capacity', async () => {
    const requestLimits: number[] = [];
    const { world, context } = await fixture({ search: async (_query, _signal, options) => {
      requestLimits.push(options!.maxResults);
      return [news('first'), { ...news('first'), url: `${news('first').url}#section` }, news('second'), news('third')];
    } });
    context.cfg.maxSourcesPerDream = 2; context.cfg.maxResults = 10;
    await world.sleep(); const result = await search(world);
    expect(result.sources.map((source: SearchResult) => source.url)).toEqual([news('first').url, news('second').url]);
    expect(requestLimits).toEqual([context.cfg.maxSourcesPerDream]);
    expect(result.quota).toMatchObject({ cycleUsed: 2, dailyUsed: 2, remaining: 0 });
    await expect(search(world)).rejects.toThrow('collection limit');
    const saved = await record(world, result.sources.map((source: { id: string }) => source.id));
    expect(saved.sources).toHaveLength(2); expect(saved.titleSource).toBe('summary');
    expect((await tool(world, 'dream_query', { query: saved.title }))[0]).toMatchObject({ title: saved.title, titleSource: 'summary' });
  });

  it('retains concrete theme queries while marking the designated material processed', async () => {
    const { world } = await fixture({ search: async query => query === 'observatory telescope opening' ? [news('telescope')] : [] });
    await world.webUi().invoke!('dream', 'addMaterial', ['Public observatory']); await world.sleep();
    const material = world.state().materials[0];
    const result = await search(world, { query: 'observatory telescope opening', materialId: material.id });
    expect(result.sources).toHaveLength(1); expect(world.state().materials[0].lastProcessedDate).toBe(world.state().date);
  });

  it('requires a summary title before a retrieved-source dream can be saved', async () => {
    const { world } = await fixture(); await world.sleep(); const found = await search(world);
    await expect(tool(world, 'dream_record', { text: 'A fictional dream.', sourceIds: [found.sources[0].id] })).rejects.toThrow('dream title');
    expect(world.state()).toMatchObject({ dreaming: true, dreams: [] });
    const saved = await record(world, [found.sources[0].id]);
    expect(saved).toMatchObject({ title: 'The floating observatory', titleSource: 'summary' });
  });

  it('retains consumed daily capacity after cancelling an unrecorded dream and restarting', async () => {
    const { world, context, create, host } = await fixture();
    context.cfg.maxSourcesPerDay = 1;
    await world.sleep(); await search(world); await world.wake(); await world.stop();
    const restarted = create(); await restarted.start(host); await restarted.sleep();
    expect(restarted.state()).toMatchObject({ sleeping: true, dreaming: false, dreams: [], quota: { dailyUsed: 1, remaining: 0 } });
    expect(host.store.range({ source: 'dream' }).filter(event => event.type === 'dream.requested')).toHaveLength(1);
  });

  it('counts an already seen URL again when a new dream collects it', async () => {
    const { world } = await fixture();
    await world.sleep(); const first = await search(world); await record(world, [first.sources[0].id]);
    await world.sleep(); const next = await search(world);
    expect(next.sources[0].id).not.toBe(first.sources[0].id);
    expect(world.state().quota).toMatchObject({ cycleUsed: 1, dailyUsed: 2 });
  });

  it('does not count empty or failed results and keeps connection tests outside quota', async () => {
    let mode = 'empty';
    const { world } = await fixture({ search: async () => {
      if (mode === 'fail') throw new Error('Fixture collection failed.');
      return mode === 'ok' ? [news('observatory')] : [];
    } });
    await world.sleep(); expect(await search(world)).toMatchObject({ skipped: true, sources: [] }); mode = 'fail';
    await world.sleep(); expect(await search(world)).toMatchObject({ skipped: true, sources: [] });
    mode = 'ok'; await world.webUi().invoke!('dream', 'testConnection', []);
    expect(world.state()).toMatchObject({ quota: { cycleUsed: 0, dailyUsed: 0 }, dreams: [], connectionTest: { status: 'ok' } });
  });

  it('refuses late results after cancellation without consuming capacity or marking material', async () => {
    const pending = deferred<SearchResult[]>();
    const { world } = await fixture({ search: async () => pending.promise });
    await world.webUi().invoke!('dream', 'addMaterial', ['Public topic']); await world.sleep();
    const controller = new AbortController();
    const reading = tool(world, 'dream_search', { query: 'public topic', materialId: world.state().materials[0].id }, controller.signal);
    const rejected = expect(reading).rejects.toThrow();
    controller.abort(); pending.resolve([news('observatory')]); await rejected;
    expect(world.state().quota.dailyUsed).toBe(0); expect(world.state().materials[0].lastProcessedDate).toBeNull();
  });

  it('rechecks a lower hot configuration limit when a search finishes', async () => {
    const pending = deferred<SearchResult[]>();
    const { world, context } = await fixture({ search: async () => pending.promise });
    await world.sleep(); const reading = search(world);
    context.cfg.maxSourcesPerDream = 1; context.cfg.maxSourcesPerDay = 1;
    pending.resolve([news('first'), news('second')]);
    const result = await reading;
    expect(result.sources).toHaveLength(1); expect(world.state().quota).toMatchObject({ cycleUsed: 1, dailyUsed: 1, remaining: 0 });
  });

  it('assigns a request spanning midnight to its completion date in the deployment timezone', async () => {
    const pending = deferred<SearchResult[]>(); let delay = false;
    const { world, context, setNow } = await fixture({ now: '2026-10-24T12:59:00Z', timezone: 'Australia/Sydney',
      search: async () => delay ? pending.promise : [news('yesterday')] });
    await world.sleep(); await search(world); delay = true;
    const reading = search(world); setNow('2026-10-24T13:01:00Z'); pending.resolve([news('today')]);
    const result = await reading;
    expect(result.quota).toMatchObject({ date: '2026-10-25', cycleUsed: 2, dailyUsed: 1 });
    const archive = new DreamArchive(join(context.dataDir, 'dream'));
    expect(archive.collectionCount('2026-10-24')).toBe(1); expect(archive.collectionCount('2026-10-25')).toBe(1);
  });

  it('allows the next local day to start a new dream after daily exhaustion', async () => {
    const { world, context, setNow } = await fixture({ now: '2026-10-24T12:59:00Z', timezone: 'Australia/Sydney' });
    context.cfg.maxSourcesPerDay = 1;
    await world.sleep(); await search(world); await world.wake(); await world.sleep();
    expect(world.state().dreaming).toBe(false);
    setNow('2026-10-24T13:01:00Z'); await world.sleep();
    expect(world.state()).toMatchObject({ dreaming: true, quota: { date: '2026-10-25', dailyUsed: 0, remaining: 1 } });
  });

  it('does not expose sources or consume capacity when the archive transaction cannot be saved', async () => {
    const { world, context } = await fixture(); await world.sleep();
    const archiveFile = join(context.dataDir, 'dream', 'archive.json'); rmSync(archiveFile); mkdirSync(archiveFile);
    await expect(search(world)).rejects.toThrow();
    expect(world.state()).toMatchObject({ phase: 'waiting', quota: { cycleUsed: 0, dailyUsed: 0 } });
    rmSync(archiveFile, { recursive: true });
    expect((await search(world)).sources).toHaveLength(1);
  });

  it('rejects concurrent collection before a second request can consume capacity', async () => {
    const pending = deferred<SearchResult[]>();
    const { world, context } = await fixture({ search: async () => pending.promise });
    context.cfg.maxSourcesPerDream = 1; await world.sleep();
    const first = search(world); await expect(search(world)).rejects.toThrow('already running');
    pending.resolve([news('observatory')]); await first;
    expect(world.state().quota).toMatchObject({ cycleUsed: 1, dailyUsed: 1 });
  });
});

describe('ego source quotas', () => {
  it('reuses source ids for paginated reads at the limit and rejects a different URL', async () => {
    const { world, context, browser } = await fixture({ ego: true }); context.cfg.maxSourcesPerDream = 1;
    await world.sleep(); const page = (await tool(world, 'dream_ego_open', { url: 'https://news.example.org/report#lead' })).value.page;
    browser.pages.get(page)!.snapshot = `${'A'.repeat(100)}${'B'.repeat(100)}`;
    const first = await tool(world, 'dream_ego_read', { page, maxChars: 100 });
    browser.pages.get(page)!.url = 'https://news.example.org/report#body';
    const second = await tool(world, 'dream_ego_read', { page, offset: 100, maxChars: 100 });
    expect(second.source.id).toBe(first.source.id); expect(second.source.content).toContain('B'.repeat(100));
    expect(world.state().quota).toMatchObject({ cycleUsed: 1, dailyUsed: 1, remaining: 0 });
    await tool(world, 'dream_ego_navigate', { page, url: 'https://news.example.org/another' });
    await expect(tool(world, 'dream_ego_read', { page })).rejects.toThrow('collection limit');
    await tool(world, 'dream_ego_close', { page }); await tool(world, 'dream_ego_handoff');
    const saved = await record(world, [first.source.id]);
    expect(saved.sources).toHaveLength(1); expect(saved.sources[0].content).toContain('B'.repeat(100));
  });

  it('does not recount a cycle source across midnight and keeps query parameters distinct', async () => {
    const { world, setNow, browser } = await fixture({ ego: true, now: '2026-10-24T12:59:00Z', timezone: 'Australia/Sydney' });
    await world.sleep(); const page = (await tool(world, 'dream_ego_open', { url: 'https://news.example.org/item?id=1' })).value.page;
    const first = await tool(world, 'dream_ego_read', { page }); setNow('2026-10-24T13:01:00Z');
    expect((await tool(world, 'dream_ego_read', { page })).source.id).toBe(first.source.id);
    expect(world.state().quota).toMatchObject({ cycleUsed: 1, dailyUsed: 0 });
    browser.pages.get(page)!.url = 'https://news.example.org/item?id=2';
    const next = await tool(world, 'dream_ego_read', { page });
    expect(next.source.id).not.toBe(first.source.id); expect(world.state().quota).toMatchObject({ cycleUsed: 2, dailyUsed: 1 });
  });

  it('never counts a late ego read after waking or a connection test', async () => {
    const { world, browser } = await fixture({ ego: true }); await world.sleep();
    await world.webUi().invoke!('dream', 'testConnection', []);
    expect(world.state().quota.dailyUsed).toBe(0);
    const page = (await tool(world, 'dream_ego_open', { url: 'https://news.example.org/report' })).value.page;
    const pending = browser.hold('read'); const reading = tool(world, 'dream_ego_read', { page });
    const rejected = expect(reading).rejects.toThrow(); await pending.entered;
    const waking = world.wake(); pending.release(); await waking; await rejected;
    expect(world.state().quota.dailyUsed).toBe(0); expect(world.state().dreams).toEqual([]);
  });
});

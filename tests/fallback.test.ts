import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { DREAM } from '../src/definition.ts';
import type { CollectionBackend } from '../src/config.ts';
import { DreamWorld } from '../src/world.ts';
import { SearchError, type SearchClient, type SearchOptions, type SearchResult } from '../src/search.ts';
import { BrowserFixture } from './helpers/ego-bridge.ts';
import { RealHost } from './helpers/real-host.ts';

const news = (name = 'observatory'): SearchResult => ({ title: name, url: `https://news.example.org/${name}`, content: `Public report about ${name}.` });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(order: CollectionBackend[] = ['ego', 'tavily', 'browser'], search?: SearchClient['search']) {
  const dir = mkdtempSync(join(tmpdir(), 'dream-fallback-'));
  const context = { ...fakeWorldContext(DREAM, { scratchDir: dir }), timezone: 'UTC' };
  context.cfg.collectorOrder = order; context.secret = () => 'fixture-key';
  const browser = new BrowserFixture(); const host = new RealHost(dir);
  let now = Date.parse('2026-10-24T12:00:00Z');
  const requests: Array<{ query: string; options: SearchOptions }> = [];
  const world = new DreamWorld({ context, now: () => now, egoBridge: browser, pollMs: 100000,
    search: { async search(query, signal, options) {
      requests.push({ query, options: options! });
      return search ? search(query, signal, options) : [news()];
    }, async close() {} } });
  cleanups.push(async () => { browser.pending?.release(); await world.stop(); rmSync(dir, { recursive: true, force: true }); });
  await world.start(host);
  async function tool(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) {
    const result = await world.tools().find(item => item.name === name)!.handler({ cycleId: world.state().cycleId, ...args }, { signal } as ToolCallContext);
    return JSON.parse(typeof result === 'string' ? result : result.text);
  }
  return { world, context, browser, host, requests, tool, setNow: (value: string) => { now = Date.parse(value); } };
}

describe('ordered collection fallback', () => {
  it('keeps one cycle, theme, material and sleep deadline through manual takeover and a failed service', async () => {
    const { world, browser, requests, tool } = await fixture(undefined, async (_query, _signal, options) => {
      if (options!.backend === 'tavily') throw new SearchError('News API returned HTTP 503.');
      return [news()];
    });
    await world.webUi().invoke!('dream', 'addMaterial', ['Public observatories']); await world.sleep(10);
    const { cycleId, sleepUntil, materials } = world.state();
    const materialId = materials[0].id;
    expect(await tool('dream_search', { query: 'observatory opening today', materialId })).toMatchObject({ needsBrowser: true, backend: 'ego' });
    const page = (await tool('dream_ego_open', { url: 'https://news.example.org' })).value.page;
    browser.ownership = 'user';
    const result = await tool('dream_ego_read', { page });
    expect(result).toMatchObject({ backend: 'browser', nextBackend: 'browser', blockedCode: 'EGO_TASK_SPACE_USER_IN_CONTROL',
      attempts: [{ backend: 'ego', reason: 'EGO_TASK_SPACE_USER_IN_CONTROL' }, { backend: 'tavily', reason: 'News API returned HTTP 503.' }],
      quota: { cycleUsed: 1, dailyUsed: 1 } });
    expect(requests.map(request => [request.options.backend, request.query])).toEqual([
      ['tavily', 'observatory opening today'], ['browser', 'observatory opening today'],
    ]);
    expect(world.state()).toMatchObject({ cycleId, sleepUntil, sleeping: true, activeBackend: 'browser', egoConnection: { halted: true } });
    expect(browser.requests.some(request => request.operation === 'resume')).toBe(false);
    expect(world.state().materials[0].lastProcessedDate).toBe(world.state().date);
    const saved = await tool('dream_record', { title: 'An observatory among clouds', text: 'The telescope floated over a sea of clouds.', sourceIds: [result.sources[0].id] });
    expect(saved.materialIds).toEqual([materialId]); expect(world.state().sleepUntil).toBe(sleepUntil);
  });

  it('honors arbitrary ordering and does not retry failed methods in the same cycle', async () => {
    const { world, requests, tool } = await fixture(['tavily', 'browser', 'ego'], async (_query, _signal, options) => {
      if (options!.backend === 'tavily') throw new Error('Private service internals');
      return [];
    });
    await world.sleep();
    expect(await tool('dream_search', { query: 'public news' })).toMatchObject({ needsBrowser: true, backend: 'ego',
      attempts: [{ backend: 'tavily' }, { backend: 'browser' }] });
    await tool('dream_search', { query: 'public observatory news' });
    expect(requests.map(request => request.options.backend)).toEqual(['tavily', 'browser']);
    expect(JSON.stringify(world.state())).not.toContain('Private service internals');
    await world.sleep(); await tool('dream_search', { query: 'public news' });
    expect(requests.map(request => request.options.backend)).toEqual(['tavily', 'browser', 'tavily', 'browser']);
  });

  it('skips an unconfigured selected method without contacting it', async () => {
    const { world, context, requests, browser, tool } = await fixture(['tavily', 'browser']);
    context.secret = () => ''; await world.sleep();
    expect(await tool('dream_search', { query: 'public news' })).toMatchObject({ backend: 'browser', attempts: [{ backend: 'tavily' }] });
    expect(requests.map(request => request.options.backend)).toEqual(['browser']); expect(browser.requests).toEqual([]);
  });

  it('requests the same-topic search when an older ego-only call has not registered a query', async () => {
    const { world, browser, requests, tool, host } = await fixture(); await world.sleep();
    browser.failure = { error: 'Human interaction is required.', code: 'EGO_TASK_SPACE_USER_IN_CONTROL', uncertain: false };
    const cursor = host.store.latestCursor();
    expect(await tool('dream_ego_open', { url: 'https://news.example.org' })).toMatchObject({ needsSearch: true, nextBackend: 'tavily' });
    expect(requests).toEqual([]);
    expect(host.store.range({ source: 'dream', fromCursor: cursor + 1 }).map(event => event.type)).toEqual(['dream.requested']);
    expect((await tool('dream_search', { query: 'observatory opening today' })).sources).toHaveLength(1);
    expect(requests[0].query).toBe('observatory opening today');
  });

  it('uses the persistent alarm topic when a daydream browser call needs fallback', async () => {
    const { world, context, browser, requests, tool, setNow } = await fixture();
    context.cfg.daydreamEnabled = true;
    await world.webUi().invoke!('dream', 'saveDaydreamAlarm', [{ time: '12:01', topic: 'Public observatory news' }]);
    setNow('2026-10-24T12:01:00Z'); await world.tick();
    browser.failure = { error: 'Browser unavailable', code: 'EGO_BROWSER_UNAVAILABLE', uncertain: false };
    const result = await tool('dream_ego_open', { url: 'https://news.example.org' });
    expect(result.backend).toBe('tavily'); expect(requests[0].query).toBe('Public observatory news');
    expect(world.state()).toMatchObject({ sleeping: false, dreamKind: 'daydream' });
  });

  it('finishes an exhausted dream without waking, processing materials or requesting human recovery', async () => {
    const { world, browser, requests, tool, host } = await fixture(undefined, async () => []);
    await world.webUi().invoke!('dream', 'addMaterial', ['Public topic']); await world.sleep(10);
    const before = world.state();
    browser.failure = { error: 'Please restore access manually.', code: 'EGO_TASK_SPACE_USER_IN_CONTROL', uncertain: false };
    const result = await tool('dream_search', { query: 'public news', materialId: before.materials[0].id });
    expect(result).toMatchObject({ skipped: true, exhausted: true, backend: null, sources: [] });
    expect(result.attempts.map((item: { backend: string }) => item.backend)).toEqual(['ego', 'tavily', 'browser']);
    expect(world.state()).toMatchObject({ sleeping: true, sleepUntil: before.sleepUntil, dreaming: false, dreams: [], quota: { dailyUsed: 0 } });
    expect(world.state().materials[0].lastProcessedDate).toBeNull(); expect(requests).toHaveLength(2);
    expect(JSON.stringify(result)).not.toMatch(/restore access|Please|resume/i);
    expect(host.store.range({ source: 'dream' }).filter(event => event.type === 'dream.woke')).toEqual([]);
  });

  it('preserves accepted sources when later methods are exhausted', async () => {
    const { world, browser, tool } = await fixture(['ego', 'browser'], async () => []); await world.sleep();
    await tool('dream_search', { query: 'public news' });
    const page = (await tool('dream_ego_open', { url: 'https://news.example.org/observatory' })).value.page;
    const first = await tool('dream_ego_read', { page }); browser.ownership = 'user';
    const exhausted = await tool('dream_ego_read', { page });
    expect(exhausted).toMatchObject({ exhausted: true, skipped: false, sources: [{ id: first.source.id }] });
    expect(world.state()).toMatchObject({ dreaming: true, activeBackend: null, quota: { cycleUsed: 1, dailyUsed: 1 } });
    expect((await tool('dream_record', { title: 'A cloudy observatory', text: 'An observatory floated among clouds.', sourceIds: [first.source.id] })).sources).toHaveLength(1);
  });

  it('shares URL deduplication and collection limits across backend transitions', async () => {
    const { world, context, browser, tool, requests } = await fixture(['ego', 'tavily'], async () => [news(), news('moon')]);
    context.cfg.maxSourcesPerDream = 2; await world.sleep(); await tool('dream_search', { query: 'public news' });
    const page = (await tool('dream_ego_open', { url: `${news().url}#lead` })).value.page;
    const first = await tool('dream_ego_read', { page }); browser.ownership = 'user';
    const next = await tool('dream_ego_read', { page });
    expect(next.sources[0].id).toBe(first.source.id); expect(next.sources).toHaveLength(2);
    expect(next.quota).toMatchObject({ cycleUsed: 2, dailyUsed: 2, remaining: 0 });
    expect(requests[0].options.maxResults).toBe(1);
    await expect(tool('dream_search', { query: 'public news' })).rejects.toThrow('collection limit');
    expect(requests).toHaveLength(1);
  });

  it('keeps explicit empty selection disabled and does not start collection', async () => {
    const { world, context, browser, requests, host } = await fixture([]); await world.sleep(10);
    expect(context.cfg.collectorOrder).toEqual([]); expect(world.state()).toMatchObject({ sleeping: true, dreaming: false });
    expect(requests).toEqual([]); expect(browser.requests).toEqual([]);
    expect(host.store.range({ source: 'dream' }).filter(event => event.type === 'dream.requested')).toEqual([]);
  });
});

describe('fallback boundaries', () => {
  it('does not create a cycle with the old selection while saving waits for cancelled collection', async () => {
    const { world, context, browser, requests, tool } = await fixture(); await world.sleep(10);
    await tool('dream_search', { query: 'public news' });
    const page = (await tool('dream_ego_open', { url: 'https://news.example.org' })).value.page;
    const pending = browser.hold('read'); const reading = tool('dream_ego_read', { page });
    const rejected = expect(reading).rejects.toThrow(); await pending.entered;
    const saving = world.webUi().invoke!('dream', 'saveCollectorConfig', [{ collectorOrder: ['browser'] }]);
    await world.sleep(20);
    expect(world.state()).toMatchObject({ sleeping: true, dreaming: false });
    const sleepUntil = world.state().sleepUntil;
    pending.release(); await saving; await rejected;
    expect(context.cfg.collectorOrder).toEqual(['browser']);
    expect(world.state()).toMatchObject({ sleepUntil, dreaming: false }); expect(requests).toEqual([]);
    await world.sleep(20); expect(world.state()).toMatchObject({ dreaming: true, activeBackend: 'browser' });
  });

  it.each(['abort', 'wake', 'stop', 'configuration', 'deadline'] as const)('does not continue after %s during a failed browser operation', async action => {
    const { world, browser, requests, tool, setNow } = await fixture(); await world.sleep(10);
    await tool('dream_search', { query: 'public news' });
    const page = (await tool('dream_ego_open', { url: 'https://news.example.org' })).value.page;
    const pending = browser.hold('read'); const controller = new AbortController();
    const reading = tool('dream_ego_read', { page }, controller.signal); const rejected = expect(reading).rejects.toThrow();
    await pending.entered;
    browser.failure = { error: 'Browser blocked', code: 'EGO_TASK_SPACE_USER_IN_CONTROL', uncertain: false };
    let changing: Promise<unknown> | undefined;
    if (action === 'abort') controller.abort();
    if (action === 'wake') changing = world.wake();
    if (action === 'stop') changing = world.stop();
    if (action === 'configuration') changing = world.webUi().invoke!('dream', 'saveCollectorConfig', [{ collectorOrder: ['browser'] }]);
    if (action === 'deadline') setNow('2026-10-24T13:00:00Z');
    pending.release(); await changing; await rejected;
    expect(requests).toEqual([]); expect(world.state().quota.dailyUsed).toBe(0);
  });

  it('does not interpret invalid tool arguments as backend failure', async () => {
    const { world, browser, requests, tool } = await fixture(); await world.sleep();
    await expect(tool('dream_search', { query: '', materialId: 'missing' })).rejects.toThrow('query');
    await expect(tool('dream_search', { query: 'public news', materialId: 'missing' })).rejects.toThrow('material');
    const invalid = await tool('dream_ego_open', { url: 'file:///private/fixture' });
    expect(invalid.code).toBe('EGO_INVALID_ARGUMENTS');
    expect(world.state().activeBackend).toBe('ego'); expect(world.state().collection.attempts).toEqual([]);
    expect(requests).toEqual([]); expect(browser.requests).toEqual([]);
  });

  it('does not continue to another backend when source accounting cannot be saved', async () => {
    const { world, context, requests, tool } = await fixture(['tavily', 'browser']); await world.sleep();
    const archiveFile = join(context.dataDir, 'dream', 'archive.json'); rmSync(archiveFile); mkdirSync(archiveFile);
    await expect(tool('dream_search', { query: 'public news' })).rejects.toThrow();
    expect(requests.map(request => request.options.backend)).toEqual(['tavily']);
    expect(world.state()).toMatchObject({ dreaming: true, activeBackend: 'tavily', quota: { cycleUsed: 0, dailyUsed: 0 }, collection: { attempts: [] } });
    rmSync(archiveFile, { recursive: true });
  });

  it('tests only the configured first selection without attempting fallback or changing order', async () => {
    const { world, context, browser, requests } = await fixture();
    browser.failure = { error: 'Browser unavailable', code: 'EGO_BROWSER_UNAVAILABLE', uncertain: false };
    await world.webUi().invoke!('dream', 'testConnection', []);
    expect(world.state().connectionTest).toMatchObject({ backend: 'ego', status: 'error' });
    expect(context.cfg.collectorOrder).toEqual(['ego', 'tavily', 'browser']); expect(requests).toEqual([]);
    expect(world.state().quota.dailyUsed).toBe(0);
  });
});

describe('collection selection migration', () => {
  it.each([
    { backend: 'auto', egoEnabled: false, expected: ['tavily'] },
    { backend: 'auto', egoEnabled: true, expected: ['ego', 'tavily'] },
    { backend: 'ego', egoEnabled: true, expected: ['ego'] },
    { backend: 'ego', egoEnabled: false, expected: [] },
    { backend: 'browser', egoEnabled: true, expected: ['browser'] },
  ])('migrates the legacy selection once: $backend / $egoEnabled', async ({ backend, egoEnabled, expected }) => {
    const dir = mkdtempSync(join(tmpdir(), 'dream-migration-'));
    const context = fakeWorldContext(DREAM, { scratchDir: dir });
    Object.assign(context.cfg, { backend, egoEnabled, collectorOrder: null });
    const create = () => new DreamWorld({ context, search: { async search() { return []; }, async close() {} } });
    const first = create(); expect(context.cfg.collectorOrder).toEqual(expected);
    context.cfg.backend = 'auto'; context.cfg.egoEnabled = !egoEnabled;
    const second = create(); expect(context.cfg.collectorOrder).toEqual(expected);
    await first.stop(); await second.stop(); rmSync(dir, { recursive: true, force: true });
  });
});

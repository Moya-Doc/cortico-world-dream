import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { DREAM } from '../src/definition.ts';
import { DreamArchive } from '../src/archive.ts';
import type { CollectionBackend } from '../src/config.ts';
import { createSearchClient, type SearchClient, type SearchOptions, type SearchResult } from '../src/search.ts';
import { DreamWorld } from '../src/world.ts';
import { strings } from '../src/strings.ts';
import { BrowserFixture } from './helpers/ego-bridge.ts';
import { RealHost } from './helpers/real-host.ts';

const news = (name = 'observatory'): SearchResult => ({ title: name, url: `https://news.example.org/${name}`, content: `Public report about ${name}.` });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(order: CollectionBackend[] = ['websearch'], search?: SearchClient['search']) {
  const dir = mkdtempSync(join(tmpdir(), 'dream-official-search-'));
  const context = { ...fakeWorldContext(DREAM, { scratchDir: dir }), timezone: 'UTC' };
  context.cfg.collectorOrder = order; context.secret = () => 'fixture-key';
  const browser = new BrowserFixture(); const host = new RealHost(dir);
  let now = Date.parse('2026-10-27T12:00:00Z');
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

describe('agent-mediated official WebSearch', () => {
  it('hands collection to Coo, registers its reported sources, and saves their provenance', async () => {
    const { world, context, browser, requests, tool } = await fixture();
    await world.webUi().invoke!('dream', 'addMaterial', ['Public observatories']); await world.sleep(10);
    const { cycleId, sleepUntil, materials } = world.state();
    const materialId = materials[0].id;
    const request = await tool('dream_search', { query: 'observatories today', materialId });
    expect(request).toMatchObject({ backend: 'websearch', needsWebSearch: true, tool: 'web_search', query: 'observatories today', sources: [] });
    expect(request.requestId).toBeTruthy(); expect(world.state().phase).toBe('waiting');
    expect(world.state().materials[0].lastProcessedDate).toBeNull();
    expect(world.state().collection.lastSuccessAt).toBeNull(); expect(world.state().quota.dailyUsed).toBe(0);
    const registered = await tool('dream_web_search_result', { requestId: request.requestId, sources: [news()] });
    expect(registered.sources[0]).toMatchObject({ ...news(), provenance: { tool: 'web_search', reportedBy: 'model' } });
    expect(registered.quota).toMatchObject({ cycleUsed: 1, dailyUsed: 1 });
    expect(world.state()).toMatchObject({ cycleId, sleepUntil, phase: 'generating' });
    expect(world.state().materials[0].lastProcessedDate).toBe(world.state().date);
    await expect(tool('dream_record', { title: 'Cloud telescope', text: 'A fictional dream.', sourceIds: ['invented-id'] })).rejects.toThrow('Use source ids');
    const saved = await tool('dream_record', { title: 'Cloud telescope', text: 'A fictional dream.', sourceIds: [registered.sources[0].id] });
    const archived = new DreamArchive(join(context.dataDir, 'dream')).get(saved.id)!;
    expect(archived.materialIds).toEqual([materialId]);
    expect(archived.sources[0].provenance).toEqual({ tool: 'web_search', reportedBy: 'model' });
    expect(await tool('dream_read', { id: saved.id })).toEqual(archived);
    expect(world.state().sleepUntil).toBe(sleepUntil);
    expect(requests).toEqual([]); expect(browser.requests).toEqual([]);
  });

  it.each(['unavailable', 'failed', 'empty'])('advances a reported %s result to the next selected backend on the same theme', async failure => {
    const { world, requests, tool } = await fixture(['websearch', 'tavily']);
    await world.sleep(); const { cycleId, sleepUntil } = world.state();
    const request = await tool('dream_search', { query: 'observatories today' });
    const result = await tool('dream_web_search_result', { requestId: request.requestId, failure });
    expect(result).toMatchObject({ backend: 'tavily', sources: [news()], attempts: [{ backend: 'websearch' }] });
    expect(result.attempts[0].reason).toContain('Coo reported');
    expect(requests.map(item => [item.options.backend, item.query])).toEqual([['tavily', 'observatories today']]);
    expect(world.state()).toMatchObject({ cycleId, sleepUntil, dreaming: true, quota: { cycleUsed: 1 } });
    await expect(tool('dream_web_search_result', { requestId: request.requestId, sources: [news()] })).rejects.toThrow('not using official WebSearch');
  });

  it('can receive a fallback from ego and hand failure on to another selected method', async () => {
    const { world, browser, requests, tool } = await fixture(['ego', 'websearch', 'browser']);
    await world.sleep();
    browser.failure = { code: 'EGO_TASK_SPACE_USER_IN_CONTROL', error: 'Human control is active.', uncertain: false };
    const request = await tool('dream_search', { query: 'observatories today' });
    expect(request).toMatchObject({ backend: 'websearch', needsWebSearch: true, attempts: [{ backend: 'ego' }] });
    const result = await tool('dream_web_search_result', { requestId: request.requestId, failure: 'failed' });
    expect(result).toMatchObject({ backend: 'browser', attempts: [{ backend: 'ego' }, { backend: 'websearch' }] });
    expect(requests.map(item => item.options.backend)).toEqual(['browser']);
  });

  it('skips an exhausted dream without recording sources or marking its designated material', async () => {
    const { world, tool } = await fixture();
    await world.webUi().invoke!('dream', 'addMaterial', ['Public observatories']); await world.sleep();
    const materialId = world.state().materials[0].id;
    const request = await tool('dream_search', { query: 'observatories today', materialId });
    expect(await tool('dream_web_search_result', { requestId: request.requestId, failure: 'unavailable' })).toMatchObject({ skipped: true, exhausted: true, sources: [] });
    expect(world.state()).toMatchObject({ dreaming: false, sleeping: true, dreams: [], quota: { dailyUsed: 0 } });
    expect(world.state().materials[0].lastProcessedDate).toBeNull();
  });

  it('deduplicates URLs, caps registration at the dream quota and carries the daily count across dreams', async () => {
    const { world, context, tool } = await fixture();
    context.cfg.maxSourcesPerDream = 2; context.cfg.maxSourcesPerDay = 3;
    await world.sleep();
    const first = await tool('dream_search', { query: 'observatories today' });
    const a = news('one');
    const result = await tool('dream_web_search_result', { requestId: first.requestId,
      sources: [a, { ...a, url: `${a.url}#details`, content: 'Another public snippet.' }, news('two'), news('three')] });
    expect(result.sources).toHaveLength(2); expect(result.quota).toMatchObject({ cycleUsed: 2, dailyUsed: 2, remaining: 0 });
    await tool('dream_record', { title: 'Cloud telescope', text: 'A fictional dream.', sourceIds: result.sources.map((source: { id: string }) => source.id) });
    await world.wake(); await world.sleep();
    const second = await tool('dream_search', { query: 'observatories today' });
    expect(second.quota.remaining).toBe(1);
    const last = await tool('dream_web_search_result', { requestId: second.requestId, sources: [news('three'), news('four')] });
    expect(last.sources).toHaveLength(1); expect(last.quota).toMatchObject({ cycleUsed: 1, dailyUsed: 3, remaining: 0 });
    expect(new DreamArchive(join(context.dataDir, 'dream')).collectionCount(world.state().date)).toBe(3);
  });

  it('rejects reports before a request, after supersession or reuse, and after waking', async () => {
    const { world, tool } = await fixture(); await world.sleep();
    await expect(tool('dream_web_search_result', { sources: [news()] })).rejects.toThrow('current requestId');
    const old = await tool('dream_search', { query: 'observatories today' });
    const request = await tool('dream_search', { query: 'observatories research today' });
    await expect(tool('dream_web_search_result', { requestId: old.requestId, sources: [news()] })).rejects.toThrow('current requestId');
    await tool('dream_web_search_result', { requestId: request.requestId, sources: [news()] });
    await expect(tool('dream_web_search_result', { requestId: request.requestId, sources: [news()] })).rejects.toThrow('current requestId');
    const pending = await tool('dream_search', { query: 'observatories research today' }); const cycleId = world.state().cycleId;
    await world.wake();
    await expect(tool('dream_web_search_result', { cycleId, requestId: pending.requestId, sources: [news('late')] })).rejects.toThrow('no longer active');
    expect(world.state().quota.dailyUsed).toBe(1);
  });

  it('rejects late reports at the dream deadline without accounting for sources', async () => {
    const { world, tool, setNow } = await fixture(); await world.sleep();
    const request = await tool('dream_search', { query: 'observatories today' }); const cycleId = world.state().cycleId;
    setNow('2026-10-27T12:06:00Z');
    await expect(tool('dream_web_search_result', { cycleId, requestId: request.requestId, sources: [news()] })).rejects.toThrow('no longer active');
    expect(world.state().quota.dailyUsed).toBe(0); expect(world.state().sleeping).toBe(true);
  });

  it.each([
    { sources: [] }, { sources: [news()], failure: 'failed' }, { failure: 'unknown' }, { sources: [{ ...news(), content: ' ' }] },
    { sources: [{ ...news(), url: 'file:///private/item' }] }, { sources: [{ ...news(), url: 'https://127.0.0.1/item' }] },
    { sources: [{ ...news(), url: 'https://news.local/item' }] }, { sources: [{ ...news(), url: 'https://user:secret@news.example.org/item' }] },
    { sources: [{ ...news(), content: 'x'.repeat(12001) }] }, { sources: Array.from({ length: 21 }, () => news()) },
  ])('rejects malformed reports without consuming their request or quota', async report => {
    const { world, tool } = await fixture(); await world.sleep();
    const request = await tool('dream_search', { query: 'observatories today' });
    await expect(tool('dream_web_search_result', { requestId: request.requestId, ...report })).rejects.toThrow();
    expect(world.state().quota.dailyUsed).toBe(0);
    expect((await tool('dream_web_search_result', { requestId: request.requestId, sources: [news()] })).sources).toHaveLength(1);
  });

  it('returns an explicit agent-required test result without opening a browser or running a search', async () => {
    const { world, browser, requests, host } = await fixture(); const before = host.store.latestCursor();
    const result = await world.webUi('en').invoke!('collection-settings', 'testConnection', []) as ReturnType<DreamWorld['state']>;
    expect(result.connectionTest).toMatchObject({ status: 'error', backend: 'websearch', error: strings('en').webSearchTestUnsupported, resultCount: null });
    expect(world.state().quota.dailyUsed).toBe(0); expect(world.state().dreams).toEqual([]);
    expect(requests).toEqual([]); expect(browser.requests).toEqual([]); expect(host.store.latestCursor()).toBe(before);
  });

  it('rejects direct built-in SearchClient use for official WebSearch', async () => {
    const client = createSearchClient(() => ({ backend: 'websearch', apiKey: '', maxResults: 1, timeoutMs: 1000 }));
    try { await expect(client.search('public news', new AbortController().signal)).rejects.toThrow('must be called by Coo'); }
    finally { await client.close(); }
  });
});

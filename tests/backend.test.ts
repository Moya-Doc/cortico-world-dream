import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import type { ToolCallContext, ToolOutcome } from 'cortico/core/types.ts';
import { DREAM } from '../src/definition.ts';
import { DREAM_SECRET } from '../src/config.ts';
import { DreamWorld } from '../src/world.ts';
import { RealHost } from './helpers/real-host.ts';
import { BrowserFixture } from './helpers/ego-bridge.ts';

let dir: string;
let context: ReturnType<typeof fakeWorldContext<ReturnType<typeof DREAM.defaults>>>;
let world: DreamWorld;
let browser: BrowserFixture;
let host: RealHost;
let key = '';
let apiRequests = 0;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dream-backend-'));
  context = fakeWorldContext(DREAM, { scratchDir: dir });
  key = ''; apiRequests = 0; browser = new BrowserFixture(); host = new RealHost(dir);
  context.secret = name => name === DREAM_SECRET ? key : '';
  context.storeSecret = (name, value) => { if (name === DREAM_SECRET) key = value; };
  world = new DreamWorld({ context, egoBridge: browser, pollMs: 100000 });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url !== 'https://api.tavily.com/search' || new Headers(init.headers).get('Authorization') !== 'Bearer fixture-key') throw new Error('Unexpected request');
    apiRequests++;
    return Response.json({ results: [{ title: 'API fixture', url: 'https://news.example.org/item', content: 'Public fixture news.' }] });
  });
});
afterEach(async () => {
  browser.pending?.release(); await world.stop(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true });
});
async function start(ego = false) {
  context.cfg.collectorOrder = ego ? ['ego', 'tavily'] : ['tavily']; await world.start(host); await world.sleep();
}
async function rawTool(name: string, args: Record<string, unknown> = {}) {
  return world.tools().find(tool => tool.name === name)!.handler({ cycleId: world.state().cycleId, ...args }, {} as ToolCallContext);
}
async function tool(name: string, args: Record<string, unknown> = {}) {
  const result = await rawTool(name, args); return JSON.parse(typeof result === 'string' ? result : result.text);
}
async function page() { return (await tool('dream_ego_open', { url: 'https://news.example.org/current' })).value.page as string; }

describe('backend selection and connection tests', () => {
  it('uses Tavily in auto mode while ego is disabled, even with the default command available', async () => {
    key = 'fixture-key'; await start();
    expect(world.state().activeBackend).toBe('tavily');
    expect((await tool('dream_search', { query: 'public news' })).sources[0].title).toBe('API fixture');
    expect(browser.requests).toEqual([]); expect(apiRequests).toBe(1);
  });
  it('prefers enabled ego and returns source ids through interactive reads rather than a fixed URL', async () => {
    key = 'fixture-key'; context.cfg.searchUrlTemplate = ''; context.cfg.allowedDomains = '';
    await start(true); const label = await page();
    const read = await tool('dream_ego_read', { page: label });
    expect(read.source).toMatchObject({ title: 'Public fixture', url: 'https://news.example.org/current' });
    expect(read.source.id).toBeTruthy(); expect(apiRequests).toBe(0);
    expect(world.state().activeBackend).toBe('ego');
    expect(await tool('dream_search', { query: 'public news' })).toMatchObject({ needsBrowser: true, backend: 'ego', sources: [] });
    expect(browser.requests.some(request => 'profileId' in request.args)).toBe(false);
    expect(JSON.stringify(world.state())).not.toContain('fixture-key');
  });
  it.each(['ego', 'tavily', 'browser'] as const)('preserves explicit %s selection', backend => {
    key = 'fixture-key'; context.cfg.collectorOrder = [backend]; expect(world.state().activeBackend).toBe(backend);
  });
  it('tests ego directly without a page visit, Coo call, archive record or material processing', async () => {
    await start(true); await world.webUi().invoke!('dream', 'addMaterial', ['Public designated topic']);
    const before = world.state(); const cursor = host.store.latestCursor();
    const after = await world.webUi().invoke!('dream', 'testConnection', []) as ReturnType<DreamWorld['state']>;
    expect(after.connectionTest).toMatchObject({ status: 'ok', backend: 'ego', resultCount: null });
    expect(browser.requests.map(request => request.operation)).toEqual(['connect']);
    expect(after.materials).toEqual(before.materials); expect(after.dreams).toEqual([]);
    expect(after.collection.lastSuccessAt).toBeNull(); expect(host.store.latestCursor()).toBe(cursor);
  });
  it('advances failed ego operations to a selected backend without guessing a query', async () => {
    key = 'fixture-key'; await start(true);
    browser.failure = { error: 'Unavailable', code: 'EGO_BROWSER_UNAVAILABLE', uncertain: false };
    expect(await tool('dream_ego_open', { url: 'https://news.example.org' })).toMatchObject({ needsSearch: true, nextBackend: 'tavily' });
    expect(apiRequests).toBe(0); expect(world.state().activeBackend).toBe('tavily');
  });
});

describe('interactive dream materials', () => {
  it('records only successful reads, marks designated materials once read and saves their source references', async () => {
    await start(true);
    const state = await world.webUi().invoke!('dream', 'addMaterial', ['Public topic']) as ReturnType<DreamWorld['state']>;
    const materialId = state.materials[0].id; const label = await page();
    await tool('dream_ego_fill', { page: label, selector: '@1', text: 'Public topic' });
    const search = await tool('dream_ego_press', { page: label, selector: '@1', key: 'Enter' });
    expect(search.value.snapshot).toContain('Public search results');
    expect(world.state().collection.lastSuccessAt).toBeNull();
    expect(world.state().materials[0].lastProcessedDate).toBeNull();
    const read = await tool('dream_ego_read', { page: label, materialId });
    expect(world.state().materials[0].lastProcessedDate).toBe(world.state().date);
    expect(world.state().phase).toBe('generating');
    await tool('dream_record', { title: 'A floating observatory', text: 'A fictional dream.', sourceIds: [read.source.id] });
    expect(world.state().dreams[0]).toMatchObject({ text: 'A fictional dream.', materialIds: [materialId], sources: [{ url: 'https://news.example.org/current' }] });
    await expect(tool('dream_ego_read', { page: label })).rejects.toThrow('no longer active');
  });
  it('keeps the current dream on the next backend when ego returns control after handoff', async () => {
    vi.useFakeTimers();
    try {
      key = 'fixture-key'; await start(true); await page(); const cycleId = world.state().cycleId;
      await tool('dream_ego_handoff');
      expect(world.state().egoConnection.halted).toBe(true);
      const cursor = host.store.latestCursor();
      browser.ownership = 'agent';
      await vi.advanceTimersByTimeAsync(2000);
      await vi.waitFor(() => expect(world.state().egoConnection.halted).toBe(false));
      expect(world.state()).toMatchObject({ cycleId, dreaming: true, egoConnection: { connected: true, halted: false } });
      expect(host.store.latestCursor()).toBe(cursor);
      expect(world.state().activeBackend).toBe('tavily');
      expect((await tool('dream_search', { query: 'Public topic' })).sources[0].id).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });
  it('does not mark designated material for an empty or failed read', async () => {
    await start(true); const label = await page();
    await world.webUi().invoke!('dream', 'addMaterial', ['Public topic']);
    const materialId = world.state().materials[0].id;
    browser.pages.get(label)!.snapshot = '';
    expect((await tool('dream_ego_read', { page: label, materialId })).source).toBeUndefined();
    expect(world.state().materials[0].lastProcessedDate).toBeNull();
    browser.failure = { error: 'Read failed', code: 'EGO_OPERATION_FAILED', uncertain: false };
    expect(await tool('dream_ego_read', { page: label, materialId })).toMatchObject({ skipped: true, sources: [] });
    expect(world.state().materials[0].lastProcessedDate).toBeNull();
  });
  it('does not commit a late read after waking and blocks new operations on the cancelled cycle', async () => {
    await start(true); const label = await page(); const cycleId = world.state().cycleId;
    const pending = browser.hold('read');
    const reading = rawTool('dream_ego_read', { page: label }); const rejected = expect(reading).rejects.toThrow();
    await pending.entered; const waking = world.wake(); pending.release(); await waking; await rejected;
    expect(world.state().collection.lastSuccessAt).toBeNull(); expect(world.state().dreams).toEqual([]);
    const requestCount = browser.requests.length;
    await expect(tool('dream_ego_click', { cycleId, page: label, selector: '@1' })).rejects.toThrow('no longer active');
    expect(browser.requests).toHaveLength(requestCount);
  });
  it('delivers page screenshots as attachments without storing image data in dream records', async () => {
    await start(true); const label = await page();
    const result = await rawTool('dream_ego_shot', { page: label }) as ToolOutcome;
    expect(result.blobs).toHaveLength(1); expect(result.blobs![0]).toMatchObject({ mime: 'image/png' });
    expect(result.text).not.toContain('base64'); expect(world.state().dreams).toEqual([]);
  });
  it('requires an active dream and the selected ego backend for all browser tools', async () => {
    await world.start(host); context.cfg.collectorOrder = ['ego'];
    await expect(tool('dream_ego_tabs')).rejects.toThrow('no longer active');
    key = 'fixture-key'; context.cfg.collectorOrder = ['tavily']; await world.sleep();
    await expect(tool('dream_ego_tabs')).rejects.toThrow('not using ego');
    expect(browser.requests).toEqual([]);
  });
});

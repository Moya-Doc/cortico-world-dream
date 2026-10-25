import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { renderWorldEnvPrompt } from 'cortico/core/prefix.ts';
import { DreamWorld } from '../src/world.ts';
import { DREAM } from '../src/definition.ts';
import { DREAM_DEFAULTS, DREAM_SECRET } from '../src/config.ts';
import { DreamArchive } from '../src/archive.ts';
import { localClock, sleepCommand } from '../src/time.ts';
import type { SearchClient } from '../src/search.ts';
import { RealHost } from './helpers/real-host.ts';

let dir: string;
let worlds: DreamWorld[];
let now: number;
let host: RealHost;
let context: ReturnType<typeof fakeWorldContext<ReturnType<typeof DREAM.defaults>>>;
const sample = { title: 'Public discovery', url: 'https://news.example.test/item', content: 'A public observation.' };
const call = {} as ToolCallContext;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dream-world-')); worlds = [];
  now = Date.parse('2026-10-24T01:00:00Z');
  host = new RealHost(dir); context = fakeWorldContext(DREAM, { scratchDir: dir });
  context.secret = () => 'fixture-key'; context.cfg.collectorOrder = ['tavily'];
  Object.defineProperty(context, 'timezone', { value: 'UTC' });
});
afterEach(async () => { for (const world of worlds) await world.stop(); rmSync(dir, { recursive: true, force: true }); });
function create(search: SearchClient = { search: async () => [sample], close: async () => {} }, random = () => 0): DreamWorld {
  const w = new DreamWorld({ context, now: () => now, random, search, pollMs: 100000 });
  worlds.push(w); return w;
}
async function tool(w: DreamWorld, name: string, args: Record<string, unknown> = {}, ctx = call) {
  return JSON.parse(await w.tools().find(t => t.name === name)!.handler(args, ctx) as string);
}
async function message(body: string, source = 'desktop-pet', user = '7', group = false) {
  return host.pushEvent({ source, type: `${source}.message`, senderKey: user, origin: source === 'console' ? 'internal' : 'external', ts: new Date(now).toISOString(),
    text: source === 'qq' ? `#1 [test 01:00] User(${user}): ${body}` : body,
    meta: source === 'qq' ? { user_id: Number(user), conv: { kind: group ? 'group' : 'private' } } : { text: body, body },
  });
}
async function collect(w: DreamWorld, materialId?: string) {
  return tool(w, 'dream_search', { cycleId: w.state().cycleId, query: 'public topic', ...(materialId ? { materialId } : {}) });
}

describe('Dream World contract', () => {
  it('dry mounts with defaults, localized config and all described tools', async () => {
    expect((await dryMountWorld(DREAM, { scratchDir: dir, hasWebUiClient: true })).failures).toEqual([]);
    expect(DREAM.defaults()).toEqual(DREAM_DEFAULTS);
    expect(create().tools().map(t => t.name)).toEqual(DREAM.describe!.tools.map(t => t.name));
  });
  it('starts sleep from a console command and restores activity at its deadline', async () => {
    const w = create(); await w.start(host); await message('睡觉十分钟', 'console'); await w.tick();
    expect(w.state().sleepUntil).toBe(new Date(now + 600000).toISOString());
    expect(w.state().dreaming).toBe(true);
    now += 600000; await w.tick(); expect(w.state().sleeping).toBe(false); expect(w.state().dreaming).toBe(false);
    expect(host.store.range({ source: 'dream' }).map(e => e.type)).toEqual(['dream.sleeping', 'dream.requested', 'dream.woke']);
  });
  it('applies a model-interpreted explicit sleep request once without returning archive bodies', async () => {
    const w = create(); await w.start(host);
    const m = await message('Coo，请休息十七分钟');
    const result = await tool(w, 'dream_sleep', { eventCursor: m.cursor, durationMinutes: 17 });
    expect(result.sleepUntil).toBe(new Date(now + 17 * 60000).toISOString());
    expect(result).not.toHaveProperty('dreams');
    await w.tick(); expect(w.state().sleeping).toBe(true);
  });
  it('does not reroll probability during the same sleep', async () => {
    context.cfg.dreamMode = 'probability'; context.cfg.dreamProbability = 0.5;
    const w = create(undefined, () => 0.8); await w.start(host); const m = await message('sleep 10 minutes'); await w.tick();
    expect(w.state().dreaming).toBe(false);
    await tool(w, 'dream_sleep', { eventCursor: m.cursor }); await w.tick();
    expect(w.state().sleeping).toBe(true); expect(w.state().dreaming).toBe(false);
    expect(host.store.range({ source: 'dream' })).toHaveLength(1);
  });
  it('an ordinary message wakes and an old sleep command cannot restart sleep', async () => {
    const w = create(); await w.start(host); const m = await message('睡觉'); await w.tick();
    await message('hello'); await w.tick(); expect(w.state().sleeping).toBe(false);
    await tool(w, 'dream_sleep', { eventCursor: m.cursor }); expect(w.state().sleeping).toBe(false);
  });
  it('requires QQ allowlist and direct message or a group self-mention', async () => {
    context.cfg.qqUsers = '7'; const w = create(); await w.start(host);
    await message('睡觉', 'qq', '8'); await w.tick(); expect(w.state().sleeping).toBe(false);
    await message('睡觉', 'qq', '7', true); await w.tick(); expect(w.state().sleeping).toBe(false);
    await message('@Coo Bot(你) 睡觉', 'qq', '7', true); await w.tick(); expect(w.state().sleeping).toBe(true);
    await message('醒来', 'qq', '8'); await w.tick(); expect(w.state().sleeping).toBe(true);
    await message('hello', 'qq', '7'); await w.tick(); expect(w.state().sleeping).toBe(true);
    await message('醒来', 'qq', '7'); await w.tick(); expect(w.state().sleeping).toBe(false);
  });
  it('rejects forged, old and sleep-message wake cursors', async () => {
    const w = create(); await w.start(host); const old = await message('hello'); await w.tick();
    const m = await message('睡觉'); await w.tick();
    await tool(w, 'dream_wake', { eventCursor: old.cursor }); expect(w.state().sleeping).toBe(true);
    await expect(tool(w, 'dream_wake', { eventCursor: m.cursor })).rejects.toThrow('sleep command');
    const unauth = await message('醒来', 'qq', '8'); await expect(tool(w, 'dream_wake', { eventCursor: unauth.cursor })).rejects.toThrow('authorized');
    await expect(tool(w, 'dream_wake', { eventCursor: 1000 })).rejects.toThrow();
  });
  it('idle sleep counts physical interaction as activity', async () => {
    context.cfg.idleEnabled = true; context.cfg.idleMinutes = 1; const w = create(); await w.start(host);
    now += 59000; await host.pushEvent({ source: 'desktop-pet', type: 'desktop-pet.touch', senderKey: 'body', origin: 'external', text: 'touch', ts: new Date(now).toISOString() });
    await w.tick(); now += 2000; await w.tick(); expect(w.state().sleeping).toBe(false);
    now += 59000; await w.tick(); expect(w.state().sleeping).toBe(true);
  });
  it('scheduled daydream runs once per local day without sleep and persists its slot', async () => {
    context.cfg.daydreamEnabled = true; const w = create();
    await w.webUi().invoke!('dream', 'saveDaydreamAlarm', [{ time: '01:00', topic: 'Public discoveries' }]);
    await w.start(host); await w.tick();
    expect(w.state().dreaming).toBe(true); expect(w.state().sleeping).toBe(false);
    await w.wake(); await w.tick(); expect(w.state().dreaming).toBe(false); await w.stop();
    const restarted = create(); await restarted.start(host); await restarted.tick(); expect(restarted.state().dreaming).toBe(false);
    now += 86400000; await restarted.tick(); expect(restarted.state().dreaming).toBe(true);
  });
  it('resumes sleep without rerolling or restarting dream on restart', async () => {
    const w = create(); await w.start(host); await w.sleep(10); await w.stop();
    const restarted = create(); await restarted.start(host); expect(restarted.state().sleeping).toBe(true); expect(restarted.state().dreaming).toBe(false);
    await restarted.stop(); now += 600001; const expired = create(); await expired.start(host); expect(expired.state().sleeping).toBe(false);
    expect(host.store.range({ source: 'dream' }).at(-1)?.type).toBe('dream.woke');
  });
  it('retains designated materials and changes their local processing day only after success', async () => {
    let result = false;
    const w = create({ search: async () => result ? [sample] : [], close: async () => {} }); await w.start(host);
    const panel = w.webUi().invoke!; await panel('dream', 'addMaterial', ['Public topic']); const material = w.state().materials[0];
    await w.sleep(); await collect(w, material.id); expect(w.state().materials[0].lastProcessedDate).toBeNull();
    result = true; await w.sleep(); await collect(w, material.id); expect(w.state().materials[0].lastProcessedDate).toBe(w.state().date);
    await w.stop(); const restarted = create(); expect(restarted.state().materials[0].tag).toBe('指定素材');
    expect(restarted.state().materials[0].lastProcessedDate).toBe('2026-10-24');
  });
  it.each([false, true])('saves one source-backed record per cycle without writing Memory or replying (legacy text window enabled: %s)', async legacy => {
    if (legacy) Object.assign(context.cfg, { overlayEnabled: true, overlayUrl: 'invalid', overlayElectronFile: '/missing/old-runtime' });
    const w = create(); await w.start(host); await w.sleep(); const cycleId = w.state().cycleId; const found = await collect(w);
    await expect(tool(w, 'dream_record', { cycleId, title: 'A floating observatory', text: 'A dream.', sourceIds: ['invented'] })).rejects.toThrow();
    const saved = await tool(w, 'dream_record', { cycleId, title: 'A floating observatory', text: 'A dream of a floating observatory.', sourceIds: [found.sources[0].id] });
    expect(w.state().sleeping).toBe(true); expect(w.state().dreaming).toBe(false); expect(w.state().error).toBeNull();
    await expect(tool(w, 'dream_record', { cycleId, title: 'A floating observatory', text: 'Another dream', sourceIds: [found.sources[0].id] })).rejects.toThrow('no longer active');
    expect(await tool(w, 'dream_read', { id: saved.id })).toEqual(saved);
    expect(await tool(w, 'dream_query', { query: 'observatory', date: '2026-10-24' })).toHaveLength(1);
    expect(readdirSync(join(context.botDir, 'memory'))).toEqual([]);
    expect(host.store.range({ source: 'dream' }).every(e => e.origin === 'internal')).toBe(true);
  });
  it('aborts pending retrieval and refuses late results after waking', async () => {
    let finish!: (value: typeof sample[]) => void; let signal!: AbortSignal;
    const w = create({ search: (_q, s) => { signal = s; return new Promise(r => { finish = r; }); }, close: async () => {} });
    await w.start(host); await w.sleep(); const pending = collect(w); const assertion = expect(pending).rejects.toThrow();
    await message('醒来'); await w.tick(); expect(signal.aborted).toBe(true); finish([sample]); await assertion;
    expect(w.state().dreams).toEqual([]);
  });
  it('does not commit a result when its caller cancelled but the backend returns late', async () => {
    const controller = new AbortController();
    const w = create({ search: async () => { controller.abort(); return [sample]; }, close: async () => {} });
    await w.start(host); await w.sleep(); await w.webUi().invoke!('dream', 'addMaterial', ['topic']);
    await expect(tool(w, 'dream_search', { cycleId: w.state().cycleId, query: 'topic', materialId: w.state().materials[0].id }, { signal: controller.signal } as ToolCallContext)).rejects.toThrow();
    expect(w.state().materials[0].lastProcessedDate).toBeNull();
  });
  it('key saving uses only framework secret storage and returns no key', async () => {
    const secrets = new Map<string, string>(); context.storeSecret = (k, v) => { secrets.set(k, v); }; context.secret = k => secrets.get(k) ?? '';
    const w = create(); const result = await w.webUi().invoke!('dream', 'saveKey', ['fixture-secret']);
    expect(result).toEqual({ keyConfigured: true }); expect(secrets.get(DREAM_SECRET)).toBe('fixture-secret');
    expect(JSON.stringify(w.state())).not.toContain('fixture-secret'); expect(w.webUi().panels![0].getMethods).not.toContain('saveKey');
  });
});

describe('dream environment index', () => {
  it('exposes an empty declared index without writing files', () => {
    const w = create();
    const archiveDir = join(context.dataDir, 'dream');
    const before = readFileSync(join(archiveDir, 'archive.json'), 'utf8');
    const files = readdirSync(archiveDir);
    expect(w.webUi().promptDocs![0].vars?.map(variable => variable.name)).toContain('dream.index');
    expect(JSON.parse(w.envPromptVars()['dream.index'])).toEqual([]);
    expect(readFileSync(join(archiveDir, 'archive.json'), 'utf8')).toBe(before);
    expect(readdirSync(archiveDir)).toEqual(files);
    expect(readdirSync(join(context.botDir, 'memory'))).toEqual([]);
  });

  it('includes only the latest ten ids, local dates and titles, preserving titles as JSON data', async () => {
    context = { ...context, timezone: 'Australia/Sydney' };
    const archive = new DreamArchive(join(context.dataDir, 'dream'));
    const records = Array.from({ length: 12 }, (_, index) => archive.append(`Body ${index} is not index content.`, [], [sample],
      Date.parse('2026-10-24T14:00:00Z') + index * 60000, index === 11 ? 'A "moon"\nbehind {{dream.state}} | clouds' : `Dream ${index}`));
    const w = create();
    const index = w.envPromptVars()['dream.index'];
    expect(JSON.parse(index)).toEqual(records.slice(-10).reverse().map(record => ({
      id: record.id, date: '2026-10-25', title: record.title,
    })));
    expect(index).not.toContain('\n');
    expect(index).not.toContain('Body ');
    expect(index).not.toContain(sample.content);
    expect(index).not.toContain(sample.url);
    const rendered = (await renderWorldEnvPrompt(w)).text;
    expect(rendered).toContain(index);
    expect(rendered).not.toContain('{{dream.index}}');
    expect(rendered).not.toContain('Body ');
    expect(rendered).not.toContain(sample.content);
    expect(rendered).not.toContain(sample.url);
  });

  it('regenerates after dream_record and deletion while dream_read keeps the complete record', async () => {
    const w = create(); await w.start(host); await w.sleep();
    const found = await collect(w);
    const saved = await tool(w, 'dream_record', { cycleId: w.state().cycleId, title: 'The moonlit station',
      text: 'A train carried constellations through a quiet station.', sourceIds: [found.sources[0].id] });
    const original = w.envPromptVars()['dream.index'];
    const previousPrompt = (await renderWorldEnvPrompt(w)).text;
    expect(JSON.parse(original)).toEqual([{ id: saved.id, date: '2026-10-24', title: saved.title }]);
    expect(await tool(w, 'dream_read', { id: saved.id })).toEqual(saved);
    await w.webUi().invoke!('dream', 'removeDream', [saved.id]);
    const archiveDir = join(context.dataDir, 'dream');
    const before = readFileSync(join(archiveDir, 'archive.json'), 'utf8');
    const files = readdirSync(archiveDir);
    expect(JSON.parse(w.envPromptVars()['dream.index'])).toEqual([]);
    expect(original).toContain(saved.id);
    expect(previousPrompt).toContain(saved.id);
    expect((await renderWorldEnvPrompt(w)).text).not.toContain(saved.id);
    expect(readFileSync(join(archiveDir, 'archive.json'), 'utf8')).toBe(before);
    expect(readdirSync(archiveDir)).toEqual(files);
    expect(readdirSync(join(context.botDir, 'memory'))).toEqual([]);
  });

  it('uses the existing legacy title fallback without rewriting old records', () => {
    const archiveDir = join(context.dataDir, 'dream');
    const archive = new DreamArchive(archiveDir);
    const record = archive.append('A silver river\nflowed through the sky.', [], [sample], now);
    const file = join(archiveDir, 'archive.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    delete data.dreams[0].title; delete data.dreams[0].titleSource; data.daydreamAlarmsMigrated = true;
    const stored = JSON.stringify(data); writeFileSync(file, stored);
    const w = create();
    expect(JSON.parse(w.envPromptVars()['dream.index'])).toEqual([{ id: record.id, date: '2026-10-24', title: record.title }]);
    expect(readFileSync(file, 'utf8')).toBe(stored);
  });
});

describe('archive and time', () => {
  it('returns detached records, survives reload and filters public content', () => {
    const a = new DreamArchive(join(dir, 'archive')); const m = a.add('Topic', now); m.topic = 'changed';
    expect(a.materials()[0].topic).toBe('Topic'); a.append('Flying train', [m.id], [sample], now);
    const b = new DreamArchive(a.dir); expect(b.query('discovery')).toHaveLength(1); expect(b.query('missing')).toEqual([]);
    expect(readFileSync(join(a.dir, 'archive.json'), 'utf8')).toContain('指定素材');
  });
  it('a failed save does not modify the in-memory archive', () => {
    const a = new DreamArchive(join(dir, 'archive')); a.add('Existing', now);
    rmSync(a.dir, { recursive: true }); writeFileSync(a.dir, 'blocked path');
    expect(() => a.add('Unsaved', now)).toThrow(); expect(a.materials().map(m => m.topic)).toEqual(['Existing']);
  });
  it.each([['睡觉', undefined], ['睡眠十分钟', 10], ['sleep 2 hours', 120], ['睡一小时', 60]])('parses %s', (text, minutes) => {
    expect(sleepCommand(text)).toEqual({ kind: 'sleep', ...(minutes ? { minutes } : {}) });
  });
  it('rejects invalid duration and computes date in the deployment timezone', () => {
    expect(sleepCommand('睡0分钟')).toBeNull(); expect(sleepCommand('sleep 5000 minutes')).toBeNull();
    expect(sleepCommand('醒来')).toEqual({ kind: 'wake' });
    expect(localClock(Date.parse('2026-10-24T23:00:00Z'), 'Australia/Sydney').day).toBe('2026-10-25');
  });
});

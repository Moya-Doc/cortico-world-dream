import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DREAM_DEFAULTS, type DreamConfigSection } from '../src/config.ts';
import { DreamEgoBrowser } from '../src/ego-browser.ts';
import { execute, publicBrowserUrl } from '../src/ego-runtime.mjs';
import type { BridgeReceipt, EgoBridge } from '../src/ego-transport/index.ts';

interface PageState { label: string; url: string; title: string; text: string; openedBy: string; fields: Record<string, string> }
interface SpaceState { id: number; name: string; ownership: string; pages: Map<string, PageState>; nextPage: number }
class BrowserFixture implements EgoBridge {
  spaces = new Map<number, SpaceState>();
  nextId = 1;
  operations: string[] = [];
  effects: string[] = [];
  screenshotBytes = Buffer.from('fixture-png');
  minimized = true;
  controlError?: string;
  hold?: { entered: Promise<void>; enter: () => void; operation: string };
  constructor(private readonly directory: string) {
    vi.stubGlobal('listTaskSpaces', async () => [...this.spaces.values()].map(({ id, name, ownership }) => ({ id, name, ownership })));
    vi.stubGlobal('taskSpace', async (identity: string | number) => {
      let space = typeof identity === 'number' ? this.spaces.get(identity) : [...this.spaces.values()].find(space => space.name === identity);
      if (!space && typeof identity === 'string') {
        space = { id: this.nextId++, name: identity, ownership: 'agent', pages: new Map(), nextPage: 1 };
        this.spaces.set(space.id, space); this.addPage(space, 'about:blank'); this.effects.push('create-space');
      }
      if (!space) throw Object.assign(new Error('private raw message'), { error_code: 'EGO_TASK_SPACE_NOT_FOUND' });
      if (space.ownership !== 'agent') throw Object.assign(new Error('private raw message'), { error_code: 'EGO_TASK_SPACE_USER_IN_CONTROL' });
      return this.task(space);
    });
    const takeover = async () => { this.effects.push('takeover'); throw new Error('Control must be returned by the operator in the browser.'); };
    vi.stubGlobal('takeOverTaskSpace', takeover); vi.stubGlobal('claimTaskSpace', takeover);
  }
  addPage(space: SpaceState, url: string, openedBy = 'agent') {
    const label = `p${space.nextPage++}`;
    const page = { label, url, title: 'Public fixture page', text: 'abcdefghij', openedBy, fields: {} };
    space.pages.set(label, page); return page;
  }
  task(space: SpaceState) {
    return {
      spaceId: space.id, name: space.name, ownership: space.ownership,
      tabs: async () => { this.available(); return [...space.pages.values()]; },
      page: (label: string) => this.page(space, space.pages.get(label)!),
      newPage: async () => this.page(space, this.addPage(space, 'about:blank')),
      waitForControl: async () => { this.available(); },
      handOff: async () => { space.ownership = 'agentDelegatedToUser'; this.effects.push('handoff'); },
      cdp: async (method: string) => {
        if (method === 'Browser.getWindowForTarget') return { windowId: 1, bounds: { windowState: this.minimized ? 'minimized' : 'normal' } };
        if (method === 'Browser.setWindowBounds') { this.minimized = false; this.effects.push('restore-window'); }
        return {};
      },
    };
  }
  available() { if (this.controlError) throw Object.assign(new Error('fixture control is unavailable'), { error_code: this.controlError }); }
  page(space: SpaceState, page: PageState) {
    return {
      label: page.label, targetId: `target-${page.label}`,
      url: async () => page.url, title: async () => page.title, snapshot: async () => page.text,
      goto: async (url: string) => { page.url = url; this.effects.push(`navigate:${url}`); },
      fill: async (selector: string, text: string) => { page.fields[selector] = text; },
      press: async (_selector: string, key: string) => { this.effects.push(`press:${key}`); },
      click: async (selector: string) => { this.effects.push(`click:${selector}`); return { clicked: true }; },
      mouse: { move: async () => {}, wheel: async (_x: number, y: number) => { this.effects.push(`scroll:${y}`); } },
      evaluate: async (expression: string) => {
        if (expression === 'timeout') throw Object.assign(new Error('secret raw diagnostic'), { error_code: 'EGO_PAGE_EVALUATION_TIMED_OUT', mayHaveLateEffects: true });
        if (expression === 'large') return { text: 'x'.repeat(2000) };
        return expression === 'undefined' ? undefined : { observed: true };
      },
      close: async () => { space.pages.delete(page.label); }, info: async () => {},
      screenshot: async ({ path }: { path: string }) => { await writeFile(path, this.screenshotBytes); },
    };
  }
  pause(operation: string) {
    let enter!: () => void;
    this.hold = { operation, entered: new Promise(resolve => { enter = resolve; }), enter: () => enter() };
    return this.hold;
  }
  async run(operation: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<BridgeReceipt> {
    this.operations.push(operation);
    const result = await execute({ operation, args: { ...args, screenshotFile: join(this.directory, 'fixture.png') } });
    if (this.hold?.operation === operation) {
      this.hold.enter();
      await new Promise<void>(resolve => { signal?.addEventListener('abort', () => resolve(), { once: true }); if (signal?.aborted) resolve(); });
      return { error: 'Uncertain fixture operation', uncertain: true };
    }
    return result;
  }
}
let directory: string;
let config: DreamConfigSection;
let bridge: BrowserFixture;
let browser: DreamEgoBrowser;
let controllers: DreamEgoBrowser[];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dream-ego-browser-'));
  config = structuredClone(DREAM_DEFAULTS); bridge = new BrowserFixture(directory); controllers = [];
  browser = create(); await browser.start();
});
function create(options: { botDir?: string; bridge?: EgoBridge } = {}) {
  const value = new DreamEgoBrowser({ config: () => config, dataDir: directory, botDir: options.botDir ?? '/fixture/bot', bridge: options.bridge ?? bridge });
  controllers.push(value); return value;
}
afterEach(async () => {
  await Promise.all(controllers.map(value => value.stop())); vi.unstubAllGlobals(); vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});
async function openPage() {
  const receipt = await browser.run('open', { url: 'https://news.example.org/story' });
  expect(receipt.error).toBeUndefined(); return receipt.value.page as string;
}
function ownSpace() { return bridge.spaces.get(browser.state().spaceId!)!; }

describe('persistent dream browser controller', () => {
  it('loads without connecting and generates a deployment-specific dream Space name', async () => {
    expect(browser.state()).toMatchObject({ running: true, connected: false, halted: false, spaceId: null });
    expect(browser.state().spaceName).toMatch(/^Coopanion-Dream-/);
    expect(bridge.operations).toEqual([]);
    const another = create({ botDir: '/fixture/another-bot' });
    expect(another.state().spaceName).not.toBe(browser.state().spaceName);
    await browser.connect(); expect(bridge.operations).toEqual(['connect']);
    expect(ownSpace().pages.get('p1')!.url).toBe('about:blank');
  });
  it('persists and reuses the same Space across restarts without finishing its pages', async () => {
    await openPage(); const id = browser.state().spaceId; const name = browser.state().spaceName;
    await browser.stop(); expect(bridge.spaces.has(id!)).toBe(true);
    const restarted = create(); await restarted.start();
    expect(restarted.state()).toMatchObject({ connected: false, spaceId: id, spaceName: name });
    expect((await restarted.connect()).error).toBeUndefined();
    expect(restarted.state()).toMatchObject({ connected: true, spaceId: id });
    expect(bridge.effects.filter(item => item === 'create-space')).toHaveLength(1);
    expect((await stat(join(directory, 'ego', 'state.json'))).mode & 0o777).toBe(0o600);
  });
  it.each(['egoExecutableFile', 'egoConnectionMode', 'egoHelperDir', 'egoSpaceName'] as const)('invalidates the connection immediately when %s changes', async key => {
    await openPage(); const before = browser.state();
    if (key === 'egoConnectionMode') config[key] = 'helper';
    else config[key] = key === 'egoSpaceName' ? 'Another-Dream-Space' : join(directory, key);
    browser.reconfigure();
    expect(browser.state()).toMatchObject({ connected: false, transport: null, lastOperation: null, helperOnline: false, launcherFile: '', spaceId: before.spaceId, spaceName: before.spaceName });
    expect(bridge.spaces.size).toBe(1);
    expect((await browser.connect()).error).toBeUndefined();
    expect(browser.state().connected).toBe(true);
    if (key === 'egoSpaceName') {
      expect(browser.state().spaceName).toBe(config.egoSpaceName);
      expect(browser.state().spaceId).not.toBe(before.spaceId);
      expect(bridge.spaces.size).toBe(2);
    } else {
      expect(browser.state().spaceId).toBe(before.spaceId);
      expect(bridge.spaces.size).toBe(1);
    }
  });
  it('applies timeout and text limits without invalidating a connected Space', async () => {
    const page = await openPage(); const before = browser.state(); const connects = bridge.operations.filter(item => item === 'connect').length;
    config.egoRequestTimeoutMs += 1000; config.egoMaxChars = 4; browser.reconfigure();
    expect(browser.state()).toMatchObject({ connected: true, spaceId: before.spaceId });
    const receipt = await browser.run('read', { page });
    expect(receipt.value.snapshot).toBe('abcd');
    expect(bridge.operations.filter(item => item === 'connect')).toHaveLength(connects);
  });
  it('reports a transport only after an attempt and clears it when the configuration changes', async () => {
    config.egoExecutableFile = join(directory, 'missing-cli'); config.egoConnectionMode = 'direct';
    const transportBrowser = new DreamEgoBrowser({ config: () => config, dataDir: directory, botDir: '/fixture/bot' });
    controllers.push(transportBrowser); await transportBrowser.start();
    expect(transportBrowser.state().transport).toBeNull();
    expect((await transportBrowser.connect()).code).toBe('EGO_CLI_NOT_FOUND');
    expect(transportBrowser.state()).toMatchObject({ transport: 'direct', connected: false });
    config.egoConnectionMode = 'helper'; transportBrowser.reconfigure();
    expect(transportBrowser.state()).toMatchObject({ transport: null, lastOperation: null, connected: false });
    expect((await transportBrowser.connect()).code).toBe('EGO_HELPER_UNAVAILABLE');
    expect(transportBrowser.state()).toMatchObject({ transport: 'helper', connected: false });
    await transportBrowser.stop(); expect(transportBrowser.state().transport).toBe('helper');
  });
  it('retains manual handoff across restart until the operator returns browser control', async () => {
    await openPage(); await browser.handoff();
    expect(browser.state()).toMatchObject({ halted: true, connected: false, uncertain: false, code: 'EGO_TASK_SPACE_USER_IN_CONTROL' });
    await browser.stop(); browser = create(); await browser.start();
    const before = bridge.operations.length;
    expect((await browser.run('tabs')).error).toBeTruthy(); expect((await browser.connect()).error).toBeTruthy();
    expect(bridge.operations.slice(before)).toEqual(['control-status']);
    expect((await browser.resume()).code).toBe('EGO_TASK_SPACE_USER_IN_CONTROL');
    ownSpace().ownership = 'agent';
    expect((await browser.connect()).error).toBeUndefined();
    expect(browser.state()).toMatchObject({ halted: false, connected: true });
    expect(bridge.effects.filter(item => item === 'takeover')).toHaveLength(0);
  });
  it('observes returned control on the same Space with backoff and never takes over or replays actions', async () => {
    vi.useFakeTimers(); await openPage(); await browser.handoff();
    const id = browser.state().spaceId;
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(browser.state().checkingControl).toBe(false));
    expect(bridge.operations.filter(item => item === 'control-status')).toHaveLength(1);
    expect(browser.state().halted).toBe(true);
    ownSpace().ownership = 'agent';
    await vi.advanceTimersByTimeAsync(3000);
    expect(browser.state().halted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(browser.state().halted).toBe(false));
    expect(browser.state()).toMatchObject({ spaceId: id, connected: true });
    expect(bridge.effects.filter(item => item === 'takeover')).toEqual([]);
    expect(bridge.operations.filter(item => item === 'open')).toHaveLength(1);
  });
  it('remembers the identity of a first connection to a delegated Space without taking control', async () => {
    const name = browser.state().spaceName;
    bridge.spaces.set(7, { id: 7, name, ownership: 'agentDelegatedToUser', pages: new Map(), nextPage: 1 });
    expect((await browser.connect()).code).toBe('EGO_TASK_SPACE_USER_IN_CONTROL');
    expect(browser.state()).toMatchObject({ spaceId: 7, halted: true, connected: false });
    expect((await browser.connect()).code).toBe('EGO_TASK_SPACE_USER_IN_CONTROL');
    bridge.spaces.get(7)!.ownership = 'agent';
    expect((await browser.connect()).value.control).toBe('agent');
    expect(browser.state()).toMatchObject({ spaceId: 7, connected: true, halted: false });
    expect(bridge.effects).toEqual([]);
  });
  it('discovers a legacy paused Space with no saved id and observes the operator returning control', async () => {
    vi.useFakeTimers();
    const name = browser.state().spaceName;
    bridge.spaces.set(7, { id: 7, name, ownership: 'agentDelegatedToUser', pages: new Map(), nextPage: 1 });
    await browser.stop();
    await mkdir(join(directory, 'ego'));
    await writeFile(join(directory, 'ego', 'state.json'), JSON.stringify({ version: 1, spaceName: name,
      halted: true, uncertain: false, spaceMissing: false, code: 'EGO_TASK_SPACE_USER_IN_CONTROL' }));
    await browser.start();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(browser.state().spaceId).toBe(7));
    await vi.waitFor(() => expect(browser.state().checkingControl).toBe(false));
    expect(browser.state().halted).toBe(true);
    bridge.spaces.get(7)!.ownership = 'agent';
    await vi.advanceTimersByTimeAsync(4000);
    await vi.waitFor(() => expect(browser.state().halted).toBe(false));
    expect(browser.state().connected).toBe(true);
    expect(bridge.effects).toEqual([]);
  });
  it('reports a true user-owned name collision without binding or claiming it', async () => {
    bridge.spaces.set(7, { id: 7, name: browser.state().spaceName, ownership: 'user', pages: new Map(), nextPage: 1 });
    expect((await browser.connect()).code).toBe('EGO_TASK_SPACE_NAME_IN_USE');
    expect((await browser.connect()).code).toBe('EGO_TASK_SPACE_NAME_IN_USE');
    expect(browser.state()).toMatchObject({ spaceId: null, halted: true, connected: false });
    expect(bridge.effects).toEqual([]);
    config.egoSpaceName = 'Independent Dream Space'; browser.reconfigure();
    expect((await browser.connect()).error).toBeUndefined();
    expect(browser.state()).toMatchObject({ connected: true, spaceName: config.egoSpaceName });
    expect(bridge.spaces.get(7)!.ownership).toBe('user');
    expect(bridge.effects).toEqual(['create-space']);
  });
  it('retains a known identity when a browser-owned prompt blocks the initial connection', async () => {
    bridge.spaces.set(7, { id: 7, name: browser.state().spaceName, ownership: 'agent', pages: new Map(), nextPage: 1 });
    bridge.controlError = 'EGO_TASK_SPACE_USER_IN_CONTROL';
    expect((await browser.connect()).code).toBe('EGO_TASK_SPACE_USER_IN_CONTROL');
    expect(browser.state()).toMatchObject({ spaceId: 7, halted: true });
    expect((await browser.connect()).code).toBe('EGO_TASK_SPACE_USER_IN_CONTROL');
    bridge.controlError = undefined;
    expect((await browser.connect()).error).toBeUndefined();
    expect(browser.state()).toMatchObject({ connected: true, halted: false });
    expect(bridge.effects).toEqual([]);
  });
  it('keeps an unknown operation warning when upgrading an older uncertain pause', async () => {
    await openPage();
    const file = join(directory, 'ego', 'state.json');
    await browser.stop();
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')),
      halted: true, uncertain: true, code: 'EGO_COMMAND_TIMEOUT' }));
    await browser.start();
    expect(browser.state().lastUnknownOutcome).toEqual({ operation: 'unknown', code: 'EGO_COMMAND_TIMEOUT' });
    expect((await browser.connect()).error).toBeUndefined();
    expect(browser.state()).toMatchObject({ connected: true, uncertain: false,
      lastUnknownOutcome: { operation: 'unknown', code: 'EGO_COMMAND_TIMEOUT' } });
    expect(JSON.parse(await readFile(file, 'utf8')).lastUnknownOutcome).toEqual({ operation: 'unknown', code: 'EGO_COMMAND_TIMEOUT' });
  });
  it('does not create a replacement Space while the old operation outcome is unknown', async () => {
    const page = await openPage(); const id = browser.state().spaceId;
    await browser.run('evaluate', { page, expression: 'timeout' });
    bridge.spaces.delete(id!);
    expect((await browser.connect()).code).toBe('EGO_TASK_SPACE_NOT_FOUND');
    expect((await browser.connect()).code).toBe('EGO_TASK_SPACE_NOT_FOUND');
    expect(browser.state()).toMatchObject({ spaceId: id, uncertain: true, halted: true, spaceMissing: false });
    expect(bridge.spaces.size).toBe(0);
  });
  it('allows a later explicit connection to replace a confirmed missing Space with no uncertain action', async () => {
    await openPage(); await browser.handoff(); const id = browser.state().spaceId;
    bridge.spaces.delete(id!);
    expect((await browser.connect()).code).toBe('EGO_TASK_SPACE_NOT_FOUND');
    expect(browser.state()).toMatchObject({ uncertain: false, spaceMissing: true });
    expect((await browser.connect()).error).toBeUndefined();
    expect(browser.state()).toMatchObject({ connected: true, halted: false });
    expect(browser.state().spaceId).not.toBe(id);
  });
  it('rejects a late control result after the World stops', async () => {
    await openPage(); await browser.handoff(); ownSpace().ownership = 'agent';
    const pending = bridge.pause('control-status');
    const result = browser.connect(); await pending.entered;
    await browser.stop();
    expect((await result).code).toBe('EGO_CANCELLED');
    expect(browser.state()).toMatchObject({ running: false, connected: false, halted: true });
    expect(bridge.effects.filter(effect => effect === 'takeover')).toEqual([]);
  });
  it('continues observing after a temporary diagnostic connection failure without inventing an unknown action', async () => {
    vi.useFakeTimers(); await openPage(); await browser.handoff(); ownSpace().ownership = 'agent';
    bridge.controlError = 'EGO_BROWSER_UNAVAILABLE';
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(browser.state().checkingControl).toBe(false));
    expect(browser.state()).toMatchObject({ halted: true, code: 'EGO_BROWSER_UNAVAILABLE', lastUnknownOutcome: null });
    bridge.controlError = undefined;
    await vi.advanceTimersByTimeAsync(4000);
    await vi.waitFor(() => expect(browser.state().halted).toBe(false));
    expect(browser.state()).toMatchObject({ connected: true, lastUnknownOutcome: null });
  });
  it('checks current availability after an unknown outcome without replaying or forgetting that outcome', async () => {
    vi.useFakeTimers(); const page = await openPage();
    await browser.run('evaluate', { page, expression: 'timeout' });
    bridge.controlError = 'EGO_TASK_SPACE_USER_IN_CONTROL';
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(browser.state().checkingControl).toBe(false));
    expect(browser.state()).toMatchObject({ halted: true, uncertain: true,
      lastUnknownOutcome: { operation: 'evaluate', code: 'EGO_PAGE_EVALUATION_TIMED_OUT' } });
    bridge.controlError = undefined;
    await vi.advanceTimersByTimeAsync(4000);
    await vi.waitFor(() => expect(browser.state().halted).toBe(false));
    expect(browser.state()).toMatchObject({ connected: true, uncertain: false,
      lastUnknownOutcome: { operation: 'evaluate', code: 'EGO_PAGE_EVALUATION_TIMED_OUT' } });
    expect(bridge.operations.filter(operation => operation === 'evaluate')).toHaveLength(1);
    await browser.stop(); browser = create(); await browser.start();
    expect(browser.state().lastUnknownOutcome).toEqual({ operation: 'evaluate', code: 'EGO_PAGE_EVALUATION_TIMED_OUT' });
    await browser.connect(); await browser.handoff(); await browser.stop();
    const count = bridge.operations.length;
    await vi.advanceTimersByTimeAsync(30000); expect(bridge.operations).toHaveLength(count);
  });
  it('halts after unknown action outcomes and never automatically repeats the action', async () => {
    await browser.connect(); const pending = bridge.pause('open');
    const operation = browser.run('open', { url: 'https://news.example.org/story' }); await pending.entered;
    await browser.cancelPending(); expect((await operation).uncertain).toBe(true);
    expect(browser.state()).toMatchObject({ halted: true, uncertain: true });
    await browser.stop(); browser = create(); await browser.start();
    expect((await browser.run('open', { url: 'https://news.example.org/story' })).error).toBeTruthy();
    expect(bridge.operations.filter(item => item === 'open')).toHaveLength(1);
    expect(bridge.spaces.size).toBe(1);
  });
  it('recreates a clearly missing Space by name without replaying the failed browser action', async () => {
    await openPage(); const oldId = browser.state().spaceId; const name = browser.state().spaceName;
    bridge.spaces.delete(oldId!);
    const failed = await browser.run('click', { page: 'p1', selector: '@button' });
    expect(failed).toMatchObject({ code: 'EGO_TASK_SPACE_NOT_FOUND', value: { spaceReset: true, failedOperationReplayed: false } });
    expect(browser.state()).toMatchObject({ connected: true, halted: false, spaceName: name });
    expect(browser.state().spaceId).not.toBe(oldId);
    expect(bridge.operations.filter(item => item === 'click')).toHaveLength(1);
    expect(bridge.effects.filter(item => item.startsWith('click:'))).toEqual([]);
  });
  it('does not recreate a Space on ambiguous failures or mismatched identity', async () => {
    await openPage(); ownSpace().name = 'another-task';
    expect((await browser.run('tabs')).code).toBe('EGO_DREAM_SPACE_MISMATCH');
    expect(browser.state().halted).toBe(true); expect(bridge.spaces.size).toBe(1);
    const before = bridge.effects.length;
    expect((await browser.resume()).error).toBeTruthy(); expect(bridge.effects).toHaveLength(before);
  });
  it('keeps an evaluation timeout halted after restart and does not leak raw diagnostics', async () => {
    const page = await openPage();
    const receipt = await browser.run('evaluate', { page, expression: 'timeout' });
    expect(receipt).toMatchObject({ code: 'EGO_PAGE_EVALUATION_TIMED_OUT', uncertain: true });
    expect(JSON.stringify(receipt)).not.toContain('secret');
    await browser.stop(); browser = create(); await browser.start();
    expect(browser.state()).toMatchObject({ halted: true, uncertain: true });
    const before = bridge.operations.length;
    await browser.run('read', { page }); expect(bridge.operations).toHaveLength(before);
  });
  it('retains an uncertain halt on the original Space after reconfiguration and restart', async () => {
    const page = await openPage(); const before = browser.state();
    await browser.run('evaluate', { page, expression: 'timeout' });
    ownSpace().ownership = 'agentDelegatedToUser';
    config.egoSpaceName = 'Changed-Dream-Space'; config.egoExecutableFile = join(directory, 'another-cli'); browser.reconfigure();
    expect(browser.state()).toMatchObject({ connected: false, halted: true, uncertain: true, spaceId: before.spaceId, spaceName: before.spaceName });
    await browser.stop(); browser = create(); await browser.start();
    expect(browser.state()).toMatchObject({ connected: false, halted: true, uncertain: true, spaceId: before.spaceId, spaceName: before.spaceName });
    const operations = bridge.operations.length;
    expect((await browser.connect()).code).toBe('EGO_TASK_SPACE_USER_IN_CONTROL');
    expect((await browser.run('open', { url: 'https://news.example.org/another' })).error).toBeTruthy();
    expect(bridge.operations.slice(operations)).toEqual(['control-status']); expect(bridge.spaces.size).toBe(1);
    ownSpace().ownership = 'agent';
    expect((await browser.connect()).error).toBeUndefined();
    expect(browser.state().spaceId).toBe(before.spaceId);
    expect((await browser.connect()).error).toBeUndefined();
    expect(browser.state()).toMatchObject({ connected: true, spaceName: config.egoSpaceName });
    expect(browser.state().lastUnknownOutcome).toEqual({ operation: 'evaluate', code: 'EGO_PAGE_EVALUATION_TIMED_OUT' });
    expect(bridge.spaces.size).toBe(2);
  });
  it('invalidates queued requests when a dream ends without closing the owned Space', async () => {
    await browser.connect(); const pending = bridge.pause('open');
    const first = browser.run('open', { url: 'https://news.example.org/story' }); await pending.entered;
    const queued = browser.run('tabs'); await browser.cancelPending(); await first;
    expect((await queued).code).toBe('EGO_CANCELLED');
    expect(bridge.operations.filter(item => item === 'tabs')).toHaveLength(0); expect(bridge.spaces.size).toBe(1);
  });
  it('stores only control identity and halt information, without page contents or supplied credentials', async () => {
    const page = await openPage(); await browser.run('fill', { page, selector: '@field', text: 'synthetic-sensitive-text' });
    const saved = await readFile(join(directory, 'ego', 'state.json'), 'utf8');
    expect(saved).not.toContain('synthetic-sensitive-text'); expect(saved).not.toContain('news.example.org');
    expect(JSON.parse(saved).spaceName).toBe(browser.state().spaceName);
  });
  it.each(['EGO_RESPONSE_TOO_LARGE', 'EGO_RUNTIME_FAILED', 'EGO_INVALID_ARGUMENT', 'EGO_HELPER_INTERRUPTED'])('keeps the specific safe diagnosis for %s', async code => {
    const controlled = create({ bridge: { run: async () => ({ error: 'private raw diagnostic', code, uncertain: false }) } });
    await controlled.start(); const receipt = await controlled.connect();
    expect(receipt.code).toBe(code); expect(receipt.error).not.toContain('private');
    expect(receipt.error).not.toBe('The dream browser operation failed.');
    expect(controlled.state().code).toBe(code);
  });
});

describe('browser operations and source receipts', () => {
  it('returns structured paginated snapshots and sources only after reading a page', async () => {
    const opened = await browser.run('open', { url: 'https://news.example.org/story', maxChars: 4 });
    expect(opened.source).toBeUndefined(); expect(opened.value).toMatchObject({ snapshot: 'abcd', nextOffset: 4, totalChars: 10, untrusted: true });
    const receipt = await browser.run('read', { page: opened.value.page, offset: 4, maxChars: 4 });
    expect(receipt.value).toMatchObject({ snapshot: 'efgh', offset: 4, end: 8, totalChars: 10, truncated: true, nextOffset: 8 });
    expect(receipt.source).toEqual({ url: 'https://news.example.org/story', title: 'Public fixture page', snippet: 'efgh' });
    const last = await browser.run('read', { page: opened.value.page, offset: 8, maxChars: 4 });
    expect(last.value).toMatchObject({ snapshot: 'ij', nextOffset: null, end: 10 });
    expect((await browser.run('navigate', { page: opened.value.page, url: 'https://news.example.org/other' })).source).toBeUndefined();
  });
  it('uses managed page controls and allows closing only agent-created pages', async () => {
    const page = await openPage();
    await browser.run('fill', { page, selector: '@field', text: 'public query' });
    expect(ownSpace().pages.get(page)!.fields['@field']).toBe('public query');
    await browser.run('press', { page, selector: '@field', key: 'ENTER' });
    await browser.run('click', { page, selector: '@button' }); await browser.run('scroll', { page, deltaY: 500 });
    expect(bridge.effects).toEqual(expect.arrayContaining(['press:ENTER', 'click:@button', 'scroll:500']));
    const user = bridge.addPage(ownSpace(), 'https://news.example.org/user', 'user');
    expect((await browser.run('close', { page: user.label })).code).toBe('EGO_PAGE_NOT_OWNED');
    expect(ownSpace().pages.has(user.label)).toBe(true);
    await browser.run('close', { page }); expect(ownSpace().pages.has(page)).toBe(false);
    expect((await browser.run('read', { page })).code).toBe('EGO_PAGE_NOT_MANAGED');
  });
  it('applies the configured text limit to action snapshots and preserves JSON around a large evaluation preview', async () => {
    const page = await openPage(); config.egoMaxChars = 1000; ownSpace().pages.get(page)!.text = 'x'.repeat(1500);
    for (const [operation, args] of [['click', { selector: '@button' }], ['fill', { selector: '@field', text: 'value' }],
      ['press', { selector: '@field', key: 'ENTER' }], ['scroll', { deltaY: 200 }]] as const) {
      const receipt = await browser.run(operation, { page, ...args });
      expect(receipt.error).toBeUndefined(); expect(receipt.value.snapshot).toHaveLength(config.egoMaxChars);
      expect(receipt.value).toMatchObject({ totalChars: 1500, truncated: true, nextOffset: config.egoMaxChars });
    }
    const evaluated = await browser.run('evaluate', { page, expression: 'large' });
    expect(evaluated.value.result.preview).toHaveLength(config.egoMaxChars);
    expect(evaluated.value.result).toMatchObject({ truncated: true, totalChars: 2011 });
    expect(JSON.parse(JSON.stringify(evaluated)).value.result.truncated).toBe(true);
  });
  it('returns screenshot bytes and restores a minimized own window only when configured', async () => {
    const page = await openPage(); const shot = await browser.run('shot', { page });
    expect(shot.value).toMatchObject({ restoredWindow: true, image: { mime: 'image/png' }, untrusted: true });
    expect(Buffer.from(shot.value.image.base64, 'base64')).toEqual(bridge.screenshotBytes);
    config.egoRestoreMinimized = false; bridge.minimized = true;
    expect((await browser.run('shot', { page })).value.restoredWindow).toBe(false); expect(bridge.minimized).toBe(true);
    bridge.screenshotBytes = Buffer.alloc(8 * 1024 * 1024 + 1);
    expect((await browser.run('shot', { page })).code).toBe('EGO_IMAGE_TOO_LARGE');
  });
  it('waits on the host without connecting or executing a browser script and is cancellable', async () => {
    expect(await browser.run('wait', { seconds: 0 })).toMatchObject({ value: { browserScriptExecuted: false, waitedSeconds: 0 } });
    const pending = browser.run('wait', { seconds: 30 }); await browser.cancelPending();
    expect((await pending).code).toBe('EGO_CANCELLED'); expect(bridge.operations).toEqual([]);
  });
  it.each(['file:///private/file', 'javascript:alert(1)', 'http://127.0.0.1', 'http://2130706433', 'http://192.168.1.1',
    'http://10.1.2.3', 'http://localhost', 'http://service.local', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'https://user:password@example.org'])('rejects non-public navigation before connecting: %s', async url => {
    expect((await browser.run('open', { url })).code).toBe('EGO_INVALID_ARGUMENTS'); expect(bridge.operations).toEqual([]);
    expect(() => publicBrowserUrl(url)).toThrow();
  });
  it('rejects caller-selected Space identities, file paths, video and unsupported operations', async () => {
    for (const [operation, args] of [['tabs', { spaceId: 99 }], ['open', { url: 'https://news.example.org', spaceName: 'other' }],
      ['shot', { page: 'p1', screenshotFile: '/private/file' }], ['video', {}], ['bilibili', {}], ['resume', {}], ['finish', {}]] as const) {
      expect((await browser.run(operation, args)).code).toBe('EGO_INVALID_ARGUMENTS');
    }
    expect(bridge.operations).toEqual([]);
  });
  it('checks handoff status without reading page bodies or taking over control', async () => {
    await browser.connect(); expect((await browser.run('control-status')).value).toEqual({ control: 'agent' });
    expect(bridge.effects).toEqual(['create-space']);
  });
});

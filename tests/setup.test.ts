import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { DREAM } from '../src/definition.ts';
import { DreamWorld } from '../src/world.ts';
import { qqConfig } from '../src/config.ts';
import { strings } from '../src/strings.ts';
import { RealHost } from './helpers/real-host.ts';
import { BrowserFixture } from './helpers/ego-bridge.ts';

let directory: string;
let context: ReturnType<typeof fakeWorldContext<ReturnType<typeof DREAM.defaults>>>;
let browser: BrowserFixture;
let world: DreamWorld;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dream-browser-setup-'));
  context = fakeWorldContext(DREAM, { scratchDir: directory }); browser = new BrowserFixture();
  world = new DreamWorld({ context, egoBridge: browser, pollMs: 100000 });
});

describe('QQ dream-sharing panel', () => {
  const invoke = (method: string, args: unknown[] = []) => world.webUi('en').invoke!('qq-talk', method, args);

  it('declares its read method and exposes only its four settings', async () => {
    expect(world.webUi('en').panels).toContainEqual({ id: 'qq-talk', title: strings('en').qqTalkTitle, getMethods: ['state'] });
    const state = await invoke('state');
    expect(state).toEqual(qqConfig(context.cfg));
    expect(Object.keys(state as object)).toHaveLength(4);
    for (const method of ['sleep', 'wake', 'saveKey', 'saveCollectorConfig', 'query']) await expect(invoke(method)).rejects.toThrow('Unknown method');
    for (const panelId of ['dream', 'collection-settings']) {
      await expect(world.webUi('en').invoke!(panelId, 'saveQQConfig', [{ qqUsers: '7002' }])).rejects.toThrow('Unknown method');
    }
  });

  it('saves a normalized partial patch while preserving an ongoing sleep and dream', async () => {
    context.cfg.qqUsers = '7001'; context.cfg.dreamTalkGroups = '9001';
    context.cfg.collectorOrder = ['browser'];
    await world.start(new RealHost(directory)); await world.sleep();
    const before = world.state();
    const saved = await invoke('saveQQConfig', [{ dreamTalkEnabled: true, dreamTalkPrivates: '8001，8001\n8002' }]);
    expect(saved).toEqual({ qqUsers: '7001', dreamTalkEnabled: true, dreamTalkGroups: '9001', dreamTalkPrivates: '8001,8002' });
    expect(context.cfg).toMatchObject(saved as object);
    expect(world.state()).toMatchObject({ sleepUntil: before.sleepUntil, cycleId: before.cycleId, sleeping: true, dreaming: true });
    await world.stop(); world = new DreamWorld({ context, egoBridge: browser, pollMs: 100000 });
    expect(await invoke('state')).toEqual(saved);
  });

  it('leaves all QQ settings unchanged when any submitted field is invalid', async () => {
    const before = qqConfig(context.cfg);
    for (const patch of [{ qqUsers: '7001', dreamTalkPrivates: 'bad' }, { dreamTalkEnabled: true, apiKey: 'not-a-setting' }]) {
      await expect(invoke('saveQQConfig', [patch])).rejects.toThrow(strings('en').qqTalkInvalidConfig);
      expect(qqConfig(context.cfg)).toEqual(before);
    }
  });

  it('restores live QQ settings if persistence changes memory before a disk write fails', async () => {
    Object.assign(context.cfg, { qqUsers: '7001', dreamTalkEnabled: true, dreamTalkGroups: '9001', dreamTalkPrivates: '8001', collectorOrder: ['browser'] });
    await world.start(new RealHost(directory)); await world.sleep();
    const before = qqConfig(context.cfg), sleep = world.state();
    const configFile = join(directory, 'fixture-config.json'), blocked = join(directory, 'blocked-config');
    writeFileSync(configFile, JSON.stringify(before)); mkdirSync(blocked);
    context.persist = patch => {
      Object.assign(context.cfg, patch);
      writeFileSync(blocked, JSON.stringify(context.cfg));
      renameSync(blocked, configFile);
    };
    await expect(invoke('saveQQConfig', [{ qqUsers: '7002', dreamTalkEnabled: false, dreamTalkGroups: '', dreamTalkPrivates: '8002' }])).rejects.toThrow();
    expect(await invoke('state')).toEqual(before);
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toEqual(before);
    expect(JSON.parse(world.envPromptVars()['dream.state'])).toMatchObject({ qqOwners: ['7001'], sharing: { enabled: true, groups: ['9001'], privates: ['8001'] } });
    expect(world.state()).toMatchObject({ sleepUntil: sleep.sleepUntil, cycleId: sleep.cycleId, sleeping: true, dreaming: true });
  });

  it('migrates a missing private list without changing saved owners or sharing choices', async () => {
    const legacy = context.cfg as unknown as Record<string, unknown>;
    delete legacy.dreamTalkPrivates;
    Object.assign(legacy, { qqUsers: '7001', dreamTalkEnabled: true, dreamTalkGroups: '9001' });
    world = new DreamWorld({ context, egoBridge: browser, pollMs: 100000 });
    expect(await invoke('state')).toEqual({ qqUsers: '7001', dreamTalkEnabled: true, dreamTalkGroups: '9001', dreamTalkPrivates: DREAM.defaults().dreamTalkPrivates });
  });
});
afterEach(async () => { browser.pending?.release(); await world.stop(); rmSync(directory, { recursive: true, force: true }); });
async function panel(method: string, args: unknown[] = []) {
  return world.webUi('en').invoke!('collection-settings', method, args) as Promise<ReturnType<DreamWorld['state']>>;
}

describe('interactive ego setup', () => {
  it('connects with the default command without changing selected collection methods', async () => {
    context.cfg.searchUrlTemplate = ''; context.cfg.allowedDomains = '';
    await world.start(new RealHost(directory));
    expect(browser.requests).toEqual([]);
    const state = await panel('connectEgo', ['']);
    expect(state.egoConnection.connected).toBe(true);
    expect(state.egoConfigured).toBe(true); expect(context.cfg.collectorOrder).toEqual(['tavily']);
    expect(state).not.toHaveProperty('profiles');
    expect(state.egoConnection).not.toHaveProperty('profiles');
    expect(browser.requests.every(request => !('profileId' in request.args))).toBe(true);
    expect(context.cfg.searchUrlTemplate).toBe(''); expect(context.cfg.allowedDomains).toBe('');
  });
  it('validates configuration writes and refuses the obsolete Profile-selection action', async () => {
    await world.start(new RealHost(directory));
    await expect(panel('selectEgoProfile', ['profile'])).rejects.toThrow('Unknown method');
    await expect(panel('saveCollectorConfig', [{ egoProfileId: 'profile' }])).rejects.toThrow();
    await expect(panel('saveCollectorConfig', [{ egoEnabled: true }])).rejects.toThrow();
    await panel('saveCollectorConfig', [{ collectorOrder: ['ego'], egoSpaceName: 'Dream fixture', egoRequestTimeoutMs: 15000, egoMaxChars: 9000, egoConnectionMode: 'direct' }]);
    expect(context.cfg).toMatchObject({ collectorOrder: ['ego'], egoSpaceName: 'Dream fixture', egoRequestTimeoutMs: 15000, egoMaxChars: 9000, egoConnectionMode: 'direct' });
  });
  it('migrates missing new fields while ignoring the legacy Profile id', async () => {
    const legacy = context.cfg as unknown as Record<string, unknown>;
    delete legacy.egoEnabled; delete legacy.egoMaxChars;
    legacy.egoExecutableFile = '/fixture/ego-browser'; legacy.egoProfileId = 'unused-legacy-profile';
    world = new DreamWorld({ context, egoBridge: browser });
    expect(context.cfg.egoEnabled).toBe(DREAM.defaults().egoEnabled); expect(context.cfg.egoMaxChars).toBe(DREAM.defaults().egoMaxChars);
    await world.start(new RealHost(directory)); await panel('connectEgo');
    expect(context.cfg.collectorOrder).toEqual(['tavily']);
    expect(JSON.stringify(browser.requests)).not.toContain('unused-legacy-profile');
  });
  it('retains its dedicated Space across World restart and does not close it on stop', async () => {
    await world.start(new RealHost(directory)); const before = await panel('connectEgo');
    await world.stop();
    expect(browser.requests.some(request => request.operation === 'finish')).toBe(false);
    world = new DreamWorld({ context, egoBridge: browser, pollMs: 100000 });
    await world.start(new RealHost(directory)); const after = await panel('connectEgo');
    expect(after.egoConnection.spaceId).toBe(before.egoConnection.spaceId);
    expect(after.egoConnection.spaceName).toBe(before.egoConnection.spaceName);
  });
  it('preserves user control across restart and reconnects only after control returns in ego', async () => {
    await world.start(new RealHost(directory)); await panel('connectEgo');
    browser.ownership = 'user';
    expect((await panel('connectEgo')).egoConnection.halted).toBe(true);
    await world.stop(); world = new DreamWorld({ context, egoBridge: browser, pollMs: 100000 });
    await world.start(new RealHost(directory));
    expect(world.state().egoConnection.halted).toBe(true);
    expect((await panel('connectEgo')).egoConnection.halted).toBe(true);
    browser.ownership = 'agent';
    expect((await panel('connectEgo')).egoConnection.halted).toBe(false);
    expect(world.state().egoConnection.connected).toBe(true);
    expect(browser.requests.some(request => request.operation === 'resume')).toBe(false);
  });
  it('does not expose panel control-transfer actions', async () => {
    await world.start(new RealHost(directory)); await panel('connectEgo');
    const before = browser.requests.length;
    for (const method of ['egoHandoff', 'egoResume']) {
      await expect(panel(method)).rejects.toThrow('Unknown method');
      await expect(world.webUi('en').invoke!('dream', method, [])).rejects.toThrow('Unknown method');
    }
    expect(browser.requests).toHaveLength(before);
  });
  it('shows a connection failure and does not mark a disabled backend enabled', async () => {
    browser.failure = { error: 'Executable unavailable.', code: 'EGO_CLI_NOT_FOUND', uncertain: false };
    await world.start(new RealHost(directory)); const state = await panel('connectEgo');
    expect(state.egoConnection.connected).toBe(false);
    expect(state.egoConnection.code).toBe('EGO_CLI_NOT_FOUND');
    expect(context.cfg.egoEnabled).toBe(false);
  });
  it('returns a safe error code for an unclassified connection failure without exposing raw diagnostics', async () => {
    browser.failure = { error: 'Private runtime output from the fixture.', uncertain: false };
    await world.start(new RealHost(directory)); const state = await panel('connectEgo');
    expect(state.egoConnection).toMatchObject({ connected: false, code: 'EGO_OPERATION_FAILED' });
    expect(state.egoConnection.reason).toBeTruthy();
    expect(JSON.stringify(state)).not.toContain('Private runtime output');
  });
});

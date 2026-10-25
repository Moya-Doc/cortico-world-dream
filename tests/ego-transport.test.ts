import { afterEach, describe, expect, it } from 'vitest';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { AutoBridge, CliBridge, HelperBridge, prepareHelperLauncher, validateHelperRequest, validateRequest, type BridgeReceipt, type EgoBridge } from '../src/ego-transport/index.ts';
import { HELPER_PROTOCOL, readEndpoint } from '../src/ego-transport/helper-bridge.ts';
import { startHelper } from '../src/ego-transport/helper.ts';
import { DreamEgoBrowser } from '../src/ego-browser.ts';
import { DREAM_DEFAULTS } from '../src/config.ts';

const directories: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()));
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'dream-transport-test-')); directories.push(dir); return dir; }
const identity = { spaceName: 'Test Dream Space', spaceId: 7 };
async function fixture(runtime = 'return {spaceId:7,value:{operation,args}};', cliPrefix = '') {
  const dir = await directory(), cliFile = join(dir, 'fake-browser.mjs'), runtimeFile = join(dir, 'runtime.mjs');
  await writeFile(cliFile, `#!${process.execPath}\nimport {writeFile} from 'node:fs/promises';\n${cliPrefix}\nconst expression=process.argv.at(-1);\nconst target=JSON.parse(expression.slice('await import('.length,-1));\nawait import(target);\n`, { mode: 0o700 });
  await chmod(cliFile, 0o700);
  await writeFile(runtimeFile, `export async function execute({operation,args}) { ${runtime} }`);
  const bridge = new CliBridge({ cliFile, dataDir: dir, timeoutMs: () => 1000, runtimeUrl: pathToFileURL(runtimeFile).href });
  return { bridge, dir, cliFile, runtimeFile };
}
async function waitUntil(check: () => Promise<boolean>) {
  const deadline = Date.now() + 4000;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Fixture did not reach its expected state.'); await new Promise(done => setTimeout(done, 10)); }
}
describe('direct Ego transport', () => {
  it('executes an ESM round with private files, bounded environment and cleanup', async () => {
    const previous = process.env.DREAM_TRANSPORT_PRIVATE_TEST;
    process.env.DREAM_TRANSPORT_PRIVATE_TEST = 'private-test-value';
    try {
      const { bridge, dir } = await fixture(`const {stat,writeFile}=await import('node:fs/promises');const {dirname,join}=await import('node:path');const folder=dirname(args.screenshotFile);await writeFile(args.screenshotFile,'synthetic');return {spaceId:7,value:{secret:process.env.DREAM_TRANSPORT_PRIVATE_TEST??null,folderMode:(await stat(folder)).mode&511,scriptMode:(await stat(join(folder,'script.mjs'))).mode&511,args}};`, `console.log('opaque diagnostic');`);
      const receipt = await bridge.run('tabs', identity);
      expect(receipt.error).toBeUndefined();
      expect(receipt.value.secret).toBeNull();
      expect(receipt.value.folderMode).toBe(0o700);
      expect(receipt.value.scriptMode).toBe(0o600);
      expect(receipt.value.args.screenshotFile).toMatch(/round-.*\/page\.png$/);
      expect(await readdir(join(dir, 'ego/rounds'))).toEqual([]);
    } finally { if (previous === undefined) delete process.env.DREAM_TRANSPORT_PRIVATE_TEST; else process.env.DREAM_TRANSPORT_PRIVATE_TEST = previous; }
  });
  it('resolves a macOS application bundle without invoking a shell', async () => {
    const { dir, cliFile, runtimeFile } = await fixture();
    const app = join(dir, 'Synthetic App.app'), executable = join(app, 'Contents/Frameworks/ego Framework.framework/Versions/Current/Helpers/ego-browser');
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(executable, await readFile(cliFile), { mode: 0o700 });
    const bridge = new CliBridge({ cliFile: app, dataDir: dir, runtimeUrl: pathToFileURL(runtimeFile).href, timeoutMs: () => 1000 });
    expect((await bridge.run('tabs', identity)).value.operation).toBe('tabs');
  });
  it('rejects injected paths and unsupported operations before starting the executable', async () => {
    const { bridge, dir } = await fixture();
    expect(await bridge.run('read', { ...identity, page: 'p1', screenshotFile: '/arbitrary/path' })).toMatchObject({ code: 'EGO_INVALID_ARGUMENT', uncertain: false });
    expect(await bridge.run('video', identity)).toMatchObject({ code: 'EGO_INVALID_ARGUMENT', uncertain: false });
    expect(await readdir(dir)).not.toContain('ego');
  });
  it('returns safe unknown failures and detects a failed inner Node runtime even when the launcher exits zero', async () => {
    const thrown = await fixture(`throw new Error('private-synthetic-text');`);
    const receipt = await thrown.bridge.run('tabs', identity);
    expect(receipt).toMatchObject({ code: 'EGO_RUNTIME_FAILED', uncertain: true });
    expect(JSON.stringify(receipt)).not.toContain('private-synthetic-text');
    const inner = await fixture('', `console.log("ego's nodejs process exited with code 13");process.exit(0);`);
    expect(await inner.bridge.run('tabs', identity)).toMatchObject({ code: 'EGO_RUNTIME_FAILED', uncertain: true });
  });
  it('accepts an eight MiB image and rejects receipts or diagnostics above their limits', async () => {
    const image = await fixture(`return {spaceId:7,value:{image:{base64:Buffer.alloc(8*1024*1024).toString('base64'),mime:'image/png'}}};`);
    expect((await image.bridge.run('shot', { ...identity, page: 'p1' })).value.image.base64.length).toBe(Math.ceil(8 * 1024 * 1024 / 3) * 4);
    const oversized = await fixture(`return {spaceId:7,value:'x'.repeat(13*1024*1024)};`);
    expect(await oversized.bridge.run('tabs', identity)).toMatchObject({ code: 'EGO_RESPONSE_TOO_LARGE', uncertain: true });
    const noisy = await fixture('', `process.stdout.write('x'.repeat(150*1024));await new Promise(done=>setTimeout(done,10000));`);
    expect(await noisy.bridge.run('tabs', identity)).toMatchObject({ code: 'EGO_RESPONSE_TOO_LARGE', uncertain: true });
  });
  it('keeps structured hard stops and permits source candidates only from read', async () => {
    const stopped = await fixture(`return {error:'Space is under user control.',code:'EGO_TASK_SPACE_USER_IN_CONTROL',uncertain:false};`);
    expect(await stopped.bridge.run('tabs', identity)).toMatchObject({ code: 'EGO_TASK_SPACE_USER_IN_CONTROL', uncertain: false });
    const source = await fixture(`return {spaceId:7,value:{},source:{url:'https://news.example/item',title:'A',snippet:'B'}};`);
    expect((await source.bridge.run('read', { ...identity, page: 'p1' })).source?.title).toBe('A');
    expect(await source.bridge.run('open', { ...identity, url: 'https://news.example' })).toMatchObject({ code: 'EGO_INVALID_RECEIPT' });
  });
  it('cancels a running command, distinguishes cancellation before launch and removes its round', async () => {
    const { bridge, dir } = await fixture(`await new Promise(done=>setTimeout(done,10000));return {value:null};`);
    const before = new AbortController(); before.abort();
    expect(await bridge.run('tabs', identity, before.signal)).toMatchObject({ code: 'EGO_COMMAND_CANCELLED', uncertain: false });
    const controller = new AbortController();
    const pending = bridge.run('tabs', identity, controller.signal);
    await waitUntil(async () => { try { return (await readdir(join(dir, 'ego/rounds'))).length === 1; } catch { return false; } });
    await new Promise(done => setTimeout(done, 100)); controller.abort();
    expect(await pending).toMatchObject({ code: 'EGO_COMMAND_CANCELLED', uncertain: true });
    expect(await readdir(join(dir, 'ego/rounds'))).toEqual([]);
  });
  it('times out a launched command and treats a missing executable as pre-execution failure', async () => {
    const { dir, cliFile, runtimeFile } = await fixture(`await new Promise(done=>setTimeout(done,10000));return {value:null};`);
    const bridge = new CliBridge({ cliFile, dataDir: dir, runtimeUrl: pathToFileURL(runtimeFile).href, timeoutMs: () => 100 });
    expect(await bridge.run('tabs', identity)).toMatchObject({ code: 'EGO_COMMAND_TIMEOUT', uncertain: true });
    const missing = new CliBridge({ cliFile: join(dir, 'missing'), dataDir: dir, timeoutMs: () => 100 });
    expect(await missing.run('tabs', identity)).toMatchObject({ code: 'EGO_CLI_NOT_FOUND', uncertain: false });
  });
});
describe('local ordinary-permission helper', () => {
  async function helper(bridge: EgoBridge) {
    const dir = await directory();
    const running = await startHelper({ dir, bridge, checkElevated: async () => false }); closers.push(running.close);
    return { ...running, dir, client: new HelperBridge(dir, () => 5000) };
  }
  it('checks authentication and Origin, validates requests, and binds one Space while permitting same-name recovery', async () => {
    let nextSpaceId = 7;
    const calls: { operation: string; args: Record<string, unknown> }[] = [];
    const running = await helper({ async run(operation, args) { calls.push({ operation, args }); return { spaceId: nextSpaceId, value: { operation } }; } });
    expect(await running.client.probe()).toBe(true);
    const endpoint = await readEndpoint(running.dir), url = `http://127.0.0.1:${running.port}`;
    const headers = { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' };
    expect((await fetch(`${url}/health`)).status).toBe(401);
    expect((await fetch(`${url}/health`, { headers: { ...headers, origin: 'https://news.example' } })).status).toBe(403);
    expect(await running.client.run('tabs', identity)).toMatchObject({ code: 'EGO_HELPER_SPACE_MISMATCH', uncertain: false });
    for (const body of [ { operation: 'video', args: identity }, { operation: 'connect', args: { ...identity, screenshotFile: '/arbitrary/path' } }, { operation: 'connect', args: identity, cliFile: '/arbitrary/executable' } ]) {
      expect((await fetch(`${url}/run`, { method: 'POST', headers, body: JSON.stringify({ timeoutMs: 5000, ...body }) })).status).toBe(400);
    }
    for (const timeoutMs of [undefined, 4999, 120001, '5000', null]) {
      expect((await fetch(`${url}/run`, { method: 'POST', headers, body: JSON.stringify({ operation: 'connect', args: { spaceName: identity.spaceName }, timeoutMs }) })).status).toBe(400);
    }
    expect(calls).toHaveLength(0);
    expect((await running.client.run('connect', { spaceName: identity.spaceName })).spaceId).toBe(7);
    expect(await running.client.run('tabs', { ...identity, spaceId: 8 })).toMatchObject({ code: 'EGO_HELPER_SPACE_MISMATCH' });
    expect(await running.client.run('connect', { spaceName: 'Another Space' })).toMatchObject({ code: 'EGO_HELPER_SPACE_MISMATCH' });
    nextSpaceId = 8;
    expect((await running.client.run('connect', { spaceName: identity.spaceName })).spaceId).toBe(8);
    expect(await running.client.run('control-status', identity)).toMatchObject({ code: 'EGO_HELPER_SPACE_MISMATCH' });
    expect((await running.client.run('tabs', { ...identity, spaceId: 8 })).value.operation).toBe('tabs');
    expect((await new HelperBridge(running.dir, () => 120000).run('tabs', { ...identity, spaceId: 8 })).value.operation).toBe('tabs');
    expect((await stat(join(running.dir, 'endpoint.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(running.dir)).mode & 0o777).toBe(0o700);
  });
  it.each(['connect', 'control-status'])('binds the first %s identity while the Space remains delegated to the user', async operation => {
    let returned = false;
    const running = await helper({ async run() { return { spaceId: 7, value: { control: returned ? 'agent' : 'user' } }; } });
    expect(await running.client.run(operation, { spaceName: identity.spaceName })).toMatchObject({ spaceId: 7, value: { control: 'user' } });
    expect(await running.client.run('control-status', { ...identity, spaceId: 8 })).toMatchObject({ code: 'EGO_HELPER_SPACE_MISMATCH' });
    expect(await running.client.run('control-status', { spaceName: 'Another Space' })).toMatchObject({ code: 'EGO_HELPER_SPACE_MISMATCH' });
    returned = true;
    expect(await running.client.run('control-status', identity)).toMatchObject({ spaceId: 7, value: { control: 'agent' } });
    expect(await running.client.run('resume', identity)).toMatchObject({ code: 'EGO_INVALID_ARGUMENT' });
  });
  it('does not bind a conflicting name and never changes an established id through discovery', async () => {
    let result: BridgeReceipt = { error: 'Name belongs to the user.', code: 'EGO_TASK_SPACE_NAME_IN_USE', uncertain: false };
    const running = await helper({ async run() { return result; } });
    expect(await running.client.run('control-status', { spaceName: 'Conflicting Space' })).toMatchObject({ code: 'EGO_TASK_SPACE_NAME_IN_USE' });
    result = { spaceId: 7, value: { control: 'agent' } };
    expect(await running.client.run('control-status', { spaceName: identity.spaceName })).toMatchObject({ spaceId: 7 });
    result = { spaceId: 8, value: { control: 'agent' } };
    expect(await running.client.run('control-status', { spaceName: identity.spaceName })).toMatchObject({ code: 'EGO_HELPER_SPACE_MISMATCH' });
    result = { spaceId: 7, value: { control: 'agent' } };
    expect(await running.client.run('control-status', identity)).toMatchObject({ spaceId: 7 });
  });
  it('does not bind an uncertain or mismatched first discovery result', async () => {
    let result: BridgeReceipt = { spaceId: 8, value: { control: 'agent' }, uncertain: true };
    const running = await helper({ async run() { return result; } });
    expect(await running.client.run('control-status', { spaceName: 'Uncertain Space' })).toMatchObject({ uncertain: true });
    result = { spaceId: 8, value: { control: 'unsupported' } };
    expect(await running.client.run('control-status', { spaceName: 'Malformed Space' })).toMatchObject({ code: 'EGO_INVALID_RECEIPT' });
    result = { spaceId: 8, value: { control: 'agent' } };
    expect(await running.client.run('control-status', identity)).toMatchObject({ code: 'EGO_HELPER_SPACE_MISMATCH' });
    result = { spaceId: 7, value: { control: 'agent' } };
    expect(await running.client.run('control-status', identity)).toMatchObject({ spaceId: 7 });
    expect(await running.client.run('control-status', { spaceName: 'Uncertain Space' })).toMatchObject({ code: 'EGO_HELPER_SPACE_MISMATCH' });
  });
  it('reports the helper transport after restoring a paused controller through a read-only check', async () => {
    let control = 'user';
    const running = await helper({ async run() { return { spaceId: 7, value: { control } }; } });
    const dataDir = await directory();
    const config = { ...structuredClone(DREAM_DEFAULTS), egoConnectionMode: 'helper' as const, egoHelperDir: running.dir, egoSpaceName: identity.spaceName };
    const create = () => new DreamEgoBrowser({ config: () => config, dataDir, botDir: dataDir });
    let browser = create();
    try {
      await browser.start();
      expect((await browser.connect()).code).toBe('EGO_TASK_SPACE_USER_IN_CONTROL');
      await browser.stop(); browser = create(); await browser.start();
      expect(browser.state()).toMatchObject({ transport: null, helperOnline: false });
      control = 'agent';
      expect((await browser.connect()).error).toBeUndefined();
      expect(browser.state()).toMatchObject({ connected: true, halted: false, transport: 'helper', helperOnline: true, lastOperation: 'control-status' });
    } finally { await browser.stop(); }
  });
  it('rejects an older helper protocol with a version diagnosis before dispatch', async () => {
    const running = await helper({ async run() { throw new Error('Old helper must not receive operations.'); } });
    const endpointFile = join(running.dir, 'endpoint.json');
    const endpoint = await readEndpoint(running.dir);
    await writeFile(endpointFile, JSON.stringify({ ...endpoint, protocol: HELPER_PROTOCOL - 1 }));
    expect(await running.client.run('control-status', { spaceName: identity.spaceName })).toMatchObject({ code: 'EGO_HELPER_VERSION', uncertain: false });
  });
  it('cancels disconnected work and does not execute a cancelled queued command', async () => {
    let started = false, cancelled = false, queuedExecutions = 0;
    const running = await helper({ async run(operation, _args, signal) {
      if (operation === 'read') { started = true; await new Promise<void>(done => { signal!.addEventListener('abort', () => { cancelled = true; done(); }, { once: true }); }); return { error: 'Cancelled.', code: 'EGO_COMMAND_CANCELLED', uncertain: true }; }
      if (operation === 'tabs') queuedExecutions++;
      return { spaceId: 7, value: null };
    } });
    await running.client.run('connect', { spaceName: identity.spaceName });
    const first = new AbortController(), second = new AbortController();
    const pending = running.client.run('read', { ...identity, page: 'p1' }, first.signal);
    await waitUntil(async () => started);
    const queued = running.client.run('tabs', identity, second.signal);
    await new Promise(done => setTimeout(done, 100)); second.abort();
    expect(await queued).toMatchObject({ code: 'EGO_COMMAND_CANCELLED' });
    await new Promise(done => setTimeout(done, 50)); first.abort();
    expect(await pending).toMatchObject({ code: 'EGO_COMMAND_CANCELLED', uncertain: true });
    await waitUntil(async () => cancelled);
    expect(queuedExecutions).toBe(0);
  });
  it('stops cleanly, removes authentication files and rejects duplicate or elevated helpers', async () => {
    const running = await helper({ async run() { return { spaceId: 7, value: null }; } });
    await expect(startHelper({ dir: running.dir, bridge: { async run() { return { value: null }; } }, checkElevated: async () => false })).rejects.toThrow('EGO_HELPER_ALREADY_RUNNING');
    await expect(startHelper({ dir: await directory(), checkElevated: async () => true })).rejects.toThrow('EGO_CLIENT_ELEVATED');
    await running.client.stop();
    await running.close();
    expect(await readdir(running.dir)).not.toContain('endpoint.json');
    expect(await readdir(running.dir)).not.toContain('.helper.lock');
    expect(await running.client.probe()).toBe(false);
  });
  it.skipIf(process.getuid?.() === 0)('runs the bundled helper with its relative runtime using a synthetic executable', async () => {
    const { dir, cliFile, runtimeFile } = await fixture(`return {spaceId:7,value:{operation,args,runtimeUrl:import.meta.url}};`);
    const bundle = join(dir, 'dist/ego-helper.mjs'), runtime = join(dir, 'src/ego-runtime.mjs'), helperDir = join(dir, 'helper');
    await mkdir(dirname(runtime), { recursive: true }); await copyFile(runtimeFile, runtime);
    await build({ entryPoints: [fileURLToPath(new URL('../src/ego-transport/helper.ts', import.meta.url))], outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const child = spawn(process.execPath, [bundle, '--dir', helperDir, '--cli', cliFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostic = '';
    child.stdout.on('data', part => { diagnostic = (diagnostic + String(part)).slice(-2048); });
    child.stderr.on('data', part => { diagnostic = (diagnostic + String(part)).slice(-2048); });
    const exited = new Promise<number | null>((done, fail) => { child.once('error', fail); child.once('exit', done); });
    closers.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; });
    const client = new HelperBridge(helperDir, () => 5000);
    await waitUntil(async () => { if (child.exitCode !== null) throw new Error(`Synthetic helper exited ${child.exitCode}: ${diagnostic}`); return client.probe(); });
    const connected = await client.run('connect', { spaceName: identity.spaceName });
    expect(connected.error).toBeUndefined();
    expect(connected.value.runtimeUrl).toBe(pathToFileURL(await realpath(runtime)).href);
    expect((await client.run('click', { ...identity, page: 'p1', selector: '#synthetic', maxChars: 1234 })).value.args.maxChars).toBe(1234);
    expect(await readdir(join(helperDir, 'ego/rounds'))).toEqual([]);
    await client.stop(); expect(await exited).toBe(0);
  });
});
describe('transport selection and launcher preparation', () => {
  it('falls back only after confirmed pre-execution elevated rejection and never replays uncertain work', async () => {
    for (const receipt of [
      { error: 'Elevated.', code: 'EGO_CLIENT_ELEVATED', uncertain: true },
      { error: 'Timeout.', code: 'EGO_COMMAND_TIMEOUT', uncertain: true },
      { error: 'User control.', code: 'EGO_TASK_SPACE_USER_IN_CONTROL', uncertain: false },
    ] satisfies BridgeReceipt[]) {
      let helperExecutions = 0;
      const automatic = new AutoBridge({ async run() { return receipt; } }, { async run() { helperExecutions++; return { value: null }; } }, 'auto', async () => false);
      expect(await automatic.run('tabs', identity)).toEqual(receipt); expect(helperExecutions).toBe(0);
    }
    const automatic = new AutoBridge({ async run() { return { error: 'Elevated.', code: 'EGO_CLIENT_ELEVATED', uncertain: false }; } }, { async run() { return { value: 'helper' }; } }, 'auto', async () => false);
    expect(await automatic.run('tabs', identity)).toEqual({ value: 'helper' }); expect(automatic.selected).toBe('helper');
  });
  it('validates bounded browser arguments shared by helper and direct transports', () => {
    expect(validateRequest('read', { ...identity, page: 'p1', maxChars: 1 }).args.maxChars).toBe(1);
    for (const [operation, args] of [ ['scroll', { ...identity, page: 'p1', deltaY: 100001 }], ['open', { ...identity, url: 'https://user:pass@news.example' }], ['evaluate', { ...identity, page: 'p1', expression: 'x'.repeat(100001) }], ['read', { ...identity, page: 'raw-page-id' }] ] as const) expect(() => validateRequest(operation, args)).toThrow();
    for (const [operation, fields] of [ ['click', { selector: '#synthetic' }], ['fill', { selector: '#synthetic', text: 'content' }], ['press', { selector: '#synthetic', key: 'Enter' }], ['scroll', { deltaY: 100 }], ['evaluate', { expression: 'document.title' }] ] as const) {
      expect(validateRequest(operation, { ...identity, page: 'p1', maxChars: 1000, ...fields }).args.maxChars).toBe(1000);
      expect(() => validateRequest(operation, { ...identity, page: 'p1', maxChars: 60001, ...fields })).toThrow();
    }
  });
  it('keeps the validated helper timeout separate from browser arguments for every request', () => {
    for (const timeoutMs of [5000, 45000, 120000]) {
      const request = validateHelperRequest({ operation: 'tabs', args: identity, timeoutMs });
      expect(request.timeoutMs).toBe(timeoutMs);
      expect(request.args).not.toHaveProperty('timeoutMs');
    }
    for (const timeoutMs of [undefined, 4999, 120001, 5000.5, NaN, Infinity, '5000']) expect(() => validateHelperRequest({ operation: 'tabs', args: identity, timeoutMs })).toThrow();
    expect(() => validateHelperRequest({ operation: 'tabs', args: { ...identity, timeoutMs: 5000 }, timeoutMs: 5000 })).toThrow();
  });
  it('writes executable macOS and encoded Windows launchers with quoted paths without starting either', async () => {
    const base = await directory(), dir = join(base, "Space's folder $()"), executable = "/synthetic/browser's path $()";
    const mac = await prepareHelperLauncher(dir, executable, 'darwin');
    const shell = await readFile(mac.launcherFile, 'utf8');
    expect(shell).toContain("'/synthetic/browser'\\''s path $()'");
    expect(shell).toContain('umask 077');
    expect((await stat(mac.launcherFile)).mode & 0o777).toBe(0o700);
    const windows = await prepareHelperLauncher(dir, executable, 'win32');
    const command = await readFile(windows.launcherFile, 'utf8'), encoded = command.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)![1];
    const powershell = Buffer.from(encoded, 'base64').toString('utf16le');
    expect(powershell).toContain("browser''s path $()");
    expect(powershell).toContain('WindowsBuiltInRole]::Administrator');
    expect(powershell).toContain('dist/ego-helper.mjs');
  });
});

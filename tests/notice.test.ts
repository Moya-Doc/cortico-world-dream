import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorldHost } from 'cortico/core/types.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { DreamNotice, DREAM_VERSION } from '../src/notice.ts';
import { DREAM } from '../src/definition.ts';
import { DreamWorld } from '../src/world.ts';
import { RealHost } from './helpers/real-host.ts';

/** Delayed rendering and persistence use the same order as the host's event delivery. */
class DeliveryHost extends RealHost {
  queue: Parameters<WorldHost['pushDeferred']>[0][] = [];
  pushDeferred(event?: Parameters<WorldHost['pushDeferred']>[0]): void { if (event) this.queue.push(event); }
  async deliver(): Promise<void> {
    const events = this.queue.splice(0);
    for (const event of events) {
      const rendered = await event.render();
      if (rendered === null) continue;
      await this.pushEvent({ ...event, source: 'dream', ts: new Date().toISOString(),
        text: typeof rendered === 'string' ? rendered : rendered.text });
    }
  }
}
let dir: string;
let host: DeliveryHost;
const awake = () => true;
const state = () => JSON.parse(readFileSync(join(dir, 'notice.json'), 'utf8'));
const notices = () => host.store.range({ source: 'dream' }).filter(e => ['dream.introduced', 'dream.updated'].includes(e.type));
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dream-notice-')); host = new DeliveryHost(join(dir, 'events')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('Dream release notices', () => {
  it('introduces first activation once and records the version only on rendering', async () => {
    const notice = new DreamNotice(dir); notice.start();
    notice.offer(host, awake); notice.offer(host, awake);
    expect(state().lastNotifiedVersion).toBeNull(); expect(notices()).toEqual([]);
    await host.deliver();
    expect(notices().map(e => e.type)).toEqual(['dream.introduced']);
    expect(state().lastNotifiedVersion).toBe(DREAM_VERSION);
    notice.offer(host, awake); await host.deliver();
    const restarted = new DreamNotice(dir); restarted.start(); restarted.offer(host, awake); await host.deliver();
    expect(notices()).toHaveLength(1);
  });
  it('retains first-use identity across a restart before delivery even after an archive appears', async () => {
    const first = new DreamNotice(dir); first.start(); first.offer(host, awake); first.stop();
    writeFileSync(join(dir, 'archive.json'), '{}');
    const next = new DreamNotice(dir); next.start(); next.offer(host, awake); await host.deliver();
    expect(notices().map(e => e.type)).toEqual(['dream.introduced']);
  });
  it.each(['archive.json', 'state.json'])('treats existing %s without notice state as an upgrade', async file => {
    writeFileSync(join(dir, file), '{}');
    const notice = new DreamNotice(dir); notice.start(); notice.offer(host, awake); await host.deliver();
    expect(notices()[0].type).toBe('dream.updated');
    expect(notices()[0].text).toContain('no recorded notice version');
  });
  it('combines missed release summaries and does not replay them after downgrade and return', async () => {
    writeFileSync(join(dir, 'notice.json'), JSON.stringify({ schema: 1, lastNotifiedVersion: '0.12.0' }));
    const next = new DreamNotice(dir, '0.12.3'); next.start(); next.offer(host, awake); await host.deliver();
    expect(notices()[0].text).toContain('30 days'); expect(notices()[0].text).toContain('QQ ProMAX');
    for (const v of ['0.12.1', '0.12.3']) { const n = new DreamNotice(dir, v); n.start(); n.offer(host, awake); await host.deliver(); }
    expect(notices()).toHaveLength(1); expect(state().lastNotifiedVersion).toBe('0.12.3');
  });
  it('waits while sleeping and rechecks sleep if it changes after queuing', async () => {
    const notice = new DreamNotice(dir); notice.start(); let ready = false;
    notice.offer(host, () => ready); await host.deliver(); expect(notices()).toEqual([]);
    ready = true; notice.offer(host, () => ready); ready = false; await host.deliver();
    expect(state().lastNotifiedVersion).toBeNull();
    ready = true; notice.offer(host, () => ready); await host.deliver(); expect(notices()).toHaveLength(1);
  });
  it('discards a callback from an old lifecycle without cancelling a newly queued notice', async () => {
    const notice = new DreamNotice(dir); notice.start(); notice.offer(host, awake);
    notice.stop(); notice.start(); notice.offer(host, awake);
    await host.deliver(); expect(notices()).toHaveLength(1);
  });
  it('retries delivery if the transport rejected the queue', async () => {
    const notice = new DreamNotice(dir); notice.start();
    const rejected = { pushDeferred: () => { throw new Error('queue unavailable'); } } as unknown as WorldHost;
    expect(() => notice.offer(rejected, awake)).toThrow('queue unavailable');
    notice.offer(host, awake); await host.deliver(); expect(notices()).toHaveLength(1);
  });
  it('does not mark a notice delivered when state persistence fails', async () => {
    const notice = new DreamNotice(dir); notice.start(); notice.offer(host, awake);
    rmSync(join(dir, 'notice.json')); mkdirSync(join(dir, 'notice.json'));
    await expect(host.deliver()).rejects.toThrow(); expect(notices()).toEqual([]);
    rmSync(join(dir, 'notice.json'), { recursive: true });
    notice.offer(host, awake); await host.deliver(); expect(notices()).toHaveLength(1);
  });
  it('rejects damaged notice metadata rather than replaying an introduction', () => {
    writeFileSync(join(dir, 'notice.json'), '{"schema":1,"lastNotifiedVersion":"invalid"}');
    expect(() => new DreamNotice(dir).start()).toThrow('Invalid dream notice.json');
  });
  it('does not announce development version identifiers', async () => {
    const notice = new DreamNotice(dir, 'dev'); notice.start(); notice.offer(host, awake); await host.deliver();
    expect(notices()).toEqual([]); expect(existsSync(join(dir, 'notice.json'))).toBe(false);
  });
});

describe('Dream World notification lifecycle', () => {
  it('leaves a pending notice out of the environment and defers it across sleep until waking', async () => {
    const context = fakeWorldContext(DREAM, { scratchDir: dir });
    context.cfg.dreamMode = 'probability'; context.cfg.dreamProbability = 0;
    const world = new DreamWorld({ context, pollMs: 100000 });
    try {
      await world.start(host);
      await world.sleep(10); await host.deliver(); expect(notices()).toEqual([]);
      expect(Object.keys(world.envPromptVars()).sort()).toEqual(['dream.index', 'dream.state']);
      await world.wake(); await world.tick(); await host.deliver();
      expect(notices().map(e => e.type)).toEqual(['dream.introduced']);
      await world.tick(); await host.deliver(); expect(notices()).toHaveLength(1);
    } finally { await world.stop(); }
  });
  it('never delivers an introduction after World shutdown', async () => {
    const context = fakeWorldContext(DREAM, { scratchDir: dir });
    const world = new DreamWorld({ context, pollMs: 100000 });
    await world.start(host); await world.stop(); await host.deliver(); expect(notices()).toEqual([]);
  });
});

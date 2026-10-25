import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlEventStore } from 'cortico/core/event-store.ts';
import type { EventEnvelope, PushOptions } from 'cortico/core/types.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { DREAM } from '../src/definition.ts';
import { DreamWorld } from '../src/world.ts';
import type { SearchClient, SearchResult } from '../src/search.ts';
import { FakeHost } from './helpers/fake-host.ts';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class RuntimeHost extends FakeHost {
  override store: JsonlEventStore;
  private gates: Array<{ type: string; entered: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> }> = [];
  constructor(dataDir: string) {
    super();
    this.store = new JsonlEventStore({ dataDir, run: 'r-20261024-120000-race', timezone: 'UTC' });
  }
  deferNext(type: string) {
    const gate = { type, entered: deferred<void>(), release: deferred<void>() };
    this.gates.push(gate);
    return gate;
  }
  releaseAll(): void { for (const gate of this.gates) gate.release.resolve(); }
  override async pushEvent(event: Omit<EventEnvelope, 'cursor'>, options?: PushOptions): Promise<EventEnvelope> {
    const full = this.store.append(event);
    this.events.push(full);
    this.pushOpts.push(options);
    const gate = this.gates.find((item) => item.type === event.type);
    if (gate) {
      gate.type = '';
      gate.entered.resolve();
      await gate.release.promise;
    }
    return full;
  }
  message(text: string, now: number): EventEnvelope {
    return this.store.append({
      source: 'desktop-pet', type: 'desktop-pet.message', origin: 'external',
      senderKey: 'operator', text, ts: new Date(now).toISOString(), meta: { text },
    });
  }
}

const fixtures: Array<{ world: DreamWorld; host: RuntimeHost; dir: string }> = [];
afterEach(async () => {
  for (const { world, host, dir } of fixtures.splice(0)) {
    host.releaseAll();
    await world.stop();
    await setImmediate();
    rmSync(dir, { recursive: true, force: true });
  }
});

const news: SearchResult[] = [{ title: 'A public observatory opens', url: 'https://news.example/observatory', content: 'The observatory held its opening today.' }];
async function fixture(search?: SearchClient) {
  const dir = mkdtempSync(join(tmpdir(), 'cortico-dream-races-'));
  const context = { ...fakeWorldContext(DREAM, { scratchDir: dir }), timezone: 'UTC' };
  context.secret = () => 'fixture-key'; context.cfg.collectorOrder = ['tavily'];
  const now = Date.parse('2026-10-24T12:00:00.000Z');
  const host = new RuntimeHost(context.dataDir);
  const world = new DreamWorld({ context, now: () => now, pollMs: 60_000,
    search: search ?? { async search() { return structuredClone(news); }, async close() {} },
  });
  fixtures.push({ world, host, dir });
  await world.start(host);
  const invoke = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
    const result = await world.tools().find((tool) => tool.name === name)!.handler(args, { role: 'main', log: host.log, signal });
    return JSON.parse(typeof result === 'string' ? result : result.text);
  };
  return { world, host, now, context, invoke };
}

describe('Sleep and dream transition races', () => {
  it('does not start a dream when waking supersedes a sleeping event in flight', async () => {
    const { world, host } = await fixture();
    const gate = host.deferNext('dream.sleeping');
    const sleeping = world.sleep(10);
    await gate.entered.promise;
    await world.wake();
    gate.release.resolve();
    await sleeping;
    expect(world.state()).toMatchObject({ sleeping: false, dreaming: false });
    expect(host.events.filter((event) => event.type === 'dream.requested')).toHaveLength(0);
  });

  it('does not recreate a cycle after stopping during sleep event delivery', async () => {
    const { world, host } = await fixture();
    const gate = host.deferNext('dream.sleeping');
    const sleeping = world.sleep(10);
    await gate.entered.promise;
    await world.stop();
    gate.release.resolve();
    await sleeping;
    expect(world.state().dreaming).toBe(false);
    expect(host.events.filter((event) => event.type === 'dream.requested')).toHaveLength(0);
  });

  it('keeps the newer sleep deadline and creates only its dream when deliveries overlap', async () => {
    const { world, host, now } = await fixture();
    const gate = host.deferNext('dream.sleeping');
    const older = world.sleep(10);
    await gate.entered.promise;
    await world.sleep(20);
    const newerCycle = world.state().cycleId;
    gate.release.resolve();
    await older;
    expect(world.state()).toMatchObject({
      sleeping: true, dreaming: true, cycleId: newerCycle,
      sleepUntil: new Date(now + 20 * 60_000).toISOString(),
    });
    expect(host.events.filter((event) => event.type === 'dream.requested')).toHaveLength(1);
  });

  it('does not let older queued chat undo a newer sleep command already applied by a tool', async () => {
    const { world, host, now, invoke } = await fixture();
    host.message('Hello before sleep', now);
    const sleep = host.message('sleep 20 minutes', now);
    await invoke('dream_sleep', { eventCursor: sleep.cursor });
    const active = world.state().cycleId;
    await world.tick();
    expect(world.state()).toMatchObject({ sleeping: true, dreaming: true, cycleId: active });
    expect(host.events.filter((event) => event.type === 'dream.requested')).toHaveLength(1);
  });

  it('does not resume processing the rest of an incoming batch after the World stops', async () => {
    const { world, host, now } = await fixture();
    host.message('sleep 10 minutes', now);
    host.message('Hello after sleep', now);
    const gate = host.deferNext('dream.sleeping');
    const ticking = world.tick();
    await gate.entered.promise;
    await world.stop();
    gate.release.resolve();
    await expect(ticking).resolves.toBeUndefined();
    expect(world.state().dreaming).toBe(false);
  });

  it('drains a message arriving during an active tick before committing collected material', async () => {
    const received = deferred<SearchResult[]>();
    const { world, host, now, invoke } = await fixture({ search: async () => received.promise, async close() {} });
    await world.webUi().invoke!('dream', 'addMaterial', ['A public observatory']);
    const material = world.state().materials[0];
    const gate = host.deferNext('dream.requested');
    host.message('sleep 10 minutes', now);
    const ticking = world.tick();
    await gate.entered.promise;
    const searching = invoke('dream_search', { cycleId: world.state().cycleId, query: material.topic, materialId: material.id });
    const outcome = searching.then(() => 'committed', () => 'cancelled');
    host.message('Hello again', now);
    received.resolve(news);
    await setImmediate();
    gate.release.resolve();
    await ticking;
    expect(await outcome).toBe('cancelled');
    expect(world.state()).toMatchObject({ sleeping: false, dreaming: false, dreams: [] });
    expect(world.state().materials[0].lastProcessedDate).toBeNull();
  });

  it('waits for an active tick and gives cancellation precedence over record validation', async () => {
    const { world, host, now, invoke } = await fixture();
    const gate = host.deferNext('dream.requested');
    host.message('sleep 10 minutes', now);
    const ticking = world.tick();
    await gate.entered.promise;
    host.message('Wake up please', now);
    let settled = false;
    const outcome = invoke('dream_record', { cycleId: world.state().cycleId, title: 'A floating observatory', text: 'An observatory floated across the sky.', sourceIds: [] })
      .then(() => { settled = true; return ''; }, (error: Error) => { settled = true; return error.message; });
    await setImmediate();
    expect(settled).toBe(false);
    gate.release.resolve();
    await ticking;
    expect(await outcome).toMatch(/no longer active/i);
    expect(world.state().dreams).toEqual([]);
  });

  it('rejects a late collection result when the tool call was aborted', async () => {
    const received = deferred<SearchResult[]>();
    const { world, invoke } = await fixture({ search: async () => received.promise, async close() {} });
    await world.webUi().invoke!('dream', 'addMaterial', ['A public observatory']);
    await world.sleep(10);
    const material = world.state().materials[0];
    const controller = new AbortController();
    const outcome = invoke('dream_search', { cycleId: world.state().cycleId, query: material.topic, materialId: material.id }, controller.signal)
      .then(() => 'committed', () => 'cancelled');
    controller.abort();
    received.resolve(news);
    expect(await outcome).toBe('cancelled');
    expect(world.state().materials[0].lastProcessedDate).toBeNull();
    expect(world.state().dreams).toEqual([]);
  });
});

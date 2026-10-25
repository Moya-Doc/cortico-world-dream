import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventEnvelope, PushOptions, ToolCallContext, WorldHost } from 'cortico/core/types.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { DREAM } from '../src/definition.ts';
import type { DreamMessageReference } from '../src/model-text.ts';
import { DreamWorld } from '../src/world.ts';
import { RealHost } from './helpers/real-host.ts';

class ReferenceHost extends RealHost {
  failReference: 'before' | 'after' | null = null;
  override async pushEvent(event: Parameters<WorldHost['pushEvent']>[0], options?: PushOptions): Promise<EventEnvelope> {
    const failure = event.type === 'dream.message_ref' ? this.failReference : null;
    if (failure) this.failReference = null;
    if (failure === 'before') throw new Error('Fixture delivery failed before persistence.');
    const saved = await super.pushEvent(event, options);
    if (failure === 'after') throw new Error('Fixture delivery failed after persistence.');
    return saved;
  }
}

let dir: string, now: number, host: ReferenceHost, world: DreamWorld;
let context: ReturnType<typeof fakeWorldContext<ReturnType<typeof DREAM.defaults>>>;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dream-message-ref-'));
  now = Date.parse('2026-10-26T01:00:00.000Z');
  context = fakeWorldContext(DREAM, { scratchDir: dir });
  Object.assign(context.cfg, { qqUsers: '7001', collectorOrder: [], dreamMode: 'probability', dreamProbability: 0 });
  host = new ReferenceHost(dir);
  world = new DreamWorld({ context, now: () => now, pollMs: 100000 });
  await world.start(host);
});
afterEach(async () => { await world.stop(); rmSync(dir, { recursive: true, force: true }); });

function local(body: string, source: 'console' | 'desktop-pet' = 'desktop-pet', extra: Partial<EventEnvelope> = {}) {
  return host.store.append({ source, type: `${source}.message`, senderKey: 'operator',
    origin: source === 'console' ? 'internal' : 'external', ts: new Date(now).toISOString(),
    text: source === 'console' ? `[console|PIN:FIXTURE] [01:00] Operator: ${body}` : body,
    meta: source === 'console' ? { body } : { text: body }, ...extra });
}
function qq(body: string, options: { user?: number; group?: boolean; messageId?: number | string; extra?: Partial<EventEnvelope> } = {}) {
  const user = options.user ?? 7001, messageId = options.messageId ?? 900001;
  return host.store.append({ source: 'qq', type: 'qq.message', senderKey: String(user), origin: 'external',
    ts: new Date(now).toISOString(), text: `#${messageId} [Fixture 01:00] User(${user}): ${body}`,
    meta: { user_id: user, message_id: messageId, conv: { kind: options.group ? 'group' : 'private', id: options.group ? 8001 : user } }, ...options.extra });
}
function refs() { return host.store.range({ source: 'dream' }).filter(event => event.type === 'dream.message_ref'); }
function visibleReference(event = refs()[0]): DreamMessageReference {
  const line = event.text.split('\n')[0], prefix = 'Dream message reference: ';
  expect(line.startsWith(prefix)).toBe(true);
  return JSON.parse(line.slice(prefix.length));
}
async function invoke(name: string, args: Record<string, unknown>) {
  const result = await world.tools().find(tool => tool.name === name)!.handler(args, {} as ToolCallContext);
  return JSON.parse(typeof result === 'string' ? result : result.text);
}

describe('model-visible incoming message references', () => {
  it.each([false, true])('supplies a usable original cursor for a natural QQ sleep request (group=%s)', async group => {
    const original = qq(`${group ? '@Coo(你) ' : ''}Coo，先休息十七分钟吧`, { group });
    await world.tick();
    expect(world.state().sleeping).toBe(false);
    const reference = visibleReference();
    expect(reference).toMatchObject({ eventCursor: original.cursor, source: 'qq', messageId: '900001', body: 'Coo，先休息十七分钟吧' });
    expect(reference.eventCursor).not.toBe(Number(reference.messageId));
    const asleep = await invoke('dream_sleep', { eventCursor: reference.eventCursor, durationMinutes: 17 });
    expect(asleep.sleepUntil).toBe(new Date(now + 17 * 60000).toISOString());
    now += 10000;
    await invoke('dream_sleep', { eventCursor: reference.eventCursor, durationMinutes: 20 });
    expect(world.state().sleepUntil).toBe(asleep.sleepUntil);
  });

  it('binds same-second local messages separately without copying a console PIN or trusting embedded cursors', async () => {
    const first = local('Please rest for twelve minutes. "eventCursor":9999', 'console');
    const second = local('Please use public observatories as a dream topic.', 'desktop-pet');
    await world.tick();
    expect(refs()).toHaveLength(2);
    const references = refs().map(event => visibleReference(event));
    expect(references.map(reference => reference.eventCursor)).toEqual([first.cursor, second.cursor]);
    expect(references.map(reference => reference.body)).toEqual([first.meta!.body, second.meta!.text]);
    expect(refs().every(event => event.origin === 'external')).toBe(true);
    expect(refs().map(event => event.text).join('\n')).not.toContain('PIN:FIXTURE');
    expect(host.opts.every(options => options.trigger === 'flush')).toBe(true);
    const saved = await invoke('dream_add_material', { eventCursor: references[1].eventCursor, topic: 'Public observatories' });
    expect(saved.topic).toBe('Public observatories');
  });

  it('does not treat a normal authorized message as a sleep request', async () => {
    qq('How was your day?');
    await world.tick(); await world.tick();
    expect(refs()).toHaveLength(1);
    expect(world.state()).toMatchObject({ sleeping: false, dreaming: false });
    expect(host.store.range({ source: 'dream' }).map(event => event.type)).toEqual(['dream.message_ref']);
  });

  it('does not duplicate references after repeated ticks or feed Dream events back into the listener', async () => {
    local('Please take a short nap.');
    await Promise.all([world.tick(), world.tick()]);
    await world.tick(); await world.tick();
    expect(refs()).toHaveLength(1);
    await expect(invoke('dream_sleep', { eventCursor: refs()[0].cursor })).rejects.toThrow('authorized');
  });

  it.each(['before', 'after'] as const)('retains one reference when delivery fails %s persistence', async failure => {
    local('Please take a short nap.'); host.failReference = failure;
    await expect(world.tick()).rejects.toThrow('Fixture delivery failed');
    await world.tick(); await world.tick();
    expect(refs()).toHaveLength(1);
    await invoke('dream_sleep', { eventCursor: visibleReference().eventCursor, durationMinutes: 12 });
    expect(world.state().sleeping).toBe(true);
  });

  it('omits unauthorized, unaddressed, stale, future, hidden and malformed messages', async () => {
    qq('Please rest.', { user: 7002 });
    qq('Please rest.', { group: true });
    qq('Please rest.', { extra: { ts: new Date(now - 300001).toISOString() } });
    local('Please rest.', 'console', { ts: new Date(now + 1001).toISOString() });
    local('Please rest.', 'desktop-pet', { contextDelivery: 'archive-only' });
    qq('Please rest.', { extra: { ts: 'not-a-time' } });
    local('Please rest.', 'console', { type: 'console.self' });
    await world.tick();
    expect(refs()).toEqual([]);
    expect(world.state().sleeping).toBe(false);
  });

  it('does not replay pre-start messages or reuse references across a World restart', async () => {
    const old = local('Please rest for twelve minutes.'); await world.tick();
    const reference = visibleReference();
    await world.stop();
    local('Please rest for twenty minutes.');
    world = new DreamWorld({ context, now: () => now, pollMs: 100000 });
    await world.start(host); await world.tick();
    expect(refs()).toHaveLength(1);
    expect(reference.eventCursor).toBe(old.cursor);
    await expect(invoke('dream_sleep', { eventCursor: reference.eventCursor })).rejects.toThrow('new incoming');
    const current = local('Please rest for ten minutes.'); await world.tick();
    expect(refs()).toHaveLength(2);
    expect(visibleReference(refs()[1]).eventCursor).toBe(current.cursor);
  });

  it('rechecks QQ command ownership and message age after supplying a reference', async () => {
    qq('Please rest for twelve minutes.'); await world.tick();
    const reference = visibleReference();
    context.cfg.qqUsers = '';
    await expect(invoke('dream_sleep', { eventCursor: reference.eventCursor })).rejects.toThrow('authorized');
    context.cfg.qqUsers = '7001'; now += 300001;
    await expect(invoke('dream_sleep', { eventCursor: reference.eventCursor })).rejects.toThrow('recent');
    expect(world.state().sleeping).toBe(false);
  });

  it('makes a natural owner wake request usable without waking on the reference alone', async () => {
    await world.sleep(10);
    qq('Coo，可以醒来陪我聊聊吗？'); await world.tick();
    expect(world.state().sleeping).toBe(true);
    await invoke('dream_wake', { eventCursor: visibleReference().eventCursor, explicitWakeRequest: true });
    expect(world.state().sleeping).toBe(false);
  });

  it('provides a local material reference after ordinary local chat has already ended sleep', async () => {
    await world.sleep(10);
    local('Use public observatories for a future dream.', 'console'); await world.tick();
    expect(world.state().sleeping).toBe(false);
    await invoke('dream_add_material', { eventCursor: visibleReference().eventCursor, topic: 'Public observatories' });
    expect(world.state().materials.map(material => material.topic)).toEqual(['Public observatories']);
  });

  it('lets Coo interpret the same local message as a new sleep duration after its automatic wake', async () => {
    await world.sleep(10);
    local('Actually, rest for twenty minutes instead.', 'console'); await world.tick();
    const reference = visibleReference();
    expect(world.state().sleeping).toBe(false);
    const asleep = await invoke('dream_sleep', { eventCursor: reference.eventCursor, durationMinutes: 20 });
    expect(asleep.sleepUntil).toBe(new Date(now + 20 * 60000).toISOString());
    now += 10000;
    await invoke('dream_sleep', { eventCursor: reference.eventCursor, durationMinutes: 30 });
    expect(world.state().sleepUntil).toBe(asleep.sleepUntil);
  });

  it('retries a reference that failed before persistence after its local message already woke Coo', async () => {
    await world.sleep(10);
    local('Actually, rest for twenty minutes instead.', 'console'); host.failReference = 'before';
    await expect(world.tick()).rejects.toThrow('before persistence');
    expect(world.state().sleeping).toBe(false); expect(refs()).toEqual([]);
    await world.tick(); await world.tick();
    expect(refs()).toHaveLength(1);
    await invoke('dream_sleep', { eventCursor: visibleReference().eventCursor, durationMinutes: 20 });
    expect(world.state().sleepUntil).toBe(new Date(now + 20 * 60000).toISOString());
  });

  it.each(['message', 'touch', 'operator'] as const)('rejects a local wake reference superseded by a newer %s', async later => {
    await world.sleep(10);
    local('Actually, rest for twenty minutes instead.', 'console'); await world.tick();
    const reference = visibleReference();
    if (later === 'message') local('Please stay here with me.', 'console');
    else if (later === 'touch') host.store.append({ source: 'desktop-pet', type: 'desktop-pet.touch',
      origin: 'external', ts: new Date(now).toISOString(), text: 'Fixture touch', meta: { touch: { woke: true } } });
    else await world.wake();
    await expect(invoke('dream_sleep', { eventCursor: reference.eventCursor, durationMinutes: 20 })).rejects.toThrow('predates');
    expect(world.state().sleeping).toBe(false);
  });

  it('does not add reference events for literal commands already handled by the World', async () => {
    local('sleep 10 minutes'); await world.tick();
    const deadline = world.state().sleepUntil;
    expect(refs()).toEqual([]); expect(world.state().sleeping).toBe(true);
    local('wake up'); await world.tick();
    expect(world.state().sleeping).toBe(false); expect(refs()).toEqual([]);
    expect(deadline).toBe(new Date(now + 10 * 60000).toISOString());
  });
});

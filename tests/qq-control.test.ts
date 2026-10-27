import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PushOptions, ToolCallContext, WorldHost } from 'cortico/core/types.ts';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { DREAM } from '../src/definition.ts';
import { DreamWorld } from '../src/world.ts';
import { RealHost } from './helpers/real-host.ts';

type Variant = 'base' | 'final' | 'promax';
let dir: string, now: number, host: RealHost, world: DreamWorld;
let context: ReturnType<typeof fakeWorldContext<ReturnType<typeof DREAM.defaults>>>;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dream-qq-control-')); now = Date.parse('2026-10-27T01:00:00Z');
  host = new RealHost(dir); context = fakeWorldContext(DREAM, { scratchDir: dir });
  Object.assign(context.cfg, { qqUsers: '7001', collectorOrder: [], dreamMode: 'probability', dreamProbability: 0 });
  world = new DreamWorld({ context, now: () => now, pollMs: 100000 }); await world.start(host);
});
afterEach(async () => { await world.stop(); rmSync(dir, { recursive: true, force: true }); });

function incoming(variant: Variant, body: string, options: {
  user?: number; group?: boolean; mention?: boolean; id?: string; ts?: string; meta?: Record<string, unknown>; type?: string;
} = {}) {
  const user = options.user ?? 7001, kind = options.group ? 'group' : 'private', targetId = options.group ? 8001 : user;
  const id = options.id ?? String(10000 + host.store.latestCursor()), ts = options.ts ?? new Date(now).toISOString();
  const text = options.mention ? `${variant === 'base' ? '@Coo(你)' : '@我'} ${body}` : body;
  const sender = `User(QQ:${user})`;
  const prefix = kind === 'private' ? `【QQ私聊 01:00 ${sender}】` : variant === 'final'
    ? `【QQ群 Fixture（群号 ${targetId}） 01:00】${sender}` : `【QQ群 ${targetId} 01:00】Fixture ${sender}`;
  const raw = host.store.append({ source: variant === 'base' ? 'qq' : 'qqbot', type: options.type ?? 'qq.message', origin: 'external',
    senderKey: variant === 'base' ? String(user) : `${kind}:${targetId}`, ts,
    text: variant === 'base' ? `#${id} [Fixture 01:00] User(${user}): ${text}` : `${prefix}：#${id} ${text}`,
    ...(variant === 'promax' ? { contextDelivery: 'archive-only' as const } : {}),
    meta: variant === 'base' ? { user_id: user, message_id: id, conv: { kind, id: targetId }, ...options.meta }
      : { user, conv: `${kind}:${targetId}`, platformMessageId: id, atMe: options.mention ?? false, sender,
        ...(variant === 'promax' ? { sourceTs: ts, channel: 'qq', inputRejected: false } : {}), ...options.meta },
  });
  if (variant !== 'promax') return { raw, delivered: raw };
  const delivered = host.store.append({ source: 'qqbot', type: raw.type, origin: 'external', senderKey: raw.senderKey,
    ts: new Date(now).toISOString(), text: `【原消息时间 ${ts}】\n${raw.text}`,
    meta: { ...raw.meta, sourceTs: ts, sourceCursor: raw.cursor, replyAllowed: true } });
  return { raw, delivered };
}
const events = (type: string) => host.store.range({ source: 'dream' }).filter(event => event.type === `dream.${type}`);
async function invoke(name: string, args: Record<string, unknown>) {
  const result = await world.tools().find(tool => tool.name === name)!.handler(args, {} as ToolCallContext);
  return JSON.parse(typeof result === 'string' ? result : result.text);
}
function ref() { return JSON.parse(events('message_ref').at(-1)!.text.split('\n')[0]!.slice('Dream message reference: '.length)); }

describe.each<Variant>(['base', 'final', 'promax'])('%s QQ control with the real event store', variant => {
  it('accepts owner private sleep and wake, and explicit group wake mentions', async () => {
    incoming(variant, '睡觉十分钟'); await world.tick();
    expect(world.state().sleepUntil).toBe(new Date(now + 600000).toISOString());
    incoming(variant, '醒来'); await world.tick(); expect(world.state().sleeping).toBe(false);
    await world.sleep(); incoming(variant, '醒来', { group: true, mention: true }); await world.tick();
    expect(world.state().sleeping).toBe(false); expect(events('sleep_reply')).toEqual([]);
  });
  it('keeps sleep for nonowners, unaddressed owner commands and ordinary mentions', async () => {
    await world.sleep(); const until = world.state().sleepUntil;
    incoming(variant, '醒来', { user: 7002 }); incoming(variant, '醒来', { group: true });
    incoming(variant, '你好'); incoming(variant, '你好', { group: true, mention: true });
    incoming(variant, '醒来', { user: 7002, group: true, mention: true }); await world.tick();
    expect(world.state().sleepUntil).toBe(until); expect(events('sleep_reply')).toHaveLength(2);
    const outsider = incoming(variant, '请结束休息', { user: 7002, group: true, mention: true });
    await expect(invoke('dream_wake', { eventCursor: outsider.raw.cursor, explicitWakeRequest: true })).rejects.toThrow('authorized');
  });
  it('exposes original message coordinates and rechecks natural-language command authority', async () => {
    const request = incoming(variant, 'Coo，请休息十七分钟'); await world.tick();
    expect(ref()).toMatchObject({ eventCursor: request.raw.cursor, ts: request.raw.ts, messageId: String(request.raw.meta![variant === 'base' ? 'message_id' : 'platformMessageId']),
      source: request.raw.source, target: 'private:7001', senderId: '7001' });
    await invoke('dream_sleep', { eventCursor: ref().eventCursor, durationMinutes: 17 });
    expect(world.state().sleepUntil).toBe(new Date(now + 17 * 60000).toISOString());
    incoming(variant, '你好', { group: true, mention: true }); await world.tick();
    await expect(invoke('dream_wake', { eventCursor: ref().eventCursor })).rejects.toThrow('explicit owner wake');
    incoming(variant, '请结束休息', { group: true, mention: true }); await world.tick();
    await invoke('dream_wake', { eventCursor: ref().eventCursor, explicitWakeRequest: true }); expect(world.state().sleeping).toBe(false);
    incoming(variant, '请记录公开的天文新闻'); await world.tick();
    await invoke('dream_add_material', { eventCursor: ref().eventCursor, topic: 'Public observatories' });
    expect(world.state().materials[0]?.topic).toBe('Public observatories');
  });
  it('never restarts sleep or emits another sleep reply for a duplicate platform message', async () => {
    incoming(variant, '睡觉十分钟', { id: '12001' }); await world.tick(); const until = world.state().sleepUntil;
    now += 10000; const duplicate = incoming(variant, '睡觉十分钟', { id: '12001' }); await world.tick();
    expect(world.state().sleepUntil).toBe(until); expect(events('sleeping')).toHaveLength(1);
    await expect(invoke('dream_sleep', { eventCursor: duplicate.raw.cursor })).rejects.toThrow('authorized');
    incoming(variant, '你好', { group: true, mention: true, id: '12002' }); await world.tick();
    incoming(variant, '你好', { group: true, mention: true, id: '12002' }); await world.tick();
    expect(events('sleep_reply')).toHaveLength(1);
    await world.stop(); world = new DreamWorld({ context, now: () => now, pollMs: 100000 }); await world.start(host);
    incoming(variant, '睡觉十分钟', { id: '12001' }); await world.tick(); expect(world.state().sleepUntil).toBe(until);
  });
  it('rejects stale, historical, self, aggregate and unverifiable messages in tools and scanning', async () => {
    const invalid = [
      incoming(variant, '睡觉', { ts: new Date(now - 300001).toISOString() }),
      incoming(variant, '睡觉', { meta: { history: true } }),
      incoming(variant, '睡觉', { meta: { self: true } }),
      incoming(variant, '睡觉', { meta: variant === 'base' ? { message_id: '' } : { platformMessageId: '' } }),
      incoming(variant, '睡觉', { meta: variant === 'base' ? { user_id: undefined } : { user: undefined } }),
    ];
    if (variant !== 'base') invalid.push(incoming(variant, '睡觉', { meta: { sender: '对话' } }));
    await world.tick(); expect(world.state().sleeping).toBe(false); expect(events('message_ref')).toEqual([]);
    for (const item of invalid) await expect(invoke('dream_sleep', { eventCursor: item.raw.cursor })).rejects.toThrow('authorized');
  });
  it('does not treat space comments or posting requests as chat even with a chat-like source', async () => {
    incoming(variant, '睡觉', { type: 'qq.qzone.comment' });
    host.store.append({ source: variant === 'base' ? 'qq' : 'qqbot', type: 'qq.message', origin: 'external',
      senderKey: 'qzone', ts: new Date(now).toISOString(), text: '睡觉', meta: { kind: 'qzone_interact', user: 7001 } });
    host.store.append({ source: 'qqbot', type: 'qq.qzone.request', origin: 'internal', senderKey: 'qzone', ts: new Date(now).toISOString(), text: '睡觉' });
    await world.tick(); expect(world.state().sleeping).toBe(false); expect(events('message_ref')).toEqual([]);
    await world.sleep(); incoming(variant, '醒来', { group: true, mention: true, type: 'qq.qzone.comment' }); await world.tick();
    expect(world.state().sleeping).toBe(true); expect(events('sleep_reply')).toEqual([]);
  });
});

it('requires a delivered, fresh ProMAX original before tools may use an archive cursor', async () => {
  const pair = incoming('promax', '请休息一下');
  const { cursor: _cursor, ...copy } = pair.delivered;
  const duplicate = host.store.append(copy);
  await world.tick(); expect(events('message_ref')).toHaveLength(1);
  await invoke('dream_sleep', { eventCursor: pair.raw.cursor }); expect(world.state().sleeping).toBe(true);
  const until = world.state().sleepUntil;
  now += 10000; await invoke('dream_sleep', { eventCursor: pair.delivered.cursor });
  expect(world.state().sleepUntil).toBe(until);
  await expect(invoke('dream_sleep', { eventCursor: duplicate.cursor })).rejects.toThrow('authorized');
});

it.each<Variant>(['base', 'final', 'promax'])('rejects recalled %s requests when interpreting a previously delivered reference', async variant => {
  const message = incoming(variant, '请休息一下'); await world.tick();
  host.store.append({ source: message.raw.source, type: 'qq.recall', origin: 'external', senderKey: 'private:7001',
    ts: new Date(now).toISOString(), text: 'A message was recalled.', ...(variant === 'base'
      ? { meta: { message_id: message.raw.meta!.message_id, conv: { kind: 'private', id: 7001 } } } : {}) });
  await expect(invoke('dream_sleep', { eventCursor: message.raw.cursor })).rejects.toThrow('authorized');
  expect(world.state().sleeping).toBe(false);
});

it.each(['before', 'after'] as const)('keeps one sleep reply suggestion across a %s-persistence delivery failure', async failure => {
  await world.sleep(); incoming('promax', '你好', { group: true, mention: true });
  const push = host.pushEvent.bind(host); let failed = false;
  host.pushEvent = async (event: Parameters<WorldHost['pushEvent']>[0], options?: PushOptions) => {
    if (event.type === 'dream.sleep_reply' && !failed) {
      failed = true;
      if (failure === 'after') await push(event, options);
      throw new Error('Fixture failure');
    }
    return push(event, options);
  };
  await expect(world.tick()).rejects.toThrow('Fixture failure');
  await world.tick(); expect(events('sleep_reply')).toHaveLength(1);
});

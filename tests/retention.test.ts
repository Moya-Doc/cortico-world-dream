import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DREAM_MAX_ORDINARY_RECORDS, DREAM_RETENTION_MS, DreamArchive } from '../src/archive.ts';

let directory: string;
const now = Date.parse('2026-10-27T03:00:00.000Z');
const source = { title: 'A public observation', url: 'https://news.example.test/observation', content: 'A newly observed formation.' };
const storedDream = (id: string, createdAt = now) => ({ id, createdAt: new Date(createdAt).toISOString(),
  title: `Dream ${id}`, titleSource: 'summary', text: `The sky unfolded into ${id}.`, materialIds: [], sources: [source] });
const file = () => join(directory, 'archive.json');
function writeArchive(fields: Record<string, unknown>) {
  writeFileSync(file(), JSON.stringify({ version: 1, materials: [], dreams: [], ...fields }));
}
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'dream-retention-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

describe('ordinary dream retention', () => {
  it('normalizes old records to ordinary zero-score dreams without changing text, sources or the file on reads', () => {
    const old = storedDream('old');
    writeArchive({ dreams: [old] });
    const original = readFileSync(file(), 'utf8');
    const archive = new DreamArchive(directory);
    expect(archive.get(old.id)).toEqual({ ...old, score: 0, tier: 'ordinary', promotedAt: null });
    expect(archive.prune(now)).toEqual([]);
    expect(readFileSync(file(), 'utf8')).toBe(original);
    archive.append('Another dream.', [], [source], now, 'The glass sky');
    expect(new DreamArchive(directory).get(old.id)).toEqual({ ...old, score: 0, tier: 'ordinary', promotedAt: null });
    expect(JSON.parse(readFileSync(file(), 'utf8')).dreams[0]).toEqual(archive.get(old.id));
  });

  it('keeps the exact thirty-day boundary and expires it one millisecond later', () => {
    const archive = new DreamArchive(directory);
    const dream = archive.append('A boundary dream.', [], [source], now, 'The clock lake');
    expect(archive.prune(now + DREAM_RETENTION_MS)).toEqual([]);
    expect(archive.get(dream.id)).toBeDefined();
    expect(archive.prune(now + DREAM_RETENTION_MS + 1)).toEqual([dream.id]);
    expect(new DreamArchive(directory).get(dream.id)).toBeUndefined();
    expect(archive.prune(now + DREAM_RETENTION_MS + 2)).toEqual([]);
  });

  it('removes oldest creation timestamps rather than array order, with stable ordering for ties', () => {
    const records = Array.from({ length: DREAM_MAX_ORDINARY_RECORDS + 2 }, (_, index) => storedDream(String(index), now - 1000 + index));
    records[1].createdAt = records[0].createdAt;
    const unordered = [records[1], ...records.slice(2).reverse(), records[0]];
    writeArchive({ dreams: unordered });
    const archive = new DreamArchive(directory);
    expect(archive.prune(now)).toEqual([records[1].id, records[0].id]);
    expect(archive.query('', '', 1000)).toHaveLength(DREAM_MAX_ORDINARY_RECORDS);
    expect(new DreamArchive(directory).get(records[2].id)).toBeDefined();
  });

  it('prunes while appending and retains the newest hundred ordinary records', () => {
    const archive = new DreamArchive(directory);
    const records = Array.from({ length: DREAM_MAX_ORDINARY_RECORDS + 1 }, (_, index) =>
      archive.append('A recent dream.', [], [source], now + index, `Recent ${index}`, { queueShare: true }));
    const restored = new DreamArchive(directory);
    expect(restored.get(records[0].id)).toBeUndefined();
    expect(restored.query('', '', 1000)).toHaveLength(DREAM_MAX_ORDINARY_RECORDS);
    expect(restored.get(records.at(-1)!.id)).toEqual(records.at(-1));
    expect(restored.pendingShares().map(share => share.recordId)).toEqual(records.slice(1).map(record => record.id));
  });

  it('removes expired bodies, sources, sharing state and usage receipts without refunding collection or deleting topics', () => {
    const archive = new DreamArchive(directory);
    const material = archive.add('Public topic', now);
    const alarm = archive.saveDaydreamAlarm({ time: '13:00', topic: 'Public scheduled topic' }, now);
    archive.recordCollection('2026-10-27', 2, material.id);
    const pending = archive.append('A pending dream.', [material.id], [source], now, 'Pending sky', { queueShare: true });
    const notified = archive.append('A shared dream.', [], [source], now, 'Shared sky', { queueShare: true });
    archive.prepareShare(notified.id, '12345', 10); archive.markShareNotified(notified.id, 11);
    archive.markUsed(pending.id, 'reply:one', now + 1, 3);
    const later = now + DREAM_RETENTION_MS + 1;
    const retained = archive.append('A current dream.', [], [source], later, 'Current sky');
    const restored = new DreamArchive(directory);
    expect(restored.query()).toEqual([retained]);
    expect(restored.pendingShares()).toEqual([]);
    expect(restored.hasUsage(pending.id, 'reply:one')).toBe(false);
    expect(restored.collectionCount('2026-10-27')).toBe(2);
    expect(restored.materials()).toEqual([{ ...material, lastProcessedDate: '2026-10-27' }]);
    expect(restored.daydreamAlarms()).toEqual([alarm]);
    const saved = JSON.parse(readFileSync(file(), 'utf8'));
    expect(saved.shares).toEqual([]); expect(saved.usageReceipts).toEqual([]);
    expect(saved.dreams.map((dream: { id: string }) => dream.id)).not.toContain(notified.id);
    expect(readFileSync(file(), 'utf8')).not.toContain('A pending dream.');
  });

  it('exempts deep dreams from both age and ordinary count limits', () => {
    const oldTime = now - DREAM_RETENTION_MS * 2;
    const deep = { ...storedDream('deep', oldTime), score: 4, tier: 'deep', promotedAt: new Date(oldTime + 1).toISOString() };
    const ordinary = Array.from({ length: DREAM_MAX_ORDINARY_RECORDS }, (_, index) => storedDream(String(index), now - index));
    writeArchive({ dreams: [deep, ...ordinary] });
    const archive = new DreamArchive(directory);
    expect(archive.prune(now)).toEqual([]);
    expect(archive.query('', '', 1000)).toHaveLength(DREAM_MAX_ORDINARY_RECORDS + 1);
    expect(archive.prune(now + DREAM_RETENTION_MS + 1)).toHaveLength(DREAM_MAX_ORDINARY_RECORDS);
    expect(new DreamArchive(directory).query()).toEqual([deep]);
    archive.removeDream(deep.id);
    expect(new DreamArchive(directory).query()).toEqual([]);
  });

  it('does not create an empty archive or rewrite unchanged retention checks', () => {
    const archive = new DreamArchive(directory);
    expect(archive.prune(now)).toEqual([]);
    expect(existsSync(file())).toBe(false);
    archive.append('A dream.', [], [source], now, 'Still here');
    const original = readFileSync(file(), 'utf8');
    expect(archive.prune(now)).toEqual([]);
    expect(readFileSync(file(), 'utf8')).toBe(original);
  });
});

describe('verified-use accounting storage', () => {
  it('starts at zero and leaves scores unchanged for queries, reads and automatic share bookkeeping', () => {
    const archive = new DreamArchive(directory);
    const dream = archive.append('A remembered sky.', [], [source], now, 'Remembered sky', { queueShare: true });
    archive.query('sky'); archive.get(dream.id);
    archive.prepareShare(dream.id, '12345', 5); archive.markShareNotified(dream.id, 6);
    expect(new DreamArchive(directory).get(dream.id)).toMatchObject({ score: 0, tier: 'ordinary', promotedAt: null });
  });

  it('promotes only when the incremented score exceeds the threshold and never demotes', () => {
    const archive = new DreamArchive(directory);
    const dream = archive.append('A remembered sky.', [], [source], now, 'Remembered sky');
    const threshold = 3;
    for (let score = 1; score <= threshold; score++) {
      expect(archive.markUsed(dream.id, `reply:${score}`, now + score, threshold)).toMatchObject({
        incremented: true, promoted: false, record: { score, tier: 'ordinary', promotedAt: null },
      });
    }
    const result = archive.markUsed(dream.id, 'reply:promote', now + threshold + 1, threshold);
    expect(result).toMatchObject({ incremented: true, promoted: true,
      record: { score: threshold + 1, tier: 'deep', promotedAt: new Date(now + threshold + 1).toISOString() } });
    const after = new DreamArchive(directory).markUsed(dream.id, 'reply:after', now + DREAM_RETENTION_MS * 2, 20);
    expect(after).toMatchObject({ incremented: true, promoted: false,
      record: { score: threshold + 2, tier: 'deep', promotedAt: result.record.promotedAt } });
    expect(archive.get(dream.id)?.text).toBe(dream.text);
  });

  it('deduplicates the same reply per dream across restarts and counts it separately for another dream', () => {
    const archive = new DreamArchive(directory);
    const first = archive.append('First dream.', [], [source], now, 'First');
    const second = archive.append('Second dream.', [], [source], now, 'Second');
    const initial = archive.markUsed(first.id, 'reply:stable', now + 1, 3);
    const restored = new DreamArchive(directory);
    expect(restored.hasUsage(first.id, 'reply:stable')).toBe(true);
    expect(restored.markUsed(first.id, 'reply:stable', now + 2, 0)).toEqual({ record: initial.record, incremented: false, promoted: false });
    expect(restored.markUsed(second.id, 'reply:stable', now + 2, 3)).toMatchObject({ record: { score: 1 }, incremented: true });
    restored.removeDream(first.id);
    expect(restored.hasUsage(first.id, 'reply:stable')).toBe(false);
    expect(restored.hasUsage(second.id, 'reply:stable')).toBe(true);
    expect(JSON.parse(readFileSync(file(), 'utf8')).usageReceipts).toEqual([{ recordId: second.id, replyKey: 'reply:stable' }]);
  });

  it('does not rescue an expired ordinary dream through a delayed report', () => {
    const archive = new DreamArchive(directory);
    const dream = archive.append('An old dream.', [], [source], now, 'Old');
    expect(() => archive.markUsed(dream.id, 'reply:late', now + DREAM_RETENTION_MS + 1, 0)).toThrow('expired');
    expect(archive.get(dream.id)?.score).toBe(0);
    expect(archive.hasUsage(dream.id, 'reply:late')).toBe(false);
  });

  it('keeps cached records, scores and receipts unchanged when atomic pruning or scoring fails', () => {
    const archive = new DreamArchive(directory);
    const dream = archive.append('A dream.', [], [source], now, 'Cached', { queueShare: true });
    rmSync(directory, { recursive: true }); writeFileSync(directory, 'blocked directory');
    expect(() => archive.markUsed(dream.id, 'reply:unsaved', now + 1, 0)).toThrow();
    expect(() => archive.prune(now + DREAM_RETENTION_MS + 1)).toThrow();
    expect(archive.get(dream.id)).toEqual(dream);
    expect(archive.hasUsage(dream.id, 'reply:unsaved')).toBe(false);
    expect(archive.pendingShares()).toEqual([{ recordId: dream.id }]);
    rmSync(directory);
    expect(archive.markUsed(dream.id, 'reply:unsaved', now + 1, 0).promoted).toBe(true);
    expect(new DreamArchive(directory).hasUsage(dream.id, 'reply:unsaved')).toBe(true);
  });

  it('rejects invalid accounting arguments and score overflow without storing a receipt', () => {
    const dream = { ...storedDream('full'), score: Number.MAX_SAFE_INTEGER };
    writeArchive({ dreams: [dream] });
    const archive = new DreamArchive(directory);
    for (const threshold of [-1, 0.5, Number.NaN]) expect(() => archive.markUsed(dream.id, 'reply:one', now, threshold)).toThrow();
    for (const reply of ['', '  ', '\u0000', 'x'.repeat(513)]) expect(() => archive.markUsed(dream.id, reply, now, 3)).toThrow();
    expect(() => archive.markUsed(dream.id, 'reply:one', Number.NaN, 3)).toThrow();
    expect(() => archive.markUsed(dream.id, 'reply:one', now, 3)).toThrow('supported range');
    expect(archive.hasUsage(dream.id, 'reply:one')).toBe(false);
    expect(archive.get(dream.id)?.score).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('retention fields on disk', () => {
  it.each([
    { score: -1 }, { score: 0.5 }, { score: '4' }, { score: Number.MAX_SAFE_INTEGER + 1 },
    { tier: 'unknown' }, { tier: 'deep', promotedAt: null }, { tier: 'ordinary', promotedAt: new Date(now).toISOString() },
    { tier: 'deep', promotedAt: '2026-02-30T00:00:00.000Z' }, { createdAt: 'invalid' },
    { createdAt: '2026-02-30T00:00:00.000Z' }, { createdAt: '2026-10-27T24:00:00.000Z' },
  ])('rejects damaged score, classification or timestamps: %j', fields => {
    writeArchive({ dreams: [{ ...storedDream('invalid'), ...fields }] });
    expect(() => new DreamArchive(directory).query()).toThrow('damaged dream archive');
  });

  it.each([
    null, {}, [{ recordId: 'missing', replyKey: 'reply:one' }], [{ recordId: 'dream', replyKey: '' }],
    [{ recordId: 'dream', replyKey: 'reply:one' }, { recordId: 'dream', replyKey: 'reply:one' }],
  ])('rejects invalid or duplicate persisted usage receipts: %j', usageReceipts => {
    writeArchive({ dreams: [storedDream('dream')], usageReceipts });
    expect(() => new DreamArchive(directory).query()).toThrow('damaged dream archive');
  });
});

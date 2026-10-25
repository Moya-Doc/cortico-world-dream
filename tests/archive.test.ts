import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DREAM_TITLE_MAX_LENGTH, DreamArchive } from '../src/archive.ts';
import { DREAM_TOOL_DECLS } from '../src/model-text.ts';

let directory: string;
const now = Date.parse('2026-10-24T01:00:00Z');
const source = { title: 'Public observation', url: 'https://news.example.test/item', content: 'A newly observed formation.' };
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'dream-archive-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

describe('dream titles', () => {
  it('persists the authored summary separately from the dream and supports title-only searches', () => {
    const archive = new DreamArchive(directory);
    const record = archive.append('Silver leaves turned into lanterns above the river.', [], [source], now, 'A floating constellation');
    expect(record).toMatchObject({ title: 'A floating constellation', titleSource: 'summary' });
    record.title = 'Changed outside the archive';
    const reloaded = new DreamArchive(directory);
    expect(reloaded.get(record.id)?.title).toBe('A floating constellation');
    expect(reloaded.query('CONSTELLATION').map(dream => dream.id)).toEqual([record.id]);
    expect(reloaded.query('constellation', '2026-10-25')).toEqual([]);
    expect(reloaded.query('observation')).toHaveLength(1);
    expect(reloaded.query('lanterns')).toHaveLength(1);
  });

  it('loads version 1 archives with explicit excerpt fallbacks without rewriting the file or losing content', () => {
    const dream = { id: 'old-record', createdAt: new Date(now).toISOString(), text: `  A river\n${'⭐'.repeat(DREAM_TITLE_MAX_LENGTH)} flowed through the sky.`, materialIds: ['topic'], sources: [source] };
    const material = { id: 'topic', topic: 'River observations', tag: '指定素材', createdAt: new Date(now).toISOString(), lastProcessedDate: null };
    const file = join(directory, 'archive.json');
    const original = JSON.stringify({ version: 1, materials: [material], dreams: [dream] });
    writeFileSync(file, original);
    const archive = new DreamArchive(directory);
    const restored = archive.get(dream.id)!;
    expect(restored).toMatchObject({ ...dream, titleSource: 'legacy-excerpt' });
    expect(restored.title.startsWith('A river ⭐')).toBe(true);
    expect(restored.title.length).toBeLessThanOrEqual(DREAM_TITLE_MAX_LENGTH);
    expect(restored.title).not.toMatch(/[\uD800-\uDBFF]$/u);
    expect(readFileSync(file, 'utf8')).toBe(original);
    archive.append('A different dream.', [], [source], now, 'The moonlit station');
    const reloaded = new DreamArchive(directory);
    expect(reloaded.materials()).toEqual([material]);
    expect(reloaded.get(dream.id)).toEqual(restored);
    expect(reloaded.query()).toHaveLength(2);
  });

  it('preserves fallback append compatibility and rejects invalid authored titles before writing', () => {
    const archive = new DreamArchive(directory);
    const legacy = archive.append('Old caller text', [], [source], now);
    expect(legacy).toMatchObject({ title: 'Old caller text', titleSource: 'legacy-excerpt' });
    for (const title of ['', '  ', 'x'.repeat(DREAM_TITLE_MAX_LENGTH + 1)]) {
      expect(() => archive.append('A new dream.', [], [source], now, title)).toThrow('dream title');
    }
    expect(new DreamArchive(directory).query().map(dream => dream.id)).toEqual([legacy.id]);
    const titled = archive.append('A new dream.', [], [source], now, 'x'.repeat(DREAM_TITLE_MAX_LENGTH));
    expect(new DreamArchive(directory).get(titled.id)?.title).toBe(titled.title);
  });

  it('requires authored titles in the model tool contract', () => {
    const parameters = DREAM_TOOL_DECLS.find(tool => tool.name === 'dream_record')!.parameters as {
      required: string[]; properties: { title: { minLength: number; maxLength: number } };
    };
    expect(parameters.required).toContain('title');
    expect(parameters.properties.title).toMatchObject({ minLength: 1, maxLength: DREAM_TITLE_MAX_LENGTH });
  });
});

describe('daily collection counts', () => {
  it('does not create an archive for a zero-count collection without a material update', () => {
    const archive = new DreamArchive(directory);
    archive.recordCollection('2026-10-24', 0);
    expect(archive.collectionCount('2026-10-24')).toBe(0);
    expect(existsSync(join(directory, 'archive.json'))).toBe(false);
  });

  it('loads archives without counts as zero and preserves their existing content when writing a count', () => {
    const material = { id: 'topic', topic: 'River observations', tag: '指定素材', createdAt: new Date(now).toISOString(), lastProcessedDate: null };
    const dream = { id: 'old-record', createdAt: new Date(now).toISOString(), text: 'A river flowed through the sky.', materialIds: ['topic'], sources: [source] };
    const file = join(directory, 'archive.json');
    const original = JSON.stringify({ version: 1, materials: [material], dreams: [dream] });
    writeFileSync(file, original);
    const archive = new DreamArchive(directory);
    expect(archive.collectionCount('2026-10-24')).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(original);
    archive.recordCollection('2026-10-24', 2, material.id);
    const reloaded = new DreamArchive(directory);
    expect(reloaded.collectionCount('2026-10-24')).toBe(2);
    expect(reloaded.get(dream.id)).toMatchObject(dream);
    expect(reloaded.materials()).toEqual([{ ...material, lastProcessedDate: '2026-10-24' }]);
  });

  it('increments each day independently, keeps earlier days and marks duplicate reads without charging again', () => {
    const archive = new DreamArchive(directory);
    const material = archive.add('Public topic', now);
    archive.recordCollection('2026-10-24', 2, material.id);
    archive.recordCollection('2026-10-24', 3);
    archive.recordCollection('2026-10-25', 4);
    archive.recordCollection('2026-10-25', 0, material.id);
    const reloaded = new DreamArchive(directory);
    expect(reloaded.collectionCount('2026-10-24')).toBe(5);
    expect(reloaded.collectionCount('2026-10-25')).toBe(4);
    expect(reloaded.collectionCount('2026-10-26')).toBe(0);
    expect(reloaded.materials()[0].lastProcessedDate).toBe('2026-10-25');
    expect(reloaded.query()).toEqual([]);
    reloaded.recordCollection('2026-10-24', 1);
    expect(new DreamArchive(directory).collectionCount('2026-10-24')).toBe(6);
  });

  it('does not change the cached count or material date when the atomic save fails', () => {
    const archive = new DreamArchive(directory);
    const material = archive.add('Public topic', now);
    archive.recordCollection('2026-10-24', 2, material.id);
    rmSync(directory, { recursive: true }); writeFileSync(directory, 'blocked path');
    expect(() => archive.recordCollection('2026-10-25', 3, material.id)).toThrow();
    expect(archive.collectionCount('2026-10-25')).toBe(0);
    expect(archive.collectionCount('2026-10-24')).toBe(2);
    expect(archive.materials()[0].lastProcessedDate).toBe('2026-10-24');
    rmSync(directory); archive.recordCollection('2026-10-25', 1, material.id);
    expect(new DreamArchive(directory).collectionCount('2026-10-25')).toBe(1);
  });

  it.each([null, [], 1, { '2026-10-24': -1 }, { '2026-10-24': 0.5 }, { '2026-10-24': '1' }, { '2026-10-24': Number.MAX_SAFE_INTEGER + 1 }, { '2026-02-30': 1 }, { yesterday: 1 }])('rejects damaged stored counts: %j', collectionCounts => {
    writeFileSync(join(directory, 'archive.json'), JSON.stringify({ version: 1, materials: [], dreams: [], collectionCounts }));
    expect(() => new DreamArchive(directory).collectionCount('2026-10-24')).toThrow('damaged dream archive');
  });

  it('rejects invalid increments and overflowing totals without changing the count', () => {
    const archive = new DreamArchive(directory);
    archive.recordCollection('2026-10-24', Number.MAX_SAFE_INTEGER);
    for (const count of [-1, 0.5, 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => archive.recordCollection('2026-10-24', count)).toThrow();
    }
    expect(() => archive.recordCollection('2026-02-30', 0)).toThrow();
    expect(new DreamArchive(directory).collectionCount('2026-10-24')).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('fixed-topic daydream alarms', () => {
  it('loads older archives with no alarms or shares without inferring old dream kinds or rewriting files', () => {
    const dream = { id: 'old-record', createdAt: new Date(now).toISOString(), text: 'A bridge floated above the valley.', materialIds: [], sources: [source] };
    const original = JSON.stringify({ version: 1, materials: [], dreams: [dream] });
    const file = join(directory, 'archive.json'); writeFileSync(file, original);
    const archive = new DreamArchive(directory);
    expect(archive.daydreamAlarms()).toEqual([]); expect(archive.pendingShares()).toEqual([]);
    expect(archive.get(dream.id)).not.toHaveProperty('kind');
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('migrates old times once as incomplete alarms and does not restore deleted alarms', () => {
    const archive = new DreamArchive(directory);
    archive.migrateDaydreamAlarms(['09:00', '15:30', '09:00'], now);
    const alarms = archive.daydreamAlarms();
    expect(alarms.map(alarm => [alarm.time, alarm.topic])).toEqual([['09:00', ''], ['15:30', '']]);
    expect(() => archive.saveDaydreamAlarm(alarms[0], now)).toThrow('daydream topic');
    archive.saveDaydreamAlarm({ ...alarms[0], topic: 'River restoration' }, now + 1000);
    archive.removeDaydreamAlarm(alarms[1].id);
    const reloaded = new DreamArchive(directory); reloaded.migrateDaydreamAlarms(['09:00', '15:30'], now + 2000);
    expect(reloaded.daydreamAlarms()).toEqual([{ ...alarms[0], topic: 'River restoration' }]);
    reloaded.removeDaydreamAlarm(alarms[0].id);
    const empty = new DreamArchive(directory); empty.migrateDaydreamAlarms(['09:00', '15:30'], now + 3000);
    expect(empty.daydreamAlarms()).toEqual([]);
  });

  it('retains an alarm topic across collection days and allows editing without replacing its identity', () => {
    const archive = new DreamArchive(directory);
    const sleepMaterial = archive.add('Sleep topic', now);
    const alarm = archive.saveDaydreamAlarm({ time: '10:15', topic: 'Public river restoration' }, now);
    alarm.topic = 'Changed outside the archive';
    archive.recordCollection('2026-10-24', 2); archive.recordCollection('2026-10-25', 1);
    expect(archive.daydreamAlarms()[0].topic).toBe('Public river restoration');
    expect(archive.materials()).toEqual([sleepMaterial]);
    const edited = archive.saveDaydreamAlarm({ id: alarm.id, time: '11:45', topic: 'Public observatory updates' }, now + 5000);
    expect(edited.id).toBe(alarm.id); expect(edited.createdAt).toBe(alarm.createdAt);
    expect(new DreamArchive(directory).daydreamAlarms()).toEqual([edited]);
  });

  it('rejects duplicate times, unknown edit ids and invalid time or topic input without changing alarms', () => {
    const archive = new DreamArchive(directory);
    const first = archive.saveDaydreamAlarm({ time: '00:00', topic: 'Public topic' }, now);
    const second = archive.saveDaydreamAlarm({ time: '23:59', topic: 'Another topic' }, now);
    for (const value of [
      { time: '00:00', topic: 'Duplicate' }, { ...second, time: '00:00' },
      { id: 'missing', time: '11:00', topic: 'Public topic' },
      { time: '24:00', topic: 'Public topic' }, { time: '9:00', topic: 'Public topic' },
      { time: '12:60', topic: 'Public topic' }, { time: '12:00', topic: '' },
      { time: '12:00', topic: ' '.repeat(4) }, { time: '12:00', topic: 'x'.repeat(501) },
    ]) expect(() => archive.saveDaydreamAlarm(value, now)).toThrow();
    expect(new DreamArchive(directory).daydreamAlarms()).toEqual([first, second]);
  });

  it('does not commit a migration marker when saving fails, so the migration can be retried', () => {
    const archive = new DreamArchive(directory); archive.daydreamAlarms();
    rmSync(directory, { recursive: true }); writeFileSync(directory, 'blocked path');
    expect(() => archive.migrateDaydreamAlarms(['12:30'], now)).toThrow();
    expect(archive.daydreamAlarms()).toEqual([]);
    rmSync(directory); archive.migrateDaydreamAlarms(['12:30'], now);
    expect(new DreamArchive(directory).daydreamAlarms().map(alarm => alarm.time)).toEqual(['12:30']);
  });

  it('preserves cached alarms when an edit or removal cannot be saved', () => {
    const archive = new DreamArchive(directory);
    const alarm = archive.saveDaydreamAlarm({ time: '12:30', topic: 'Public topic' }, now);
    rmSync(directory, { recursive: true }); writeFileSync(directory, 'blocked path');
    expect(() => archive.saveDaydreamAlarm({ ...alarm, topic: 'Unsaved topic' }, now)).toThrow();
    expect(() => archive.removeDaydreamAlarm(alarm.id)).toThrow();
    expect(archive.daydreamAlarms()).toEqual([alarm]);
  });
});

describe('dream share notifications and deletion', () => {
  it('atomically queues new records with their kind and optional fixed-topic metadata', () => {
    const archive = new DreamArchive(directory);
    const legacy = archive.append('An earlier dream.', [], [source], now, 'Earlier');
    const sleeping = archive.append('A sleep dream.', [], [source], now, 'Moonlit stairs', { kind: 'sleep', queueShare: true });
    const alarm = archive.saveDaydreamAlarm({ time: '12:30', topic: 'Public river news' }, now);
    const daydream = archive.append('A waking dream.', [], [source], now, 'The floating bridge', { kind: 'daydream', alarmId: alarm.id, topic: alarm.topic, queueShare: true });
    const reloaded = new DreamArchive(directory);
    expect(reloaded.get(legacy.id)).not.toHaveProperty('kind');
    expect(reloaded.get(sleeping.id)?.kind).toBe('sleep');
    expect(reloaded.get(daydream.id)).toMatchObject({ kind: 'daydream', alarmId: alarm.id, topic: alarm.topic });
    expect(reloaded.pendingShares()).toEqual([{ recordId: sleeping.id }, { recordId: daydream.id }]);
    const detached = reloaded.pendingShares(); detached[0].selectedGroupId = '111';
    expect(reloaded.pendingShares()[0]).not.toHaveProperty('selectedGroupId');
  });

  it('keeps the first selected group and attempt cursor across retries and restart, then removes notified work from pending', () => {
    const archive = new DreamArchive(directory);
    const dream = archive.append('A sleep dream.', [], [source], now, 'Moonlit stairs', { kind: 'sleep', queueShare: true });
    expect(archive.prepareShare(dream.id, '12345', 10)).toEqual({ recordId: dream.id, selectedGroupId: '12345', attemptAfterCursor: 10 });
    const reloaded = new DreamArchive(directory);
    expect(reloaded.prepareShare(dream.id, '67890', 20)).toEqual({ recordId: dream.id, selectedGroupId: '12345', attemptAfterCursor: 10 });
    reloaded.markShareNotified(dream.id, 15); reloaded.markShareNotified(dream.id, 30);
    expect(new DreamArchive(directory).pendingShares()).toEqual([]);
    expect(reloaded.prepareShare(dream.id, '67890', 40)).toBeUndefined();
    const data = JSON.parse(readFileSync(join(directory, 'archive.json'), 'utf8'));
    expect(data.shares).toEqual([{ recordId: dream.id, selectedGroupId: '12345', attemptAfterCursor: 10, notifiedCursor: 15 }]);
    expect(data.shares[0]).not.toHaveProperty('sent');
  });

  it('drops one pending suggestion or all pending suggestions without changing records or notified entries', () => {
    const archive = new DreamArchive(directory);
    const records = Array.from({ length: 3 }, (_, index) => archive.append(`Dream ${index}`, [], [source], now, `Title ${index}`, { kind: 'sleep', queueShare: true }));
    archive.prepareShare(records[0].id, '12345', 0); archive.markShareNotified(records[0].id, 1);
    archive.dropPendingShare(records[0].id); archive.dropPendingShare(records[1].id);
    expect(archive.pendingShares()).toEqual([{ recordId: records[2].id }]);
    archive.clearPendingShares();
    const reloaded = new DreamArchive(directory);
    expect(reloaded.pendingShares()).toEqual([]); expect(reloaded.query()).toHaveLength(3);
    expect(JSON.parse(readFileSync(join(directory, 'archive.json'), 'utf8')).shares).toEqual([
      { recordId: records[0].id, selectedGroupId: '12345', attemptAfterCursor: 0, notifiedCursor: 1 },
    ]);
  });

  it('persists one private recipient across restart and never replaces it with a group on retry', () => {
    const archive = new DreamArchive(directory);
    const dream = archive.append('A sleep dream.', [], [source], now, 'Moonlit stairs', { kind: 'sleep', queueShare: true });
    const expected = { recordId: dream.id, selectedPrivateId: '99999999999999999999', attemptAfterCursor: 10 };
    expect(archive.prepareShare(dream.id, expected.selectedPrivateId, 10, 'private')).toEqual(expected);
    const reloaded = new DreamArchive(directory);
    expect(reloaded.pendingShares()).toEqual([expected]);
    expect(reloaded.prepareShare(dream.id, '12345', 20)).toEqual(expected);
    reloaded.markShareNotified(dream.id, 15);
    expect(new DreamArchive(directory).pendingShares()).toEqual([]);
  });

  it('reads prepared and notified legacy group suggestions without rewriting or converting their target', () => {
    const archive = new DreamArchive(directory);
    const pending = archive.append('A sleep dream.', [], [source], now, 'Moonlit stairs', { kind: 'sleep', queueShare: true });
    const notified = archive.append('An earlier dream.', [], [source], now, 'Silver sea', { queueShare: true });
    archive.prepareShare(pending.id, '12345', 10);
    archive.prepareShare(notified.id, '67890', 11); archive.markShareNotified(notified.id, 15);
    const file = join(directory, 'archive.json'), original = readFileSync(file, 'utf8');
    const reloaded = new DreamArchive(directory);
    expect(reloaded.pendingShares()).toEqual([{ recordId: pending.id, selectedGroupId: '12345', attemptAfterCursor: 10 }]);
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(reloaded.prepareShare(pending.id, '99999', 20, 'private'))
      .toEqual({ recordId: pending.id, selectedGroupId: '12345', attemptAfterCursor: 10 });
  });

  it('deletes records and related notification metadata without refunding collected sources', () => {
    const archive = new DreamArchive(directory);
    const material = archive.add('Public topic', now);
    const alarm = archive.saveDaydreamAlarm({ time: '13:00', topic: 'Public daydream topic' }, now);
    archive.recordCollection('2026-10-24', 3, material.id);
    const pending = archive.append('Pending dream.', [], [source], now, 'Pending', { kind: 'sleep', queueShare: true });
    const notified = archive.append('Notified dream.', [], [source], now, 'Notified', { kind: 'sleep', queueShare: true });
    archive.prepareShare(notified.id, '12345', 0); archive.markShareNotified(notified.id, 1);
    archive.removeDream(pending.id); archive.removeDream(notified.id);
    archive.markShareNotified(pending.id, 2);
    expect(archive.prepareShare(pending.id, '12345', 2)).toBeUndefined();
    const reloaded = new DreamArchive(directory);
    expect(reloaded.get(pending.id)).toBeUndefined(); expect(reloaded.query()).toEqual([]);
    expect(reloaded.pendingShares()).toEqual([]); expect(reloaded.collectionCount('2026-10-24')).toBe(3);
    expect(reloaded.materials()[0]).toMatchObject({ ...material, lastProcessedDate: '2026-10-24' });
    expect(reloaded.daydreamAlarms()).toEqual([alarm]);
    expect(JSON.parse(readFileSync(join(directory, 'archive.json'), 'utf8')).shares).toEqual([]);
  });

  it('does not change cached records or notification state when any atomic save fails', () => {
    const archive = new DreamArchive(directory);
    const dream = archive.append('A sleep dream.', [], [source], now, 'Moonlit stairs', { kind: 'sleep', queueShare: true });
    rmSync(directory, { recursive: true }); writeFileSync(directory, 'blocked path');
    expect(() => archive.append('Unsaved dream.', [], [source], now, 'Unsaved', { kind: 'sleep', queueShare: true })).toThrow();
    expect(() => archive.prepareShare(dream.id, '12345', 0)).toThrow();
    expect(() => archive.markShareNotified(dream.id, 1)).toThrow();
    expect(() => archive.removeDream(dream.id)).toThrow();
    expect(() => archive.clearPendingShares()).toThrow(); expect(() => archive.dropPendingShare(dream.id)).toThrow();
    expect(archive.get(dream.id)).toEqual(dream); expect(archive.query()).toHaveLength(1);
    expect(archive.pendingShares()).toEqual([{ recordId: dream.id }]);
  });

  it('rejects invalid notification targets and cursors without preparing or completing a suggestion', () => {
    const archive = new DreamArchive(directory);
    const dream = archive.append('A sleep dream.', [], [source], now, 'Moonlit stairs', { kind: 'sleep', queueShare: true });
    for (const id of ['', 'group:12345', '0', '-1', 'name', '9'.repeat(21)]) {
      expect(() => archive.prepareShare(dream.id, id, 0)).toThrow();
      expect(() => archive.prepareShare(dream.id, id, 0, 'private')).toThrow();
    }
    for (const cursor of [-1, 0.5, Number.NaN]) expect(() => archive.prepareShare(dream.id, '12345', cursor)).toThrow();
    for (const cursor of [-1, 0, 0.5]) expect(() => archive.markShareNotified(dream.id, cursor)).toThrow();
    expect(archive.pendingShares()).toEqual([{ recordId: dream.id }]);
  });
});

describe('new archive field validation', () => {
  const dream = { id: 'old-record', createdAt: new Date(now).toISOString(), text: 'An old dream.', materialIds: [], sources: [source] };
  const alarm = { id: 'alarm', time: '12:00', topic: '', createdAt: new Date(now).toISOString() };
  it.each([
    { daydreamAlarms: null }, { daydreamAlarms: [{ ...alarm, time: '25:00' }] },
    { daydreamAlarms: [{ ...alarm, topic: ' '.repeat(3) }] }, { daydreamAlarms: [alarm, { ...alarm, id: 'other' }] },
    { daydreamAlarms: [alarm, { ...alarm, time: '13:00' }] }, { daydreamAlarmsMigrated: 'yes' },
    { shares: null }, { shares: [{ recordId: 'missing' }] },
    { shares: [{ recordId: dream.id, selectedGroupId: '12345' }] },
    { shares: [{ recordId: dream.id, selectedGroupId: '12345', attemptAfterCursor: -1 }] },
    { shares: [{ recordId: dream.id, selectedPrivateId: '12345' }] },
    { shares: [{ recordId: dream.id, selectedPrivateId: '0', attemptAfterCursor: 0 }] },
    { shares: [{ recordId: dream.id, selectedPrivateId: '9'.repeat(21), attemptAfterCursor: 0 }] },
    { shares: [{ recordId: dream.id, selectedGroupId: '12345', selectedPrivateId: '12345', attemptAfterCursor: 0 }] },
    { shares: [{ recordId: dream.id, attemptAfterCursor: 0 }] },
    { shares: [{ recordId: dream.id, notifiedCursor: 0 }] }, { shares: [{ recordId: dream.id }, { recordId: dream.id }] },
    { dreams: [{ ...dream, kind: 'invented' }] }, { dreams: [{ ...dream, topic: '' }] },
  ])('rejects damaged alarm, record or notification fields: %j', fields => {
    writeFileSync(join(directory, 'archive.json'), JSON.stringify({ version: 1, materials: [], dreams: [dream], ...fields }));
    expect(() => new DreamArchive(directory).query()).toThrow('damaged dream archive');
  });
});

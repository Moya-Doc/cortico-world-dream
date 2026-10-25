import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SearchResult } from './search.ts';

export interface Material {
  id: string; topic: string; tag: '指定素材'; createdAt: string; lastProcessedDate: string | null;
}
export type DreamKind = 'sleep' | 'daydream';
export interface DaydreamAlarm { id: string; time: string; topic: string; createdAt: string }
export interface PendingShare {
  recordId: string; selectedGroupId?: string; selectedPrivateId?: string; attemptAfterCursor?: number; notifiedCursor?: number;
}
export interface DreamRecord {
  id: string; createdAt: string; title: string; titleSource: 'summary' | 'legacy-excerpt';
  text: string; materialIds: string[]; sources: SearchResult[];
  kind?: DreamKind; alarmId?: string; topic?: string;
}
interface ArchiveData {
  version: 1; materials: Material[]; dreams: DreamRecord[]; collectionCounts: Record<string, number>;
  daydreamAlarms: DaydreamAlarm[]; daydreamAlarmsMigrated: boolean; shares: PendingShare[];
}
type StoredDreamRecord = Omit<DreamRecord, 'title' | 'titleSource'> & Partial<Pick<DreamRecord, 'title' | 'titleSource'>>;
type AddedArchiveFields = 'collectionCounts' | 'daydreamAlarms' | 'daydreamAlarmsMigrated' | 'shares';
type StoredArchiveData = Omit<ArchiveData, 'dreams' | AddedArchiveFields> & { dreams: StoredDreamRecord[] } & Partial<Pick<ArchiveData, AddedArchiveFields>>;

export const DREAM_TITLE_MAX_LENGTH = 80;

export function textInput(value: unknown, limit: number, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`Invalid ${name}.`);
  return value.trim();
}

function legacyTitle(record: Pick<DreamRecord, 'text' | 'id'>): string {
  const excerpt = record.text.replace(/\s+/gu, ' ').trim() || record.id || '—';
  let title = '';
  for (const character of excerpt) {
    if (title.length + character.length > DREAM_TITLE_MAX_LENGTH) break;
    title += character;
  }
  return title;
}

function validDay(day: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(day) && Number.isFinite(Date.parse(`${day}T00:00:00Z`))
    && new Date(`${day}T00:00:00Z`).toISOString().startsWith(day);
}
const alarmTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const qqId = /^[1-9][0-9]{0,19}$/u;
function validCursor(value: unknown, minimum = 0): boolean { return Number.isSafeInteger(value) && Number(value) >= minimum; }

/** One atomic file owns dream artifacts, collection counts, scheduled topics and share notification state. */
export class DreamArchive {
  private data: ArchiveData | null = null;
  constructor(readonly dir: string) {}
  private load(): ArchiveData {
    if (this.data) return this.data;
    const file = join(this.dir, 'archive.json');
    if (!existsSync(file)) return this.data = { version: 1, materials: [], dreams: [], collectionCounts: {}, daydreamAlarms: [], daydreamAlarmsMigrated: false, shares: [] };
    const raw = JSON.parse(readFileSync(file, 'utf8')) as StoredArchiveData;
    if (!raw || raw.version !== 1 || !Array.isArray(raw.materials) || !Array.isArray(raw.dreams)
      || raw.materials.some(m => !m || typeof m.id !== 'string' || typeof m.topic !== 'string' || m.tag !== '指定素材')
      || raw.dreams.some(d => !d || typeof d.id !== 'string' || typeof d.text !== 'string' || !Array.isArray(d.sources)
        || (d.title !== undefined && (typeof d.title !== 'string' || !d.title.trim() || d.title.length > DREAM_TITLE_MAX_LENGTH))
        || (d.titleSource !== undefined && d.titleSource !== 'summary' && d.titleSource !== 'legacy-excerpt')
        || (d.kind !== undefined && d.kind !== 'sleep' && d.kind !== 'daydream')
        || (d.alarmId !== undefined && (typeof d.alarmId !== 'string' || !d.alarmId || d.alarmId.length > 100))
        || (d.topic !== undefined && (typeof d.topic !== 'string' || !d.topic.trim() || d.topic.length > 500)))
      || (raw.collectionCounts !== undefined && (raw.collectionCounts === null || typeof raw.collectionCounts !== 'object'
        || Array.isArray(raw.collectionCounts) || Object.entries(raw.collectionCounts).some(([day, count]) => !validDay(day) || !Number.isSafeInteger(count) || count < 0)))
      || (raw.daydreamAlarmsMigrated !== undefined && typeof raw.daydreamAlarmsMigrated !== 'boolean')
      || (raw.daydreamAlarms !== undefined && (!Array.isArray(raw.daydreamAlarms) || raw.daydreamAlarms.some(alarm => !alarm
        || typeof alarm.id !== 'string' || !alarm.id || alarm.id.length > 100 || typeof alarm.time !== 'string' || !alarmTime.test(alarm.time)
        || typeof alarm.topic !== 'string' || alarm.topic.length > 500 || (alarm.topic !== '' && !alarm.topic.trim())
        || typeof alarm.createdAt !== 'string' || !Number.isFinite(Date.parse(alarm.createdAt)))
        || new Set(raw.daydreamAlarms.map(alarm => alarm.id)).size !== raw.daydreamAlarms.length
        || new Set(raw.daydreamAlarms.map(alarm => alarm.time)).size !== raw.daydreamAlarms.length))
      || (raw.shares !== undefined && (!Array.isArray(raw.shares) || raw.shares.some(share => !share
        || typeof share.recordId !== 'string' || !raw.dreams.some(dream => dream.id === share.recordId)
        || (share.selectedGroupId !== undefined && (typeof share.selectedGroupId !== 'string' || !qqId.test(share.selectedGroupId)))
        || (share.selectedPrivateId !== undefined && (typeof share.selectedPrivateId !== 'string' || !qqId.test(share.selectedPrivateId)))
        || (share.selectedGroupId !== undefined && share.selectedPrivateId !== undefined)
        || (share.attemptAfterCursor !== undefined && !validCursor(share.attemptAfterCursor))
        || ((share.selectedGroupId === undefined && share.selectedPrivateId === undefined) !== (share.attemptAfterCursor === undefined))
        || (share.notifiedCursor !== undefined && !validCursor(share.notifiedCursor, 1)))
        || new Set(raw.shares.map(share => share.recordId)).size !== raw.shares.length))) {
      throw new Error('Unsupported or damaged dream archive. Restore archive.json from a backup.');
    }
    return this.data = { ...raw, collectionCounts: raw.collectionCounts ?? {}, daydreamAlarms: raw.daydreamAlarms ?? [],
      daydreamAlarmsMigrated: raw.daydreamAlarmsMigrated ?? raw.daydreamAlarms !== undefined, shares: raw.shares ?? [], dreams: raw.dreams.map(d => ({ ...d,
      title: d.title ?? legacyTitle(d), titleSource: d.title === undefined ? 'legacy-excerpt' : d.titleSource ?? 'summary',
    })) };
  }
  private save(data: ArchiveData): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, 'archive.json');
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(temp, file);
    this.data = data;
  }
  materials(): Material[] { return structuredClone(this.load().materials); }
  add(topic: unknown, now: number): Material {
    const value = textInput(topic, 500, 'material topic');
    const existing = this.load().materials.find(m => m.topic === value);
    if (existing) return structuredClone(existing);
    const item: Material = { id: randomUUID(), topic: value, tag: '指定素材', createdAt: new Date(now).toISOString(), lastProcessedDate: null };
    const next = structuredClone(this.load()); next.materials.push(item); this.save(next); return structuredClone(item);
  }
  remove(id: string): void { const next = structuredClone(this.load()); next.materials = next.materials.filter(m => m.id !== id); this.save(next); }
  processed(id: string, day: string): void {
    const next = structuredClone(this.load());
    const item = next.materials.find(m => m.id === id);
    if (item) { item.lastProcessedDate = day; this.save(next); }
  }
  daydreamAlarms(): DaydreamAlarm[] { return structuredClone(this.load().daydreamAlarms); }
  saveDaydreamAlarm(value: { id?: string; time: string; topic: string }, now: number): DaydreamAlarm {
    const time = textInput(value.time, 5, 'daydream time');
    if (!alarmTime.test(time)) throw new Error('Invalid daydream time.');
    const topic = textInput(value.topic, 500, 'daydream topic');
    const id = value.id === undefined ? undefined : textInput(value.id, 100, 'daydream alarm id');
    const next = structuredClone(this.load());
    const existing = id === undefined ? undefined : next.daydreamAlarms.find(alarm => alarm.id === id);
    if (id !== undefined && !existing) throw new Error('Unknown daydream alarm.');
    if (next.daydreamAlarms.some(alarm => alarm.time === time && alarm.id !== id)) throw new Error('A daydream alarm already uses this time.');
    const item = { id: existing?.id ?? randomUUID(), time, topic, createdAt: existing?.createdAt ?? new Date(now).toISOString() };
    if (existing) Object.assign(existing, item); else next.daydreamAlarms.push(item);
    next.daydreamAlarmsMigrated = true;
    this.save(next); return structuredClone(item);
  }
  removeDaydreamAlarm(id: string): void {
    const next = structuredClone(this.load());
    next.daydreamAlarms = next.daydreamAlarms.filter(alarm => alarm.id !== id);
    next.daydreamAlarmsMigrated = true; this.save(next);
  }
  migrateDaydreamAlarms(times: string[], now: number): void {
    if (this.load().daydreamAlarmsMigrated) return;
    if (times.some(time => !alarmTime.test(time))) throw new Error('Invalid daydream time.');
    const next = structuredClone(this.load());
    const createdAt = new Date(now).toISOString();
    for (const time of new Set(times)) {
      if (!next.daydreamAlarms.some(alarm => alarm.time === time)) next.daydreamAlarms.push({ id: randomUUID(), time, topic: '', createdAt });
    }
    next.daydreamAlarmsMigrated = true; this.save(next);
  }
  collectionCount(day: string): number { return this.load().collectionCounts[day] ?? 0; }
  recordCollection(day: string, count: number, materialId?: string): void {
    if (!validDay(day) || !Number.isSafeInteger(count) || count < 0) throw new Error('Invalid collection count or date.');
    const next = structuredClone(this.load());
    const total = (next.collectionCounts[day] ?? 0) + count;
    if (!Number.isSafeInteger(total)) throw new Error('Collection count exceeds the supported range.');
    const item = next.materials.find(material => material.id === materialId);
    if (count === 0 && (!item || item.lastProcessedDate === day)) return;
    next.collectionCounts[day] = total;
    if (item) item.lastProcessedDate = day;
    this.save(next);
  }
  append(text: string, materialIds: string[], sources: SearchResult[], now: number, title?: string,
    options: { kind?: DreamKind; alarmId?: string; topic?: string; queueShare?: boolean } = {}): DreamRecord {
    const id = randomUUID();
    const item: DreamRecord = { id, createdAt: new Date(now).toISOString(),
      title: title === undefined ? legacyTitle({ text, id }) : textInput(title, DREAM_TITLE_MAX_LENGTH, 'dream title'),
      titleSource: title === undefined ? 'legacy-excerpt' : 'summary', text, materialIds: [...materialIds], sources: structuredClone(sources),
      ...(options.kind ? { kind: options.kind } : {}),
      ...(options.alarmId !== undefined ? { alarmId: textInput(options.alarmId, 100, 'daydream alarm id') } : {}),
      ...(options.topic !== undefined ? { topic: textInput(options.topic, 500, 'daydream topic') } : {}) };
    const next = structuredClone(this.load()); next.dreams.push(item);
    if (options.queueShare) next.shares.push({ recordId: id });
    this.save(next); return structuredClone(item);
  }
  removeDream(id: string): void {
    const next = structuredClone(this.load());
    next.dreams = next.dreams.filter(dream => dream.id !== id); next.shares = next.shares.filter(share => share.recordId !== id);
    this.save(next);
  }
  pendingShares(): PendingShare[] { return structuredClone(this.load().shares.filter(share => share.notifiedCursor === undefined)); }
  prepareShare(recordId: string, selectedId: string, attemptAfterCursor: number, kind: 'group' | 'private' = 'group'): PendingShare | undefined {
    if (!qqId.test(selectedId) || !validCursor(attemptAfterCursor)) throw new Error('Invalid share target or event cursor.');
    const next = structuredClone(this.load());
    const share = next.shares.find(item => item.recordId === recordId && item.notifiedCursor === undefined);
    if (!share) return undefined;
    if (share.selectedGroupId === undefined && share.selectedPrivateId === undefined) {
      share[kind === 'group' ? 'selectedGroupId' : 'selectedPrivateId'] = selectedId;
      share.attemptAfterCursor = attemptAfterCursor; this.save(next);
    }
    return structuredClone(share);
  }
  markShareNotified(recordId: string, cursor: number): void {
    if (!validCursor(cursor, 1)) throw new Error('Invalid share event cursor.');
    const next = structuredClone(this.load());
    const share = next.shares.find(item => item.recordId === recordId && item.notifiedCursor === undefined);
    if (share) { share.notifiedCursor = cursor; this.save(next); }
  }
  clearPendingShares(): void {
    const data = this.load();
    if (!data.shares.some(share => share.notifiedCursor === undefined)) return;
    const next = structuredClone(data); next.shares = next.shares.filter(share => share.notifiedCursor !== undefined); this.save(next);
  }
  dropPendingShare(recordId: string): void {
    const data = this.load();
    if (!data.shares.some(share => share.recordId === recordId && share.notifiedCursor === undefined)) return;
    const next = structuredClone(data);
    next.shares = next.shares.filter(share => share.recordId !== recordId || share.notifiedCursor !== undefined); this.save(next);
  }
  query(query = '', date = '', limit = 30): DreamRecord[] {
    const q = query.toLocaleLowerCase();
    return structuredClone(this.load().dreams.filter(d => (!date || d.createdAt.startsWith(date))
      && (!q || `${d.title} ${d.text} ${d.sources.map(s => s.title).join(' ')}`.toLocaleLowerCase().includes(q))).slice(-limit).reverse());
  }
  get(id: string): DreamRecord | undefined { return structuredClone(this.load().dreams.find(d => d.id === id)); }
}

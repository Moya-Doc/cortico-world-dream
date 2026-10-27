/** One deferred local notice per release; notice.json tracks rendering, not speech or user acknowledgement. */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorldHost } from 'cortico/core/types.ts';
import { DREAM_NOTICE_RELEASES, MODEL_TEXT } from './model-text.ts';

export const DREAM_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
type PendingNotice = { kind: 'introduced' | 'updated'; from: string | null };

function version(value: unknown): number[] | null {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}
function compare(a: string, b: string): number {
  const x = version(a)!; const y = version(b)!;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export class DreamNotice {
  private pending: PendingNotice | null = null;
  private queued = false;
  private generation = 0;
  private readonly legacy: boolean;
  constructor(private readonly dir: string, private readonly currentVersion = DREAM_VERSION) {
    // Archive migration may create archive.json before start().
    this.legacy = existsSync(join(dir, 'archive.json')) || existsSync(join(dir, 'state.json'));
  }
  start(): void {
    this.stop();
    if (!version(this.currentVersion)) return;
    const file = join(this.dir, 'notice.json');
    if (!existsSync(file)) {
      const kind = this.legacy ? 'updated' : 'introduced';
      this.record(null, kind);
      this.pending = { kind, from: null };
      return;
    }
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (!saved || saved.schema !== 1 || (saved.lastNotifiedVersion === null
      ? !['introduced', 'updated'].includes(saved.firstKind) : !version(saved.lastNotifiedVersion))) throw new Error('Invalid dream notice.json.');
    if (saved.lastNotifiedVersion === null) {
      this.pending = { kind: saved.firstKind, from: null };
      return;
    }
    if (compare(this.currentVersion, saved.lastNotifiedVersion) > 0)
      this.pending = { kind: 'updated', from: saved.lastNotifiedVersion };
  }
  stop(): void {
    this.generation++;
    this.queued = false;
    this.pending = null;
  }
  offer(host: WorldHost, canDeliver: () => boolean): void {
    if (!this.pending || this.queued || !canDeliver()) return;
    const pending = this.pending;
    const generation = this.generation;
    this.queued = true;
    try {
      host.pushDeferred({
        type: `dream.${pending.kind}`, origin: 'internal', senderKey: 'dream',
        meta: { version: this.currentVersion, fromVersion: pending.from },
        render: () => {
          if (generation !== this.generation) return null;
          this.queued = false;
          if (this.pending !== pending || !canDeliver()) return null;
          const changes = DREAM_NOTICE_RELEASES.filter(release => compare(release.version, this.currentVersion) <= 0
            && (pending.from ? compare(release.version, pending.from) > 0 : release.version === this.currentVersion));
          const text = pending.kind === 'introduced' ? MODEL_TEXT.introduced(this.currentVersion)
            : MODEL_TEXT.updated(pending.from, this.currentVersion, changes.map(release => release.text));
          this.record();
          this.pending = null;
          return text;
        },
      }, { trigger: 'flush' });
    } catch (error) { this.queued = false; throw error; }
  }
  private record(lastNotifiedVersion: string | null = this.currentVersion, firstKind?: PendingNotice['kind']): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, 'notice.json'); const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ schema: 1, lastNotifiedVersion, ...(firstKind ? { firstKind } : {}) }, null, 2) + '\n', { mode: 0o600 });
    renameSync(temp, file);
  }
}

import { JsonlEventStore } from 'cortico/core/event-store.ts';
import { nullLogger } from 'cortico/core/util.ts';
import type { WorldHost, EventEnvelope, PushOptions } from 'cortico/core/types.ts';

export class RealHost implements WorldHost {
  store: JsonlEventStore;
  log = nullLogger();
  modelFacts = { model: () => 'fixture', accepts: () => false, contextWindow: () => 128000 };
  opts: PushOptions[] = [];
  constructor(dataDir: string) { this.store = new JsonlEventStore({ dataDir, run: 'test-run', timezone: 'UTC' }); }
  async pushEvent(e: Parameters<WorldHost['pushEvent']>[0], opts?: PushOptions): Promise<EventEnvelope> {
    this.opts.push(opts ?? {});
    return this.store.append({ ...e, blobs: undefined, origin: e.origin ?? 'external' });
  }
  pushDeferred(): void {}
  async drainPendingEvents(): Promise<EventEnvelope[]> { return []; }
  blob(): null { return null; }
  reportUsage(): void {}
}

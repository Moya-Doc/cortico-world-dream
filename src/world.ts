import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope, ToolCallContext, ToolDef, ToolOutcome, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { WorldContext } from 'cortico/world.ts';
import type { Language } from 'cortico/core/language.ts';
import { nowIso } from 'cortico/core/util.ts';
import { bounded, DREAM_DEFAULTS, DREAM_SECRET, dreamConfigGroups, qqConfig, qqConfigPatch, QQ_ID, splitList, type DreamConfigSection } from './config.ts';
import { collectorConfig, collectorPatch, collectorReadiness, selectedBackends } from './collection.ts';
import { DREAM_TITLE_MAX_LENGTH, DreamArchive, textInput, type DaydreamAlarm, type DreamKind } from './archive.ts';
import { createSearchClient, publicUrl, SearchError, type SearchClient, type SearchOptions, type SearchResult } from './search.ts';
import { DreamEgoBrowser } from './ego-browser.ts';
import type { EgoBridge, BridgeReceipt } from './ego-transport/index.ts';
import { DREAM_EGO_TOOL_DECLS, DREAM_TOOL_DECLS, MODEL_TEXT, type DreamMessageReference } from './model-text.ts';
import { egoBrowserErrorText, strings } from './strings.ts';
import { localClock, sleepCommand } from './time.ts';
import { DreamUsage, type DreamIncomingRef, type DreamReplyRef } from './usage.ts';
import { isQQSource, parseQQMessage, qqWithdrawal, QQ_SOURCES, type QQMessage } from './qq.ts';

export interface DreamWorldOptions {
  context: WorldContext<DreamConfigSection>;
  now?: () => number;
  random?: () => number;
  search?: SearchClient;
  egoBridge?: EgoBridge;
  pollMs?: number;
}
interface Cycle {
  id: string; controller: AbortController; until: number; collecting: boolean;
  kind: DreamKind; alarm?: DaydreamAlarm;
  backends: SearchOptions['backend'][]; backendIndex: number; attempts: CollectionAttempt[];
  query?: string; materialId?: string;
  webSearchRequest?: string;
  sources: Map<string, SearchResult & { materialId?: string }>;
}
interface PersistedState { version: 1; sleepUntil: number | null; scheduled: Record<string, string> }
interface CollectionAttempt { backend: SearchOptions['backend']; reason: string }
interface CollectionStatus {
  backend: SearchOptions['backend'] | null;
  status: 'idle' | 'collecting' | 'ok' | 'error';
  error: Error | null;
  attempts: CollectionAttempt[];
}
interface ConnectionTest {
  status: 'idle' | 'testing' | 'ok' | 'error';
  backend: SearchOptions['backend'] | null;
  checkedAt: string | null;
  error: Error | 'cancelled' | 'stopped' | 'busy' | 'unconfigured' | 'agent-required' | null;
  resultCount: number | null;
}
class BrowserCollectionError extends SearchError {
  constructor(readonly code: string | undefined, message: string) { super(message); }
}
const egoCallErrors = new Set(['EGO_INVALID_ARGUMENTS', 'EGO_PAGE_NOT_MANAGED', 'EGO_PAGE_NOT_OWNED',
  'EGO_IMAGE_TOO_LARGE', 'EGO_RESPONSE_TOO_LARGE', 'EGO_CANCELLED', 'EGO_STOPPED']);
class CollectionQuotaError extends SearchError {
  constructor(readonly kind: 'cycle' | 'day') {
    super(kind === 'day' ? 'The daily collection limit is reached. Use already registered sources to finish this dream.'
      : 'This dream has reached its collection limit. Use its registered sources to finish the dream.');
  }
}

/** Sleep is World state. Body actions and speech policy are instructions to the main Persona. */
export class DreamWorld implements World {
  readonly id = 'dream';
  private readonly ctx: WorldContext<DreamConfigSection>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly archive: DreamArchive;
  private readonly search: SearchClient;
  private readonly ego: DreamEgoBrowser;
  private browserHalted = false;
  private collection: CollectionStatus = { backend: null, status: 'idle', error: null, attempts: [] };
  private lastCollectionSuccess: string | null = null;
  private connectionTest: ConnectionTest = { status: 'idle', backend: null, checkedAt: null, error: null, resultCount: null };
  private testController?: AbortController;
  private testTask?: Promise<void>;
  private collectionTask?: Promise<void>;
  private shareTask?: Promise<void>;
  private changingCollector = false;
  private host: WorldHost | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private tickTask?: Promise<void>;
  private transition = 0;
  private cursor = 0;
  private firstCursor = 0;
  private lastActivity = 0;
  private sleepUntil: number | null = null;
  private cycle: Cycle | null = null;
  private scheduled: Record<string, string> = {};
  private handled = new Set<number>();
  private referencedMessages = new Set<number>();
  private qqSeen = new Map<string, QQMessage>();
  private qqDeliveries = new Map<number, number>();
  private sleepReplies = new Set<number>();
  private error: string | null = null;
  private stopped = true;
  private nextArchiveCleanup = 0;
  private usage: DreamUsage | null = null;
  private controlCursor = 0;
  /** A local message may wake mechanically before its explicit sleep intent is interpreted. */
  private localWakeCursor: number | null = null;

  constructor(private readonly opts: DreamWorldOptions) {
    this.ctx = opts.context;
    const missing = Object.fromEntries(Object.entries(DREAM_DEFAULTS).filter(([key]) => !Object.hasOwn(this.ctx.cfg, key)));
    if (Object.keys(missing).length) this.ctx.persist(missing);
    if (this.cfg.collectorOrder === null) this.ctx.persist({ collectorOrder: selectedBackends(this.cfg) });
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.archive = new DreamArchive(join(this.ctx.dataDir, 'dream'));
    this.archive.migrateDaydreamAlarms(splitList(this.cfg.daydreamTimes), this.now());
    this.ego = new DreamEgoBrowser({ config: () => this.cfg, dataDir: this.archive.dir, botDir: this.ctx.botDir, bridge: opts.egoBridge,
      onState: () => this.browserChanged() });
    this.search = opts.search ?? createSearchClient(() => this.searchOptions());
  }
  private get cfg(): DreamConfigSection { return this.ctx.cfg; }
  private maintainArchive(force = false): void {
    const now = this.now();
    if (!force && now < this.nextArchiveCleanup) return;
    this.archive.prune(now);
    this.nextArchiveCleanup = now + 60000;
  }
  private collectionStatus(language: Language = 'zh') {
    return collectorReadiness(this.cfg, this.ctx.secret(DREAM_SECRET), language);
  }
  private backendMissing(backend: SearchOptions['backend']): string[] {
    const status = this.collectionStatus('en');
    return backend === 'ego' ? status.egoMissing : backend === 'tavily' ? status.tavilyMissing
      : backend === 'websearch' ? status.webSearchMissing : status.browserMissing;
  }
  private cycleBackend(cycle: Cycle): SearchOptions['backend'] | null { return cycle.backends[cycle.backendIndex] ?? null; }
  private searchOptions(backend = this.collectionStatus().activeBackend): SearchOptions {
    if (!backend || this.backendMissing(backend).length) throw new SearchError('Complete the selected collection configuration before collecting dream materials.');
    if (backend === 'websearch') throw new SearchError('The official web_search tool must be called by Coo.');
    return {
      backend, apiKey: backend === 'tavily' ? this.ctx.secret(DREAM_SECRET) : '',
      timeoutMs: this.cfg.timeoutMs, maxResults: this.cfg.maxResults,
    };
  }
  envPromptVars(): Record<string, string> {
    this.maintainArchive();
    return { 'dream.state': JSON.stringify({ sleeping: this.sleepUntil !== null, sleepUntil: this.sleepUntil ? new Date(this.sleepUntil).toISOString() : null,
      cycleId: this.cycle?.id ?? null, dreamKind: this.cycle?.kind ?? null, qqOwners: splitList(this.cfg.qqUsers), sharing: this.sharingState() }),
      'dream.index': JSON.stringify(this.archive.query('', '', 10).map(({ id, createdAt, title }) => ({
        id, date: localClock(Date.parse(createdAt), this.ctx.timezone).day, title,
      }))) };
  }
  private sharingState() {
    const groups = [...new Set(splitList(this.cfg.dreamTalkGroups))];
    const privates = [...new Set(splitList(this.cfg.dreamTalkPrivates))];
    const valid = [...groups, ...privates].every(id => QQ_ID.test(id));
    return { enabled: this.cfg.dreamTalkEnabled && valid && groups.length + privates.length > 0,
      groups: valid ? groups : [], privates: valid ? privates : [] };
  }
  private async offerShares(): Promise<void> {
    if (this.stopped) return;
    if (this.shareTask) return this.shareTask;
    this.shareTask = this.flushShares();
    try { await this.shareTask; } finally { this.shareTask = undefined; }
  }
  private async flushShares(): Promise<void> {
    const sharing = this.sharingState();
    if (!sharing.enabled) { this.archive.clearPendingShares(); return; }
    if (this.sleepUntil !== null || this.cycle) return;
    for (const item of this.archive.pendingShares()) {
      if (this.stopped || this.sleepUntil !== null || this.cycle) return;
      const current = this.sharingState();
      if (!current.enabled) { this.archive.clearPendingShares(); return; }
      const selected = item.selectedGroupId !== undefined ? { kind: 'group' as const, id: item.selectedGroupId }
        : item.selectedPrivateId !== undefined ? { kind: 'private' as const, id: item.selectedPrivateId } : undefined;
      if (item.attemptAfterCursor !== undefined) {
        const target = `${selected!.kind}:${selected!.id}`;
        const sent = this.host!.store.range({ source: this.id, fromCursor: item.attemptAfterCursor + 1 })
          .find(event => event.type === 'dream.share' && event.meta?.recordId === item.recordId
            && (event.meta?.target === target || (event.meta?.target === undefined
              && event.meta?.[selected!.kind === 'group' ? 'groupId' : 'privateId'] === selected!.id)));
        if (sent) { this.archive.markShareNotified(item.recordId, sent.cursor); continue; }
      }
      if (selected && !(selected.kind === 'group' ? current.groups : current.privates).includes(selected.id)) {
        this.archive.dropPendingShare(item.recordId); continue;
      }
      const targets = [...current.groups.map(id => ({ kind: 'group' as const, id })), ...current.privates.map(id => ({ kind: 'private' as const, id }))];
      const recipient = selected ?? targets[Math.min(targets.length - 1, Math.floor(this.random() * targets.length))]!;
      const target = `${recipient.kind}:${recipient.id}`;
      const prepared = this.archive.prepareShare(item.recordId, recipient.id, this.host!.store.latestCursor(), recipient.kind);
      if (!prepared) continue;
      const event = await this.emit('share', MODEL_TEXT.share(item.recordId, target), false,
        { recordId: item.recordId, target, [recipient.kind === 'group' ? 'groupId' : 'privateId']: recipient.id });
      if (event) this.archive.markShareNotified(item.recordId, event.cursor);
    }
  }
  private modelState() {
    this.maintainArchive();
    return { sleeping: this.sleepUntil !== null, sleepUntil: this.sleepUntil ? new Date(this.sleepUntil).toISOString() : null,
      dreaming: this.cycle !== null, cycleId: this.cycle?.id ?? null, date: localClock(this.now(), this.ctx.timezone).day,
      dreamKind: this.cycle?.kind ?? null, daydreamAlarm: this.cycle?.alarm ?? null,
      materials: this.cycle?.kind === 'daydream' ? [] : this.archive.materials(), backend: this.cycle ? this.cycleBackend(this.cycle) : this.collectionStatus().activeBackend, quota: this.quota(),
      collectorOrder: this.cycle?.backends ?? selectedBackends(this.cfg), attempts: this.collection.attempts,
      collectionQuery: this.cycle?.query ?? null, collectionMaterialId: this.cycle?.materialId ?? null,
      qqOwners: splitList(this.cfg.qqUsers), sharing: this.sharingState(), deepDreamThreshold: this.cfg.deepDreamThreshold,
      browser: { connected: this.ego.state().connected, halted: this.ego.state().halted, code: this.ego.state().code,
        lastUnknownOutcome: this.ego.state().lastUnknownOutcome }, error: this.error };
  }
  private requireRunning(): void { if (this.stopped) throw new Error('Dream World is not running. Enable it before controlling sleep.'); }
  private browserChanged(): void {
    const state = this.ego.state();
    const resumed = this.browserHalted && !state.halted && state.connected;
    this.browserHalted = state.halted;
    if (resumed && this.cycle && this.cycleBackend(this.cycle) === 'ego' && !this.stopped) void this.emit('requested', MODEL_TEXT.browserResumed).catch(() => {
      this.error = 'The browser resumed, but the dream continuation event could not be delivered.';
    });
  }
  private collectionError(error: Error | null, language: Language): string | null {
    return error instanceof CollectionQuotaError ? strings(language)[error.kind === 'day' ? 'quotaDailyReached' : 'quotaCycleReached']
      : error instanceof BrowserCollectionError ? egoBrowserErrorText(error.code, language)
      : error instanceof SearchError ? error.message : error ? strings(language).error : null;
  }
  private quota(cycle: Cycle | null = this.cycle) {
    const date = localClock(this.now(), this.ctx.timezone).day;
    const cycleUsed = cycle?.sources.size ?? 0;
    const cycleLimit = this.cfg.maxSourcesPerDream;
    const dailyUsed = this.archive.collectionCount(date);
    const dailyLimit = this.cfg.maxSourcesPerDay;
    return { date, cycleUsed, cycleLimit, dailyUsed, dailyLimit,
      remaining: Math.max(0, Math.min(cycleLimit - cycleUsed, dailyLimit - dailyUsed)) };
  }
  private quotaError(cycle: Cycle): CollectionQuotaError {
    const quota = this.quota(cycle);
    return new CollectionQuotaError(quota.dailyUsed >= quota.dailyLimit ? 'day' : 'cycle');
  }
  /** Archive accounting commits before source ids become usable by dream_record. */
  private registerSources(cycle: Cycle, results: SearchResult[], materialId?: string) {
    const quota = this.quota(cycle);
    const sources = new Map<string, SearchResult & { materialId?: string }>(cycle.sources);
    const accepted = new Map<string, SearchResult & { id: string }>();
    let count = 0;
    for (const result of results) {
      if (!result.content.trim()) continue;
      const url = new URL(result.url); url.hash = '';
      const key = url.href;
      const existing = [...sources.entries()].find(([, source]) => source.url === key);
      if (!existing && count >= quota.remaining) continue;
      const id = existing?.[0] ?? randomUUID();
      const previous = existing?.[1];
      const content = previous && !previous.content.includes(result.content)
        ? `${previous.content}\n${result.content}`.slice(0, 60000) : previous?.content ?? result.content.slice(0, 60000);
      const source = { ...result, url: key, content,
        ...((result.provenance ?? previous?.provenance) ? { provenance: result.provenance ?? previous?.provenance } : {}),
        ...((previous?.materialId ?? materialId) ? { materialId: previous?.materialId ?? materialId } : {}) };
      sources.set(id, source);
      accepted.set(id, { id, title: source.title, url: key, content, ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}),
        ...(source.provenance ? { provenance: source.provenance } : {}) });
      if (!existing) count++;
    }
    if (accepted.size && (count || materialId)) this.archive.recordCollection(quota.date, count, materialId);
    cycle.sources = sources;
    if (accepted.size) this.lastCollectionSuccess = new Date(this.now()).toISOString();
    return [...accepted.values()];
  }
  private phase(): 'awake' | 'sleeping' | 'waiting' | 'collecting' | 'generating' {
    if (this.cycle?.collecting) return 'collecting';
    if (this.cycle?.sources.size) return 'generating';
    if (this.cycle) return 'waiting';
    return this.sleepUntil !== null ? 'sleeping' : 'awake';
  }
  state(language: Language = 'zh') {
    this.maintainArchive();
    const t = strings(language);
    const status = this.collectionStatus(language);
    const testError = this.connectionTest.error;
    const egoState = this.ego.state();
    return {
      sleeping: this.sleepUntil !== null, sleepUntil: this.sleepUntil ? new Date(this.sleepUntil).toISOString() : null,
      dreaming: this.cycle !== null, cycleId: this.cycle?.id ?? null, date: localClock(this.now(), this.ctx.timezone).day,
      dreamKind: this.cycle?.kind ?? null, daydreamAlarms: this.archive.daydreamAlarms(), daydreamEnabled: this.cfg.daydreamEnabled,
      materials: this.archive.materials(), dreams: this.archive.query(), ...status,
      activeBackend: this.cycle ? this.cycleBackend(this.cycle) : status.activeBackend, error: this.error, quota: this.quota(),
      phase: this.phase(), collectorConfig: collectorConfig(this.cfg), egoConnection: { ...egoState, reason: egoState.code ? egoBrowserErrorText(egoState.code, language) : '' },
      collection: { ...this.collection, attempts: this.collection.attempts.map(attempt => ({ ...attempt })), lastSuccessAt: this.lastCollectionSuccess, error: this.collectionError(this.collection.error, language) },
      connectionTest: { ...this.connectionTest, error: testError === 'cancelled' ? t.testCancelled : testError === 'stopped' ? t.collectorStopped
        : testError === 'busy' ? t.collectionBusy : testError === 'unconfigured' ? `${t.collectionNotConfigured} ${t.missingConfiguration}: ${status.readiness.missing.join(', ')}`
        : testError === 'agent-required' ? t.webSearchTestUnsupported
        : this.collectionError(testError, language) },
    };
  }
  async start(host: WorldHost): Promise<void> {
    if (!this.stopped) return;
    this.maintainArchive(true);
    this.host = host; this.stopped = false; this.cursor = this.firstCursor = this.controlCursor = host.store.latestCursor(); this.lastActivity = this.now();
    this.usage = new DreamUsage(host.store, this.now);
    this.qqSeen.clear(); this.qqDeliveries.clear(); this.sleepReplies.clear();
    for (const source of QQ_SOURCES) {
      for (const event of host.store.range({ source, fromTs: new Date(this.now() - 300000).toISOString(), toCursor: this.firstCursor })) {
        const message = parseQQMessage(event, host.store);
        if (message && !this.qqSeen.has(message.key)) this.qqSeen.set(message.key, message);
      }
    }
    this.localWakeCursor = null;
    await this.ego.start();
    const file = join(this.archive.dir, 'state.json');
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as PersistedState;
      if (saved.version !== 1 || !saved.scheduled || typeof saved.scheduled !== 'object'
        || (saved.sleepUntil !== null && !Number.isFinite(saved.sleepUntil))) throw new Error('Invalid dream state.json.');
      this.scheduled = saved.scheduled;
      if (saved.sleepUntil && saved.sleepUntil > this.now()) {
        this.sleepUntil = saved.sleepUntil;
        await this.emit('sleeping', MODEL_TEXT.resumed);
      } else if (saved.sleepUntil) { this.sleepUntil = saved.sleepUntil; await this.wake(MODEL_TEXT.expiredOffline); }
    }
    await this.offerShares();
    this.timer = setInterval(() => { void this.tick().catch(() => { this.error = 'Dream timer failed; inspect the extension configuration.'; }); }, this.opts.pollMs ?? 500);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    this.stopped = true; this.transition++; this.localWakeCursor = null;
    this.usage?.reset(); this.usage = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.cycle?.controller.abort(); this.cycle = null;
    this.testController?.abort();
    await Promise.allSettled([this.search.close(), this.ego.stop(), this.testTask, this.collectionTask, this.shareTask]);
    this.host = null;
  }
  private saveState(): void {
    mkdirSync(this.archive.dir, { recursive: true, mode: 0o700 });
    const file = join(this.archive.dir, 'state.json');
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, sleepUntil: this.sleepUntil, scheduled: this.scheduled }), { mode: 0o600 });
    renameSync(temp, file);
  }
  private async emit(kind: string, text: string, interrupt = false, meta?: EventEnvelope['meta'], origin: EventEnvelope['origin'] = 'internal'): Promise<EventEnvelope | undefined> {
    if (!this.host || this.stopped) return;
    return this.host.pushEvent({
      type: `dream.${kind}`, source: this.id, senderKey: this.id, origin, ts: nowIso(this.ctx.timezone, new Date(this.now())),
      text: `${text}\nDream state: ${JSON.stringify({ sleeping: this.sleepUntil !== null, sleepUntil: this.sleepUntil ? new Date(this.sleepUntil).toISOString() : null,
        cycleId: this.cycle?.id ?? null, dreamKind: this.cycle?.kind ?? null })}`, ...(meta ? { meta } : {}),
    }, { trigger: interrupt ? 'interrupt' : 'flush' });
  }
  private qqMessage(e: EventEnvelope) {
    const delivery = this.qqDeliveries.get(e.cursor);
    const event = delivery === undefined ? e : this.host?.store.get(delivery);
    const message = event && parseQQMessage(event, this.host?.store);
    if (!message || message.cursor <= this.firstCursor || !this.recentTimestamp(message.ts)
      || (this.host && qqWithdrawal(message, this.host.store))) return null;
    const seen = this.qqSeen.get(message.key);
    if (seen && seen.deliveryCursor !== message.deliveryCursor) return null;
    return { ...message, owner: splitList(this.cfg.qqUsers).includes(message.senderId),
      groupId: message.kind === 'group' ? message.id : null };
  }
  private recentTimestamp(ts: string): boolean {
    const at = Date.parse(ts);
    return Number.isFinite(at) && this.now() - at <= 300000 && at <= this.now() + 1000;
  }
  private message(e: EventEnvelope): { body: string; addressed: boolean } | null {
    if (e.origin !== 'external' && !(e.source === 'console' && e.type === 'console.message' && e.origin === 'internal')) return null;
    const meta = e.meta ?? {};
    if (e.source === 'desktop-pet' && ['desktop-pet.message', 'desktop-pet.speech'].includes(e.type))
      return { body: typeof meta.text === 'string' ? meta.text : e.text, addressed: true };
    if (e.source === 'console' && e.type === 'console.message')
      return { body: typeof meta.body === 'string' ? meta.body : e.text, addressed: true };
    const qq = this.qqMessage(e);
    return qq?.owner ? { body: qq.body, addressed: qq.addressed } : null;
  }
  private recentMessage(cursor: unknown): { event: EventEnvelope; body: string } {
    if (!Number.isInteger(cursor) || Number(cursor) <= this.firstCursor) throw new Error('A new incoming message cursor is required.');
    const e = this.host?.store.get(Number(cursor));
    const message = e && this.eligibleRecentMessage(e);
    if (!e || !message)
      throw new Error('The message is not recent or its sender is not authorized.');
    const qq = this.qqMessage(e);
    return { event: qq ? this.host!.store.get(qq.cursor)! : e, body: message.body };
  }
  private eligibleRecentMessage(event: EventEnvelope): { body: string; addressed: boolean } | null {
    const message = this.message(event), qq = this.qqMessage(event);
    return (qq?.cursor ?? event.cursor) > this.firstCursor && message?.addressed
      && (qq !== null || event.contextDelivery !== 'archive-only') && this.recentTimestamp(qq?.ts ?? event.ts) ? message : null;
  }
  private async referenceMessage(event: EventEnvelope): Promise<void> {
    const qq = this.qqMessage(event), cursor = qq?.cursor ?? event.cursor;
    if (this.stopped || !this.host || event.contextDelivery === 'archive-only' || cursor < this.controlCursor
      || this.handled.has(cursor) || this.referencedMessages.has(cursor)) return;
    const message = this.eligibleRecentMessage(event);
    if (!message) return;
    const reference: DreamMessageReference = { eventCursor: cursor, source: event.source, type: event.type,
      ts: qq?.ts ?? event.ts, body: message.body, ...(qq ? { messageId: qq.messageId, target: qq.target, senderId: qq.senderId } : {}) };
    const host = this.host, before = host.store.latestCursor();
    this.referencedMessages.add(cursor);
    try {
      await host.pushEvent({ type: 'dream.message_ref', source: this.id, senderKey: this.id, origin: 'external',
        ts: nowIso(this.ctx.timezone, new Date(this.now())), text: MODEL_TEXT.messageRef(reference),
        meta: { eventCursor: cursor } }, { trigger: 'flush' });
    } catch (error) {
      if (!host.store.range({ source: this.id, fromCursor: before + 1 }).some(item => item.type === 'dream.message_ref' && item.meta?.eventCursor === cursor))
        this.referencedMessages.delete(cursor);
      throw error;
    }
  }
  private newerInteraction(cursor: number): boolean {
    return ['desktop-pet', 'console', ...QQ_SOURCES].some(source => this.host!.store.range({ source, fromCursor: cursor + 1 }).some(event =>
      ((this.qqMessage(event)?.cursor ?? event.cursor) > cursor && this.eligibleRecentMessage(event)?.addressed) || (event.source === 'desktop-pet' && event.type === 'desktop-pet.touch'
        && event.origin === 'external' && (event.meta?.touch as { woke?: boolean } | undefined)?.woke === true)));
  }
  async tick(): Promise<void> {
    if (this.tickTask) return this.tickTask;
    if (this.stopped || !this.host) return;
    this.tickTask = this.drainEvents();
    try { await this.tickTask; } finally { this.tickTask = undefined; }
  }
  private async drainEvents(): Promise<void> {
    do { await this.runTick(); }
    while (!this.stopped && this.host && this.cursor < this.host.store.latestCursor());
  }
  private async runTick(): Promise<void> {
    this.maintainArchive();
    const end = this.host!.store.latestCursor();
    while (this.cursor < end) {
      const to = Math.min(end, this.cursor + 256);
      const events = ['desktop-pet', 'console', ...QQ_SOURCES].flatMap(source => this.host!.store.range({ fromCursor: this.cursor + 1, toCursor: to, source })).sort((a, b) => a.cursor - b.cursor);
      for (const e of events) {
        if (this.stopped) return;
        if (e.source === 'desktop-pet' && e.origin === 'external' && e.type === 'desktop-pet.touch') {
          this.lastActivity = this.now();
          const touch = e.meta?.touch as { woke?: boolean } | undefined;
          if (touch?.woke === true && e.cursor > this.controlCursor && (this.sleepUntil !== null || this.cycle)) await this.wake(MODEL_TEXT.touchWake, e.cursor);
        }
        const qq = this.qqMessage(e);
        if (isQQSource(e.source) && !qq) continue;
        if (qq) {
          this.qqSeen.set(qq.key, qq); this.qqDeliveries.set(qq.cursor, qq.deliveryCursor);
        }
        const message = this.eligibleRecentMessage(e), cursor = qq?.cursor ?? e.cursor;
        if (this.sleepUntil !== null && cursor > this.controlCursor && qq?.mentioned && qq.groupId && !this.sleepReplies.has(cursor)
          && !(qq.owner && sleepCommand(qq.body))) {
          this.sleepReplies.add(cursor);
          const host = this.host!, before = host.store.latestCursor();
          try {
            await this.emit('sleep_reply', MODEL_TEXT.sleepReply({ eventCursor: cursor, source: qq.source, type: e.type,
              ts: qq.ts, body: qq.body, messageId: qq.messageId, target: qq.target, senderId: qq.senderId }), false, { eventCursor: cursor }, 'external');
          } catch (error) {
            if (!host.store.range({ source: this.id, fromCursor: before + 1 }).some(item => item.type === 'dream.sleep_reply' && item.meta?.eventCursor === cursor))
              this.sleepReplies.delete(cursor);
            throw error;
          }
        }
        if (!message?.addressed) continue;
        this.lastActivity = this.now();
        if (this.localWakeCursor !== null && cursor > this.localWakeCursor) this.localWakeCursor = null;
        if (cursor <= this.controlCursor) {
          if (cursor === this.localWakeCursor) await this.referenceMessage(e);
          continue;
        }
        const command = sleepCommand(message.body);
        if (command?.kind === 'sleep') {
          if (!this.handled.has(cursor)) { this.handled.add(cursor); await this.sleep(command.minutes, cursor); }
        } else if ((!isQQSource(e.source) || this.sleepUntil === null || command?.kind === 'wake') && (this.sleepUntil !== null || this.cycle || (command?.kind === 'wake' && this.testController))) {
          const generation = this.transition + 1;
          await this.wake(command?.kind === 'wake' ? MODEL_TEXT.userWake : MODEL_TEXT.messageWake, cursor);
          if (!isQQSource(e.source) && !command && !this.stopped && this.transition === generation)
            this.localWakeCursor = cursor;
        }
        if (!command) await this.referenceMessage(e);
      }
      if (this.stopped) return;
      this.cursor = to;
      this.referencedMessages.clear();
    }
    if (this.stopped) return;
    if (this.handled.size > 1024) this.handled = new Set([...this.handled].filter(c => c > end - 1024));
    for (const [key, message] of this.qqSeen) if (!this.recentTimestamp(message.ts)) {
      this.qqSeen.delete(key); this.qqDeliveries.delete(message.cursor); this.sleepReplies.delete(message.cursor);
    }
    const now = this.now();
    if (this.sleepUntil !== null && now >= this.sleepUntil) await this.wake(MODEL_TEXT.deadline);
    if (this.cycle && now >= this.cycle.until) await this.cancelDream(MODEL_TEXT.dreamDeadline);
    const clock = localClock(now, this.ctx.timezone);
    const sleepSlot = `sleep:${clock.time}`;
    if (this.cfg.sleepScheduleEnabled && splitList(this.cfg.sleepTimes).includes(clock.time) && this.scheduled[sleepSlot] !== clock.day) {
      this.scheduled[sleepSlot] = clock.day; this.saveState();
      if (this.sleepUntil === null) await this.sleep();
    }
    const daydreamSlot = `daydream:${clock.time}`;
    const alarm = this.cfg.daydreamEnabled ? this.archive.daydreamAlarms().find(item => item.time === clock.time && item.topic.trim()) : undefined;
    if (alarm && this.scheduled[daydreamSlot] !== clock.day) {
      this.scheduled[daydreamSlot] = clock.day; this.saveState();
      if (this.sleepUntil === null && !this.cycle) await this.beginDream('daydream', alarm);
    }
    await this.offerShares();
    if (this.cfg.idleEnabled && this.sleepUntil === null && !this.cycle && now - this.lastActivity >= this.cfg.idleMinutes * 60000) await this.sleep();
  }
  async sleep(minutes: unknown = this.cfg.sleepMinutes, cursor = this.host?.store.latestCursor() ?? 0): Promise<void> {
    this.requireRunning();
    const duration = bounded(minutes, 1, 1440, 'sleep duration');
    this.usage?.reset();
    const generation = ++this.transition;
    this.localWakeCursor = null;
    this.controlCursor = Math.max(this.controlCursor, cursor);
    await this.cancelDream(MODEL_TEXT.replaced);
    if (this.stopped || generation !== this.transition) return;
    this.sleepUntil = this.now() + duration * 60000; this.error = null; this.saveState();
    await this.emit('sleeping', MODEL_TEXT.sleeping);
    if (this.stopped || generation !== this.transition) return;
    if (this.cfg.dreamMode === 'always' || this.random() < bounded(this.cfg.dreamProbability, 0, 1, 'dream probability')) await this.beginDream();
  }
  async wake(reason = MODEL_TEXT.operatorWake, cursor = this.host?.store.latestCursor() ?? 0): Promise<void> {
    this.requireRunning();
    this.testController?.abort();
    const generation = ++this.transition;
    this.localWakeCursor = null;
    const hadState = this.sleepUntil !== null || this.cycle !== null;
    this.controlCursor = Math.max(this.controlCursor, cursor);
    this.sleepUntil = null; this.lastActivity = this.now();
    await this.cancelDream(reason, false); this.saveState();
    if (hadState && !this.stopped && generation === this.transition) await this.emit('woke', MODEL_TEXT.woke(reason), true);
    await this.offerShares();
  }
  private async beginDream(kind: DreamKind = 'sleep', alarm?: DaydreamAlarm): Promise<void> {
    if (this.stopped || this.changingCollector || this.cycle || !this.quota(null).remaining) return;
    this.usage?.reset();
    const controller = new AbortController();
    const until = this.now() + bounded(this.cfg.maxDreamMinutes, 1, 60, 'dream time limit') * 60000;
    const cycle: Cycle = { id: randomUUID(), controller, until, kind, ...(alarm ? { alarm: structuredClone(alarm), query: alarm.topic } : {}),
      backends: selectedBackends(this.cfg), backendIndex: 0, attempts: [], collecting: false, sources: new Map() };
    this.cycle = cycle;
    this.collection = { backend: null, status: 'idle', error: null, attempts: cycle.attempts };
    if (!this.selectBackend(cycle, this.collection)) { await this.finishCollection(cycle, this.collection); return; }
    await this.emit('requested', MODEL_TEXT.requested);
  }
  private async cancelDream(reason: string, notify = true): Promise<void> {
    if (!this.cycle) return;
    this.cycle.controller.abort(); this.cycle = null;
    await this.ego.cancelPending();
    if (notify) await this.emit('cancelled', MODEL_TEXT.cancelled(reason));
  }
  private activeCycle(id: unknown): Cycle {
    this.requireRunning();
    if (!this.cycle || id !== this.cycle.id || this.cycle.controller.signal.aborted || this.now() >= this.cycle.until
      || (this.sleepUntil !== null && this.now() >= this.sleepUntil)) throw new Error('This dream cycle is no longer active.');
    return this.cycle;
  }
  private requireCollectionIdle(): void {
    if (this.collectionTask || this.testTask || this.changingCollector) throw new Error('A collection or connection change is already running.');
  }
  private failBackend(cycle: Cycle, collection: CollectionStatus, error: Error): void {
    const backend = this.cycleBackend(cycle)!;
    cycle.attempts.push({ backend, reason: error instanceof BrowserCollectionError
      ? error.code ?? 'EGO_OPERATION_FAILED' : this.collectionError(error, 'en') ?? strings('en').error });
    cycle.backendIndex++;
    collection.backend = this.cycleBackend(cycle); collection.status = 'error'; collection.error = error;
  }
  private selectBackend(cycle: Cycle, collection: CollectionStatus): SearchOptions['backend'] | null {
    let backend = this.cycleBackend(cycle);
    while (backend) {
      const missing = this.backendMissing(backend);
      if (!missing.length) break;
      this.failBackend(cycle, collection, new SearchError(`Missing collection configuration: ${missing.join(', ')}.`));
      backend = this.cycleBackend(cycle);
    }
    collection.backend = backend;
    return backend;
  }
  private collectionResult(cycle: Cycle, sources: Array<SearchResult & { id: string }> = [], extra: Record<string, unknown> = {}) {
    return { sources, date: localClock(this.now(), this.ctx.timezone).day, quota: this.quota(cycle), untrusted: true,
      backend: this.cycleBackend(cycle), attempts: cycle.attempts.map(attempt => ({ ...attempt })),
      lastUnknownOutcome: this.ego.state().lastUnknownOutcome, ...extra };
  }
  private async finishCollection(cycle: Cycle, collection: CollectionStatus) {
    this.activeCycle(cycle.id);
    const sources = [...cycle.sources.entries()].map(([id, source]) => ({ id, ...source }));
    collection.backend = null; collection.status = 'error';
    collection.error ??= new SearchError('No selected collection method produced usable sources.');
    if (!sources.length) {
      cycle.controller.abort(); this.cycle = null;
      await this.emit('cancelled', MODEL_TEXT.collectorsExhausted);
    }
    return this.collectionResult(cycle, sources, { exhausted: true, skipped: !sources.length });
  }
  private async withCollection<T>(cycle: Cycle, call: ToolCallContext,
    action: (signal: AbortSignal, collection: CollectionStatus) => Promise<T>): Promise<T> {
    this.requireCollectionIdle();
    const signal = call.signal ? AbortSignal.any([cycle.controller.signal, call.signal]) : cycle.controller.signal;
    const collection: CollectionStatus = { backend: this.cycleBackend(cycle), status: 'collecting', error: null, attempts: cycle.attempts };
    this.collection = collection; cycle.collecting = true;
    let finished!: () => void;
    this.collectionTask = new Promise(resolve => { finished = resolve; });
    try {
      this.activeCycle(cycle.id); signal.throwIfAborted();
      return await action(signal, collection);
    } catch (error) {
      collection.status = signal.aborted ? 'idle' : 'error';
      if (!signal.aborted) collection.error = error instanceof Error ? error : new Error();
      throw error;
    } finally { cycle.collecting = false; this.collectionTask = undefined; finished(); }
  }
  private async attemptCollection(cycle: Cycle, signal: AbortSignal, collection: CollectionStatus) {
    while (true) {
      this.activeCycle(cycle.id); signal.throwIfAborted();
      const backend = this.selectBackend(cycle, collection);
      if (!backend) return this.finishCollection(cycle, collection);
      const remaining = this.quota(cycle).remaining;
      if (!remaining) throw this.quotaError(cycle);
      collection.status = 'collecting';
      if (backend === 'ego') {
        const receipt = await this.ego.connect(signal);
        await this.tick(); this.activeCycle(cycle.id); signal.throwIfAborted();
        if (receipt.error) {
          if (receipt.code === 'EGO_CANCELLED' || receipt.code === 'EGO_STOPPED') throw new BrowserCollectionError(receipt.code, receipt.error);
          this.failBackend(cycle, collection, new BrowserCollectionError(receipt.code, receipt.error));
          continue;
        }
        collection.status = 'ok'; collection.error = null; this.error = null;
        return this.collectionResult(cycle, [], { needsBrowser: true });
      }
      if (!cycle.query) {
        collection.status = 'idle';
        await this.emit('requested', MODEL_TEXT.requested);
        this.activeCycle(cycle.id); signal.throwIfAborted();
        return this.collectionResult(cycle, [], { needsSearch: true, nextBackend: backend });
      }
      if (backend === 'websearch') {
        cycle.webSearchRequest = randomUUID();
        collection.status = 'idle'; collection.error = null;
        return this.collectionResult(cycle, [], { needsWebSearch: true, tool: 'web_search',
          requestId: cycle.webSearchRequest, query: cycle.query, instructions: MODEL_TEXT.webSearchRequested });
      }
      const options = this.searchOptions(backend);
      options.maxResults = Math.min(options.maxResults, remaining);
      let results: SearchResult[];
      try { results = await this.search.search(cycle.query, signal, options); }
      catch (error) {
        await this.tick(); this.activeCycle(cycle.id); signal.throwIfAborted();
        this.failBackend(cycle, collection, error instanceof Error ? error : new Error());
        continue;
      }
      await this.tick(); this.activeCycle(cycle.id); signal.throwIfAborted();
      const sources = this.registerSources(cycle, results, cycle.materialId);
      if (!sources.length) {
        if (results.some(result => result.content.trim()) && !this.quota(cycle).remaining) throw this.quotaError(cycle);
        this.failBackend(cycle, collection, new SearchError('No usable public sources were returned.'));
        continue;
      }
      collection.status = 'ok'; collection.error = null; this.error = null;
      return this.collectionResult(cycle, sources);
    }
  }
  private async collect(args: Record<string, unknown>, call: ToolCallContext) {
    const cycle = this.activeCycle(args.cycleId);
    this.requireCollectionIdle();
    const query = textInput(args.query, 500, 'query');
    if (cycle.kind === 'daydream' && args.materialId) throw new Error('Daydreams use their alarm topic, not sleep material ids.');
    const material = args.materialId ? this.archive.materials().find(m => m.id === args.materialId) : undefined;
    if (args.materialId && !material) throw new Error('Unknown material id.');
    return this.withCollection(cycle, call, async (signal, collection) => {
      cycle.query = query; cycle.materialId = material?.id;
      return this.attemptCollection(cycle, signal, collection);
    });
  }
  private async webSearchResult(args: Record<string, unknown>, call: ToolCallContext) {
    await this.tick();
    const cycle = this.activeCycle(args.cycleId);
    if (this.cycleBackend(cycle) !== 'websearch') throw new Error('This dream is not using official WebSearch. Check dream_status.');
    if (!cycle.webSearchRequest || args.requestId !== cycle.webSearchRequest)
      throw new Error('Use the current requestId returned by dream_search for official WebSearch.');
    const failure = args.failure;
    if (failure !== undefined && (typeof failure !== 'string' || !['unavailable', 'failed', 'empty'].includes(failure) || args.sources !== undefined))
      throw new Error('Report either sources or one WebSearch failure: unavailable, failed or empty.');
    let results: SearchResult[] = [];
    if (failure === undefined) {
      if (!Array.isArray(args.sources) || args.sources.length < 1 || args.sources.length > 20)
        throw new Error('Report 1–20 public sources, or report an empty WebSearch result.');
      results = args.sources.map((item: unknown) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid WebSearch source.');
        const source = item as Record<string, unknown>;
        const title = textInput(source.title, 300, 'WebSearch source title');
        const content = textInput(source.content, 12000, 'WebSearch source content');
        const url = publicUrl(textInput(source.url, 8192, 'WebSearch source URL')).href;
        if (/[\u0000]/u.test(title + content)) throw new Error('Invalid WebSearch source text.');
        return { title, url, content, provenance: { tool: 'web_search', reportedBy: 'model' } };
      });
    }
    return this.withCollection(cycle, call, async (signal, collection) => {
      if (failure !== undefined) {
        delete cycle.webSearchRequest;
        this.failBackend(cycle, collection, new SearchError(MODEL_TEXT.webSearchFailure(failure as 'unavailable' | 'failed' | 'empty')));
        return this.attemptCollection(cycle, signal, collection);
      }
      const sources = this.registerSources(cycle, results, cycle.materialId);
      if (!sources.length) throw this.quotaError(cycle);
      delete cycle.webSearchRequest;
      collection.status = 'ok'; collection.error = null; this.error = null;
      return this.collectionResult(cycle, sources, { reportedBy: 'model', tool: 'web_search' });
    });
  }
  private async testConnection(language: Language): Promise<void> {
    const t = strings(language);
    if (this.testTask || this.collectionTask || this.changingCollector) throw new Error(t.collectionBusy);
    const readiness = this.collectionStatus(language).readiness;
    const test: ConnectionTest = { status: 'testing', backend: readiness.backend, checkedAt: null, error: null, resultCount: null };
    this.connectionTest = test;
    if (this.stopped || !readiness.ready) {
      test.status = 'error'; test.error = this.stopped ? 'stopped' : 'unconfigured'; test.checkedAt = new Date(this.now()).toISOString();
      return;
    }
    if (readiness.backend === 'websearch') {
      test.status = 'error'; test.error = 'agent-required'; test.checkedAt = new Date(this.now()).toISOString();
      return;
    }
    const controller = new AbortController();
    this.testController = controller;
    const task = Promise.resolve().then(async () => {
      try {
        const options = this.searchOptions();
        if (options.backend === 'ego') {
          const receipt = await this.ego.connect(controller.signal);
          controller.signal.throwIfAborted();
          if (receipt.error) throw new BrowserCollectionError(receipt.code, receipt.error);
          test.status = 'ok'; test.resultCount = null;
          return;
        }
        controller.signal.throwIfAborted();
        const results = await this.search.search(`current public news ${localClock(this.now(), this.ctx.timezone).day}`, controller.signal, options);
        controller.signal.throwIfAborted();
        test.status = 'ok'; test.resultCount = results.length;
      } catch (error) {
        test.status = 'error';
        test.error = controller.signal.aborted ? 'cancelled' : error instanceof Error ? error : new Error();
      } finally {
        test.checkedAt = new Date(this.now()).toISOString();
        if (this.testController === controller) { this.testController = undefined; this.testTask = undefined; }
      }
    });
    this.testTask = task;
    await task;
  }
  private async changeCollector(action: () => Promise<void> | void, language: Language): Promise<void> {
    if (this.changingCollector) throw new Error(strings(language).collectionBusy);
    this.changingCollector = true;
    try {
      this.testController?.abort();
      await this.cancelDream(MODEL_TEXT.collectorChanged);
      await Promise.allSettled([this.testTask, this.collectionTask]);
      await this.ego.cancelPending();
      await action();
      this.collection = { backend: null, status: 'idle', error: null, attempts: [] };
      this.connectionTest = { status: 'idle', backend: null, checkedAt: null, error: null, resultCount: null };
    } finally { this.changingCollector = false; }
  }
  private async browse(operation: string, args: Record<string, unknown>, call: ToolCallContext): Promise<ToolOutcome> {
    const cycle = this.activeCycle(args.cycleId);
    if (this.cycleBackend(cycle) !== 'ego') throw new Error('This dream is not using ego. Check dream_status before collecting.');
    this.requireCollectionIdle();
    if (cycle.kind === 'daydream' && args.materialId) throw new Error('Daydreams use their alarm topic, not sleep material ids.');
    const materialId = args.materialId ?? cycle.materialId;
    const material = materialId ? this.archive.materials().find(item => item.id === materialId) : undefined;
    if (materialId && !material) throw new Error('Unknown material id.');
    const { cycleId: _cycleId, materialId: _materialId, ...input } = args;
    return this.withCollection(cycle, call, async (signal, collection) => {
      if (material) { cycle.materialId = material.id; cycle.query ??= material.topic; }
      const receipt = await this.ego.run(operation, input, signal);
      await this.tick(); this.activeCycle(cycle.id); signal.throwIfAborted();
      if (receipt.error) {
        const error = new BrowserCollectionError(receipt.code, receipt.error);
        if (egoCallErrors.has(receipt.code ?? '')) {
          collection.status = 'error'; collection.error = error;
          return { text: JSON.stringify({ ...receipt, untrusted: true }), failed: true };
        }
        this.failBackend(cycle, collection, error);
        const result = await this.attemptCollection(cycle, signal, collection);
        return { text: JSON.stringify({ ...result, previousBackend: 'ego', blockedCode: receipt.code ?? 'EGO_OPERATION_FAILED', nextBackend: this.cycleBackend(cycle) }) };
      }
      if (operation === 'handoff') {
        if (!this.quota(cycle).remaining) {
          collection.status = 'ok';
          return { text: JSON.stringify(this.collectionResult(cycle,
            [...cycle.sources.entries()].map(([id, source]) => ({ id, ...source })), { handedOff: true, quotaReached: true })) };
        }
        this.failBackend(cycle, collection, new BrowserCollectionError('EGO_TASK_SPACE_USER_IN_CONTROL', 'Ego collection is paused.'));
        const result = await this.attemptCollection(cycle, signal, collection);
        return { text: JSON.stringify({ ...result, previousBackend: 'ego', blockedCode: 'EGO_TASK_SPACE_USER_IN_CONTROL', nextBackend: this.cycleBackend(cycle) }) };
      }
      const source = operation === 'read' ? receipt.source : undefined;
      let savedSource: (SearchResult & { id: string }) | undefined;
      if (source?.snippet?.trim()) {
        savedSource = this.registerSources(cycle, [{ title: source.title, url: source.url, content: source.snippet }], material?.id)[0];
        if (!savedSource) throw this.quotaError(cycle);
      }
      collection.status = 'ok'; this.error = null;
      const value = receipt.value as Record<string, unknown> | null | undefined;
      const image = value && typeof value === 'object' ? value.image as { base64?: string; mime?: string } | undefined : undefined;
      const data: BridgeReceipt = image ? { ...receipt, value: { ...value, image: undefined } } : receipt;
      const result: ToolOutcome = { text: JSON.stringify({ ...data, source: savedSource, backend: 'ego', attempts: cycle.attempts,
        date: localClock(this.now(), this.ctx.timezone).day, quota: this.quota(cycle),
        lastUnknownOutcome: this.ego.state().lastUnknownOutcome, untrusted: true }) };
      if (image?.base64 && image.mime && /^image\/(png|jpeg)$/.test(image.mime)) {
        const bytes = Buffer.from(image.base64, 'base64');
        if (bytes.length > 8 * 1024 * 1024) throw new Error('Browser screenshot exceeded the size limit.');
        result.blobs = [{ bytes, mime: image.mime, name: 'dream-page.png', fallbackText: 'Public webpage viewport from the dream Space. Image interpretation requires a vision-capable model.' }];
        if (this.host?.modelFacts?.accepts(image.mime) === false) result.text += '\nThe configured model does not accept this image. Read the semantic page snapshot instead.';
      }
      return result;
    });
  }
  private async record(args: Record<string, unknown>) {
    await this.tick();
    const cycle = this.activeCycle(args.cycleId);
    const text = textInput(args.text, 6000, 'dream text');
    const title = textInput(args.title, DREAM_TITLE_MAX_LENGTH, 'dream title');
    if (!Array.isArray(args.sourceIds) || args.sourceIds.length < 1 || args.sourceIds.length > 20 || args.sourceIds.some(id => typeof id !== 'string' || !cycle.sources.has(id)))
      throw new Error('Use source ids returned by this dream’s successful material reads or searches.');
    const sources = [...new Set(args.sourceIds as string[])].map(id => cycle.sources.get(id)!);
    const materialIds = [...new Set(sources.flatMap(s => s.materialId ? [s.materialId] : []))];
    const saved = this.archive.append(text, materialIds, sources, this.now(), title, { kind: cycle.kind,
      ...(cycle.alarm ? { alarmId: cycle.alarm.id, topic: cycle.alarm.topic } : {}), queueShare: this.sharingState().enabled });
    cycle.controller.abort(); this.cycle = null;
    await this.emit('completed', MODEL_TEXT.completed(saved.id));
    await this.offerShares();
    return saved;
  }
  private async readDream(args: Record<string, unknown>) {
    if (args.replyTo !== undefined) await this.tick();
    this.maintainArchive(true);
    const record = this.archive.get(textInput(args.id, 100, 'dream id'));
    if (!record) return { error: 'Dream not found.' };
    if (args.replyTo === undefined) return record;
    this.requireRunning();
    if (this.sleepUntil !== null || this.cycle) throw new Error('Prepare a dream reference only while awake with no active dream.');
    return { ...record, usage: this.usage!.prepare(record, args.replyTo as DreamIncomingRef) };
  }
  private async markUsed(args: Record<string, unknown>) {
    await this.tick(); this.requireRunning(); this.maintainArchive(true);
    if (this.sleepUntil !== null || this.cycle) throw new Error('Dream usage can be reported only while awake with no active dream.');
    const id = textInput(args.id, 100, 'dream id');
    if (!this.archive.get(id)) throw new Error('Dream not found.');
    const threshold = this.cfg.deepDreamThreshold;
    if (!Number.isSafeInteger(threshold) || threshold < 0 || threshold > 1000) throw new Error('Invalid deep dream threshold.');
    const verified = this.usage!.verify(id, textInput(args.usageToken, 100, 'dream usage token'), args.reply as DreamReplyRef);
    return this.archive.markUsed(id, verified.replyKey, this.now(), threshold);
  }
  tools(): ToolDef[] {
    return [...DREAM_TOOL_DECLS, ...DREAM_EGO_TOOL_DECLS].map(spec => ({ ...spec, interruptible: spec.name === 'dream_search' || spec.name === 'dream_web_search_result' || spec.name.startsWith('dream_ego_'), handler: async (args, call) => {
      if (spec.name.startsWith('dream_ego_')) return this.browse(spec.name.slice('dream_ego_'.length), args, call);
      let value: unknown;
      switch (spec.name) {
        case 'dream_status': value = this.modelState(); break;
        case 'dream_sleep': {
          await this.tick();
          this.requireRunning(); const { event, body } = this.recentMessage(args.eventCursor); const command = sleepCommand(body);
          if (command?.kind === 'wake') throw new Error('A wake command cannot authorize sleep.');
          const minutes = command?.kind === 'sleep' ? command.minutes : bounded(args.durationMinutes ?? this.cfg.sleepMinutes, 1, 1440, 'sleep duration');
          if (!this.handled.has(event.cursor)) {
            const sameLocalWake = event.cursor === this.controlCursor && event.cursor === this.localWakeCursor && !this.newerInteraction(event.cursor);
            if (event.cursor <= this.controlCursor && !sameLocalWake) throw new Error('This command predates the current sleep state.');
            this.handled.add(event.cursor); await this.sleep(minutes, event.cursor);
          }
          value = this.modelState(); break;
        }
        case 'dream_wake': {
          await this.tick();
          const { event, body } = this.recentMessage(args.eventCursor);
          const command = sleepCommand(body);
          if (command?.kind === 'sleep') throw new Error('A sleep command cannot authorize waking.');
          if (isQQSource(event.source) && this.sleepUntil !== null && command?.kind !== 'wake' && args.explicitWakeRequest !== true)
            throw new Error('QQ waking requires an explicit owner wake request. A message or mention alone does not authorize waking.');
          if (event.cursor > this.controlCursor) await this.wake(MODEL_TEXT.userWake, event.cursor);
          value = this.modelState(); break;
        }
        case 'dream_add_material': await this.tick(); this.recentMessage(args.eventCursor); value = this.archive.add(args.topic, this.now()); break;
        case 'dream_search': value = await this.collect(args, call); break;
        case 'dream_web_search_result': value = await this.webSearchResult(args, call); break;
        case 'dream_record': value = await this.record(args); break;
        case 'dream_query': {
          this.maintainArchive(true);
          const date = args.date === undefined ? '' : String(args.date);
          if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date.');
          const limit = Math.trunc(bounded(args.limit ?? 20, 1, 50, 'query limit'));
          value = this.archive.query(String(args.query ?? ''), '', Number.MAX_SAFE_INTEGER).filter(d => !date || localClock(Date.parse(d.createdAt), this.ctx.timezone).day === date).slice(0, limit).map(d => ({ id: d.id, createdAt: d.createdAt, kind: d.kind ?? null, title: d.title, titleSource: d.titleSource, score: d.score, tier: d.tier, promotedAt: d.promotedAt, text: d.text.slice(0, 300) })); break;
        }
        case 'dream_read': value = await this.readDream(args); break;
        case 'dream_mark_used': value = await this.markUsed(args); break;
      }
      return JSON.stringify(value);
    } }));
  }
  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const s = strings(language);
    const readiness = this.collectionStatus(language).readiness;
    const backendName = readiness.backend === 'ego' ? s.egoTitle : readiness.backend === 'tavily' ? 'Tavily' : readiness.backend === 'browser' ? s.browserTitle
      : readiness.backend === 'websearch' ? s.webSearchTitle : s.noBackend;
    const promptName = language === 'zh' || language === 'zh-Hant' ? 'ENV_PROMPT.zh.md' : 'ENV_PROMPT.en.md';
    const deploymentPath = join(this.ctx.botDir, 'worlds', 'dream', promptName);
    return {
      label: s.name, config: dreamConfigGroups(language),
      lamps: [{ label: s.collectionConfigTitle, state: readiness.ready ? 'online' : 'offline',
        hint: `${s.activeBackend}: ${backendName}${readiness.backend === 'websearch' ? `; ${s.webSearchCheckHint}` : ''}${readiness.missing.length ? `; ${s.missingConfiguration}: ${readiness.missing.join(', ')}` : ''}` }],
      panels: [{ id: 'dream', title: s.panelTitle, getMethods: ['state', 'query'] },
        { id: 'collection-settings', title: s.collectionConfigTitle, getMethods: ['state'] },
        { id: 'qq-talk', title: s.qqTalkTitle, getMethods: ['state'] }],
      invoke: async (panel, method, args) => {
        if (panel === 'qq-talk') {
          if (method === 'state') return qqConfig(this.cfg);
          if (method !== 'saveQQConfig') throw new Error('Unknown method.');
          let patch: ReturnType<typeof qqConfigPatch>;
          try { patch = qqConfigPatch(args[0]); } catch { throw new Error(s.qqTalkInvalidConfig); }
          // persist updates the live configuration before writing it.
          const previous = qqConfig(this.cfg);
          try { this.ctx.persist(patch); }
          catch (error) { Object.assign(this.cfg, previous); throw error; }
          return qqConfig(this.cfg);
        }
        if (panel !== 'dream' && panel !== 'collection-settings') throw new Error('Unknown panel.');
        if (panel === 'collection-settings' && !['state', 'connectEgo', 'prepareEgoHelper', 'stopEgoHelper', 'saveKey', 'saveCollectorConfig', 'testConnection'].includes(method)) throw new Error('Unknown method.');
        switch (method) {
          case 'state': return this.state(language);
          case 'addMaterial': this.archive.add(args[0], this.now()); return this.state(language);
          case 'removeMaterial': this.archive.remove(textInput(args[0], 100, 'material id')); return this.state(language);
          case 'saveDaydreamAlarm': {
            try { this.archive.saveDaydreamAlarm(args[0] as { id?: string; time: string; topic: string }, this.now()); }
            catch { throw new Error(s.configInvalid); }
            return this.state(language);
          }
          case 'removeDaydreamAlarm': this.archive.removeDaydreamAlarm(textInput(args[0], 100, 'alarm id')); return this.state(language);
          case 'removeDream': this.archive.removeDream(textInput(args[0], 100, 'dream id')); return this.state(language);
          case 'query': return this.archive.query(String(args[0] ?? ''));
          case 'sleep': await this.sleep(args[0] ?? this.cfg.sleepMinutes); return this.state(language);
          case 'wake': await this.wake(); return this.state(language);
          case 'testConnection': await this.testConnection(language); return this.state(language);
          case 'saveCollectorConfig': {
            let patch: ReturnType<typeof collectorPatch>;
            try { patch = collectorPatch(args[0]); } catch { throw new Error(s.configInvalid); }
            await this.changeCollector(() => { this.ctx.persist(patch); this.ego.reconfigure(); }, language);
            return this.state(language);
          }
          case 'connectEgo': {
            this.requireRunning();
            const patch = collectorPatch({ egoExecutableFile: args[0] ?? this.cfg.egoExecutableFile });
            await this.changeCollector(async () => {
              this.requireRunning();
              this.ctx.persist(patch);
              await this.ego.connect();
            }, language);
            return this.state(language);
          }
          case 'prepareEgoHelper':
          case 'stopEgoHelper': {
            this.requireRunning();
            await this.changeCollector(async () => {
              const receipt = method === 'prepareEgoHelper' ? await this.ego.prepareHelper() : await this.ego.stopHelper();
              if (receipt.error) throw new Error(egoBrowserErrorText(receipt.code, language));
            }, language);
            return this.state(language);
          }
          case 'saveKey': {
            const key = textInput(args[0], 512, 'Tavily key');
            if (/\s/.test(key)) throw new Error(s.configInvalid);
            await this.changeCollector(() => this.ctx.storeSecret(DREAM_SECRET, key), language);
            return { keyConfigured: true };
          }
          default: throw new Error('Unknown method.');
        }
      },
      promptDocs: [{ key: 'worlds.dream.envPrompt', title: s.promptTitle, description: s.promptDescription,
        path: existsSync(deploymentPath) ? deploymentPath : fileURLToPath(new URL(`./${promptName}`, import.meta.url)), deploymentPath,
        role: 'envPrompt', vars: [{ name: 'dream.state', description: s.configTitle },
          { name: 'dream.index', description: s.dreamIndexDescription }] }],
    };
  }
}

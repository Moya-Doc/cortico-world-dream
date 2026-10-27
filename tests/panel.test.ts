import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { mountDreamPanel, mountCollectionSettings, type DreamPanelState, type DreamRecord } from '../webui/client.ts';
import { DREAM_DEFAULTS } from '../src/config.ts';
import { collectorConfig } from '../src/collection.ts';
import { configLabels, DREAM_LANGUAGES, egoBrowserErrorText, egoErrorText, strings } from '../src/strings.ts';

const cleanup: Array<() => void> = [];
const panelCss = readFileSync(new URL('../webui/style.css', import.meta.url), 'utf8');
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function archiveRecord(id: string, text: string, title = 'A dream of discovery'): DreamRecord {
  return { id, title, text, createdAt: '2026-01-02T12:00:00.000Z', materialIds: [], sources: [], score: 0, tier: 'ordinary', promotedAt: null };
}

function harness(records: DreamRecord[] = [], backend: Pick<DreamPanelState, 'keyConfigured' | 'egoConfigured' | 'activeBackend'> = {
  keyConfigured: false, egoConfigured: false, activeBackend: null,
}, panel: 'dream' | 'settings' = 'dream') {
  const dom = new JSDOM('<main></main>', { url: 'https://panel.example' });
  const style = dom.window.document.createElement('style'); style.textContent = panelCss; dom.window.document.head.append(style);
  const root = dom.window.document.querySelector('main')!;
  const abort = new dom.window.AbortController();
  const state: DreamPanelState = {
    sleeping: false, sleepUntil: null, dreaming: false, cycleId: null, phase: 'awake',
    dreamKind: null, daydreamEnabled: true, daydreamAlarms: [],
    browserConfigured: true, browserMissing: [], webSearchConfigured: true, webSearchMissing: [],
    readiness: { ready: backend.activeBackend !== null, backend: backend.activeBackend, missing: [] },
    collectorConfig: { ...collectorConfig({ ...DREAM_DEFAULTS }), collectorOrder: [] },
    connectionTest: { status: 'idle', backend: null, checkedAt: null, error: null, resultCount: null },
    materials: [], dreams: records, ...backend, error: null,
    egoMissing: backend.egoConfigured ? [] : ['Browser path'],
    tavilyMissing: backend.keyConfigured ? [] : ['API Key'],
    egoConnection: {
      running: true, connected: backend.egoConfigured, connecting: false, halted: false, reason: null,
      uncertain: false, spaceMissing: false, spaceId: null, spaceName: '', connectionMode: 'auto', transport: null,
      lastUnknownOutcome: null,
      helperOnline: false, helperDir: '/fixture/helper', launcherFile: '', canPrepareHelper: true, lastOperation: null,
    },
    collection: { backend: null, status: 'idle', error: null, lastSuccessAt: null },
    quota: { date: '2026-01-02', cycleUsed: 0, cycleLimit: DREAM_DEFAULTS.maxSourcesPerDream, dailyUsed: 0, dailyLimit: DREAM_DEFAULTS.maxSourcesPerDay, remaining: DREAM_DEFAULTS.maxSourcesPerDream },
  };
  let key = '';
  let testCount = 0;
  let testFailure = '';
  let finishTest: (() => void) | undefined;
  let deferTest = false;
  let savedPatch: Record<string, unknown> | undefined;
  let collectorFailure = false;
  let connectionFailure: { code?: string; reason?: string; message: string } | undefined;
  let deferConnect = false;
  let finishConnect: (() => void) | undefined;
  const configuredSleepMinutes = 30;
  let keyFailure = false;
  let deleteFailure = false;
  let poll: (() => void) | undefined;
  let pendingState: Promise<DreamPanelState> | undefined;
  const context = {
    root, signal: abort.signal, language: 'en',
    async invoke(method: string, args: unknown[] = []) {
      if (method === 'state') return pendingState ?? structuredClone(state);
      if (method === 'addMaterial') {
        state.materials.push({ id: `material-${state.materials.length}`, topic: String(args[0]), tag: '指定素材', createdAt: new Date().toISOString(), lastProcessedDate: null });
      } else if (method === 'removeMaterial') {
        state.materials = state.materials.filter((material) => material.id !== args[0]);
      } else if (method === 'saveDaydreamAlarm') {
        const value = args[0] as { id?: string; time: string; topic: string };
        const existing = state.daydreamAlarms.find(alarm => alarm.id === value.id);
        if (existing) Object.assign(existing, value);
        else state.daydreamAlarms.push({ ...value, id: `alarm-${state.daydreamAlarms.length}`, createdAt: '2026-10-25T00:00:00Z' });
      } else if (method === 'removeDaydreamAlarm') {
        state.daydreamAlarms = state.daydreamAlarms.filter(alarm => alarm.id !== args[0]);
      } else if (method === 'removeDream') {
        if (deleteFailure) throw new Error('Dream deletion failed.');
        state.dreams = state.dreams.filter(dream => dream.id !== args[0]);
      } else if (method === 'sleep') {
        state.sleeping = true; state.phase = 'sleeping';
        state.sleepUntil = new Date(Date.now() + Number(args[0] ?? configuredSleepMinutes) * 60_000).toISOString();
      } else if (method === 'wake') {
        state.sleeping = false; state.phase = 'awake';
        state.sleepUntil = null;
      } else if (method === 'query') {
        return state.dreams.filter((record) => record.text.includes(String(args[0])));
      } else if (method === 'saveKey') {
        if (keyFailure) throw new Error(`Rejected credential: ${args[0]}`);
        key = String(args[0]);
        state.keyConfigured = true;
        state.tavilyMissing = [];
      } else if (method === 'connectEgo') {
        state.collectorConfig.egoExecutableFile = String(args[0] ?? '');
        state.egoConnection.connecting = true;
        if (deferConnect) await new Promise<void>(resolve => { finishConnect = resolve; });
        state.egoConnection.connecting = false;
        if (connectionFailure) {
          state.egoConnection.connected = false;
          state.egoConnection.code = connectionFailure.code;
          state.egoConnection.reason = connectionFailure.reason ?? null;
          throw new Error(connectionFailure.message);
        }
        state.egoConnection.connected = true;
        state.egoConnection.spaceName = 'Dream materials'; state.egoConnection.spaceId = 17; state.egoConnection.transport = 'direct';
        state.egoConfigured = true; state.egoMissing = [];
      } else if (method === 'prepareEgoHelper') {
        state.egoConnection.launcherFile = '/fixture/helper/start-helper.sh';
      } else if (method === 'stopEgoHelper') {
        state.egoConnection.helperOnline = false;
      } else if (method === 'saveCollectorConfig') {
        if (collectorFailure) throw new Error('Settings could not be saved.');
        savedPatch = args[0] as Record<string, unknown>;
        Object.assign(state.collectorConfig, savedPatch);
      } else if (method === 'testConnection') {
        testCount++;
        state.connectionTest.status = 'testing';
        if (deferTest) await new Promise<void>(resolve => { finishTest = resolve; });
        state.connectionTest = { status: testFailure ? 'error' : 'ok', backend: state.activeBackend, checkedAt: '2026-10-25T12:00:00.000Z', error: testFailure || null, resultCount: testFailure ? null : 2 };
      } else {
        throw new Error(`Unknown panel method: ${method}`);
      }
    },
    interval(fn: () => void) {
      poll = fn;
      return { dispose() { poll = undefined; } };
    },
  } as unknown as WebUiPanelContext;
  const mounted = panel === 'settings' ? mountCollectionSettings(context) : mountDreamPanel(context);
  const dispose = () => { abort.abort(); mounted.dispose(); };
  cleanup.push(() => { dispose(); dom.window.close(); });
  function input(selector: string, value: string) {
    const node = root.querySelector<HTMLInputElement>(selector)!;
    node.value = value;
    node.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    return node;
  }
  function submit(selector: string) {
    root.querySelector(selector)!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  }
  return {
    root, state, input, submit, dispose, configuredSleepMinutes,
    poll: () => poll?.(),
    get polling() { return Boolean(poll); },
    get key() { return key; },
    get testCount() { return testCount; },
    get savedPatch() { return savedPatch; },
    failTest(message: string) { testFailure = message; },
    pauseTest() { deferTest = true; },
    finishTest() { finishTest?.(); },
    rejectKey() { keyFailure = true; },
    rejectDelete() { deleteFailure = true; },
    rejectCollector(value: boolean) { collectorFailure = value; },
    rejectEgo(value: typeof connectionFailure) { connectionFailure = value; },
    pauseConnect() { deferConnect = true; },
    finishConnect() { finishConnect?.(); },
    deferState(value: Promise<DreamPanelState>) { pendingState = value; },
  };
}

describe('Dream panel', () => {
  it.each([
    { keyConfigured: false, egoConfigured: false, activeBackend: null },
    { keyConfigured: true, egoConfigured: false, activeBackend: 'tavily' },
    { keyConfigured: false, egoConfigured: true, activeBackend: 'ego' },
    { keyConfigured: true, egoConfigured: true, activeBackend: 'ego' },
    { keyConfigured: true, egoConfigured: true, activeBackend: 'browser' },
  ] as const)('shows plain backend status without setup inputs for %j', async backend => {
    const ui = harness([], backend);
    const t = strings('en');
    const selected = backend.activeBackend === 'ego' ? t.egoTitle : backend.activeBackend === 'tavily' ? 'Tavily'
      : backend.activeBackend === 'browser' ? t.browserTitle : t.noBackend;
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-backend')?.textContent).toBe(`${t.backendActive} · ${selected}`));
    expect(ui.root.querySelector('.dream-ego-state')?.textContent).toBe(backend.egoConfigured ? t.keyPresent : t.keyMissing);
    expect(ui.root.querySelector('.dream-key-state')?.textContent).toBe(backend.keyConfigured ? t.keyPresent : t.keyMissing);
    expect(ui.root.querySelector('input[type=password],.dream-ego-path,.dream-profile,.dream-config-form')).toBeNull();
    expect(ui.root.querySelector('[data-ready],.dream-provider-state')).toBeNull();
  });

  it.each(['dream', 'settings'] as const)('distinguishes configuration indicators from the currently selected backend in %s', async panel => {
    const ui = harness([], { keyConfigured: true, egoConfigured: true, activeBackend: 'ego' }, panel);
    await vi.waitFor(() => expect(ui.root.querySelector<HTMLElement>('.dream-key-state')?.dataset.configured).toBe('true'));
    const ego = ui.root.querySelector<HTMLElement>('.dream-ego-state')!;
    const tavily = ui.root.querySelector<HTMLElement>('.dream-key-state')!;
    expect(ego.dataset.configured).toBe('true');
    expect(ui.root.querySelector('.dream-backend')?.textContent).toBe(`${strings('en').backendActive} · ${strings('en').egoTitle}`);
    ui.state.tavilyMissing = ['Search timeout']; ui.poll();
    await vi.waitFor(() => expect(tavily.dataset.configured).toBe('false'));
    expect(tavily.textContent).toBe(strings('en').keyMissing);
    const window = ui.root.ownerDocument.defaultView!;
    expect(window.getComputedStyle(ego.querySelector('.dream-status-dot')!).backgroundColor)
      .not.toBe(window.getComputedStyle(tavily.querySelector('.dream-status-dot')!).backgroundColor);
    expect(ego.querySelector('.dream-status-dot')!.getAttribute('aria-hidden')).toBe('true');
    ui.state.tavilyMissing = []; ui.poll();
    await vi.waitFor(() => expect(tavily.dataset.configured).toBe('true'));
    if (panel === 'settings') {
      const browser = ui.root.querySelector<HTMLElement>('.dream-browser-state')!;
      expect(browser.dataset.configured).toBe('true');
      ui.state.browserConfigured = false; ui.state.browserMissing = ['Search timeout']; ui.poll();
      await vi.waitFor(() => expect(browser.dataset.configured).toBe('false'));
    }
  });

  it('keeps configured methods unselected until the collection order is saved', async () => {
    const ui = harness([], { keyConfigured: true, egoConfigured: true, activeBackend: null });
    await vi.waitFor(() => expect(ui.root.querySelectorAll('.dream-collector-choice')).toHaveLength(4));
    const checkboxes = [...ui.root.querySelectorAll<HTMLInputElement>('.dream-collector-selected')];
    expect(checkboxes.every(input => !input.checked && !input.disabled)).toBe(true);
    expect(ui.root.querySelectorAll('.dream-collector-choice [data-configured=true]')).toHaveLength(3);
    const actions = ui.root.querySelector<HTMLElement>('.dream-collector-actions')!;
    expect(ui.root.ownerDocument.defaultView!.getComputedStyle(actions).display).toBe('none');
    expect(ui.root.querySelector<HTMLElement>('.dream-collector-empty')!.hidden).toBe(false);
    expect(ui.root.querySelector<HTMLButtonElement>('.dream-collector-order-save')!.disabled).toBe(true);
    checkboxes[0]!.click();
    expect(ui.root.ownerDocument.defaultView!.getComputedStyle(actions).display).not.toBe('none');
    expect(ui.state.collectorConfig.collectorOrder).toEqual([]); expect(ui.savedPatch).toBeUndefined();
    ui.submit('.dream-collector-order-form');
    await vi.waitFor(() => expect(ui.savedPatch).toEqual({ collectorOrder: ['ego'] }));
    expect(ui.state.collectorConfig.collectorOrder).toEqual(['ego']);
    expect(ui.root.querySelector<HTMLButtonElement>('.dream-collector-order-save')!.disabled).toBe(true);
  });

  it('orders selected methods, appends reselected methods and preserves edits and focus during polling', async () => {
    const ui = harness();
    await vi.waitFor(() => expect(ui.root.querySelectorAll('.dream-collector-choice')).toHaveLength(4));
    ui.state.collectorConfig.collectorOrder = ['tavily', 'ego']; ui.poll();
    const order = () => [...ui.root.querySelectorAll<HTMLElement>('[data-group=builtin] .dream-collector-choice')].map(row => row.dataset.backend);
    const checkbox = (backend: string) => ui.root.querySelector<HTMLInputElement>(`.dream-collector-selected[name=${backend}]`)!;
    const move = (backend: string, direction: string) => ui.root.querySelector<HTMLButtonElement>(`[data-backend=${backend}] .dream-collector-${direction}`)!;
    await vi.waitFor(() => expect(order()).toEqual(['tavily', 'ego', 'browser']));
    expect(move('tavily', 'up').disabled).toBe(true); expect(move('ego', 'down').disabled).toBe(true);
    checkbox('browser').click(); move('browser', 'up').click();
    expect(order()).toEqual(['tavily', 'browser', 'ego']);
    checkbox('tavily').click(); expect(order()).toEqual(['browser', 'ego', 'tavily']);
    checkbox('tavily').click(); expect(order()).toEqual(['browser', 'ego', 'tavily']);
    checkbox('ego').focus(); ui.poll(); await Promise.resolve();
    expect(ui.root.ownerDocument.activeElement).toBe(checkbox('ego'));
    expect(order()).toEqual(['browser', 'ego', 'tavily']);
    expect(ui.state.collectorConfig.collectorOrder).toEqual(['tavily', 'ego']);
    ui.submit('.dream-collector-order-form');
    await vi.waitFor(() => expect(ui.savedPatch).toEqual({ collectorOrder: ['browser', 'ego', 'tavily'] }));
    ui.state.collectorConfig.collectorOrder = ['tavily']; ui.poll();
    await vi.waitFor(() => expect(order()).toEqual(['tavily', 'ego', 'browser']));
    expect(checkbox('ego').checked).toBe(false); expect(checkbox('browser').checked).toBe(false);
  });

  it('retains an unsaved empty selection after a failure and allows retrying it', async () => {
    const ui = harness();
    await vi.waitFor(() => expect(ui.root.querySelectorAll('.dream-collector-choice')).toHaveLength(4));
    ui.state.collectorConfig.collectorOrder = ['browser']; ui.poll();
    const checkbox = ui.root.querySelector<HTMLInputElement>('.dream-collector-selected[name=browser]')!;
    await vi.waitFor(() => expect(checkbox.checked).toBe(true));
    checkbox.click(); ui.rejectCollector(true); ui.submit('.dream-collector-order-form');
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-action-error')?.textContent).toBe('Settings could not be saved.'));
    ui.poll(); await Promise.resolve(); expect(checkbox.checked).toBe(false);
    expect(ui.state.collectorConfig.collectorOrder).toEqual(['browser']);
    expect(ui.root.querySelector<HTMLButtonElement>('.dream-collector-order-save')!.disabled).toBe(false);
    ui.rejectCollector(false); ui.submit('.dream-collector-order-form');
    await vi.waitFor(() => expect(ui.state.collectorConfig.collectorOrder).toEqual([]));
    expect(ui.savedPatch).toEqual({ collectorOrder: [] });
  });

  it('groups collectors without changing their shared priority and saves cross-group moves', async () => {
    const ui = harness();
    const t = strings('en');
    const row = (backend: string) => ui.root.querySelector<HTMLElement>(`[data-backend=${backend}]`)!;
    const rank = (backend: string) => row(backend).querySelector('.dream-collector-position')!.textContent;
    const move = (backend: string, direction: string) => row(backend).querySelector<HTMLButtonElement>(`.dream-collector-${direction}`)!;
    await vi.waitFor(() => expect(row('websearch').querySelector('.dream-websearch-state')?.textContent).toBe(t.webSearchCheck));
    expect([...ui.root.querySelectorAll('.dream-collector-group legend')].map(node => node.textContent)).toEqual([t.collectorBuiltIn, t.collectorWorldExtensions]);
    expect([...ui.root.querySelectorAll<HTMLElement>('[data-group=builtin] [data-backend]')].map(node => node.dataset.backend)).toEqual(['ego', 'tavily', 'browser']);
    expect(row('websearch').closest('fieldset')?.dataset.group).toBe('world');
    expect(row('websearch').querySelector<HTMLElement>('.dream-websearch-state')!.dataset.configured).toBe('unknown');
    expect(row('websearch').textContent).not.toContain(t.keyPresent);
    expect(ui.root.querySelector('.dream-websearch-hint')?.textContent).toBe(t.webSearchCheckHint);
    ui.state.collectorConfig.collectorOrder = ['browser']; ui.poll();
    await vi.waitFor(() => expect(rank('browser')).toBe('1'));
    row('websearch').querySelector<HTMLInputElement>('input')!.click();
    expect(rank('websearch')).toBe('2');
    move('websearch', 'up').click();
    expect(rank('websearch')).toBe('1'); expect(rank('browser')).toBe('2');
    expect(move('websearch', 'up').disabled).toBe(true); expect(move('browser', 'down').disabled).toBe(true);
    ui.poll(); await Promise.resolve();
    expect(rank('websearch')).toBe('1');
    ui.submit('.dream-collector-order-form');
    await vi.waitFor(() => expect(ui.savedPatch).toEqual({ collectorOrder: ['websearch', 'browser'] }));
    await vi.waitFor(() => expect(move('browser', 'up').disabled).toBe(false));
    move('browser', 'up').click();
    expect(rank('websearch')).toBe('2'); expect(rank('browser')).toBe('1');
    expect(row('websearch').closest('fieldset')?.dataset.group).toBe('world');
    expect(row('browser').closest('fieldset')?.dataset.group).toBe('builtin');
    ui.submit('.dream-collector-order-form');
    await vi.waitFor(() => expect(ui.savedPatch).toEqual({ collectorOrder: ['browser', 'websearch'] }));
  });

  it('shows the current fallback backend and renders previous failure reasons literally', async () => {
    const ui = harness([], { keyConfigured: true, egoConfigured: true, activeBackend: 'tavily' });
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-phase')?.textContent).toBe(strings('en').awake));
    ui.state.readiness.backend = 'ego'; ui.state.collection.backend = 'tavily';
    ui.state.collection.attempts = [{ backend: 'ego', reason: '<img src=x> requires user control' }]; ui.poll();
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-collection-attempts')?.textContent).toContain('<img src=x> requires user control'));
    expect(ui.root.querySelector('.dream-backend')?.textContent).toBe(`${strings('en').backendActive} · Tavily`);
    expect(ui.root.querySelector('img')).toBeNull();
    ui.state.collection.attempts = []; ui.poll();
    await vi.waitFor(() => expect(ui.root.querySelector<HTMLElement>('.dream-collection-attempts')!.hidden).toBe(true));
  });

  it('renders every phase and explains that dream generation awaits Coo', async () => {
    const ui = harness();
    const t = strings('en');
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-phase')?.textContent).toBe(t.awake));
    for (const [phase, label] of [['sleeping', t.sleeping], ['waiting', t.phaseWaiting], ['collecting', t.phaseCollecting], ['generating', t.phaseGenerating]] as const) {
      ui.state.phase = phase; ui.poll();
      await vi.waitFor(() => expect(ui.root.querySelector('.dream-phase')?.textContent).toBe(label));
    }
    expect(ui.root.querySelector<HTMLElement>('.dream-phase-hint')!.hidden).toBe(false);
    expect(ui.root.querySelector('.dream-phase-hint')?.textContent).toBe(t.phaseGeneratingHint);
  });

  it('identifies a daydream while preserving its waiting, collection and generation phases', async () => {
    const ui = harness(); const t = strings('en');
    ui.state.dreamKind = 'daydream'; ui.state.dreaming = true;
    for (const [phase, label] of [['waiting', t.phaseWaiting], ['collecting', t.phaseCollecting], ['generating', t.phaseGenerating]] as const) {
      ui.state.phase = phase; ui.poll();
      await vi.waitFor(() => expect(ui.root.querySelector('.dream-phase')?.textContent).toBe(`${t.daydreamLabel} · ${label}`));
    }
    ui.state.dreamKind = 'sleep'; ui.poll();
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-phase')?.textContent).toBe(t.phaseGenerating));
  });

  it('adds, edits and removes persistent alarm topics without losing editor changes on polling', async () => {
    const ui = harness();
    await vi.waitFor(() => expect(ui.root.textContent).toContain(strings('en').daydreamAlarmEmpty));
    ui.input('.dream-alarm-time', '14:30'); ui.input('.dream-alarm-topic', 'Public observatory discoveries');
    ui.root.querySelector<HTMLButtonElement>('.dream-alarm-save')!.click();
    await vi.waitFor(() => expect(ui.root.querySelectorAll('.dream-alarm')).toHaveLength(1));
    const saved = { ...ui.state.daydreamAlarms[0] };
    expect(saved).toMatchObject({ time: '14:30', topic: 'Public observatory discoveries' });
    ui.root.querySelector<HTMLButtonElement>('.dream-alarm-edit')!.click();
    ui.input('.dream-alarm-time', '15:45'); const input = ui.input('.dream-alarm-topic', 'Public ocean research');
    ui.poll(); await Promise.resolve();
    expect(input.value).toBe('Public ocean research');
    expect(ui.root.querySelector<HTMLInputElement>('.dream-alarm-time')!.value).toBe('15:45');
    ui.root.querySelector<HTMLButtonElement>('.dream-alarm-save')!.click();
    await vi.waitFor(() => expect(ui.state.daydreamAlarms[0].topic).toBe('Public ocean research'));
    expect(ui.state.daydreamAlarms).toHaveLength(1);
    expect(ui.state.daydreamAlarms[0]).toMatchObject({ id: saved.id, time: '15:45', createdAt: saved.createdAt });
    await vi.waitFor(() => expect(ui.root.querySelector<HTMLButtonElement>('.dream-alarm-edit')!.disabled).toBe(false));
    ui.root.querySelector<HTMLButtonElement>('.dream-alarm-edit')!.click();
    ui.root.querySelector<HTMLButtonElement>('.dream-alarm-remove')!.click();
    await vi.waitFor(() => expect(ui.root.querySelectorAll('.dream-alarm')).toHaveLength(0));
    expect(ui.state.daydreamAlarms).toEqual([]); expect(input.value).toBe('');
  });

  it('shows disabled and migrated alarms, requires a topic, and cancels edits without changing the alarm', async () => {
    const ui = harness(); const t = strings('en');
    ui.state.daydreamEnabled = false;
    ui.state.daydreamAlarms = [{ id: 'legacy', time: '09:00', topic: '', createdAt: '2026-10-25T00:00:00Z' }]; ui.poll();
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-alarm-topic-missing')?.textContent).toBe(t.daydreamAlarmTopicMissing));
    expect(ui.root.textContent).toContain(t.daydreamAlarmDisabled);
    ui.root.querySelector<HTMLButtonElement>('.dream-alarm-edit')!.click();
    expect(ui.root.querySelector<HTMLInputElement>('.dream-alarm-topic')!.validity.valueMissing).toBe(true);
    ui.root.querySelector<HTMLButtonElement>('.dream-alarm-save')!.click();
    expect(ui.state.daydreamAlarms[0].topic).toBe('');
    ui.input('.dream-alarm-topic', 'A proposed topic'); ui.root.querySelector<HTMLButtonElement>('.dream-alarm-cancel')!.click();
    expect(ui.state.daydreamAlarms[0].topic).toBe(''); expect(ui.root.querySelector<HTMLInputElement>('.dream-alarm-topic')!.value).toBe('');
    expect(ui.root.querySelector<HTMLButtonElement>('.dream-alarm-save')!.textContent).toBe(t.daydreamAlarmAdd);
    ui.root.querySelector<HTMLButtonElement>('.dream-alarm-edit')!.click(); ui.input('.dream-alarm-topic', 'A recurring public topic');
    ui.root.querySelector<HTMLButtonElement>('.dream-alarm-save')!.click();
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-alarm-topic-missing')).toBeNull());
    expect(ui.state.daydreamAlarms[0]).toMatchObject({ id: 'legacy', time: '09:00', topic: 'A recurring public topic' });
  });

  it('shows a previous collection success alongside a specific current failure', async () => {
    const ui = harness([], { keyConfigured: true, egoConfigured: true, activeBackend: 'ego' });
    ui.state.collection = { backend: 'tavily', status: 'error', error: '<img> search limit reached', lastSuccessAt: '2026-10-24T12:00:00.000Z' };
    ui.poll();
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-collection-error')?.textContent).toBe(ui.state.collection.error));
    expect(ui.root.querySelector('.dream-collection-result')?.textContent).toContain(strings('en').lastSuccess);
    expect(ui.root.querySelector('img')).toBeNull();
    expect(ui.root.querySelector('.dream-backend')?.textContent).toContain(strings('en').egoTitle);
  });

  it('clears recovered World errors on polling and shows collection failures only in the result', async () => {
    const ui = harness();
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-phase')?.textContent).toBe(strings('en').awake));
    ui.state.error = 'A collection operation failed'; ui.poll();
    await vi.waitFor(() => expect(ui.root.querySelector<HTMLElement>('.dream-state-error')!.hidden).toBe(false));
    ui.state.collection.error = 'The browser executable does not exist'; ui.state.collection.status = 'error'; ui.poll();
    await vi.waitFor(() => expect(ui.root.querySelector<HTMLElement>('.dream-state-error')!.hidden).toBe(true));
    expect(ui.root.querySelector('.dream-collection-error')?.textContent).toBe(ui.state.collection.error);
    ui.state.error = null; ui.state.collection.error = null; ui.state.collection.status = 'ok';
    ui.state.collection.lastSuccessAt = '2026-10-25T12:00:00.000Z'; ui.poll();
    await vi.waitFor(() => expect(ui.root.querySelector<HTMLElement>('.dream-collection-error')!.hidden).toBe(true));
    expect(ui.root.querySelector<HTMLElement>('.dream-state-error')!.hidden).toBe(true);
    expect(ui.root.querySelector('.dream-state-error')?.textContent).toBe('');
  });

  it('keeps connection testing in collection settings without adding records', async () => {
    const ui = harness([], { keyConfigured: true, egoConfigured: false, activeBackend: 'tavily' }, 'settings');
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-backend')?.textContent).toContain('Tavily'));
    ui.pauseTest();
    const test = ui.root.querySelector<HTMLButtonElement>('.dream-test')!;
    test.click();
    await vi.waitFor(() => expect(test.textContent).toBe(strings('en').testRunning));
    expect(test.disabled).toBe(true);
    test.click();
    expect(ui.testCount).toBe(1);
    ui.finishTest();
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-test-result')?.textContent).toContain(strings('en').testSuccess));
    expect(ui.root.querySelector('.dream-test-result')?.textContent).toContain('Tavily');
    expect(ui.root.querySelector('.dream-test-result')?.textContent).toContain('2');
    expect(ui.state.dreams).toEqual([]);
    expect(ui.state.materials).toEqual([]);
    expect(ui.state.collection.lastSuccessAt).toBeNull();
  });

  it('does not issue a panel connection test for an agent-called World collector', async () => {
    const ui = harness([], { keyConfigured: false, egoConfigured: false, activeBackend: 'websearch' }, 'settings');
    const t = strings('en');
    const test = ui.root.querySelector<HTMLButtonElement>('.dream-test')!;
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-backend')?.textContent).toContain(t.webSearchTitle));
    expect(test.disabled).toBe(true);
    expect(ui.root.querySelector('.dream-test-hint')?.textContent).toBe(t.webSearchTestUnsupported);
    test.click(); expect(ui.testCount).toBe(0);
    ui.state.activeBackend = 'browser'; ui.state.readiness.backend = 'browser'; ui.poll();
    await vi.waitFor(() => expect(test.disabled).toBe(false));
    expect(ui.root.querySelector('.dream-test-hint')?.textContent).toBe(t.testUsesSavedConfig);
  });

  it('does not expose connection testing or its result in Sleep and dreams', async () => {
    const ui = harness();
    ui.state.connectionTest = { status: 'error', backend: 'ego', error: 'Only shown in collection settings', checkedAt: null, resultCount: null };
    ui.poll();
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-phase')?.textContent).toBe(strings('en').awake));
    expect(ui.root.querySelector('.dream-test,.dream-test-result,.dream-connection-test')).toBeNull();
    expect(ui.root.textContent).not.toContain(ui.state.connectionTest.error);
    expect(ui.root.textContent).not.toContain(strings('en').testUsesSavedConfig);
  });

  it('displays test errors literally', async () => {
    const ui = harness([], undefined, 'settings');
    await vi.waitFor(() => expect(ui.root.querySelector<HTMLButtonElement>('.dream-test')?.disabled).toBe(false));
    ui.failTest('<img> browser start failed');
    ui.root.querySelector<HTMLButtonElement>('.dream-test')!.click();
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-test-result')?.textContent).toContain('<img> browser start failed'));
    expect(ui.root.querySelector('img')).toBeNull();
  });

  it('shows collapsed connection settings without selection or browser-search setup fields', async () => {
    const ui = harness([], undefined, 'settings');
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-ego-state')?.textContent).toBe(strings('en').keyMissing));
    for (const name of ['ego', 'tavily', 'browser']) expect(ui.root.querySelector<HTMLDetailsElement>(`.dream-${name}-details`)!.open).toBe(false);
    expect(ui.root.querySelector('.dream-ego-path')?.closest('details')).toBeNull();
    expect(ui.root.querySelector('input[type=password]')?.closest('details')).toBeNull();
    expect(ui.root.querySelector('.dream-profile')).toBeNull();
    expect(ui.root.querySelector('.dream-config-searchUrlTemplate,.dream-config-allowedDomains,.dream-config-browserExecutableFile,.dream-config-egoEnabled')).toBeNull();
    expect(ui.root.querySelector('.dream-browser-details')?.textContent).toContain(strings('en').browserSearchHint);
    expect(ui.root.querySelector('.dream-browser-details input')).toBeNull();
    expect(ui.root.querySelector('.dream-config-egoRequestTimeoutMs')?.closest('details')).toBe(ui.root.querySelector('.dream-ego-details'));
    expect(ui.root.querySelector('.dream-ego-missing')?.textContent).toContain('Browser path');
  });

  it('connects with an empty PATH command without selecting ego and shows its Space and transport', async () => {
    const ui = harness([], undefined, 'settings');
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-ego-state')?.textContent).toBe(strings('en').keyMissing));
    ui.input('.dream-ego-path', ''); ui.submit('.dream-ego-form');
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-space')?.textContent).toContain('Dream materials'));
    expect(ui.root.querySelector<HTMLDetailsElement>('.dream-ego-details')!.open).toBe(true);
    expect(ui.state.collectorConfig.egoExecutableFile).toBe(''); expect(ui.state.collectorConfig.collectorOrder).toEqual([]);
    expect(ui.root.querySelector('.dream-space')?.textContent).toContain('#17');
    expect(ui.root.querySelector('.dream-transport')?.textContent).toContain(strings('en').egoModeDirect);
    expect(ui.root.querySelector('.dream-backend')?.textContent).toContain(strings('en').noBackend);
  });
  it('keeps general collection controls in Configuration and only saves backend-specific settings', async () => {
    const ui = harness([], undefined, 'settings');
    await vi.waitFor(() => expect(ui.root.querySelector<HTMLInputElement>('[name=egoMaxChars]')?.value).toBe(String(DREAM_DEFAULTS.egoMaxChars)));
    for (const name of ['backend', 'collectorOrder', 'egoEnabled', 'maxSourcesPerDream', 'maxSourcesPerDay', 'timeoutMs', 'maxResults']) expect(ui.root.querySelector(`[name=${name}]`)).toBeNull();
    expect(ui.root.querySelector('.dream-mode,.dream-common-details,.dream-collection-limits')).toBeNull();
    expect(ui.root.querySelector('.dream-general-settings-hint')?.textContent).toBe(strings('en').collectionGeneralSettingsHint);
    ui.input('[name=egoMaxChars]', '12000'); ui.submit('.dream-config-form');
    await vi.waitFor(() => expect(ui.state.collectorConfig.egoMaxChars).toBe(12000));
    expect(ui.savedPatch).toEqual({ egoMaxChars: 12000 });
    expect(ui.state.collectorConfig.maxSourcesPerDream).toBe(DREAM_DEFAULTS.maxSourcesPerDream);
  });
  it('shows quota usage and exhaustion without blocking the settings connection test', async () => {
    const ui = harness([], undefined, 'settings');
    ui.state.quota.dailyUsed = ui.state.quota.dailyLimit;
    ui.state.quota.remaining = 0; ui.poll();
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-quota-status')?.textContent).toBe(strings('en').quotaDailyReached));
    expect(ui.root.querySelector('.dream-collection-usage')?.textContent).toContain(`${ui.state.quota.dailyUsed}/${ui.state.quota.dailyLimit}`);
    expect(ui.root.querySelector<HTMLButtonElement>('.dream-test')!.disabled).toBe(false);
  });

  it('renders independent collection bars and updates their used and remaining proportions', async () => {
    const ui = harness();
    const t = strings('en');
    await vi.waitFor(() => expect(ui.root.querySelectorAll('[role=progressbar]')).toHaveLength(2));
    const cycle = ui.root.querySelector<HTMLElement>('.dream-quota-cycle')!;
    const daily = ui.root.querySelector<HTMLElement>('.dream-quota-daily')!;
    for (const row of [cycle, daily]) {
      expect(row.querySelector<HTMLElement>('.dream-quota-bar .dream-quota-used')!.style.width).toBe('0%');
      expect(row.querySelector<HTMLElement>('.dream-quota-bar .dream-quota-remaining')!.style.width).toBe('100%');
    }
    Object.assign(ui.state.quota, { cycleUsed: 2, cycleLimit: 5, dailyUsed: 6, dailyLimit: 20, remaining: 3 }); ui.poll();
    await vi.waitFor(() => expect(cycle.querySelector('.dream-quota-total')?.textContent).toBe('2/5'));
    expect(cycle.querySelector<HTMLElement>('.dream-quota-bar .dream-quota-used')!.style.width).toBe('40%');
    expect(cycle.querySelector<HTMLElement>('.dream-quota-bar .dream-quota-remaining')!.style.width).toBe('60%');
    expect(cycle.querySelector('.dream-quota-remaining-value')?.textContent).toBe('3');
    expect(daily.querySelector<HTMLElement>('.dream-quota-bar .dream-quota-used')!.style.width).toBe('30%');
    expect(daily.querySelector<HTMLElement>('.dream-quota-bar .dream-quota-remaining')!.style.width).toBe('70%');
    expect(daily.querySelector('.dream-quota-remaining-value')?.textContent).toBe('14');
    const accessible = cycle.querySelector('[role=progressbar]')!;
    expect(accessible.getAttribute('aria-label')).toBe(t.quotaCycle);
    expect(accessible.getAttribute('aria-valuemin')).toBe('0');
    expect(accessible.getAttribute('aria-valuemax')).toBe('5');
    expect(accessible.getAttribute('aria-valuenow')).toBe('2');
    expect(accessible.getAttribute('aria-valuetext')).toBe(`${t.quotaCollected}: 2/5; ${t.quotaRemaining}: 3`);
    Object.assign(ui.state.quota, { cycleUsed: 5, dailyUsed: 20, remaining: 0 }); ui.poll();
    await vi.waitFor(() => expect(cycle.querySelector('.dream-quota-total')?.textContent).toBe('5/5'));
    for (const row of [cycle, daily]) {
      expect(row.querySelector<HTMLElement>('.dream-quota-bar .dream-quota-used')!.style.width).toBe('100%');
      expect(row.querySelector<HTMLElement>('.dream-quota-bar .dream-quota-remaining')!.style.width).toBe('0%');
      expect(row.querySelector('.dream-quota-remaining-value')?.textContent).toBe('0');
    }
  });

  it('keeps actual collection totals when limits are lowered below saved usage', async () => {
    const ui = harness();
    Object.assign(ui.state.quota, { cycleUsed: 4, cycleLimit: 3, dailyUsed: 12, dailyLimit: 10, remaining: 0 }); ui.poll();
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-quota-daily .dream-quota-total')?.textContent).toBe('12/10'));
    for (const [kind, count, limit] of [['cycle', 4, 3], ['daily', 12, 10]] as const) {
      const row = ui.root.querySelector(`.dream-quota-${kind}`)!;
      expect(row.querySelector('.dream-quota-collected-value')?.textContent).toBe(String(count));
      expect(row.querySelector('.dream-quota-remaining-value')?.textContent).toBe('0');
      expect(row.querySelector<HTMLElement>('.dream-quota-bar .dream-quota-used')!.style.width).toBe('100%');
      expect(row.querySelector<HTMLElement>('.dream-quota-bar .dream-quota-remaining')!.style.width).toBe('0%');
      expect(row.querySelector('[role=progressbar]')!.getAttribute('aria-valuenow')).toBe(String(limit));
      expect(row.querySelector('[role=progressbar]')!.getAttribute('aria-valuetext')).toContain(`${count}/${limit}`);
    }
    expect(ui.root.querySelector('.dream-quota-status')?.textContent).toBe(strings('en').quotaDailyReached);
  });

  it('keeps helper setup without exposing manual browser control', async () => {
    const ui = harness([], { keyConfigured: false, egoConfigured: true, activeBackend: 'ego' }, 'settings');
    await vi.waitFor(() => expect(ui.root.querySelector<HTMLButtonElement>('.dream-helper-prepare')!.disabled).toBe(false));
    expect(ui.root.querySelector('.dream-handoff,.dream-resume')).toBeNull();
    ui.root.querySelector<HTMLButtonElement>('.dream-helper-prepare')!.click();
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-helper-launcher')?.textContent).toContain('/fixture/helper/start-helper.sh'));
    expect(ui.state.egoConnection.helperOnline).toBe(false);
    expect(ui.root.textContent).toContain(strings('en').egoHelperInstructions);
    ui.state.egoConnection.helperOnline = true; ui.poll();
    await vi.waitFor(() => expect(ui.root.querySelector<HTMLButtonElement>('.dream-helper-stop')!.disabled).toBe(false));
    ui.root.querySelector<HTMLButtonElement>('.dream-helper-stop')!.click();
    await vi.waitFor(() => expect(ui.state.egoConnection.helperOnline).toBe(false));
  });

  it('shows a failed ego connection distinctly from an unchecked connection and updates after recovery', async () => {
    const ui = harness([], undefined, 'settings');
    const t = strings('en');
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-connection')?.textContent).toContain(t.egoNotConnected));
    ui.state.egoConnection.code = 'EGO_BROWSER_UNAVAILABLE';
    ui.state.egoConnection.reason = egoBrowserErrorText(ui.state.egoConnection.code, 'en');
    ui.poll();
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-connection')?.textContent).toContain(t.connectionError));
    expect(ui.root.querySelector('.dream-connection')?.textContent).not.toContain(t.egoNotConnected);
    expect(ui.root.querySelector('.dream-ego-error')?.textContent).toContain(ui.state.egoConnection.reason);
    ui.state.egoConnection.connected = true;
    ui.state.egoConnection.code = undefined;
    ui.state.egoConnection.reason = null;
    ui.poll();
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-connection')?.textContent).toContain(t.egoAgentReady));
    expect(ui.root.querySelector<HTMLElement>('.dream-ego-error')!.hidden).toBe(true);
  });

  it('shows connection progress and refreshes failed status immediately without changing selected collectors', async () => {
    const ui = harness([], undefined, 'settings');
    const t = strings('en');
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-connection')?.textContent).toContain(t.egoNotConnected));
    ui.pauseConnect();
    const reason = egoBrowserErrorText('EGO_BROWSER_UNAVAILABLE', 'en');
    ui.rejectEgo({ code: 'EGO_BROWSER_UNAVAILABLE', reason, message: 'The connection attempt failed.' });
    ui.submit('.dream-ego-form');
    expect(ui.root.querySelector('.dream-connection')?.textContent).toContain(t.connectionConnecting);
    expect(ui.root.querySelector('.dream-ego-form button')?.textContent).toBe(t.connectionConnecting);
    expect(ui.root.querySelector<HTMLButtonElement>('.dream-ego-form button')!.disabled).toBe(true);
    expect(ui.root.querySelector<HTMLDetailsElement>('.dream-ego-details')!.open).toBe(true);
    ui.finishConnect();
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-connection')?.textContent).toContain(t.connectionError));
    expect(ui.root.querySelector('.dream-ego-error')?.textContent).toContain('EGO_BROWSER_UNAVAILABLE');
    expect(ui.root.querySelector('.dream-ego-error')?.textContent).toContain(reason);
    expect(ui.root.querySelector('.dream-action-error')?.textContent).toBe('The connection attempt failed.');
    expect(ui.root.querySelector<HTMLButtonElement>('.dream-ego-form button')!.disabled).toBe(false);
    expect(ui.state.collectorConfig.collectorOrder).toEqual([]);
  });

  it('does not invent an error code when a failed connection provides none', async () => {
    const ui = harness([], undefined, 'settings');
    const t = strings('en');
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-connection')?.textContent).toContain(t.egoNotConnected));
    ui.rejectEgo({ message: 'The connection request failed.' });
    ui.submit('.dream-ego-form');
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-connection')?.textContent).toContain(t.connectionError));
    expect(ui.root.querySelector('.dream-ego-error')?.textContent).toBe(t.egoUnknownError);
    expect(ui.root.querySelector('.dream-action-error')?.textContent).toBe('The connection request failed.');
  });

  it('distinguishes user control from other pauses and retains an unknown outcome after agent control returns', async () => {
    const ui = harness([], undefined, 'settings');
    const t = strings('en');
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-connection')?.textContent).toContain(t.egoNotConnected));
    Object.assign(ui.state.egoConnection, { halted: true, code: 'EGO_TASK_SPACE_USER_IN_CONTROL' });
    ui.poll();
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-connection')?.textContent).toContain(t.egoUserControl));
    expect(ui.root.querySelector('.dream-ego-error')?.textContent).toContain('EGO_TASK_SPACE_USER_IN_CONTROL');
    Object.assign(ui.state.egoConnection, { code: 'EGO_COMMAND_TIMEOUT', uncertain: true });
    ui.poll();
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-connection')?.textContent).toContain(t.egoControlHalted));
    expect(ui.root.querySelector<HTMLElement>('.dream-ego-uncertain')!.hidden).toBe(false);
    Object.assign(ui.state.egoConnection, { halted: false, connected: true, code: undefined, uncertain: false,
      lastUnknownOutcome: { operation: 'click', code: 'EGO_COMMAND_TIMEOUT' } });
    ui.poll();
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-connection')?.textContent).toContain(t.egoAgentReady));
    expect(ui.root.querySelector<HTMLElement>('.dream-ego-uncertain')!.hidden).toBe(false);
    expect(ui.root.querySelector('.dream-ego-uncertain')?.textContent).toBe(t.egoUncertain);
    expect(ui.root.querySelector('.dream-handoff,.dream-resume')).toBeNull();
  });

  it('disables connection, helper and connection-test actions while the World is stopped', async () => {
    const ui = harness([], undefined, 'settings');
    const t = strings('en');
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-connection')?.textContent).toContain(t.egoNotConnected));
    Object.assign(ui.state.egoConnection, { running: false, halted: true, code: 'EGO_TASK_SPACE_USER_IN_CONTROL', helperOnline: true });
    ui.poll();
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-connection')?.textContent).toContain(t.egoWorldDisabled));
    for (const selector of ['.dream-ego-form button', '.dream-helper-prepare', '.dream-helper-stop', '.dream-test']) {
      expect(ui.root.querySelector<HTMLButtonElement>(selector)!.disabled).toBe(true);
    }
    ui.submit('.dream-ego-form');
    expect(ui.state.egoConnection.connected).toBe(false);
    expect(ui.root.querySelector<HTMLElement>('.dream-action-error')!.hidden).toBe(true);
  });

  it('preserves opened settings and edited values during state polling and saves only edited nonsecret fields', async () => {
    const ui = harness([], undefined, 'settings');
    await vi.waitFor(() => expect(ui.root.querySelector<HTMLInputElement>('.dream-config-egoRequestTimeoutMs')!.value).toBe(String(DREAM_DEFAULTS.egoRequestTimeoutMs)));
    const details = ui.root.querySelector<HTMLDetailsElement>('.dream-ego-details')!; details.open = true;
    const path = ui.input('.dream-ego-path', '/Applications/Edited Browser.app');
    const space = ui.input('.dream-config-egoSpaceName', 'Dream collection');
    const timeout = ui.input('.dream-config-egoRequestTimeoutMs', '60000');
    ui.poll();
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-connection')?.textContent).toContain(strings('en').egoNotConnected));
    expect(details.open).toBe(true); expect(path.value).toBe('/Applications/Edited Browser.app');
    expect(space.value).toBe('Dream collection'); expect(timeout.value).toBe('60000');
    ui.submit('.dream-config-form');
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-notice')?.textContent).toBe(strings('en').configSaved));
    expect(ui.savedPatch).toEqual({ egoExecutableFile: '/Applications/Edited Browser.app', egoSpaceName: 'Dream collection', egoRequestTimeoutMs: 60000 });
    expect(ui.state.collectorConfig.egoRequestTimeoutMs).toBe(60000);
  });

  it('opens the backend configuration containing an invalid value without saving it', async () => {
    const ui = harness([], undefined, 'settings');
    await vi.waitFor(() => expect(ui.root.querySelector<HTMLInputElement>('.dream-config-egoRequestTimeoutMs')!.value).toBe(String(DREAM_DEFAULTS.egoRequestTimeoutMs)));
    ui.input('.dream-config-egoRequestTimeoutMs', '1');
    ui.submit('.dream-config-form');
    expect(ui.savedPatch).toBeUndefined();
    expect(ui.root.querySelector<HTMLDetailsElement>('.dream-ego-details')!.open).toBe(true);
    expect(ui.root.querySelector('.dream-action-error')?.textContent).toBe(strings('en').configInvalid);
  });

  it('clears an unsaved credential and ignores pending settings responses when unmounted', async () => {
    const ui = harness([], undefined, 'settings');
    await vi.waitFor(() => expect(ui.root.querySelector<HTMLInputElement>('.dream-config-egoRequestTimeoutMs')!.value).toBe(String(DREAM_DEFAULTS.egoRequestTimeoutMs)));
    let resolve!: (state: DreamPanelState) => void;
    ui.deferState(new Promise(done => { resolve = done; }));
    ui.poll();
    const input = ui.input('input[type=password]', 'unsaved-test-credential');
    ui.dispose();
    expect(input.value).toBe(''); expect(ui.polling).toBe(false);
    resolve(ui.state); await Promise.resolve();
    expect(ui.root.childElementCount).toBe(0);
  });

  it('updates designated materials through the panel data contract', async () => {
    const ui = harness();
    await vi.waitFor(() => expect(ui.root.textContent).toContain(strings('en').emptyMaterials));
    ui.input('input[type=text]', 'A nearby observatory opens');
    ui.submit('.dream-material-form');
    await vi.waitFor(() => expect(ui.root.querySelectorAll('.dream-material')).toHaveLength(1));
    expect(ui.state.materials[0].topic).toBe('A nearby observatory opens');
    expect(ui.root.textContent).toContain(strings('en').pending);
    ui.root.querySelector<HTMLButtonElement>('.dream-material button')!.click();
    await vi.waitFor(() => expect(ui.root.querySelectorAll('.dream-material')).toHaveLength(0));
    expect(ui.state.materials).toEqual([]);
  });

  it('shows sleep and wake state, with an omitted duration using the configured default', async () => {
    const ui = harness();
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-phase')?.textContent).toBe(strings('en').awake));
    ui.submit('.dream-controls');
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-phase')?.textContent).toBe(strings('en').sleeping));
    expect(Date.parse(ui.state.sleepUntil!) - Date.now()).toBeGreaterThan(ui.configuredSleepMinutes * 60_000 - 1000);
    const wake = [...ui.root.querySelectorAll('button')].find((button) => button.textContent === strings('en').wake)!;
    wake.click();
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-phase')?.textContent).toBe(strings('en').awake));
    expect(wake.disabled).toBe(true);
  });

  it('keeps the dream summary visible and clickable when expanded and collapsed', async () => {
    const record = archiveRecord('one', 'A long dream about an observatory drifting across the sea.', 'An observatory adrift at sea');
    const ui = harness([record]);
    await vi.waitFor(() => expect(ui.root.querySelectorAll('.dream-entry')).toHaveLength(1));
    const item = ui.root.querySelector<HTMLDetailsElement>('.dream-entry')!;
    const title = item.querySelector<HTMLElement>('.dream-entry-title')!;
    expect(title.textContent).toBe(record.title);
    expect(item.querySelector('.dream-text')?.textContent).toBe(record.text);
    expect(item.open).toBe(false);
    title.click();
    expect(item.open).toBe(true);
    expect(ui.root.ownerDocument.defaultView!.getComputedStyle(title).display).not.toBe('none');
    title.click();
    expect(item.open).toBe(false);
    title.click();
    expect(item.open).toBe(true);
  });

  it('keeps deep dream labels beside titles through disclosure, refresh and filtering', async () => {
    const deep = { ...archiveRecord('deep', 'A silver ocean.'), score: DREAM_DEFAULTS.deepDreamThreshold + 1,
      tier: 'deep' as const, promotedAt: '2026-01-03T12:00:00.000Z' };
    const ordinary = archiveRecord('ordinary', 'A quiet forest.');
    const ui = harness([deep, ordinary]);
    const t = strings('en');
    await vi.waitFor(() => expect(ui.root.querySelectorAll('.dream-entry')).toHaveLength(2));
    const item = ui.root.querySelector<HTMLDetailsElement>('.dream-entry')!;
    const badge = item.querySelector<HTMLElement>('.dream-tier')!;
    const title = item.querySelector<HTMLElement>('.dream-entry-title')!;
    expect(badge.textContent).toBe(t.deepDreamLabel);
    expect(title.nextElementSibling).toBe(badge);
    expect(badge.closest('summary')).not.toBeNull();
    expect(ui.root.querySelector('.dream-retention-hint')?.textContent).toBe(t.archiveRetentionHint);
    expect(ui.root.querySelectorAll<HTMLElement>('.dream-tier')[1]!.hidden).toBe(true);
    for (const open of [true, false, true]) {
      title.click(); expect(item.open).toBe(open);
      ui.poll(); await Promise.resolve();
      expect(badge.hidden).toBe(false);
      expect(ui.root.querySelector('.dream-entry')).toBe(item);
      expect(item.querySelector('.dream-score')?.textContent).toBe(`${t.dreamScore} · ${deep.score}`);
    }
    ui.input('input[type=search]', 'forest'); ui.submit('.dream-section-header form');
    await vi.waitFor(() => expect(ui.root.querySelectorAll('.dream-entry')).toHaveLength(1));
    ui.input('input[type=search]', ''); ui.submit('.dream-section-header form');
    await vi.waitFor(() => expect(ui.root.querySelectorAll('.dream-entry')).toHaveLength(2));
    const restored = ui.root.querySelector<HTMLDetailsElement>('.dream-entry')!;
    expect(restored.open).toBe(true);
    expect(restored.querySelector<HTMLElement>('.dream-tier')!.hidden).toBe(false);
  });

  it('updates a promoted dream badge and score without closing the open record', async () => {
    const record = archiveRecord('one', 'An observatory in the clouds.');
    const ui = harness([record]);
    await vi.waitFor(() => expect(ui.root.querySelectorAll('.dream-entry')).toHaveLength(1));
    const item = ui.root.querySelector<HTMLDetailsElement>('.dream-entry')!;
    item.querySelector('summary')!.click();
    expect(item.querySelector<HTMLElement>('.dream-tier')!.hidden).toBe(true);
    Object.assign(ui.state.dreams[0]!, { tier: 'deep', score: DREAM_DEFAULTS.deepDreamThreshold + 1, promotedAt: '2026-01-03T12:00:00.000Z' });
    ui.poll();
    await vi.waitFor(() => expect(item.querySelector<HTMLElement>('.dream-tier')!.hidden).toBe(false));
    expect(item.open).toBe(true);
    expect(item.querySelector('.dream-score')?.textContent).toBe(`${strings('en').dreamScore} · ${ui.state.dreams[0]!.score}`);
  });

  it('preserves the current disclosure state when polling before a queued toggle event', async () => {
    const ui = harness([archiveRecord('one', 'An observatory in the clouds.')]);
    await vi.waitFor(() => expect(ui.root.querySelectorAll('.dream-entry')).toHaveLength(1));
    const item = ui.root.querySelector<HTMLDetailsElement>('.dream-entry')!;
    const row = item.querySelector('summary')!;
    row.click();
    ui.poll();
    await Promise.resolve();
    expect(ui.root.querySelector('.dream-entry')).toBe(item);
    expect(item.open).toBe(true);
    row.click();
    ui.poll();
    await Promise.resolve();
    expect(ui.root.querySelector('.dream-entry')).toBe(item);
    expect(item.open).toBe(false);
  });

  it('remembers the current disclosure state across archive filtering', async () => {
    const ui = harness([archiveRecord('one', 'ocean discovery'), archiveRecord('two', 'forest discovery')]);
    await vi.waitFor(() => expect(ui.root.querySelectorAll('.dream-entry')).toHaveLength(2));
    ui.root.querySelector<HTMLElement>('.dream-entry-title')!.click();
    ui.input('input[type=search]', 'forest'); ui.submit('.dream-section-header form');
    await vi.waitFor(() => expect(ui.root.querySelectorAll('.dream-entry')).toHaveLength(1));
    ui.input('input[type=search]', ''); ui.submit('.dream-section-header form');
    await vi.waitFor(() => expect(ui.root.querySelectorAll('.dream-entry')).toHaveLength(2));
    const item = ui.root.querySelector<HTMLDetailsElement>('.dream-entry')!;
    expect(item.open).toBe(true);
    item.querySelector('summary')!.click();
    ui.input('input[type=search]', 'forest'); ui.submit('.dream-section-header form');
    await vi.waitFor(() => expect(ui.root.querySelectorAll('.dream-entry')).toHaveLength(1));
    ui.input('input[type=search]', ''); ui.submit('.dream-section-header form');
    await vi.waitFor(() => expect(ui.root.querySelectorAll('.dream-entry')).toHaveLength(2));
    expect(ui.root.querySelector<HTMLDetailsElement>('.dream-entry')!.open).toBe(false);
  });

  it('keeps inline deletion confirmation through polling without changing disclosure state', async () => {
    const ui = harness([archiveRecord('one', 'ocean discovery')]);
    await vi.waitFor(() => expect(ui.root.querySelectorAll('.dream-entry')).toHaveLength(1));
    const item = ui.root.querySelector<HTMLDetailsElement>('.dream-entry')!;
    item.querySelector('summary')!.click();
    ui.root.querySelector<HTMLButtonElement>('.dream-record-remove')!.click();
    const confirmation = ui.root.querySelector<HTMLElement>('.dream-record-confirmation')!;
    expect(confirmation.hidden).toBe(false); expect(item.open).toBe(true);
    ui.poll(); await Promise.resolve();
    expect(ui.root.querySelector('.dream-record-confirmation')).toBe(confirmation); expect(confirmation.hidden).toBe(false);
    expect(ui.root.querySelector('.dream-entry')).toBe(item); expect(item.open).toBe(true);
    ui.root.querySelector<HTMLButtonElement>('.dream-record-cancel')!.click();
    expect(confirmation.hidden).toBe(true); expect(ui.state.dreams).toHaveLength(1);
    item.querySelector('summary')!.click(); expect(item.open).toBe(false);
    ui.root.querySelector<HTMLButtonElement>('.dream-record-remove')!.click();
    expect(item.open).toBe(false);
    ui.root.querySelector<HTMLButtonElement>('.dream-record-confirm')!.click();
    await vi.waitFor(() => expect(ui.root.querySelectorAll('.dream-entry')).toHaveLength(0));
    expect(ui.state.dreams).toEqual([]);
  });

  it('deletes only the confirmed filtered dream and preserves daily usage', async () => {
    const ui = harness([archiveRecord('one', 'ocean discovery'), archiveRecord('two', 'forest discovery')]);
    ui.state.quota.dailyUsed = 2;
    await vi.waitFor(() => expect(ui.root.querySelectorAll('.dream-entry')).toHaveLength(2));
    ui.input('input[type=search]', 'forest'); ui.submit('.dream-section-header form');
    await vi.waitFor(() => expect(ui.root.querySelectorAll('.dream-entry')).toHaveLength(1));
    ui.root.querySelector<HTMLButtonElement>('.dream-record-remove')!.click();
    ui.root.querySelector<HTMLButtonElement>('.dream-record-confirm')!.click();
    await vi.waitFor(() => expect(ui.root.querySelectorAll('.dream-entry')).toHaveLength(0));
    expect(ui.state.dreams.map(dream => dream.id)).toEqual(['one']); expect(ui.state.quota.dailyUsed).toBe(2);
    ui.input('input[type=search]', ''); ui.submit('.dream-section-header form');
    await vi.waitFor(() => expect(ui.root.querySelectorAll('.dream-entry')).toHaveLength(1));
    expect(ui.root.querySelector('.dream-text')?.textContent).toBe('ocean discovery');
  });

  it('retains the record and its confirmation when deletion fails', async () => {
    const ui = harness([archiveRecord('one', 'ocean discovery')]);
    await vi.waitFor(() => expect(ui.root.querySelectorAll('.dream-entry')).toHaveLength(1)); ui.rejectDelete();
    ui.root.querySelector<HTMLButtonElement>('.dream-record-remove')!.click();
    ui.root.querySelector<HTMLButtonElement>('.dream-record-confirm')!.click();
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-action-error')?.textContent).toBe('Dream deletion failed.'));
    expect(ui.root.querySelectorAll('.dream-entry')).toHaveLength(1); expect(ui.state.dreams).toHaveLength(1);
    expect(ui.root.querySelector<HTMLElement>('.dream-record-confirmation')!.hidden).toBe(false);
    expect(ui.root.querySelector<HTMLButtonElement>('.dream-record-confirm')!.disabled).toBe(false);
  });

  it('uses a short body excerpt when a legacy record has no summary title', async () => {
    const record = archiveRecord('legacy', `A dream\n\n${'with stars '.repeat(20)}`);
    delete (record as Partial<DreamRecord>).title;
    const ui = harness([record]);
    await vi.waitFor(() => expect(ui.root.querySelectorAll('.dream-entry')).toHaveLength(1));
    const title = ui.root.querySelector('.dream-entry-title')!.textContent!;
    expect(title).toBe(Array.from(record.text.replace(/\s+/gu, ' ').trim()).slice(0, 80).join(''));
    expect(ui.root.querySelector('.dream-text')!.textContent).toBe(record.text);
  });

  it('renders archived text literally and links only http(s) sources without embedded credentials', async () => {
    const record = archiveRecord('one', '<img src=x onerror=alert(1)> ocean discovery');
    record.sources = [
      { title: '<b>source</b>', url: 'https://news.example/story', content: '' },
      { title: 'unsafe scheme', url: 'javascript:alert(1)', content: '' },
      { title: 'embedded credential', url: 'https://operator:secret@news.example/story', content: '' },
    ];
    const ui = harness([record, archiveRecord('two', 'forest discovery')]);
    await vi.waitFor(() => expect(ui.root.querySelectorAll('.dream-entry')).toHaveLength(2));
    expect(ui.root.querySelector('img')).toBeNull();
    expect(ui.root.querySelector('.dream-text')?.textContent).toBe(record.text);
    const links = ui.root.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toBe('<b>source</b>');
    expect(links[0].rel).toContain('noreferrer');
    ui.input('input[type=search]', 'forest');
    ui.submit('.dream-section-header form');
    await vi.waitFor(() => expect(ui.root.querySelectorAll('.dream-entry')).toHaveLength(1));
    expect(ui.root.querySelector('.dream-text')?.textContent).toBe('forest discovery');
  });

  it('clears credentials before saving and never displays server errors containing them', async () => {
    const ui = harness([], undefined, 'settings');
    await vi.waitFor(() => expect(ui.root.textContent).toContain(strings('en').keyMissing));
    const secret = 'test-only-credential';
    const input = ui.input('input[type=password]', secret);
    ui.submit('.dream-key form');
    expect(input.value).toBe('');
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-key-state')?.textContent).toBe(strings('en').keyPresent));
    expect(ui.key).toBe(secret);
    expect(ui.root.outerHTML).not.toContain(secret);
    ui.rejectKey();
    ui.input('input[type=password]', 'second-test-credential');
    ui.submit('.dream-key form');
    expect(input.value).toBe('');
    await vi.waitFor(() => expect(ui.root.querySelector<HTMLElement>('.dream-error')!.hidden).toBe(false));
    expect(ui.root.textContent).not.toContain('second-test-credential');
    expect(ui.root.textContent).not.toContain('Rejected credential');
  });

  it('ends polling and ignores late responses after unmount', async () => {
    const ui = harness();
    await vi.waitFor(() => expect(ui.root.querySelector('.dream-phase')?.textContent).toBe(strings('en').awake));
    let resolve!: (state: DreamPanelState) => void;
    ui.deferState(new Promise((done) => { resolve = done; }));
    ui.poll();
    ui.dispose();
    expect(ui.polling).toBe(false);
    resolve({ ...ui.state, sleeping: true });
    await Promise.resolve();
    expect(ui.root.childElementCount).toBe(0);
  });

  it('provides complete UI and configuration translations in every host language', () => {
    const expectedUi = Object.keys(strings('en')).sort();
    const expectedConfig = Object.keys(configLabels('en')).sort();
    for (const language of DREAM_LANGUAGES) {
      expect(Object.keys(strings(language)).sort()).toEqual(expectedUi);
      expect(Object.values(strings(language)).filter(value => typeof value === 'string').every(value => value.trim().length > 0)).toBe(true);
      expect(Object.keys(configLabels(language)).sort()).toEqual(expectedConfig);
      expect(Object.values(configLabels(language)).every((value) => value.trim().length > 0)).toBe(true);
      for (const code of ['missingPath', 'invalidPath', 'notExecutable', 'unsupportedBrowser', 'startFailed', 'timeout', 'cancelled', 'disconnected', 'userControl', 'nameInUse', 'invalidResponse', 'responseTooLarge', 'commandFailed']) {
        expect(egoErrorText(code, language)).not.toBe(strings(language).connectionError);
        expect(egoErrorText(code, language).trim()).not.toBe('');
      }
      for (const code of ['EGO_HELPER_UNAVAILABLE', 'EGO_HELPER_REQUIRED', 'EGO_HELPER_VERSION', 'EGO_HELPER_SPACE_MISMATCH',
        'EGO_BROWSER_UNAVAILABLE', 'EGO_COMMAND_TIMEOUT', 'EGO_INVALID_RECEIPT', 'EGO_TASK_SPACE_NOT_FOUND', 'EGO_RUNTIME_FAILED']) {
        expect(egoBrowserErrorText(code, language).trim()).not.toBe('');
        expect(egoBrowserErrorText(code, language)).not.toBe(strings(language).error);
      }
      expect(egoBrowserErrorText('EGO_INVALID_ARGUMENTS', language)).toBe(strings(language).configInvalid);
      for (const code of ['unknown', '__proto__', 'constructor', undefined]) expect(egoBrowserErrorText(code, language)).toBe(strings(language).error);
      expect(strings(language)).not.toHaveProperty('chooseProfile');
    }
  });
});

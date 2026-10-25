import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { configLabels, strings } from '../src/strings.ts';
import { mountQQTalk } from './qq-talk.ts';
import './style.css';

type Backend = 'ego' | 'tavily' | 'browser';
export interface DreamRecord {
  id: string; createdAt: string; title: string; text: string; materialIds: string[];
  sources: Array<{ title: string; url: string; content: string; publishedAt?: string }>;
}
export interface CollectorConfig {
  collectorOrder: Backend[] | null;
  egoExecutableFile: string; egoSpaceName: string; egoRequestTimeoutMs: number;
  egoMaxChars: number; egoRestoreMinimized: boolean; egoConnectionMode: 'auto' | 'direct' | 'helper'; egoHelperDir: string;
  timeoutMs: number; maxResults: number; maxSourcesPerDream: number; maxSourcesPerDay: number;
}
export interface DreamPanelState {
  sleeping: boolean; sleepUntil: string | null; dreaming: boolean; cycleId: string | null;
  dreamKind: 'sleep' | 'daydream' | null;
  daydreamEnabled: boolean; daydreamAlarms: Array<{ id: string; time: string; topic: string; createdAt: string }>;
  phase: 'awake' | 'sleeping' | 'waiting' | 'collecting' | 'generating';
  materials: Array<{ id: string; topic: string; tag: '指定素材'; createdAt: string; lastProcessedDate: string | null }>;
  dreams: DreamRecord[];
  quota: { date: string; cycleUsed: number; cycleLimit: number; dailyUsed: number; dailyLimit: number; remaining: number };
  keyConfigured: boolean; egoConfigured: boolean; browserConfigured: boolean;
  activeBackend: Backend | null;
  egoMissing: string[]; tavilyMissing: string[]; browserMissing: string[];
  egoConnection: {
    running: boolean; connected: boolean; connecting: boolean; halted: boolean; reason: string | null; code?: string;
    uncertain: boolean; spaceMissing: boolean; spaceId: number | null; spaceName: string;
    lastUnknownOutcome: { operation: string; code: string } | null;
    connectionMode: 'auto' | 'direct' | 'helper'; transport: 'direct' | 'helper' | null;
    helperOnline: boolean; helperDir: string; launcherFile: string; canPrepareHelper: boolean; lastOperation: string | null;
  };
  collection: { backend: Backend | null; status: 'idle' | 'collecting' | 'ok' | 'error'; error: string | null; lastSuccessAt: string | null; attempts?: Array<{ backend: Backend; reason: string }> };
  connectionTest: { status: 'idle' | 'testing' | 'ok' | 'error'; backend: Backend | null; checkedAt: string | null; error: string | null; resultCount: number | null };
  collectorConfig: CollectorConfig;
  readiness: { ready: boolean; backend: Backend | null; missing: string[] };
  error: string | null;
}

function linkUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function panelUi(ctx: WebUiPanelContext) {
  const t = strings(ctx.language);
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] => {
    const node = ctx.root.ownerDocument.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const panel = element('div', 'dream-panel');
  const notice = element('p', 'dream-notice');
  notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  const failure = element('p', 'dream-error dream-action-error');
  failure.setAttribute('role', 'alert'); failure.hidden = true;
  const buttons: HTMLButtonElement[] = [];
  let disposed = false, busy = false, requestSerial = 0;
  let lastState: DreamPanelState | undefined;
  let render: (state: DreamPanelState) => Promise<void> | void = () => {};
  let updateControls = () => {};
  const active = () => !disposed && !ctx.signal.aborted;
  const button = (text: string, cls = '') => {
    const node = element('button', `dream-button ${cls}`, text);
    node.type = 'button'; buttons.push(node); return node;
  };
  function updateButtons() { for (const node of buttons) node.disabled = busy; updateControls(); }
  function reportError(error: unknown) {
    if (!active()) return;
    failure.textContent = error instanceof Error ? error.message : t.error;
    failure.hidden = false;
  }
  async function reload() {
    const serial = ++requestSerial;
    const state = await ctx.invoke<DreamPanelState>('state');
    if (!active() || serial !== requestSerial) return;
    lastState = state;
    await render(state);
    if (active() && serial === requestSerial) updateButtons();
  }
  async function operate(action: () => Promise<void>) {
    if (busy || !active()) return;
    busy = true; requestSerial++; notice.textContent = ''; failure.hidden = true; updateButtons();
    try { await action(); if (active()) await reload(); }
    catch (error) {
      try { if (active()) await reload(); } catch { /* Preserve the action error when status refresh also fails. */ }
      reportError(error);
    }
    finally { busy = false; if (active()) updateButtons(); }
  }
  function date(value: string) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString(ctx.language === 'zh-Hant' ? 'zh-TW' : ctx.language, { dateStyle: 'medium', timeStyle: 'short' }) : value;
  }
  function missing(node: HTMLElement, values: string[]) {
    node.replaceChildren(); node.hidden = !values.length;
    if (values.length) {
      node.append(element('span', '', t.missingConfiguration));
      const list = element('ul');
      for (const value of values) list.append(element('li', '', value));
      node.append(list);
    }
  }
  function field(label: string, control: HTMLElement) {
    const node = element('label', 'dream-field'); node.append(element('span', '', label), control); return node;
  }
  function input(cls = '', type = 'text') {
    const node = element('input', `dream-input ${cls}`); node.type = type; return node;
  }
  function start(renderer: typeof render, controls?: typeof updateControls, cleanup?: () => void) {
    render = renderer; updateControls = controls ?? (() => {}); ctx.root.append(panel);
    const polling = ctx.interval(() => { if (!busy) void reload().catch(reportError); }, 3000);
    void reload().catch(reportError);
    return { dispose() { disposed = true; requestSerial++; cleanup?.(); polling.dispose(); panel.remove(); } };
  }
  return { t, element, panel, notice, failure, button, date, missing, field, input, operate, start, active,
    get busy() { return busy; }, get state() { return lastState; } };
}

type PanelUi = ReturnType<typeof panelUi>;
function configurationStatus(ui: PanelUi, className: string) {
  const node = ui.element('span', `${className} dream-configuration-status`);
  const dot = ui.element('span', 'dream-status-dot'); dot.setAttribute('aria-hidden', 'true');
  const label = ui.element('span'); node.append(dot, label);
  return { node, render(configured: boolean) {
    node.dataset.configured = String(configured); label.textContent = configured ? ui.t.keyPresent : ui.t.keyMissing;
  } };
}
function quotaBar(ui: PanelUi, label: string, kind: 'cycle' | 'daily') {
  const { element, t } = ui;
  const node = element('div', `dream-quota dream-quota-${kind}`);
  const summary = element('div', 'dream-quota-summary');
  const bar = element('div', 'dream-quota-bar');
  bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-label', label); bar.setAttribute('aria-valuemin', '0');
  const used = element('span', 'dream-quota-used'); const remaining = element('span', 'dream-quota-remaining');
  used.setAttribute('aria-hidden', 'true'); remaining.setAttribute('aria-hidden', 'true'); bar.append(used, remaining);
  const total = element('span', 'dream-quota-total');
  summary.append(element('span', 'dream-quota-label', label), bar, total);
  const legend = element('div', 'dream-quota-legend');
  const collectedValue = element('span', 'dream-quota-collected-value'); const remainingValue = element('span', 'dream-quota-remaining-value');
  for (const [name, value, className] of [[t.quotaCollected, collectedValue, 'dream-quota-used'], [t.quotaRemaining, remainingValue, 'dream-quota-remaining']] as const) {
    const item = element('span', 'dream-quota-legend-item'); const swatch = element('span', `dream-quota-swatch ${className}`);
    swatch.setAttribute('aria-hidden', 'true'); item.append(swatch, element('span', '', name), value); legend.append(item);
  }
  node.append(summary, legend);
  return { node, render(count: number, limit: number) {
    const available = Math.max(0, limit - count), percent = Math.min(100, count / limit * 100);
    used.style.width = `${percent}%`; remaining.style.width = `${100 - percent}%`;
    total.textContent = `${count}/${limit}`;
    collectedValue.textContent = String(count); remainingValue.textContent = String(available);
    bar.setAttribute('aria-valuemax', String(limit)); bar.setAttribute('aria-valuenow', String(Math.min(count, limit)));
    bar.setAttribute('aria-valuetext', `${t.quotaCollected}: ${count}/${limit}; ${t.quotaRemaining}: ${available}`);
  } };
}

function connectionTest(ctx: WebUiPanelContext, ui: PanelUi) {
  const { t, element } = ui;
  const node = element('div', 'dream-connection-test');
  const test = ui.button(t.testConnection, 'dream-test');
  const result = element('p', 'dream-test-result dream-secondary');
  result.setAttribute('role', 'status'); result.setAttribute('aria-live', 'polite');
  node.append(test, result, element('p', 'dream-secondary', t.testUsesSavedConfig));
  let testing = false;
  const name = (value: Backend | null) => value === 'ego' ? t.egoTitle : value === 'tavily' ? 'Tavily' : value === 'browser' ? t.browserTitle : t.noBackend;
  function update() {
    const state = ui.state;
    test.disabled = ui.busy || !state?.egoConnection.running || state?.connectionTest.status === 'testing' || state?.collection.status === 'collecting';
    test.textContent = testing || state?.connectionTest.status === 'testing' ? t.testRunning : t.testConnection;
  }
  test.addEventListener('click', () => void ui.operate(async () => {
    testing = true; update();
    try { await ctx.invoke('testConnection'); }
    finally { testing = false; }
  }), { signal: ctx.signal });
  return { node, update, render(value: DreamPanelState['connectionTest']) {
    result.classList.toggle('dream-error', value.status === 'error');
    result.textContent = value.status === 'testing' ? t.testRunning : value.status === 'ok'
      ? `${t.testSuccess} · ${name(value.backend)}${value.resultCount === null ? '' : ` · ${t.testResultCount}: ${value.resultCount}`}${value.checkedAt ? ` · ${ui.date(value.checkedAt)}` : ''}`
      : value.status === 'error' ? `${t.testFailure} · ${name(value.backend)}${value.error ? ` · ${value.error}` : ''}` : '';
    result.hidden = !result.textContent; update();
  } };
}

function collectionSummary(ctx: WebUiPanelContext, ui: PanelUi, showConnectionTest = false) {
  const { t, element } = ui;
  const card = element('section', 'dream-card dream-collection');
  card.append(element('h3', '', t.groupCollectionTitle));
  const backend = element('p', 'dream-backend dream-secondary', t.loading);
  const result = element('p', 'dream-collection-result dream-secondary');
  const usage = element('div', 'dream-collection-usage dream-secondary');
  const cycleUsage = quotaBar(ui, t.quotaCycle, 'cycle'); const dailyUsage = quotaBar(ui, t.quotaToday, 'daily');
  usage.append(cycleUsage.node, dailyUsage.node);
  const quotaStatus = element('p', 'dream-quota-status dream-secondary');
  const resultError = element('p', 'dream-error dream-collection-error');
  resultError.setAttribute('role', 'alert'); resultError.hidden = true;
  const attempts = element('p', 'dream-collection-attempts dream-secondary'); attempts.hidden = true;
  card.append(backend, result, usage, quotaStatus, resultError, attempts);
  const test = showConnectionTest ? connectionTest(ctx, ui) : undefined;
  if (test) card.append(test.node);
  const name = (value: Backend | null) => value === 'ego' ? t.egoTitle : value === 'tavily' ? 'Tavily' : value === 'browser' ? t.browserTitle : t.noBackend;
  function update() {
    test?.update();
  }
  return { card, update, render(state: DreamPanelState) {
    backend.textContent = `${t.backendActive} · ${name(state.activeBackend)}`;
    result.textContent = `${t.collectionResult} · ${state.collection.lastSuccessAt ? `${t.lastSuccess} ${ui.date(state.collection.lastSuccessAt)}` : t.neverCollected}`;
    const quota = state.quota;
    cycleUsage.render(quota.cycleUsed, quota.cycleLimit); dailyUsage.render(quota.dailyUsed, quota.dailyLimit);
    quotaStatus.textContent = quota.dailyUsed >= quota.dailyLimit ? t.quotaDailyReached : quota.cycleUsed >= quota.cycleLimit ? t.quotaCycleReached : '';
    quotaStatus.hidden = !quotaStatus.textContent;
    resultError.textContent = state.collection.error || ''; resultError.hidden = !state.collection.error;
    attempts.textContent = state.collection.attempts?.length ? `${t.collectionAttempts} · ${state.collection.attempts.map(attempt => `${name(attempt.backend)}: ${attempt.reason}`).join(' → ')}` : '';
    attempts.hidden = !attempts.textContent;
    test?.render(state.connectionTest);
  } };
}

function collectionSelection(ctx: WebUiPanelContext, ui: PanelUi) {
  const { t, element } = ui;
  const form = element('form', 'dream-collector-order-form');
  const list = element('ul', 'dream-collector-order');
  const empty = element('p', 'dream-secondary dream-collector-empty', t.collectionNoneSelected);
  const save = ui.button(t.collectorOrderSave, 'dream-primary dream-collector-order-save'); save.type = 'submit';
  const methods = ['ego', 'tavily', 'browser'] as const;
  let order: Backend[] = [], dirty = false, loaded = false;
  const rows = methods.map(backend => {
    const row = element('li', 'dream-collector-choice'); row.dataset.backend = backend;
    const name = backend === 'ego' ? t.egoTitle : backend === 'tavily' ? 'Tavily' : t.browserTitle;
    const position = element('span', 'dream-collector-position dream-secondary'); position.setAttribute('aria-hidden', 'true');
    const checkbox = ui.input('dream-collector-selected', 'checkbox'); checkbox.name = backend;
    const label = element('label', 'dream-collector-label'); label.append(checkbox, element('span', '', name));
    const status = configurationStatus(ui, `dream-${backend === 'tavily' ? 'key' : backend}-state dream-secondary`);
    const actions = element('div', 'dream-collector-actions');
    const up = ui.button(t.collectorMoveUp, 'dream-collector-up'); up.setAttribute('aria-label', `${name} · ${t.collectorMoveUp}`);
    const down = ui.button(t.collectorMoveDown, 'dream-collector-down'); down.setAttribute('aria-label', `${name} · ${t.collectorMoveDown}`);
    actions.append(up, down); row.append(position, label, status.node, actions);
    function change(next: Backend[]) { order = next; dirty = true; ui.notice.textContent = ''; update(); }
    checkbox.addEventListener('change', () => change(checkbox.checked ? [...order, backend] : order.filter(value => value !== backend)), { signal: ctx.signal });
    for (const [control, delta] of [[up, -1], [down, 1]] as const) control.addEventListener('click', () => {
      const index = order.indexOf(backend), target = index + delta;
      if (index < 0 || target < 0 || target >= order.length) return;
      const next = [...order]; [next[index], next[target]] = [next[target]!, next[index]!]; change(next);
    }, { signal: ctx.signal });
    return { backend, row, position, checkbox, status, up, down, actions };
  });
  function update() {
    const display = [...order, ...methods.filter(backend => !order.includes(backend))];
    for (const [position, backend] of display.entries()) {
      const item = rows.find(row => row.backend === backend)!;
      const index = order.indexOf(backend);
      if (list.children[position] !== item.row) list.insertBefore(item.row, list.children[position] ?? null);
      item.checkbox.checked = index >= 0;
      item.checkbox.disabled = ui.busy || !loaded;
      item.position.textContent = index >= 0 ? String(index + 1) : '';
      item.actions.hidden = index < 0;
      item.up.disabled = ui.busy || index <= 0;
      item.down.disabled = ui.busy || index < 0 || index === order.length - 1;
    }
    empty.hidden = order.length > 0; save.disabled = ui.busy || !loaded || !dirty;
  }
  form.append(list, empty, element('p', 'dream-secondary', t.collectorOrderHint), save);
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!loaded || !dirty) return;
    const value = [...order];
    void ui.operate(async () => {
      await ctx.invoke('saveCollectorConfig', [{ collectorOrder: value }]);
      dirty = false;
      if (ui.active()) ui.notice.textContent = t.configSaved;
    });
  }, { signal: ctx.signal });
  update();
  return { form, update, render(state: DreamPanelState) {
    if (!dirty) order = [...(state.collectorConfig.collectorOrder ?? [])];
    loaded = true;
    for (const item of rows) {
      const ready = item.backend === 'ego' ? state.egoConfigured : item.backend === 'tavily' ? state.tavilyMissing.length === 0 : state.browserConfigured;
      const missing = item.backend === 'ego' ? state.egoMissing : item.backend === 'tavily' ? state.tavilyMissing : state.browserMissing;
      item.status.render(ready); item.status.node.title = missing.join(' · ');
    }
    update();
  } };
}

export function mountDreamPanel(ctx: WebUiPanelContext): { dispose(): void } {
  const ui = panelUi(ctx);
  const { t, element, button, panel } = ui;
  const header = element('div', 'dream-header');
  const phase = element('span', 'dream-phase', t.loading); phase.setAttribute('role', 'status');
  phase.setAttribute('aria-label', t.currentPhase);
  header.append(element('h2', 'dream-title', t.panelTitle), phase);
  const phaseHint = element('p', 'dream-secondary dream-phase-hint'); phaseHint.hidden = true;
  const wakeAt = element('p', 'dream-secondary');
  const serverError = element('p', 'dream-error dream-state-error'); serverError.setAttribute('role', 'alert'); serverError.hidden = true;
  const controls = element('form', 'dream-controls');
  const duration = ui.input('dream-duration', 'number');
  duration.min = '1'; duration.max = '1440'; duration.step = '1'; duration.placeholder = t.configuredDuration;
  const sleep = button(t.sleep, 'dream-primary'); sleep.type = 'submit';
  const wake = button(t.wake);
  const refresh = button(t.refresh, 'dream-subtle');
  controls.append(ui.field(`${t.sleepDuration} · ${t.minutes}`, duration), sleep, wake, refresh);
  const summary = collectionSummary(ctx, ui);
  const selection = collectionSelection(ctx, ui);
  summary.card.insertBefore(selection.form, summary.card.children[1]!);

  const materialsCard = element('section', 'dream-card');
  const materialForm = element('form', 'dream-input-row dream-material-form');
  const topic = ui.input('dream-topic-input'); topic.required = true; topic.maxLength = 500;
  topic.placeholder = t.materialPlaceholder; topic.setAttribute('aria-label', t.materialPlaceholder);
  const add = button(t.addMaterial, 'dream-primary'); add.type = 'submit'; materialForm.append(topic, add);
  const materialList = element('ul', 'dream-materials');
  materialsCard.append(element('h3', '', t.materials), materialForm, materialList);
  const alarmsCard = element('section', 'dream-card dream-daydream-alarms');
  const alarmsDisabled = element('p', 'dream-secondary', t.daydreamAlarmDisabled);
  const alarmForm = element('form', 'dream-alarm-form');
  const alarmTime = ui.input('dream-alarm-time', 'time'); alarmTime.required = true; alarmTime.step = '60';
  const alarmTopic = ui.input('dream-alarm-topic'); alarmTopic.required = true; alarmTopic.maxLength = 500;
  const alarmTopicField = ui.field(t.daydreamAlarmTopic, alarmTopic); alarmTopicField.classList.add('dream-alarm-topic-field');
  const alarmSave = button(t.daydreamAlarmAdd, 'dream-primary dream-alarm-save'); alarmSave.type = 'submit';
  const alarmCancel = button(t.cancelAction, 'dream-alarm-cancel'); alarmCancel.hidden = true;
  const alarmsList = element('ul', 'dream-alarm-list');
  let editingAlarm: string | undefined;
  function clearAlarmEditor() {
    editingAlarm = undefined; alarmTime.value = ''; alarmTopic.value = '';
    alarmSave.textContent = t.daydreamAlarmAdd; alarmCancel.hidden = true;
  }
  alarmCancel.addEventListener('click', clearAlarmEditor, { signal: ctx.signal });
  alarmForm.addEventListener('submit', event => {
    event.preventDefault(); const value = alarmTopic.value.trim();
    if (!value || !alarmForm.reportValidity()) return;
    const alarm = { ...(editingAlarm ? { id: editingAlarm } : {}), time: alarmTime.value, topic: value };
    void ui.operate(async () => { await ctx.invoke('saveDaydreamAlarm', [alarm]); clearAlarmEditor(); });
  }, { signal: ctx.signal });
  alarmForm.append(ui.field(t.daydreamAlarmTime, alarmTime), alarmTopicField, alarmSave, alarmCancel);
  alarmsCard.append(element('h3', '', t.daydreamAlarms), alarmsDisabled, element('p', 'dream-secondary', t.daydreamAlarmHint), alarmForm, alarmsList);
  const archiveCard = element('section', 'dream-card');
  const archiveHeader = element('div', 'dream-section-header');
  const queryForm = element('form', 'dream-input-row');
  const query = ui.input('', 'search'); query.maxLength = 500; query.placeholder = t.queryPlaceholder; query.setAttribute('aria-label', t.queryPlaceholder);
  const search = button(t.query); search.type = 'submit'; queryForm.append(query, search);
  archiveHeader.append(element('h3', '', t.archive), queryForm);
  const archive = element('div', 'dream-archive'); archiveCard.append(archiveHeader, archive);
  panel.append(header, phaseHint, wakeAt, controls, ui.notice, ui.failure, serverError, summary.card, materialsCard, alarmsCard, archiveCard);
  let currentQuery = '', archiveSerial = 0;
  const openDreams = new Set<string>();
  const entries = new Map<string, {
    container: HTMLElement;
    item: HTMLDetailsElement; time: HTMLTimeElement; title: HTMLSpanElement; text: HTMLParagraphElement;
    heading: HTMLHeadingElement; sources: HTMLUListElement; sourceKey: string;
  }>();
  const emptyArchive = element('p', 'dream-empty', t.emptyDreams);
  function renderDreams(records: DreamRecord[]) {
    const visible = new Set(records.map(record => record.id));
    for (const [id, entry] of entries) {
      if (visible.has(id)) continue;
      if (entry.item.open) openDreams.add(id); else openDreams.delete(id);
      entry.container.remove(); entries.delete(id);
    }
    if (!records.length) { archive.append(emptyArchive); return; }
    emptyArchive.remove();
    let index = 0;
    for (const record of records) {
      let entry = entries.get(record.id);
      if (!entry) {
        const container = element('article', 'dream-archive-item');
        const item = element('details', 'dream-entry'); item.open = openDreams.has(record.id);
        const row = element('summary', 'dream-entry-summary');
        const time = element('time', 'dream-secondary');
        const title = element('span', 'dream-entry-title');
        const text = element('p', 'dream-text');
        const heading = element('h4', 'dream-source-heading', t.sources);
        const sources = element('ul', 'dream-sources');
        row.append(time, title); item.append(row, text, heading, sources);
        const remove = element('button', 'dream-button dream-subtle dream-record-remove', t.removeDream); remove.type = 'button';
        const confirmation = element('div', 'dream-record-confirmation'); confirmation.hidden = true;
        const confirm = element('button', 'dream-button dream-record-confirm', t.confirmDelete); confirm.type = 'button';
        const cancel = element('button', 'dream-button dream-record-cancel', t.cancelAction); cancel.type = 'button';
        confirmation.append(element('p', 'dream-secondary', t.removeDreamConfirm), confirm, cancel);
        remove.addEventListener('click', () => { confirmation.hidden = false; remove.hidden = true; }, { signal: ctx.signal });
        cancel.addEventListener('click', () => { confirmation.hidden = true; remove.hidden = false; }, { signal: ctx.signal });
        confirm.addEventListener('click', () => void ui.operate(async () => {
          await ctx.invoke('removeDream', [record.id]); openDreams.delete(record.id);
        }), { signal: ctx.signal });
        container.append(item, remove, confirmation);
        entry = { container, item, time, title, text, heading, sources, sourceKey: '' }; entries.set(record.id, entry);
      }
      const title = record.title?.trim() || Array.from(record.text.replace(/\s+/gu, ' ').trim()).slice(0, 80).join('');
      if (entry.title.textContent !== title) entry.title.textContent = title;
      if (entry.text.textContent !== record.text) entry.text.textContent = record.text;
      if (entry.time.dateTime !== record.createdAt) { entry.time.dateTime = record.createdAt; entry.time.textContent = ui.date(record.createdAt); }
      entry.heading.hidden = entry.sources.hidden = !record.sources.length;
      const sourceKey = JSON.stringify(record.sources.map(({ title, url }) => [title, url]));
      if (entry.sourceKey !== sourceKey) {
        entry.sourceKey = sourceKey; entry.sources.replaceChildren();
        for (const source of record.sources) {
          const line = element('li'); const href = linkUrl(source.url);
          if (href) { const link = element('a', '', source.title || source.url); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; line.append(link); }
          else line.append(element('span', '', source.title));
          entry.sources.append(line);
        }
      }
      if (archive.children[index] !== entry.container) archive.insertBefore(entry.container, archive.children[index] ?? null);
      index++;
    }
  }
  controls.addEventListener('submit', event => {
    event.preventDefault(); if (!controls.reportValidity()) return;
    void ui.operate(async () => { await ctx.invoke('sleep', duration.value === '' ? [] : [Number(duration.value)]); });
  }, { signal: ctx.signal });
  wake.addEventListener('click', () => void ui.operate(async () => { await ctx.invoke('wake'); }), { signal: ctx.signal });
  refresh.addEventListener('click', () => void ui.operate(async () => {}), { signal: ctx.signal });
  materialForm.addEventListener('submit', event => {
    event.preventDefault(); const value = topic.value.trim(); if (!value || !materialForm.reportValidity()) return;
    void ui.operate(async () => { await ctx.invoke('addMaterial', [value]); if (topic.value.trim() === value) topic.value = ''; });
  }, { signal: ctx.signal });
  queryForm.addEventListener('submit', event => { event.preventDefault(); currentQuery = query.value.trim(); void ui.operate(async () => {}); }, { signal: ctx.signal });
  return ui.start(async state => {
    const phases = { awake: t.awake, sleeping: t.sleeping, waiting: t.phaseWaiting, collecting: t.phaseCollecting, generating: t.phaseGenerating };
    phase.textContent = `${state.dreamKind === 'daydream' ? `${t.daydreamLabel} · ` : ''}${phases[state.phase]}`;
    phase.dataset.phase = state.phase; phase.dataset.kind = state.dreamKind ?? '';
    phaseHint.textContent = t.phaseGeneratingHint; phaseHint.hidden = state.phase !== 'generating';
    wakeAt.textContent = state.sleeping && state.sleepUntil ? `${t.until} · ${ui.date(state.sleepUntil)}` : ''; wakeAt.hidden = !wakeAt.textContent;
    selection.render(state);
    summary.render(state);
    serverError.textContent = state.error ? `${t.error}: ${state.error}` : ''; serverError.hidden = !state.error || Boolean(state.collection.error);
    materialList.replaceChildren();
    if (!state.materials.length) materialList.append(element('li', 'dream-empty', t.emptyMaterials));
    for (const material of state.materials) {
      const row = element('li', 'dream-material');
      const copy = element('div', 'dream-material-copy'); const tags = element('div', 'dream-tags');
      tags.append(element('span', 'dream-tag', t.designated), element('span', 'dream-secondary', material.lastProcessedDate ? `${t.processed} · ${material.lastProcessedDate}` : t.pending));
      copy.append(element('p', 'dream-topic', material.topic), tags);
      const remove = element('button', 'dream-button dream-subtle', t.removeMaterial); remove.type = 'button'; remove.disabled = ui.busy;
      remove.addEventListener('click', () => void ui.operate(async () => { await ctx.invoke('removeMaterial', [material.id]); }), { signal: ctx.signal });
      row.append(copy, remove); materialList.append(row);
    }
    alarmsDisabled.hidden = state.daydreamEnabled;
    alarmsList.replaceChildren();
    if (!state.daydreamAlarms.length) alarmsList.append(element('li', 'dream-empty', t.daydreamAlarmEmpty));
    for (const alarm of state.daydreamAlarms) {
      const row = element('li', 'dream-alarm');
      const copy = element('div', 'dream-material-copy');
      copy.append(element('span', 'dream-alarm-scheduled-time', alarm.time), element('p', alarm.topic ? 'dream-topic' : 'dream-secondary dream-alarm-topic-missing', alarm.topic || t.daydreamAlarmTopicMissing));
      const edit = element('button', 'dream-button dream-subtle dream-alarm-edit', t.daydreamAlarmEdit); edit.type = 'button';
      edit.addEventListener('click', () => {
        editingAlarm = alarm.id; alarmTime.value = alarm.time; alarmTopic.value = alarm.topic;
        alarmSave.textContent = t.daydreamAlarmSave; alarmCancel.hidden = false; alarmTopic.focus();
      }, { signal: ctx.signal });
      const remove = element('button', 'dream-button dream-subtle dream-alarm-remove', t.daydreamAlarmRemove); remove.type = 'button';
      remove.addEventListener('click', () => void ui.operate(async () => {
        await ctx.invoke('removeDaydreamAlarm', [alarm.id]); if (editingAlarm === alarm.id) clearAlarmEditor();
      }), { signal: ctx.signal });
      row.append(copy, edit, remove); alarmsList.append(row);
    }
    const serial = ++archiveSerial;
    const records = currentQuery ? await ctx.invoke<DreamRecord[]>('query', [currentQuery]) : state.dreams;
    if (ui.active() && serial === archiveSerial) renderDreams(records);
  }, () => {
    wake.disabled = ui.busy || (!ui.state?.sleeping && !ui.state?.dreaming);
    for (const node of materialList.querySelectorAll('button')) node.disabled = ui.busy;
    for (const node of [...alarmsList.querySelectorAll('button'), ...archive.querySelectorAll('button'), alarmTime, alarmTopic]) node.disabled = ui.busy;
    summary.update(); selection.update();
  });
}

export function mountCollectionSettings(ctx: WebUiPanelContext): { dispose(): void } {
  const ui = panelUi(ctx);
  const { t, element, button, panel } = ui;
  const labels = configLabels(ctx.language);
  panel.classList.add('dream-settings');
  panel.append(element('h2', 'dream-title', t.collectionConfigTitle), ui.notice, ui.failure);
  const group = element('section', 'dream-card dream-collector-settings');
  group.append(element('h3', '', t.groupCollectionTitle), element('p', 'dream-secondary dream-general-settings-hint', t.collectionGeneralSettingsHint));
  function fold(name: string, cls: string) {
    const node = element('details', `dream-settings-fold ${cls}`);
    node.append(element('summary', '', name)); const body = element('div', 'dream-fold-body'); node.append(body); return { node, body };
  }
  function provider(name: string, cls: string) {
    const card = element('section', `dream-provider dream-${cls}`);
    const header = element('div', 'dream-section-header'); const status = configurationStatus(ui, `dream-${cls}-state dream-secondary`);
    header.append(element('h4', '', name), status.node);
    const missing = element('div', `dream-missing dream-${cls === 'key' ? 'tavily' : cls}-missing dream-secondary`);
    card.append(header, missing); return { card, status, missing };
  }
  const ego = provider(t.egoTitle, 'ego');
  const egoForm = element('form', 'dream-input-row dream-ego-form');
  const egoPath = ui.input('dream-ego-path'); egoPath.maxLength = 4096; egoPath.autocomplete = 'off'; egoPath.spellcheck = false; egoPath.placeholder = 'ego-browser';
  const pathField = ui.field(labels.egoExecutableFile, egoPath); pathField.classList.add('dream-path-field');
  const connect = button(t.connectEgo); connect.type = 'submit'; egoForm.append(pathField, connect);
  const egoDetails = fold(t.egoTitle, 'dream-ego-details');
  ego.card.append(egoForm, element('p', 'dream-secondary', t.egoPathHint), egoDetails.node);

  const tavily = provider('Tavily', 'key');
  const keyForm = element('form', 'dream-input-row dream-key-form');
  const key = ui.input('dream-api-key', 'password'); key.required = true; key.autocomplete = 'new-password'; key.maxLength = 512; key.placeholder = t.keyPlaceholder;
  const keyField = ui.field(t.keyTitle, key); keyField.classList.add('dream-path-field');
  const saveKey = button(t.saveKey); saveKey.type = 'submit'; keyForm.append(keyField, saveKey);
  const tavilyDetails = fold('Tavily', 'dream-tavily-details');
  tavilyDetails.body.append(element('p', 'dream-secondary', 'API · https://api.tavily.com/search'));
  tavily.card.append(keyForm, tavilyDetails.node);
  const browser = provider(t.browserTitle, 'browser');
  const browserDetails = fold(t.browserTitle, 'dream-browser-details');
  browserDetails.body.append(element('p', 'dream-secondary', t.browserSearchHint)); browser.card.append(browserDetails.node);
  const configForm = element('form', 'dream-config-form');
  type Field = Exclude<keyof CollectorConfig, 'collectorOrder' | 'timeoutMs' | 'maxResults' | 'maxSourcesPerDream' | 'maxSourcesPerDay'>;
  const inputs = { egoExecutableFile: egoPath } as Record<Field, HTMLInputElement | HTMLSelectElement>;
  const numeric: Partial<Record<Field, [number, number]>> = {
    egoRequestTimeoutMs: [5000, 120000], egoMaxChars: [1000, 60000],
  };
  const hints: Partial<Record<Field, string>> = { egoSpaceName: t.egoSpaceHint, egoRestoreMinimized: t.egoRestoreHint };
  for (const field of ['egoSpaceName', 'egoRequestTimeoutMs', 'egoMaxChars', 'egoRestoreMinimized', 'egoConnectionMode', 'egoHelperDir'] as const) {
    const bool = field === 'egoRestoreMinimized';
    let control: HTMLInputElement | HTMLSelectElement;
    if (field === 'egoConnectionMode') {
      control = element('select', `dream-input dream-config-${field}`);
      for (const [value, label] of [['auto', t.egoModeAuto], ['direct', t.egoModeDirect], ['helper', t.egoModeHelper]]) {
        const option = element('option', '', label); option.value = value!; control.append(option);
      }
    } else {
      const input = ui.input(`dream-config-${field}`, bool ? 'checkbox' : numeric[field] ? 'number' : 'text');
      if (numeric[field]) { input.min = String(numeric[field]![0]); input.max = String(numeric[field]![1]); input.step = '1'; input.required = true; }
      else if (!bool) { input.maxLength = field === 'egoSpaceName' ? 256 : 4096; input.autocomplete = 'off'; input.spellcheck = false; }
      control = input;
    }
    control.name = field; inputs[field] = control;
    const parent = egoDetails.body;
    parent.append(ui.field(labels[field], control));
    if (hints[field]) parent.append(element('p', 'dream-secondary', hints[field]));
  }
  const connection = element('p', 'dream-connection dream-secondary'); const space = element('p', 'dream-space dream-secondary');
  const transport = element('p', 'dream-transport dream-secondary');
  const egoError = element('p', 'dream-error dream-ego-error'); egoError.setAttribute('role', 'alert'); egoError.hidden = true;
  const uncertain = element('p', 'dream-error dream-ego-uncertain'); uncertain.hidden = true; uncertain.textContent = t.egoUncertain;
  const helperStatus = element('p', 'dream-helper-status dream-secondary');
  const helperPath = element('p', 'dream-helper-directory dream-secondary');
  const launcher = element('p', 'dream-helper-launcher dream-secondary');
  const helperActions = element('div', 'dream-controls');
  const prepare = button(t.prepareEgoHelper, 'dream-helper-prepare'); const stop = button(t.stopEgoHelper, 'dream-helper-stop');
  helperActions.append(prepare, stop);
  ego.card.insertBefore(connection, egoDetails.node); ego.card.insertBefore(egoError, egoDetails.node);
  ego.card.insertBefore(uncertain, egoDetails.node);
  egoDetails.body.append(space, transport, helperStatus, helperPath, launcher, helperActions, element('p', 'dream-secondary', t.egoHelperInstructions));
  const save = button(t.saveConfig, 'dream-primary'); save.type = 'submit'; configForm.append(save);
  group.append(ego.card, tavily.card, browser.card, configForm);
  const summary = collectionSummary(ctx, ui, true); panel.append(group, summary.card);
  let connecting = false, connectionFailed = false;
  function renderConnection(value: DreamPanelState['egoConnection']) {
    const status = !value.running ? t.egoWorldDisabled : connecting || value.connecting ? t.connectionConnecting
      : value.halted && value.code === 'EGO_TASK_SPACE_USER_IN_CONTROL' ? t.egoUserControl
      : value.halted ? t.egoControlHalted : value.connected ? t.egoAgentReady
      : value.code || value.reason || connectionFailed ? t.connectionError : t.egoNotConnected;
    connection.textContent = `${t.connectionStatus} · ${status}`;
  }
  const dirty = new Set<Field>();
  for (const [field, control] of Object.entries(inputs)) control.addEventListener(control.tagName === 'SELECT' || control.type === 'checkbox' ? 'change' : 'input', () => { dirty.add(field as Field); }, { signal: ctx.signal });
  function configValues(): Pick<CollectorConfig, Field> {
    const values: Record<string, string | number | boolean> = {};
    for (const [field, control] of Object.entries(inputs)) values[field] = control.type === 'checkbox' ? (control as HTMLInputElement).checked
      : numeric[field as Field] ? Number(control.value) : control.value.trim();
    return values as unknown as Pick<CollectorConfig, Field>;
  }
  configForm.addEventListener('submit', event => {
    event.preventDefault();
    const invalid = Object.values(inputs).find(input => !input.checkValidity());
    if (invalid) { const details = invalid.closest('details'); if (details) details.open = true; ui.failure.textContent = t.configInvalid; ui.failure.hidden = false; invalid.reportValidity(); return; }
    const values = configValues(); const patch = Object.fromEntries([...dirty].map(field => [field, values[field]]));
    void ui.operate(async () => {
      if (Object.keys(patch).length) await ctx.invoke('saveCollectorConfig', [patch]);
      const current = configValues(); for (const field of dirty) if (current[field] === values[field]) dirty.delete(field);
      if (ui.active()) ui.notice.textContent = t.configSaved;
    });
  }, { signal: ctx.signal });
  egoForm.addEventListener('submit', event => {
    event.preventDefault(); const path = egoPath.value.trim();
    if (ui.busy || !ui.state?.egoConnection.running) return;
    void ui.operate(async () => {
      connecting = true; connectionFailed = false; connect.textContent = t.connectionConnecting;
      renderConnection(ui.state!.egoConnection); egoDetails.node.open = true;
      try { await ctx.invoke('connectEgo', [path]); if (ui.active() && egoPath.value.trim() === path) dirty.delete('egoExecutableFile'); }
      catch (error) { connectionFailed = true; throw error; }
      finally { connecting = false; }
    });
  }, { signal: ctx.signal });
  for (const [control, method] of [[prepare, 'prepareEgoHelper'], [stop, 'stopEgoHelper']] as const) {
    control.addEventListener('click', () => void ui.operate(async () => { await ctx.invoke(method); }), { signal: ctx.signal });
  }
  keyForm.addEventListener('submit', event => {
    event.preventDefault(); const value = key.value.trim(); if (!value || ui.busy || !keyForm.reportValidity()) return;
    key.value = '';
    void ui.operate(async () => { try { await ctx.invoke('saveKey', [value]); } catch { throw new Error(t.error); } if (ui.active()) ui.notice.textContent = t.keySaved; });
  }, { signal: ctx.signal });
  return ui.start(state => {
    const value = state.egoConnection;
    if (value.connected) connectionFailed = false;
    ego.status.render(state.egoConfigured);
    tavily.status.render(state.tavilyMissing.length === 0);
    browser.status.render(state.browserConfigured);
    ui.missing(ego.missing, state.egoMissing); ui.missing(tavily.missing, state.tavilyMissing); ui.missing(browser.missing, state.browserMissing);
    renderConnection(value);
    space.textContent = value.spaceName ? `${t.egoSpace} · ${value.spaceName}${value.spaceId === null ? '' : ` (#${value.spaceId})`}` : ''; space.hidden = !space.textContent;
    transport.textContent = `${t.egoTransport} · ${value.transport === 'helper' ? t.egoModeHelper : value.transport === 'direct' ? t.egoModeDirect : t.connectionUnchecked}`;
    egoError.textContent = [value.reason, value.code ? `(${value.code})` : value.reason || connectionFailed ? t.egoUnknownError : ''].filter(Boolean).join(' '); egoError.hidden = !egoError.textContent;
    uncertain.hidden = !value.uncertain && !value.lastUnknownOutcome;
    helperStatus.textContent = `${t.egoHelperStatus} · ${value.helperOnline ? t.egoHelperOnline : t.egoHelperOffline}`;
    helperPath.textContent = value.helperDir ? `${labels.egoHelperDir} · ${value.helperDir}` : ''; helperPath.hidden = !value.helperDir;
    launcher.textContent = `${t.egoHelperLauncher} · ${value.launcherFile || t.egoHelperNotPrepared}`;
    for (const [field, control] of Object.entries(inputs)) {
      if (dirty.has(field as Field) || ctx.root.ownerDocument.activeElement === control) continue;
      if (control.type === 'checkbox') (control as HTMLInputElement).checked = Boolean(state.collectorConfig[field as Field]);
      else control.value = String(state.collectorConfig[field as Field]);
    }
    summary.render(state);
  }, () => {
    const value = ui.state?.egoConnection;
    connect.disabled = ui.busy || !value?.running || value.connecting || ui.state?.connectionTest.status === 'testing';
    prepare.disabled = ui.busy || !value?.running || !value.canPrepareHelper;
    stop.disabled = ui.busy || !value?.running || !value.helperOnline;
    connect.textContent = connecting ? t.connectionConnecting : t.connectEgo; summary.update();
  }, () => { key.value = ''; });
}

export default { panels: { dream: { mount: mountDreamPanel }, 'collection-settings': { mount: mountCollectionSettings }, 'qq-talk': { mount: mountQQTalk } } };

import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { configLabels, strings } from '../src/strings.ts';

export interface QQTalkState {
  qqUsers: string;
  dreamTalkEnabled: boolean;
  dreamTalkGroups: string;
  dreamTalkPrivates: string;
}

type ListKey = 'dreamTalkGroups' | 'dreamTalkPrivates';
const customValue = 'custom';
const validId = (value: string) => /^[1-9]\d{0,19}$/.test(value);
const ids = (value: string) => value.split(/[,，\s]+/).filter(Boolean);

function rosterIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Invalid QQ roster');
  return [...new Set(value.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return [];
    const { id, enabled } = entry;
    return enabled === true && Number.isSafeInteger(id) && id > 0 ? [String(id)] : [];
  }))];
}

export function mountQQTalk(ctx: WebUiPanelContext) {
  const t = strings(ctx.language), labels = configLabels(ctx.language);
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] => {
    const node = ctx.root.ownerDocument.createElement(tag); node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (text: string, className = '') => {
    const node = element('button', `dream-button ${className}`, text); node.type = 'button'; return node;
  };
  const panel = element('div', 'dream-panel dream-qq-talk');
  const notice = element('p', 'dream-notice'); notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  const error = element('p', 'dream-error'); error.setAttribute('role', 'alert'); error.hidden = true;
  panel.append(element('h2', '', t.qqTalkTitle), element('p', 'dream-secondary', t.qqTalkRequiresPlugin));

  const permissions = element('section', 'dream-card dream-qq-permissions');
  const ownersForm = element('form', 'dream-qq-owners-form');
  const ownersLabel = element('label', 'dream-field dream-qq-owners-label');
  const owners = element('input', 'dream-input dream-qq-owners'); owners.type = 'text';
  ownersLabel.append(element('span', '', labels.qqUsers), owners);
  const saveOwners = button(t.qqTalkSavePermissions, 'dream-primary'); saveOwners.type = 'submit';
  ownersForm.append(ownersLabel, saveOwners);
  permissions.append(element('h3', '', t.qqTalkPermissions), element('p', 'dream-secondary', t.qqUsersDescription), ownersForm);

  const sharing = element('section', 'dream-card dream-qq-sharing');
  const enabledLabel = element('label', 'dream-collector-label');
  const enabled = element('input', 'dream-input dream-qq-enabled'); enabled.type = 'checkbox';
  enabledLabel.append(enabled, element('span', '', labels.dreamTalkEnabled));
  const rosterHeader = element('div', 'dream-section-header');
  const rosterStatus = element('p', 'dream-secondary dream-qq-roster-status', t.qqTalkRosterLoading);
  rosterStatus.setAttribute('role', 'status');
  const refresh = button(t.refresh, 'dream-qq-refresh'); rosterHeader.append(rosterStatus, refresh);
  sharing.append(enabledLabel, element('p', 'dream-secondary', t.qqTalkSharingHint), rosterHeader,
    element('p', 'dream-secondary', t.qqTalkSendHint));
  panel.append(permissions, sharing, notice, error);
  let state: QQTalkState | undefined, busy = false, disposed = false, ownersDirty = false;
  let stateSerial = 0, rosterSerial = 0, readingRoster = false;
  const active = () => !disposed && !ctx.signal.aborted;
  const controllers: Array<{ updateDisabled(): void; render(value: string): void; candidates(value: string[]): void }> = [];
  function report(message: string) { error.textContent = message; error.hidden = false; notice.textContent = ''; }
  function updateDisabled() {
    owners.disabled = saveOwners.disabled = enabled.disabled = busy || !state;
    refresh.disabled = readingRoster;
    for (const list of controllers) list.updateDisabled();
  }
  function render(value: QQTalkState) {
    state = value;
    if (!ownersDirty) owners.value = value.qqUsers;
    enabled.checked = value.dreamTalkEnabled;
    controllers[0]!.render(value.dreamTalkGroups); controllers[1]!.render(value.dreamTalkPrivates);
    updateDisabled();
  }
  async function save(patch: Partial<QQTalkState>, accepted: () => void = () => {}) {
    if (busy || !state || !active()) return false;
    busy = true; stateSerial++; error.hidden = true; notice.textContent = ''; updateDisabled();
    try {
      const next = await ctx.invoke<QQTalkState>('saveQQConfig', [patch]);
      if (!active()) return false;
      accepted(); render(next); notice.textContent = t.qqTalkSaved; return true;
    } catch {
      if (active()) report(t.qqTalkSaveFailed);
      return false;
    } finally { busy = false; if (active()) updateDisabled(); }
  }
  function allowlist(key: ListKey, title: string) {
    const section = element('section', `dream-qq-list-section dream-qq-${key === 'dreamTalkGroups' ? 'groups' : 'privates'}`);
    const list = element('ul', 'dream-qq-list'); section.append(element('h3', '', title), list); sharing.append(section);
    let candidates: string[] = [];
    const rows = new Map<string, ReturnType<typeof makeRow>>();
    function makeRow(savedId: string | null) {
      const row = element('li', `dream-qq-row${savedId === null ? ' dream-qq-draft' : ''}`);
      if (savedId !== null) row.dataset.savedId = savedId;
      const form = element('form', 'dream-qq-row-form');
      const select = element('select', 'dream-input dream-qq-select'); select.setAttribute('aria-label', title);
      const input = element('input', 'dream-input dream-qq-custom'); input.type = 'text'; input.inputMode = 'numeric';
      input.placeholder = t.qqTalkEnterId; input.setAttribute('aria-label', `${title} · ${t.qqTalkCustom}`); input.hidden = true;
      const commit = button(savedId === null ? t.qqTalkAdd : t.qqTalkSave, 'dream-primary dream-qq-commit'); commit.type = 'submit';
      const cancel = button(t.cancelAction, 'dream-qq-cancel'); cancel.hidden = true;
      const remove = button('×', 'dream-qq-remove'); remove.hidden = savedId === null;
      remove.setAttribute('aria-label', `${t.qqTalkRemove} ${savedId ?? ''}`);
      const rowError = element('p', 'dream-error dream-qq-row-error'); rowError.setAttribute('role', 'alert'); rowError.hidden = true;
      form.append(select, input, commit, cancel, remove); row.append(form, rowError);
      let dirty = false;
      function options() {
        const selected = select.value || savedId || '';
        select.replaceChildren();
        const values = [...new Set([savedId, selected === customValue ? null : selected, ...candidates].filter((value): value is string => !!value))];
        const placeholder = element('option', '', t.qqTalkSelect); placeholder.value = ''; select.append(placeholder);
        for (const value of values) { const option = element('option', '', value); option.value = value; select.append(option); }
        const custom = element('option', '', t.qqTalkCustom); custom.value = customValue; select.append(custom);
        select.value = selected;
      }
      function controls() {
        const custom = select.value === customValue;
        select.hidden = custom; input.hidden = !custom; cancel.hidden = !custom;
        commit.hidden = savedId !== null && !dirty;
        for (const node of [select, input, commit, cancel, remove]) node.disabled = busy || !state;
      }
      function reset() { dirty = false; select.value = savedId ?? ''; input.value = ''; rowError.hidden = true; controls(); }
      async function commitValue() {
        if (!state || busy || !active()) return;
        const value = (select.value === customValue ? input.value : select.value).trim();
        const current = ids(state[key]);
        const reason = !validId(value) ? t.qqTalkInvalidId : current.some(id => id === value && id !== savedId) ? t.qqTalkDuplicateId : '';
        if (reason) { rowError.textContent = reason; rowError.hidden = false; return; }
        rowError.hidden = true;
        const next = savedId === null ? [...current, value] : current.map(id => id === savedId ? value : id);
        const succeeded = await save({ [key]: next.join(',') }, reset);
        if (!succeeded && active()) { rowError.textContent = t.qqTalkSaveFailed; rowError.hidden = false; }
      }
      form.addEventListener('submit', event => { event.preventDefault(); void commitValue(); }, { signal: ctx.signal });
      select.addEventListener('change', () => {
        dirty = true; rowError.hidden = true; controls();
        if (select.value === customValue) { input.value = savedId ?? ''; input.focus(); }
        else if (savedId !== null && select.value) void commitValue();
      }, { signal: ctx.signal });
      input.addEventListener('input', () => { dirty = true; rowError.hidden = true; controls(); }, { signal: ctx.signal });
      cancel.addEventListener('click', reset, { signal: ctx.signal });
      remove.addEventListener('click', () => {
        if (state) void save({ [key]: ids(state[key]).filter(id => id !== savedId).join(',') });
      }, { signal: ctx.signal });
      options(); controls();
      return { row, options, controls };
    }
    const draft = makeRow(null); list.append(draft.row);
    return {
      candidates(value: string[]) { candidates = value; for (const row of [...rows.values(), draft]) row.options(); },
      updateDisabled() { for (const row of [...rows.values(), draft]) row.controls(); },
      render(value: string) {
        const current = ids(value);
        for (const [id, row] of rows) if (!current.includes(id)) { row.row.remove(); rows.delete(id); }
        let cursor: ChildNode | null = list.firstChild;
        for (const id of current) {
          let row = rows.get(id);
          if (!row) { row = makeRow(id); rows.set(id, row); }
          if (row.row !== cursor) list.insertBefore(row.row, cursor);
          cursor = row.row.nextSibling;
        }
      },
    };
  }
  controllers.push(allowlist('dreamTalkGroups', t.qqTalkGroups), allowlist('dreamTalkPrivates', t.qqTalkPrivates));
  owners.addEventListener('input', () => { ownersDirty = true; }, { signal: ctx.signal });
  ownersForm.addEventListener('submit', event => {
    event.preventDefault();
    const values = ids(owners.value.trim());
    if (values.some(value => !validId(value))) { report(t.qqTalkInvalidId); return; }
    void save({ qqUsers: [...new Set(values)].join(',') }, () => { ownersDirty = false; });
  }, { signal: ctx.signal });
  enabled.addEventListener('change', () => {
    void save({ dreamTalkEnabled: enabled.checked }).then(saved => { if (!saved && active() && state) enabled.checked = state.dreamTalkEnabled; });
  }, { signal: ctx.signal });
  async function reloadState() {
    const serial = ++stateSerial;
    try {
      const next = await ctx.invoke<QQTalkState>('state');
      if (active() && serial === stateSerial) render(next);
    } catch { if (active() && serial === stateSerial) report(t.error); }
  }
  async function reloadRoster() {
    const serial = ++rosterSerial; readingRoster = true; rosterStatus.textContent = t.qqTalkRosterLoading; updateDisabled();
    try {
      const response = await fetch('/api/webui/providers/world%3Aqq/panels/roster/get', {
        method: 'POST', credentials: 'same-origin', signal: ctx.signal,
        headers: { 'Content-Type': 'application/json', 'x-cortico-language': ctx.language }, body: JSON.stringify({ args: [] }),
      });
      if (!response.ok) throw new Error('QQ roster unavailable');
      const value: unknown = await response.json();
      if (!value || typeof value !== 'object' || !('groups' in value) || !('privates' in value)) throw new Error('Invalid QQ roster');
      const groups = rosterIds(value.groups), privates = rosterIds(value.privates);
      if (!active() || serial !== rosterSerial) return;
      controllers[0]!.candidates(groups); controllers[1]!.candidates(privates);
      rosterStatus.textContent = groups.length || privates.length ? t.qqTalkRosterLoaded : t.qqTalkRosterEmpty;
    } catch {
      if (!active() || serial !== rosterSerial) return;
      controllers[0]!.candidates([]); controllers[1]!.candidates([]); rosterStatus.textContent = t.qqTalkRosterUnavailable;
    } finally { if (active() && serial === rosterSerial) { readingRoster = false; updateDisabled(); } }
  }
  refresh.addEventListener('click', () => { void reloadRoster(); if (!busy) void reloadState(); }, { signal: ctx.signal });
  ctx.root.append(panel); updateDisabled();
  const polling = ctx.interval(() => { if (!busy) void reloadState(); }, 3000);
  void reloadState(); void reloadRoster();
  return { dispose() { disposed = true; stateSerial++; rosterSerial++; polling.dispose(); panel.remove(); } };
}

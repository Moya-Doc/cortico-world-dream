import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { mountQQTalk, type QQTalkState } from '../webui/qq-talk.ts';
import bundle from '../webui/client.ts';
import { strings } from '../src/strings.ts';

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); vi.unstubAllGlobals(); });
const t = strings('en');
const rosterPath = '/api/webui/providers/world%3Aqq/panels/roster/get';
type Roster = { groups: unknown[]; privates: unknown[] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function harness(initial: Partial<QQTalkState> = {}, initialRoster: Roster = {
  groups: [{ id: 12345, enabled: true }, { id: 23456, enabled: false }, { id: 34567, enabled: true }],
  privates: [{ id: 56789, enabled: true }],
}) {
  const dom = new JSDOM('<main></main>', { url: 'https://panel.example' });
  const root = dom.window.document.querySelector('main')!;
  const abort = new dom.window.AbortController();
  const state: QQTalkState = { qqUsers: '', dreamTalkEnabled: false, dreamTalkGroups: '', dreamTalkPrivates: '', ...initial };
  let roster = initialRoster, rosterStatus = 200, failSave = false;
  let waitRoster: Promise<Roster> | undefined, waitState: Promise<QQTalkState> | undefined, waitSave: Promise<void> | undefined;
  const patches: Partial<QQTalkState>[] = [];
  const requests: Array<{ path: string; method: string; args: unknown[]; signal: AbortSignal }> = [];
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    if (path !== rosterPath || init.method !== 'POST') throw new Error('Undeclared API request');
    const { args } = JSON.parse(String(init.body)) as { args: unknown[] };
    requests.push({ path, method: init.method, args, signal: init.signal! });
    const result = waitRoster ? await waitRoster : roster;
    return new Response(JSON.stringify(result), { status: rosterStatus, headers: { 'Content-Type': 'application/json' } });
  });
  let poll: (() => void) | undefined;
  const context = {
    root, signal: abort.signal, language: 'en',
    async invoke(method: string, args: unknown[] = []) {
      if (method === 'state') return waitState ?? structuredClone(state);
      if (method !== 'saveQQConfig') throw new Error(`Unexpected method: ${method}`);
      const patch = args[0] as Partial<QQTalkState>;
      if (Object.keys(patch).some(key => !(key in state))) throw new Error('Unexpected config field');
      if (waitSave) await waitSave;
      if (failSave) throw new Error('Rejected settings');
      patches.push(structuredClone(patch)); Object.assign(state, patch); return structuredClone(state);
    },
    interval(fn: () => void) { poll = fn; return { dispose() { poll = undefined; } }; },
  } as unknown as WebUiPanelContext;
  const mounted = mountQQTalk(context);
  const dispose = () => { abort.abort(); mounted.dispose(); };
  cleanup.push(() => { dispose(); dom.window.close(); });
  function node<T extends Element = HTMLElement>(selector: string) { return root.querySelector<T>(selector)!; }
  function select(selector: string, value: string) {
    const control = node<HTMLSelectElement>(selector); control.value = value;
    control.dispatchEvent(new dom.window.Event('change', { bubbles: true })); return control;
  }
  function input(selector: string, value: string) {
    const control = node<HTMLInputElement>(selector); control.value = value;
    control.dispatchEvent(new dom.window.Event('input', { bubbles: true })); return control;
  }
  function submit(selector: string) {
    node(selector).dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  }
  const ready = async () => { await vi.waitFor(() => expect(node<HTMLInputElement>('.dream-qq-owners').disabled).toBe(false)); };
  return {
    root, state, requests, patches, node, input, select, submit, ready, dispose,
    poll: () => poll?.(), get polling() { return !!poll; },
    roster(value: Roster, status = 200) { roster = value; rosterStatus = status; },
    deferRoster(value: Promise<Roster>) { waitRoster = value; },
    deferState(value: Promise<QQTalkState>) { waitState = value; },
    deferSave(value: Promise<void>) { waitSave = value; },
    failSave(value: boolean) { failSave = value; },
  };
}

const groupDraft = '.dream-qq-groups .dream-qq-draft';
const privateDraft = '.dream-qq-privates .dream-qq-draft';

describe('QQ dream sharing panel', () => {
  it('registers the separate panel and reads only enabled, exact roster IDs through the public API', async () => {
    expect(bundle.panels['qq-talk'].mount).toBe(mountQQTalk);
    const ui = harness({}, {
      groups: [{ id: 12345, enabled: true }, { id: 12345, enabled: true }, { id: 45678, enabled: false },
        { id: Number.MAX_SAFE_INTEGER + 1, enabled: true }, { id: -1, enabled: true }, { id: '88888', enabled: true }],
      privates: [{ id: 56789, enabled: true }],
    });
    await ui.ready();
    expect(ui.root.textContent).toContain(t.qqTalkRequiresPlugin);
    expect(ui.node('.dream-qq-roster-status').textContent).toBe(t.qqTalkRosterLoaded);
    expect([...ui.node<HTMLSelectElement>(`${groupDraft} select`).options].map(option => option.value)).toEqual(['', '12345', 'custom']);
    expect([...ui.node<HTMLSelectElement>(`${privateDraft} select`).options].map(option => option.value)).toEqual(['', '56789', 'custom']);
    expect(ui.requests.map(({ path, method, args }) => ({ path, method, args }))).toEqual([{ path: rosterPath, method: 'POST', args: [] }]);
    expect(ui.patches).toEqual([]);
  });

  it('adds a selected group, leaves a new blank field and persists edits and removal', async () => {
    const ui = harness(); await ui.ready();
    ui.select(`${groupDraft} select`, '12345'); ui.submit(`${groupDraft} form`);
    await vi.waitFor(() => expect(ui.state.dreamTalkGroups).toBe('12345'));
    expect(ui.node<HTMLSelectElement>(`${groupDraft} select`).value).toBe('');
    expect(ui.root.querySelectorAll('.dream-qq-groups .dream-qq-row')).toHaveLength(2);
    ui.select('.dream-qq-groups [data-saved-id="12345"] select', '34567');
    await vi.waitFor(() => expect(ui.state.dreamTalkGroups).toBe('34567'));
    ui.node<HTMLButtonElement>('.dream-qq-groups [data-saved-id="34567"] .dream-qq-remove').click();
    await vi.waitFor(() => expect(ui.state.dreamTalkGroups).toBe(''));
    expect(ui.root.querySelectorAll('.dream-qq-groups .dream-qq-row')).toHaveLength(1);
  });

  it('allows custom private recipients without QQ and keeps them separate from command permissions', async () => {
    const ui = harness({ qqUsers: '77777' }); await ui.ready();
    ui.roster({ groups: [], privates: [] }, 404); ui.node<HTMLButtonElement>('.dream-qq-refresh').click();
    await vi.waitFor(() => expect(ui.node('.dream-qq-roster-status').textContent).toBe(t.qqTalkRosterUnavailable));
    ui.select(`${privateDraft} select`, 'custom');
    ui.input(`${privateDraft} input`, '12345678901234567890'); ui.submit(`${privateDraft} form`);
    await vi.waitFor(() => expect(ui.state.dreamTalkPrivates).toBe('12345678901234567890'));
    expect(ui.state.qqUsers).toBe('77777'); expect(ui.state.dreamTalkGroups).toBe('');
    const row = '.dream-qq-privates [data-saved-id="12345678901234567890"]';
    expect(ui.node<HTMLSelectElement>(`${row} select`).value).toBe('12345678901234567890');
    ui.select(`${row} select`, 'custom'); ui.input(`${row} input`, '98765'); ui.submit(`${row} form`);
    await vi.waitFor(() => expect(ui.state.dreamTalkPrivates).toBe('98765'));
    expect(ui.node<HTMLInputElement>(`${privateDraft} input`).value).toBe('');
  });

  it('rejects invalid and duplicate IDs without saving or consuming the draft', async () => {
    const ui = harness({ dreamTalkGroups: '12345' }); await ui.ready();
    ui.select(`${groupDraft} select`, 'custom'); ui.input(`${groupDraft} input`, '0'); ui.submit(`${groupDraft} form`);
    expect(ui.node(`${groupDraft} .dream-qq-row-error`).textContent).toBe(t.qqTalkInvalidId);
    ui.input(`${groupDraft} input`, '12345'); ui.submit(`${groupDraft} form`);
    expect(ui.node(`${groupDraft} .dream-qq-row-error`).textContent).toBe(t.qqTalkDuplicateId);
    expect(ui.node<HTMLInputElement>(`${groupDraft} input`).value).toBe('12345');
    expect(ui.state.dreamTalkGroups).toBe('12345'); expect(ui.patches).toEqual([]);
  });

  it('retains failed additions, edits and deletions for retry', async () => {
    const ui = harness({ dreamTalkGroups: '12345' }); await ui.ready(); ui.failSave(true);
    ui.select(`${privateDraft} select`, 'custom'); ui.input(`${privateDraft} input`, '99999'); ui.submit(`${privateDraft} form`);
    await vi.waitFor(() => expect(ui.node(`${privateDraft} .dream-qq-row-error`).textContent).toBe(t.qqTalkSaveFailed));
    expect(ui.node<HTMLInputElement>(`${privateDraft} input`).value).toBe('99999'); expect(ui.state.dreamTalkPrivates).toBe('');
    const row = '.dream-qq-groups [data-saved-id="12345"]';
    ui.select(`${row} select`, '34567');
    await vi.waitFor(() => expect(ui.node(`${row} .dream-qq-row-error`).textContent).toBe(t.qqTalkSaveFailed));
    expect(ui.node<HTMLSelectElement>(`${row} select`).value).toBe('34567');
    ui.node<HTMLButtonElement>(`${row} .dream-qq-remove`).click();
    await vi.waitFor(() => expect(ui.node<HTMLButtonElement>(`${row} .dream-qq-remove`).disabled).toBe(false));
    expect(ui.state.dreamTalkGroups).toBe('12345'); expect(ui.node(row)).not.toBeNull();
    ui.failSave(false); ui.submit(`${privateDraft} form`);
    await vi.waitFor(() => expect(ui.state.dreamTalkPrivates).toBe('99999'));
    ui.submit(`${row} form`);
    await vi.waitFor(() => expect(ui.state.dreamTalkGroups).toBe('34567'));
  });

  it('preserves owner and custom drafts through polls and delayed roster refreshes', async () => {
    const ui = harness({ dreamTalkGroups: '99999' }); await ui.ready();
    ui.input('.dream-qq-owners', '77777');
    ui.select(`${groupDraft} select`, 'custom'); ui.input(`${groupDraft} input`, '88888');
    const delayed = deferred<Roster>(); ui.deferRoster(delayed.promise);
    ui.node<HTMLButtonElement>('.dream-qq-refresh').click(); ui.poll();
    delayed.resolve({ groups: [{ id: 67890, enabled: true }], privates: [] });
    await vi.waitFor(() => expect(ui.node('.dream-qq-roster-status').textContent).toBe(t.qqTalkRosterLoaded));
    expect(ui.node<HTMLInputElement>('.dream-qq-owners').value).toBe('77777');
    expect(ui.node<HTMLInputElement>(`${groupDraft} input`).value).toBe('88888');
    expect(ui.node<HTMLInputElement>(`${groupDraft} input`).hidden).toBe(false);
    expect(ui.node<HTMLSelectElement>('.dream-qq-groups [data-saved-id="99999"] select').value).toBe('99999');
    ui.submit('.dream-qq-owners-form');
    await vi.waitFor(() => expect(ui.state.qqUsers).toBe('77777'));
    expect(ui.node<HTMLInputElement>(`${groupDraft} input`).value).toBe('88888');
  });

  it('keeps focus and edits in an existing custom row across state polling', async () => {
    const ui = harness({ dreamTalkGroups: '12345,34567' }); await ui.ready();
    const row = '.dream-qq-groups [data-saved-id="12345"]';
    ui.select(`${row} select`, 'custom');
    const input = ui.input(`${row} input`, '98765');
    expect(input.ownerDocument.activeElement).toBe(input);
    ui.poll(); await Promise.resolve(); await Promise.resolve();
    expect(input.ownerDocument.activeElement).toBe(input); expect(input.value).toBe('98765');
    ui.submit(`${row} form`);
    await vi.waitFor(() => expect(ui.state.dreamTalkGroups).toBe('98765,34567'));
  });

  it('saves permissions explicitly and sharing independently, reverting a failed sharing toggle', async () => {
    const ui = harness(); await ui.ready();
    ui.input('.dream-qq-owners', '11111, 22222'); expect(ui.state.qqUsers).toBe('');
    ui.submit('.dream-qq-owners-form');
    await vi.waitFor(() => expect(ui.state.qqUsers).toBe('11111,22222'));
    ui.node<HTMLInputElement>('.dream-qq-enabled').click();
    await vi.waitFor(() => expect(ui.state.dreamTalkEnabled).toBe(true));
    ui.failSave(true); ui.node<HTMLInputElement>('.dream-qq-enabled').click();
    await vi.waitFor(() => expect(ui.node<HTMLInputElement>('.dream-qq-enabled').checked).toBe(true));
    expect(ui.state.dreamTalkEnabled).toBe(true); expect(ui.state.qqUsers).toBe('11111,22222');
  });

  it('ignores a stale state response after a successful save', async () => {
    const ui = harness(); await ui.ready();
    const stale = deferred<QQTalkState>(); ui.deferState(stale.promise); ui.poll();
    ui.select(`${groupDraft} select`, '12345'); ui.submit(`${groupDraft} form`);
    await vi.waitFor(() => expect(ui.state.dreamTalkGroups).toBe('12345'));
    stale.resolve({ qqUsers: '', dreamTalkEnabled: false, dreamTalkGroups: '', dreamTalkPrivates: '' });
    await Promise.resolve(); await Promise.resolve();
    expect(ui.node('.dream-qq-groups [data-saved-id="12345"]')).not.toBeNull();
  });

  it('stops polling and ignores late requests when the panel is unmounted', async () => {
    const ui = harness(); await ui.ready();
    const delayed = deferred<Roster>(); ui.deferRoster(delayed.promise);
    ui.node<HTMLButtonElement>('.dream-qq-refresh').click();
    ui.dispose(); delayed.resolve({ groups: [{ id: 12345, enabled: true }], privates: [] });
    await Promise.resolve(); await Promise.resolve();
    expect(ui.requests.every(request => request.signal.aborted)).toBe(true);
    expect(ui.polling).toBe(false); expect(ui.root.childElementCount).toBe(0);
  });
});

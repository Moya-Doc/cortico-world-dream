/*
 * Adapted from cortico-world-ego (https://github.com/biliye/cortico-world-ego).
 * Browser-only Dream integration; video and Bilibili features are excluded.
 *
 * MIT License
 *
 * Copyright (c) 2026 筆離嘢
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DreamConfigSection } from './config.ts';
import { publicBrowserUrl } from './ego-runtime.mjs';
import { AutoBridge, CliBridge, HelperBridge, isConnectionFailure, normalizeFailure, prepareHelperLauncher, validateRequest,
  type BridgeReceipt, type EgoBridge } from './ego-transport/index.ts';

export interface DreamEgoBrowserOptions {
  config: () => DreamConfigSection;
  /** The Dream archive directory; the controller owns its ego/ child. */
  dataDir: string;
  botDir: string;
  bridge?: EgoBridge;
  onState?: () => void;
}
export interface DreamEgoBrowserState {
  running: boolean; connected: boolean; connecting: boolean; halted: boolean; reason: string; code?: string;
  uncertain: boolean; spaceMissing: boolean; spaceId: number | null; spaceName: string;
  connectionMode: 'auto' | 'direct' | 'helper'; transport: 'direct' | 'helper' | null;
  helperOnline: boolean; helperDir: string; launcherFile: string; canPrepareHelper: boolean; lastOperation: string | null;
  checkingControl: boolean;
  lastUnknownOutcome: { operation: string; code: string } | null;
}
interface SavedState {
  version: 1; spaceName: string; spaceId?: number; halted: boolean; code?: string; uncertain: boolean; spaceMissing: boolean;
  lastUnknownOutcome?: { operation: string; code: string };
}
const messages: Record<string, string> = {
  EGO_STOPPED: 'Enable Dream World before connecting its browser.',
  EGO_CANCELLED: 'The dream browser operation was cancelled.',
  EGO_COMMAND_CANCELLED: 'The browser command was cancelled. Check its outcome before resuming when it may have started.',
  EGO_INVALID_ARGUMENTS: 'The browser arguments are invalid.',
  EGO_INVALID_ARGUMENT: 'The browser arguments are invalid.',
  EGO_CLI_NOT_FOUND: 'The ego-browser executable could not be found.',
  EGO_CLIENT_ELEVATED: 'ego-browser rejected an elevated client. Start the ordinary-permission helper.',
  EGO_BROWSER_UNAVAILABLE: 'ego lite is unavailable. Open the application and reconnect.',
  EGO_HELPER_UNAVAILABLE: 'The ordinary-permission helper is not running.',
  EGO_HELPER_REQUIRED: 'Start the ordinary-permission helper and reconnect.',
  EGO_HELPER_VERSION: 'Regenerate the helper launcher and restart the helper.',
  EGO_HELPER_SPACE_MISMATCH: 'This helper is assigned to another browser Space.',
  EGO_HELPER_INTERRUPTED: 'The helper connection was interrupted. Inspect the browser before resuming.',
  EGO_HELPER_ALREADY_RUNNING: 'A helper already runs from this directory.',
  EGO_TASK_SPACE_USER_IN_CONTROL: 'The operator or a browser prompt controls the dream Space. Return control in ego lite; availability is checked automatically.',
  EGO_TASK_SPACE_INACTIVE: 'The dream Space is inactive. Inspect it before resuming.',
  EGO_TASK_SPACE_NAME_IN_USE: 'The configured dream Space name is already in use.',
  EGO_TASK_SPACE_NOT_FOUND: 'The dream Space no longer exists. Its pages and element references are invalid.',
  EGO_TASK_SPACE_NOT_SELECTED: 'The dream Space is no longer assigned to this browser task.',
  EGO_TASK_SPACE_UNAVAILABLE: 'The dream Space is unavailable.',
  EGO_TASK_HOST_DISCONNECTED: 'The browser task host disconnected.',
  EGO_DREAM_SPACE_MISMATCH: 'The saved Space identity belongs to another task. Inspect the browser before resuming.',
  EGO_PAGE_NOT_MANAGED: 'Use the tabs tool to select a page managed by this dream Space.',
  EGO_PAGE_NOT_OWNED: 'Only pages opened by this dream browser may be closed.',
  EGO_IMAGE_TOO_LARGE: 'The screenshot exceeds the 8 MiB limit.',
  EGO_RESPONSE_TOO_LARGE: 'The browser response exceeded the transport size limit. Request a smaller page result.',
  EGO_RUNTIME_FAILED: 'The ego-browser runtime could not complete the command. Check the installed browser and helper versions.',
  EGO_COMMAND_TIMEOUT: 'The browser command timed out. Its outcome is unknown; inspect the Space before resuming.',
  EGO_PAGE_EVALUATION_TIMED_OUT: 'Page JavaScript timed out and may still have effects. Inspect the page before resuming; do not repeat the script automatically.',
  EGO_STATE_INVALID: 'The saved dream browser state could not be read. Inspect the browser before resuming.',
  EGO_INVALID_RECEIPT: 'The browser returned an invalid or mismatched receipt. Inspect the Space before resuming.',
  EGO_UNCERTAIN: 'The browser operation has an unknown outcome. Inspect the Space before resuming; do not repeat the action automatically.',
  EGO_OPERATION_FAILED: 'The dream browser operation failed.',
};
const stoppedCodes = new Set(['EGO_TASK_SPACE_USER_IN_CONTROL', 'EGO_TASK_SPACE_INACTIVE', 'EGO_TASK_SPACE_NAME_IN_USE',
  'EGO_TASK_SPACE_NOT_FOUND', 'EGO_TASK_SPACE_NOT_SELECTED', 'EGO_TASK_SPACE_UNAVAILABLE', 'EGO_TASK_HOST_DISCONNECTED',
  'EGO_DREAM_SPACE_MISMATCH', 'EGO_STATE_INVALID', 'EGO_INVALID_RECEIPT']);
const operations = new Set(['open', 'navigate', 'tabs', 'read', 'click', 'fill', 'press', 'scroll', 'evaluate', 'wait', 'shot', 'close', 'handoff', 'control-status']);
function failure(code: string, uncertain = false): BridgeReceipt { return { error: messages[code] ?? messages.EGO_OPERATION_FAILED, code, uncertain }; }
function safeReceipt(receipt: BridgeReceipt): BridgeReceipt {
  if (!receipt.error && !receipt.code && !receipt.uncertain) return receipt;
  const original = normalizeFailure(receipt);
  const uncertain = original.uncertain === true || original.code === 'EGO_PAGE_EVALUATION_TIMED_OUT';
  const code = original.code && Object.hasOwn(messages, original.code) ? original.code : uncertain ? 'EGO_UNCERTAIN' : 'EGO_OPERATION_FAILED';
  return { ...original, ...failure(code, uncertain) };
}

/** One deployment retains one owned Space. Cancellation never closes pages or replays browser operations. */
export class DreamEgoBrowser {
  private readonly stateFile: string;
  private bridge!: EgoBridge;
  private helper!: HelperBridge;
  private transport?: AutoBridge;
  private configuration = '';
  private saved: SavedState;
  private running = false;
  private connected = false;
  private connecting = false;
  private helperOnline = false;
  private launcherFile = '';
  private lastOperation: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private lifetime = new AbortController();
  private pending = new AbortController();
  private controlTimer?: ReturnType<typeof setTimeout>;
  private controlGeneration = 0;
  private controlDelay = 2000;
  private checkingControl = false;
  constructor(private readonly options: DreamEgoBrowserOptions) {
    this.stateFile = join(options.dataDir, 'ego', 'state.json');
    this.saved = this.freshState();
    this.configureTransport();
  }
  private get cfg() { return this.options.config(); }
  private spaceName() { return this.cfg.egoSpaceName.trim() || `Coopanion-Dream-${createHash('sha256').update(resolve(this.options.botDir)).digest('hex').slice(0, 12)}`; }
  private helperDir() { return this.cfg.egoHelperDir.trim() || join(this.options.dataDir, 'ego', 'helper'); }
  private configurationKey() { return JSON.stringify([this.cfg.egoExecutableFile, this.cfg.egoConnectionMode, this.helperDir(), this.spaceName()]); }
  private freshState(): SavedState { return { version: 1, spaceName: this.spaceName(), halted: false, uncertain: false, spaceMissing: false }; }
  private changed() { this.options.onState?.(); }
  private configureTransport() {
    const signature = this.configurationKey();
    if (signature === this.configuration) return;
    this.configuration = signature;
    const timeout = () => this.cfg.egoRequestTimeoutMs;
    this.helper = new HelperBridge(this.helperDir(), timeout);
    if (this.options.bridge) this.bridge = this.options.bridge;
    else {
      this.transport = new AutoBridge(new CliBridge({ cliFile: this.cfg.egoExecutableFile, dataDir: this.options.dataDir, timeoutMs: timeout }),
        this.helper, this.cfg.egoConnectionMode);
      this.bridge = this.transport;
    }
    this.connected = false; this.helperOnline = false; this.launcherFile = ''; this.lastOperation = null;
  }
  reconfigure(): void {
    this.configureTransport();
    this.changed();
  }
  state(): DreamEgoBrowserState {
    return { running: this.running, connected: this.running && this.connected && this.configuration === this.configurationKey() && this.saved.spaceName === this.spaceName(), connecting: this.connecting, halted: this.saved.halted,
      reason: this.saved.code ? messages[this.saved.code] ?? messages.EGO_OPERATION_FAILED! : '', code: this.saved.code,
      uncertain: this.saved.uncertain, spaceMissing: this.saved.spaceMissing, spaceId: this.saved.spaceId ?? null,
      spaceName: this.saved.spaceName, connectionMode: this.cfg.egoConnectionMode, transport: this.lastOperation ? this.transport?.selected ?? (this.options.bridge ? 'direct' : null) : null,
      helperOnline: this.helperOnline, helperDir: this.helperDir(), launcherFile: this.launcherFile,
      canPrepareHelper: process.platform === 'win32' || process.platform === 'darwin', lastOperation: this.lastOperation,
      checkingControl: this.checkingControl,
      lastUnknownOutcome: this.saved.lastUnknownOutcome ? { ...this.saved.lastUnknownOutcome } : null };
  }
  async start(): Promise<void> {
    if (this.running) return;
    this.lifetime = new AbortController(); this.pending = new AbortController(); this.configureTransport();
    this.saved = this.freshState(); this.connected = false;
    try {
      if ((await stat(this.stateFile)).size > 32768) throw new Error('Invalid state size');
      const saved = JSON.parse(await readFile(this.stateFile, 'utf8')) as SavedState;
      if (saved.version !== 1 || typeof saved.spaceName !== 'string' || typeof saved.halted !== 'boolean'
        || typeof saved.uncertain !== 'boolean' || typeof saved.spaceMissing !== 'boolean'
        || (saved.code !== undefined && typeof saved.code !== 'string') || (saved.uncertain && !saved.halted)
        || (saved.spaceId !== undefined && (!Number.isSafeInteger(saved.spaceId) || saved.spaceId < 1))
        || (saved.lastUnknownOutcome !== undefined && (!saved.lastUnknownOutcome || typeof saved.lastUnknownOutcome.operation !== 'string'
          || !operations.has(saved.lastUnknownOutcome.operation) && !['connect', 'unknown'].includes(saved.lastUnknownOutcome.operation)
          || typeof saved.lastUnknownOutcome.code !== 'string' || !Object.hasOwn(messages, saved.lastUnknownOutcome.code)))) throw new Error('Invalid saved state');
      if (saved.spaceName === this.saved.spaceName || saved.halted) {
        const code = saved.code && Object.hasOwn(messages, saved.code) ? saved.code : saved.halted ? 'EGO_UNCERTAIN' : undefined;
        this.saved = { version: 1, spaceName: saved.spaceName, spaceId: saved.spaceId, halted: saved.halted,
          uncertain: saved.uncertain, spaceMissing: saved.spaceMissing && saved.halted && !saved.uncertain && code === 'EGO_TASK_SPACE_NOT_FOUND', code,
          ...(saved.lastUnknownOutcome ? { lastUnknownOutcome: { ...saved.lastUnknownOutcome } }
            : saved.uncertain ? { lastUnknownOutcome: { operation: 'unknown', code: code ?? 'EGO_UNCERTAIN' } } : {}) };
      } else if (saved.lastUnknownOutcome) this.saved.lastUnknownOutcome = { ...saved.lastUnknownOutcome };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.saved = { ...this.saved, halted: true, code: 'EGO_STATE_INVALID', uncertain: true,
        lastUnknownOutcome: { operation: 'unknown', code: 'EGO_STATE_INVALID' } };
    }
    this.running = true; this.scheduleControlCheck(); this.changed();
  }
  async stop(): Promise<void> {
    this.running = false; this.clearControlCheck(); this.lifetime.abort(); await this.cancelPending(); this.connected = false; this.changed();
  }
  async cancelPending(): Promise<void> {
    this.pending.abort(); this.pending = new AbortController();
    await this.queue.catch(() => {});
    this.scheduleControlCheck();
  }
  private serial(action: (signal: AbortSignal) => Promise<BridgeReceipt>, signal?: AbortSignal): Promise<BridgeReceipt> {
    const combined = AbortSignal.any([this.lifetime.signal, this.pending.signal, ...(signal ? [signal] : [])]);
    const result = this.queue.then(async () => {
      if (!this.running) return failure('EGO_STOPPED');
      if (combined.aborted) return failure('EGO_CANCELLED');
      this.configureTransport();
      const unboundNameConflict = this.saved.code === 'EGO_TASK_SPACE_NAME_IN_USE' && !this.saved.spaceId && !this.saved.uncertain;
      if (this.saved.spaceName !== this.spaceName() && (!this.saved.halted || unboundNameConflict)) {
        this.saved = { ...this.freshState(), ...(this.saved.lastUnknownOutcome ? { lastUnknownOutcome: this.saved.lastUnknownOutcome } : {}) };
        this.connected = false; await this.save();
      }
      return action(combined);
    });
    this.queue = result.catch(() => {});
    return result;
  }
  private async save(): Promise<void> {
    await mkdir(join(this.options.dataDir, 'ego'), { recursive: true, mode: 0o700 });
    const temp = `${this.stateFile}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(this.saved), { mode: 0o600 });
    await rename(temp, this.stateFile); this.changed();
  }
  private canCheckControl() {
    return this.running && this.saved.halted && !this.saved.spaceMissing
      && !['EGO_TASK_SPACE_NAME_IN_USE', 'EGO_DREAM_SPACE_MISMATCH', 'EGO_STATE_INVALID', 'EGO_TASK_SPACE_NOT_FOUND', 'EGO_TASK_SPACE_INACTIVE'].includes(this.saved.code ?? '');
  }
  private clearControlCheck() {
    this.controlGeneration++; this.controlDelay = 2000;
    if (this.controlTimer) clearTimeout(this.controlTimer);
    this.controlTimer = undefined;
  }
  private scheduleControlCheck() {
    if (!this.canCheckControl() || this.controlTimer || this.checkingControl) return;
    const generation = this.controlGeneration;
    this.controlTimer = setTimeout(() => {
      this.controlTimer = undefined;
      void this.serial(async signal => {
        if (!this.canCheckControl() || generation !== this.controlGeneration) return this.paused();
        this.checkingControl = true; this.changed();
        try {
          return await this.observeControl(signal, generation);
        } catch { return this.paused(); }
        finally {
          this.checkingControl = false; this.changed();
          if (generation === this.controlGeneration) { this.controlDelay = Math.min(10000, this.controlDelay * 2); this.scheduleControlCheck(); }
        }
      }).catch(() => {});
    }, this.controlDelay);
    this.controlTimer.unref();
  }
  private paused(): BridgeReceipt { return failure(this.saved.code ?? 'EGO_UNCERTAIN', this.saved.uncertain); }
  private async observeControl(signal: AbortSignal, generation = this.controlGeneration): Promise<BridgeReceipt> {
    const id = this.saved.spaceId;
    this.lastOperation = 'control-status'; this.changed();
    let receipt: BridgeReceipt;
    try { receipt = safeReceipt(await this.bridge.run('control-status', { ...(id ? { spaceId: id } : {}), spaceName: this.saved.spaceName }, signal)); }
    catch { receipt = failure('EGO_OPERATION_FAILED'); }
    if (!this.running || signal.aborted || generation !== this.controlGeneration) return failure('EGO_CANCELLED');
    if (this.transport?.selected === 'helper') {
      if (!receipt.error) this.helperOnline = true;
      else if (/^EGO_HELPER_/.test(receipt.code ?? '')) this.helperOnline = false;
    }
    if (!receipt.error && (receipt.uncertain || !Number.isSafeInteger(receipt.spaceId) || receipt.spaceId! < 1
      || id && receipt.spaceId !== id || !['agent', 'user', 'inactive'].includes(receipt.value?.control))) receipt = failure('EGO_INVALID_RECEIPT');
    if (!receipt.error) {
      this.saved.spaceId = receipt.spaceId;
      if (receipt.value.control === 'agent') {
        this.saved.halted = false; this.saved.code = undefined; this.saved.uncertain = false; this.saved.spaceMissing = false;
        this.connected = true; this.clearControlCheck(); await this.save();
        return receipt;
      }
      receipt = failure(receipt.value.control === 'user' ? 'EGO_TASK_SPACE_USER_IN_CONTROL' : 'EGO_TASK_SPACE_INACTIVE');
    }
    this.connected = false; this.saved.halted = true; this.saved.code = receipt.code;
    // A diagnostic failure leaves the original unknown outcome unresolved.
    this.saved.spaceMissing = receipt.code === 'EGO_TASK_SPACE_NOT_FOUND' && !this.saved.uncertain;
    await this.save(); this.scheduleControlCheck();
    return receipt;
  }
  private async command(operation: string, args: Record<string, unknown>, signal: AbortSignal, byName = false): Promise<BridgeReceipt> {
    if (signal.aborted) return failure('EGO_CANCELLED');
    this.lastOperation = operation; this.changed();
    let receipt: BridgeReceipt;
    try {
      receipt = safeReceipt(await this.bridge.run(operation, { ...args, spaceName: this.saved.spaceName,
        ...(byName || !this.saved.spaceId ? {} : { spaceId: this.saved.spaceId }) }, signal));
    } catch { receipt = failure('EGO_UNCERTAIN', true); }
    if (signal.aborted && !receipt.error) receipt = failure('EGO_UNCERTAIN', true);
    if (!receipt.error && (!Number.isSafeInteger(receipt.spaceId) || receipt.spaceId! < 1
      || (!byName && this.saved.spaceId && receipt.spaceId !== this.saved.spaceId))) receipt = failure('EGO_INVALID_RECEIPT', true);
    if (!receipt.error && ['connect', 'control-status'].includes(operation) && ['user', 'inactive'].includes(receipt.value?.control)) {
      this.saved.spaceId = receipt.spaceId;
      receipt = failure(receipt.value.control === 'user' ? 'EGO_TASK_SPACE_USER_IN_CONTROL' : 'EGO_TASK_SPACE_INACTIVE');
    }
    if (receipt.error) {
      if (receipt.uncertain || stoppedCodes.has(receipt.code ?? '') || receipt.code === 'EGO_PAGE_EVALUATION_TIMED_OUT') {
        this.saved.halted = true; this.saved.uncertain = receipt.uncertain === true;
        if (receipt.uncertain) this.saved.lastUnknownOutcome = { operation, code: receipt.code ?? 'EGO_UNCERTAIN' };
        this.saved.spaceMissing = receipt.code === 'EGO_TASK_SPACE_NOT_FOUND' && !receipt.uncertain;
        this.saved.code = receipt.code; this.connected = false;
      } else if (isConnectionFailure(receipt.code)) {
        this.connected = false;
        if (!this.saved.halted) this.saved.code = receipt.code;
      } else if (!this.saved.halted) this.saved.code = receipt.code;
      await this.save(); this.scheduleControlCheck(); return receipt;
    }
    this.saved.spaceId = receipt.spaceId;
    if (!this.saved.halted) this.saved.code = undefined;
    if (this.transport?.selected === 'helper') this.helperOnline = true;
    await this.save(); return receipt;
  }
  private async establish(signal: AbortSignal, byName = false): Promise<BridgeReceipt> {
    if (this.saved.halted && (!this.saved.spaceMissing || this.saved.uncertain)) return this.observeControl(signal);
    this.connecting = true; this.changed();
    try {
      let receipt = await this.command('connect', {}, signal, byName || this.saved.spaceMissing);
      if (receipt.code === 'EGO_TASK_SPACE_NOT_FOUND' && !receipt.uncertain && !signal.aborted && !byName) receipt = await this.command('connect', {}, signal, true);
      if (!receipt.error) {
        this.saved.halted = false; this.saved.uncertain = false; this.saved.spaceMissing = false; this.saved.code = undefined;
        this.connected = true; this.clearControlCheck(); await this.save();
      }
      return receipt;
    } finally { this.connecting = false; this.changed(); }
  }
  connect(signal?: AbortSignal): Promise<BridgeReceipt> { return this.serial(active => this.establish(active), signal); }
  run(operation: string, input: Record<string, unknown> = {}, signal?: AbortSignal): Promise<BridgeReceipt> {
    if (!operations.has(operation)) return Promise.resolve(failure('EGO_INVALID_ARGUMENTS'));
    if (operation === 'wait') return this.wait(input, signal);
    let args: Record<string, unknown>;
    try {
      if (['spaceId', 'spaceName', 'screenshotFile', 'restoreMinimized'].some(key => Object.hasOwn(input, key))) throw new Error();
      args = { ...input };
      if (['open', 'navigate', 'read', 'click', 'fill', 'press', 'scroll', 'evaluate'].includes(operation)) args.maxChars ??= this.cfg.egoMaxChars;
      if (operation === 'shot') args.restoreMinimized = this.cfg.egoRestoreMinimized;
      if (typeof args.url === 'string') args.url = publicBrowserUrl(args.url);
      validateRequest(operation, { ...args, spaceId: 1, spaceName: this.saved.spaceName });
    } catch { return Promise.resolve(failure('EGO_INVALID_ARGUMENTS')); }
    return this.serial(async active => {
      if (this.saved.halted && !this.saved.spaceMissing) return this.paused();
      if (!this.connected) { const receipt = await this.establish(active); if (receipt.error) return receipt; }
      const receipt = await this.command(operation, args, active);
      if (receipt.code === 'EGO_TASK_SPACE_NOT_FOUND' && !receipt.uncertain && !active.aborted) {
        const recovered = await this.establish(active, true);
        return recovered.error ? receipt : { ...receipt, value: { spaceReset: true, failedOperationReplayed: false } };
      }
      if (!receipt.error && operation === 'handoff') {
        this.saved.halted = true; this.saved.code = 'EGO_TASK_SPACE_USER_IN_CONTROL'; this.saved.uncertain = false;
        this.saved.spaceMissing = false; this.connected = false; await this.save(); this.scheduleControlCheck();
      }
      return receipt;
    }, signal);
  }
  handoff(signal?: AbortSignal): Promise<BridgeReceipt> { return this.run('handoff', {}, signal); }
  resume(signal?: AbortSignal): Promise<BridgeReceipt> {
    return this.serial(active => this.observeControl(active), signal);
  }
  private async wait(args: Record<string, unknown>, signal?: AbortSignal): Promise<BridgeReceipt> {
    if (!this.running) return failure('EGO_STOPPED');
    if (Object.keys(args).some(key => key !== 'seconds') || typeof args.seconds !== 'number' || !Number.isFinite(args.seconds) || args.seconds < 0 || args.seconds > 60) return failure('EGO_INVALID_ARGUMENTS');
    const active = AbortSignal.any([this.lifetime.signal, this.pending.signal, ...(signal ? [signal] : [])]);
    try {
      active.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const complete = () => { active.removeEventListener('abort', abort); resolve(); };
        const timer = setTimeout(complete, Number(args.seconds) * 1000);
        const abort = () => { clearTimeout(timer); active.removeEventListener('abort', abort); reject(new Error()); };
        active.addEventListener('abort', abort, { once: true }); if (active.aborted) abort();
      });
      return { value: { waitedSeconds: args.seconds, browserScriptExecuted: false, halted: this.saved.halted } };
    } catch { return failure('EGO_CANCELLED'); }
  }
  async prepareHelper(): Promise<BridgeReceipt> {
    if (!this.running) return failure('EGO_STOPPED');
    try {
      this.configureTransport();
      const launcher = await prepareHelperLauncher(this.helperDir(), this.cfg.egoExecutableFile);
      this.launcherFile = launcher.launcherFile; this.changed(); return { value: { launcherFile: this.launcherFile } };
    } catch { return failure('EGO_OPERATION_FAILED'); }
  }
  async stopHelper(): Promise<BridgeReceipt> {
    await this.cancelPending();
    try {
      await this.helper.stop(); this.helperOnline = false;
      if (this.transport?.selected === 'helper') { this.connected = false; if (!this.saved.halted) this.saved.code = 'EGO_HELPER_UNAVAILABLE'; await this.save(); }
      this.changed(); return { value: { stopped: true } };
    } catch { return failure('EGO_HELPER_UNAVAILABLE'); }
  }
}

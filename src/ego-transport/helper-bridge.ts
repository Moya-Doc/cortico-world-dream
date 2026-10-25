/** Adapted from cortico-world-ego (MIT, Copyright (c) 2026 筆離嘢); see LICENSE. */
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeFailure } from './failures.ts';
import { isElevated } from './permissions.ts';
import { validateHelperRequest } from './request.ts';
import { MAX_RECEIPT_BYTES, validReceipt, type BridgeReceipt, type EgoBridge } from './types.ts';

export const HELPER_PROTOCOL = 3;
export const HELPER_KIND = 'cortico-world-dream';
export interface HelperEndpoint { kind: typeof HELPER_KIND; protocol: number; port: number; token: string; pid: number }
export async function readEndpoint(dir: string): Promise<HelperEndpoint> {
  const handle = await open(join(dir, 'endpoint.json'), 'r');
  let endpoint: HelperEndpoint;
  try {
    if ((await handle.stat()).size > 8192) throw new Error('Invalid helper endpoint.');
    endpoint = JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
  if (endpoint.kind !== HELPER_KIND || endpoint.protocol !== HELPER_PROTOCOL) throw new Error('EGO_HELPER_VERSION');
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || !/^[a-f0-9]{64}$/.test(endpoint.token) || !Number.isSafeInteger(endpoint.pid) || endpoint.pid < 1) throw new Error('Invalid helper endpoint.');
  return endpoint;
}
async function readJson(response: Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing helper response.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > limit) throw new Error('Helper response exceeds the size limit.');
      chunks.push(result.value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export class HelperBridge implements EgoBridge {
  constructor(readonly dir: string, private readonly timeoutMs: () => number) {}
  private async available(endpoint: HelperEndpoint): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${endpoint.port}/health`, { redirect: 'error', headers: { authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(2000) });
      const value = await readJson(response, 8192) as { kind?: string; protocol?: number; elevated?: boolean; pid?: number };
      return response.ok && value.kind === HELPER_KIND && value.protocol === HELPER_PROTOCOL && value.elevated === false && value.pid === endpoint.pid;
    } catch { return false; }
  }
  async probe(): Promise<boolean> {
    try { return this.available(await readEndpoint(this.dir)); } catch { return false; }
  }
  async stop(): Promise<void> {
    const endpoint = await readEndpoint(this.dir);
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/shutdown`, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(5000) });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Could not stop Ego helper: HTTP ${response.status}`);
  }
  async run(operation: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<BridgeReceipt> {
    if (signal?.aborted) return { error: 'Ego operation cancelled before execution.', code: 'EGO_COMMAND_CANCELLED', uncertain: false };
    let request: ReturnType<typeof validateHelperRequest>;
    try { request = validateHelperRequest({ operation, args, timeoutMs: this.timeoutMs() }); }
    catch { return { error: 'Invalid browser operation or arguments.', code: 'EGO_INVALID_ARGUMENT', uncertain: false }; }
    let endpoint: HelperEndpoint;
    try { endpoint = await readEndpoint(this.dir); }
    catch (error) { return { error: 'Start the helper shipped with this extension, then reconnect.', code: String(error).includes('EGO_HELPER_VERSION') ? 'EGO_HELPER_VERSION' : 'EGO_HELPER_UNAVAILABLE', uncertain: false }; }
    if (!await this.available(endpoint)) return { error: 'The ordinary-permission Ego helper is not running. Start its launcher, then reconnect.', code: 'EGO_HELPER_UNAVAILABLE', uncertain: false };
    if (signal?.aborted) return { error: 'Ego operation cancelled before execution.', code: 'EGO_COMMAND_CANCELLED', uncertain: false };
    const timeout = AbortSignal.timeout(request.timeoutMs + 5000);
    try {
      const response = await fetch(`http://127.0.0.1:${endpoint.port}/run`, {
        method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(request), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const receipt = await readJson(response, MAX_RECEIPT_BYTES);
      if (!validReceipt(receipt) || !response.ok && !receipt.error) return { error: 'Ego helper returned an invalid receipt.', code: 'EGO_INVALID_RECEIPT', uncertain: true };
      return normalizeFailure(receipt);
    } catch {
      return { error: 'Ego helper connection interrupted; browser effects may still finish.', code: signal?.aborted ? 'EGO_COMMAND_CANCELLED' : timeout.aborted ? 'EGO_COMMAND_TIMEOUT' : 'EGO_HELPER_INTERRUPTED', uncertain: true };
    }
  }
}
export class AutoBridge implements EgoBridge {
  selected: 'direct' | 'helper' = 'direct';
  private checkedElevation = false;
  constructor(private readonly direct: EgoBridge, private readonly helper: EgoBridge, private readonly mode: 'auto' | 'direct' | 'helper', private readonly checkElevated = isElevated) {
    if (mode === 'helper') this.selected = 'helper';
  }
  async run(operation: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<BridgeReceipt> {
    if (signal?.aborted) return { error: 'Ego operation cancelled before execution.', code: 'EGO_COMMAND_CANCELLED', uncertain: false };
    if (this.mode === 'auto' && !this.checkedElevation) {
      this.checkedElevation = true;
      try { if (await this.checkElevated()) this.selected = 'helper'; } catch { /* Ego also reports elevated clients before executing operations. */ }
    }
    if (this.selected === 'helper') return this.helper.run(operation, args, signal);
    const receipt = normalizeFailure(await this.direct.run(operation, args, signal));
    if (this.mode !== 'auto' || receipt.code !== 'EGO_CLIENT_ELEVATED' || receipt.uncertain !== false || signal?.aborted) return receipt;
    this.selected = 'helper';
    const result = await this.helper.run(operation, args, signal);
    if (result.code === 'EGO_HELPER_UNAVAILABLE') return { ...result, code: 'EGO_HELPER_REQUIRED', error: 'Ego rejected the elevated client. Start the ordinary-permission helper, then reconnect.' };
    return result;
  }
}

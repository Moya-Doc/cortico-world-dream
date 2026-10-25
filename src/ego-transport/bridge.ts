/** Adapted from cortico-world-ego (MIT, Copyright (c) 2026 筆離嘢); see LICENSE. */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeFailure } from './failures.ts';
import { minimalEnvironment } from './permissions.ts';
import { validateRequest } from './request.ts';
import { MAX_RECEIPT_BYTES, validReceipt, type BridgeReceipt, type EgoBridge } from './types.ts';
export type { BridgeReceipt, EgoBridge, EvaluationTimeout } from './types.ts';

export class CliBridge implements EgoBridge {
  constructor(private readonly options: { cliFile: string; dataDir: string; timeoutMs: () => number; runtimeUrl?: string }) {}
  async run(operation: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<BridgeReceipt> {
    let directory: string | undefined;
    let launched = false;
    try {
      if (signal?.aborted) return { error: 'Ego operation cancelled before execution.', code: 'EGO_COMMAND_CANCELLED', uncertain: false };
      const request = validateRequest(operation, args);
      let file = this.options.cliFile.trim() || 'ego-browser';
      if (/\.(cmd|bat|ps1)$/i.test(file) || /[\u0000-\u001f]/.test(file)) return { error: 'Select an ego-browser executable without shell arguments.', code: 'EGO_CLI_NOT_FOUND', uncertain: false };
      if (file.endsWith('.app')) file = join(file, 'Contents/Frameworks/ego Framework.framework/Versions/Current/Helpers/ego-browser');
      const parent = resolve(this.options.dataDir, 'ego', 'rounds');
      await mkdir(parent, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(parent, 'round-'));
      const input = join(directory, 'script.mjs'), output = join(directory, 'result.json');
      const runtime = this.options.runtimeUrl ?? new URL('../ego-runtime.mjs', import.meta.url).href;
      const payload = JSON.stringify({ operation: request.operation, args: { ...request.args, screenshotFile: join(directory, 'page.png') } });
      await writeFile(input, `import { execute } from ${JSON.stringify(runtime)};\nimport { writeFile } from 'node:fs/promises';\nlet receipt;\ntry { receipt = await execute(${payload}); } catch { receipt = {error: 'Ego runtime failed.', code: 'EGO_RUNTIME_FAILED', uncertain: true}; }\nconst encoded = JSON.stringify(receipt);\nawait writeFile(${JSON.stringify(output)}, Buffer.byteLength(encoded) > ${MAX_RECEIPT_BYTES} ? JSON.stringify({error:'Ego receipt exceeds the size limit.',code:'EGO_RESPONSE_TOO_LARGE',uncertain:true}) : encoded, {mode:0o600,flag:'wx'});\n`, { mode: 0o600, flag: 'wx' });
      signal?.throwIfAborted();
      const timeoutMs = Math.max(100, Math.min(120000, this.options.timeoutMs()));
      let diagnostic = '', innerFailed = false;
      const exitCode = await new Promise<number | null>((done, fail) => {
        const child = spawn(file, ['nodejs', '-e', `await import(${JSON.stringify(pathToFileURL(input).href)})`], { shell: false, env: minimalEnvironment(file), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let failure: { error: string; code: string; uncertain: boolean } | undefined;
        let killTimer: NodeJS.Timeout | undefined;
        let bytes = 0;
        const tails = { stdout: '', stderr: '' };
        const terminate = () => { child.kill(); killTimer ??= setTimeout(() => child.kill('SIGKILL'), 500); killTimer.unref(); };
        const abort = () => { failure = { error: 'Ego operation cancelled; browser effects may still finish.', code: 'EGO_COMMAND_CANCELLED', uncertain: launched }; terminate(); };
        const timer = setTimeout(() => { failure = { error: `Ego command exceeded ${timeoutMs} ms; browser effects may still finish.`, code: 'EGO_COMMAND_TIMEOUT', uncertain: launched }; terminate(); }, timeoutMs);
        child.once('spawn', () => { launched = true; });
        signal?.addEventListener('abort', abort, { once: true });
        const receive = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
          bytes += chunk.length;
          if (bytes > 128 * 1024) { failure = { error: 'Ego diagnostic output exceeds the size limit.', code: 'EGO_RESPONSE_TOO_LARGE', uncertain: launched }; terminate(); return; }
          const text = tails[stream] + chunk.toString('utf8');
          if (/ego's nodejs process exited with code\s+[1-9]\d*/.test(text)) innerFailed = true;
          for (const message of ['ego lite closed the connection because ego-browser is running as administrator', 'Failed to connect to ego_cli bootstrap']) if (text.toLowerCase().includes(message.toLowerCase())) diagnostic = message;
          tails[stream] = text.slice(-256);
        };
        child.stdout.on('data', chunk => receive(chunk, 'stdout')); child.stderr.on('data', chunk => receive(chunk, 'stderr'));
        child.once('error', error => { failure ??= { error: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Ego executable was not found.' : 'Could not start ego-browser.', code: 'EGO_CLI_NOT_FOUND', uncertain: launched }; });
        child.once('close', code => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); signal?.removeEventListener('abort', abort); if (failure) fail(failure); else done(code); });
        if (signal?.aborted) abort();
      });
      signal?.throwIfAborted();
      if (diagnostic) return normalizeFailure({ error: diagnostic, uncertain: false });
      if (innerFailed) return { error: 'The Ego Node runtime failed.', code: 'EGO_RUNTIME_FAILED', uncertain: launched };
      const receiptFile = await open(output, 'r');
      let receipt: unknown;
      try {
        const buffer = Buffer.alloc(MAX_RECEIPT_BYTES + 1);
        let length = 0;
        while (length < buffer.length) { const { bytesRead } = await receiptFile.read(buffer, length, buffer.length - length, null); if (!bytesRead) break; length += bytesRead; }
        if (length > MAX_RECEIPT_BYTES) return { error: 'Ego receipt exceeds the size limit.', code: 'EGO_RESPONSE_TOO_LARGE', uncertain: launched };
        receipt = JSON.parse(buffer.toString('utf8', 0, length));
      } finally { await receiptFile.close(); }
      signal?.throwIfAborted();
      if (!validReceipt(receipt) || receipt.source && operation !== 'read') return { error: 'Ego returned an invalid receipt.', code: 'EGO_INVALID_RECEIPT', uncertain: launched };
      if (receipt.error) return normalizeFailure(receipt);
      if (exitCode !== 0) return { error: 'Ego exited before the operation completed.', code: 'EGO_RUNTIME_FAILED', uncertain: launched };
      return receipt;
    } catch (error) {
      if (signal?.aborted) return { error: 'Ego operation cancelled; browser effects may still finish.', code: 'EGO_COMMAND_CANCELLED', uncertain: launched };
      if (error && typeof error === 'object' && typeof (error as BridgeReceipt).error === 'string') return normalizeFailure(error as BridgeReceipt);
      return { error: launched ? 'Could not read the Ego operation receipt.' : 'Could not prepare the Ego operation.', code: launched ? 'EGO_INVALID_RECEIPT' : 'EGO_INVALID_ARGUMENT', uncertain: launched };
    } finally { if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {}); }
  }
}

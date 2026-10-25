/** Adapted from cortico-world-ego (MIT, Copyright (c) 2026 筆離嘢); see LICENSE. */
import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { chmod, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CliBridge } from './bridge.ts';
import { HELPER_KIND, HELPER_PROTOCOL, HelperBridge, type HelperEndpoint } from './helper-bridge.ts';
import { isElevated } from './permissions.ts';
import { validateHelperRequest } from './request.ts';
import { MAX_RECEIPT_BYTES, MAX_REQUEST_BYTES, validReceipt, type BridgeReceipt, type EgoBridge } from './types.ts';

async function readBody(req: IncomingMessage): Promise<unknown> {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const part of req) {
    length += part.length;
    if (length > MAX_REQUEST_BYTES) throw new Error('Request exceeds the size limit.');
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
}
async function acquireLock(file: string, token: string): Promise<void> {
  try { await writeFile(file, JSON.stringify({ pid: process.pid, token }), { mode: 0o600, flag: 'wx' }); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const handle = await open(file, 'r');
  let pid: unknown;
  try {
    if ((await handle.stat()).size > 1024) throw new Error('Invalid helper lock.');
    pid = JSON.parse(await handle.readFile('utf8')).pid;
  } finally { await handle.close(); }
  if (!Number.isSafeInteger(pid) || Number(pid) < 1) throw new Error('Invalid helper lock.');
  try { process.kill(Number(pid), 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('EGO_HELPER_ALREADY_RUNNING');
    await unlink(file);
    await writeFile(file, JSON.stringify({ pid: process.pid, token }), { mode: 0o600, flag: 'wx' });
    return;
  }
  throw new Error('EGO_HELPER_ALREADY_RUNNING');
}
async function removeOwnedFile(file: string, token: string): Promise<void> {
  try { if (JSON.parse(await readFile(file, 'utf8')).token === token) await unlink(file); } catch { /* A newer helper may own the endpoint. */ }
}
export async function startHelper(options: { dir: string; cliFile?: string; bridge?: EgoBridge; checkElevated?: () => Promise<boolean> }): Promise<{ port: number; endpoint: HelperEndpoint; close: () => Promise<void> }> {
  if (await (options.checkElevated ?? isElevated)()) throw new Error('EGO_CLIENT_ELEVATED: Start the helper without administrator or root privileges.');
  const dir = resolve(options.dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  if (await new HelperBridge(dir, () => 45000).probe()) throw new Error('EGO_HELPER_ALREADY_RUNNING');
  const token = randomBytes(32).toString('hex');
  const lockFile = join(dir, '.helper.lock'), endpointFile = join(dir, 'endpoint.json');
  await acquireLock(lockFile, token);
  const bundled = basename(fileURLToPath(import.meta.url)) === 'ego-helper.mjs';
  const runtimeUrl = new URL(bundled ? '../src/ego-runtime.mjs' : '../ego-runtime.mjs', import.meta.url).href;
  let queue: Promise<void> = Promise.resolve(), port = 0, closing: Promise<void> | undefined;
  let spaceName: string | undefined, spaceId: number | undefined;
  const controllers = new Set<AbortController>();
  let closeServer = async () => {};
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json; charset=utf-8'); res.setHeader('cache-control', 'no-store');
    const reply = (status: number, value: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      let encoded: string;
      try { encoded = JSON.stringify(value); } catch { encoded = JSON.stringify({ error: 'Invalid helper receipt.', code: 'EGO_INVALID_RECEIPT', uncertain: true }); }
      if (Buffer.byteLength(encoded) > MAX_RECEIPT_BYTES) encoded = JSON.stringify({ error: 'Helper receipt exceeds the size limit.', code: 'EGO_RESPONSE_TOO_LARGE', uncertain: true });
      res.writeHead(status); res.end(encoded);
    };
    const auth = req.headers.authorization ?? '', wanted = `Bearer ${token}`;
    if (req.headers.origin !== undefined || req.headers.host !== `127.0.0.1:${port}`) return reply(403, { error: 'Local requests without Origin are required.', uncertain: false });
    if (Buffer.byteLength(auth) !== Buffer.byteLength(wanted) || !timingSafeEqual(Buffer.from(auth), Buffer.from(wanted))) return reply(401, { error: 'Unauthorized.', uncertain: false });
    if (req.url === '/health' && req.method === 'GET') return reply(200, { kind: HELPER_KIND, protocol: HELPER_PROTOCOL, elevated: false, pid: process.pid });
    if (req.url === '/shutdown' && req.method === 'POST') { reply(200, { value: null }); void closeServer(); return; }
    if (req.url !== '/run' || req.method !== 'POST') return reply(404, { error: 'Not found.', uncertain: false });
    if (closing) return reply(503, { error: 'Helper is stopping.', code: 'EGO_HELPER_UNAVAILABLE', uncertain: false });
    const controller = new AbortController(); controllers.add(controller);
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', abort); res.once('close', abort);
    try {
      if (!req.headers['content-type']?.startsWith('application/json')) return reply(415, { error: 'JSON is required.', code: 'EGO_INVALID_ARGUMENT', uncertain: false });
      const request = validateHelperRequest(await readBody(req));
      const run = queue.then(async (): Promise<BridgeReceipt> => {
        if (controller.signal.aborted) return { error: 'Ego operation cancelled before execution.', code: 'EGO_COMMAND_CANCELLED', uncertain: false };
        const identifiesSpace = request.operation === 'connect' || request.operation === 'control-status';
        if (spaceName === undefined && !identifiesSpace
          || spaceName !== undefined && request.args.spaceName !== spaceName
          || spaceId !== undefined && request.args.spaceId !== undefined && request.args.spaceId !== spaceId
          || !identifiesSpace && request.args.spaceId !== spaceId) {
          return { error: 'This helper belongs to one Dream Space. Connect its configured Space first.', code: 'EGO_HELPER_SPACE_MISMATCH', uncertain: false };
        }
        let receipt: BridgeReceipt;
        const bridge = options.bridge ?? new CliBridge({ cliFile: options.cliFile || 'ego-browser', dataDir: dir, runtimeUrl, timeoutMs: () => request.timeoutMs });
        try { receipt = await bridge.run(request.operation, request.args, controller.signal); }
        catch { return { error: 'The Ego operation failed.', code: 'EGO_RUNTIME_FAILED', uncertain: true }; }
        if (!validReceipt(receipt)) return { error: 'Invalid Ego receipt.', code: 'EGO_INVALID_RECEIPT', uncertain: true };
        if (receipt.source && request.operation !== 'read') return { error: 'Invalid Ego source receipt.', code: 'EGO_INVALID_RECEIPT', uncertain: true };
        if (!receipt.error && request.operation === 'control-status' && !['agent', 'user', 'inactive'].includes(receipt.value?.control)) {
          return { error: 'Invalid Ego control status.', code: 'EGO_INVALID_RECEIPT', uncertain: false };
        }
        if (!receipt.error && !receipt.uncertain && receipt.spaceId !== undefined) {
          if (request.args.spaceId !== undefined && request.args.spaceId !== receipt.spaceId) {
            return { error: 'The Ego receipt refers to another Space.', code: 'EGO_HELPER_SPACE_MISMATCH', uncertain: true };
          }
          if (request.operation === 'connect' || request.operation === 'control-status' && spaceId === undefined) { spaceName = String(request.args.spaceName); spaceId = receipt.spaceId; }
          else if (receipt.spaceId !== spaceId) return { error: 'The Ego receipt refers to another Space.', code: 'EGO_HELPER_SPACE_MISMATCH', uncertain: true };
        }
        return receipt;
      });
      queue = run.then(() => {}, () => {});
      reply(200, await run);
    } catch { reply(400, { error: 'Invalid browser operation or arguments.', code: 'EGO_INVALID_ARGUMENT', uncertain: false }); }
    finally { controllers.delete(controller); req.removeListener('aborted', abort); res.removeListener('close', abort); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  try {
    await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', () => { server.off('error', fail); done(); }); });
    port = (server.address() as { port: number }).port;
    const endpoint: HelperEndpoint = { kind: HELPER_KIND, protocol: HELPER_PROTOCOL, port, token, pid: process.pid };
    await unlink(endpointFile).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    await writeFile(endpointFile, JSON.stringify(endpoint), { mode: 0o600, flag: 'wx' });
    closeServer = () => closing ??= (async () => {
      for (const controller of controllers) controller.abort();
      server.closeIdleConnections();
      const force = setTimeout(() => server.closeAllConnections(), 1000); force.unref();
      await new Promise<void>(done => server.close(() => done())); clearTimeout(force);
      await queue;
      await removeOwnedFile(endpointFile, token); await removeOwnedFile(lockFile, token);
    })();
    return { port, endpoint, close: closeServer };
  } catch (error) {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    await removeOwnedFile(endpointFile, token); await removeOwnedFile(lockFile, token); throw error;
  }
}
async function main(): Promise<void> {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or later is required.');
  const args = process.argv.slice(2), values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!key || !['--dir', '--cli'].includes(key) || !value || Object.hasOwn(values, key)) throw new Error('Usage: node ego-helper.mjs --dir <helper directory> [--cli <ego-browser executable>]');
    values[key] = value;
  }
  if (!values['--dir']) throw new Error('A helper directory is required.');
  const helper = await startHelper({ dir: values['--dir'], cliFile: values['--cli'] });
  console.log(`Ego helper ready on 127.0.0.1:${helper.port}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void helper.close().then(() => process.exit(0)); });
}
function isEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (isEntryPoint()) {
  main().catch(error => { console.error((error as Error).message.startsWith('EGO_') ? (error as Error).message : 'Could not start Ego helper. Check its directory, executable and Node.js installation.'); process.exitCode = 1; });
}

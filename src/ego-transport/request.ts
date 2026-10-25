/** Request fields are shared by the direct transport and its authenticated local helper. */
import { MAX_REQUEST_BYTES } from './types.ts';

const fields: Record<string, readonly string[]> = {
  connect: [], 'control-status': [], tabs: [], handoff: [],
  open: ['url', 'maxChars'], navigate: ['page', 'url', 'maxChars'],
  read: ['page', 'fullPage', 'offset', 'maxChars'], click: ['page', 'selector', 'maxChars'],
  fill: ['page', 'selector', 'text', 'maxChars'], press: ['page', 'selector', 'key', 'maxChars'],
  scroll: ['page', 'deltaY', 'x', 'y', 'maxChars'], evaluate: ['page', 'expression', 'maxChars'],
  shot: ['page', 'restoreMinimized'], close: ['page'],
};
const required: Record<string, readonly string[]> = {
  open: ['url'], navigate: ['page', 'url'], read: ['page'], click: ['page', 'selector'],
  fill: ['page', 'selector', 'text'], press: ['page', 'selector', 'key'], scroll: ['page', 'deltaY'],
  evaluate: ['page', 'expression'], shot: ['page'], close: ['page'],
};
const stringLimits: Record<string, number> = { spaceName: 256, page: 32, url: 8192, selector: 4096, text: 20000, key: 256, expression: 100000 };
export function validateRequest(operation: unknown, value: unknown): { operation: string; args: Record<string, unknown> } {
  if (typeof operation !== 'string' || !Object.hasOwn(fields, operation) || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unsupported browser operation or arguments.');
  const args = value as Record<string, unknown>;
  const allowed = new Set(['spaceId', 'spaceName', ...fields[operation]!]);
  for (const [key, item] of Object.entries(args)) {
    if (!allowed.has(key)) throw new Error('Unsupported browser argument.');
    if (item === undefined) continue;
    if (Object.hasOwn(stringLimits, key)) {
      if (typeof item !== 'string' || item.length > stringLimits[key]! || item.includes('\0') || (key !== 'text' && !item.trim())) throw new Error('Invalid browser text argument.');
      if (key === 'spaceName' && /[\u0000-\u001f]/.test(item)) throw new Error('Invalid Space name.');
    } else if (key === 'fullPage' || key === 'restoreMinimized') {
      if (typeof item !== 'boolean') throw new Error('Invalid browser boolean argument.');
    } else if (typeof item !== 'number' || !Number.isFinite(item)) throw new Error('Invalid browser numeric argument.');
  }
  for (const key of required[operation] ?? []) if (args[key] === undefined) throw new Error('Missing browser argument.');
  if (args.page !== undefined && !/^p[1-9][0-9]*$/.test(String(args.page))) throw new Error('Invalid managed Page label.');
  if (args.spaceId !== undefined && (!Number.isSafeInteger(args.spaceId) || Number(args.spaceId) < 1)) throw new Error('Invalid Space id.');
  if (!args.spaceName || !['connect', 'control-status'].includes(operation) && args.spaceId === undefined) throw new Error('A dedicated Space identity is required.');
  if (args.maxChars !== undefined && (!Number.isInteger(args.maxChars) || Number(args.maxChars) < 1 || Number(args.maxChars) > 60000)) throw new Error('Invalid text limit.');
  if (args.offset !== undefined && (!Number.isInteger(args.offset) || Number(args.offset) < 0 || Number(args.offset) > 10000000)) throw new Error('Invalid text offset.');
  if (args.deltaY !== undefined && Math.abs(Number(args.deltaY)) > 100000) throw new Error('Invalid scroll distance.');
  for (const key of ['x', 'y']) if (args[key] !== undefined && (Number(args[key]) < 0 || Number(args[key]) > 10000)) throw new Error('Invalid scroll coordinate.');
  if (args.url !== undefined) {
    let url: URL;
    try { url = new URL(String(args.url)); } catch { throw new Error('Invalid browser URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP(S) URLs without credentials are supported.');
  }
  if (Buffer.byteLength(JSON.stringify({ operation, args }), 'utf8') > MAX_REQUEST_BYTES) throw new Error('Browser request exceeds the size limit.');
  return { operation, args: { ...args } };
}

export function validateHelperRequest(value: unknown): ReturnType<typeof validateRequest> & { timeoutMs: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['operation', 'args', 'timeoutMs'].includes(key))) throw new Error('Invalid helper request.');
  const request = value as { operation?: unknown; args?: unknown; timeoutMs?: unknown };
  if (typeof request.timeoutMs !== 'number' || !Number.isInteger(request.timeoutMs) || request.timeoutMs < 5000 || request.timeoutMs > 120000) throw new Error('The helper timeout must be between 5000 and 120000 ms.');
  const validated = { ...validateRequest(request.operation, request.args), timeoutMs: request.timeoutMs };
  if (Buffer.byteLength(JSON.stringify(validated), 'utf8') > MAX_REQUEST_BYTES) throw new Error('Helper request exceeds the size limit.');
  return validated;
}

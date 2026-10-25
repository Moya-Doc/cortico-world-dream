/** Public news collection through the configured API or fixed public search endpoints. */
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { WEB_SEARCH_ENGINES } from './web-search.ts';

export interface SearchOptions {
  backend: 'tavily' | 'ego' | 'browser';
  apiKey: string;
  timeoutMs: number;
  maxResults: number;
}

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  publishedAt?: string;
}

export interface SearchClient {
  search(query: string, signal: AbortSignal, requestOptions?: SearchOptions): Promise<SearchResult[]>;
  close(): Promise<void>;
}

const RESPONSE_BYTES = 512 * 1024;
const CONTENT_CHARS = 12_000;
const privateV4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) privateV4.addSubnet(address, prefix);
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const documentationV6 = new BlockList();
documentationV6.addSubnet('2001:db8::', 32, 'ipv6');

export class SearchError extends Error {}
function fail(message: string): never { throw new SearchError(message); }

function publicHost(host: string): boolean {
  return !isIP(host) && host.length <= 253
    && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]+$/i.test(host)
    && !/(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/i.test(host);
}

function publicUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { return fail('Search URL is invalid.'); }
  if (raw.length > 8192 || url.protocol !== 'https:' || url.username || url.password || url.port
    || !publicHost(url.hostname)) {
    return fail('Search URL must use a public HTTPS domain without credentials or a custom port.');
  }
  return url;
}

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) return !privateV4.check(address);
  return isIP(address) === 6 && globalV6.check(address, 'ipv6') && !documentationV6.check(address, 'ipv6');
}

async function resolvePublic(host: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const addresses = await abortable(lookup(host, { all: true, verbatim: true }), signal);
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
    fail('Search domain resolved to a non-public network address.');
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new SearchError('Search cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\u0000/g, '').trim().slice(0, max) : '';
}

function resultsOf(value: unknown, max: number): SearchResult[] {
  if (!Array.isArray(value)) fail('Search returned an invalid result list.');
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const title = cleanText(row.title, 300);
    const content = cleanText(row.content, CONTENT_CHARS);
    if (!title || !content || typeof row.url !== 'string') continue;
    let url: string;
    try { url = publicUrl(row.url).href; } catch { continue; }
    if (seen.has(url)) continue;
    const publishedAt = cleanText(row.publishedAt ?? row.published_date, 80);
    out.push({ title, url, content, ...(publishedAt ? { publishedAt } : {}) });
    seen.add(url);
    if (out.length === max) break;
  }
  return out;
}

async function readBody(response: Response, signal: AbortSignal): Promise<string> {
  if (Number(response.headers.get('content-length') ?? 0) > RESPONSE_BYTES) {
    await response.body?.cancel();
    fail('Search response exceeded the size limit.');
  }
  if (!response.body) fail('Search returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_BYTES) fail('Search response exceeded the size limit.');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function tavily(options: SearchOptions, query: string, signal: AbortSignal): Promise<SearchResult[]> {
  if (!options.apiKey || /\s/.test(options.apiKey) || options.apiKey.length > 1024) {
    fail('Configure a valid news API key.');
  }
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST', redirect: 'error', signal,
    headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, topic: 'news', time_range: 'd', search_depth: 'basic',
      max_results: options.maxResults, include_published_date: true,
      include_answer: false, include_raw_content: false, include_images: false }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    fail(`News API returned HTTP ${response.status}.`);
  }
  const data: unknown = JSON.parse(await readBody(response, signal));
  if (!data || typeof data !== 'object') fail('News API returned an invalid response.');
  return resultsOf((data as Record<string, unknown>).results, options.maxResults);
}

async function webSearch(options: SearchOptions, query: string, signal: AbortSignal): Promise<SearchResult[]> {
  const errors: string[] = [];
  const attemptMs = Math.min(12_000, options.timeoutMs / WEB_SEARCH_ENGINES.length);
  for (const engine of WEB_SEARCH_ENGINES) {
    signal.throwIfAborted();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptMs);
    const attempt = AbortSignal.any([signal, controller.signal]);
    try {
      const url = publicUrl(engine.url(query));
      await resolvePublic(url.hostname, attempt);
      attempt.throwIfAborted();
      const response = await fetch(url.href, {
        method: 'GET', redirect: 'error', credentials: 'omit', signal: attempt,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CorticoDream)',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', Accept: 'text/html,application/rss+xml,application/xml;q=0.9' },
      });
      if (!response.ok) {
        await response.body?.cancel();
        fail(`Search engine returned HTTP ${response.status}.`);
      }
      const result = resultsOf(engine.parse(await readBody(response, attempt)), options.maxResults);
      attempt.throwIfAborted();
      if (result.length) return result;
      errors.push(`${engine.name}: no public results with excerpts`);
    } catch (error) {
      signal.throwIfAborted();
      errors.push(`${engine.name}: ${controller.signal.aborted ? 'request timed out' : error instanceof SearchError ? error.message : 'request failed'}`);
    } finally {
      clearTimeout(timer);
    }
  }
  fail(`Web search found no usable news sources. ${errors.join('; ')}`);
}

/** close cancels this client's requests; a new client is required after closing. */
export function createSearchClient(options: () => SearchOptions): SearchClient {
  let closed = false;
  const active = new Map<AbortController, Promise<SearchResult[]>>();
  return {
    async search(query, callerSignal, requestOptions) {
      if (closed) fail('Search client is closed.');
      if (active.size) fail('A news search is already running.');
      const controller = new AbortController();
      const abort = () => controller.abort();
      callerSignal.addEventListener('abort', abort, { once: true });
      if (callerSignal.aborted) abort();
      let timeout: NodeJS.Timeout | undefined;
      let timedOut = false;
      const run = async (): Promise<SearchResult[]> => {
        try {
          const current = requestOptions ?? options();
          const config = { ...current };
          if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 120_000
            || !Number.isInteger(config.maxResults) || config.maxResults < 1 || config.maxResults > 20) {
            fail('Search timeout must be 100–120000 ms and maximum results must be 1–20.');
          }
          const text = query.trim();
          if (!text || text.length > 1000 || /[\u0000-\u001f]/.test(text)) fail('Search query must contain 1–1000 characters without control characters.');
          controller.signal.throwIfAborted();
          timeout = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutMs);
          let result: SearchResult[];
          if (config.backend === 'ego') fail('Use the interactive dream_ego browser tools for ego collection.');
          if (config.backend === 'tavily') result = await tavily(config, text, controller.signal);
          else result = await webSearch(config, text, controller.signal);
          controller.signal.throwIfAborted();
          return result;
        } catch (error) {
          if (controller.signal.aborted) fail(timedOut ? 'News search timed out.' : 'Search cancelled.');
          if (error instanceof SearchError) throw error;
          fail('News search failed. Check the selected service.');
        } finally {
          if (timeout) clearTimeout(timeout);
          callerSignal.removeEventListener('abort', abort);
          active.delete(controller);
        }
      };
      const promise = Promise.resolve().then(run);
      active.set(controller, promise);
      return promise;
    },
    async close() {
      closed = true;
      for (const controller of active.keys()) controller.abort();
      await Promise.allSettled([...active.values()]);
    },
  };
}

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSearchClient, type SearchClient, type SearchOptions } from '../src/search.ts';

const adapters = vi.hoisted(() => ({ address: '93.184.216.34', lookups: [] as string[] }));
vi.mock('node:dns/promises', () => ({
  lookup: async (host: string) => {
    adapters.lookups.push(host);
    return [{ address: adapters.address, family: adapters.address.includes(':') ? 6 : 4 }];
  },
}));

const defaults = (): SearchOptions => ({
  backend: 'tavily', apiKey: 'synthetic-secret', timeoutMs: 2000, maxResults: 3,
});
const clients: SearchClient[] = [];
const directories: string[] = [];
function client(overrides: Partial<SearchOptions> = {}) {
  const cfg = { ...defaults(), ...overrides };
  const search = createSearchClient(() => cfg);
  clients.push(search);
  return { search, cfg };
}
async function temporaryDirectory() {
  const dir = await mkdtemp(join(tmpdir(), 'cortico-dream-search-'));
  directories.push(dir);
  return dir;
}
const signal = () => new AbortController().signal;
const soResult = (title = 'Public observatory report', url = 'https://paper.example.org/story', content = 'A public report about an observatory.') =>
  `<h3 class="res-title"><a href="${url}">${title}</a></h3><p class="res-desc">${content}</p>`;
const sogouResult = '<h3><a href="https://paper.example.org/second">Public ocean report</a></h3><div class="text-layout">A public report about ocean research.</div>';
const rssResult = '<rss><channel><item><title>Public geology report</title><link>https://paper.example.org/third</link><description>A public report about geology.</description></item></channel></rss>';
const ddgResult = '<div><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fpaper.example.org%2Ffourth">Public energy report</a><a class="result__snippet">A public report about energy.</a></div>';

beforeEach(() => {
  adapters.address = '93.184.216.34';
  adapters.lookups.length = 0;
  vi.stubGlobal('fetch', async () => { throw new Error('Unexpected network request'); });
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((search) => search.close()));
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('news API', () => {
  it('returns bounded public news, deduplicates sources and ignores malformed entries', async () => {
    vi.stubGlobal('fetch', async (_input: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      if (body.topic !== 'news' || body.time_range !== 'd' || body.include_answer !== false) {
        return new Response('Unsupported search scope', { status: 400 });
      }
      return Response.json({ results: [
        { title: 'Local address', url: 'https://127.0.0.1/private', content: 'discard' },
        { title: 'Credential URL', url: 'https://user:pass@news.example.org/', content: 'discard' },
        { title: 'Headline', url: 'https://paper.example.org/one', content: 'x'.repeat(20_000), published_date: '2026-10-24' },
        { title: 'Duplicate', url: 'https://paper.example.org/one', content: 'discard' },
        { title: 'Another headline', url: 'https://paper.example.org/two', content: 'Second story' },
        { title: 'No URL', content: 'discard' },
      ] });
    });
    const { search } = client({ maxResults: 2 });
    const results = await search.search('today public science news', signal());
    expect(results.map((r) => r.title)).toEqual(['Headline', 'Another headline']);
    expect(results[0].content.length).toBeLessThan(20_000);
    expect(results[0].publishedAt).toBe('2026-10-24');
  });

  it('uses the supplied request options when live configuration selects another backend', async () => {
    const {search} = client({backend:'ego'});
    const requested: RequestInit[] = [];
    vi.stubGlobal('fetch',async (_url:string,init:RequestInit) => {
      requested.push(init);
      return Response.json({results:[{title:'Public headline',url:'https://news.example.org/story',content:'Public report.'}]});
    });
    const results = await search.search('public news',signal(),{...defaults(),apiKey:'request-specific-key',maxResults:1});
    expect(results.map(row=>row.title)).toEqual(['Public headline']);
    expect(new Headers(requested[0].headers).get('Authorization')).toBe('Bearer request-specific-key');
    expect(JSON.parse(requested[0].body as string).max_results).toBe(1);
  });

  it('rejects redirects without forwarding the key or including transport errors in the receipt', async () => {
    const contacted: string[] = [];
    vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
      contacted.push(input);
      if (init.redirect !== 'error') contacted.push('https://untrusted.example.org/collect');
      throw new Error(`redirect with Authorization ${new Headers(init.headers).get('Authorization')}`);
    });
    const { search, cfg } = client();
    const error = await search.search('public news', signal()).catch((cause: Error) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(cfg.apiKey);
    expect(contacted.some((url) => url.includes('untrusted'))).toBe(false);
  });

  it('does not expose a service error response body', async () => {
    vi.stubGlobal('fetch', async () => new Response('credentials and private diagnostics', { status: 403 }));
    await expect(client().search.search('public news', signal())).rejects.toThrow('HTTP 403');
  });

  it('rejects an oversized response before parsing it', async () => {
    vi.stubGlobal('fetch', async () => new Response('x'.repeat(600_000)));
    await expect(client().search.search('public news', signal())).rejects.toThrow('size limit');
  });

  it('close aborts an active request and rejects subsequent searches', async () => {
    let running = false;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    vi.stubGlobal('fetch', async (_input: string, init: RequestInit) => new Promise((_resolve, reject) => {
      running = true;
      init.signal!.addEventListener('abort', () => { running = false; reject(new Error('transport aborted')); }, { once: true });
      started();
    }));
    const { search } = client();
    const pending = search.search('public news', signal());
    const rejected = expect(pending).rejects.toThrow('cancelled');
    await ready;
    await search.close();
    await rejected;
    expect(running).toBe(false);
    await expect(search.search('public news', signal())).rejects.toThrow('closed');
  });

  it('timeout aborts the request and frees the client for another search', async () => {
    vi.stubGlobal('fetch', async (_input: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('expired')), { once: true });
    }));
    const { search } = client({ timeoutMs: 100 });
    await expect(search.search('public news', signal())).rejects.toThrow('timed out');
    vi.stubGlobal('fetch', async () => Response.json({ results: [] }));
    await expect(search.search('public news', signal())).resolves.toEqual([]);
  });

  it('an already cancelled call never starts a service request', async () => {
    const aborted = new AbortController();
    aborted.abort();
    await expect(client().search.search('public news', aborted.signal)).rejects.toThrow('cancelled');
  });
});

describe('public web search', () => {
  it('returns separate news excerpts and never opens the legacy browser or profile', async () => {
    const profile = await temporaryDirectory();
    await writeFile(join(profile, 'Cookies'), 'private fixture data');
    const requested: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      requested.push({ url, init });
      return new Response(soResult() + soResult('Public satellite report', 'https://paper.example.org/two', 'A satellite launched.'));
    });
    const legacyConfig = { backend: 'browser' as const, browserProfileDir: profile, browserExecutableFile: '/missing-browser',
      searchUrlTemplate: 'file:///private/file?q={query}', allowedDomains: ['127.0.0.1'] };
    const { search } = client(legacyConfig);
    const results = await search.search('news & science? q=other', signal());
    expect(results.map(row => row.url)).toEqual(['https://paper.example.org/story', 'https://paper.example.org/two']);
    expect(results.every(row => Boolean(row.content) && !row.publishedAt)).toBe(true);
    expect(new URL(requested[0]!.url).searchParams.get('q')).toBe('news & science? q=other');
    expect(new Headers(requested[0]!.init.headers).has('Authorization')).toBe(false);
    expect(new Headers(requested[0]!.init.headers).has('Cookie')).toBe(false);
    expect(requested[0]!.init.credentials).toBe('omit');
    expect(await readFile(join(profile, 'Cookies'), 'utf8')).toBe('private fixture data');
  });

  it('tries each engine once in order until a source returns public excerpts', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      const host = new URL(url).hostname; requested.push(host);
      if (host === 'www.so.com') return new Response('Blocked', { status: 403 });
      if (host === 'www.sogou.com') return new Response('<h3><a href="https://paper.example.org/empty">Only a title</a></h3>');
      if (host === 'www.bing.com') return new Response('<rss><channel></channel></rss>');
      return new Response(ddgResult);
    });
    const results = await client({ backend: 'browser' }).search.search('public science reports', signal());
    expect(requested).toEqual(['www.so.com', 'www.sogou.com', 'www.bing.com', 'html.duckduckgo.com']);
    expect(results).toEqual([{ title: 'Public energy report', url: 'https://paper.example.org/fourth', content: 'A public report about energy.' }]);
  });

  it.each([
    ['www.sogou.com', sogouResult, 'https://paper.example.org/second'],
    ['www.bing.com', rssResult, 'https://paper.example.org/third'],
  ])('stops after %s returns usable excerpts', async (host, body, expectedUrl) => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      const current = new URL(url).hostname; requested.push(current);
      return new Response(current === host ? body : 'No results');
    });
    const results = await client({ backend: 'browser' }).search.search('public research', signal());
    expect(results[0]!.url).toBe(expectedUrl);
    expect(requested.at(-1)).toBe(host);
    expect(new Set(requested).size).toBe(requested.length);
  });

  it('filters unsafe links and empty excerpts, normalizes fragments and respects the news limit', async () => {
    vi.stubGlobal('fetch', async () => new Response(
      soResult('Private address', 'https://127.0.0.1/private') +
      soResult('Private name', 'https://service.local/private') +
      soResult('Credentials', 'https://user:pass@paper.example.org/private') +
      soResult('Insecure address', 'http://paper.example.org/private') +
      soResult('Empty excerpt', 'https://paper.example.org/empty', ' ') +
      soResult('Public first report', 'https://paper.example.org/one#intro', 'a'.repeat(15_000)) +
      soResult('Same report', 'https://paper.example.org/one#later') +
      soResult('Public second report', 'https://paper.example.org/two') +
      soResult('Public third report', 'https://paper.example.org/three'),
    ));
    const result = await client({ backend: 'browser', maxResults: 2 }).search.search('public science', signal());
    expect(result.map(row => row.url)).toEqual(['https://paper.example.org/one', 'https://paper.example.org/two']);
    expect(result[0]!.content.length).toBeLessThan(15_000);
  });

  it.each(['127.0.0.1', '10.2.3.4', '192.168.1.2', '169.254.169.254', '::1', 'fc00::1', '::ffff:127.0.0.1'])('never requests an engine resolving to %s', async address => {
    adapters.address = address;
    let contacted = false;
    vi.stubGlobal('fetch', async () => { contacted = true; return new Response(soResult()); });
    await expect(client({ backend: 'browser' }).search.search('public news', signal())).rejects.toThrow('non-public');
    expect(contacted).toBe(false);
  });

  it('rejects engine redirects before contacting their destination and continues to the next engine', async () => {
    const contacted: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      contacted.push(url);
      if (new URL(url).hostname === 'www.so.com') {
        if (init.redirect !== 'error') contacted.push('https://127.0.0.1/private');
        return new Response('', { status: 302, headers: { location: 'https://127.0.0.1/private' } });
      }
      return new Response(sogouResult);
    });
    const result = await client({ backend: 'browser' }).search.search('public news', signal());
    expect(result[0]!.title).toBe('Public ocean report');
    expect(contacted.map(url => new URL(url).hostname)).toEqual(['www.so.com', 'www.sogou.com']);
  });

  it.each([true, false])('rejects an oversized response, with declared length %s, then tries the next engine', async declared => {
    vi.stubGlobal('fetch', async (url: string) => new URL(url).hostname === 'www.so.com'
      ? new Response('x'.repeat(600_000), declared ? { headers: { 'content-length': '600000' } } : {})
      : new Response(sogouResult));
    const result = await client({ backend: 'browser' }).search.search('public news', signal());
    expect(result[0]!.url).toBe('https://paper.example.org/second');
  });

  it('reports each failed engine without exposing transport diagnostics or accepting titles as news', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (new URL(url).hostname === 'www.so.com') throw new Error('private transport diagnostics');
      return new Response('<h3><a href="https://paper.example.org/title">Only a title</a></h3>');
    });
    const error = await client({ backend: 'browser' }).search.search('public news', signal()).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('360: request failed');
    expect((error as Error).message).toContain('DuckDuckGo: no public results with excerpts');
    expect((error as Error).message).not.toContain('private transport diagnostics');
  });

  it('moves to the next engine after the first attempt exhausts its share of the total deadline', async () => {
    const contacted: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const host = new URL(url).hostname; contacted.push(host);
      if (host !== 'www.so.com') return new Response(sogouResult);
      return new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('timed out')), { once: true }));
    });
    const result = await client({ backend: 'browser', timeoutMs: 1000 }).search.search('public news', signal());
    expect(result[0]!.url).toBe('https://paper.example.org/second');
    expect(contacted).toEqual(['www.so.com', 'www.sogou.com']);
  });

  it('keeps one total deadline across sequential engines and does not retry after it expires', async () => {
    const contacted: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      contacted.push(new URL(url).hostname);
      return new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('timed out')), { once: true }));
    });
    await expect(client({ backend: 'browser', timeoutMs: 100 }).search.search('public news', signal())).rejects.toThrow('timed out');
    expect(contacted.length).toBeGreaterThan(1);
    expect(contacted.length).toBeLessThanOrEqual(4);
    expect(new Set(contacted).size).toBe(contacted.length);
  });

  it('caller cancellation during an engine request prevents all later engine attempts', async () => {
    const contacted: string[] = [];
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      contacted.push(new URL(url).hostname);
      started();
      return new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    });
    const controller = new AbortController();
    const pending = client({ backend: 'browser' }).search.search('public news', controller.signal);
    const rejected = expect(pending).rejects.toThrow('cancelled');
    await ready; controller.abort(); await rejected;
    expect(contacted).toEqual(['www.so.com']);
  });

  it('an already cancelled search never resolves or requests any engine', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(client({ backend: 'browser' }).search.search('public news', controller.signal)).rejects.toThrow('cancelled');
    expect(adapters.lookups).toEqual([]);
  });

  it('cancels a stalled response body without trying another engine', async () => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const contacted: string[] = [];
    let cancelled = false;
    vi.stubGlobal('fetch', async (url: string) => {
      contacted.push(new URL(url).hostname);
      let sent = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode('<html>')); }
          else started();
        },
        cancel() { cancelled = true; },
      }));
    });
    const controller = new AbortController();
    const pending = client({ backend: 'browser' }).search.search('public news', controller.signal);
    const rejected = expect(pending).rejects.toThrow('cancelled');
    await ready; controller.abort(); await rejected;
    expect(contacted).toEqual(['www.so.com']);
    expect(cancelled).toBe(true);
  });
});

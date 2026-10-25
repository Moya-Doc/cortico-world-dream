/** Public search URLs and result parsing, adapted from cortico-world-netlingo/src/search.ts.
 * Source: https://github.com/danhuangpaii/cortico-world-netlingo/tree/38fea2eed308fc3a1f4865312d53a582b98279bf
 *
 * MIT License
 *
 * Copyright (c) 2026 cortico-world-netlingo contributors
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
interface SearchHit { title: string; content: string; url: string }
interface SearchEngine {
  name: string;
  url(query: string): string;
  parse(body: string): SearchHit[];
}

const MAX_CANDIDATES = 100;
const ENTITIES: Record<string, string> = {
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  middot: '·', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  copy: '©', reg: '®', times: '×', laquo: '«', raquo: '»',
};

function entities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (!body.startsWith('#')) return Object.hasOwn(ENTITIES, body.toLowerCase()) ? ENTITIES[body.toLowerCase()]! : whole;
    const hex = body[1]?.toLowerCase() === 'x';
    const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function plain(value: string): string {
  return entities(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(?:br|p|div|li|ul|ol|h[1-6]|tr|td|section|article)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function attribute(tag: string, name: string): string {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return entities(match?.[1] ?? match?.[2] ?? match?.[3] ?? '');
}

function absolute(href: string, base: string): string {
  if (!href.trim()) return '';
  try { const url = new URL(href, base); url.hash = ''; return url.href; } catch { return ''; }
}

function headings(html: string, base: string, snippet: RegExp): SearchHit[] {
  const matches = [...html.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3\s*>/gi)];
  const hits: SearchHit[] = [];
  for (let i = 0; i < matches.length && hits.length < MAX_CANDIDATES; i++) {
    const current = matches[i]!;
    const anchor = /<a\b[^>]*>([\s\S]*?)<\/a\s*>/i.exec(current[1]!);
    if (!anchor) continue;
    const title = plain(anchor[1]!);
    const url = absolute(attribute(anchor[0], 'href'), base);
    const block = html.slice(current.index! + current[0].length, matches[i + 1]?.index ?? html.length);
    const content = plain(snippet.exec(block)?.[1] ?? '');
    if (title && content && url) hits.push({ title, content, url });
  }
  return hits;
}

function rss(xml: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const tag = (item: string, name: string) => plain(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}\\s*>`, 'i').exec(item)?.[1] ?? '');
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi)) {
    const body = match[1]!;
    const title = tag(body, 'title'), content = tag(body, 'description');
    const url = absolute(tag(body, 'link'), 'https://www.bing.com');
    if (title && content && url) hits.push({ title, content, url });
    if (hits.length === MAX_CANDIDATES) break;
  }
  return hits;
}

function duckDuckGo(html: string): SearchHit[] {
  const anchors = [...html.matchAll(/<a\b[^>]*class\s*=\s*["'][^"']*\bresult__a\b[^"']*["'][^>]*>([\s\S]*?)<\/a\s*>/gi)];
  const hits: SearchHit[] = [];
  for (let i = 0; i < anchors.length && hits.length < MAX_CANDIDATES; i++) {
    const current = anchors[i]!;
    let url = absolute(attribute(current[0], 'href'), 'https://html.duckduckgo.com');
    if (url) {
      const parsed = new URL(url);
      if (['duckduckgo.com', 'html.duckduckgo.com'].includes(parsed.hostname) && parsed.pathname === '/l/') {
        url = absolute(parsed.searchParams.get('uddg') ?? '', 'https://html.duckduckgo.com');
      }
    }
    const block = html.slice(current.index! + current[0].length, anchors[i + 1]?.index ?? html.length);
    const title = plain(current[1]!);
    const content = plain(/<(?:a|div)\b[^>]*class\s*=\s*["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)\s*>/i.exec(block)?.[1] ?? '');
    if (title && content && url) hits.push({ title, content, url });
  }
  return hits;
}

export const WEB_SEARCH_ENGINES: readonly SearchEngine[] = [
  { name: '360', url: query => `https://www.so.com/s?q=${encodeURIComponent(query)}`,
    parse: html => headings(html, 'https://www.so.com', /<p\b[^>]*class\s*=\s*["'][^"']*\bres-desc\b[^"']*["'][^>]*>([\s\S]*?)<\/p\s*>/i) },
  { name: 'Sogou', url: query => `https://www.sogou.com/web?query=${encodeURIComponent(query)}`,
    parse: html => headings(html, 'https://www.sogou.com', /<div\b[^>]*class\s*=\s*["'][^"']*(?:text-layout|fz-mid|str-text-info)[^"']*["'][^>]*>([\s\S]*?)<\/div\s*>/i) },
  { name: 'Bing RSS', url: query => `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}&count=10`, parse: rss },
  { name: 'DuckDuckGo', url: query => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=cn-zh`, parse: duckDuckGo },
];

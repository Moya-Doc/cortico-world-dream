import { describe, expect, it } from 'vitest';
import { WEB_SEARCH_ENGINES } from '../src/web-search.ts';

describe('public search result parsing', () => {
  it('keeps each heading paired with its own excerpt when another heading is incomplete', () => {
    const html = '<h3><a href="/link?m=one">Only a heading</a></h3>' +
      '<h3><a data-href="https://paper.example.org/wrong" href="https://paper.example.org/two">Stars <strong>and</strong> planets</a></h3><p class="res-desc">A telescope &amp; its discoveries.</p>';
    expect(WEB_SEARCH_ENGINES[0]!.parse(html)).toEqual([
      { title: 'Stars and planets', url: 'https://paper.example.org/two', content: 'A telescope & its discoveries.' },
    ]);
  });

  it('expands search-engine redirect links and decodes quoted HTML without executing scripts', () => {
    const html = "<h3 class='vr-title'><a href='/link?url=one&amp;v=2'>Ocean &#x7814;&#31350;</a></h3>" +
      "<div class='str-text-info'>Ocean observations.<script>throw new Error('must not execute');</script></div>";
    expect(WEB_SEARCH_ENGINES[1]!.parse(html)).toEqual([
      { title: 'Ocean 研究', url: 'https://www.sogou.com/link?url=one&v=2', content: 'Ocean observations.' },
    ]);
  });

  it('reads RSS CDATA, entities and excerpts while skipping entries with no description', () => {
    const xml = '<rss><channel><item><title>Only a title</title><link>https://paper.example.org/empty</link></item>' +
      '<item><title><![CDATA[Stars &amp; planets]]></title><link>https://paper.example.org/space?a=1&amp;b=2</link>' +
      '<description><![CDATA[Public <b>observations</b> from a telescope.]]></description></item></channel></rss>';
    expect(WEB_SEARCH_ENGINES[2]!.parse(xml)).toEqual([
      { title: 'Stars & planets', url: 'https://paper.example.org/space?a=1&b=2', content: 'Public observations from a telescope.' },
    ]);
  });

  it('unwraps result redirects and never borrows an excerpt from the next result', () => {
    const html = '<a class="result__a" href="https://paper.example.org/empty">No excerpt</a>' +
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fpaper.example.org%2Fenergy%23intro&amp;v=1">Energy findings</a>' +
      '<a class="result__snippet">A public energy report.</a>';
    expect(WEB_SEARCH_ENGINES[3]!.parse(html)).toEqual([
      { title: 'Energy findings', url: 'https://paper.example.org/energy', content: 'A public energy report.' },
    ]);
  });
});

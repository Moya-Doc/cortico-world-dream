import type { BridgeReceipt, EgoBridge } from '../../src/ego-transport/index.ts';

interface Page { label: string; url: string; title: string; snapshot: string; openedBy: string }
export class BrowserFixture implements EgoBridge {
  requests: Array<{ operation: string; args: Record<string, unknown> }> = [];
  space?: { id: number; name: string };
  ownership = 'agent';
  pages = new Map<string, Page>();
  failure?: BridgeReceipt;
  pending?: { operation: string; entered: Promise<void>; started(): void; release(): void; released: Promise<void> };
  hold(operation: string) {
    let started!: () => void; let release!: () => void;
    this.pending = { operation, entered: new Promise(resolve => { started = resolve; }), released: new Promise(resolve => { release = resolve; }), started: () => started(), release: () => release() };
    return this.pending;
  }
  async run(operation: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<BridgeReceipt> {
    signal?.throwIfAborted();
    this.requests.push({ operation, args: structuredClone(args) });
    const pending = this.pending;
    if (pending?.operation === operation) {
      pending.started();
      await pending.released;
    }
    // A browser command may finish after cancellation; the controller must reject its late receipt.
    if (this.failure) return this.failure;
    if (operation === 'connect' && !args.spaceId) {
      this.space ??= { id: 42, name: String(args.spaceName) };
      this.pages.set('p1', { label: 'p1', url: 'about:blank', title: '', snapshot: '', openedBy: 'agent' });
    }
    if (!this.space || (args.spaceId && args.spaceId !== this.space.id)) return { error: 'Space missing.', code: 'EGO_TASK_SPACE_NOT_FOUND', uncertain: false };
    const spaceId = this.space.id;
    if (operation === 'resume') this.ownership = 'agent';
    if (operation === 'control-status') return { spaceId, value: { control: this.ownership, name: this.space.name } };
    if (this.ownership !== 'agent') return { spaceId, error: 'Operator controls this Space.', code: 'EGO_TASK_SPACE_USER_IN_CONTROL', uncertain: false };
    const inventory = () => [...this.pages.values()].map(page => ({ page: page.label, url: page.url, title: page.title, openedBy: page.openedBy, active: false }));
    if (operation === 'connect' || operation === 'resume') return { spaceId, value: { name: this.space.name, pages: inventory() } };
    if (operation === 'tabs') return { spaceId, value: inventory() };
    if (operation === 'handoff') { this.ownership = 'user'; return { spaceId, value: { handedOff: true } }; }
    if (operation === 'open') {
      const page = this.pages.get('p1')?.url === 'about:blank' ? this.pages.get('p1')! : { label: `p${this.pages.size + 1}`, url: '', title: '', snapshot: '', openedBy: 'agent' };
      page.url = String(args.url); page.title = 'Public fixture'; page.snapshot = 'A public news report. @1 Search';
      this.pages.set(page.label, page);
      return { spaceId, value: { page: page.label, url: page.url, title: page.title, snapshot: page.snapshot } };
    }
    const page = this.pages.get(String(args.page));
    if (!page) return { spaceId, error: 'Unknown page.' };
    if (operation === 'navigate') page.url = String(args.url);
    if (operation === 'fill') page.snapshot = `Public search: ${String(args.text)}`;
    if (operation === 'press' || operation === 'click') page.snapshot = 'Public search results. @2 News item';
    if (operation === 'close') {
      if (page.openedBy !== 'agent') return { spaceId, error: 'Cannot close a user-created page.' };
      this.pages.delete(page.label); return { spaceId, value: { closed: page.label } };
    }
    if (operation === 'evaluate') return { spaceId, value: { headline: 'A public headline' } };
    if (operation === 'shot') return { spaceId, value: { page: page.label, url: page.url, image: { mime: 'image/png', base64: Buffer.from('synthetic-image').toString('base64') } } };
    const offset = Number(args.offset ?? 0); const limit = Number(args.maxChars ?? 16000);
    const snippet = page.snapshot.slice(offset, offset + limit);
    return { spaceId, value: { page: page.label, url: page.url, title: page.title, snapshot: snippet, offset, end: offset + snippet.length,
      totalChars: page.snapshot.length, truncated: offset + snippet.length < page.snapshot.length, nextOffset: offset + snippet.length < page.snapshot.length ? offset + snippet.length : null },
      ...(operation === 'read' ? { source: { url: page.url, title: page.title, snippet } } : {}) };
  }
}

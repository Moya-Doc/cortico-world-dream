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
/** Executed by the installed ego-browser runtime; its browser helpers are globals. */
import { open } from 'node:fs/promises';
import { BlockList, isIP } from 'node:net';

const IMAGE_LIMIT = 8 * 1024 * 1024;
const privateV4 = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) privateV4.addSubnet(address, prefix);
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function errorCode(error) {
  for (let item = error, depth = 0; item && depth < 5; item = item.cause, depth++) if (item.error_code || item.code) return item.error_code || item.code;
  return String(error).match(/EGO_[A-Z_]+/)?.[0];
}
export function publicBrowserUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { fail('EGO_INVALID_ARGUMENTS', 'A public HTTP or HTTPS URL is required.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !host
    || /(?:^|\.)(localhost|local|internal|lan|home|test|invalid)$/i.test(host)
    || (isIP(host) === 4 && privateV4.check(host)) || (isIP(host) === 6 && !globalV6.check(host, 'ipv6'))
    || (!isIP(host) && !host.includes('.'))) fail('EGO_INVALID_ARGUMENTS', 'Only public HTTP or HTTPS pages without URL credentials may be opened.');
  return url.href;
}
function ownName(task, args) {
  if (task.name !== args.spaceName) fail('EGO_DREAM_SPACE_MISMATCH', 'The saved Space belongs to a different task.');
  if (task.ownership !== 'agent') fail(task.ownership === 'agentDelegatedToUser' ? 'EGO_TASK_SPACE_USER_IN_CONTROL' : 'EGO_TASK_SPACE_INACTIVE', 'The dream Space is not under agent control.');
}
async function existingSpace(args) {
  const spaces = await listTaskSpaces();
  const matches = spaces.filter(space => args.spaceId === undefined ? space.name === args.spaceName : space.id === args.spaceId);
  if (matches.length > 1) fail('EGO_DREAM_SPACE_MISMATCH', 'The dream Space identity is ambiguous.');
  const saved = matches[0];
  if (!saved) fail('EGO_TASK_SPACE_NOT_FOUND', 'The dream Space no longer exists.');
  if (saved.name !== args.spaceName) fail('EGO_DREAM_SPACE_MISMATCH', 'The saved Space belongs to a different task.');
  return saved;
}
function controlOf(space) {
  if (space.ownership === 'user') fail('EGO_TASK_SPACE_NAME_IN_USE', 'The named Space belongs to the user.');
  if (space.ownership === 'agentDelegatedToUser') return 'user';
  if (space.ownership === 'agent') return 'agent';
  return 'inactive';
}
async function inventory(task) {
  return (await task.tabs()).filter(tab => /^p[1-9][0-9]*$/.test(tab.label ?? ''))
    .map(({ label, url, title, active, openedBy }) => ({ page: label, url, title, active, openedBy }));
}
async function observation(page, args) {
  const url = publicBrowserUrl(await page.url());
  const title = String(await page.title()).slice(0, 1000);
  const raw = await page.snapshot({ scope: args.fullPage ? 'full_page' : 'only_within_viewport' });
  const snapshot = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const offset = Number.isInteger(args.offset) && args.offset >= 0 ? Math.min(args.offset, snapshot.length) : 0;
  const maxChars = Number.isInteger(args.maxChars) ? Math.max(1, Math.min(60000, args.maxChars)) : 16000;
  const selected = snapshot.slice(offset, offset + maxChars);
  const nextOffset = offset + selected.length < snapshot.length ? offset + selected.length : null;
  return { page: page.label, url, title, snapshot: selected, offset, end: offset + selected.length, totalChars: snapshot.length,
    truncated: offset > 0 || nextOffset !== null, nextOffset, untrusted: true };
}
async function capturePage(task, page, args) {
  let restoredWindow = false;
  if (args.restoreMinimized) {
    await page.info();
    const window = await task.cdp('Browser.getWindowForTarget', { targetId: page.targetId });
    if (window.bounds.windowState === 'minimized') {
      await task.cdp('Browser.setWindowBounds', { windowId: window.windowId, bounds: { windowState: 'normal' } });
      restoredWindow = true;
    }
  }
  await page.screenshot({ path: args.screenshotFile });
  const file = await open(args.screenshotFile, 'r');
  try {
    if ((await file.stat()).size > IMAGE_LIMIT) fail('EGO_IMAGE_TOO_LARGE', 'The screenshot exceeds the 8 MiB limit.');
    const buffer = Buffer.alloc(IMAGE_LIMIT + 1); let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > IMAGE_LIMIT) fail('EGO_IMAGE_TOO_LARGE', 'The screenshot exceeds the 8 MiB limit.');
    return { page: page.label, url: publicBrowserUrl(await page.url()), title: String(await page.title()).slice(0, 1000),
      image: { base64: buffer.subarray(0, length).toString('base64'), mime: 'image/png' }, restoredWindow, untrusted: true };
  } finally { await file.close(); }
}
export async function execute({ operation, args }) {
  let task;
  let identified;
  try {
    if (typeof args.spaceName !== 'string' || !args.spaceName.trim()) fail('EGO_INVALID_ARGUMENTS', 'A dedicated dream Space name is required.');
    if (operation === 'control-status') {
      identified = await existingSpace(args);
      const control = controlOf(identified);
      if (control !== 'agent') return { spaceId: identified.id, value: { control } };
      task = await taskSpace(identified.id); ownName(task, args);
      await task.waitForControl({ interval: 1, timeout: 1 });
      return { spaceId: task.spaceId, value: { control: 'agent' } };
    }
    if (operation === 'connect') {
      if (args.spaceId !== undefined) identified = await existingSpace(args);
      else {
        try { identified = await existingSpace(args); }
        catch (error) { if (errorCode(error) !== 'EGO_TASK_SPACE_NOT_FOUND') throw error; }
      }
      if (identified) {
        const control = controlOf(identified);
        if (control !== 'agent') return { spaceId: identified.id, value: { control } };
      }
      task = await taskSpace(identified?.id ?? args.spaceName);
    } else {
      if (!Number.isSafeInteger(args.spaceId) || args.spaceId < 1) fail('EGO_INVALID_ARGUMENTS', 'An existing dream Space is required.');
      task = await taskSpace(args.spaceId);
    }
    ownName(task, args);
    let value; let source;
    if (operation === 'connect') value = { name: task.name, pages: await inventory(task), control: 'agent' };
    else if (operation === 'tabs') value = { pages: await inventory(task), untrusted: true };
    else if (operation === 'handoff') { await task.handOff(); value = { handedOff: true }; }
    else if (operation === 'open') {
      const url = publicBrowserUrl(args.url);
      const blank = (await task.tabs()).find(tab => tab.label && tab.openedBy === 'agent' && /^(about:blank|chrome:\/\/newtab\/?)$/.test(tab.url));
      const page = blank ? task.page(blank.label) : await task.newPage();
      try { await page.goto(url, { timeout: 30000 }); value = await observation(page, args); }
      catch (error) {
        if (errorCode(error)?.startsWith('EGO_TASK_') || error.mayHaveLateEffects) throw error;
        return { spaceId: task.spaceId, error: `The managed page ${page.label} could not be opened.`, code: errorCode(error) ?? 'EGO_OPERATION_FAILED' };
      }
    } else {
      const entry = (await task.tabs()).find(tab => tab.label === args.page && /^p[1-9][0-9]*$/.test(tab.label));
      if (!entry) fail('EGO_PAGE_NOT_MANAGED', 'Use the tabs tool to find a managed page in this dream Space.');
      const page = task.page(args.page);
      if (!['navigate', 'close'].includes(operation)) publicBrowserUrl(await page.url());
      switch (operation) {
        case 'read': {
          value = await observation(page, args);
          source = { url: value.url, title: value.title, snippet: value.snapshot };
          break;
        }
        case 'navigate': await page.goto(publicBrowserUrl(args.url), { timeout: 30000 }); value = await observation(page, args); break;
        case 'click': value = { ...(await observationAfter(() => page.click(args.selector, { label: 'operate page element' }), page, args)), pages: await inventory(task) }; break;
        case 'fill': value = await observationAfter(() => page.fill(args.selector, args.text), page, args); break;
        case 'press': value = await observationAfter(() => page.press(args.selector, args.key), page, args); break;
        case 'scroll': await page.mouse.move(args.x ?? 500, args.y ?? 400); value = await observationAfter(() => page.mouse.wheel(0, args.deltaY, { label: 'scroll page content' }), page, args); break;
        case 'evaluate': {
          const result = (await page.evaluate(args.expression)) ?? null;
          const text = JSON.stringify(result);
          const maxChars = Math.max(1, Math.min(60000, args.maxChars ?? 16000));
          value = { page: page.label, url: await page.url(), result: text.length > maxChars
            ? { preview: text.slice(0, maxChars), totalChars: text.length, truncated: true } : result, untrusted: true };
          break;
        }
        case 'shot': value = await capturePage(task, page, args); break;
        case 'close':
          if (entry.openedBy !== 'agent') fail('EGO_PAGE_NOT_OWNED', 'Only pages opened by this dream browser may be closed.');
          await page.close(); value = { closed: args.page }; break;
        default: fail('EGO_INVALID_ARGUMENTS', 'This browser operation is not supported.');
      }
    }
    return { spaceId: task.spaceId, value: value ?? null, ...(source ? { source } : {}) };
  } catch (error) {
    const code = errorCode(error) ?? 'EGO_OPERATION_FAILED';
    // A successful identity lookup survives a control block without authorizing any browser action.
    if ((identified || task) && ['connect', 'control-status'].includes(operation) && code === 'EGO_TASK_SPACE_USER_IN_CONTROL') {
      return { spaceId: identified?.id ?? task.spaceId, value: { control: 'user' } };
    }
    const evaluation = code === 'EGO_PAGE_EVALUATION_TIMED_OUT' ? { page: args.page,
      timeoutMs: Number.isFinite(error.timeoutMs) ? error.timeoutMs : undefined,
      executionStopped: typeof error.executionStopped === 'boolean' ? error.executionStopped : undefined,
      pageResponsive: typeof error.pageResponsive === 'boolean' ? error.pageResponsive : undefined,
      mayHaveLateEffects: typeof error.mayHaveLateEffects === 'boolean' ? error.mayHaveLateEffects : undefined } : undefined;
    return { spaceId: task?.spaceId, error: 'The dream browser operation failed.', code,
      uncertain: !!evaluation || !!error.mayHaveLateEffects, ...(evaluation ? { evaluation } : {}) };
  }
}
async function observationAfter(action, page, args) { await action(); return observation(page, args); }

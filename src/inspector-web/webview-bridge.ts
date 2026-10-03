import { attach, type Browser } from 'webdriverio';
import { readFileSync, existsSync } from 'fs';
import { getActiveSessionFilePath } from '../appium/session.js';
import type { DomNodePayload } from './ws-protocol.js';

interface SessionFile {
  appiumUrl: string;
  sessionId: string;
  platform: string;
  ts: number;
}

export interface WebViewInfo {
  id: string;
  url: string;
  title: string;
}

const ZMA_FRAGMENTS = ['/appointmentbook', 'AppointmentCustomDataV2'];

let attachedBrowser: Browser | null = null;
let attachedSessionId: string | null = null;
let appiumBase: string = '';
let lastLoadedContextId: string | null = null; // cached from most recent loadWebViewDom
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
let inspectPollTimer: ReturnType<typeof setInterval> | null = null;

function startKeepalive(base: string): void {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(async () => {
    try { await fetch(`${base.replace(/\/session\/.*/, '')}/status`); } catch { /* ignore */ }
  }, 90_000);
}

async function getSession(): Promise<{ browser: Browser; base: string }> {
  const filePath = getActiveSessionFilePath();
  if (!existsSync(filePath)) {
    throw new Error('No live Appium session — connect the MCP first.');
  }
  const session: SessionFile = JSON.parse(readFileSync(filePath, 'utf8'));
  const base = `${session.appiumUrl}/session/${session.sessionId}`;

  // Validate session is alive before (re-)attaching — fast raw HTTP check
  const check = await fetch(`${session.appiumUrl}/session/${session.sessionId}`, { signal: AbortSignal.timeout(5000) })
    .then(r => r.json() as Promise<{ value: unknown }>)
    .catch(() => ({ value: { error: 'network' } }));
  const checkVal = (check.value as Record<string, unknown>);
  if (checkVal?.error) {
    // Session is dead — clear cache and give clear message
    attachedBrowser = null;
    attachedSessionId = null;
    throw new Error('Appium session has expired — reconnect the MCP (send "connect to ios ws://...") and try again.');
  }

  if (attachedBrowser && attachedSessionId === session.sessionId) {
    return { browser: attachedBrowser, base };
  }

  const url = new URL(session.appiumUrl);
  try {
    attachedBrowser = await attach({
      sessionId: session.sessionId,
      protocol: url.protocol.replace(':', '') as 'http' | 'https',
      hostname: url.hostname,
      port: parseInt(url.port) || 4723,
      path: '/',
    });
  } catch (err) {
    attachedBrowser = null;
    attachedSessionId = null;
    throw new Error(`Failed to attach to Appium session — reconnect the MCP. (${err instanceof Error ? err.message : String(err)})`);
  }
  attachedSessionId = session.sessionId;
  appiumBase = base;
  lastLoadedContextId = null; // reset on new session
  startKeepalive(base);
  return { browser: attachedBrowser, base };
}

// Raw HTTP helpers — bypass webdriverio's mobile-only guards for context switching
async function rawGet(base: string, path: string): Promise<unknown> {
  const r = await fetch(`${base}${path}`);
  const j = (await r.json()) as { value: unknown };
  return j.value;
}

async function rawPost(base: string, path: string, body: unknown): Promise<unknown> {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = (await r.json()) as { value: unknown };
  return j.value;
}

export async function listWebViews(): Promise<WebViewInfo[]> {
  const { browser, base } = await getSession();
  try {
    const result: unknown = await browser.executeScript('mobile: getContexts', []);
    if (Array.isArray(result)) {
      return result
        .filter((c: unknown) => {
          if (!c || typeof c !== 'object') return false;
          const ctx = c as Record<string, unknown>;
          const id = String(ctx.id ?? '');
          const url = String(ctx.url ?? '');
          return id.includes('WEBVIEW') && url !== 'about:blank';
        })
        .map((c: unknown) => {
          const ctx = c as Record<string, unknown>;
          return {
            id: String(ctx.id ?? ''),
            url: String(ctx.url ?? ''),
            title: String(ctx.title ?? ''),
          };
        });
    }
  } catch { /* fall through */ }

  // Fallback: raw contexts endpoint — guard against non-array response
  const plain = await rawGet(base, '/contexts');
  const arr = Array.isArray(plain) ? plain as string[] : [];
  return arr
    .filter(id => id !== 'NATIVE_APP')
    .map(id => ({ id, url: '', title: '' }));
}

async function resolveContextId(browser: Browser): Promise<string> {
  // Use cached context if available (avoids an extra mobile: getContexts round-trip)
  if (lastLoadedContextId) return lastLoadedContextId;
  const webviews = await listWebViews();
  if (webviews.length === 0) {
    throw new Error('No webview detected — open a web surface (e.g. tap Book) first.');
  }
  const preferred = webviews.find(w => ZMA_FRAGMENTS.some(f => w.url.includes(f)));
  return (preferred || webviews[0]).id;
}

// DOM walk: depth-first, sets data-idom for reference.
// domId is the DFS counter value — used to re-locate elements without relying on attributes.
const DOM_WALK_JS = `return (function() {
  var counter = 0;
  var ATTRS = ['placeholder','name','type','aria-label','href','role','data-testid','autocomplete'];
  function walk(el, depth) {
    if (!el || depth > 30) return null;
    var r = el.getBoundingClientRect();
    var node = { domId: counter++, tag: (el.tagName || 'unknown').toLowerCase() };
    if (el.id) node.id = el.id;
    var rawCls = typeof el.className === 'string' ? el.className : '';
    var cls = rawCls.split(/\s+/).filter(function(s) { return s.length > 0; });
    if (cls.length) node.classes = cls;
    var hasRect = r.width > 0 || r.height > 0;
    if (hasRect) node.rect = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    var attrs = {};
    for (var i = 0; i < ATTRS.length; i++) { var v = el.getAttribute(ATTRS[i]); if (v) attrs[ATTRS[i]] = v; }
    if (Object.keys(attrs).length) node.attrs = attrs;
    var kids = Array.from(el.children || []);
    if (kids.length) {
      var ch = [];
      for (var k = 0; k < Math.min(kids.length, 100); k++) {
        var c = walk(kids[k], depth + 1);
        if (c) ch.push(c);
      }
      if (ch.length) node.children = ch;
    } else {
      var t = (el.textContent || '').trim().slice(0, 80);
      if (t) node.text = t;
    }
    return node;
  }
  return walk(document.body || document.documentElement, 0);
})();`;

// Highlight by re-walking the DOM with the same DFS order as the snapshot.
// Uses a bold overlay div so it's visible even on small or edge-positioned elements.
const HIGHLIGHT_JS = (domId: number) => `return (function(targetId) {
  var counter = 0;
  function findEl(el, depth) {
    if (!el || depth > 30) return null;
    if (counter++ === targetId) return el;
    var kids = Array.from(el.children || []);
    for (var k = 0; k < Math.min(kids.length, 100); k++) {
      var found = findEl(kids[k], depth + 1);
      if (found) return found;
    }
    return null;
  }
  var el = findEl(document.body || document.documentElement, 0);
  if (!el) return { found: false, tag: null, id: null };
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  var r = el.getBoundingClientRect();
  var ov = document.createElement('div');
  ov.id = '__inspector_ov__';
  ov.style.cssText = 'position:fixed;z-index:99999;pointer-events:none;'
    + 'top:' + r.top + 'px;left:' + r.left + 'px;'
    + 'width:' + r.width + 'px;height:' + r.height + 'px;'
    + 'outline:3px solid #89b4fa;outline-offset:-2px;'
    + 'background:rgba(137,180,250,0.15);'
    + 'box-sizing:border-box;';
  var old = document.getElementById('__inspector_ov__');
  if (old) old.remove();
  document.body.appendChild(ov);
  setTimeout(function() { ov.remove(); }, 2500);
  return { found: true, tag: el.tagName.toLowerCase(), id: el.id || null, rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } };
})(${domId});`;

export async function loadWebViewDom(contextId?: string): Promise<{
  root: DomNodePayload;
  totalNodes: number;
  url: string;
  contextId: string;
}> {
  const { browser, base } = await getSession();
  // Resolve target context
  let targetId = contextId;
  if (!targetId) {
    const webviews = await listWebViews();
    if (webviews.length === 0) throw new Error('No webview detected — open a web surface (e.g. tap Book) first.');
    const preferred = webviews.find(w => ZMA_FRAGMENTS.some(f => w.url.includes(f)));
    targetId = (preferred || webviews[0]).id;
  }

  await rawPost(base, '/context', { name: targetId });
  try {
    const root = (await browser.execute(DOM_WALK_JS)) as DomNodePayload;
    let count = 0;
    const countNodes = (n: DomNodePayload): void => { count++; (n.children || []).forEach(countNodes); };
    countNodes(root);
    const url = String(await rawGet(base, '/url'));
    lastLoadedContextId = targetId; // cache for highlight/verify
    return { root, totalNodes: count, url, contextId: targetId };
  } finally {
    try { await rawPost(base, '/context', { name: 'NATIVE_APP' }); } catch { /* best-effort */ }
  }
}

export async function highlightWebViewNode(domId: number): Promise<{ found: boolean; tag?: string | null; id?: string | null; rect?: { x: number; y: number; w: number; h: number } }> {
  const { browser, base } = await getSession();
  const targetId = await resolveContextId(browser);
  await rawPost(base, '/context', { name: targetId });
  try {
    const r = await browser.execute(HIGHLIGHT_JS(domId));
    return (r as { found: boolean; tag?: string | null; id?: string | null; rect?: { x: number; y: number; w: number; h: number } });
  } finally {
    try { await rawPost(base, '/context', { name: 'NATIVE_APP' }); } catch { /* best-effort */ }
  }
}

export async function verifyWebSelector(
  by: 'css' | 'xpath',
  value: string,
): Promise<{ matchCount: number; unique: boolean }> {
  const { browser, base } = await getSession();
  const targetId = await resolveContextId(browser);
  await rawPost(base, '/context', { name: targetId });
  try {
    let matchCount: number;
    if (by === 'css') {
      matchCount = (await browser.execute(
        `return document.querySelectorAll(${JSON.stringify(value)}).length`,
      )) as number;
    } else {
      matchCount = (await browser.execute(
        `return document.evaluate(${JSON.stringify(value)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength`,
      )) as number;
    }
    return { matchCount, unique: matchCount === 1 };
  } finally {
    try { await rawPost(base, '/context', { name: 'NATIVE_APP' }); } catch { /* best-effort */ }
  }
}

// JS injected into webview to capture next tap. Uses capture:true so it fires
// before app handlers. Computes DFS domId using same ordering as DOM_WALK_JS.
const INSPECT_INJECT_JS = `
window.__inspectorHit = null;
document.body.style.cursor = 'crosshair';
document.addEventListener('click', function __inspector_pick__(e) {
  e.preventDefault(); e.stopPropagation();
  document.body.style.cursor = '';
  var target = e.target;
  var counter = 0, domId = -1;
  function findId(el, depth) {
    if (!el || depth > 30) return;
    var myId = counter++;
    if (el === target) { domId = myId; return; }
    var kids = Array.from(el.children || []);
    for (var k = 0; k < Math.min(kids.length, 100); k++) {
      if (domId >= 0) return;
      findId(kids[k], depth + 1);
    }
  }
  findId(document.body || document.documentElement, 0);
  var r = target.getBoundingClientRect();
  window.__inspectorHit = {
    domId: domId,
    tag: target.tagName.toLowerCase(),
    id: target.id || null,
    cls: (typeof target.className === 'string' ? target.className.trim().split(/\\s+/).filter(Boolean) : []).slice(0, 3),
    rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
  };
  document.removeEventListener('click', __inspector_pick__, true);
}, true);
return true;`;

const INSPECT_CANCEL_JS = `
window.__inspectorHit = null;
document.body.style.cursor = '';
document.removeEventListener('click', window.__inspector_pick__ || function(){}, true);
return true;`;

const INSPECT_POLL_JS = `return window.__inspectorHit || null;`;

export type InspectHitCallback = (
  domId: number,
  fresh: { root: DomNodePayload; totalNodes: number; url: string; contextId: string },
  tag: string | null,
  id: string | null,
  cls: string[],
  rect: { x: number; y: number; w: number; h: number },
) => void;

export async function startWebInspect(onHit: InspectHitCallback): Promise<void> {
  stopWebInspect();
  const { browser, base } = await getSession();
  const targetId = await resolveContextId(browser);

  // Inject the pick listener
  await rawPost(base, '/context', { name: targetId });
  try {
    await browser.execute(INSPECT_INJECT_JS);
  } finally {
    await rawPost(base, '/context', { name: 'NATIVE_APP' }).catch(() => {});
  }

  // Poll every 400ms for up to 60s
  let ticks = 0;
  inspectPollTimer = setInterval(async () => {
    ticks++;
    if (ticks > 150) { stopWebInspect(); return; } // 60s timeout
    try {
      await rawPost(base, '/context', { name: targetId });
      const hit = await browser.execute(INSPECT_POLL_JS);
      await rawPost(base, '/context', { name: 'NATIVE_APP' }).catch(() => {});
      if (hit && typeof hit === 'object') {
        stopWebInspect();
        const h = hit as { domId: number; tag: string; id: string | null; cls: string[]; rect: { x: number; y: number; w: number; h: number } };
        // Reload DOM so snapshot is in sync with the tapped element's domId
        const fresh = await loadWebViewDom(targetId);
        onHit(h.domId, fresh, h.tag, h.id, h.cls, h.rect);
      }
    } catch { /* ignore transient poll errors */ }
  }, 400);
}

export function stopWebInspect(): void {
  if (inspectPollTimer) { clearInterval(inspectPollTimer); inspectPollTimer = null; }
  // Best-effort cancel in page (async, fire-and-forget)
  getSession().then(async ({ browser, base }) => {
    const targetId = lastLoadedContextId;
    if (!targetId) return;
    await rawPost(base, '/context', { name: targetId }).catch(() => {});
    await browser.execute(INSPECT_CANCEL_JS).catch(() => {});
    await rawPost(base, '/context', { name: 'NATIVE_APP' }).catch(() => {});
  }).catch(() => {});
}

import { getBrowser, getBrowserWithReconnect } from '../appium/session.js';
import { logger } from '../util/logger.js';

export type AppContext = 'FLUTTER' | 'NATIVE_APP' | string; // WEBVIEW_xxx

export interface ContextInfo {
  current: string;
  available: string[];
}

// Cache current context to avoid repeated Appium calls (~50-100ms each)
let cachedContext: string | null = null;
// Track the last WebView context we actively used (for multi-webview apps)
let lastActiveWebView: string | null = null;

// --- getContexts() TTL cache (saves 100-500ms per interaction cycle) ---
let cachedContextsList: string[] | null = null;
let contextsCacheTime: number = 0;
const CONTEXTS_CACHE_TTL_MS = 5000; // 5s TTL

/** Invalidate the context cache (call after any context switch) */
export function invalidateContextCache(): void {
  cachedContext = null;
}

/** Invalidate the getContexts() cache (call when contexts may have changed, e.g. navigation) */
export function invalidateContextsListCache(): void {
  cachedContextsList = null;
  contextsCacheTime = 0;
}

/**
 * Get all available contexts (cached with 5s TTL).
 * Handles both string[] and {id: string}[] responses from FlutterIntegration driver.
 */
export async function getContexts(): Promise<string[]> {
  // Return cached if still fresh
  if (cachedContextsList && (Date.now() - contextsCacheTime) < CONTEXTS_CACHE_TTL_MS) {
    return cachedContextsList;
  }

  const browser = getBrowser();
  const raw: unknown = await browser.getContexts();

  let result: string[];
  if (!Array.isArray(raw)) {
    result = ['NATIVE_APP'];
  } else {
    result = raw.map((ctx: unknown) => {
      if (typeof ctx === 'string') return ctx;
      if (ctx && typeof ctx === 'object' && 'id' in ctx) return String((ctx as { id: unknown }).id);
      return String(ctx);
    });
  }

  cachedContextsList = result;
  contextsCacheTime = Date.now();
  return result;
}

export async function getCurrentContext(): Promise<string> {
  if (cachedContext) return cachedContext;
  const browser = getBrowser();
  const ctx = await browser.getContext();
  cachedContext = typeof ctx === 'string' ? ctx : 'NATIVE_APP';
  return cachedContext;
}

export async function getContextInfo(): Promise<ContextInfo> {
  const [current, available] = await Promise.all([getCurrentContext(), getContexts()]);
  return { current, available };
}

export async function switchToNative(): Promise<string> {
  const browser = getBrowser();
  await browser.switchContext('NATIVE_APP');
  cachedContext = 'NATIVE_APP';
  logger.info('Switched to NATIVE_APP context');
  return 'NATIVE_APP';
}

export async function switchToFlutter(): Promise<string> {
  const browser = getBrowser();
  // Flutter is typically the default context or FLUTTER
  const contexts = await getContexts();
  const flutterCtx = contexts.find(c => c === 'FLUTTER') || contexts.find(c => !c.startsWith('WEBVIEW') && c !== 'NATIVE_APP');
  if (flutterCtx) {
    await browser.switchContext(flutterCtx);
    cachedContext = flutterCtx;
    logger.info('Switched to Flutter context', { context: flutterCtx });
    return flutterCtx;
  }
  // Default — switch to NATIVE_APP (Flutter commands work in default context with FlutterIntegration driver)
  await browser.switchContext('NATIVE_APP');
  cachedContext = 'NATIVE_APP';
  logger.info('No explicit FLUTTER context found, switched to NATIVE_APP (Flutter commands still work)');
  return 'NATIVE_APP';
}

/**
 * Find a WEBVIEW context ID by URL using full context metadata from 'mobile: getContexts'.
 * Does NOT switch contexts — reads URL/title metadata directly.
 *
 * @param urlFragment substring to match in the webview URL (e.g. "/appointmentbook")
 * @param excludeIds optional set of webview IDs to ignore (used to skip stale "about:blank" preloaded contexts when waiting for a NEW webview to appear)
 * @returns the context ID, or null if not found
 */
export async function findWebViewContextByUrl(urlFragment: string, excludeIds?: ReadonlySet<string>): Promise<string | null> {
  try {
    const browser = getBrowser();
    const result: unknown = await browser.executeScript('mobile: getContexts', []);

    if (!Array.isArray(result)) return null;

    for (const item of result) {
      if (item && typeof item === 'object') {
        const ctx = item as Record<string, unknown>;
        const id = ctx.id != null ? String(ctx.id) : null;
        const url = ctx.url != null ? String(ctx.url) : '';
        const title = ctx.title != null ? String(ctx.title) : '';

        if (id && id.includes('WEBVIEW')) {
          logger.debug('Context metadata', { id, title, url: url.length > 80 ? url.substring(0, 80) + '...' : url });

          if (excludeIds && excludeIds.has(id)) continue;
          if (url.includes(urlFragment)) {
            return id;
          }
        }
      }
    }
  } catch (e) {
    logger.warn('fullContextList lookup failed, will use fallback', { error: String(e) });
  }
  return null;
}

/**
 * Snapshot the IDs of all currently-known WEBVIEW contexts. Use before triggering
 * the action that should spawn a new webview, then pass the snapshot as `excludeIds`
 * to `findWebViewContextByUrl` / `waitForNewWebViewByUrl` so stale preloaded
 * contexts (e.g. about:blank) are not picked up by mistake.
 */
export async function snapshotWebViewIds(): Promise<Set<string>> {
  try {
    const contexts = await getContexts();
    return new Set(contexts.filter(c => c.startsWith('WEBVIEW')));
  } catch (e) {
    logger.debug('snapshotWebViewIds: getContexts failed', { error: String(e) });
    return new Set();
  }
}

/**
 * Poll for a webview whose URL matches `urlFragment` and whose context ID is NOT
 * present in `excludeIds`. Useful for hybrid forms where multiple webviews coexist
 * and an old "about:blank" preloaded context is still around.
 *
 * Does NOT switch — returns the matched ID. Caller decides when to switch.
 */
export async function waitForNewWebViewByUrl(args: {
  urlFragment: string;
  excludeIds?: ReadonlySet<string>;
  timeoutSeconds?: number;
  pollIntervalMs?: number;
}): Promise<string> {
  const timeout = (args.timeoutSeconds ?? 30) * 1000;
  const interval = args.pollIntervalMs ?? 1000;
  const deadline = Date.now() + timeout;
  const exclude = args.excludeIds ?? new Set<string>();

  while (Date.now() < deadline) {
    invalidateContextsListCache();
    const id = await findWebViewContextByUrl(args.urlFragment, exclude);
    if (id) {
      logger.info('Found new WebView matching URL', { id, urlFragment: args.urlFragment, excluded: exclude.size });
      return id;
    }
    await sleep(interval);
  }
  throw new Error(`No NEW WebView with URL containing '${args.urlFragment}' appeared within ${args.timeoutSeconds ?? 30}s (excluded ${exclude.size} pre-existing contexts).`);
}

/**
 * Once switched into a WebView, poll a small JS predicate until it returns truthy
 * (or a JSON-safe primitive truthy value). Used after switching to a form webview
 * to wait for actual content to render.
 *
 * Default predicate: `document.readyState === 'complete' && document.body && document.body.children.length > 0`.
 * Pass `predicateJs` like `"document.querySelectorAll('input').length > 0"` for forms.
 */
export async function waitForWebViewContentReady(args?: {
  predicateJs?: string;
  timeoutSeconds?: number;
  pollIntervalMs?: number;
}): Promise<void> {
  const timeout = (args?.timeoutSeconds ?? 30) * 1000;
  const interval = args?.pollIntervalMs ?? 500;
  const deadline = Date.now() + timeout;
  const predicate = args?.predicateJs
    ?? `document.readyState === 'complete' && document.body && document.body.children.length > 0`;
  // Wrap in a function so a bare expression is also valid — webview-inspector adds `return` automatically.
  const script = `return (${predicate})`;

  let lastError: string | undefined;
  const browser = getBrowser();
  while (Date.now() < deadline) {
    try {
      const result: unknown = await browser.execute(script);
      if (result) {
        logger.info('WebView content ready', { predicate });
        return;
      }
    } catch (e) {
      lastError = String(e);
    }
    await sleep(interval);
  }
  throw new Error(`WebView content predicate did not become truthy within ${args?.timeoutSeconds ?? 30}s. Predicate: ${predicate}${lastError ? ` (last error: ${lastError})` : ''}`);
}

/**
 * Switch to a specific WEBVIEW context whose URL contains the given fragment.
 * Uses mobile: getContexts metadata to find the right context WITHOUT switching to wrong ones.
 *
 * @param urlFragment substring to match against the webview URL (e.g. "/appointmentbook")
 * @param waitTimeout seconds to wait for the webview to appear
 * @returns the matched context name
 */
export async function switchToWebViewByUrl(urlFragment: string, waitTimeout: number = 30): Promise<string> {
  const deadline = Date.now() + waitTimeout * 1000;

  while (Date.now() < deadline) {
    const matchedContext = await findWebViewContextByUrl(urlFragment);

    if (matchedContext) {
      const browser = getBrowser();
      await browser.switchContext(matchedContext);
      cachedContext = matchedContext;
      lastActiveWebView = matchedContext;
      logger.info('Switched to WebView by URL', { context: matchedContext, urlFragment });
      return matchedContext;
    }

    await sleep(1000);
  }

  throw new Error(`No WEBVIEW context found with URL containing '${urlFragment}' after ${waitTimeout}s. Ensure the webview is loaded.`);
}

/**
 * Switch to a WebView context.
 * @param waitTimeout - seconds to wait for a WebView to appear
 * @param webviewId - specific WebView context ID (e.g. "WEBVIEW_2335.13"). If omitted, uses the last active WebView or the first available.
 */
export async function switchToWebView(waitTimeout: number = 10, webviewId?: string): Promise<string> {
  const deadline = Date.now() + waitTimeout * 1000;

  while (Date.now() < deadline) {
    // Force fresh fetch when actively waiting for a WebView to appear
    invalidateContextsListCache();
    const contexts = await getContexts();
    const webviews = contexts.filter(c => c.startsWith('WEBVIEW'));

    if (webviews.length > 0) {
      // Build ordered list of webviews to try
      let targets: string[];
      if (webviewId) {
        // Exact match first, then fall back to others
        const exact = webviews.find(w => w === webviewId);
        targets = exact ? [exact, ...webviews.filter(w => w !== exact)] : [...webviews];
      } else if (lastActiveWebView && webviews.includes(lastActiveWebView)) {
        targets = [lastActiveWebView, ...webviews.filter(w => w !== lastActiveWebView)];
      } else {
        // Try newest (last) first, then others
        targets = [...webviews].reverse();
      }

      // Try each webview context — some may crash the session on iOS with FlutterIntegration
      for (const target of targets) {
        try {
          const browser = getBrowser();
          await browser.switchContext(target);
          cachedContext = target;
          lastActiveWebView = target;
          logger.info('Switched to WebView context', { context: target, available: webviews });
          return target;
        } catch (err) {
          logger.warn('Failed to switch to WebView context, trying next', { target, error: String(err) });
          // Session may have crashed — try to recover
          try {
            const browser = await getBrowserWithReconnect();
            // Verify session is alive
            await browser.getContext();
          } catch {
            logger.warn('Session crashed during WebView switch — reconnecting');
            try {
              await getBrowserWithReconnect();
            } catch {
              // Will retry in outer loop or throw at deadline
            }
          }
        }
      }
    }
    await sleep(1000);
  }

  throw new Error(`No WebView context found after ${waitTimeout}s. Available: ${(await getContexts()).join(', ')}`);
}

/**
 * Get all available WebView contexts.
 */
export async function getWebViewContexts(): Promise<string[]> {
  const contexts = await getContexts();
  return contexts.filter(c => c.startsWith('WEBVIEW'));
}

/**
 * Try an operation across all available WebView contexts until one succeeds.
 * Returns the result and the webview context that worked.
 */
export async function tryAcrossWebViews<T>(
  operation: () => Promise<T>,
  excludeWebView?: string,
): Promise<{ result: T; webviewContext: string } | null> {
  const webviews = await getWebViewContexts();
  const browser = getBrowser();

  for (const wv of webviews) {
    if (wv === excludeWebView) continue;
    try {
      await browser.switchContext(wv);
      cachedContext = wv;
      const result = await operation();
      lastActiveWebView = wv;
      logger.info('Operation succeeded in WebView', { context: wv });
      return { result, webviewContext: wv };
    } catch {
      // Try next webview
    }
  }
  return null;
}

/**
 * Switch to any context by its exact ID (e.g., "NATIVE_APP", "WEBVIEW_2335.12", "FLUTTER").
 * Used by the element registry for precise context routing.
 */
export async function switchToContextById(contextId: string): Promise<string> {
  const browser = getBrowser();
  const contexts = await getContexts();

  if (!contexts.includes(contextId)) {
    throw new Error(`Context ${contextId} not available. Available: ${contexts.join(', ')}`);
  }

  await browser.switchContext(contextId);
  cachedContext = contextId;

  if (contextId.startsWith('WEBVIEW')) {
    lastActiveWebView = contextId;
  }

  logger.info('Switched to context by ID', { contextId });
  return contextId;
}

export async function switchContext(to: 'flutter' | 'webview' | 'native', waitTimeout?: number, webviewId?: string, urlFragment?: string): Promise<ContextInfo> {
  switch (to) {
    case 'flutter':
      await switchToFlutter();
      break;
    case 'webview':
      if (urlFragment) {
        await switchToWebViewByUrl(urlFragment, waitTimeout || 30);
      } else {
        await switchToWebView(waitTimeout || 10, webviewId);
      }
      break;
    case 'native':
      await switchToNative();
      break;
  }
  return getContextInfo();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Classify an xpath target as native, webview, or ambiguous based on patterns */
export function classifyXpath(target: string): 'native' | 'webview' | 'ambiguous' {
  // iOS native element types
  if (/XCUIElementType/i.test(target)) return 'native';
  // Android native element types
  if (/android\.(widget|view|webkit)\./i.test(target)) return 'native';

  // HTML/DOM tag patterns → webview
  const htmlTags = /\/\/(input|div|button|a|span|form|select|textarea|iframe|label|img|table|tr|td|th|ul|ol|li|h[1-6]|p|nav|header|footer|section|article|main)(\[|\/|$)/i;
  if (htmlTags.test(target)) return 'webview';
  // Common HTML attribute patterns
  if (/\[@(id|class|name|type|href|src|placeholder|data-)/.test(target)) return 'webview';

  return 'ambiguous';
}

/**
 * Ensure the correct Appium context is active for the given locator strategy.
 * Switches context only when necessary to minimize overhead.
 */
export async function ensureContextForLocator(by: string, target: string): Promise<void> {
  const flutterStrategies = ['key', 'text', 'type', 'semanticsLabel'];

  if (flutterStrategies.includes(by)) {
    // Flutter locators work from NATIVE_APP and FLUTTER contexts,
    // but NOT from WEBVIEW — only switch if currently in webview
    const current = await getCurrentContext();
    if (current.startsWith('WEBVIEW')) {
      await switchToFlutter();
      logger.info('Auto-switched from WebView to Flutter for locator', { by });
    }
    return;
  }

  if (by === 'accessibilityId') {
    const current = await getCurrentContext();
    if (current !== 'NATIVE_APP') {
      await switchToNative();
      logger.info('Auto-switched to Native for accessibilityId locator');
    }
    return;
  }

  if (by === 'css') {
    const current = await getCurrentContext();
    if (!current.startsWith('WEBVIEW')) {
      // Fast-fail: check if any WebView contexts exist before waiting
      const contexts = await getContexts();
      const hasWebView = contexts.some(c => c.startsWith('WEBVIEW'));
      if (!hasWebView) {
        throw new Error('No WebView context available — CSS selectors require a WebView. Use xpath or accessibilityId for native elements.');
      }
      await switchToWebView(5);
      logger.info('Auto-switched to WebView for CSS locator');
    }
    return;
  }

  if (by === 'xpath') {
    const classification = classifyXpath(target);
    const current = await getCurrentContext();

    if (classification === 'native' && current !== 'NATIVE_APP') {
      await switchToNative();
      logger.info('Auto-switched to Native for xpath (detected native pattern)', { target });
    } else if (classification === 'webview' && !current.startsWith('WEBVIEW')) {
      // Fast-fail: check if WebView contexts exist before waiting
      const contexts = await getContexts();
      const hasWebView = contexts.some(c => c.startsWith('WEBVIEW'));
      if (hasWebView) {
        await switchToWebView(5);
        logger.info('Auto-switched to WebView for xpath (detected HTML pattern)', { target });
      } else {
        logger.info('XPath looks like HTML but no WebView exists, staying in native', { target });
      }
    }
    // 'ambiguous' — stay in current context, fallback will handle if needed
  }
}

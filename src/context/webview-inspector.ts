import { getBrowser } from '../appium/session.js';
import { getCurrentContext, switchToWebView, switchToNative, getWebViewMetadata } from './context-manager.js';
import { logger } from '../util/logger.js';

export async function getPageSource(): Promise<string> {
  const browser = getBrowser();
  const ctx = await getCurrentContext();
  const wasWebView = ctx.startsWith('WEBVIEW');

  if (!wasWebView) {
    await switchToWebView(10);
  }

  try {
    const source = await browser.getPageSource();
    return source;
  } finally {
    if (!wasWebView) {
      // Restore original context only if we switched
      await switchToNative().catch(() => {});
    }
  }
}

/**
 * Execute JavaScript in a WebView context.
 * Auto-wraps scripts that don't contain 'return' with a return statement.
 * If the current webview fails, retries ONLY across webviews with a real page
 * loaded (about:blank preloads are skipped — running the script there returns
 * misleading empty results), and reports which context actually executed it.
 */
export async function executeJavaScript(script: string): Promise<{ result: unknown; context: string }> {
  const browser = getBrowser();
  const ctx = await getCurrentContext();
  const wasWebView = ctx.startsWith('WEBVIEW');

  if (!wasWebView) {
    await switchToWebView(10);
  }

  // Auto-wrap scripts that don't have a return statement
  const wrappedScript = autoWrapReturn(script);

  try {
    const result = await browser.execute(wrappedScript);
    return { result, context: await getCurrentContext() };
  } catch (firstError) {
    // If we're in a webview and it failed, try other REAL-page webviews
    const metas = await getWebViewMetadata();
    const currentWv = await getCurrentContext();
    const candidates = metas
      .filter(m => m.id !== currentWv && m.url && m.url !== 'about:blank')
      .map(m => m.id);

    for (const wv of candidates) {
      try {
        await browser.switchContext(wv);
        const result = await browser.execute(wrappedScript);
        logger.info('JS executed successfully in alternate WebView', { context: wv });
        return { result, context: wv };
      } catch {
        // Try next
      }
    }

    // All webviews failed — restore and throw
    if (!wasWebView) {
      await switchToNative().catch(() => {});
    }
    throw firstError;
  }
}

export async function getCurrentUrl(): Promise<string> {
  const browser = getBrowser();
  const ctx = await getCurrentContext();
  const wasWebView = ctx.startsWith('WEBVIEW');

  if (!wasWebView) {
    await switchToWebView(10);
  }

  try {
    return await browser.getUrl();
  } finally {
    if (!wasWebView) {
      await switchToNative().catch(() => {});
    }
  }
}

/**
 * Auto-wrap a JavaScript snippet with `return` if it doesn't already have one.
 * WebDriver's execute() requires a return statement for the value to be captured.
 */
function autoWrapReturn(script: string): string {
  const trimmed = script.trim();

  // Already has return — leave as-is
  if (/\breturn\b/.test(trimmed)) {
    return trimmed;
  }

  // Multi-statement: last statement might be an expression to return
  // If it ends with a semicolon-terminated expression, wrap the last expression
  const statements = trimmed.split(';').map(s => s.trim()).filter(Boolean);
  if (statements.length > 1) {
    const last = statements.pop()!;
    return statements.join('; ') + '; return ' + last + ';';
  }

  // Single expression — wrap with return
  return 'return ' + trimmed.replace(/;$/, '') + ';';
}

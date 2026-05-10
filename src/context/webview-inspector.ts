import { getBrowser } from '../appium/session.js';
import { getCurrentContext, switchToWebView, switchToNative, getWebViewContexts } from './context-manager.js';
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
 * If multiple WebViews exist and the script fails in one, tries the others.
 */
export async function executeJavaScript(script: string): Promise<unknown> {
  const browser = getBrowser();
  const ctx = await getCurrentContext();
  const wasWebView = ctx.startsWith('WEBVIEW');
  const originalContext = ctx;

  if (!wasWebView) {
    await switchToWebView(10);
  }

  // Auto-wrap scripts that don't have a return statement
  const wrappedScript = autoWrapReturn(script);

  try {
    const result = await browser.execute(wrappedScript);
    return result;
  } catch (firstError) {
    // If we're in a webview and it failed, try other webviews
    const webviews = await getWebViewContexts();
    const currentWv = await getCurrentContext();

    for (const wv of webviews) {
      if (wv === currentWv) continue;
      try {
        await browser.switchContext(wv);
        const result = await browser.execute(wrappedScript);
        logger.info('JS executed successfully in alternate WebView', { context: wv });
        return result;
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

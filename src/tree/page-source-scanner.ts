/**
 * Page-Source-First Scanner — extracts interactive elements from a single
 * getPageSource() call instead of 100+ individual findElements calls.
 *
 * Performance: 1 Appium call (~200ms) + local XML parsing + 5-20 targeted
 * Flutter locator lookups = 0.3-2s total vs 5-15s for the type-scan approach.
 */

import { getBrowser } from '../appium/session.js';
import { logger } from '../util/logger.js';
import { INTERACTIVE_WIDGET_TYPES, type InteractiveElement } from './types.js';
import { getRegistry } from '../context/element-registry.js';
import { getContexts, getCurrentContext, getWebViewContexts, switchToContextById } from '../context/context-manager.js';

// Set of interactive types for O(1) lookup
const INTERACTIVE_SET = new Set(INTERACTIVE_WIDGET_TYPES);

// --- Page source scan cache (avoids redundant re-scans within short window) ---
let cachedScanResult: InteractiveElement[] | null = null;
let scanCacheTime: number = 0;
const SCAN_CACHE_TTL_MS = 2000; // 2s TTL — auto-scan after action reuses recent scan

/** Invalidate the page source scan cache (call on navigation or context switch) */
export function invalidateScanCache(): void {
  cachedScanResult = null;
  scanCacheTime = 0;
}

/**
 * Native iOS type → probable Flutter widget type mapping.
 * Used to classify elements extracted from getPageSource() XML.
 */
const IOS_TYPE_MAP: Record<string, string> = {
  'Button': 'TextButton',
  'TextField': 'TextField',
  'SecureTextField': 'TextField',
  'StaticText': 'Text',
  'Image': 'Icon',
  'Switch': 'Switch',
  'Slider': 'Slider',
  'Picker': 'DropdownButton',
  'SearchField': 'SearchBar',
  'TextArea': 'TextField',
  'CheckBox': 'Checkbox',
  'RadioButton': 'Radio',
  'Link': 'TextButton',
  'Tab': 'Tab',
  'TabBar': 'TabBar',
  'NavigationBar': 'NavigationBar',
  'Cell': 'ListTile',
  'DisclosureTriangle': 'ExpansionTile',
};

/**
 * Android type → probable Flutter widget type mapping.
 */
const ANDROID_TYPE_MAP: Record<string, string> = {
  'Button': 'TextButton',
  'EditText': 'TextField',
  'TextView': 'Text',
  'ImageView': 'Icon',
  'ImageButton': 'IconButton',
  'Switch': 'Switch',
  'CheckBox': 'Checkbox',
  'RadioButton': 'Radio',
  'Spinner': 'DropdownButton',
  'SeekBar': 'Slider',
  'SearchView': 'SearchBar',
  'TabWidget': 'TabBar',
};

/** Types that are always interactive regardless of Flutter mapping */
const ALWAYS_INTERACTIVE = new Set([
  'Button', 'TextField', 'SecureTextField', 'Switch', 'Slider',
  'CheckBox', 'RadioButton', 'SearchField', 'Link', 'Tab',
  'EditText', 'ImageButton', 'Spinner', 'SeekBar',
]);

/** Types to skip entirely (containers, system elements) */
const SKIP_TYPES = new Set([
  'Application', 'Window', 'Other', 'Group', 'ScrollView',
  'Table', 'Toolbar', 'Header', 'Footer',
  'StatusBar', 'NavigationBar', // iOS system bars
]);

/** Types that represent WebView containers — extract bounds but don't treat as interactive */
const WEBVIEW_TYPES = new Set(['WebView']);

interface ParsedElement {
  nativeType: string;
  flutterType: string;
  text?: string;
  label?: string;
  enabled: boolean;
  visible: boolean;
  rect?: { x: number; y: number; width: number; height: number };
  interactive: boolean;
}

/**
 * Scan for interactive widgets using getPageSource() — the fast path.
 * Returns InteractiveElement[] compatible with the existing scanner interface.
 * Results are cached for 2s to avoid redundant re-scans (e.g. auto-scan after action).
 */
export async function pageSourceScan(forceRefresh?: boolean): Promise<InteractiveElement[]> {
  // Return cached result if still fresh
  if (!forceRefresh && cachedScanResult && (Date.now() - scanCacheTime) < SCAN_CACHE_TTL_MS) {
    logger.debug('Page source scan: returning cached result', { age: Date.now() - scanCacheTime, elements: cachedScanResult.length });
    return cachedScanResult;
  }

  const browser = getBrowser();
  const startTime = Date.now();

  try {
    // Single Appium call to get the entire page tree
    const source = await browser.getPageSource();
    const parseTime = Date.now();

    // Extract WebView bounds and register them in the context registry
    await extractAndRegisterWebViewBounds(source);

    // Parse XML locally
    const parsed = parsePageSourceXml(source);
    const interactive = parsed.filter(el => el.interactive && el.visible);

    logger.info('Page source scan: parsed elements', {
      total: parsed.length,
      interactive: interactive.length,
      parseMs: Date.now() - parseTime,
    });

    // Convert to InteractiveElement[] with locator enrichment
    const elements = await enrichWithFlutterLocators(browser, interactive);

    // Register all found elements in the context registry
    const currentCtx = await getCurrentContext();
    const registry = getRegistry();
    for (const el of elements) {
      registry.registerElement(currentCtx, el.locator.by, el.locator.value);
    }

    const totalMs = Date.now() - startTime;
    logger.info(`Page source scan complete: ${elements.length} elements in ${totalMs}ms`);

    // Cache the result for short-lived reuse (e.g. auto-scan after action)
    cachedScanResult = elements;
    scanCacheTime = Date.now();

    return elements;
  } catch (error) {
    logger.warn('Page source scan failed, will fall back to type scan', { error: String(error) });
    return [];
  }
}

/**
 * Extract WebView container bounds from native page source XML and register
 * them in the element registry as context regions. This enables coordinate-to-context
 * mapping for tap operations.
 *
 * WebView elements in native XML appear as:
 *   iOS: <XCUIElementTypeWebView x="0" y="88" width="1180" height="732" ... />
 *   Android: <android.webkit.WebView bounds="[0,88][1080,2280]" ... />
 *
 * They correlate 1:1 by order with WEBVIEW_xxx contexts from getContexts().
 */
async function extractAndRegisterWebViewBounds(xml: string): Promise<void> {
  const registry = getRegistry();

  try {
    // Find all WebView elements with bounds
    const webViewBounds: Array<{ x: number; y: number; width: number; height: number }> = [];

    // iOS pattern: XCUIElementTypeWebView with x/y/width/height attributes
    const iosPattern = /<XCUIElementTypeWebView\s+([^>]*?)(?:\/>|>)/g;
    let match: RegExpExecArray | null;
    while ((match = iosPattern.exec(xml)) !== null) {
      const attrs = match[1];
      const x = getAttr(attrs, 'x');
      const y = getAttr(attrs, 'y');
      const w = getAttr(attrs, 'width');
      const h = getAttr(attrs, 'height');
      if (x && y && w && h) {
        webViewBounds.push({ x: Number(x), y: Number(y), width: Number(w), height: Number(h) });
      }
    }

    // Android pattern: android.webkit.WebView with bounds attribute
    const androidPattern = /<android\.webkit\.WebView\s+([^>]*?)(?:\/>|>)/g;
    while ((match = androidPattern.exec(xml)) !== null) {
      const attrs = match[1];
      const bounds = getAttr(attrs, 'bounds');
      if (bounds) {
        const boundsMatch = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
        if (boundsMatch) {
          const [, x1, y1, x2, y2] = boundsMatch.map(Number);
          webViewBounds.push({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
        }
      }
    }

    if (webViewBounds.length === 0) return;

    // Get available WebView contexts and correlate by order
    const allContexts = await getContexts();
    const webviewContexts = allContexts.filter(c => c.startsWith('WEBVIEW'));

    // Update known contexts in registry
    registry.setKnownContexts(allContexts);

    // Register Flutter/native region (full screen, behind WebViews)
    registry.registerRegion('NATIVE_APP', 'native');

    // Correlate WebView bounds with context IDs (1:1 by order)
    for (let i = 0; i < Math.min(webViewBounds.length, webviewContexts.length); i++) {
      registry.registerRegion(webviewContexts[i], 'webview', webViewBounds[i]);
      logger.info('Registered WebView bounds', {
        contextId: webviewContexts[i],
        bounds: webViewBounds[i],
      });
    }
  } catch (error) {
    logger.debug('WebView bounds extraction failed (non-critical)', { error: String(error) });
  }
}

/**
 * Parse native XML page source into structured elements.
 * Handles both iOS (XCUIElementType*) and Android (android.widget.*) formats.
 */
function parsePageSourceXml(xml: string): ParsedElement[] {
  const elements: ParsedElement[] = [];
  const isAndroid = xml.includes('android.widget.') || xml.includes('android.view.');

  // Match self-closing tags: <XCUIElementTypeButton ... />
  const selfClosingPattern = /<(\w[\w.]*)\s+([^>]*?)\/>/g;
  let match: RegExpExecArray | null;

  while ((match = selfClosingPattern.exec(xml)) !== null) {
    const el = parseElement(match[1], match[2], isAndroid);
    if (el) elements.push(el);
  }

  // Match open+close tags: <Type attrs>content</Type>
  const openClosePattern = /<(\w[\w.]*)\s+([^>]*?)>([^<]*)<\/\1>/g;
  while ((match = openClosePattern.exec(xml)) !== null) {
    const el = parseElement(match[1], match[2], isAndroid, match[3].trim());
    if (el) elements.push(el);
  }

  return elements;
}

function parseElement(
  tagName: string,
  attrs: string,
  isAndroid: boolean,
  content?: string,
): ParsedElement | null {
  // Simplify type name
  let nativeType = tagName;
  if (nativeType.startsWith('XCUIElementType')) {
    nativeType = nativeType.replace('XCUIElementType', '');
  } else if (nativeType.startsWith('android.widget.')) {
    nativeType = nativeType.replace('android.widget.', '');
  } else if (nativeType.startsWith('android.view.')) {
    nativeType = nativeType.replace('android.view.', '');
  }

  // Skip system/container elements (WebView bounds are extracted separately)
  if (SKIP_TYPES.has(nativeType) || WEBVIEW_TYPES.has(nativeType)) return null;

  // Check visibility
  const visible = getAttr(attrs, 'visible') || getAttr(attrs, 'isVisible');
  if (visible === 'false' || visible === '0') return null;

  // Extract text content
  const text = content || getAttr(attrs, 'text') || getAttr(attrs, 'value') || getAttr(attrs, 'label') || undefined;
  const label = getAttr(attrs, 'name') || getAttr(attrs, 'resource-id') || getAttr(attrs, 'accessibility-id') || undefined;

  // Only include elements with some identifying info or known interactive type
  const hasIdentifier = text || label || ALWAYS_INTERACTIVE.has(nativeType);
  if (!hasIdentifier) return null;

  // Check enabled
  const enabled = getAttr(attrs, 'enabled') !== 'false' && getAttr(attrs, 'isEnabled') !== '0';

  // Parse bounds/rect
  let rect: ParsedElement['rect'] | undefined;
  const bounds = getAttr(attrs, 'bounds');
  if (bounds) {
    const boundsMatch = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (boundsMatch) {
      const [, x1, y1, x2, y2] = boundsMatch.map(Number);
      rect = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    }
  }
  const x = getAttr(attrs, 'x');
  const y = getAttr(attrs, 'y');
  const w = getAttr(attrs, 'width');
  const h = getAttr(attrs, 'height');
  if (x && y && w && h) {
    rect = { x: Number(x), y: Number(y), width: Number(w), height: Number(h) };
  }

  // Map native type to Flutter type
  const typeMap = isAndroid ? ANDROID_TYPE_MAP : IOS_TYPE_MAP;
  const flutterType = typeMap[nativeType] || nativeType;

  // Determine interactivity
  const interactive = ALWAYS_INTERACTIVE.has(nativeType)
    || INTERACTIVE_SET.has(flutterType)
    || INTERACTIVE_SET.has(nativeType);

  return {
    nativeType,
    flutterType,
    text,
    label,
    enabled,
    visible: true,
    rect,
    interactive,
  };
}

/**
 * Enrich parsed elements with Flutter-specific locators.
 * Batch-resolves ValueKeys and semanticsLabels for interactive elements.
 */
async function enrichWithFlutterLocators(
  browser: WebdriverIO.Browser,
  elements: ParsedElement[],
): Promise<InteractiveElement[]> {
  const results: InteractiveElement[] = [];
  const batchSize = 5;

  for (let i = 0; i < elements.length; i += batchSize) {
    const batch = elements.slice(i, i + batchSize);
    const resolved = await Promise.allSettled(
      batch.map((el, j) => resolveLocator(browser, el, i + j)),
    );

    for (const result of resolved) {
      if (result.status === 'fulfilled' && result.value) {
        results.push(result.value);
      }
    }
  }

  return results;
}

async function resolveLocator(
  browser: WebdriverIO.Browser,
  el: ParsedElement,
  globalIndex: number,
): Promise<InteractiveElement | null> {
  // Try to find the element via Flutter finders to get a proper locator
  // Priority: text → semanticsLabel → type

  // 1. Try finding by text (if text exists)
  if (el.text && el.text.trim()) {
    try {
      const found = await browser.findElements('-flutter text', el.text.trim());
      if (found.length > 0) {
        return buildInteractiveElement(el, globalIndex, { by: 'text', value: el.text.trim() });
      }
    } catch { /* not found via Flutter text */ }
  }

  // 2. Try semantics label
  if (el.label && el.label.trim()) {
    try {
      const found = await browser.findElements('-flutter semantics label', el.label.trim());
      if (found.length > 0) {
        return buildInteractiveElement(el, globalIndex, { by: 'semanticsLabel', value: el.label.trim() });
      }
    } catch { /* not found via semantics */ }
  }

  // 3. Try type (use the Flutter type mapping)
  if (INTERACTIVE_SET.has(el.flutterType)) {
    try {
      const found = await browser.findElements('-flutter type', el.flutterType);
      if (found.length > 0) {
        return buildInteractiveElement(el, globalIndex, { by: 'type', value: el.flutterType });
      }
    } catch { /* not found via type */ }
  }

  // 4. Fallback: return with native type as locator (coordinate-based tap will work)
  const locator = el.text
    ? { by: 'text', value: el.text }
    : el.label
      ? { by: 'semanticsLabel', value: el.label }
      : { by: 'type', value: el.flutterType };

  return buildInteractiveElement(el, globalIndex, locator);
}

function buildInteractiveElement(
  el: ParsedElement,
  index: number,
  locator: { by: string; value: string },
): InteractiveElement {
  return {
    index,
    type: el.flutterType,
    text: el.text,
    enabled: el.enabled,
    displayed: el.visible,
    position: el.rect ? {
      x: String(el.rect.x) as unknown as number,
      y: String(el.rect.y) as unknown as number,
      width: String(el.rect.width) as unknown as number,
      height: String(el.rect.height) as unknown as number,
    } : undefined,
    locator,
  };
}

function getAttr(attrs: string, name: string): string | null {
  const pattern = new RegExp(`${name}="([^"]*?)"`);
  const match = attrs.match(pattern);
  return match ? match[1] : null;
}

// ── WebView Interactive Element Scanning ─────────────────────────

/** HTML tag → Flutter-like type mapping for consistent element typing */
const HTML_TYPE_MAP: Record<string, string> = {
  button: 'TextButton',
  a: 'TextButton',
  input: 'TextField',
  select: 'DropdownButton',
  textarea: 'TextField',
  label: 'Text',
};

/** HTML input types that are interactive */
const INTERACTIVE_INPUT_TYPES = new Set([
  'text', 'password', 'email', 'tel', 'number', 'search', 'url',
  'submit', 'button', 'reset', 'checkbox', 'radio', 'file', 'date',
]);

/**
 * Scan a WebView context for interactive DOM elements.
 * Switches to the WebView, executes JS to extract elements, switches back.
 * Returns InteractiveElement[] with CSS locators and context tags.
 *
 * @param contextId - The WEBVIEW_xxx context to scan
 * @param startIndex - Starting index for element numbering (to continue from native scan)
 */
export async function scanWebViewInteractiveElements(
  contextId: string,
  startIndex: number = 0,
): Promise<InteractiveElement[]> {
  const browser = getBrowser();
  const originalCtx = await getCurrentContext();

  try {
    await switchToContextById(contextId);

    // Execute JS to extract all interactive elements from the DOM
    const rawElements = await Promise.race([
      browser.execute(EXTRACT_INTERACTIVE_JS),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('WebView scan timeout')), 1500)),
    ]) as WebViewRawElement[];

    if (!Array.isArray(rawElements) || rawElements.length === 0) {
      return [];
    }

    const elements: InteractiveElement[] = [];
    for (let i = 0; i < rawElements.length; i++) {
      const raw = rawElements[i];
      if (!raw || !raw.tag) continue;

      const tag = raw.tag.toLowerCase();
      const flutterType = HTML_TYPE_MAP[tag] || 'TextButton';

      // Build best CSS selector: #id → [name=x] → tag.class → tag with text
      let cssSelector: string;
      if (raw.id) {
        cssSelector = `#${raw.id}`;
      } else if (raw.name) {
        cssSelector = `${tag}[name="${raw.name}"]`;
      } else if (raw.classes && raw.classes.length > 0) {
        cssSelector = `${tag}.${raw.classes.slice(0, 2).join('.')}`;
      } else if (raw.text) {
        // Use xpath-like text matching as CSS can't match by text content
        // Fall back to tag-based selector
        cssSelector = tag;
      } else {
        cssSelector = tag;
      }

      const text = raw.text?.trim().slice(0, 100) || undefined;

      elements.push({
        index: startIndex + i,
        type: flutterType,
        text,
        enabled: raw.disabled !== true,
        displayed: true,
        position: raw.rect ? {
          x: raw.rect.x,
          y: raw.rect.y,
          width: raw.rect.width,
          height: raw.rect.height,
        } : undefined,
        locator: { by: 'css', value: cssSelector },
        context: contextId,
      });
    }

    logger.info('WebView scan complete', { contextId, elements: elements.length });
    return elements;
  } catch (error) {
    logger.debug('WebView scan failed (non-critical)', { contextId, error: String(error) });
    return [];
  } finally {
    // Restore original context
    if (originalCtx !== contextId) {
      try { await switchToContextById(originalCtx); } catch { /* best effort */ }
    }
  }
}

interface WebViewRawElement {
  tag: string;
  text?: string;
  id?: string;
  name?: string;
  classes?: string[];
  type?: string;
  href?: string;
  role?: string;
  disabled?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
}

/**
 * JavaScript executed inside the WebView to extract interactive elements.
 * Returns a JSON-serializable array of element descriptors.
 */
const EXTRACT_INTERACTIVE_JS = `
return (function() {
  var selectors = 'button, a[href], input, select, textarea, [role="button"], [onclick], [tabindex]';
  var nodes = document.querySelectorAll(selectors);
  var results = [];
  for (var i = 0; i < nodes.length && i < 100; i++) {
    var el = nodes[i];
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    var tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      var inputType = (el.type || 'text').toLowerCase();
      if (inputType === 'hidden') continue;
    }
    results.push({
      tag: tag,
      text: (el.textContent || el.value || el.placeholder || '').trim().substring(0, 100),
      id: el.id || null,
      name: el.name || null,
      classes: el.className ? el.className.split(/\\s+/).filter(function(c) { return c.length > 0; }).slice(0, 3) : [],
      type: el.type || null,
      href: el.href || null,
      role: el.getAttribute('role') || null,
      disabled: el.disabled === true,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
    });
  }
  return results;
})();
`;

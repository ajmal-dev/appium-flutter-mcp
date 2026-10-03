import { z } from 'zod';
import { getBrowser, getBrowserWithReconnect } from '../appium/session.js';
import { captureScreenshot, LLM_SCREENSHOT_OPTS } from '../util/screenshot.js';
import { invalidateCache } from '../tree/tree-builder.js';
import { logger } from '../util/logger.js';
import { loadConfig } from '../util/config.js';
import { recordAction, isRecording } from '../recording/recorder.js';
import { ensureContextForLocator, getCurrentContext, switchToNative, switchToWebView, tryAcrossWebViews, getWebViewContexts, switchToContextById } from '../context/context-manager.js';
import { getRegistry } from '../context/element-registry.js';
import { autoScanElementsOnly as autoScanElementsOnlyRaw } from '../util/auto-scan.js';

// Batch mode: intermediate sub-actions inside batch_actions discard their scan
// output, so running a page-source scan per sub-action is pure wasted latency.
// The final scan (after the batch loop) still records the end screen.
let batchDepth = 0;

async function autoScanElementsOnly(action?: { by: string; value: string }): Promise<McpToolResponse['content']> {
  if (batchDepth > 0) return [];
  return autoScanElementsOnlyRaw(action);
}
import { pageSourceScan, scanWebViewInteractiveElements } from '../tree/page-source-scanner.js';
import { getScreenElements, describeKeyGap } from '../util/element-source.js';
import { matchesDistinctiveToken, distinctiveSearchTerms } from '../util/distinctive-tokens.js';
import { enhancedSimilarity } from '../locator/fuzzy.js';
import { formatElementsCompact } from '../util/element-format.js';
import { getVMClient, vmDriverCommandsUsable, markVMDriverCommandsBroken } from '../vm/vm-session.js';
import { vmTap, vmEnterText, vmWaitFor, isVMCompatibleLocator } from '../vm/vm-actions.js';
import type { McpToolResponse } from '../types.js';
import type { InteractiveElement } from '../tree/types.js';
import { getDartSourceIndex, searchValueKeys } from '../source/dart-source-scanner.js';

export const tapSchema = z.object({
  target: z.string().optional().describe('Locator value (ValueKey, text, type, XPath, CSS selector, or accessibility ID). Omit when using x/y coordinates or description.'),
  by: z.enum(['key', 'text', 'type', 'semanticsLabel', 'xpath', 'accessibilityId', 'css', 'coordinates', 'relativeRight', 'relativeLeft'])
    .optional()
    .default('key')
    .describe('Locator strategy. Use "coordinates" with x/y params for coordinate-based tap. Use "relativeRight"/"relativeLeft" with target=anchor text and index=Nth element to the right/left (1-based).'),
  description: z.string().optional().describe('Natural-language description of the element (e.g., "Login button", "search field"). When set (and no target/x/y), fuzzy-matches against visible elements and taps the best match — no need to discover a locator first.'),
  index: z.number().optional().default(0).describe('Zero-based index when multiple elements match (e.g., 2 to tap the 3rd IconButton). For relativeRight/relativeLeft: 1-based offset (e.g., 3 = 3rd element to the right of anchor)'),
  x: z.number().optional().describe('X coordinate for coordinate-based tap'),
  y: z.number().optional().describe('Y coordinate for coordinate-based tap'),
  timeout: z.number().optional().default(10).describe('Wait timeout in seconds'),
  screenshot: z.boolean().optional().default(true).describe('Return screenshot after action. Set false for faster intermediate steps.'),
});

export const typeTextSchema = z.object({
  target: z.string().optional().describe('Locator value for the text field. Omit when using x/y coordinates.'),
  text: z.string().describe('Text to enter'),
  by: z.enum(['key', 'text', 'type', 'semanticsLabel', 'xpath', 'accessibilityId', 'css', 'coordinates'])
    .optional()
    .default('key')
    .describe('Locator strategy (default: key). Use "coordinates" with x/y to tap-focus a field then type via VM.'),
  x: z.number().optional().describe('X coordinate for coordinate-based typing'),
  y: z.number().optional().describe('Y coordinate for coordinate-based typing'),
  index: z.number().optional().default(0).describe('Zero-based index when multiple text fields match the same locator'),
  clearFirst: z.boolean().optional().default(true).describe('Clear field before typing'),
  screenshot: z.boolean().optional().default(true).describe('Return screenshot after action. Set false for faster intermediate steps.'),
});

export const gestureSchema = z.object({
  action: z.enum(['swipe', 'scroll_down', 'scroll_up', 'long_press', 'double_tap', 'back', 'scroll_until_visible'])
    .describe('Gesture action to perform. "scroll_until_visible" scrolls until the target element appears (requires target).'),
  target: z.string().optional().describe('Element locator for element-targeted gestures (required for scroll_until_visible)'),
  targetBy: z.enum(['key', 'text', 'type', 'semanticsLabel', 'xpath', 'accessibilityId', 'css']).optional().describe('Locator strategy for target (default: key)'),
  params: z.object({
    startX: z.number().optional(),
    startY: z.number().optional(),
    endX: z.number().optional(),
    endY: z.number().optional(),
    duration: z.number().optional(),
  }).optional().describe('Gesture parameters for swipe'),
  direction: z.enum(['down', 'up', 'left', 'right']).optional().default('down')
    .describe('scroll_until_visible only: direction to scroll'),
  maxScrolls: z.number().optional().default(15).describe('scroll_until_visible only: max scroll attempts'),
  scrollDelta: z.number().optional().default(300).describe('scroll_until_visible only: pixels per scroll step'),
  scrollableTarget: z.string().optional().describe('scroll_until_visible only: locator of the scrollable container (if not the default scrollable)'),
  scrollableBy: z.enum(['key', 'text', 'type']).optional().describe('scroll_until_visible only: locator strategy for the scrollable container'),
  screenshot: z.boolean().optional().default(true).describe('Return screenshot after action. Set false for faster intermediate steps.'),
});

async function findElement(browser: WebdriverIO.Browser, target: string, by: string, index: number = 0) {
  // Map tool-level strategy names to W3C protocol strategy strings
  // for the FlutterIntegration driver
  const flutterStrategies: Record<string, string> = {
    key: '-flutter key',
    text: '-flutter text',
    type: '-flutter type',
    semanticsLabel: '-flutter semantics label',
  };

  if (flutterStrategies[by]) {
    if (index > 0) {
      // Use findElements for index-based selection
      const rawElements = await browser.findElements(flutterStrategies[by], target);
      if (index >= rawElements.length) {
        throw new Error(`Index ${index} out of bounds — only ${rawElements.length} elements found for ${by}="${target}"`);
      }
      return browser.$(rawElements[index]);
    }
    const rawElement = await browser.findElement(flutterStrategies[by], target);
    return browser.$(rawElement);
  }

  // For non-Flutter strategies with index support
  const selectorMap: Record<string, string> = {
    xpath: target,
    accessibilityId: `~${target}`,
    css: target,
  };

  const selector = selectorMap[by];
  if (selector !== undefined) {
    if (index > 0) {
      const rawElements = await browser.findElements('xpath' === by ? 'xpath' : 'css selector', selector);
      if (index >= rawElements.length) throw new Error(`Index ${index} out of bounds — only ${rawElements.length} elements found`);
      return browser.$(rawElements[index]);
    }
    return browser.$(selector);
  }

  // Default: Flutter key
  const rawElement = await browser.findElement('-flutter key', target);
  return browser.$(rawElement);
}

// --- Per-session failed context memoization (reset on navigation) ---
// Tracks locator fingerprints that failed in specific contexts to skip retries
const failedContextMemo = new Map<string, Set<string>>();

function memoContextFailure(by: string, target: string, contextId: string): void {
  const key = `${by}:${target}`;
  if (!failedContextMemo.has(key)) failedContextMemo.set(key, new Set());
  failedContextMemo.get(key)!.add(contextId);
}

function wasContextTriedAndFailed(by: string, target: string, contextId: string): boolean {
  return failedContextMemo.get(`${by}:${target}`)?.has(contextId) === true;
}

/** Clear failed-context memo (call on navigation/new screen) */
export function clearContextFailureMemo(): void {
  failedContextMemo.clear();
}

/**
 * Find element with intelligent auto-context-switching.
 * 1. Registry lookup for O(1) context routing
 * 2. Heuristic context selection
 * 3. Try finding the element
 * 4. For ambiguous xpath/css: fallback to other contexts (with memoization)
 */
async function findElementWithContextFallback(
  browser: WebdriverIO.Browser,
  target: string,
  by: string,
  index: number = 0,
): Promise<any> {
  // Step 0: Check element registry for known context (O(1) lookup)
  const registry = getRegistry();
  const knownCtx = registry.lookupContext(by, target);
  if (knownCtx) {
    const current = await getCurrentContext();
    if (current !== knownCtx) {
      try {
        await switchToContextById(knownCtx);
        logger.info('Registry-routed context switch', { by, target, from: current, to: knownCtx });
      } catch {
        logger.debug('Registry-suggested context unavailable, falling through', { knownCtx });
      }
    }
  }

  // Step 0b: For CSS/xpath in webview — check if registry knows about cross-origin iframes
  if ((by === 'css' || by === 'xpath') && !knownCtx) {
    if (registry.anyWebViewHasCrossOriginIframes()) {
      throw new Error(
        `CSS/xpath selectors cannot reach cross-origin iframe content in this WebView. ` +
        `Use coordinate-based tap (by="coordinates" with x/y) instead. ` +
        `The booking form is inside an iframe that blocks direct element access.`
      );
    }
  }

  // Step 1: Switch to best-guess context based on locator strategy (if registry had no answer)
  if (!knownCtx) {
    await ensureContextForLocator(by, target);
  }

  // Step 1b: If by='key' but target looks like display text (has spaces), try 'text' first
  const effectiveBy = (by === 'key' && /\s/.test(target)) ? 'text' : by;
  if (effectiveBy !== by) {
    logger.info('Auto-detected display text in target, trying text strategy first', { target, originalBy: by });
  }

  // Step 2: Try finding the element
  const tryContext = await getCurrentContext();
  try {
    const el = await findElement(browser, target, effectiveBy, index);
    // Register successful find in registry for future lookups
    registry.registerElement(tryContext, effectiveBy, target);
    return el;
  } catch (firstError) {
    // Step 2b: If we auto-switched to 'text' and it failed, try original 'key' strategy
    // If original was 'key' and failed, try 'text' as immediate fallback
    if (effectiveBy !== by) {
      try {
        const el = await findElement(browser, target, by, index);
        registry.registerElement(tryContext, by, target);
        return el;
      } catch { /* continue to other fallbacks */ }
    } else if (by === 'key') {
      // key → text → semanticsLabel fallback chain
      try {
        logger.debug('Key lookup failed, trying text strategy as fallback', { target });
        const el = await findElement(browser, target, 'text', index);
        registry.registerElement(tryContext, 'text', target);
        logger.info('Found element via key→text fallback', { target });
        return el;
      } catch { /* continue to semanticsLabel */ }
      try {
        logger.debug('Text fallback failed, trying semanticsLabel', { target });
        const el = await findElement(browser, target, 'semanticsLabel', index);
        registry.registerElement(tryContext, 'semanticsLabel', target);
        logger.info('Found element via key→text→semanticsLabel fallback', { target });
        return el;
      } catch { /* continue to other fallbacks */ }
    } else if (by === 'text') {
      // text → key → semanticsLabel fallback chain
      try {
        logger.debug('Text lookup failed, trying key strategy as fallback', { target });
        const el = await findElement(browser, target, 'key', index);
        registry.registerElement(tryContext, 'key', target);
        logger.info('Found element via text→key fallback', { target });
        return el;
      } catch { /* continue to semanticsLabel */ }
      try {
        logger.debug('Key fallback failed, trying semanticsLabel', { target });
        const el = await findElement(browser, target, 'semanticsLabel', index);
        registry.registerElement(tryContext, 'semanticsLabel', target);
        logger.info('Found element via text→key→semanticsLabel fallback', { target });
        return el;
      } catch { /* continue to other fallbacks */ }
    }

    // Memoize this context as failed for this locator
    memoContextFailure(by, target, tryContext);

    // Step 3: For xpath, try other contexts (skip already-failed ones)
    if (by === 'xpath') {
      const current = await getCurrentContext();
      const fallbackContexts: Array<'native' | 'webview'> = [];

      if (current !== 'NATIVE_APP' && !wasContextTriedAndFailed(by, target, 'NATIVE_APP')) {
        fallbackContexts.push('native');
      }
      if (!current.startsWith('WEBVIEW')) {
        fallbackContexts.push('webview');
      }

      for (const ctx of fallbackContexts) {
        try {
          if (ctx === 'native') await switchToNative();
          else await switchToWebView(3);

          const actualCtx = await getCurrentContext();
          if (wasContextTriedAndFailed(by, target, actualCtx)) continue;

          const el = await findElement(browser, target, by, index);
          registry.registerElement(actualCtx, by, target);
          logger.info('Found element via context fallback', { by, target, context: actualCtx });
          return el;
        } catch {
          const failedCtx = await getCurrentContext();
          memoContextFailure(by, target, failedCtx);
        }
      }
    }

    // Step 3b: For CSS selectors, try other WebView contexts (multi-webview apps)
    if (by === 'css') {
      const currentWv = await getCurrentContext();
      const webviews = await getWebViewContexts();
      for (const wv of webviews) {
        if (wv === currentWv || wasContextTriedAndFailed(by, target, wv)) continue;
        try {
          await switchToWebView(3, wv);
          const el = await findElement(browser, target, by, index);
          const actualCtx = await getCurrentContext();
          registry.registerElement(actualCtx, by, target);
          logger.info('Found CSS element in alternate WebView', { target, webview: actualCtx });
          return el;
        } catch {
          memoContextFailure(by, target, wv);
        }
      }

      // CSS failed in ALL webviews — check if cross-origin iframes are the cause
      try {
        await detectAndMarkCrossOriginIframes(browser, registry);
      } catch { /* non-critical */ }
    }

    // All strategies failed — enhance error if iframes detected
    if ((by === 'css' || by === 'xpath') && registry.anyWebViewHasCrossOriginIframes()) {
      throw new Error(
        `${String(firstError)}. ` +
        `NOTE: Cross-origin iframes detected in WebView — CSS/xpath cannot access iframe content. ` +
        `Use coordinate-based tap (by="coordinates" with x/y from screenshot) instead.`
      );
    }
    throw firstError;
  }
}

async function screenshotContent(browser: WebdriverIO.Browser, enabled: boolean = true): Promise<McpToolResponse['content']> {
  if (!enabled) return [];
  const config = loadConfig();
  if (!config.screenshotOnAction) return [];
  try {
    // Compressed for LLM consumption — a raw full-res PNG costs ~6x the tokens
    // of an 800px JPEG and adds nothing for element identification.
    const screenshot = await captureScreenshot(browser, LLM_SCREENSHOT_OPTS);
    return [{ type: 'image' as const, data: screenshot.base64, mimeType: screenshot.mimeType }];
  } catch {
    return [];
  }
}

interface JsTapResult {
  ok: boolean;
  count?: number;
  text?: string;
  /** Element-center in CSS px (webview viewport space) + viewport size for device-coord translation. */
  cx?: number;
  cy?: number;
  vw?: number;
  vh?: number;
  error?: string;
}

/**
 * Tap a DOM element via in-page JavaScript: scrollIntoView + synthesized
 * pointerdown/mousedown/mouseup/click at the element center. One execute()
 * round trip — no WebDriver atoms, no interactability gate. Returns ok:false
 * (never throws for "not found") so callers can fall back to the atom path.
 */
async function jsWebViewTap(browser: WebdriverIO.Browser, selector: string, index: number): Promise<JsTapResult> {
  const script = `return (function() {
    var els;
    try { els = document.querySelectorAll(${JSON.stringify(selector)}); }
    catch (e) { return { ok: false, error: 'bad selector: ' + e.message }; }
    if (els.length <= ${index}) return { ok: false, count: els.length };
    var el = els[${index}];
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    var r = el.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
    try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (e) {}
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (e) {}
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    if (typeof el.focus === 'function') { try { el.focus(); } catch (e) {} }
    return {
      ok: true,
      count: els.length,
      text: (el.textContent || el.value || '').trim().substring(0, 60),
      cx: Math.round(cx), cy: Math.round(cy),
      vw: window.innerWidth, vh: window.innerHeight
    };
  })();`;
  const result = await browser.execute(script);
  return result as JsTapResult;
}

/**
 * Get element rect (position + size) from a WebdriverIO element.
 */
async function getElementRect(el: { getSize: () => Promise<{ width: number; height: number }>; getLocation: () => Promise<{ x: number; y: number }> }): Promise<{ x: number; y: number; width: number; height: number } | null> {
  try {
    const [size, loc] = await Promise.all([el.getSize(), el.getLocation()]);
    // Ensure numeric values (Appium/Flutter driver may return strings)
    return {
      x: Number(loc.x),
      y: Number(loc.y),
      width: Number(size.width),
      height: Number(size.height),
    };
  } catch {
    return null;
  }
}

/**
 * Scan all elements of given Flutter types and return their positions.
 * Sequential per type to avoid Appium session contention.
 */
async function scanFlutterElementsWithPositions(
  browser: WebdriverIO.Browser,
  types: string[],
): Promise<Array<{ type: string; text?: string; position: { x: number; y: number; width: number; height: number } }>> {
  const results: Array<{ type: string; text?: string; position: { x: number; y: number; width: number; height: number } }> = [];

  for (const typeName of types) {
    try {
      const rawElements = await browser.findElements('-flutter type', typeName);
      if (rawElements.length === 0) continue;

      for (const raw of rawElements) {
        try {
          const el = await browser.$(raw);
          const rect = await getElementRect(el);
          if (!rect) continue;
          let text: string | undefined;
          try { text = await el.getText(); } catch { /* ignore */ }
          results.push({ type: typeName, text: text || undefined, position: rect });
        } catch { /* skip element */ }
      }
    } catch {
      // Type not found — normal
    }
  }

  logger.info('Relative tap scan complete', { types: types.length, elements: results.length });
  return results;
}

/**
 * Relative tap: find an anchor element by text, then tap the Nth element
 * to its right or left in the same row (based on Y-coordinate proximity).
 * Uses Flutter finders directly to get element positions.
 */
async function handleRelativeTap(
  browser: WebdriverIO.Browser,
  anchorText: string,
  direction: 'right' | 'left',
  offset: number,
  screenshot: boolean,
): Promise<McpToolResponse> {
  // 1. Find the anchor element by text using Flutter finder
  let anchorPos: { x: number; y: number; width: number; height: number } | null = null;
  try {
    const rawAnchor = await browser.findElement('-flutter text', anchorText);
    const anchorEl = await browser.$(rawAnchor);
    anchorPos = await getElementRect(anchorEl);
  } catch {
    // Text not found — try as key
    try {
      const rawAnchor = await browser.findElement('-flutter key', anchorText);
      const anchorEl = await browser.$(rawAnchor);
      anchorPos = await getElementRect(anchorEl);
    } catch { /* not found */ }
  }

  if (!anchorPos) {
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ error: true, message: `Anchor element "${anchorText}" not found on screen`, suggestion: 'Check visible text elements and retry with the exact text' }) },
      ],
    };
  }

  const anchorCenterY = anchorPos.y + anchorPos.height / 2;
  const ROW_TOLERANCE = 25; // pixels — elements within this Y range are "same row"

  // 2. Scan common widget types that appear as row siblings (icons, buttons, images, text)
  const SCAN_TYPES = [
    'IconButton', 'Icon', 'Image', 'GestureDetector', 'InkWell',
    'Text', 'TextButton', 'ElevatedButton', 'SvgPicture',
  ];

  const allElements = await scanFlutterElementsWithPositions(browser, SCAN_TYPES);

  // 3. Find all elements in the same row (similar Y center)
  const rowCandidates = allElements.filter(el => {
    const elCenterY = el.position.y + el.position.height / 2;
    return Math.abs(elCenterY - anchorCenterY) <= ROW_TOLERANCE;
  });

  // Add the anchor itself
  rowCandidates.push({ type: 'Text', text: anchorText, position: anchorPos });

  // Sort by X position
  rowCandidates.sort((a, b) => a.position.x - b.position.x);

  // 4. Deduplicate: merge elements whose centers are within 15px of each other.
  // When multiple elements overlap, keep the smallest (most specific) widget.
  const MERGE_THRESHOLD = 15;
  const sameRow: typeof rowCandidates = [];
  for (const el of rowCandidates) {
    const elCenterX = el.position.x + el.position.width / 2;
    const existing = sameRow.find(s => {
      const sCenterX = s.position.x + s.position.width / 2;
      return Math.abs(sCenterX - elCenterX) < MERGE_THRESHOLD;
    });
    if (existing) {
      // Keep the smaller (more specific) element — child widgets are smaller than parents
      const existingArea = existing.position.width * existing.position.height;
      const elArea = el.position.width * el.position.height;
      if (elArea < existingArea) {
        const idx = sameRow.indexOf(existing);
        sameRow[idx] = el;
      }
    } else {
      sameRow.push(el);
    }
  }

  // Re-sort after merges
  sameRow.sort((a, b) => a.position.x - b.position.x);

  // 4. Sort by X position (left to right)
  sameRow.sort((a, b) => a.position.x - b.position.x);

  // 5. Find anchor index in the sorted row (closest X match)
  let anchorIdx = -1;
  let minDist = Infinity;
  for (let i = 0; i < sameRow.length; i++) {
    const dist = Math.abs(sameRow[i].position.x - anchorPos.x) + Math.abs(sameRow[i].position.y - anchorPos.y);
    if (dist < minDist) {
      minDist = dist;
      anchorIdx = i;
    }
  }

  // 6. Calculate target index based on direction and offset
  let targetIdx: number;
  if (direction === 'right') {
    targetIdx = anchorIdx + offset;
  } else {
    targetIdx = anchorIdx - offset;
  }

  if (targetIdx < 0 || targetIdx >= sameRow.length) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: true,
            message: `No element found ${offset} positions to the ${direction} of "${anchorText}". Row has ${sameRow.length} elements, anchor is at position ${anchorIdx + 1}.`,
            rowElements: sameRow.map(el => ({ type: el.type, text: el.text, x: el.position.x, y: el.position.y, w: el.position.width, h: el.position.height })),
          }),
        },
      ],
    };
  }

  const target = sameRow[targetIdx];
  const tapX = Math.round(target.position.x + target.position.width / 2);
  const tapY = Math.round(target.position.y + target.position.height / 2);

  logger.info('Relative tap resolved', {
    anchor: anchorText,
    direction,
    offset,
    targetType: target.type,
    targetText: target.text,
    tapX,
    tapY,
    rowSize: sameRow.length,
  });

  // 7. Tap the resolved coordinates
  await browser.action('pointer')
    .move({ x: tapX, y: tapY })
    .down()
    .up()
    .perform();

  invalidateCache();

  if (isRecording()) {
    recordAction('tap', { by: `relative${direction === 'right' ? 'Right' : 'Left'}`, target: anchorText, index: offset, resolvedX: tapX, resolvedY: tapY }, 'flutter');
  }

  const extra = await screenshotContent(browser, screenshot);
  const scanBlocks = await autoScanElementsOnly();
  return {
    content: [
      {
        type: 'text' as const,
        text: `Tapped ${offset} element(s) to the ${direction} of "${anchorText}" → ${target.type || 'element'}${target.text ? ` "${target.text}"` : ''} at (${tapX}, ${tapY})`,
      },
      ...extra,
      ...scanBlocks,
    ],
  };
}

export async function handleTap(params: z.infer<typeof tapSchema>): Promise<McpToolResponse> {
  const browser = await getBrowserWithReconnect();

  // Description-based tap (absorbed smart_tap): fuzzy-match visible elements
  if (params.description && !params.target && params.x === undefined && params.y === undefined) {
    return handleSmartTap({ description: params.description, screenshot: params.screenshot ?? true });
  }

  try {
    // Relative tap: find anchor element then tap Nth element to its right/left
    if (params.by === 'relativeRight' || params.by === 'relativeLeft') {
      if (!params.target) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message: 'Anchor text "target" is required for relative tap' }) }] };
      }
      const direction = params.by === 'relativeRight' ? 'right' : 'left';
      const offset = params.index || 1; // default to 1st element in that direction
      return handleRelativeTap(browser, params.target, direction, offset, params.screenshot ?? true);
    }

    // Fix #1: Coordinate-based tap support
    if (params.by === 'coordinates' || (params.x !== undefined && params.y !== undefined)) {
      const x = params.x!;
      const y = params.y!;

      // ⚠️ Pre-coordinate ValueKey source check:
      // Before using fragile coordinates, scan the Dart source index for any
      // ValueKey that might target this element. If found, emit a warning so
      // the caller (or Claude) can use byValueKey instead.
      if (params.target) {
        try {
          const cfg = loadConfig();
          const srcIndex = await getDartSourceIndex(cfg.flutterAppPath, cfg.flutterComponentsPath);
          if (srcIndex) {
            const hits = searchValueKeys(srcIndex, params.target);
            if (hits.length > 0) {
              logger.warn(
                `⚠️  Coordinate tap for "${params.target}" but ValueKey exists in Dart source — ` +
                `prefer: tap(by="key", target="${hits[0].keyValue}") to avoid brittle coordinates`,
                { keyValue: hits[0].keyValue, file: hits[0].filePath, line: hits[0].line },
              );
            }
          }
        } catch { /* source index is optional — silently skip on any error */ }
      }

      // Check registry for coordinate-to-context mapping
      const coordRegistry = getRegistry();
      const targetCtx = coordRegistry.lookupContextForCoordinates(x, y);
      if (targetCtx) {
        const current = await getCurrentContext();
        if (current !== targetCtx) {
          try {
            await switchToContextById(targetCtx);
            logger.info('Registry-routed coordinate tap to context', { x, y, context: targetCtx });
          } catch {
            logger.debug('Coordinate context switch failed, tapping in current context', { targetCtx });
          }
        }
      }

      await browser.action('pointer')
        .move({ x, y })
        .down()
        .up()
        .perform();

      invalidateCache();
      logger.info('Tapped at coordinates', { x, y });

      if (isRecording()) {
        recordAction('tap', { by: 'coordinates', x, y }, 'flutter');
      }

      const extra = await screenshotContent(browser, params.screenshot);
      // Auto-scan: include screen elements after coordinate tap (skip during test runs)
      const scanBlocks = await autoScanElementsOnly();
      return {
        content: [
          { type: 'text' as const, text: `Tapped at coordinates (${x}, ${y})` },
          ...extra,
          ...scanBlocks,
        ],
      };
    }

    if (!params.target) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: true, message: 'Either "target" or "x"/"y" coordinates are required' }),
        }],
      };
    }

    // JS-first fast path for CSS targets. WebDriver atoms in a WKWebView can
    // block for the full webviewAtomWaitTimeout when the page (or a sibling
    // stale webview) wedges the remote debugger; a direct querySelector +
    // synthesized pointer/mouse events is one execute() round trip and also
    // reaches elements atoms consider "not interactable" (e.g. Bryntum event
    // divs). Falls through to the atom path when the selector isn't present.
    if (params.by === 'css') {
      try {
        await ensureContextForLocator('css', params.target);
        const js = await jsWebViewTap(browser, params.target, params.index);
        if (js.ok) {
          invalidateCache();
          const currentCtx = await getCurrentContext();
          if (isRecording()) {
            recordAction('tap', { target: params.target, by: 'css', index: params.index }, 'webview');
          }
          // Device-coordinate hint: lets the agent retry as a TRUSTED native tap
          // (by:"coordinates") if the page ignored the synthesized events.
          let coordHint = '';
          const bounds = getRegistry().regions.get(currentCtx)?.bounds;
          if (bounds && js.cx != null && js.cy != null && js.vw) {
            const scale = bounds.width / js.vw;
            const devX = Math.round(bounds.x + js.cx * scale);
            const devY = Math.round(bounds.y + js.cy * scale);
            coordHint = ` (device coords ≈ ${devX},${devY})`;
          }
          const indexInfo = params.index > 0 ? ` [index=${params.index}]` : '';
          logger.info('Tapped element via JS', { target: params.target, index: params.index, context: currentCtx, matches: js.count });
          const extra = await screenshotContent(browser, params.screenshot);
          const scanBlocks = await autoScanElementsOnly();
          return {
            content: [
              {
                type: 'text' as const,
                text: `Tapped (JS): css="${params.target}"${indexInfo}${js.text ? ` — "${js.text}"` : ''} [context: ${currentCtx}, ${js.count} match${js.count === 1 ? '' : 'es'}]${coordHint}`,
              },
              ...extra,
              ...scanBlocks,
            ],
          };
        }
        logger.info('JS tap: selector not matched in current webview, falling back to atom path', {
          target: params.target, index: params.index, matches: js.count ?? 0, error: js.error,
        });
      } catch (e) {
        logger.debug('JS tap attempt failed, falling back to atom path', { target: params.target, error: String(e) });
      }
    }

    // VM fast path: use direct Dart VM Service for Flutter locators (index=0 only).
    // Gated on the flutter_driver command set actually working on this build —
    // integration_test builds (like ZMA) register ext.flutter.driver but only
    // implement a health subset, so the first protocol failure disables this
    // path for the whole session (see vm-session.ts).
    const vm = getVMClient();
    if (vm && vmDriverCommandsUsable() && isVMCompatibleLocator(params.by) && params.index === 0) {
      try {
        await vmTap(vm, params.by, params.target, params.timeout);
        invalidateCache();
        logger.info('Tapped element via VM', { target: params.target, by: params.by });

        if (isRecording()) {
          recordAction('tap', { target: params.target, by: params.by, index: 0 }, 'flutter');
        }

        const extra = await screenshotContent(browser, params.screenshot);
        const scanBlocks = await autoScanElementsOnly();
        return {
          content: [
            { type: 'text' as const, text: `Tapped: ${params.by}="${params.target}" [via VM]` },
            ...extra,
            ...scanBlocks,
          ],
        };
      } catch (vmError) {
        const msg = String(vmError);
        // Protocol-level failure (integration_test's stub endpoint) → disable
        // the VM path for the session. Legit driver errors (element not found,
        // timeout) fall through without disabling.
        if (msg.includes('VM Service error')) markVMDriverCommandsBroken(msg);
        logger.warn('VM tap failed, falling back to Appium', { by: params.by, target: params.target, error: msg });
        // Fall through to Appium path
      }
    }

    // Appium path: element selection with auto-context-switching
    const element = await findElementWithContextFallback(browser, params.target, params.by, params.index);
    // Native iOS elements don't support the 'displayed' attribute; use waitForExist instead
    if (params.by === 'xpath' || params.by === 'accessibilityId') {
      await element.waitForExist({ timeout: params.timeout * 1000 });
    } else {
      await element.waitForDisplayed({ timeout: params.timeout * 1000 });
    }
    await element.click();

    invalidateCache();
    const indexInfo = params.index > 0 ? ` [index=${params.index}]` : '';
    const currentCtx = await getCurrentContext();
    const ctxLabel = currentCtx.startsWith('WEBVIEW') ? 'webview' : currentCtx === 'NATIVE_APP' ? 'native' : 'flutter';
    logger.info('Tapped element', { target: params.target, by: params.by, index: params.index, context: currentCtx });

    // Record action if recording is active — use actual context
    if (isRecording()) {
      recordAction('tap', { target: params.target, by: params.by, index: params.index }, ctxLabel);
    }

    const extra = await screenshotContent(browser, params.screenshot);
    // Auto-scan: include screen elements after tap so Claude sees the new screen state (skip during test runs)
    const scanBlocks = await autoScanElementsOnly();
    return {
      content: [
        { type: 'text' as const, text: `Tapped: ${params.by}="${params.target}"${indexInfo} [context: ${currentCtx}]` },
        ...extra,
        ...scanBlocks,
      ],
    };
  } catch (error) {
    const msg = `Failed to tap ${params.by}="${params.target || `(${params.x},${params.y})`}": ${String(error)}`;
    logger.error(msg);
    // Auto-scan on failure: include available elements so Claude can retry immediately
    let scanBlocks: McpToolResponse['content'] = [];
    try { scanBlocks = await autoScanElementsOnly(); } catch { /* non-critical */ }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ error: true, message: msg, suggestion: 'Check the available elements below, or use by="coordinates" with x/y params' }),
        },
        ...scanBlocks,
      ],
    };
  }
}

export async function handleTypeText(params: z.infer<typeof typeTextSchema>): Promise<McpToolResponse> {
  const browser = await getBrowserWithReconnect();

  try {
    // Coordinate-based typing: tap to focus, then type via multiple fallback strategies
    if (params.by === 'coordinates' && params.x !== undefined && params.y !== undefined) {
      // Step 1: Tap coordinates via Appium to focus the field
      await browser.action('pointer', { parameters: { pointerType: 'touch' } })
        .move({ x: Math.round(params.x), y: Math.round(params.y) })
        .down()
        .up()
        .perform();
      await new Promise(r => setTimeout(r, 500));

      let method = '';

      // Strategy 1: VM enterText (fastest, sends to focused widget) — only when
      // the flutter_driver command set actually works on this build.
      const vm = getVMClient();
      if (vm && vmDriverCommandsUsable()) {
        try {
          await vmEnterText(vm, params.text);
          method = 'VM';
        } catch (e) {
          const msg = String(e);
          if (msg.includes('VM Service error')) markVMDriverCommandsBroken(msg);
          logger.warn('VM enterText not available', { error: msg });
        }
      }

      // Strategy 2: mobile: type (XCUITest typeText — simulates hardware keyboard, works with Flutter)
      if (!method) {
        try {
          await browser.switchContext('NATIVE_APP');
          await browser.execute('mobile: type', { text: params.text });
          method = 'mobile-type';
        } catch (mobileTypeErr) {
          logger.warn('mobile: type failed', { error: String(mobileTypeErr) });
        }
      }

      // Strategy 3: Switch to native context and type via active element sendKeys
      if (!method) {
        try {
          await browser.switchContext('NATIVE_APP');
          const activeEl = await browser.getActiveElement() as any;
          await activeEl.sendKeys(params.text.split(''));
          method = 'native-sendKeys';
        } catch (nativeErr) {
          logger.warn('Native sendKeys failed', { error: String(nativeErr) });
        }
      }

      // Strategy 4: Appium mobile: keys (iOS specific)
      if (!method) {
        try {
          await browser.execute('mobile: keys', {
            keys: params.text.split('').map(c => ({ key: c })),
          });
          method = 'mobile-keys';
        } catch (mobileErr) {
          logger.warn('mobile: keys failed', { error: String(mobileErr) });
        }
      }

      if (!method) {
        throw new Error(`Could not type text at (${params.x}, ${params.y}): all input strategies failed`);
      }

      // Switch back to flutter context
      try { await browser.switchContext('FLUTTER'); } catch { /* may already be in flutter */ }

      invalidateCache();
      logger.info('Typed text via coordinates', { x: params.x, y: params.y, textLength: params.text.length, method });

      if (isRecording()) {
        recordAction('type_text', { target: `(${params.x},${params.y})`, by: 'coordinates', text: params.text, clearFirst: params.clearFirst }, 'flutter');
      }

      const extra = await screenshotContent(browser, params.screenshot);
      const scanBlocks = await autoScanElementsOnly();
      return {
        content: [
          { type: 'text' as const, text: `Typed "${params.text}" at coordinates (${params.x}, ${params.y}) [via ${method}]` },
          ...extra,
          ...scanBlocks,
        ],
      };
    }

    // VM fast path: tap field via VM to focus it, then enter text.
    // Gated on the flutter_driver command set working on this build — this
    // replaces the old per-call dummy-probe round trip.
    const vm = getVMClient();
    if (vm && params.target && isVMCompatibleLocator(params.by) && params.index === 0) {
      if (vmDriverCommandsUsable()) {
        try {
          await vmTap(vm, params.by, params.target, 10);
          await vmEnterText(vm, params.text);

          invalidateCache();
          logger.info('Typed text via VM', { target: params.target, by: params.by, textLength: params.text.length });

          if (isRecording()) {
            recordAction('type_text', { target: params.target, by: params.by, text: params.text, clearFirst: params.clearFirst }, 'flutter');
          }

          const extra = await screenshotContent(browser, params.screenshot);
          const scanBlocks = await autoScanElementsOnly();
          return {
            content: [
              { type: 'text' as const, text: `Typed "${params.text}" into ${params.by}="${params.target}" [via VM]` },
              ...extra,
              ...scanBlocks,
            ],
          };
        } catch (vmError) {
          const msg = String(vmError);
          if (msg.includes('VM Service error')) markVMDriverCommandsBroken(msg);
          logger.warn('VM type_text failed, falling back to Appium', { by: params.by, target: params.target, error: msg });
        }
      }
    }

    // Appium path: element selection with auto-context-switching
    if (!params.target) {
      throw new Error('target is required for non-coordinate typing');
    }
    const element = await findElementWithContextFallback(browser, params.target, params.by, params.index);
    // Native iOS elements don't support the 'displayed' attribute; use waitForExist instead
    if (params.by === 'xpath' || params.by === 'accessibilityId') {
      await element.waitForExist({ timeout: 10000 });
    } else {
      await element.waitForDisplayed({ timeout: 10000 });
    }

    if (params.clearFirst) {
      try {
        await element.clearValue();
      } catch (clearErr) {
        logger.warn('clearValue failed, proceeding with setValue', { error: String(clearErr) });
      }
    }
    await element.setValue(params.text);

    invalidateCache();
    const currentCtx = await getCurrentContext();
    const ctxLabel = currentCtx.startsWith('WEBVIEW') ? 'webview' : currentCtx === 'NATIVE_APP' ? 'native' : 'flutter';
    logger.info('Typed text', { target: params.target, by: params.by, textLength: params.text.length, context: currentCtx });

    // Record action if recording is active — use actual context
    if (isRecording()) {
      recordAction('type_text', { target: params.target, by: params.by, text: params.text, clearFirst: params.clearFirst }, ctxLabel);
    }

    const extra = await screenshotContent(browser, params.screenshot);
    // Auto-scan: include screen elements after typing (skip during test runs)
    const scanBlocks = await autoScanElementsOnly();
    return {
      content: [
        { type: 'text' as const, text: `Typed "${params.text}" into ${params.by}="${params.target}" [context: ${currentCtx}]` },
        ...extra,
        ...scanBlocks,
      ],
    };
  } catch (error) {
    const msg = `Failed to type into ${params.by}="${params.target}": ${String(error)}`;
    logger.error(msg);
    // Auto-scan on failure: include available elements
    let scanBlocks: McpToolResponse['content'] = [];
    try { scanBlocks = await autoScanElementsOnly(); } catch { /* non-critical */ }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ error: true, message: msg, suggestion: 'Check the available elements below to find the correct field' }),
        },
        ...scanBlocks,
      ],
    };
  }
}

export async function handleGesture(params: z.infer<typeof gestureSchema>): Promise<McpToolResponse> {
  const browser = await getBrowserWithReconnect();

  // Absorbed scroll_until_visible: delegate to the dedicated scroll-search handler
  if (params.action === 'scroll_until_visible') {
    if (!params.target) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: true, message: 'target is required for scroll_until_visible' }),
        }],
      };
    }
    return handleScrollUntilVisible({
      target: params.target,
      by: (params.targetBy ?? 'key') as z.infer<typeof scrollUntilVisibleSchema>['by'],
      scrollDirection: params.direction ?? 'down',
      maxScrolls: params.maxScrolls ?? 15,
      scrollDelta: params.scrollDelta ?? 300,
      scrollableTarget: params.scrollableTarget,
      scrollableBy: params.scrollableBy,
      index: 0,
      screenshot: params.screenshot ?? true,
    });
  }

  try {
    switch (params.action) {
      case 'scroll_down': {
        const rect = await browser.getWindowRect();
        await browser.action('pointer')
          .move({ x: Math.floor(rect.width / 2), y: Math.floor(rect.height * 0.8) })
          .down()
          .move({ x: Math.floor(rect.width / 2), y: Math.floor(rect.height * 0.2), duration: 600 })
          .up()
          .perform();
        break;
      }
      case 'scroll_up': {
        const rect = await browser.getWindowRect();
        await browser.action('pointer')
          .move({ x: Math.floor(rect.width / 2), y: Math.floor(rect.height * 0.2) })
          .down()
          .move({ x: Math.floor(rect.width / 2), y: Math.floor(rect.height * 0.8), duration: 600 })
          .up()
          .perform();
        break;
      }
      case 'swipe': {
        const p = params.params || {};
        await browser.action('pointer')
          .move({ x: p.startX || 500, y: p.startY || 500 })
          .down()
          .move({ x: p.endX || 500, y: p.endY || 200, duration: p.duration || 600 })
          .up()
          .perform();
        break;
      }
      case 'long_press': {
        if (params.target && params.targetBy) {
          const el = await findElementWithContextFallback(browser, params.target, params.targetBy);
          await browser.execute('flutter: longPress', { origin: { element: el.elementId } });
        }
        break;
      }
      case 'double_tap': {
        if (params.target && params.targetBy) {
          const el = await findElementWithContextFallback(browser, params.target, params.targetBy);
          await browser.execute('flutter: doubleClick', { origin: { element: el.elementId } });
        }
        break;
      }
      case 'back': {
        await browser.back();
        // After back navigation, check if any WebView contexts were destroyed
        try {
          const { getContexts, invalidateContextsListCache } = await import('../context/context-manager.js');
          invalidateContextsListCache(); // Force fresh context list after navigation
          const currentContexts = await getContexts();
          getRegistry().diffContexts(currentContexts);
        } catch { /* non-critical */ }
        // Clear failed-context memo since we're on a new screen
        clearContextFailureMemo();
        break;
      }
    }

    invalidateCache();
    logger.info('Gesture performed', { action: params.action });

    // Record action if recording is active
    if (isRecording()) {
      if (params.action === 'back') {
        recordAction('navigate_back', { action: params.action }, 'flutter');
      } else {
        recordAction('gesture', {
          action: params.action,
          target: params.target,
          targetBy: params.targetBy,
          params: params.params,
        }, 'flutter');
      }
    }

    const extra = await screenshotContent(browser, params.screenshot);
    // Auto-scan: include screen elements after gesture (skip during test runs)
    const scanBlocks = await autoScanElementsOnly();
    return {
      content: [
        { type: 'text' as const, text: `Gesture: ${params.action} performed` },
        ...extra,
        ...scanBlocks,
      ],
    };
  } catch (error) {
    const msg = `Gesture ${params.action} failed: ${String(error)}`;
    logger.error(msg);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message: msg }) }],
    };
  }
}

/** Infer the app context from the locator strategy */
/**
 * Detect cross-origin iframes in the current WebView and mark them in the registry.
 * Called after CSS selector fails across all webviews.
 */
async function detectAndMarkCrossOriginIframes(
  browser: WebdriverIO.Browser,
  registry: ReturnType<typeof getRegistry>,
): Promise<void> {
  const webviews = await getWebViewContexts();
  for (const wv of webviews) {
    try {
      await switchToWebView(3, wv);
      // Check if this webview has iframes with src from a different origin
      const result = await browser.execute(
        'var iframes = document.querySelectorAll("iframe[src]"); ' +
        'var count = 0; ' +
        'iframes.forEach(function(f) { if (f.src && !f.src.startsWith("about:") && f.src.indexOf(window.location.hostname) === -1) count++; }); ' +
        'return count;'
      );
      if (typeof result === 'number' && result > 0) {
        registry.markHasCrossOriginIframes(wv);
        logger.info('Detected cross-origin iframes in WebView', { contextId: wv, count: result });
      }
    } catch {
      // Non-critical — continue
    }
  }
  // Switch back to native after detection
  await switchToNative().catch(() => {});
}

function inferContext(by: string): string {
  if (by === 'key' || by === 'text' || by === 'type' || by === 'semanticsLabel') return 'flutter';
  if (by === 'css') return 'webview';
  if (by === 'xpath' || by === 'accessibilityId') return 'native';
  return 'flutter';
}

// --- Scroll Until Visible Tool ---

export const scrollUntilVisibleSchema = z.object({
  target: z.string().describe('Locator value of the element to scroll to'),
  by: z.enum(['key', 'text', 'type', 'semanticsLabel', 'xpath', 'accessibilityId', 'css'])
    .optional()
    .default('key')
    .describe('Locator strategy for the target element'),
  scrollDirection: z.enum(['down', 'up', 'left', 'right'])
    .optional()
    .default('down')
    .describe('Direction to scroll'),
  maxScrolls: z.number().optional().default(15).describe('Maximum scroll attempts before giving up'),
  scrollDelta: z.number().optional().default(300).describe('Pixels per scroll step. Larger = faster scrolling, smaller = more precise'),
  scrollableTarget: z.string().optional().describe('Locator value of the scrollable container (if not the default scrollable)'),
  scrollableBy: z.enum(['key', 'text', 'type']).optional().describe('Locator strategy for the scrollable container'),
  index: z.number().optional().default(0).describe('Zero-based index when multiple elements match'),
  screenshot: z.boolean().optional().default(true).describe('Return screenshot after element is found'),
});

export async function handleScrollUntilVisible(params: z.infer<typeof scrollUntilVisibleSchema>): Promise<McpToolResponse> {
  const browser = await getBrowserWithReconnect();
  const startTime = Date.now();

  try {
    // Determine strategy context
    const flutterStrategies = ['key', 'text', 'type', 'semanticsLabel'];
    const isFlutter = flutterStrategies.includes(params.by);

    if (isFlutter) {
      // Use Flutter's built-in scrollTillVisible command for best reliability
      const strategyMap: Record<string, string> = {
        key: '-flutter key',
        text: '-flutter text',
        type: '-flutter type',
        semanticsLabel: '-flutter semantics label',
      };

      const scrollParams: Record<string, unknown> = {
        finder: { strategy: strategyMap[params.by], selector: params.target },
        scrollDirection: params.scrollDirection,
        delta: params.scrollDelta,
        maxScrolls: params.maxScrolls,
      };

      // If a scrollable container is specified, add it as the scroll view finder
      if (params.scrollableTarget && params.scrollableBy) {
        scrollParams.scrollView = {
          strategy: strategyMap[params.scrollableBy] || '-flutter key',
          selector: params.scrollableTarget,
        };
      }

      await browser.execute('flutter: scrollTillVisible', scrollParams);

      // Now find the element so we can return info about it
      const rawElement = await browser.findElement(strategyMap[params.by], params.target);
      const element = await browser.$(rawElement);
      await element.waitForDisplayed({ timeout: 5000 });

      invalidateCache();
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info('Scrolled to element (Flutter)', { target: params.target, by: params.by, elapsed });

      if (isRecording()) {
        recordAction('gesture', {
          action: 'scroll_until_visible',
          target: params.target,
          by: params.by,
          scrollDirection: params.scrollDirection,
          maxScrolls: params.maxScrolls,
        }, 'flutter');
      }

      const extra = await screenshotContent(browser, params.screenshot);
      const scanBlocks = await autoScanElementsOnly();
      return {
        content: [
          { type: 'text' as const, text: `Scrolled ${params.scrollDirection} and found ${params.by}="${params.target}" after ${elapsed}s` },
          ...extra,
          ...scanBlocks,
        ],
      };
    }

    // Non-Flutter: manual scroll loop for native/webview elements
    await ensureContextForLocator(params.by, params.target);
    const rect = await browser.getWindowRect();
    const centerX = Math.floor(rect.width / 2);

    for (let attempt = 0; attempt < params.maxScrolls; attempt++) {
      // Check if element exists and is visible
      try {
        const element = await findElement(browser, params.target, params.by, params.index);
        const isDisplayed = await element.isDisplayed().catch(() => false);
        if (isDisplayed) {
          invalidateCache();
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          logger.info('Scrolled to element (native/webview)', { target: params.target, by: params.by, attempts: attempt, elapsed });

          if (isRecording()) {
            const currentCtx = await getCurrentContext();
            const ctxLabel = currentCtx.startsWith('WEBVIEW') ? 'webview' : 'native';
            recordAction('gesture', {
              action: 'scroll_until_visible',
              target: params.target,
              by: params.by,
              scrollDirection: params.scrollDirection,
              attempts: attempt,
            }, ctxLabel);
          }

          const extra = await screenshotContent(browser, params.screenshot);
          const scanBlocks2 = await autoScanElementsOnly();
          return {
            content: [
              { type: 'text' as const, text: `Scrolled ${params.scrollDirection} (${attempt} swipes) and found ${params.by}="${params.target}" after ${elapsed}s` },
              ...extra,
              ...scanBlocks2,
            ],
          };
        }
      } catch {
        // Element not found yet — scroll and retry
      }

      // Perform scroll gesture
      const scrollDistance = params.scrollDelta;
      let startY: number, endY: number, startX: number, endX: number;
      startX = endX = centerX;
      startY = endY = Math.floor(rect.height / 2);

      switch (params.scrollDirection) {
        case 'down':
          startY = Math.floor(rect.height * 0.7);
          endY = Math.floor(rect.height * 0.7) - scrollDistance;
          break;
        case 'up':
          startY = Math.floor(rect.height * 0.3);
          endY = Math.floor(rect.height * 0.3) + scrollDistance;
          break;
        case 'left':
          startX = Math.floor(rect.width * 0.8);
          endX = Math.floor(rect.width * 0.8) - scrollDistance;
          break;
        case 'right':
          startX = Math.floor(rect.width * 0.2);
          endX = Math.floor(rect.width * 0.2) + scrollDistance;
          break;
      }

      await browser.action('pointer')
        .move({ x: startX, y: startY })
        .down()
        .move({ x: endX, y: endY, duration: 400 })
        .up()
        .perform();

      // Brief pause for content to settle
      await new Promise(r => setTimeout(r, 300));
    }

    // Exhausted all scroll attempts
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: true,
          message: `Element ${params.by}="${params.target}" not found after ${params.maxScrolls} scrolls (${elapsed}s)`,
          suggestion: 'Increase maxScrolls, try a different scrollDirection, or verify the element exists with find_elements',
        }),
      }],
    };
  } catch (error) {
    const msg = `scroll_until_visible failed for ${params.by}="${params.target}": ${String(error)}`;
    logger.error(msg);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message: msg }) }],
    };
  }
}

// --- Wait For Page Stable Tool ---

export const waitForPageStableSchema = z.object({
  stabilityThreshold: z.number().optional().default(1500)
    .describe('Milliseconds with no changes before the page is considered stable (default: 1500)'),
  timeout: z.number().optional().default(30)
    .describe('Max wait time in seconds before giving up'),
  checkInterval: z.number().optional().default(500)
    .describe('How often to check for changes in milliseconds'),
  ignoreAnimations: z.boolean().optional().default(true)
    .describe('Ignore minor pixel changes caused by animations (uses structural comparison instead of pixel diff)'),
  screenshot: z.boolean().optional().default(true)
    .describe('Return screenshot of the stable page'),
});

/**
 * Wait for the page to stop changing — detects stability by comparing
 * widget tree snapshots and page source across intervals.
 * More reliable than waiting for a specific element after navigation/transitions.
 */
export async function handleWaitForPageStable(params: z.infer<typeof waitForPageStableSchema>): Promise<McpToolResponse> {
  const browser = await getBrowserWithReconnect();
  const startTime = Date.now();
  const timeoutMs = params.timeout * 1000;

  try {
    let lastSnapshot = '';
    let stableSince: number | null = null;

    while ((Date.now() - startTime) < timeoutMs) {
      // Take a structural snapshot: page source is fast and captures DOM/widget structure
      const currentSnapshot = await getPageStructureFingerprint(browser);

      if (currentSnapshot === lastSnapshot) {
        // No change detected
        if (!stableSince) {
          stableSince = Date.now();
        }

        const stableFor = Date.now() - stableSince;
        if (stableFor >= params.stabilityThreshold) {
          // Page is stable
          invalidateCache();
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const stableMs = stableFor;

          logger.info('Page stabilized', { elapsed, stableFor: stableMs });

          if (isRecording()) {
            recordAction('wait', {
              action: 'wait_for_page_stable',
              elapsed: parseFloat(elapsed),
              stableFor: stableMs,
            }, 'flutter');
          }

          const extra = await screenshotContent(browser, params.screenshot);
          return {
            content: [
              { type: 'text' as const, text: `Page stable after ${elapsed}s (no changes for ${stableMs}ms)` },
              ...extra,
            ],
          };
        }
      } else {
        // Change detected — reset stability timer
        stableSince = null;
        lastSnapshot = currentSnapshot;
      }

      await new Promise(r => setTimeout(r, params.checkInterval));
    }

    // Timed out waiting for stability
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.warn('Page did not stabilize within timeout', { elapsed, timeout: params.timeout });

    const extra = await screenshotContent(browser, params.screenshot);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: false,
            warning: true,
            message: `Page did not fully stabilize after ${elapsed}s — may still be loading or animating`,
            suggestion: 'Increase timeout or stabilityThreshold, or use wait_for to target a specific element',
          }),
        },
        ...extra,
      ],
    };
  } catch (error) {
    const msg = `wait_for_page_stable failed: ${String(error)}`;
    logger.error(msg);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message: msg }) }],
    };
  }
}

/**
 * Generate a structural fingerprint of the current page.
 * Uses page source (XML for native, HTML for webview) which reflects
 * structural changes (new/removed elements, text changes, visibility changes)
 * while being immune to cosmetic animation changes like opacity/color transitions.
 */
async function getPageStructureFingerprint(browser: WebdriverIO.Browser): Promise<string> {
  try {
    const source = await browser.getPageSource();
    // Strip volatile attributes that change without meaningful UI change:
    // - bounds/rect coordinates (minor layout jitter from animations)
    // - focused state (cursor blink etc.)
    // - animation-related attrs
    return source
      .replace(/\b(bounds|frame|rect)="[^"]*"/g, '')
      .replace(/\b(focused)="[^"]*"/g, '')
      .replace(/\b(visible)="(true|false)"/g, 'visible="$2"');
  } catch {
    // Fallback: use screenshot hash if page source unavailable
    try {
      const screenshot = await browser.takeScreenshot();
      // Simple hash of first 2000 chars — catches major changes
      return simpleHash(screenshot.slice(0, 2000));
    } catch {
      return '';
    }
  }
}

/** Fast non-crypto hash for change detection */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return hash.toString(36);
}

// --- Wait For Tool ---

export const waitForSchema = z.object({
  target: z.string().optional().describe('Locator value to wait for. OMIT to wait for the page to become STABLE instead (no structural changes — use after navigation, transitions, or data loading).'),
  by: z.enum(['key', 'text', 'type', 'semanticsLabel', 'xpath', 'accessibilityId', 'css'])
    .optional()
    .default('text')
    .describe('Locator strategy (default: text)'),
  timeout: z.number().optional().default(30).describe('Max wait time in seconds'),
  index: z.number().optional().default(0).describe('Zero-based index when multiple elements match'),
  stabilityThreshold: z.number().optional().default(1500)
    .describe('Stable-mode only (no target): milliseconds with no changes before the page is considered stable'),
  checkInterval: z.number().optional().default(500)
    .describe('Stable-mode only (no target): how often to check for changes in milliseconds'),
  screenshot: z.boolean().optional().default(true).describe('Return screenshot when element is found / page is stable'),
});

export async function handleWaitFor(params: z.infer<typeof waitForSchema>): Promise<McpToolResponse> {
  const browser = await getBrowserWithReconnect();
  const startTime = Date.now();

  // Stable-mode (absorbed wait_for_page_stable): no target = wait for the page to stop changing
  if (!params.target) {
    return handleWaitForPageStable({
      stabilityThreshold: params.stabilityThreshold ?? 1500,
      timeout: params.timeout ?? 30,
      checkInterval: params.checkInterval ?? 500,
      ignoreAnimations: true,
      screenshot: params.screenshot ?? true,
    });
  }

  try {
    const element = await findElementWithContextFallback(browser, params.target, params.by, params.index);
    if (params.by === 'xpath' || params.by === 'accessibilityId') {
      await element.waitForExist({ timeout: params.timeout * 1000 });
    } else {
      await element.waitForDisplayed({ timeout: params.timeout * 1000 });
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const extra = await screenshotContent(browser, params.screenshot);
    return {
      content: [
        { type: 'text' as const, text: `Found ${params.by}="${params.target}" after ${elapsed}s` },
        ...extra,
      ],
    };
  } catch (error) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: true, message: `Element ${params.by}="${params.target}" not found after ${elapsed}s: ${String(error)}` }),
      }],
    };
  }
}

// --- Smart Tap Tool ---

export const smartTapSchema = z.object({
  description: z.string().describe('Natural-language description of the element to tap (e.g., "Login button", "search field", "guest name")'),
  screenshot: z.boolean().optional().default(true).describe('Return screenshot after action'),
});

/**
 * Smart tap: accepts a natural-language description, fuzzy-matches against
 * visible elements, and taps the best match. Combines observe + act in 1 call.
 */
export async function handleSmartTap(params: z.infer<typeof smartTapSchema>): Promise<McpToolResponse> {
  const browser = await getBrowserWithReconnect();

  try {
    // Registry-first fast path: check if element was already seen (sub-ms lookup)
    const registry = getRegistry();
    const registryMatch = registry.findByDescription(params.description, 0.8);
    if (registryMatch) {
      logger.info('smart_tap: registry fast path', { description: params.description, match: `${registryMatch.by}:${registryMatch.value}`, score: registryMatch.score.toFixed(2) });
      const result = await handleTap({
        target: registryMatch.value,
        by: registryMatch.by as any,
        index: 0,
        timeout: 10,
        screenshot: params.screenshot,
      });
      const matchInfo = `Matched "${params.description}" → ${registryMatch.by}:${registryMatch.value} (registry fast path, confidence: ${(registryMatch.score * 100).toFixed(0)}%)\n`;
      return {
        content: [
          { type: 'text' as const, text: matchInfo },
          ...result.content,
        ],
      };
    }

    // Full scan path. Prefer the key-aware Dart VM widget tree (one WebSocket
    // round trip, cached until the screen changes) over the Appium XML scan,
    // which cannot see ValueKeys at all. Falls back automatically when there's
    // no VM (release build) or we're in a WebView context.
    let { elements, source: elementSource } = await getScreenElements();
    if (elements.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: true, message: 'No interactive elements found on screen.' }),
        }],
      };
    }

    // Fuzzy match against description
    let match = findBestMatch(params.description, elements);

    // Native fallback: the VM tree sees Flutter widgets only. A weak match can
    // mean the target is a native control (system dialog, permission prompt),
    // which only the Appium page source enumerates — so widen the search there
    // before giving up. Never narrows coverage vs. the old page-source-only path.
    if (elementSource === 'vm' && (!match || match.score < 0.6)) {
      try {
        const nativeElements = await pageSourceScan();
        const nativeMatch = findBestMatch(params.description, nativeElements);
        if (nativeMatch && nativeMatch.score > (match?.score ?? 0)) {
          logger.info('smart_tap: native page-source match beat VM tree', {
            vmScore: match?.score ?? 0,
            nativeScore: nativeMatch.score,
          });
          match = nativeMatch;
          elements = nativeElements;
          elementSource = 'pageSource';
        }
      } catch (nativeError) {
        logger.debug('Native fallback scan failed (non-critical)', { error: String(nativeError) });
      }
    }

    // WebView fallback: if no good match in Flutter/native AND WebViews exist, scan them
    if ((!match || match.score < 0.6)) {
      try {
        const webviews = await getWebViewContexts();
        if (webviews.length > 0) {
          logger.info('smart_tap: weak Flutter match, trying WebView fallback', { flutterScore: match?.score ?? 0, webviews: webviews.length });
          const webViewElements: InteractiveElement[] = [];
          const scanResults = await Promise.allSettled(
            webviews.map(wv => scanWebViewInteractiveElements(wv, elements.length + webViewElements.length)),
          );
          for (const result of scanResults) {
            if (result.status === 'fulfilled') {
              webViewElements.push(...result.value);
            }
          }
          if (webViewElements.length > 0) {
            const webViewMatch = findBestMatch(params.description, webViewElements);
            if (webViewMatch && webViewMatch.score > (match?.score ?? 0)) {
              match = webViewMatch;
              logger.info('smart_tap: WebView match found', { element: `${match.element.locator.by}:${match.element.locator.value}`, score: match.score });
              // Register WebView elements for future O(1) lookup
              const elemRegistry = getRegistry();
              for (const el of webViewElements) {
                if (el.context) elemRegistry.registerElement(el.context, el.locator.by, el.locator.value);
              }
            }
          }
        }
      } catch (wvError) {
        logger.debug('WebView fallback scan failed (non-critical)', { error: String(wvError) });
      }
    }

    // NOT-FOUND GUARD. findBestMatch has a 0.4 floor and always returns its
    // least-bad candidate, so when the target is absent from the element list it
    // taps something else with confident-looking scores instead of failing.
    // Live 2026-08-01: "Book button" matched apb_today_button at 77% and tapped
    // Today — the Book control was missing from the tree's interactive list
    // (no key, and its label was never propagated onto the tappable ancestor).
    // A wrong action with no error is the worst outcome; veto it.
    if (match && !matchesDistinctiveToken(
      params.description, match.element.text, match.element.locator?.value, match.element.type,
    )) {
      logger.info('smart_tap: vetoed weak match — no distinctive token in common', {
        description: params.description,
        rejected: `${match.element.locator.by}:${match.element.locator.value}`,
        score: match.score,
      });
      match = null;
    }

    // TEXT FALLBACK. An interactive element with no key and no propagated label
    // is invisible to description matching, yet still perfectly findable by its
    // on-screen text (Book: absent from the element list, but find_elements by
    // text returns it immediately). Try the description's distinctive words
    // directly before giving up.
    if (!match) {
      for (const token of distinctiveSearchTerms(params.description)) {
        try {
          const found = await browser.findElements('-flutter text', token);
          if (found.length === 1) {
            logger.info('smart_tap: resolved via text fallback', { description: params.description, token });
            const result = await handleTap({
              target: token, by: 'text', index: 0, timeout: 10, screenshot: params.screenshot,
            });
            return {
              content: [
                { type: 'text' as const, text:
                  `Matched "${params.description}" → text:${token} (text fallback — the control is not in the widget tree's interactive list, so it has no ValueKey AND no propagated label; worth filing as an automation gap)\n` },
                ...result.content,
              ],
            };
          }
        } catch { /* try the next token */ }
      }
    }

    if (!match) {
      const compact = formatElementsCompact(elements);
      const noMatchText = `No element matching "${params.description}" found.\n\nAvailable elements:\n${compact}`;
      return {
        content: [{ type: 'text' as const, text: noMatchText }],
      };
    }

    // Tap the matched element (context-aware: CSS locators from WebView will route correctly)
    const result = await handleTap({
      target: match.element.locator.value,
      by: match.element.locator.by as any,
      index: 0,
      timeout: 10,
      screenshot: params.screenshot,
    });

    // Prepend match info to the response
    const ctxTag = match.element.context?.startsWith('WEBVIEW') ? ' [webview]' : '';
    const matchInfo = `Matched "${params.description}" → ${match.element.locator.by}:${match.element.locator.value} (${match.element.type}${match.element.text ? ` "${match.element.text}"` : ''}${ctxTag}, confidence: ${(match.score * 100).toFixed(0)}%)\n`;

    // ValueKey-first discipline: when the VM tree proves the widget has no key,
    // say so explicitly instead of silently shipping a text/type fallback —
    // silent fallbacks are how ValueKey gaps stay invisible.
    const keyGap = describeKeyGap(match.element, elementSource);

    return {
      content: [
        { type: 'text' as const, text: keyGap ? `${matchInfo}${keyGap}\n` : matchInfo },
        ...result.content,
      ],
    };
  } catch (error) {
    const msg = `smart_tap failed for "${params.description}": ${String(error)}`;
    logger.error(msg);
    let scanBlocks: McpToolResponse['content'] = [];
    try { scanBlocks = await autoScanElementsOnly(); } catch { /* non-critical */ }
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ error: true, message: msg }) },
        ...scanBlocks,
      ],
    };
  }
}

/** Type hint words in description → matching element types */
const TYPE_HINT_MAP: Record<string, Set<string>> = {
  button: new Set(['TextButton', 'ElevatedButton', 'OutlinedButton', 'IconButton', 'FloatingActionButton', 'FilledButton']),
  field: new Set(['TextField', 'TextFormField', 'AutoSizeTextField']),
  input: new Set(['TextField', 'TextFormField', 'AutoSizeTextField', 'SearchBar']),
  link: new Set(['TextButton']),
  switch: new Set(['Switch']),
  checkbox: new Set(['Checkbox']),
  dropdown: new Set(['DropdownButton', 'DropdownMenu', 'PopupMenuButton']),
  tab: new Set(['Tab']),
  card: new Set(['Card', 'ListTile', 'AppointmentCard', 'GuestCard', 'ServiceCard']),
  icon: new Set(['Icon', 'IconButton', 'ImageIcon']),
  search: new Set(['SearchBar', 'SearchAnchor']),
};

/**
 * Fuzzy similarity against a ValueKey is discounted relative to visible text —
 * see the comment at its use site. 0.85 keeps key matching useful when an
 * element has no text at all (icon buttons), while ensuring any real text match
 * outranks a coincidental key-token overlap.
 */
const KEY_SIMILARITY_WEIGHT = 0.85;

function findBestMatch(
  description: string,
  elements: InteractiveElement[],
): { element: InteractiveElement; score: number } | null {
  let bestMatch: { element: InteractiveElement; score: number } | null = null;
  const descLower = description.toLowerCase();

  // Detect type hints in description for bonus scoring
  const descWords = descLower.split(/\s+/);
  const matchingTypeHints = new Set<string>();
  for (const word of descWords) {
    const types = TYPE_HINT_MAP[word];
    if (types) {
      for (const t of types) matchingTypeHints.add(t);
    }
  }

  for (const el of elements) {
    let maxScore = 0;

    // Score against text (using enhanced similarity with substring awareness)
    if (el.text) {
      maxScore = Math.max(maxScore, enhancedSimilarity(descLower, el.text.toLowerCase()));
    }

    // Score against locator value, DISCOUNTED.
    //
    // Since elements are sourced from the VM tree, locator.value is usually the
    // ValueKey — and key strings share heavy boilerplate ("apb_", "_button",
    // "_day_"), so a human phrase scores almost as well against the WRONG key as
    // the right one. Live regression: "today button" matched
    // apb_prev_day_button over apb_today_button and tapped the wrong control.
    // Text is the human-facing label and must win; an explicit key mention is
    // still handled at full strength by the containment boost below.
    if (el.locator?.value) {
      maxScore = Math.max(maxScore, enhancedSimilarity(descLower, el.locator.value.toLowerCase()) * KEY_SIMILARITY_WEIGHT);
    }

    // Score against type (reduced weight — type alone is weak signal)
    maxScore = Math.max(maxScore, enhancedSimilarity(descLower, el.type.toLowerCase()) * 0.5);

    // Boost if description contains the text or locator value
    if (el.text && descLower.includes(el.text.toLowerCase())) {
      maxScore = Math.max(maxScore, 0.85);
    }
    if (el.locator?.value && descLower.includes(el.locator.value.toLowerCase())) {
      maxScore = Math.max(maxScore, 0.85);
    }

    // Type-aware bonus: "book button" + element is TextButton → +0.15
    if (matchingTypeHints.size > 0 && matchingTypeHints.has(el.type)) {
      maxScore = Math.min(1.0, maxScore + 0.15);
    }

    // Strictly-greater means the FIRST element to reach a score keeps it, so a
    // near-tie is decided by tree order — which is arbitrary. Break ties toward
    // the element that has visible text: it is the human-facing label, and the
    // description came from a human.
    if (bestMatch === null) {
      if (maxScore > 0.4) bestMatch = { element: el, score: maxScore };
      continue;
    }

    const prevScore = bestMatch.score;
    const prevHasText = !!bestMatch.element.text;
    const isTie = Math.abs(maxScore - prevScore) < 0.02;

    if (maxScore > prevScore || (isTie && !!el.text && !prevHasText)) {
      bestMatch = { element: el, score: Math.max(maxScore, prevScore) };
    }
  }

  return bestMatch;
}

// --- Batch Actions Tool ---

const batchActionItemSchema = z.object({
  action: z.enum(['tap', 'type_text', 'gesture', 'wait_for']).describe('Action to perform'),
  params: z.record(z.unknown()).describe('Parameters for the action (same as the individual tool params)'),
});

export const batchActionsSchema = z.object({
  actions: z.array(batchActionItemSchema).min(1).max(20).describe('Array of actions to execute in sequence'),
  screenshot: z.boolean().optional().default(true).describe('Return screenshot after the LAST action only'),
  stopOnFailure: z.boolean().optional().default(true).describe('Stop executing on first failure'),
});

/**
 * Execute multiple actions in sequence, returning only the final screen state.
 * Reduces N tool calls to 1.
 */
export async function handleBatchActions(params: z.infer<typeof batchActionsSchema>): Promise<McpToolResponse> {
  const results: string[] = [];
  let lastError: string | null = null;

  batchDepth++;
  try {
  for (let i = 0; i < params.actions.length; i++) {
    const item = params.actions[i];
    const stepLabel = `Step ${i + 1}/${params.actions.length}: ${item.action}`;

    try {
      let result: McpToolResponse;
      switch (item.action) {
        case 'tap':
          result = await handleTap({
            ...item.params as any,
            screenshot: false, // Skip intermediate screenshots
          });
          break;
        case 'type_text':
          result = await handleTypeText({
            ...item.params as any,
            screenshot: false,
          });
          break;
        case 'gesture':
          result = await handleGesture({
            ...item.params as any,
            screenshot: false,
          });
          break;
        case 'wait_for':
          result = await handleWaitFor({
            ...item.params as any,
            screenshot: false,
          });
          break;
        default:
          results.push(`${stepLabel}: skipped (unknown action)`);
          continue;
      }

      // Check if action returned an error
      const textContent = result.content.find(c => c.type === 'text');
      const text = textContent && 'text' in textContent ? textContent.text : '';
      const isError = text.includes('"error":true') || text.includes('"error": true');

      if (isError && params.stopOnFailure) {
        lastError = text;
        results.push(`${stepLabel}: FAILED — ${text.slice(0, 100)}`);
        break;
      }

      results.push(`${stepLabel}: OK`);
    } catch (error) {
      lastError = String(error);
      results.push(`${stepLabel}: FAILED — ${lastError.slice(0, 100)}`);
      if (params.stopOnFailure) break;
    }
  }
  } finally {
    batchDepth--;
  }

  // Final screen state
  const browser = await getBrowserWithReconnect();
  const extra = await screenshotContent(browser, params.screenshot);
  const scanBlocks = await autoScanElementsOnly();

  const summary = results.join('\n');
  const status = lastError ? 'completed with errors' : 'all steps passed';

  return {
    content: [
      {
        type: 'text' as const,
        text: `Batch: ${status} (${results.length}/${params.actions.length} steps)\n${summary}`,
      },
      ...extra,
      ...scanBlocks,
    ],
  };
}

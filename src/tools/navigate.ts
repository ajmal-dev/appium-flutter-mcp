import { z } from 'zod';
import {
  switchContext, invalidateContextsListCache,
  snapshotWebViewIds, waitForNewWebViewByUrl, waitForWebViewContentReady,
  switchToContextById,
} from '../context/context-manager.js';
import { getPageSource, executeJavaScript, getCurrentUrl } from '../context/webview-inspector.js';
import { getNativePageSource, getNativeElementsStructured } from '../context/native-inspector.js';
import { invalidateCache } from '../tree/tree-builder.js';
import { recordAction, isRecording } from '../recording/recorder.js';
import {
  getCurrentAppId, getCurrentScreenId, getScreenByName,
  findNavigationPath, loadAllScreenMaps, recordScreen,
} from '../context/screen-map-store.js';
import { pageSourceScan, scanWebViewInteractiveElementsDetailed } from '../tree/page-source-scanner.js';
import { getRegistry } from '../context/element-registry.js';
import { getBrowserWithReconnect, getSessionMode } from '../appium/session.js';
import { autoScanElementsOnly } from '../util/auto-scan.js';
import { formatElementsCompact } from '../util/element-format.js';
import { logger } from '../util/logger.js';
import type { McpToolResponse } from '../types.js';

// ── web_navigate: Safari-mode URL loader (NEW tool, no existing behavior touched) ──

export const webNavigateSchema = z.object({
  url: z.string().describe('Absolute URL to load in the Safari browser session (e.g. "https://example.com").'),
  waitFor: z.enum(['load', 'domcontentloaded']).optional().default('load')
    .describe('When to consider navigation complete. "load" waits for full page load; "domcontentloaded" is faster.'),
  timeoutMs: z.number().optional().default(30000).describe('Max wait for the page to become ready (ms).'),
});

export async function handleWebNavigate(
  params: z.infer<typeof webNavigateSchema>,
): Promise<McpToolResponse> {
  const mode = getSessionMode();
  if (mode !== 'safari') {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: true,
          message: `web_navigate is only available in Safari sessions. Current sessionMode = "${mode}". Reconnect with capabilities: { "appium:browserName": "Safari", "appium:automationName": "XCUITest" }.`,
        }, null, 2),
      }],
    };
  }
  const browser = await getBrowserWithReconnect();
  const t0 = Date.now();
  try {
    await browser.url(params.url);
    // Best-effort readiness gate: poll document.readyState via WebDriver script API
    const deadline = t0 + Math.max(1000, params.timeoutMs);
    const target = params.waitFor === 'domcontentloaded' ? ['interactive', 'complete'] : ['complete'];
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const state = await browser.execute('return document.readyState;') as string;
        if (target.includes(state)) { ready = true; break; }
      } catch { /* pre-page-load execute can throw; keep polling */ }
      await new Promise(r => setTimeout(r, 200));
    }
    const finalUrl = await browser.getUrl().catch(() => params.url);
    const title = await browser.getTitle().catch(() => '');
    logger.info('web_navigate complete', { url: params.url, finalUrl, ready, elapsedMs: Date.now() - t0 });
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: ready ? 'loaded' : 'timeout_but_navigated',
          url: finalUrl,
          title,
          waitFor: params.waitFor,
          elapsedMs: Date.now() - t0,
        }, null, 2),
      }],
    };
  } catch (err) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: true,
          message: `Navigation to "${params.url}" failed: ${String(err)}`,
          elapsedMs: Date.now() - t0,
        }, null, 2),
      }],
    };
  }
}

export const switchContextSchema = z.object({
  to: z.enum(['flutter', 'webview', 'native']).describe('Target context'),
  waitTimeout: z.number().optional().default(10).describe('Timeout in seconds to wait for WebView context (use ~30 with waitForNew)'),
  webviewId: z.string().optional().describe('Specific WebView context ID to switch to (e.g. "WEBVIEW_2335.13"). If omitted, uses the most recently active or newest WebView.'),
  urlFragment: z.string().optional().describe('URL fragment to match when switching to webview (e.g. "/appointmentbook"). Uses mobile:getContexts metadata to find the correct webview WITHOUT switching to wrong ones. Preferred for multi-webview apps.'),
  waitForNew: z.boolean().optional().default(false)
    .describe('Wait for a NEWLY-spawned webview matching urlFragment: snapshots existing webview IDs first and ignores them (skips stale "about:blank" preloaded contexts). Use right after the action that opens the webview. Requires urlFragment.'),
  preExistingIds: z.array(z.string()).optional()
    .describe('Explicit webview IDs to exclude when waiting for a new webview (overrides the automatic snapshot).'),
  contentPredicate: z.string().optional()
    .describe('JS expression that must become truthy after switching to the webview (e.g. "document.querySelectorAll(\'input\').length > 0" for forms). Defaults to a readyState check when waitForNew is set.'),
  contentTimeoutSeconds: z.number().optional().default(30)
    .describe('How long to wait for contentPredicate to become truthy.'),
});

export const inspectWebviewSchema = z.object({
  action: z.enum(['elements', 'page_source', 'execute_js', 'get_url']).describe('WebView inspection action'),
  script: z.string().optional().describe('JavaScript to execute (for execute_js action)'),
  selector: z.string().optional().describe('elements action only: extra CSS selector to include beyond the default interactive set (e.g. ".b-sch-event" for Bryntum appointment cards)'),
});

export const inspectNativeSchema = z.object({
  format: z.enum(['structured', 'raw_xml']).optional().default('structured')
    .describe('Output format: "structured" returns parsed JSON elements (recommended), "raw_xml" returns full XML page source'),
});

export const inspectSchema = z.object({
  target: z.enum(['webview', 'native']).describe('Which layer to inspect: "webview" (interactive elements / HTML DOM / JS / URL) or "native" (accessibility tree).'),
  action: z.enum(['elements', 'page_source', 'execute_js', 'get_url']).optional().default('elements')
    .describe('WebView only: "elements" (default) returns a compact numbered list of interactive DOM elements with CSS selectors — use this first. "page_source" returns the HTML DOM stripped of scripts/styles and capped (a large page can otherwise exceed 100k tokens). "execute_js" runs the script param. "get_url" returns the current URL.'),
  script: z.string().optional().describe('WebView only: JavaScript to execute (for action="execute_js")'),
  selector: z.string().optional().describe('WebView elements action only: extra CSS selector to scan beyond the default interactive set (e.g. ".b-sch-event" for Bryntum appointment cards).'),
  format: z.enum(['structured', 'raw_xml']).optional().default('structured')
    .describe('Native only: "structured" returns parsed JSON elements (recommended), "raw_xml" returns full XML page source.'),
});

export async function handleInspect(params: z.infer<typeof inspectSchema>): Promise<McpToolResponse> {
  return params.target === 'webview'
    ? handleInspectWebview({ action: params.action ?? 'elements', script: params.script, selector: params.selector })
    : handleInspectNative({ format: params.format ?? 'structured' });
}

export async function handleSwitchContext(params: z.infer<typeof switchContextSchema>): Promise<McpToolResponse> {
  // Absorbed wait_for_webview: waiting semantics for newly-spawned / content-gated webviews
  if (params.to === 'webview' && (params.waitForNew || params.contentPredicate || params.preExistingIds)) {
    if (!params.urlFragment) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: true, message: 'urlFragment is required when using waitForNew / contentPredicate / preExistingIds.' }),
        }],
      };
    }
    return handleWaitForWebview({
      urlFragment: params.urlFragment,
      excludeStale: params.waitForNew ?? false,
      preExistingIds: params.preExistingIds,
      switchTo: true,
      contentPredicate: params.contentPredicate,
      contentTimeoutSeconds: params.contentTimeoutSeconds ?? 30,
      timeoutSeconds: params.waitTimeout && params.waitTimeout > 10 ? params.waitTimeout : 30,
    });
  }

  invalidateContextsListCache(); // Force fresh context list for explicit switches
  const info = await switchContext(params.to, params.waitTimeout, params.webviewId, params.urlFragment);
  invalidateCache();

  // Record context switch if recording is active
  if (isRecording()) {
    recordAction('switch_context', { to: params.to }, params.to);
  }

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ switched: true, current: info.current, available: info.available }, null, 2),
    }],
  };
}

/** Cap for stripped page_source output — beyond this the DOM dump stops informing and starts flooding. */
const PAGE_SOURCE_MAX_CHARS = 60_000;

/**
 * Strip the payload-heavy, locator-irrelevant parts of an HTML dump:
 * script/style/svg bodies, HTML comments, data: URIs, collapsed whitespace.
 * Measured live on the ZMA calendar webview: 471KB raw → far under the cap.
 */
function stripHtmlForInspection(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '<script/>')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '<style/>')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '<svg/>')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(src|href|xlink:href)="data:[^"]{100,}"/gi, '$1="data:…"')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

export async function handleInspectWebview(params: z.infer<typeof inspectWebviewSchema>): Promise<McpToolResponse> {
  // Record webview action if recording is active
  if (isRecording()) {
    recordAction('webview_action', { action: params.action, script: params.script }, 'webview');
  }

  switch (params.action) {
    case 'elements': {
      // Compact interactive-element view — the webview counterpart of
      // get_widget_tree. Ensures a real-page webview is active first.
      const current = await getCurrentContextSafe();
      const contextId = current.startsWith('WEBVIEW')
        ? current
        : await switchToWebViewRanked();
      const scan = await scanWebViewInteractiveElementsDetailed(contextId, 0, {
        selector: params.selector,
        timeoutMs: 5000,
      });
      if (scan.elements.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No interactive elements found in ${contextId}${params.selector ? ` (selector: ${params.selector})` : ''}. If the page is still loading, wait_for stability and retry; or pass a custom selector.`,
          }],
        };
      }
      const bounds = getRegistry().regions.get(contextId)?.bounds;
      const header = [
        `WebView ${contextId} — ${scan.elements.length} interactive elements${scan.truncated ? ` (of ${scan.total} — TRUNCATED, narrow with a selector)` : ''}`,
        bounds ? `Webview bounds on device: (${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}) — element (x,y) are CSS px relative to the webview viewport; add bounds offset for device-coordinate taps.` : '',
        `Tap via: tap({by: "css", target: "<selector>"})`,
      ].filter(Boolean).join('\n');
      return {
        content: [{
          type: 'text' as const,
          text: `${header}\n\n${formatElementsCompact(scan.elements)}`,
        }],
      };
    }
    case 'page_source': {
      const source = await getPageSource();
      const stripped = stripHtmlForInspection(source);
      const truncated = stripped.length > PAGE_SOURCE_MAX_CHARS;
      const body = truncated ? stripped.slice(0, PAGE_SOURCE_MAX_CHARS) : stripped;
      const note = truncated
        ? `\n\n[TRUNCATED at ${PAGE_SOURCE_MAX_CHARS} chars — full stripped size ${stripped.length}. Prefer action:"elements" or a targeted execute_js instead of reading raw HTML.]`
        : '';
      return {
        content: [{ type: 'text' as const, text: `WebView Page Source (scripts/styles stripped):\n${body}${note}` }],
      };
    }
    case 'execute_js': {
      if (!params.script) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: true, message: 'script parameter required for execute_js action' }),
          }],
        };
      }
      const { result, context } = await executeJavaScript(params.script);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ result, context }, null, 2) }],
      };
    }
    case 'get_url': {
      const url = await getCurrentUrl();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ url }) }],
      };
    }
  }
}

async function getCurrentContextSafe(): Promise<string> {
  try {
    const { getCurrentContext } = await import('../context/context-manager.js');
    return await getCurrentContext();
  } catch {
    return 'NATIVE_APP';
  }
}

async function switchToWebViewRanked(): Promise<string> {
  const { switchToWebView } = await import('../context/context-manager.js');
  return switchToWebView(10);
}

export async function handleInspectNative(params: z.infer<typeof inspectNativeSchema>): Promise<McpToolResponse> {
  if (params.format === 'raw_xml') {
    const source = await getNativePageSource();
    return {
      content: [{ type: 'text' as const, text: `Native Page Source (XML):\n${source}` }],
    };
  }

  // Structured format — parsed accessibility tree as JSON (recommended for AI)
  const elements = await getNativeElementsStructured();
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        context: 'NATIVE_APP',
        elementCount: elements.length,
        elements,
      }, null, 2),
    }],
  };
}

// --- WebView lifecycle helpers (mirrors zmauiautomation patterns) ---

export const waitForWebviewSchema = z.object({
  urlFragment: z.string().describe('Substring to match in the webview URL (e.g. "/appointmentbook", "AppointmentCustomDataV2.aspx").'),
  excludeStale: z.boolean().optional().default(true).describe('When true (default), snapshot existing webview IDs first and ignore them — only return a NEWLY-spawned matching webview. Set false to allow matching any existing webview.'),
  preExistingIds: z.array(z.string()).optional().describe('Optional explicit list of webview IDs to exclude. Overrides excludeStale=true behaviour. Use when you snapshotted IDs at a specific earlier moment.'),
  switchTo: z.boolean().optional().default(true).describe('When true (default), switch to the matched webview after finding it. Set false to only return the ID.'),
  contentPredicate: z.string().optional().describe('Optional JS expression that must become truthy after switching. Defaults to a generic readyState check; pass `"document.querySelectorAll(\'input\').length > 0"` for forms.'),
  contentTimeoutSeconds: z.number().optional().default(30).describe('How long to wait for `contentPredicate` to become truthy after switching.'),
  timeoutSeconds: z.number().optional().default(30).describe('How long to wait for the matching webview to appear.'),
});

export async function handleWaitForWebview(params: z.infer<typeof waitForWebviewSchema>): Promise<McpToolResponse> {
  let exclude: ReadonlySet<string> | undefined;
  if (params.preExistingIds && params.preExistingIds.length > 0) {
    exclude = new Set(params.preExistingIds);
  } else if (params.excludeStale) {
    exclude = await snapshotWebViewIds();
  }

  let matchedId: string;
  try {
    matchedId = await waitForNewWebViewByUrl({
      urlFragment: params.urlFragment,
      excludeIds: exclude,
      timeoutSeconds: params.timeoutSeconds,
    });
  } catch (e) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: true,
          message: String(e instanceof Error ? e.message : e),
          excludedIdCount: exclude?.size ?? 0,
        }),
      }],
    };
  }

  if (!params.switchTo) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ matchedId, switched: false, excludedIdCount: exclude?.size ?? 0 }),
      }],
    };
  }

  try {
    await switchToContextById(matchedId);
  } catch (e) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: true, matchedId, switched: false, message: `Found webview ${matchedId} but switch failed: ${String(e)}` }),
      }],
    };
  }

  if (isRecording()) {
    recordAction('switch_context', { to: 'webview', urlFragment: params.urlFragment, matchedId }, 'webview');
  }

  let contentReady = false;
  let contentError: string | undefined;
  try {
    await waitForWebViewContentReady({
      predicateJs: params.contentPredicate,
      timeoutSeconds: params.contentTimeoutSeconds,
    });
    contentReady = true;
  } catch (e) {
    contentError = String(e instanceof Error ? e.message : e);
  }

  invalidateCache();
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        matchedId,
        switched: true,
        contentReady,
        contentError,
        excludedIdCount: exclude?.size ?? 0,
      }, null, 2),
    }],
  };
}

export const webviewFillFormSchema = z.object({
  fields: z.array(z.object({
    label: z.string().describe('Visible label text. Matched case-insensitive, trimmed; first label whose textContent contains the value wins.'),
    value: z.string().describe('Value to set on the input/textarea/select that follows or is associated with the label.'),
  })).min(1).describe('One or more {label, value} pairs to fill.'),
  selectorHints: z.object({
    labelSelector: z.string().optional().describe('CSS selector for label-bearing elements. Default: "label, td, th, span, div".'),
    inputSelector: z.string().optional().describe('CSS selector for input-bearing elements. Default: "input, textarea, select".'),
  }).optional(),
  dispatchEvents: z.boolean().optional().default(true).describe('Dispatch input + change events after setting value (most React/Angular forms need this).'),
});

export async function handleWebviewFillForm(params: z.infer<typeof webviewFillFormSchema>): Promise<McpToolResponse> {
  // Run a single JS pass that walks the DOM, matches labels, sets values,
  // and reports per-field outcome. Mirrors zmauiautomation's fillFieldByLabel.
  const labelSel = params.selectorHints?.labelSelector ?? 'label, td, th, span, div';
  const inputSel = params.selectorHints?.inputSelector ?? 'input, textarea, select';
  const dispatch = params.dispatchEvents !== false;

  const script = `
    var fields = ${JSON.stringify(params.fields)};
    var labelSel = ${JSON.stringify(labelSel)};
    var inputSel = ${JSON.stringify(inputSel)};
    var dispatch = ${JSON.stringify(dispatch)};

    function findInputForLabel(labelEl) {
      // 1) <label for="ID">
      if (labelEl.tagName === 'LABEL' && labelEl.htmlFor) {
        var byId = document.getElementById(labelEl.htmlFor);
        if (byId) return byId;
      }
      // 2) input nested inside the label
      var nested = labelEl.querySelector(inputSel);
      if (nested) return nested;
      // 3) closest table row's input
      var row = labelEl.closest('tr');
      if (row) {
        var rowInput = row.querySelector(inputSel);
        if (rowInput) return rowInput;
      }
      // 4) next siblings within the same parent
      var sib = labelEl.nextElementSibling;
      while (sib) {
        if (sib.matches && sib.matches(inputSel)) return sib;
        var inside = sib.querySelector ? sib.querySelector(inputSel) : null;
        if (inside) return inside;
        sib = sib.nextElementSibling;
      }
      // 5) parent's first input
      var parent = labelEl.parentElement;
      if (parent) {
        var inParent = parent.querySelector(inputSel);
        if (inParent) return inParent;
      }
      return null;
    }

    function setInputValue(input, value) {
      if (input.tagName === 'SELECT') {
        var opts = input.options;
        for (var i = 0; i < opts.length; i++) {
          if (opts[i].textContent.trim() === value || opts[i].value === value) {
            input.selectedIndex = i;
            return true;
          }
        }
        return false;
      }
      // Use native setter so React's controlled inputs notice the change
      try {
        var proto = Object.getPrototypeOf(input);
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) { desc.set.call(input, value); }
        else { input.value = value; }
      } catch (e) {
        input.value = value;
      }
      return true;
    }

    var labels = document.querySelectorAll(labelSel);
    var results = [];
    for (var f = 0; f < fields.length; f++) {
      var target = (fields[f].label || '').trim().toLowerCase();
      var matched = null;
      for (var i = 0; i < labels.length; i++) {
        var t = (labels[i].textContent || '').trim().toLowerCase();
        if (!t) continue;
        if (t === target || t.indexOf(target) >= 0) { matched = labels[i]; break; }
      }
      if (!matched) {
        results.push({ label: fields[f].label, ok: false, reason: 'label not found' });
        continue;
      }
      var input = findInputForLabel(matched);
      if (!input) {
        results.push({ label: fields[f].label, ok: false, reason: 'no input near label', labelText: matched.textContent.trim().slice(0,80) });
        continue;
      }
      var ok = setInputValue(input, fields[f].value);
      if (!ok) {
        results.push({ label: fields[f].label, ok: false, reason: 'select option not found' });
        continue;
      }
      if (dispatch) {
        try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
        try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
      }
      results.push({ label: fields[f].label, ok: true, inputType: (input.tagName + (input.type ? ':' + input.type : '')).toLowerCase() });
    }
    return JSON.stringify(results);
  `;

  let raw: unknown;
  try {
    raw = (await executeJavaScript(script)).result;
  } catch (e) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: true, message: `Form-fill JS execution failed: ${String(e instanceof Error ? e.message : e)}. Make sure you are inside the right WEBVIEW context.` }),
      }],
    };
  }

  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { /* keep raw string */ }
  }

  if (isRecording()) {
    recordAction('webview_action', { action: 'fill_form', fieldCount: params.fields.length, results: parsed }, 'webview');
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ results: parsed }, null, 2) }],
  };
}

// --- Navigate To Tool ---

export const navigateToSchema = z.object({
  screen: z.string().describe('Target screen name (e.g., "Dashboard", "Guest Profile"). Must be a previously discovered screen.'),
});

/**
 * Navigate to a target screen using the persistent navigation graph.
 * BFS finds the shortest path from current screen to target, then executes each tap.
 */
export async function handleNavigateTo(params: z.infer<typeof navigateToSchema>): Promise<McpToolResponse> {
  const appId = getCurrentAppId();
  if (!appId) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: true, message: 'No app connected. Call connect first.' }),
      }],
    };
  }

  // Find target screen
  const targetScreen = getScreenByName(appId, params.screen);
  if (!targetScreen) {
    const allScreens = loadAllScreenMaps(appId);
    const available = allScreens.map(s =>
      s.aliases?.length ? `"${s.name}" (aka ${s.aliases.join(', ')})` : `"${s.name}"`
    ).join(', ');
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: true,
          message: `Screen "${params.screen}" not found.`,
          availableScreens: available || 'None — explore the app first to build the navigation map.',
        }),
      }],
    };
  }

  // Identify current screen (structural similarity match-or-create)
  let currentScreenId = getCurrentScreenId();
  if (!currentScreenId) {
    try {
      const elements = await pageSourceScan();
      currentScreenId = recordScreen(appId, elements)?.screenId ?? null;
    } catch {
      currentScreenId = null;
    }
    if (!currentScreenId) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: true, message: 'Could not identify current screen.' }),
        }],
      };
    }
  }

  // Already there?
  if (currentScreenId === targetScreen.screenId) {
    const compact = formatElementsCompact(targetScreen.elements);
    return {
      content: [{
        type: 'text' as const,
        text: `Already on "${targetScreen.name}".\n\n${compact}`,
      }],
    };
  }

  // Find path
  const path = findNavigationPath(appId, currentScreenId, targetScreen.screenId);
  if (!path || path.length === 0) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: true,
          message: `No known navigation path from current screen to "${targetScreen.name}". Explore more of the app to build the navigation graph.`,
        }),
      }],
    };
  }

  // Execute navigation steps
  const browser = await getBrowserWithReconnect();
  const steps: string[] = [];

  try {
    const { handleTap } = await import('./act.js');

    for (let i = 0; i < path.length; i++) {
      const step = path[i];
      steps.push(`Step ${i + 1}: tap ${step.action.by}="${step.action.value}"`);

      // Execute tap
      await handleTap({
        target: step.action.value,
        by: step.action.by as any,
        index: 0,
        timeout: 10,
        screenshot: false, // Skip intermediate screenshots for speed
      });

      // Brief wait for transition
      await new Promise(r => setTimeout(r, 500));
    }

    // Final scan of destination screen
    const scanBlocks = await autoScanElementsOnly();

    return {
      content: [
        {
          type: 'text' as const,
          text: `Navigated to "${targetScreen.name}" in ${path.length} step(s):\n${steps.join('\n')}`,
        },
        ...scanBlocks,
      ],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: true,
          message: `Navigation failed at step ${steps.length + 1}: ${String(error)}`,
          completedSteps: steps,
        }),
      }],
    };
  }
}

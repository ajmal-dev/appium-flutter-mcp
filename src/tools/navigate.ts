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
  findNavigationPath, loadAllScreenMaps, generateFingerprint,
} from '../context/screen-map-store.js';
import { pageSourceScan } from '../tree/page-source-scanner.js';
import { getBrowserWithReconnect } from '../appium/session.js';
import { autoScanElementsOnly } from '../util/auto-scan.js';
import { formatElementsCompact } from '../util/element-format.js';
import { logger } from '../util/logger.js';
import type { McpToolResponse } from '../types.js';

export const switchContextSchema = z.object({
  to: z.enum(['flutter', 'webview', 'native']).describe('Target context'),
  waitTimeout: z.number().optional().default(10).describe('Timeout in seconds to wait for WebView context'),
  webviewId: z.string().optional().describe('Specific WebView context ID to switch to (e.g. "WEBVIEW_2335.13"). If omitted, uses the most recently active or newest WebView.'),
  urlFragment: z.string().optional().describe('URL fragment to match when switching to webview (e.g. "/appointmentbook"). Uses mobile:getContexts metadata to find the correct webview WITHOUT switching to wrong ones. Preferred for multi-webview apps.'),
});

export const inspectWebviewSchema = z.object({
  action: z.enum(['page_source', 'execute_js', 'get_url']).describe('WebView inspection action'),
  script: z.string().optional().describe('JavaScript to execute (for execute_js action)'),
});

export const inspectNativeSchema = z.object({
  format: z.enum(['structured', 'raw_xml']).optional().default('structured')
    .describe('Output format: "structured" returns parsed JSON elements (recommended), "raw_xml" returns full XML page source'),
});

export async function handleSwitchContext(params: z.infer<typeof switchContextSchema>): Promise<McpToolResponse> {
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

export async function handleInspectWebview(params: z.infer<typeof inspectWebviewSchema>): Promise<McpToolResponse> {
  // Record webview action if recording is active
  if (isRecording()) {
    recordAction('webview_action', { action: params.action, script: params.script }, 'webview');
  }

  switch (params.action) {
    case 'page_source': {
      const source = await getPageSource();
      return {
        content: [{ type: 'text' as const, text: `WebView Page Source:\n${source}` }],
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
      const result = await executeJavaScript(params.script);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ result }, null, 2) }],
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

// --- WebView lifecycle helpers ---

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
  // and reports per-field outcome.
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
    raw = await executeJavaScript(script);
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
    const available = allScreens.map(s => `"${s.name}"`).join(', ');
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

  // Identify current screen
  let currentScreenId = getCurrentScreenId();
  if (!currentScreenId) {
    try {
      const elements = await pageSourceScan();
      currentScreenId = generateFingerprint(elements);
    } catch {
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

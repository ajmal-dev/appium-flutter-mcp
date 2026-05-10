import { z } from 'zod';
import { getBrowser, getBrowserWithReconnect } from '../appium/session.js';
import { captureScreenshot } from '../util/screenshot.js';
import { buildWidgetTree } from '../tree/tree-builder.js';
import { pageSourceScan } from '../tree/page-source-scanner.js';
import { getElementDiagnostics } from '../tree/diagnostics.js';
import { logger } from '../util/logger.js';
import { recordAction, isRecording } from '../recording/recorder.js';
import { formatElementsCompact, formatElementsSummaryLine, summarizeValueKeys } from '../util/element-format.js';
import {
  getCurrentAppId, getCurrentScreenId, generateFingerprint,
  loadScreenMap, loadAllScreenMaps, getScreenByName,
  recordScreen, trackScreenTransition,
} from '../context/screen-map-store.js';
import { ensureContextForLocator } from '../context/context-manager.js';
import type { McpToolResponse } from '../types.js';

export const getScreenSchema = z.object({
  includeTree: z.boolean().optional().default(false).describe('Include widget tree alongside screenshot'),
});

export const getWidgetTreeSchema = z.object({
  interactiveOnly: z.boolean().optional().default(false).describe('Only return interactive elements (faster)'),
  refresh: z.boolean().optional().default(false).describe('Force refresh (bypass cache)'),
});

export const findElementsSchema = z.object({
  by: z.enum(['key', 'text', 'type', 'semanticsLabel']).describe('Locator strategy'),
  value: z.string().describe('Locator value'),
});

export const getElementDetailsSchema = z.object({
  by: z.enum(['key', 'text', 'type', 'semanticsLabel']).describe('Locator strategy'),
  value: z.string().describe('Locator value'),
});

export async function handleGetScreen(params: z.infer<typeof getScreenSchema>): Promise<McpToolResponse> {
  const browser = await getBrowserWithReconnect();
  // Compress screenshot for LLM token efficiency (JPEG, max 800px width)
  const screenshot = await captureScreenshot(browser, { maxWidth: 800, quality: 75 });

  // Fix #6: Include device dimensions for coordinate mapping
  let dimensionInfo = '';
  try {
    const rect = await browser.getWindowRect();
    dimensionInfo = ` | Device: ${rect.width}x${rect.height}px (use these coords for tap x/y)`;
  } catch { /* non-critical */ }

  const content: McpToolResponse['content'] = [
    { type: 'text' as const, text: `⚠️ Screenshot is ephemeral — do NOT cache. Re-fetch after every action.${dimensionInfo}` },
    { type: 'image' as const, data: screenshot.base64, mimeType: screenshot.mimeType },
  ];

  // Always try to include ValueKey summary (lightweight, high value)
  try {
    const tree = await buildWidgetTree({ interactiveOnly: true });
    const keySummary = summarizeValueKeys(tree.interactiveElements);
    if (keySummary) {
      content.push({ type: 'text' as const, text: keySummary });
    }

    if (params.includeTree) {
      content.push({
        type: 'text' as const,
        text: `Interactive Elements (${tree.interactiveCount} found):\n${formatElementsCompact(tree.interactiveElements)}`,
      });
    }
  } catch (error) {
    if (params.includeTree) {
      content.push({
        type: 'text' as const,
        text: `Widget tree unavailable: ${String(error)}`,
      });
    }
  }

  return { content };
}

export async function handleGetWidgetTree(params: z.infer<typeof getWidgetTreeSchema>): Promise<McpToolResponse> {
  const tree = await buildWidgetTree({
    interactiveOnly: params.interactiveOnly,
    refresh: params.refresh,
  });

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(tree, null, 2) }],
  };
}

export async function handleFindElements(params: z.infer<typeof findElementsSchema>): Promise<McpToolResponse> {
  const browser = await getBrowserWithReconnect();
  const strategyMap: Record<string, string> = {
    key: '-flutter key',
    text: '-flutter text',
    type: '-flutter type',
    semanticsLabel: '-flutter semantics label',
  };
  const using = strategyMap[params.by];
  const results: Array<Record<string, unknown>> = [];

  try {
    // Auto-switch context: Flutter locators fail silently in WEBVIEW context
    await ensureContextForLocator(params.by, params.value);

    const rawElements = await browser.findElements(using, params.value);
    const elements = await Promise.all(rawElements.map(el => browser.$(el)));

    const elementArray = Array.from(elements);
    for (let i = 0; i < elementArray.length; i++) {
      const el = elementArray[i];
      const [text, displayed, enabled, size, location] = await Promise.allSettled([
        el.getText(),
        el.isDisplayed(),
        el.isEnabled(),
        el.getSize(),
        el.getLocation(),
      ]);

      let position: Record<string, number> | undefined;
      if (size.status === 'fulfilled' && location.status === 'fulfilled') {
        position = {
          x: location.value.x,
          y: location.value.y,
          width: size.value.width,
          height: size.value.height,
        };
      }

      // Fix #4: isEnabled() always returns false for Flutter elements
      let enabledVal = enabled.status === 'fulfilled' ? enabled.value : undefined;
      if (enabledVal === false) {
        try {
          const enabledAttr = await el.getAttribute('enabled');
          if (enabledAttr === 'true' || enabledAttr === null) enabledVal = true;
        } catch {
          enabledVal = true; // Assume enabled by default
        }
      }

      // Try to get the ValueKey for this element (useful when searching by text/type)
      let keyValue: string | undefined;
      if (params.by !== 'key') {
        try {
          const keyAttr = await el.getAttribute('key');
          if (keyAttr && keyAttr !== 'null' && keyAttr !== '<null>') {
            // Parse ValueKey format: [<'actual_key'>] or ValueKey<String>('actual_key')
            const match = keyAttr.match(/(?:ValueKey|Key)\S*\(\s*'([^']+)'\s*\)/) ||
                          keyAttr.match(/\[<'([^']+)'>\]/);
            keyValue = match ? match[1] : keyAttr.replace(/^\[<|'|>\]$/g, '').trim();
            if (keyValue === 'null' || keyValue === '') keyValue = undefined;
          }
        } catch { /* key attribute not available */ }
      }

      results.push({
        index: i,
        text: text.status === 'fulfilled' ? text.value : undefined,
        key: keyValue,
        displayed: displayed.status === 'fulfilled' ? displayed.value : undefined,
        enabled: enabledVal,
        position,
        locator: { by: params.by, value: params.value },
      });
    }
  } catch (error) {
    logger.warn('find_elements failed', { by: params.by, value: params.value, error: String(error) });
  }

  // Record find_elements if recording is active
  if (isRecording() && results.length > 0) {
    recordAction('find_elements', { by: params.by, value: params.value, count: results.length }, 'flutter');
  }

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ by: params.by, value: params.value, count: results.length, elements: results }, null, 2),
    }],
  };
}

export async function handleGetElementDetails(params: z.infer<typeof getElementDetailsSchema>): Promise<McpToolResponse> {
  const strategyMap: Record<string, string> = {
    key: 'key',
    text: 'text',
    type: 'type',
    semanticsLabel: 'semantics label',
  };

  const diagnostics = await getElementDiagnostics(strategyMap[params.by], params.value);

  if (!diagnostics) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: true, message: `Element not found: ${params.by}=${params.value}` }),
      }],
    };
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(diagnostics, null, 2) }],
  };
}

// --- Get Known Screen Tool ---

export const getKnownScreenSchema = z.object({
  name: z.string().optional().describe('Screen name to look up (e.g., "Login", "Dashboard"). If omitted, identifies the current screen.'),
  listAll: z.boolean().optional().default(false).describe('List all known screens for the current app'),
});

export async function handleGetKnownScreen(params: z.infer<typeof getKnownScreenSchema>): Promise<McpToolResponse> {
  const appId = getCurrentAppId();
  if (!appId) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: true, message: 'No app connected. Call connect first.' }),
      }],
    };
  }

  // List all known screens
  if (params.listAll) {
    const screens = loadAllScreenMaps(appId);
    if (screens.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: 'No known screens yet. Explore the app to build the screen map.',
        }],
      };
    }
    const list = screens.map(s =>
      `- "${s.name}" (id: ${s.screenId}, ${s.elements.length} elements, ${s.edges.length} edges, last: ${s.lastVerified})`
    ).join('\n');
    return {
      content: [{
        type: 'text' as const,
        text: `Known screens for ${appId} (${screens.length}):\n${list}`,
      }],
    };
  }

  // Look up by name
  if (params.name) {
    const screen = getScreenByName(appId, params.name);
    if (!screen) {
      return {
        content: [{
          type: 'text' as const,
          text: `Screen "${params.name}" not found in known screens. Use listAll=true to see available screens.`,
        }],
      };
    }
    const compact = formatElementsCompact(screen.elements);
    const edgeInfo = screen.edges.length > 0
      ? '\n\nNavigation from this screen:\n' + screen.edges.map(e =>
          `  ${e.action.by}:${e.action.value} → "${e.toScreenName || e.toScreenId}"`
        ).join('\n')
      : '';
    return {
      content: [{
        type: 'text' as const,
        text: `Screen: "${screen.name}" (${screen.elements.length} elements)\nLast verified: ${screen.lastVerified}\n\n${compact}${edgeInfo}`,
      }],
    };
  }

  // Identify current screen — fast scan + fingerprint lookup
  try {
    const elements = await pageSourceScan();
    const fingerprint = generateFingerprint(elements);
    const known = loadScreenMap(appId, fingerprint);

    if (known) {
      // Screen is known — return cached info (near-instant)
      const compact = formatElementsCompact(known.elements);
      const edgeInfo = known.edges.length > 0
        ? '\n\nNavigation from this screen:\n' + known.edges.map(e =>
            `  ${e.action.by}:${e.action.value} → "${e.toScreenName || e.toScreenId}"`
          ).join('\n')
        : '';
      return {
        content: [{
          type: 'text' as const,
          text: `Known screen: "${known.name}" (${known.elements.length} elements)\n\n${compact}${edgeInfo}`,
        }],
      };
    }

    // New screen — record it and return fresh scan
    const newScreen = recordScreen(appId, elements);
    const compact = formatElementsCompact(elements);
    return {
      content: [{
        type: 'text' as const,
        text: `New screen discovered: "${newScreen.name}" (${elements.length} elements)\n\n${compact}`,
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: true, message: `Screen identification failed: ${String(error)}` }),
      }],
    };
  }
}

// --- Compact format support for get_widget_tree ---

export const getWidgetTreeCompactSchema = z.object({
  interactiveOnly: z.boolean().optional().default(false).describe('Only return interactive elements (faster)'),
  refresh: z.boolean().optional().default(false).describe('Force refresh (bypass cache)'),
  format: z.enum(['full', 'compact']).optional().default('full')
    .describe('Output format: "full" returns JSON (default), "compact" returns token-efficient text (~3-5x fewer tokens)'),
});

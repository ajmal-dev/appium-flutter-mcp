import { z } from 'zod';
import { getBrowser, getBrowserWithReconnect, getSessionMode } from '../appium/session.js';
import { captureScreenshot } from '../util/screenshot.js';
import { buildWidgetTree } from '../tree/tree-builder.js';
import { pageSourceScan } from '../tree/page-source-scanner.js';
import { getElementDiagnostics } from '../tree/diagnostics.js';
import { logger } from '../util/logger.js';
import { recordAction, isRecording } from '../recording/recorder.js';
import { formatElementsCompact, formatElementsSummaryLine, summarizeValueKeys } from '../util/element-format.js';
import {
  getCurrentAppId, loadAllScreenMaps, getScreenByName,
  recordScreen, identifyScreen, bindScreenName,
} from '../context/screen-map-store.js';
import { ensureContextForLocator } from '../context/context-manager.js';
import { recordTelemetry } from '../util/telemetry.js';
import type { McpToolResponse } from '../types.js';

export const getScreenSchema = z.object({
  includeTree: z.boolean().optional().default(false).describe('Include widget tree alongside screenshot'),
});

export const findElementsSchema = z.object({
  by: z.enum(['key', 'text', 'type', 'semanticsLabel']).describe('Locator strategy'),
  value: z.string().describe('Locator value'),
  details: z.boolean().optional().default(false)
    .describe('Return deep widget + render diagnostics for the element instead of the match list. Expensive — use only when you need deep inspection.'),
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

  // Flutter widget tree summary is Flutter-mode-only — the tree walk needs the
  // Flutter Integration driver. Safari/native sessions get the screenshot alone.
  if (getSessionMode() === 'flutter') {
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
  }

  return { content };
}

/**
 * Guidance attached to a count:0 result. A zero-result probe is the #1 source of
 * hallucinated fallback locators — the model concludes "absent" and invents a
 * coordinate tap. Every branch here steers back to a real signal instead.
 */
function zeroResultGuidance(by: string): string {
  switch (by) {
    case 'key':
      return 'count:0 by key proves NOTHING on its own. (a) confirm vmService.connected via get_status; (b) find_elements CANNOT traverse platform-view / OverlayEntry children (search rows, appointment detail, tooltips) even though tapByKey and verify_locator still work there — confirm with verify_locator({by:"key"}) or inspect({target:"native"}) before concluding the key is absent. Do NOT jump to coordinates on a zero-by-key result.';
    case 'text':
      return 'count:0 by text — the widget is likely RichText (not matchable) or truncated. Match from the START of the visible string, or switch to a ValueKey / textContaining. Do not retry the same finder harder.';
    case 'type':
      return 'count:0 by type — verify the exact widget type name (icons/images are RawImage/Icon/Image). Absence from the tree ≠ absence from screen for platform-view content.';
    case 'semanticsLabel':
      return 'count:0 by semanticsLabel — GestureDetectors frequently expose no label. Fall back to key/text/type before coordinates.';
    default:
      return 'count:0 — re-check vmService.connected (get_status); without a live VM a zero probe proves nothing.';
  }
}

export async function handleFindElements(params: z.infer<typeof findElementsSchema>): Promise<McpToolResponse> {
  // Flutter-mode guard — find_elements uses -flutter locator strategies
  // (key/text/type/semanticsLabel) that only resolve against the Flutter
  // widget tree. In Safari / native sessions these strategies return 0 with
  // a misleading error; short-circuit with guidance instead.
  const sessionMode = getSessionMode();
  if (sessionMode !== 'flutter') {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: true,
          message: `find_elements uses Flutter locator strategies (current sessionMode = "${sessionMode}"). ` +
            (sessionMode === 'safari'
              ? 'For Safari, use inspect(target:"webview") to list DOM elements with CSS selectors.'
              : 'For native XCUITest, use inspect(target:"native") to see accessibility IDs and XPaths.'),
        }),
      }],
    };
  }

  const browser = await getBrowserWithReconnect();

  // Deep-diagnostics mode (absorbed get_element_details)
  if (params.details) {
    return handleGetElementDetails({ by: params.by, value: params.value });
  }

  const strategyMap: Record<string, string> = {
    key: '-flutter key',
    text: '-flutter text',
    type: '-flutter type',
    semanticsLabel: '-flutter semantics label',
  };
  const using = strategyMap[params.by];
  const results: Array<Record<string, unknown>> = [];
  let strategyError: string | undefined;
  const t0 = Date.now();

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
    strategyError = String(error);
    logger.warn('find_elements failed', { by: params.by, value: params.value, error: strategyError });
  }

  // Telemetry: fire-and-forget per-call outcome so world_review can surface trends.
  const appId = getCurrentAppId() ?? '';
  recordTelemetry(appId, {
    ts: t0,
    tool: 'find_elements',
    strategy: params.by,
    ok: results.length > 0 && !strategyError,
    ms: Date.now() - t0,
    ...(strategyError ? { error: strategyError.slice(0, 200) } : {}),
  });

  // Record find_elements if recording is active
  if (isRecording() && results.length > 0) {
    recordAction('find_elements', { by: params.by, value: params.value, count: results.length }, 'flutter');
  }

  const payload: Record<string, unknown> = { by: params.by, value: params.value, count: results.length, elements: results };
  // Anti-hallucination guard: a zero-result probe proves NOTHING on its own.
  // Steer away from concluding "absent" (the #1 source of invented fallback locators).
  if (results.length === 0) payload.guidance = zeroResultGuidance(params.by);
  // strategyError distinguishes "locator channel broken" from "widget genuinely absent" (count:0).
  // Agents can check this field to avoid treating a channel failure as proof of absence.
  if (strategyError) payload.strategyError = strategyError;
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(payload, null, 2),
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
  name: z.string().optional().describe('Screen name to look up (e.g., "Login", "Medical Record"). Fuzzy: matches canonical name, aliases, route name, and widget class. If omitted, identifies the current screen.'),
  listAll: z.boolean().optional().default(false).describe('List all known screens for the current app'),
  bindName: z.string().optional().describe('Bind this name to the CURRENT screen (e.g. "Medical Record") so future sessions can find it by name. Agent-bound names are canonical and never overwritten.'),
});

export async function handleGetKnownScreen(params: z.infer<typeof getKnownScreenSchema>): Promise<McpToolResponse> {
  // Flutter-mode guard — the screen-map store keys screens by Flutter widget
  // structure and stores ValueKey-based locators. Safari / native sessions
  // don't fit this schema.
  const sessionMode = getSessionMode();
  if (sessionMode !== 'flutter') {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: true,
          message: `get_known_screen is Flutter-only (current sessionMode = "${sessionMode}"). The screen map stores Flutter widget structures.`,
        }),
      }],
    };
  }
  const appId = getCurrentAppId();
  if (!appId) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: true, message: 'No app connected. Call connect first.' }),
      }],
    };
  }

  // Bind a human-chosen name to the current screen
  if (params.bindName) {
    try {
      const elements = await pageSourceScan();
      const entry = recordScreen(appId, elements);
      if (!entry) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: true, message: 'Could not identify current screen (empty scan) — nothing to bind.' }),
          }],
        };
      }
      const bound = bindScreenName(appId, entry.screenId, params.bindName);
      const aliasInfo = bound?.aliases?.length ? ` (aliases: ${bound.aliases.join(', ')})` : '';
      return {
        content: [{
          type: 'text' as const,
          text: `Current screen bound to "${bound?.name}" (id: ${entry.screenId})${aliasInfo}. Future sessions can navigate_to it by this name.`,
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: true, message: `Bind failed: ${String(error)}` }),
        }],
      };
    }
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
    const list = screens.map(s => {
      const aliases = s.aliases?.length ? ` aka [${s.aliases.join(', ')}]` : '';
      return `- "${s.name}"${aliases} (id: ${s.screenId}, ${s.elements.length} elements, ${s.edges.length} edges, last: ${s.lastVerified})`;
    }).join('\n');
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
    const aliasInfo = screen.aliases?.length ? ` aka [${screen.aliases.join(', ')}]` : '';
    const edgeInfo = screen.edges.length > 0
      ? '\n\nNavigation from this screen:\n' + screen.edges.map(e =>
          `  ${e.action.by}:${e.action.value} → "${e.toScreenName || e.toScreenId}"`
        ).join('\n')
      : '';
    return {
      content: [{
        type: 'text' as const,
        text: `Screen: "${screen.name}"${aliasInfo} (${screen.elements.length} elements)\nLast verified: ${screen.lastVerified}\n\n${compact}${edgeInfo}`,
      }],
    };
  }

  // Identify current screen — structural similarity match against the store
  try {
    const elements = await pageSourceScan();
    const match = identifyScreen(appId, elements);
    const entry = recordScreen(appId, elements); // upsert: refresh known entry or create new

    if (!entry) {
      return {
        content: [{
          type: 'text' as const,
          text: 'Current screen scan returned no elements — cannot identify or record it.',
        }],
      };
    }

    const compact = formatElementsCompact(elements);

    if (match) {
      // Screen is known — return cached knowledge (edges, aliases)
      const aliasInfo = entry.aliases?.length ? ` aka [${entry.aliases.join(', ')}]` : '';
      const edgeInfo = entry.edges.length > 0
        ? '\n\nNavigation from this screen:\n' + entry.edges.map(e =>
            `  ${e.action.by}:${e.action.value} → "${e.toScreenName || e.toScreenId}"`
          ).join('\n')
        : '';
      return {
        content: [{
          type: 'text' as const,
          text: `Known screen: "${entry.name}"${aliasInfo} (match ${(match.score * 100).toFixed(0)}%, ${elements.length} elements)\n\n${compact}${edgeInfo}`,
        }],
      };
    }

    // New screen — recorded with an inferred name; suggest binding a real one
    return {
      content: [{
        type: 'text' as const,
        text: `New screen discovered: "${entry.name}" (${elements.length} elements)\nTip: bind a meaningful name with get_known_screen({bindName: "..."}) so future sessions can navigate here directly.\n\n${compact}`,
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
  interactiveOnly: z.boolean().optional().default(true).describe('Only return interactive elements (default: true, ~3-5x fewer tokens). Set false for full tree debugging, or to include static text anchors in format="tree".'),
  refresh: z.boolean().optional().default(false).describe('Force refresh (bypass cache)'),
  format: z.enum(['full', 'compact', 'tree']).optional().default('tree')
    .describe('Output format: "tree" (default) returns a pruned HIERARCHICAL tree (structure preserved, boilerplate/noise stripped — best for containment-based locators like "the button inside this card"), "compact" returns a token-efficient flat list (no hierarchy), "full" returns the complete raw JSON tree (very large, debugging only).'),
});

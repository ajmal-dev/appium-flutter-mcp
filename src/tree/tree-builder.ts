import { getRenderTree } from '../appium/driver.js';
import { getCurrentContext } from '../context/context-manager.js';
import { getCurrentPlatform } from '../appium/session.js';
import { parseRenderTree, condenseTree } from './render-tree-parser.js';
import { scanInteractiveWidgets } from './widget-scanner.js';
import { pageSourceScan, invalidateScanCache } from './page-source-scanner.js';
import { getVMClient } from '../vm/vm-session.js';
import { buildVMWidgetTree } from '../vm/vm-widget-tree.js';
import { setVMLogger } from '../vm/vm-logger.js';
import type { DartVMClient } from '../vm/dart-vm-client.js';
import type { WidgetTree, WidgetNode, InteractiveElement, ContextSummary } from './types.js';
import { logger } from '../util/logger.js';
import { getRegistry } from '../context/element-registry.js';

// Inject Winston logger into VM modules (so they log to the same file in MCP server context)
setVMLogger(logger);

// Cache
let cachedTree: WidgetTree | null = null;
let cacheTimestamp: number = 0;
// invalidateCache() is now wired into essentially every state-mutating tool (tap,
// type_text, gesture, switch_context, app_control, zma_shortcut flows) plus the passive
// flutter:navigation listener below — this TTL's only remaining job is bounding staleness
// for the one residual case neither catches: in-place content mutation with no route
// change and no tool-driven action (e.g. a live-pushed counter/list update). 20s
// comfortably covers normal LLM "thinking time" between get_widget_tree calls (avoiding
// pointless refetches) while still keeping that residual case bounded.
let cacheTtlMs: number = 20000;

export function setCacheTtl(ms: number) {
  cacheTtlMs = ms;
}

export function invalidateCache() {
  cachedTree = null;
  cacheTimestamp = 0;
  // Mark registry entries as stale (but keep as hints for next interaction)
  getRegistry().markStale();
  // Also invalidate page source scan cache so next scan is fresh
  invalidateScanCache();
}

// Passive safety net: Flutter's own VM service already emits a 'flutter:navigation'
// event on every real route push/pop. Listening for it means the cache gets invalidated
// on app-internal navigation we didn't directly cause (deep links, timers, programmatic
// redirects) without depending on every action handler remembering to call
// invalidateCache() itself.
let navSubscribedClient: DartVMClient | null = null;

function ensureNavigationListener(vmClient: DartVMClient) {
  // Identity comparison (not a boolean flag) matters: connectVM() constructs a brand-new
  // DartVMClient on every explicit reconnect, so this correctly re-attaches to a new
  // instance while no-op'ing when it's the same one. An internal reconnect (inside
  // dart-vm-client.ts's own scheduleReconnect()) reuses the same instance and never
  // detaches its own listeners, so a once-attached listener survives that on its own.
  if (navSubscribedClient === vmClient) return;
  navSubscribedClient = vmClient;
  vmClient.on('flutter:navigation', () => {
    logger.debug('flutter:navigation event — invalidating widget tree cache');
    invalidateCache();
  });
}

/**
 * Build the complete widget tree by combining render tree + interactive widget scan.
 */
export async function buildWidgetTree(options?: {
  interactiveOnly?: boolean;
  refresh?: boolean;
  customTypes?: string[];
}): Promise<WidgetTree> {
  const effectiveTtl = cacheTtlMs;
  if (!options?.refresh && cachedTree && (Date.now() - cacheTimestamp) < effectiveTtl) {
    // A cached entry built with interactiveOnly:true has its `tree` permanently nulled
    // (see below) — if THIS call actually needs the tree, that cached entry can't serve
    // it. Fall through and rebuild instead of silently returning an empty tree.
    const needsTree = options?.interactiveOnly === false;
    const cacheCanServe = !(needsTree && cachedTree.tree == null);
    if (cacheCanServe) {
      if (options?.interactiveOnly) {
        return {
          ...cachedTree,
          tree: null,
        };
      }
      return cachedTree;
    }
  }

  const context = await getCurrentContext();
  const platform = getCurrentPlatform();

  let tree: WidgetNode | WidgetNode[] | null = null;
  let interactiveElements: InteractiveElement[] = [];
  let source: WidgetTree['source'] = 'combined';

  // Priority 1: Try VM Service (fastest — single WebSocket call)
  const vmClient = getVMClient();
  if (vmClient) {
    ensureNavigationListener(vmClient);
    try {
      const vmTree = await buildVMWidgetTree(vmClient, platform);
      logger.info('Used VM Service widget tree (direct path)', {
        interactiveCount: vmTree.interactiveCount,
        elementCount: vmTree.elementCount,
      });

      // VM tree is complete — use it directly
      const vmElementCount = vmTree.elementCount;

      // Build context summary from element registry
      const registry = getRegistry();
      const contextSummaries: ContextSummary[] = [];
      for (const region of registry.regions.values()) {
        contextSummaries.push({
          contextId: region.contextId,
          type: region.contextType,
          bounds: region.bounds,
          elementCount: region.elementCount,
        });
      }

      const widgetTree: WidgetTree = {
        ...vmTree,
        context,
        contexts: contextSummaries.length > 0 ? contextSummaries : undefined,
      };

      if (options?.interactiveOnly) {
        widgetTree.tree = null;
      }

      cachedTree = widgetTree;
      cacheTimestamp = Date.now();
      return widgetTree;
    } catch (vmError) {
      logger.warn('VM widget tree failed, falling back to Appium', { error: String(vmError) });
    }
  }

  // Priority 2: Run render tree + fast page-source scan in parallel (Appium path)
  const [renderResult, fastScanResult] = await Promise.allSettled([
    options?.interactiveOnly ? Promise.resolve(null) : getRenderTree(),
    pageSourceScan(),
  ]);

  // Process render tree
  if (renderResult.status === 'fulfilled' && renderResult.value) {
    tree = parseRenderTree(renderResult.value);
    if (tree && !Array.isArray(tree)) {
      tree = condenseTree(tree);
    }
    source = 'renderTree';
  }

  // Use fast page-source scan results, fall back to type scan if empty
  if (fastScanResult.status === 'fulfilled' && fastScanResult.value.length > 0) {
    interactiveElements = fastScanResult.value;
    source = tree ? 'combined' : 'scanner';
    logger.info('Used page-source-first scanner (fast path)');
  } else {
    // Fallback: slow type-by-type scan
    logger.info('Page-source scan returned empty, falling back to type scan');
    try {
      interactiveElements = await scanInteractiveWidgets(options?.customTypes);
    } catch (fallbackError) {
      logger.warn('Type scan fallback also failed', { error: String(fallbackError) });
      interactiveElements = [];
    }
    if (tree) {
      source = 'combined';
    } else {
      source = 'scanner';
    }
  }

  const elementCount = countNodes(tree);

  // Build context summary from element registry
  const registry = getRegistry();
  const contextSummaries: ContextSummary[] = [];
  for (const region of registry.regions.values()) {
    contextSummaries.push({
      contextId: region.contextId,
      type: region.contextType,
      bounds: region.bounds,
      elementCount: region.elementCount,
    });
  }

  const widgetTree: WidgetTree = {
    timestamp: new Date().toISOString(),
    context,
    platform,
    source,
    tree: options?.interactiveOnly ? null : tree,
    interactiveElements,
    elementCount,
    interactiveCount: interactiveElements.length,
    contexts: contextSummaries.length > 0 ? contextSummaries : undefined,
  };

  // Update cache
  cachedTree = widgetTree;
  cacheTimestamp = Date.now();

  logger.info('Widget tree built', {
    source,
    elementCount,
    interactiveCount: interactiveElements.length,
  });

  return widgetTree;
}

function countNodes(tree: WidgetNode | WidgetNode[] | null): number {
  if (!tree) return 0;
  if (Array.isArray(tree)) return tree.reduce((acc, n) => acc + countNodes(n), 0);
  let count = 1;
  if (tree.children) {
    count += tree.children.reduce((acc, n) => acc + countNodes(n), 0);
  }
  return count;
}

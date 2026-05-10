/**
 * Context-Aware Element Registry
 *
 * A lazy, incremental registry that maps elements and screen regions to contexts.
 * Built from observations during page scans and successful element finds —
 * zero additional Appium overhead.
 *
 * Two-tier lookup:
 * 1. Locator index: "css:.booking-btn" → "WEBVIEW_2335.12" (O(1))
 * 2. Coordinate regions: screen bounds per context → point-in-rect check
 */

import { logger } from '../util/logger.js';
import { enhancedSimilarity } from '../locator/fuzzy.js';

export interface ContextRegion {
  contextId: string;
  contextType: 'flutter' | 'webview' | 'native';
  bounds?: { x: number; y: number; width: number; height: number };
  lastScanned: number;
  elementCount: number;
  /** WebView contains cross-origin iframes — CSS/xpath selectors won't work, use coordinates */
  hasCrossOriginIframes?: boolean;
}

interface RegisteredElement {
  fingerprint: string;
  contextId: string;
  lastSeen: number;
  stale: boolean;
}

class ElementRegistry {
  /** Context regions with screen bounds */
  regions: Map<string, ContextRegion> = new Map();

  /** Locator fingerprint → contextId for O(1) lookup */
  locatorIndex: Map<string, RegisteredElement> = new Map();

  /** Version counter — increments on mutation for cache coherence */
  version: number = 0;

  /** Known context IDs from last getContexts() call */
  private knownContextIds: string[] = [];

  // ── Registration ──────────────────────────────────────────────

  /**
   * Register an element's locator as belonging to a specific context.
   * Called after successful element find or during page scans.
   */
  registerElement(contextId: string, by: string, value: string): void {
    const fingerprint = `${by}:${value}`;
    this.locatorIndex.set(fingerprint, {
      fingerprint,
      contextId,
      lastSeen: Date.now(),
      stale: false,
    });

    // Update element count for the region
    const region = this.regions.get(contextId);
    if (region) {
      region.elementCount++;
    }
  }

  /**
   * Register a context region with optional screen bounds.
   * Called when WebView bounds are detected from native page source.
   */
  registerRegion(
    contextId: string,
    contextType: 'flutter' | 'webview' | 'native',
    bounds?: { x: number; y: number; width: number; height: number },
  ): void {
    this.regions.set(contextId, {
      contextId,
      contextType,
      bounds,
      lastScanned: Date.now(),
      elementCount: 0,
    });
    this.version++;
    logger.debug('Registered context region', { contextId, contextType, bounds });
  }

  // ── Lookup ────────────────────────────────────────────────────

  /**
   * Look up which context a locator belongs to. O(1) Map lookup.
   * Returns null if unknown (caller should fall through to heuristics).
   */
  lookupContext(by: string, value: string): string | null {
    const fingerprint = `${by}:${value}`;
    const entry = this.locatorIndex.get(fingerprint);

    if (!entry) return null;

    // Check if the context still exists
    if (this.knownContextIds.length > 0 && !this.knownContextIds.includes(entry.contextId)) {
      // Context was removed (WebView closed)
      this.locatorIndex.delete(fingerprint);
      return null;
    }

    if (entry.stale) {
      // Return as hint but caller should be prepared for fallback
      logger.debug('Registry hit (stale)', { fingerprint, contextId: entry.contextId });
    } else {
      logger.debug('Registry hit', { fingerprint, contextId: entry.contextId });
    }

    return entry.contextId;
  }

  /**
   * Fuzzy-search registered elements by natural language description.
   * Iterates locatorIndex (typically 20-50 entries, sub-ms).
   * Returns best match above threshold with its contextId.
   */
  findByDescription(description: string, threshold: number = 0.8): {
    by: string; value: string; contextId: string; score: number;
  } | null {
    let best: { by: string; value: string; contextId: string; score: number } | null = null;
    const descLower = description.toLowerCase();

    for (const [fingerprint, entry] of this.locatorIndex.entries()) {
      // fingerprint format: "by:value"
      const colonIdx = fingerprint.indexOf(':');
      if (colonIdx === -1) continue;

      const by = fingerprint.slice(0, colonIdx);
      const value = fingerprint.slice(colonIdx + 1);

      const score = enhancedSimilarity(descLower, value.toLowerCase());
      if (score > (best?.score ?? threshold)) {
        // Verify context still exists
        if (this.knownContextIds.length > 0 && !this.knownContextIds.includes(entry.contextId)) {
          continue;
        }
        best = { by, value, contextId: entry.contextId, score };
      }
    }

    if (best) {
      logger.debug('Registry findByDescription hit', { description, match: `${best.by}:${best.value}`, score: best.score.toFixed(2) });
    }
    return best;
  }

  /**
   * Look up which context owns a screen coordinate.
   * Checks WebView regions first (they overlay Flutter).
   * Returns null if no region contains the point.
   */
  lookupContextForCoordinates(x: number, y: number): string | null {
    // Check WebView regions first (they sit on top of Flutter content)
    for (const region of this.regions.values()) {
      if (region.contextType !== 'webview' || !region.bounds) continue;

      const b = region.bounds;
      if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height) {
        logger.debug('Coordinate mapped to WebView', { x, y, contextId: region.contextId, bounds: b });
        return region.contextId;
      }
    }

    // If no WebView contains the point, it's Flutter/native territory
    return null;
  }

  /**
   * Get all registered WebView regions with bounds.
   */
  getWebViewRegions(): ContextRegion[] {
    return Array.from(this.regions.values()).filter(
      r => r.contextType === 'webview' && r.bounds,
    );
  }

  // ── Iframe Detection ───────────────────────────────────────────

  /**
   * Mark a WebView as having cross-origin iframes.
   * CSS/xpath selectors won't work for iframe content — only coordinates.
   * Called when a CSS/xpath find fails and iframes are detected.
   */
  markHasCrossOriginIframes(contextId: string): void {
    const region = this.regions.get(contextId);
    if (region) {
      region.hasCrossOriginIframes = true;
      logger.info('Marked WebView as having cross-origin iframes', { contextId });
    }
  }

  /**
   * Check if a WebView has cross-origin iframes.
   * If true, CSS/xpath selectors should be skipped — use coordinates instead.
   */
  hasCrossOriginIframes(contextId: string): boolean {
    const region = this.regions.get(contextId);
    return region?.hasCrossOriginIframes === true;
  }

  /**
   * Check if ANY webview has cross-origin iframes.
   */
  anyWebViewHasCrossOriginIframes(): boolean {
    for (const region of this.regions.values()) {
      if (region.contextType === 'webview' && region.hasCrossOriginIframes) {
        return true;
      }
    }
    return false;
  }

  // ── Cache Coherence ───────────────────────────────────────────

  /**
   * Mark all entries as stale (keep as hints, don't clear).
   * Called on cache invalidation / navigation.
   */
  markStale(): void {
    for (const entry of this.locatorIndex.values()) {
      entry.stale = true;
    }
    this.version++;
  }

  /**
   * Evict a specific context and all its registered elements.
   * Called when a WebView is destroyed.
   */
  evictContext(contextId: string): void {
    this.regions.delete(contextId);

    // Remove all locator entries for this context
    for (const [key, entry] of this.locatorIndex.entries()) {
      if (entry.contextId === contextId) {
        this.locatorIndex.delete(key);
      }
    }

    this.version++;
    logger.info('Evicted context from registry', { contextId });
  }

  /**
   * Diff current contexts against known contexts.
   * Evicts dead WebViews, detects new ones.
   * Returns { added, removed } context IDs.
   */
  diffContexts(currentContexts: string[]): { added: string[]; removed: string[] } {
    const currentSet = new Set(currentContexts);
    const knownSet = new Set(this.knownContextIds);

    const added = currentContexts.filter(c => !knownSet.has(c));
    const removed = this.knownContextIds.filter(c => !currentSet.has(c));

    // Evict removed contexts
    for (const ctx of removed) {
      if (ctx.startsWith('WEBVIEW')) {
        this.evictContext(ctx);
      }
    }

    this.knownContextIds = [...currentContexts];
    return { added, removed };
  }

  /**
   * Update the known context list without diffing.
   */
  setKnownContexts(contexts: string[]): void {
    this.knownContextIds = [...contexts];
  }

  /**
   * Clear the entire registry (hard reset).
   */
  clear(): void {
    this.regions.clear();
    this.locatorIndex.clear();
    this.knownContextIds = [];
    this.version++;
  }

  /**
   * Get registry stats for debugging.
   */
  stats(): { regions: number; elements: number; version: number; staleCount: number } {
    let staleCount = 0;
    for (const entry of this.locatorIndex.values()) {
      if (entry.stale) staleCount++;
    }
    return {
      regions: this.regions.size,
      elements: this.locatorIndex.size,
      version: this.version,
      staleCount,
    };
  }
}

// ── Singleton ─────────────────────────────────────────────────

let registry: ElementRegistry | null = null;

export function getRegistry(): ElementRegistry {
  if (!registry) {
    registry = new ElementRegistry();
  }
  return registry;
}

export function resetRegistry(): void {
  if (registry) {
    registry.clear();
  }
  registry = null;
}

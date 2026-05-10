/**
 * Auto-scan utility: runs pageSourceScan + optional screenshot after actions.
 * Used by session, device, workflow, and act tools to return screen state
 * automatically, eliminating the need for follow-up get_screen/get_widget_tree calls.
 */

import { pageSourceScan } from '../tree/page-source-scanner.js';
import { captureScreenshot } from './screenshot.js';
import { formatElementsCompact, formatElementsSummaryLine } from './element-format.js';
import { trackScreenTransition } from '../context/screen-map-store.js';
import { logger } from './logger.js';
import type { McpToolResponse } from '../types.js';
import type { InteractiveElement } from '../tree/types.js';

export interface AutoScanResult {
  elements: InteractiveElement[];
  contentBlocks: McpToolResponse['content'];
}

/**
 * Run a fast page-source scan and return formatted content blocks.
 * Safe to call after any action — failures are non-critical.
 */
export async function autoScan(
  browser: WebdriverIO.Browser,
  options?: {
    includeScreenshot?: boolean;
    maxWidth?: number;
    quality?: number;
    action?: { by: string; value: string };
  },
): Promise<AutoScanResult> {
  const contentBlocks: McpToolResponse['content'] = [];
  let elements: InteractiveElement[] = [];

  try {
    elements = await pageSourceScan();

    // Track screen in persistent screen map (non-critical)
    try { trackScreenTransition(elements, options?.action); } catch { /* ignore */ }

    if (elements.length > 0) {
      const summary = formatElementsSummaryLine(elements);
      const compact = formatElementsCompact(elements);
      contentBlocks.push({
        type: 'text' as const,
        text: `\n--- Screen Elements (${summary}) ---\n${compact}`,
      });
    }
  } catch (error) {
    logger.debug('Auto-scan failed (non-critical)', { error: String(error) });
  }

  if (options?.includeScreenshot !== false) {
    try {
      const screenshot = await captureScreenshot(browser, {
        maxWidth: options?.maxWidth ?? 800,
        quality: options?.quality ?? 75,
      });
      contentBlocks.push({
        type: 'image' as const,
        data: screenshot.base64,
        mimeType: screenshot.mimeType,
      });
    } catch {
      // Screenshot failure is non-critical
    }
  }

  return { elements, contentBlocks };
}

/**
 * Run auto-scan and return just the element text content block.
 * Used when screenshot is handled separately (e.g., in act.ts).
 */
export async function autoScanElementsOnly(
  action?: { by: string; value: string },
): Promise<McpToolResponse['content']> {
  try {
    const elements = await pageSourceScan();

    // Track screen in persistent screen map (non-critical)
    try { trackScreenTransition(elements, action); } catch { /* ignore */ }

    if (elements.length > 0) {
      const summary = formatElementsSummaryLine(elements);
      const compact = formatElementsCompact(elements);
      return [{
        type: 'text' as const,
        text: `\n--- Screen Elements (${summary}) ---\n${compact}`,
      }];
    }
  } catch (error) {
    logger.debug('Auto-scan elements-only failed (non-critical)', { error: String(error) });
  }
  return [];
}

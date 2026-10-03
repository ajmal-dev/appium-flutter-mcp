/**
 * Unified element source for description-based resolution (`tap({description})`,
 * `flutter_locator`).
 *
 * WHY THIS EXISTS
 * Both of those tools used to resolve exclusively through `pageSourceScan()`
 * — Appium's native XML page source plus, per interactive element, up to three
 * SEQUENTIAL `findElements` round trips (text → semanticsLabel → type). That
 * path never queries `-flutter key` and never populates `InteractiveElement.key`,
 * so a ValueKey was structurally invisible to it: the "Priority 1: ValueKey"
 * branches downstream in locator.ts could never fire, and every resolution
 * landed on a fragile text/type locator.
 *
 * `buildWidgetTree()` already solves this — via `buildVMWidgetTree()` it pulls
 * the whole tree in a single VM WebSocket round trip and `buildLocators()`
 * ranks `key` first (confidence 1.0). It is also already cached (20s TTL) and
 * already invalidated both by state-mutating tool calls and by the passive
 * `flutter:navigation` VM event — so a screen change always yields a fresh
 * tree, while repeated lookups on the SAME screen are free.
 *
 * This module routes the description-resolution tools to that tree, keeping
 * `pageSourceScan()` as the fallback for the cases the VM genuinely cannot
 * serve (no VM = release/profile build, or a WebView context whose DOM is
 * opaque to the Flutter widget tree).
 */

import { buildWidgetTree } from '../tree/tree-builder.js';
import { pageSourceScan } from '../tree/page-source-scanner.js';
import { getVMClient } from '../vm/vm-session.js';
import { getCurrentContext } from '../context/context-manager.js';
import { logger } from './logger.js';
import type { InteractiveElement } from '../tree/types.js';

export interface ScreenElementsResult {
  elements: InteractiveElement[];
  /**
   * 'vm' — key-aware Dart VM widget tree. A missing `key` here is real evidence
   *        the widget has no ValueKey.
   * 'pageSource' — Appium native XML scan. Cannot see ValueKeys at all, so a
   *        missing `key` proves NOTHING and must never be reported as a gap.
   */
  source: 'vm' | 'pageSource';
}

/**
 * Get the current screen's interactive elements, preferring the key-aware VM tree.
 *
 * Falls back to `pageSourceScan()` when: no VM client (release/profile build),
 * the active context is a WebView (DOM, not Flutter widgets), or the VM tree
 * came back empty/failed.
 */
export async function getScreenElements(): Promise<ScreenElementsResult> {
  const vmClient = getVMClient();

  if (vmClient) {
    let context = '';
    try {
      context = await getCurrentContext();
    } catch {
      // Context probe is best-effort; a failure shouldn't block the VM path.
    }

    // WebView content is DOM — the Flutter widget tree renders it as one opaque
    // platform view, so the VM cannot enumerate its controls.
    if (!context.startsWith('WEBVIEW')) {
      try {
        const tree = await buildWidgetTree({ interactiveOnly: true });
        const elements = tree.interactiveElements ?? [];
        if (elements.length > 0 && tree.source === 'vm') {
          logger.debug('element-source: VM tree', {
            count: elements.length,
            keyed: elements.filter(e => e.key).length,
          });
          return { elements, source: 'vm' };
        }
        // buildWidgetTree fell back to its own Appium path internally — treat
        // the result as page-source-derived so callers don't misreport keys.
        if (elements.length > 0) {
          return { elements, source: 'pageSource' };
        }
      } catch (error) {
        logger.debug('element-source: VM tree failed, falling back to page source', {
          error: String(error),
        });
      }
    }
  }

  const elements = await pageSourceScan();
  return { elements, source: 'pageSource' };
}

/**
 * Build the "no ValueKey" advisory for a resolved element, or null when none is
 * warranted.
 *
 * Only meaningful for VM-sourced elements: a page-source scan cannot see keys,
 * so "no key found" there means "we couldn't look", not "no key exists".
 * Reporting a gap from that would send the app team chasing a key that may
 * already be present.
 */
export function describeKeyGap(
  element: InteractiveElement,
  source: ScreenElementsResult['source'],
): string | null {
  if (source !== 'vm') return null;
  if (element.key) return null;

  const label = element.text ? `"${element.text}"` : element.type;
  return `⚠️ ${label} (${element.type}) has NO ValueKey — falling back to `
    + `${element.locator.by}:${element.locator.value}. This is an automation gap: `
    + `report it to the user and consider filing it for the app team.`;
}

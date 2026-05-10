import { getBrowser } from '../appium/session.js';
import { logger } from '../util/logger.js';
import { INTERACTIVE_WIDGET_TYPES, type InteractiveElement } from './types.js';

/**
 * Scan for interactive widgets by type using Flutter finders.
 * For each found widget, collects text, position, and builds best locator.
 */
export async function scanInteractiveWidgets(
  customTypes?: string[],
): Promise<InteractiveElement[]> {
  const browser = getBrowser();
  const types = customTypes || INTERACTIVE_WIDGET_TYPES;
  const elements: InteractiveElement[] = [];
  let globalIndex = 0;

  // Run scans in parallel batches to improve performance
  const batchSize = 5;
  for (let i = 0; i < types.length; i += batchSize) {
    const batch = types.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(typeName => scanSingleType(browser, typeName)),
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === 'fulfilled' && result.value.length > 0) {
        for (const el of result.value) {
          elements.push({ ...el, index: globalIndex++ });
        }
      }
    }
  }

  // Fix #2: Fallback — scan for elements with semantics labels that may be
  // custom widgets not in INTERACTIVE_WIDGET_TYPES
  try {
    const semanticsElements = await scanBySemanticsLabels(browser, elements);
    for (const el of semanticsElements) {
      elements.push({ ...el, index: globalIndex++ });
    }
  } catch (error) {
    logger.debug('Semantics fallback scan failed', { error: String(error) });
  }

  logger.info(`Widget scan complete: ${elements.length} interactive elements found`);
  return elements;
}

/**
 * Fallback scan: find tappable elements via the native accessibility tree
 * that were missed by the type-based scan. This catches custom widgets with
 * semantics labels (e.g., camera icon, AI Scribe button).
 */
async function scanBySemanticsLabels(
  browser: Awaited<ReturnType<typeof getBrowser>>,
  existingElements: InteractiveElement[],
): Promise<Omit<InteractiveElement, 'index'>[]> {
  const results: Omit<InteractiveElement, 'index'>[] = [];

  // Collect already-found element positions to deduplicate
  const existingPositions = new Set(
    existingElements
      .filter(e => e.position)
      .map(e => `${e.position!.x},${e.position!.y}`),
  );

  try {
    // Use Appium's native source to find elements with accessibility labels
    // that might be tappable but not in our widget type list
    const source = await browser.getPageSource();

    // Extract elements with label/name attributes from the XML
    const labelMatches = source.matchAll(/label="([^"]+)"/g);
    const labels = new Set<string>();
    for (const match of labelMatches) {
      if (match[1] && match[1].trim().length > 0 && match[1].length < 100) {
        labels.add(match[1].trim());
      }
    }

    // Try to find each label as a semantics label in Flutter
    for (const label of labels) {
      try {
        const rawElements = await browser.findElements('-flutter semantics label', label);
        if (rawElements.length === 0) continue;

        const el = await browser.$(rawElements[0]);
        const rect = await getRect(el);

        // Skip if we already found this element at the same position
        if (rect && existingPositions.has(`${rect.x},${rect.y}`)) continue;

        let text: string | undefined;
        try { text = await el.getText(); } catch { /* ignore */ }

        results.push({
          type: 'SemanticsNode',
          text: text || label,
          enabled: true, // Assume enabled since we found it via semantics
          displayed: true,
          position: rect || undefined,
          locator: { by: 'semanticsLabel', value: label },
        });
      } catch {
        // Element not findable via Flutter — skip
      }
    }
  } catch (error) {
    logger.debug('Semantics label scan failed', { error: String(error) });
  }

  return results;
}

async function scanSingleType(
  browser: Awaited<ReturnType<typeof getBrowser>>,
  typeName: string,
): Promise<Omit<InteractiveElement, 'index'>[]> {
  const results: Omit<InteractiveElement, 'index'>[] = [];

  try {
    const rawElements = await browser.findElements('-flutter type', typeName);
    const found = await Promise.all(rawElements.map(el => browser.$(el)));
    const foundArray = Array.from(found);
    if (foundArray.length === 0) return results;

    for (const el of foundArray) {
      try {
        const [text, displayed, enabled, rect] = await Promise.allSettled([
          el.getText(),
          el.isDisplayed(),
          el.isEnabled(),
          getRect(el),
        ]);

        const textVal = text.status === 'fulfilled' ? text.value : undefined;
        const displayedVal = displayed.status === 'fulfilled' ? displayed.value : undefined;
        let enabledVal = enabled.status === 'fulfilled' ? enabled.value : undefined;

        // Fix #4: isEnabled() always returns false for Flutter elements.
        // Fallback to getAttribute('enabled') which returns a string.
        if (enabledVal === false) {
          try {
            const enabledAttr = await el.getAttribute('enabled');
            if (enabledAttr === 'true' || enabledAttr === null) {
              // null means attribute not set — treat as enabled (Flutter default)
              enabledVal = true;
            }
          } catch {
            // If getAttribute also fails, assume enabled (most widgets are)
            enabledVal = true;
          }
        }

        const position = rect.status === 'fulfilled' ? rect.value : undefined;

        // Try to get ValueKey
        let key: string | undefined;
        try {
          const keyAttr = await el.getAttribute('key');
          if (keyAttr && keyAttr !== 'null') key = keyAttr;
        } catch { /* no key */ }

        // Build best locator
        const locator = buildLocator(typeName, key, textVal);

        results.push({
          type: typeName,
          key,
          text: textVal || undefined,
          enabled: enabledVal,
          displayed: displayedVal,
          position: position || undefined,
          locator,
        });
      } catch (error) {
        logger.debug(`Failed to get properties for ${typeName} element`, { error: String(error) });
      }
    }
  } catch (error) {
    // Type not found on screen — this is normal
    logger.debug(`No ${typeName} elements found`);
  }

  return results;
}

async function getRect(el: { getSize: () => Promise<{ width: number; height: number }>; getLocation: () => Promise<{ x: number; y: number }> }): Promise<{ x: number; y: number; width: number; height: number } | null> {
  try {
    const [size, loc] = await Promise.all([el.getSize(), el.getLocation()]);
    return { x: loc.x, y: loc.y, width: size.width, height: size.height };
  } catch {
    return null;
  }
}

function buildLocator(type: string, key?: string, text?: string): { by: string; value: string } {
  // Prefer key (most reliable), then text, then type
  if (key) return { by: 'key', value: key };
  if (text && text.trim()) return { by: 'text', value: text.trim() };
  return { by: 'type', value: type };
}

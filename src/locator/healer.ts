/**
 * Self-Healing Locator Engine — when a primary locator fails,
 * cascades through alternative strategies to find the element.
 *
 * Strategy cascade (ordered by reliability):
 * 1. Key variants (camelCase ↔ snake_case, prefix/suffix removal)
 * 2. Text strategy with same/similar text
 * 3. SemanticsLabel with the key/text as label
 * 4. Fuzzy text match against all visible elements
 * 5. Coordinate fallback (if position was recorded)
 */

import { getBrowser } from '../appium/session.js';
import { logger } from '../util/logger.js';
import { pageSourceScan } from '../tree/page-source-scanner.js';
import { combinedSimilarity, keyVariants } from './fuzzy.js';
import {
  logHealingEvent,
  isHealingActive,
  isHealingEnabled,
  getHealingConfig,
  type HealingEvent,
} from './registry.js';

export interface HealResult {
  element: any; // WebdriverIO.Element or ChainablePromiseElement
  healedLocator: { by: string; value: string };
  strategy: string;
  confidence: number;
}

/**
 * Attempt to heal a failed locator by trying alternative strategies.
 * Returns null if healing is disabled or no alternative found above threshold.
 */
export async function healLocator(
  originalBy: string,
  originalTarget: string,
): Promise<HealResult | null> {
  if (!isHealingEnabled()) return null;

  const config = getHealingConfig();
  const browser = getBrowser();
  const strategies: Array<() => Promise<HealResult | null>> = [];

  // Strategy 1: Key variants (if original was a key)
  if (originalBy === 'key') {
    strategies.push(() => tryKeyVariants(browser, originalTarget));
  }

  // Strategy 2: Try as text (if original was key or type)
  if (originalBy === 'key' || originalBy === 'type') {
    strategies.push(() => tryAsText(browser, originalTarget));
  }

  // Strategy 3: Try as semanticsLabel
  if (originalBy !== 'semanticsLabel') {
    strategies.push(() => tryAsSemanticsLabel(browser, originalTarget));
  }

  // Strategy 4: Fuzzy text match against visible elements
  strategies.push(() => tryFuzzyMatch(browser, originalTarget, config.fuzzyThreshold));

  // Execute strategies in order until one succeeds
  for (const strategy of strategies) {
    try {
      const result = await strategy();
      if (result && result.confidence >= config.confidenceThreshold) {
        // Log the healing event
        const event: HealingEvent = {
          timestamp: new Date().toISOString(),
          originalLocator: { by: originalBy, value: originalTarget },
          healedLocator: result.healedLocator,
          strategy: result.strategy,
          confidence: result.confidence,
          screenContext: 'unknown',
        };
        logHealingEvent(event);

        if (isHealingActive()) {
          logger.info('Locator healed', {
            original: `${originalBy}="${originalTarget}"`,
            healed: `${result.healedLocator.by}="${result.healedLocator.value}"`,
            strategy: result.strategy,
            confidence: result.confidence.toFixed(2),
          });
          return result;
        } else {
          // Passive mode: log but don't use
          logger.info('Locator healing found (passive mode, not applied)', {
            original: `${originalBy}="${originalTarget}"`,
            healed: `${result.healedLocator.by}="${result.healedLocator.value}"`,
          });
          return null;
        }
      }
    } catch {
      // Strategy failed, try next
    }
  }

  return null;
}

async function tryKeyVariants(
  browser: WebdriverIO.Browser,
  originalKey: string,
): Promise<HealResult | null> {
  const variants = keyVariants(originalKey);

  for (const variant of variants) {
    if (variant === originalKey) continue;
    try {
      const rawEl = await browser.findElement('-flutter key', variant);
      const element = await browser.$(rawEl);
      return {
        element,
        healedLocator: { by: 'key', value: variant },
        strategy: 'key_variant',
        confidence: 0.9,
      };
    } catch { /* variant not found */ }
  }

  return null;
}

async function tryAsText(
  browser: WebdriverIO.Browser,
  value: string,
): Promise<HealResult | null> {
  // Clean up key-style strings to get possible text
  const textValue = value
    .replace(/[_\-]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();

  if (!textValue) return null;

  try {
    const rawEl = await browser.findElement('-flutter text', textValue);
    const element = await browser.$(rawEl);
    return {
      element,
      healedLocator: { by: 'text', value: textValue },
      strategy: 'text_from_key',
      confidence: 0.85,
    };
  } catch { /* not found */ }

  // Try original value as-is
  try {
    const rawEl = await browser.findElement('-flutter text', value);
    const element = await browser.$(rawEl);
    return {
      element,
      healedLocator: { by: 'text', value },
      strategy: 'text_direct',
      confidence: 0.85,
    };
  } catch { /* not found */ }

  return null;
}

async function tryAsSemanticsLabel(
  browser: WebdriverIO.Browser,
  value: string,
): Promise<HealResult | null> {
  try {
    const rawEl = await browser.findElement('-flutter semantics label', value);
    const element = await browser.$(rawEl);
    return {
      element,
      healedLocator: { by: 'semanticsLabel', value },
      strategy: 'semantics_label',
      confidence: 0.85,
    };
  } catch { /* not found */ }

  return null;
}

async function tryFuzzyMatch(
  browser: WebdriverIO.Browser,
  originalValue: string,
  threshold: number,
): Promise<HealResult | null> {
  // Get all visible elements via the fast page-source scanner
  let visibleElements;
  try {
    visibleElements = await pageSourceScan();
  } catch {
    return null;
  }

  if (visibleElements.length === 0) return null;

  // Find best fuzzy match
  let bestMatch: { element: typeof visibleElements[0]; score: number } | null = null;

  for (const el of visibleElements) {
    const candidates = [el.text, el.locator?.value].filter(Boolean) as string[];
    for (const candidate of candidates) {
      const score = combinedSimilarity(originalValue, candidate);
      if (score >= threshold && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { element: el, score };
      }
    }
  }

  if (!bestMatch) return null;

  // Try to find the matched element via Flutter finder
  const matchedEl = bestMatch.element;
  const locator = matchedEl.locator;

  try {
    const strategyMap: Record<string, string> = {
      key: '-flutter key',
      text: '-flutter text',
      type: '-flutter type',
      semanticsLabel: '-flutter semantics label',
    };

    const using = strategyMap[locator.by];
    if (!using) return null;

    const rawEl = await browser.findElement(using, locator.value);
    const element = await browser.$(rawEl);

    return {
      element,
      healedLocator: locator,
      strategy: 'fuzzy_match',
      confidence: bestMatch.score,
    };
  } catch {
    return null;
  }
}

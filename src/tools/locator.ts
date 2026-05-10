import { z } from 'zod';
import { McpToolResponse } from '../types.js';
import { logger } from '../util/logger.js';
import { getBrowserWithReconnect } from '../appium/session.js';
import { pageSourceScan, scanWebViewInteractiveElements } from '../tree/page-source-scanner.js';
import { getNativeInteractiveElements } from '../context/native-inspector.js';
import { enhancedSimilarity } from '../locator/fuzzy.js';
import { getRegistry } from '../context/element-registry.js';
import { getWebViewContexts, ensureContextForLocator } from '../context/context-manager.js';
import { formatElementsCompact } from '../util/element-format.js';
import { getDartSourceIndex, searchValueKeys } from '../source/dart-source-scanner.js';
import { loadConfig } from '../util/config.js';
import type { InteractiveElement } from '../tree/types.js';

// ── Schema ───────────────────────────────────────────────────────────────────

export const flutterLocatorSchema = z.object({
  description: z.string().describe('Natural-language description of the UI element (e.g., "book button", "guest name field", "login link")'),
  topN: z.number().optional().default(1).describe('Number of top matches to return (1-5). Use >1 when unsure which element you mean.'),
  context: z.enum(['auto', 'flutter', 'webview', 'native']).optional().default('auto')
    .describe('Which context to search: "auto" tries Flutter first then falls back to WebView/Native'),
  mode: z.enum(['human', 'structured']).optional().default('human')
    .describe('"human": readable output. "structured": JSON with all candidates, verification results, parent keys, source info — designed for AI analysis.'),
  verify: z.boolean().optional().default(false)
    .describe('When true, verify top candidates on device via findElements and include match counts'),
});

// ── Type hint map (same as smart_tap) ────────────────────────────────────────

const TYPE_HINT_MAP: Record<string, Set<string>> = {
  button: new Set(['TextButton', 'ElevatedButton', 'OutlinedButton', 'IconButton', 'FloatingActionButton', 'FilledButton', 'Button', 'ImageButton']),
  field: new Set(['TextField', 'TextFormField', 'AutoSizeTextField', 'EditText', 'SecureTextField']),
  input: new Set(['TextField', 'TextFormField', 'AutoSizeTextField', 'SearchBar', 'EditText', 'SecureTextField']),
  link: new Set(['TextButton']),
  switch: new Set(['Switch']),
  checkbox: new Set(['Checkbox']),
  dropdown: new Set(['DropdownButton', 'DropdownMenu', 'PopupMenuButton']),
  tab: new Set(['Tab']),
  card: new Set(['ListTile', 'Card']),
  icon: new Set(['Icon', 'IconButton', 'ImageIcon']),
  search: new Set(['SearchBar', 'SearchAnchor']),
};

// ── Handler ──────────────────────────────────────────────────────────────────

export async function handleFlutterLocator(
  params: z.infer<typeof flutterLocatorSchema>,
): Promise<McpToolResponse> {
  const { description, topN, context: searchContext, mode, verify } = params;
  const clampedTopN = Math.max(1, Math.min(5, topN));

  // Ensure we have an active session
  try {
    await getBrowserWithReconnect();
  } catch {
    return { content: [{ type: 'text', text: 'Not connected to Appium. Use `connect` first.' }] };
  }

  // 1. Registry fast path
  const registry = getRegistry();
  const registryMatch = registry.findByDescription(description, 0.6);
  if (registryMatch && registryMatch.score >= 0.85 && clampedTopN === 1) {
    logger.info('flutter_locator: registry fast path', { description, match: `${registryMatch.by}:${registryMatch.value}`, score: registryMatch.score.toFixed(2) });
    const contextType = detectContextType(registryMatch.contextId);
    const output = formatSingleLocator({
      by: registryMatch.by,
      value: registryMatch.value,
      contextType,
      score: registryMatch.score,
      element: null,
      unique: true, // registry entries are fingerprinted
    }, description);
    return { content: [{ type: 'text', text: output }] };
  }

  // 2. Scan screen based on context
  let elements: InteractiveElement[] = [];

  if (searchContext === 'native') {
    // Native-only: get elements with accessibilityId/xpath locators
    elements = await getNativeInteractiveElements();

  } else if (searchContext === 'webview') {
    // WebView-only: scan all WebView contexts
    elements = await scanAllWebViews(0);

  } else {
    // 'flutter' or 'auto': start with pageSourceScan
    elements = await pageSourceScan();

    // 'auto' fallback: if weak Flutter match, try WebView then Native
    if (searchContext === 'auto') {
      const flutterBest = findTopMatches(description, elements, 1);
      if (!flutterBest.length || flutterBest[0].score < 0.6) {
        // Try WebViews
        const webViewElements = await scanAllWebViews(elements.length);
        if (webViewElements.length > 0) {
          elements = [...elements, ...webViewElements];
        }

        // Still weak? Try native with proper native locators
        const combinedBest = findTopMatches(description, elements, 1);
        if (!combinedBest.length || combinedBest[0].score < 0.6) {
          try {
            const nativeElements = await getNativeInteractiveElements();
            if (nativeElements.length > 0) {
              // Re-index to avoid collisions
              const offset = elements.length;
              const reindexed = nativeElements.map((el: InteractiveElement, i: number) => ({ ...el, index: offset + i }));
              elements = [...elements, ...reindexed];
            }
          } catch (e) {
            logger.debug('Native scan failed (non-critical)', { error: String(e) });
          }
        }
      }
    }
  }

  if (elements.length === 0) {
    return { content: [{ type: 'text', text: 'No interactive elements found on screen.' }] };
  }

  // 4. Fuzzy match
  const matches = findTopMatches(description, elements, mode === 'structured' ? 1 : clampedTopN);

  if (matches.length === 0) {
    // Try source-aware fallback: consult Dart source index for ValueKey suggestions
    const sourceHint = await getSourceKeyHint(description);

    if (mode === 'structured') {
      const result: StructuredLocatorResult = {
        description,
        bestMatch: null,
        candidates: [],
        parentKeys: [],
        sourceHint: sourceHint || undefined,
        allElementsSummary: formatElementsCompact(elements.slice(0, 15)),
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    const compact = formatElementsCompact(elements.slice(0, 15));
    const parts = [`No element matching "${description}" found (threshold: 40%).`];

    if (sourceHint) {
      parts.push('');
      parts.push(sourceHint);
    }

    parts.push('');
    parts.push(`Visible elements on screen:\n${compact}`);

    return { content: [{ type: 'text', text: parts.join('\n') }] };
  }

  // ── Structured mode: return rich JSON for AI analysis ──────────────────────
  if (mode === 'structured') {
    return buildStructuredOutput(description, matches[0], elements, verify);
  }

  // ── Human mode: existing readable output ───────────────────────────────────
  const lines: string[] = [`## Locator for "${description}"\n`];

  for (let i = 0; i < matches.length; i++) {
    const { element, score } = matches[i];

    // Find best unique locator
    const locator = findBestUniqueLocator(element, elements);
    const contextType = detectContextType(element.context);

    const compact = formatElementCompact(element);
    lines.push(`### Match #${i + 1} (confidence: ${(score * 100).toFixed(0)}%)`);
    lines.push(`Element: ${compact}\n`);

    lines.push(`Compact:  ${locator.by}:${locator.value}`);
    lines.push(`Unique:   ${locator.unique ? 'Yes (1 match on screen)' : `No (${locator.duplicateCount} matches — consider using index)`}`);
    lines.push('');

    // Source context: show where the key is defined in Dart source
    const sourceInfo = await getSourceKeyInfo(locator.value);
    if (sourceInfo) {
      lines.push(`Source:   ${sourceInfo}`);
      lines.push('');
    }

    // Java output
    const constName = strategyPrefix(locator.by) + toConstantName(locator.value);
    let javaUsage: string;
    if (contextType === 'webview') {
      javaUsage = buildWebFinder(locator.by, constName);
    } else if (contextType === 'native') {
      javaUsage = buildNativeFinder(locator.by, constName);
    } else {
      javaUsage = buildFinder(locator.by, constName);
    }

    lines.push('Java:');
    lines.push(`  private static final String ${constName} = "${escapeJava(locator.value)}";`);
    lines.push(`  // Usage: ${javaUsage}`);

    if (i < matches.length - 1) lines.push('\n---\n');
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ── WebView scanner helper ───────────────────────────────────────────────────

async function scanAllWebViews(indexOffset: number): Promise<InteractiveElement[]> {
  try {
    const webviews = await getWebViewContexts();
    if (webviews.length === 0) return [];

    logger.info('flutter_locator: scanning WebViews', { count: webviews.length });
    const allElements: InteractiveElement[] = [];
    const scanResults = await Promise.allSettled(
      webviews.map(wv => scanWebViewInteractiveElements(wv, indexOffset + allElements.length)),
    );
    for (const result of scanResults) {
      if (result.status === 'fulfilled') {
        allElements.push(...result.value);
      }
    }
    return allElements;
  } catch (e) {
    logger.debug('WebView scan failed (non-critical)', { error: String(e) });
    return [];
  }
}

// ── Matching ─────────────────────────────────────────────────────────────────

interface ScoredMatch {
  element: InteractiveElement;
  score: number;
}

function findTopMatches(
  description: string,
  elements: InteractiveElement[],
  topN: number,
): ScoredMatch[] {
  const descLower = description.toLowerCase();
  const descWords = descLower.split(/\s+/);

  // Collect type hints from description
  const matchingTypeHints = new Set<string>();
  for (const word of descWords) {
    const types = TYPE_HINT_MAP[word];
    if (types) {
      for (const t of types) matchingTypeHints.add(t);
    }
  }

  const scored: ScoredMatch[] = [];

  for (const el of elements) {
    let maxScore = 0;

    // Score against text
    if (el.text) {
      maxScore = Math.max(maxScore, enhancedSimilarity(descLower, el.text.toLowerCase()));
    }

    // Score against locator value
    if (el.locator?.value) {
      maxScore = Math.max(maxScore, enhancedSimilarity(descLower, el.locator.value.toLowerCase()));
    }

    // Score against type (reduced weight)
    maxScore = Math.max(maxScore, enhancedSimilarity(descLower, el.type.toLowerCase()) * 0.5);

    // Boost if description contains the text or locator value
    if (el.text && descLower.includes(el.text.toLowerCase())) {
      maxScore = Math.max(maxScore, 0.85);
    }
    if (el.locator?.value && descLower.includes(el.locator.value.toLowerCase())) {
      maxScore = Math.max(maxScore, 0.85);
    }

    // Type-aware bonus
    if (matchingTypeHints.size > 0 && matchingTypeHints.has(el.type)) {
      maxScore = Math.min(1.0, maxScore + 0.15);
    }

    if (maxScore > 0.4) {
      scored.push({ element: el, score: maxScore });
    }
  }

  // Sort descending and take topN
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}

// ── Uniqueness ───────────────────────────────────────────────────────────────

interface ResolvedLocator {
  by: string;
  value: string;
  unique: boolean;
  duplicateCount: number;
}

function findBestUniqueLocator(
  element: InteractiveElement,
  allElements: InteractiveElement[],
): ResolvedLocator {
  // Strategy priority: key > semanticsLabel > text > original locator
  const strategies: Array<{ by: string; value: string | undefined }> = [
    { by: 'key', value: element.key },
    { by: 'semanticsLabel', value: element.locator?.by === 'semanticsLabel' ? element.locator.value : undefined },
    { by: 'text', value: element.text },
    { by: element.locator?.by ?? 'text', value: element.locator?.value },
  ];

  for (const strat of strategies) {
    if (!strat.value) continue;

    const count = countDuplicates(strat.by, strat.value, allElements);
    if (count === 1) {
      return { by: strat.by, value: strat.value, unique: true, duplicateCount: 1 };
    }
  }

  // Fallback: use original locator even if non-unique
  const by = element.locator?.by ?? 'text';
  const value = element.locator?.value ?? element.text ?? element.type;
  const count = countDuplicates(by, value, allElements);
  return { by, value, unique: count === 1, duplicateCount: count };
}

function countDuplicates(by: string, value: string, elements: InteractiveElement[]): number {
  let count = 0;
  for (const el of elements) {
    if (by === 'key' && el.key === value) count++;
    else if (by === 'text' && el.text === value) count++;
    else if (by === 'type' && el.type === value) count++;
    else if (el.locator?.by === by && el.locator?.value === value) count++;
  }
  return count || 1; // at least 1 (the element itself)
}

// ── Formatting helpers ───────────────────────────────────────────────────────

function formatElementCompact(el: InteractiveElement): string {
  const parts = [`#${el.index}`, el.type];
  if (el.text) parts.push(`"${el.text}"`);
  if (el.locator) parts.push(`${el.locator.by}:${el.locator.value}`);
  if (el.position) parts.push(`(${el.position.x},${el.position.y} ${el.position.width}x${el.position.height})`);
  if (el.enabled !== false) parts.push('enabled');
  else parts.push('disabled');
  return parts.join(' ');
}

interface SingleLocatorInfo {
  by: string;
  value: string;
  contextType: string;
  score: number;
  element: InteractiveElement | null;
  unique: boolean;
}

function formatSingleLocator(info: SingleLocatorInfo, description: string): string {
  const { by, value, contextType, score } = info;
  const constName = strategyPrefix(by) + toConstantName(value);
  let javaUsage: string;
  if (contextType === 'webview') {
    javaUsage = buildWebFinder(by, constName);
  } else if (contextType === 'native') {
    javaUsage = buildNativeFinder(by, constName);
  } else {
    javaUsage = buildFinder(by, constName);
  }

  const lines = [
    `## Locator for "${description}"\n`,
    `### Match #1 (confidence: ${(score * 100).toFixed(0)}%) [registry cache]\n`,
    `Compact:  ${by}:${value}`,
    `Unique:   Yes`,
    '',
    'Java:',
    `  private static final String ${constName} = "${escapeJava(value)}";`,
    `  // Usage: ${javaUsage}`,
  ];
  return lines.join('\n');
}

function detectContextType(context: string | undefined): 'flutter' | 'webview' | 'native' {
  if (!context) return 'flutter';
  if (context.startsWith('WEBVIEW')) return 'webview';
  if (context === 'NATIVE_APP') return 'native';
  return 'flutter';
}

function escapeJava(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ── Structured output (for AI-powered locator discovery) ─────────────────

interface StructuredLocatorResult {
  description: string;
  bestMatch: {
    type: string;
    text?: string;
    key?: string;
    semanticsLabel?: string;
    position?: { x: number; y: number; width: number; height: number };
    context: string;
    confidence: number;
  } | null;
  candidates: Array<{
    by: string;
    value: string;
    priority: number;
    verified?: boolean;
    matchCount?: number;
    javaCode: string;
  }>;
  parentKeys: string[];
  sourceInfo?: {
    dartClass: string;
    dartField: string;
    filePath: string;
    line: number;
  };
  sourceHint?: string;
  allElementsSummary: string;
}

const APPIUM_STRATEGIES: Record<string, string> = {
  key: '-flutter key',
  text: '-flutter text',
  type: '-flutter type',
  semanticsLabel: '-flutter semantics label',
  xpath: 'xpath',
  accessibilityId: 'accessibility id',
  css: 'css selector',
};

async function buildStructuredOutput(
  description: string,
  match: ScoredMatch,
  allElements: InteractiveElement[],
  verify: boolean,
): Promise<McpToolResponse> {
  const { element, score } = match;
  const contextType = detectContextType(element.context);

  // Build candidate locators in priority order
  const candidates: StructuredLocatorResult['candidates'] = [];
  let priority = 0;

  // Priority 1: ValueKey
  if (element.key) {
    candidates.push({
      by: 'key',
      value: element.key,
      priority: ++priority,
      javaCode: buildJavaCode('key', element.key, contextType),
    });
  }

  // Priority 2: semanticsLabel
  const semLabel = element.locator?.by === 'semanticsLabel' ? element.locator.value : undefined;
  if (semLabel) {
    candidates.push({
      by: 'semanticsLabel',
      value: semLabel,
      priority: ++priority,
      javaCode: buildJavaCode('semanticsLabel', semLabel, contextType),
    });
  }

  // Priority 3: text
  if (element.text) {
    candidates.push({
      by: 'text',
      value: element.text,
      priority: ++priority,
      javaCode: buildJavaCode('text', element.text, contextType),
    });
  }

  // Priority 4: type
  if (element.type && element.type !== 'Unknown') {
    candidates.push({
      by: 'type',
      value: element.type,
      priority: ++priority,
      javaCode: buildJavaCode('type', element.type, contextType),
    });
  }

  // For webview/native, add context-specific locators
  if (contextType === 'webview' && element.locator) {
    if (element.locator.by === 'css' || element.locator.by === 'xpath') {
      candidates.push({
        by: element.locator.by,
        value: element.locator.value,
        priority: ++priority,
        javaCode: buildJavaCode(element.locator.by, element.locator.value, contextType),
      });
    }
  }
  if (contextType === 'native' && element.locator) {
    if (element.locator.by === 'accessibilityId' || element.locator.by === 'xpath') {
      candidates.push({
        by: element.locator.by,
        value: element.locator.value,
        priority: ++priority,
        javaCode: buildJavaCode(element.locator.by, element.locator.value, contextType),
      });
    }
  }

  // Verify candidates on device
  if (verify && candidates.length > 0) {
    await verifyCandidates(candidates);
  }

  // Find parent keys (for descendant axis)
  const parentKeys = findParentKeys(element, allElements);

  // Get source info
  const sourceInfo = await getSourceInfoStructured(element.key || element.locator?.value);

  const result: StructuredLocatorResult = {
    description,
    bestMatch: {
      type: element.type,
      text: element.text,
      key: element.key,
      semanticsLabel: semLabel,
      position: element.position,
      context: contextType,
      confidence: score,
    },
    candidates,
    parentKeys,
    sourceInfo: sourceInfo || undefined,
    allElementsSummary: formatElementsCompact(allElements.slice(0, 20)),
  };

  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

function buildJavaCode(by: string, value: string, contextType: string): string {
  const escaped = escapeJava(value);
  if (contextType === 'webview') {
    switch (by) {
      case 'css': return `actions.webFindByCss("${escaped}")`;
      case 'xpath': return `actions.webFindByXPath("${escaped}")`;
      default: return `actions.webFindByCss("${escaped}")`;
    }
  }
  if (contextType === 'native') {
    switch (by) {
      case 'accessibilityId': return `actions.nativeFindByAccessibilityId("${escaped}")`;
      case 'xpath': return `actions.nativeFindByXPath("${escaped}")`;
      default: return `actions.nativeFindByXPath("${escaped}")`;
    }
  }
  switch (by) {
    case 'key': return `actions.byValueKey("${escaped}")`;
    case 'text': return `actions.byText("${escaped}")`;
    case 'type': return `actions.byType("${escaped}")`;
    case 'semanticsLabel': return `actions.bySemanticsLabel("${escaped}")`;
    default: return `actions.byValueKey("${escaped}")`;
  }
}

async function verifyCandidates(
  candidates: StructuredLocatorResult['candidates'],
): Promise<void> {
  let browser: WebdriverIO.Browser;
  try {
    browser = await getBrowserWithReconnect();
  } catch {
    return; // Can't verify without browser
  }

  for (const c of candidates) {
    const strategy = APPIUM_STRATEGIES[c.by];
    if (!strategy) {
      c.verified = false;
      c.matchCount = 0;
      continue;
    }
    try {
      await ensureContextForLocator(c.by, c.value);
      const elements = await browser.findElements(strategy, c.value);
      c.verified = true;
      c.matchCount = elements.length;
    } catch {
      c.verified = false;
      c.matchCount = 0;
    }
  }
}

function findParentKeys(
  target: InteractiveElement,
  allElements: InteractiveElement[],
): string[] {
  if (!target.position) return [];
  const parents: string[] = [];
  for (const el of allElements) {
    if (!el.key || !el.position || el === target) continue;
    // Check spatial containment: parent contains child
    if (
      el.position.x <= target.position.x &&
      el.position.y <= target.position.y &&
      el.position.x + el.position.width >= target.position.x + target.position.width &&
      el.position.y + el.position.height >= target.position.y + target.position.height &&
      // Parent must be bigger than the target
      el.position.width * el.position.height > target.position.width * target.position.height
    ) {
      parents.push(el.key);
    }
  }
  // Sort by area ascending (closest/smallest parent first)
  return parents.sort((a, b) => {
    const aEl = allElements.find(e => e.key === a);
    const bEl = allElements.find(e => e.key === b);
    const aArea = aEl?.position ? aEl.position.width * aEl.position.height : Infinity;
    const bArea = bEl?.position ? bEl.position.width * bEl.position.height : Infinity;
    return aArea - bArea;
  }).slice(0, 5); // Top 5 closest parents
}

async function getSourceInfoStructured(
  keyValue: string | undefined,
): Promise<{ dartClass: string; dartField: string; filePath: string; line: number } | null> {
  if (!keyValue) return null;
  try {
    const config = loadConfig();
    const index = await getDartSourceIndex(config.flutterAppPath, config.flutterComponentsPath);
    if (!index) return null;
    const defs = index.valueKeys.get(keyValue);
    if (!defs || defs.length === 0) return null;
    const def = defs[0];
    return {
      dartClass: def.dartClass,
      dartField: def.dartField || '',
      filePath: def.filePath.split('/').slice(-3).join('/'),
      line: def.line,
    };
  } catch {
    return null;
  }
}

// ── Source-aware helpers ──────────────────────────────────────────────────

async function getSourceKeyHint(description: string): Promise<string | null> {
  try {
    const config = loadConfig();
    const index = await getDartSourceIndex(config.flutterAppPath, config.flutterComponentsPath);
    if (!index) return null;

    const results = searchValueKeys(index, description);
    if (results.length === 0) return null;

    const lines = ['**Source-aware suggestion** (from Dart source):'];
    for (const def of results.slice(0, 3)) {
      const loc = def.source === 'test_keys' ? '[test_keys]' : '[inline]';
      lines.push(`  - \`${def.keyValue}\` ${loc} — ${def.dartClass}.${def.dartField || '(inline)'} (${def.filePath.split('/').slice(-2).join('/')}:${def.line})`);
    }
    return lines.join('\n');
  } catch {
    return null;
  }
}

async function getSourceKeyInfo(keyValue: string): Promise<string | null> {
  try {
    const config = loadConfig();
    const index = await getDartSourceIndex(config.flutterAppPath, config.flutterComponentsPath);
    if (!index) return null;

    const defs = index.valueKeys.get(keyValue);
    if (!defs || defs.length === 0) return null;

    const def = defs[0]; // Use first (preferred) definition
    const shortPath = def.filePath.split('/').slice(-2).join('/');
    if (def.dartField) {
      return `${def.dartClass}.${def.dartField} (${shortPath}:${def.line})`;
    }
    return `${shortPath}:${def.line}`;
  } catch {
    return null;
  }
}

// ── Java locator formatting helpers ───────────────────────────────────────
//
// These produce neutral Java snippets aimed at the appium-flutter-integration
// driver's `FlutterBy` finder for Flutter contexts and `AppiumBy` / `By` for
// native/webview contexts. Adjust to your own helper class if needed.

export function strategyPrefix(by: string): string {
  switch (by) {
    case 'key':            return 'KEY_';
    case 'text':           return 'TEXT_';
    case 'type':           return 'TYPE_';
    case 'semanticsLabel': return 'LABEL_';
    case 'xpath':          return 'XPATH_';
    case 'accessibilityId':return 'ACC_';
    case 'css':            return 'CSS_';
    default:               return 'LOC_';
  }
}

export function toConstantName(value: string): string {
  return value
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase() || 'X';
}

export function buildFinder(by: string, constName: string): string {
  switch (by) {
    case 'key':            return `driver.findElement(FlutterBy.valueKey(${constName}))`;
    case 'text':           return `driver.findElement(FlutterBy.text(${constName}))`;
    case 'type':           return `driver.findElement(FlutterBy.type(${constName}))`;
    case 'semanticsLabel': return `driver.findElement(FlutterBy.semanticsLabel(${constName}))`;
    default:               return `driver.findElement(FlutterBy.${by}(${constName}))`;
  }
}

export function buildNativeFinder(by: string, constName: string): string {
  switch (by) {
    case 'xpath':           return `driver.findElement(AppiumBy.xpath(${constName}))`;
    case 'accessibilityId': return `driver.findElement(AppiumBy.accessibilityId(${constName}))`;
    default:                return `driver.findElement(AppiumBy.${by}(${constName}))`;
  }
}

export function buildWebFinder(by: string, constName: string): string {
  switch (by) {
    case 'css':   return `driver.findElement(By.cssSelector(${constName}))`;
    case 'xpath': return `driver.findElement(By.xpath(${constName}))`;
    default:      return `driver.findElement(By.${by}(${constName}))`;
  }
}

/**
 * Shared hybrid-locator rules + heuristic re-ranker.
 *
 * Read by `flutter_locator` (structured + human output) and
 * `agentic_create_test` (agent contract) so the agent picks the locator
 * strategy that actually resolves on the live Appium-Flutter driver.
 *
 * Backed by live observations from the ZMA gallery screen — see
 * `org.devicefarm.FlutterBy` behaviour where `byType("Text")` / `byType("RichText")`
 * return 0 hits even when the widget tree contains them, while custom app
 * widget types resolve cleanly.
 */

/** Markdown block injected into every agent contract / case prompt. */
export const HYBRID_LOCATOR_RULES_MD = [
  '## Hybrid locator rules (verified live on iOS Flutter)',
  '- **`byType("Text")` and `byType("RichText")` are unreliable** — `org.devicefarm.FlutterBy.type(...)` does not resolve framework text widgets on iOS even when the widget tree contains them. For text matches, use `actions.byText("...")` instead.',
  '- **Custom app widget types resolve cleanly** — a PascalCase widget type from the app (not `Text` or `RichText`) works as a type locator.',
  '- **Icon-only buttons (Upload, Filter, Sort, etc.) need `bySemanticsLabel`** — they have no Text descendant so `byText("Upload")` returns 0. Try `actions.bySemanticsLabel("Upload")` first.',
  '- **No XPath axes in Flutter context** — `org.devicefarm.FlutterBy` only supports `key | text | type | semanticsLabel`. Write parent/child scoping in Java using `parent.findElement(FlutterBy.type("..."))` (descendant-only). Walk upward by iterating siblings, not by an ancestor axis.',
  '- **No `contains(text)`** — Flutter `byText` is exact. For substring match, fetch candidates and filter via `getText().contains(...)` in Java.',
  '- **Indexed access** — `[@text=\'X\'][1]` in XPath becomes `driver.findElements(FlutterBy.text("X")).get(0)` in Java.',
  '- **Locator priority** — `key` > `semanticsLabel` > `text` > `type` (custom only). Use `type` for built-in framework widgets only when scoped under a parent.',
].join('\n');

/**
 * Framework widget types that exist in the live tree but DO NOT resolve via
 * Appium-Flutter `FlutterBy.type(...)`. Verified live on iOS.
 *
 * Custom app widgets (PascalCase compound names) resolve fine — only the
 * generic Flutter framework primitives are blocked.
 */
export const BLOCKED_TYPE_LOCATORS = new Set<string>([
  'Text',
  'RichText',
  'Container',
  'Row',
  'Column',
  'Stack',
  'Padding',
  'Center',
  'SizedBox',
  'Expanded',
  'Flexible',
  'Spacer',
]);

export interface HeuristicCandidate {
  by: string;
  value: string;
  priority: number;
  verified?: boolean;
  matchCount?: number;
  javaCode: string;
  unsupported?: boolean;
  unsupportedReason?: string;
}

export interface HeuristicInputs {
  candidates: HeuristicCandidate[];
  /** Visible text on the target element (empty string for icon-only widgets). */
  elementText?: string;
  /** Semantics label on the target element, if any. */
  semanticsLabel?: string;
  /** Closest parent ValueKeys, ordered by area ascending. */
  parentKeys: string[];
  /** flutter | webview | native — only flutter applies the FlutterBy rules. */
  contextType: 'flutter' | 'webview' | 'native';
}

export interface HeuristicOutput {
  /** Free-text notes the agent should read before picking a candidate. */
  notes: string[];
  /**
   * Java snippet that scopes the chosen locator under the nearest parent
   * ValueKey — emitted when the best candidate has `matchCount > 1` and at
   * least one parent key is available.
   */
  parentScopedJavaCode?: string;
}

/**
 * Apply the hybrid rules to a candidate list. Mutates the candidates in place
 * (flags blocked type-locators) and returns advisory notes + an optional
 * parent-scoping snippet.
 */
export function applyHybridHeuristics(inputs: HeuristicInputs): HeuristicOutput {
  const { candidates, elementText, semanticsLabel, parentKeys, contextType } = inputs;
  const notes: string[] = [];

  // Only Flutter context has FlutterBy quirks — webview/native pass through.
  if (contextType !== 'flutter') {
    return { notes };
  }

  // 1. Flag `byType(blocked framework widget)` as unsupported and push to end.
  for (const c of candidates) {
    if (c.by === 'type' && BLOCKED_TYPE_LOCATORS.has(c.value)) {
      c.unsupported = true;
      c.unsupportedReason = `FlutterBy.type("${c.value}") does not resolve on iOS Flutter — use byText / bySemanticsLabel instead.`;
    }
  }

  // 2. Icon-only widget — promote semanticsLabel-based note when text is empty.
  if ((!elementText || !elementText.trim()) && semanticsLabel) {
    const hasSemCandidate = candidates.some(c => c.by === 'semanticsLabel');
    if (hasSemCandidate) {
      notes.push(`Element has no visible text but exposes semanticsLabel="${semanticsLabel}". Prefer \`actions.bySemanticsLabel("${escapeJava(semanticsLabel)}")\` over byText/byType for icon-only widgets.`);
    }
  }

  // 3. Non-unique best candidate — emit parent-scoping snippet.
  const verifiedNonUnique = candidates
    .filter(c => !c.unsupported && c.verified === true && (c.matchCount ?? 0) > 1)
    .sort((a, b) => a.priority - b.priority)[0];

  let parentScopedJavaCode: string | undefined;
  if (verifiedNonUnique && parentKeys.length > 0) {
    parentScopedJavaCode = buildParentScopedJava(
      parentKeys[0],
      verifiedNonUnique.by,
      verifiedNonUnique.value,
    );
    notes.push(
      `Best candidate \`${verifiedNonUnique.by}:${verifiedNonUnique.value}\` matches ${verifiedNonUnique.matchCount} elements — scope under the nearest parent ValueKey "${parentKeys[0]}" using the parentScopedJavaCode field.`,
    );
  }

  // 4. If we have a custom-type candidate that's verified+unique, mention it
  //    as a stable fallback (custom app types are platform-stable).
  const customTypeUnique = candidates.find(c =>
    c.by === 'type' && !c.unsupported && c.verified === true && c.matchCount === 1,
  );
  if (customTypeUnique && !candidates.some(c => c.by === 'key' && c.verified === true && c.matchCount === 1)) {
    notes.push(`No unique ValueKey, but custom widget type \`${customTypeUnique.value}\` is unique on this screen — safe to use \`byType("${customTypeUnique.value}")\`.`);
  }

  return { notes, parentScopedJavaCode };
}

/**
 * Build a Java parent-scoping snippet for ZMA's `AppActions` / `FlutterBy` API.
 *
 *   WebElement parent = actions.byValueKey("<parentKey>");
 *   WebElement target = parent.findElement(FlutterBy.<by>("<value>"));
 */
export function buildParentScopedJava(parentKey: string, by: string, value: string): string {
  const flutterByMethod = by === 'key' ? 'key'
    : by === 'text' ? 'text'
    : by === 'semanticsLabel' ? 'semanticsLabel'
    : by === 'type' ? 'type'
    : 'text';
  return [
    `WebElement parent = actions.byValueKey("${escapeJava(parentKey)}");`,
    `WebElement target = parent.findElement(FlutterBy.${flutterByMethod}("${escapeJava(value)}"));`,
  ].join('\n');
}

function escapeJava(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

import type { DartVMClient } from './dart-vm-client.js';
import { transformWidgetSummaryTree } from './vm-widget-tree.js';
import type { VMWidgetNode } from './vm-widget-tree.js';
import { matchLocatorInTree, enrichedTextMatches, type LocatorStrategy } from './verify-locator.js';
import { extractDeepLocators } from './deep-locators.js';
import { resolveCreationLocation } from '../source/source-resolver.js';

/** A creation-location entry resolved to an on-disk APP-source file. */
export interface AppSourceLocation { file: string; line: number; resolvedPath: string; }

/**
 * Walk UP from the tapped widget to the NEAREST ancestor whose creationLocation resolves to
 * APP source (under flutterAppPath / flutterComponentsPath), skipping framework / .pub-cache
 * leaves. Fixes the get_tap_selection blind spot where a tapped ZDS button surfaces only the
 * generic leaf (e.g. zen_foundation/button_widget.dart) instead of the app `ButtonProps` site
 * that actually created it (learned live 2026-07-26, PD-295764).
 *
 * Best-effort: returns undefined on any failure — it only ever ADDS an `appSource` hint, never
 * changes or breaks the existing leaf `source`. NOTE: getParentChain is intentionally NOT used
 * (its full-tree ids don't correlate — see resolveUniqueLocator); the summary-tree parent map is.
 */
export async function resolveNearestAppSource(
  client: DartVMClient,
  flutterAppPath?: string,
  flutterComponentsPath?: string,
  group = `appsrc-${Date.now()}`,
): Promise<AppSourceLocation | undefined> {
  if (!flutterAppPath && !flutterComponentsPath) return undefined;
  const isAppSource = (resolved: string | null): resolved is string =>
    !!resolved &&
    ((!!flutterAppPath && resolved.startsWith(flutterAppPath)) ||
      (!!flutterComponentsPath && resolved.startsWith(flutterComponentsPath)));
  try {
    let summaryRoot: VMWidgetNode;
    try {
      summaryRoot = transformWidgetSummaryTree(await client.getRootWidget(group));
    } catch {
      summaryRoot = transformWidgetSummaryTree(await client.getRootWidgetSummaryTreeInGroup(group));
    }
    const parent = new Map<VMWidgetNode, VMWidgetNode>();
    (function link(n: VMWidgetNode) {
      for (const c of (n.children ?? []) as VMWidgetNode[]) { parent.set(c, n); link(c); }
    })(summaryRoot);

    let sel = null;
    try { sel = await client.getSelectedWidget(group, ''); } catch { /* */ }
    if (!sel) { try { sel = await client.getSelectedSummaryWidget(group, ''); } catch { /* */ } }
    try { await client.callServiceExtension('ext.flutter.inspector.disposeGroup', { objectGroup: group }); } catch { /* */ }
    let node = sel ? findByValueId(summaryRoot, sel.valueId) : null;

    // Walk up; return the nearest ancestor (incl. self) that resolves to app source.
    while (node) {
      const cl = node.creationLocation;
      if (cl) {
        const resolved = resolveCreationLocation(cl.file, flutterAppPath, flutterComponentsPath);
        if (isAppSource(resolved)) return { file: cl.file, line: cl.line, resolvedPath: resolved };
      }
      node = parent.get(node) ?? null;
    }
  } catch { /* best-effort — no app source found */ }
  return undefined;
}

export type ResolveStrategy = 'own' | 'scoped' | 'scoped-indexed' | 'type-indexed' | 'none';

export interface ResolvedLocator {
  strategy: ResolveStrategy;
  unique: boolean;
  /** Ready-to-paste Java (zmauiautomation AppActions; multi-line for scoped). */
  java: string;
  /** One-line human explanation of how uniqueness was achieved. */
  explanation: string;
  parentKey?: string;
  target?: { by: LocatorStrategy; value: string };
  index?: number;
  matchCount?: number;
}

function stripGenerics(t: string): string {
  return (t || '').split(/[<(]/)[0].trim();
}
function escapeJava(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
function flutterBy(by: LocatorStrategy, value: string): string {
  const m = by === 'key' ? 'valueKey' : by; // text|type|semanticsLabel map 1:1
  return `FlutterBy.${m}("${escapeJava(value)}")`;
}
function appActions(by: LocatorStrategy, value: string): string {
  const v = escapeJava(value);
  switch (by) {
    case 'key': return `actions.byValueKey("${v}")`;
    case 'semanticsLabel': return `actions.bySemanticsLabel("${v}")`;
    case 'text': return `actions.byText("${v}")`;
    case 'type': return `actions.byType("${v}")`;
  }
}

function findByValueId(root: VMWidgetNode | null, vid: string): VMWidgetNode | null {
  if (!root) return null;
  if (root.valueId === vid) return root;
  for (const c of (root.children ?? []) as VMWidgetNode[]) {
    const f = findByValueId(c, vid);
    if (f) return f;
  }
  return null;
}

/**
 * Always produce a UNIQUE locator for the currently-selected widget, trying in
 * order: (1) own ValueKey if unique, (2) ancestor-scoped via a unique ancestor
 * ValueKey (descendant axis), (3) index among same-type matches (scoped to the
 * keyed ancestor when there is one, else global). Index is the guaranteed
 * backstop, so a unique locator always exists.
 *
 * Everything is computed inside the summary tree (one object group) so valueIds
 * are comparable: the selection is located via getSelectedSummaryWidget and
 * ancestors are walked via summary-tree parent links (getParentChain returns
 * full-tree ids that don't correlate, so it is intentionally not used).
 */
export async function resolveUniqueLocator(
  client: DartVMClient,
  group = `resolve-${Date.now()}`,
): Promise<ResolvedLocator> {
  // Unfiltered tree — covers framework text widgets (Text, RichText, etc.) so
  // byText / bySemanticsLabel uniqueness is computed against the same set
  // Appium-Flutter's find.text actually walks.
  let summaryRoot: VMWidgetNode;
  try {
    summaryRoot = transformWidgetSummaryTree(await client.getRootWidget(group));
  } catch {
    summaryRoot = transformWidgetSummaryTree(
      await client.getRootWidgetSummaryTreeInGroup(group),
    );
  }

  // child → parent map for ancestor walking
  const parent = new Map<VMWidgetNode, VMWidgetNode>();
  (function link(n: VMWidgetNode) {
    for (const c of (n.children ?? []) as VMWidgetNode[]) {
      parent.set(c, n);
      link(c);
    }
  })(summaryRoot);

  // Prefer the FULL selection (matches what the controller surfaces in the
  // Selection panel) — `getSelectedSummaryWidget` walks up to the nearest
  // creation-location-tracked ancestor and can return a wrapper instead of
  // the actual tapped widget (e.g. surfacing GuestDetailsBaseScreen when the
  // user tapped a SingleButtonRow nested inside it).
  let sel = null;
  try { sel = await client.getSelectedWidget(group, ''); } catch { /* fall through */ }
  if (!sel) {
    try { sel = await client.getSelectedSummaryWidget(group, ''); } catch { /* */ }
  }
  const sNode = sel ? findByValueId(summaryRoot, sel.valueId) : null;
  try { await client.callServiceExtension('ext.flutter.inspector.disposeGroup', { objectGroup: group }); } catch { /* ignore */ }

  if (!sNode) {
    return {
      strategy: 'none',
      unique: false,
      java: '// Could not locate the selected widget in the summary tree.',
      explanation: 'No selection, or the widget is outside the creation-location summary tree.',
    };
  }

  // Candidates that actually identify the tapped widget: its own
  // key/text/semanticsLabel (from the detail walk) plus its type. Ordered
  // key > semanticsLabel > text > type. (extractDeepLocators already ranks.)
  const deep = await extractDeepLocators(client, sNode.valueId ?? '', stripGenerics(sNode.type), group).catch(() => []);
  const cands: Array<{ by: LocatorStrategy; value: string }> = [];
  const pushCand = (by: LocatorStrategy, value: string) => {
    if (value && !cands.some((c) => c.by === by && c.value === value)) cands.push({ by, value });
  };
  for (const d of deep) {
    if (d.by === 'key' || d.by === 'text' || d.by === 'semanticsLabel') pushCand(d.by as LocatorStrategy, d.value);
  }
  pushCand('type', stripGenerics(sNode.type));

  // Count matches of a candidate within a scope. key/type walk the local tree
  // sync. text/semanticsLabel first try a direct walk (the unfiltered tree
  // carries textPreview on Text/RichText), then fall back to RPC enrichment
  // when previews are absent.
  const matchesIn = async (scope: VMWidgetNode, by: LocatorStrategy, value: string): Promise<VMWidgetNode[]> => {
    if (by === 'text' || by === 'semanticsLabel') {
      // textPreview on the unfiltered tree propagates up through wrappers
      // (Flexible, SelectionContainer, Semantics, …); filter to actual
      // text-bearing widgets to match Appium-Flutter's `find.text`.
      const TEXT_BEARING = /^(Text|RichText|EditableText|SelectableText|TextField|TextFormField|AutoSizeText)$/;
      const out: VMWidgetNode[] = [];
      const walk = (n: VMWidgetNode): void => {
        const v = by === 'text' ? n.text : n.semanticsLabel;
        if (v === value && (by === 'semanticsLabel' || TEXT_BEARING.test(n.type || ''))) out.push(n);
        for (const c of (n.children ?? []) as VMWidgetNode[]) walk(c);
      };
      walk(scope);
      if (out.length > 0) return out;
      return enrichedTextMatches(client, scope, by, value);
    }
    return matchLocatorInTree(scope, by, value);
  };

  // (1) own unique — key > semanticsLabel > text > type
  for (const c of cands) {
    if ((await matchesIn(summaryRoot, c.by, c.value)).length === 1) {
      return {
        strategy: 'own', unique: true, java: appActions(c.by, c.value),
        explanation: `Unique on its own (${c.by}).`, target: c, matchCount: 1,
      };
    }
  }

  // ancestors, nearest first
  const ancestors: VMWidgetNode[] = [];
  for (let a = parent.get(sNode); a; a = parent.get(a)) ancestors.push(a);

  // The locator that uniquely identifies an ancestor itself — ValueKey first
  // (most stable), else its type if that type appears exactly once globally.
  const anchorOf = (a: VMWidgetNode): { by: LocatorStrategy; value: string } | null => {
    if (a.key && matchLocatorInTree(summaryRoot, 'key', a.key).length === 1) return { by: 'key', value: a.key };
    const t = stripGenerics(a.type);
    if (t && matchLocatorInTree(summaryRoot, 'type', t).length === 1) return { by: 'type', value: t };
    return null;
  };
  const parentExpr = (anchor: { by: LocatorStrategy; value: string }): string =>
    anchor.by === 'key' ? `actions.byValueKey("${escapeJava(anchor.value)}")` : `actions.byType("${escapeJava(anchor.value)}")`;

  // (2) scope under the NEAREST uniquely-identifiable ancestor (key or type)
  for (const a of ancestors) {
    const anchor = anchorOf(a);
    if (!anchor) continue;
    const scopeNote = anchor.by === 'key' ? `key "${anchor.value}"` : `unique type "${anchor.value}"`;
    // target unique within the ancestor?
    for (const c of cands) {
      if (c.by === anchor.by && c.value === anchor.value) continue;
      if ((await matchesIn(a, c.by, c.value)).length === 1) {
        return {
          strategy: 'scoped', unique: true,
          java:
            `WebElement parent = ${parentExpr(anchor)};\n` +
            `WebElement target = parent.findElement(${flutterBy(c.by, c.value)});`,
          explanation: `Not unique alone; scoped under ancestor ${scopeNote} (unique within it by ${c.by}).`,
          parentKey: anchor.by === 'key' ? anchor.value : undefined, target: c, matchCount: 1,
        };
      }
    }
    // (2b) scoped + index within the ancestor (prefer text, else type)
    const c = cands.find((x) => x.by === 'text') ?? cands.find((x) => x.by !== 'key') ?? cands[0];
    const within = await matchesIn(a, c.by, c.value);
    const idx = within.findIndex((n) => n.valueId === sNode.valueId);
    if (idx >= 0) {
      return {
        strategy: 'scoped-indexed', unique: true,
        java:
          `WebElement parent = ${parentExpr(anchor)};\n` +
          `WebElement target = parent.findElements(${flutterBy(c.by, c.value)}).get(${idx});`,
        explanation: `Scoped under ancestor ${scopeNote}, then index ${idx} of ${within.length} by ${c.by}.`,
        parentKey: anchor.by === 'key' ? anchor.value : undefined, target: c, index: idx, matchCount: within.length,
      };
    }
  }

  // (3) global type index (always works)
  const c = { by: 'type' as LocatorStrategy, value: stripGenerics(sNode.type) };
  const all = matchLocatorInTree(summaryRoot, c.by, c.value);
  const idx = Math.max(0, all.findIndex((n) => n.valueId === sNode.valueId));
  return {
    strategy: 'type-indexed', unique: true,
    java: `// ${all.length} matches; this widget is index ${idx} (order approx — may differ from Appium)\nWebElement target = actions.findElements(${flutterBy(c.by, c.value)}).get(${idx});`,
    explanation: `No unique key, text, or uniquely-identifiable ancestor — fell back to global index ${idx} of ${all.length} by type. ⚠ Index order is approximate (summary tree, not Appium's). Prefer adding a ValueKey.`,
    target: c, index: idx, matchCount: all.length,
  };
}

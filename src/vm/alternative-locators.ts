/**
 * Compound / alternative locator patterns for the inspector.
 *
 * The primary `resolveUniqueLocator()` (resolve-locator.ts) returns ONE
 * guaranteed-unique locator using the own/scoped/scoped-indexed/type-indexed
 * chain. This module emits a small set of *additional* patterns the user might
 * prefer when porting tests from a web-style XPath project:
 *
 *   - parent-scoped         — descendant of each uniquely-keyed ancestor
 *   - parent-containing     — inverted-ancestor: iterate parents-of-type,
 *                             pick the one containing a known text descendant,
 *                             then read the target descendant from it
 *   - contains-text         — substring match on the widget's own text via a
 *                             Java stream filter (the FlutterBy API has no
 *                             contains() — this is the canonical workaround)
 *   - scoped-indexed-alt    — same shape as scoped-indexed but anchored on a
 *                             custom widget type rather than a ValueKey
 *
 * All snippets target zmauiautomation's `AppActions` / `org.devicefarm.FlutterBy`.
 */

import type { DartVMClient } from './dart-vm-client.js';
import { transformWidgetSummaryTree, type VMWidgetNode } from './vm-widget-tree.js';
import { matchLocatorInTree, enrichedTextMatches, type LocatorStrategy } from './verify-locator.js';
import { extractDeepLocators } from './deep-locators.js';
import { BLOCKED_TYPE_LOCATORS } from '../agent/locator-playbook.js';

export type AlternativeKind =
  | 'parent-scoped'
  | 'parent-containing'
  | 'contains-text'
  | 'scoped-indexed-alt';

/**
 * Structured parameters that mirror each compound Java snippet. The inspector
 * uses these to run the same query against the live summary tree, so the
 * Verify button can report match counts for compound patterns without us
 * shelling out to Maven.
 */
export type VerifyCompoundParams =
  | {
      kind: 'parent-scoped';
      parent: { by: LocatorStrategy; value: string };
      target: { by: LocatorStrategy; value: string };
    }
  | {
      kind: 'parent-containing';
      parentType: string;
      identifier: { by: 'text' | 'semanticsLabel'; value: string };
      targetType: string;
    }
  | {
      kind: 'contains-text';
      type: string;
      substring: string;
    };

export interface AlternativeLocator {
  kind: AlternativeKind;
  /** Ready-to-paste Java (multi-line). */
  java: string;
  /** One-line human explanation of when this pattern wins. */
  explanation: string;
  /** Parent widget ValueKey (parent-scoped) or type (parent-containing/scoped-indexed-alt). */
  parentAnchor?: { by: 'key' | 'type'; value: string };
  /** Structured params the inspector uses to run a live match count. */
  verify?: VerifyCompoundParams;
}

function stripGenerics(t: string): string {
  return (t || '').split(/[<(]/)[0].trim();
}
function escapeJava(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
function flutterBy(by: LocatorStrategy, value: string): string {
  const m = by === 'key' ? 'valueKey' : by;
  return `FlutterBy.${m}("${escapeJava(value)}")`;
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

function collectDescendantTexts(node: VMWidgetNode, cap = 8): string[] {
  const out: string[] = [];
  const walk = (n: VMWidgetNode): void => {
    if (out.length >= cap) return;
    if (n.text && n.text.trim().length >= 2 && n.text.trim().length <= 80) {
      out.push(n.text.trim());
    }
    for (const c of (n.children ?? []) as VMWidgetNode[]) walk(c);
  };
  walk(node);
  return out;
}

/**
 * Custom app widgets are stable cross-platform — generic Flutter
 * framework widgets (Row, Column, Container, etc.) are not. We only emit
 * compound patterns anchored on stable types.
 */
function isStableCustomType(type: string): boolean {
  const t = stripGenerics(type);
  if (!t) return false;
  if (BLOCKED_TYPE_LOCATORS.has(t)) return false;
  // Common framework widgets that exist by-name but aren't useful anchors.
  const generic = new Set([
    'GestureDetector', 'InkWell', 'ListTile', 'Card', 'Scaffold', 'AppBar',
    'Material', 'MaterialApp', 'Theme', 'Builder', 'StatefulBuilder',
    'AnimatedBuilder', 'StreamBuilder', 'FutureBuilder', 'ValueListenableBuilder',
    'BlocBuilder', 'BlocProvider', 'BlocListener', 'BlocConsumer',
    'MultiBlocProvider', 'MultiProvider', 'Provider', 'Consumer',
    'IgnorePointer', 'AbsorbPointer', 'PointerInterceptor', 'SafeArea',
    'MediaQuery', 'Directionality', 'Focus', 'FocusScope', 'FocusDetector',
    'PopScope', 'Listener', 'Semantics', 'MergeSemantics',
  ]);
  if (generic.has(t)) return false;
  // Heuristic: stable custom widgets are PascalCase compound names — 2+ caps.
  const capCount = (t.match(/[A-Z]/g) ?? []).length;
  return capCount >= 2;
}

/**
 * Emit 0-N compound locators for the tapped widget.
 *
 * Walks the same summary tree as `resolveUniqueLocator` (one extra fetch is
 * cheap, and keeping the modules independent means future changes to either
 * one stay local).
 */
export async function resolveAlternativeLocators(
  client: DartVMClient,
  group = `alt-${Date.now()}`,
): Promise<AlternativeLocator[]> {
  // Use the unfiltered tree so text-bearing descendants (Text, RichText) can
  // anchor parent-containing alternatives — they live in text.dart and are
  // absent from the creation-location summary tree.
  let summaryRoot: VMWidgetNode;
  try {
    summaryRoot = transformWidgetSummaryTree(await client.getRootWidget(group));
  } catch {
    try {
      summaryRoot = transformWidgetSummaryTree(
        await client.getRootWidgetSummaryTreeInGroup(group),
      );
    } catch {
      return [];
    }
  }

  const parent = new Map<VMWidgetNode, VMWidgetNode>();
  (function link(n: VMWidgetNode) {
    for (const c of (n.children ?? []) as VMWidgetNode[]) {
      parent.set(c, n);
      link(c);
    }
  })(summaryRoot);

  let sel;
  try {
    sel = await client.getSelectedSummaryWidget(group, '');
  } catch {
    sel = null;
  }
  const sNode = sel ? findByValueId(summaryRoot, sel.valueId) : null;
  try {
    await client.callServiceExtension('ext.flutter.inspector.disposeGroup', { objectGroup: group });
  } catch { /* ignore */ }
  if (!sNode) return [];

  const deep = await extractDeepLocators(client, sNode.valueId ?? '', stripGenerics(sNode.type), group).catch(() => []);
  const ownByText = deep.find(d => d.by === 'text')?.value;
  const ownType = stripGenerics(sNode.type);

  // Walk ancestors nearest-first.
  const ancestors: VMWidgetNode[] = [];
  for (let a = parent.get(sNode); a; a = parent.get(a)) ancestors.push(a);

  const alts: AlternativeLocator[] = [];
  const seenJava = new Set<string>();
  const push = (alt: AlternativeLocator): void => {
    if (seenJava.has(alt.java)) return;
    seenJava.add(alt.java);
    alts.push(alt);
  };

  // (A) For each ancestor with a stable custom type, emit a parent-containing
  //     inverted-ancestor pattern keyed on each descendant text we can see.
  //     This is the canonical translation of the web XPath:
  //       [@type='RichText',@text='X']/ancestor[@type='Y']/descendant[@type='Z']
  for (const a of ancestors) {
    const aType = stripGenerics(a.type);
    if (!isStableCustomType(aType)) continue;
    const parentTypeMatches = matchLocatorInTree(summaryRoot, 'type', aType).length;
    if (parentTypeMatches < 2) continue; // only useful when the parent type is repeated (list items)

    const siblingTexts = collectDescendantTexts(a, 6).filter(t => t !== ownByText);
    if (siblingTexts.length === 0 || !ownType || BLOCKED_TYPE_LOCATORS.has(ownType)) continue;

    // Prefer the longest text as the "identifying" sibling.
    const identifier = [...siblingTexts].sort((x, y) => y.length - x.length)[0];

    push({
      kind: 'parent-containing',
      parentAnchor: { by: 'type', value: aType },
      java: [
        `// Inverted-ancestor: pick the ${aType} whose descendant text matches, then read its ${ownType}.`,
        `WebElement target = actions.findElementsByType("${escapeJava(aType)}").stream()`,
        `    .filter(p -> !p.findElements(FlutterBy.text("${escapeJava(identifier)}")).isEmpty())`,
        `    .findFirst()`,
        `    .orElseThrow()`,
        `    .findElement(FlutterBy.type("${escapeJava(ownType)}"));`,
      ].join('\n'),
      explanation: `Iterate ${aType} siblings, pick the one containing "${identifier}", then read the ${ownType} descendant. Same shape as web XPath ancestor/descendant.`,
      verify: {
        kind: 'parent-containing',
        parentType: aType,
        identifier: { by: 'text', value: identifier },
        targetType: ownType,
      },
    });
    break; // only the nearest repeating-list ancestor
  }

  // (B) Parent-scoped descendant — emit ONE alternative per ancestor with a
  //     unique ValueKey OR a unique stable type, separate from the primary
  //     resolved locator (which uses the nearest one).
  for (const a of ancestors.slice(1, 4)) { // skip the nearest (it's the primary) + cap depth
    let anchor: { by: 'key' | 'type'; value: string } | null = null;
    if (a.key && matchLocatorInTree(summaryRoot, 'key', a.key).length === 1) {
      anchor = { by: 'key', value: a.key };
    } else {
      const t = stripGenerics(a.type);
      if (isStableCustomType(t) && matchLocatorInTree(summaryRoot, 'type', t).length === 1) {
        anchor = { by: 'type', value: t };
      }
    }
    if (!anchor) continue;

    // Pick the most informative locator the target carries.
    const pick = deep.find(d => d.by === 'key')
      ?? deep.find(d => d.by === 'semanticsLabel')
      ?? deep.find(d => d.by === 'text')
      ?? (ownType && !BLOCKED_TYPE_LOCATORS.has(ownType) ? { by: 'type', value: ownType, confidence: 0.4 } : null);
    if (!pick) continue;

    const parentExpr = anchor.by === 'key'
      ? `actions.byValueKey("${escapeJava(anchor.value)}")`
      : `actions.byType("${escapeJava(anchor.value)}")`;
    push({
      kind: 'parent-scoped',
      parentAnchor: anchor,
      java: [
        `WebElement parent = ${parentExpr};`,
        `WebElement target = parent.findElement(${flutterBy(pick.by as LocatorStrategy, pick.value)});`,
      ].join('\n'),
      explanation: `Alternative anchor — descendant of ${anchor.by === 'key' ? `key "${anchor.value}"` : `unique type "${anchor.value}"`}.`,
      verify: {
        kind: 'parent-scoped',
        parent: { by: anchor.by as LocatorStrategy, value: anchor.value },
        target: { by: pick.by as LocatorStrategy, value: pick.value },
      },
    });
  }

  // (C) Contains-text — if the widget has its own text, emit the canonical
  //     "substring match" pattern (FlutterBy has no contains operator).
  if (ownByText && ownByText.length >= 4 && ownType && !BLOCKED_TYPE_LOCATORS.has(ownType)) {
    const substring = ownByText.length > 16 ? ownByText.slice(0, 12) : ownByText;
    push({
      kind: 'contains-text',
      java: [
        `// FlutterBy has no contains() — filter type matches by getText().`,
        `WebElement target = actions.findElementsByType("${escapeJava(ownType)}").stream()`,
        `    .filter(e -> e.getText() != null && e.getText().contains("${escapeJava(substring)}"))`,
        `    .findFirst()`,
        `    .orElseThrow();`,
      ].join('\n'),
      explanation: `Substring match on the widget's own text ("${substring}") — useful when full text is dynamic / truncated.`,
      verify: {
        kind: 'contains-text',
        type: ownType,
        substring,
      },
    });
  }

  return alts;
}

// ---------------------------------------------------------------------------
// Live verification — runs the same query the Java snippet describes against
// the current summary tree and reports how many widgets match.
// ---------------------------------------------------------------------------

export interface CompoundVerifyResult {
  kind: AlternativeKind;
  matchCount: number;
  unique: boolean;
  /** Free-text breakdown — e.g. "3 parents of type X, 1 contained 'filename', 2 Image descendants in it". */
  detail: string;
}

export async function verifyCompoundLocator(
  client: DartVMClient,
  params: VerifyCompoundParams,
): Promise<CompoundVerifyResult> {
  const group = `compound-verify-${Date.now()}`;
  // Use the UNFILTERED widget tree — Text/RichText/EditableText live in the
  // Flutter framework (text.dart) and are excluded from the creation-location
  // summary tree. Falls back to the summary tree on older Flutter that lacks
  // the unfiltered RPC.
  let root: VMWidgetNode | null = null;
  try {
    root = transformWidgetSummaryTree(await client.getRootWidget(group));
  } catch {
    try {
      root = transformWidgetSummaryTree(await client.getRootWidgetSummaryTreeInGroup(group));
    } catch {
      root = null;
    }
  }
  try {
    await client.callServiceExtension('ext.flutter.inspector.disposeGroup', { objectGroup: group });
  } catch { /* ignore */ }

  if (!root) {
    return { kind: params.kind, matchCount: 0, unique: false, detail: 'Could not fetch widget tree.' };
  }
  const summaryRoot = root;

  const matchesIn = async (scope: VMWidgetNode, by: LocatorStrategy, value: string): Promise<VMWidgetNode[]> => {
    if (by === 'text' || by === 'semanticsLabel') {
      // Walk the unfiltered subtree. textPreview propagates upward, so we
      // only count actual text-bearing leaf widgets to match Appium-Flutter's
      // find.text behaviour.
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

  if (params.kind === 'parent-scoped') {
    const parents = await matchesIn(summaryRoot, params.parent.by, params.parent.value);
    if (parents.length === 0) {
      return { kind: 'parent-scoped', matchCount: 0, unique: false, detail: `Parent ${params.parent.by}="${params.parent.value}" not found.` };
    }
    if (parents.length > 1) {
      return { kind: 'parent-scoped', matchCount: 0, unique: false, detail: `Parent ${params.parent.by}="${params.parent.value}" is not unique (${parents.length} matches) — pick a more specific anchor.` };
    }
    const targets = await matchesIn(parents[0], params.target.by, params.target.value);
    return {
      kind: 'parent-scoped',
      matchCount: targets.length,
      unique: targets.length === 1,
      detail: `1 parent · ${targets.length} ${params.target.by}="${params.target.value}" descendant${targets.length === 1 ? '' : 's'} inside.`,
    };
  }

  if (params.kind === 'parent-containing') {
    const parents = matchLocatorInTree(summaryRoot, 'type', params.parentType);
    if (parents.length === 0) {
      return { kind: 'parent-containing', matchCount: 0, unique: false, detail: `No widgets of type "${params.parentType}" on screen.` };
    }
    let containing = 0;
    let firstMatchingTargets = -1;
    for (const p of parents) {
      const ids = await matchesIn(p, params.identifier.by, params.identifier.value);
      if (ids.length > 0) {
        containing += 1;
        if (firstMatchingTargets < 0) {
          const targets = matchLocatorInTree(p, 'type', params.targetType);
          firstMatchingTargets = targets.length;
        }
      }
    }
    const inner = firstMatchingTargets >= 0 ? firstMatchingTargets : 0;
    return {
      kind: 'parent-containing',
      matchCount: containing === 0 ? 0 : (inner === 1 ? 1 : 0),
      unique: containing === 1 && inner === 1,
      detail: `${parents.length} ${params.parentType}, ${containing} contained "${params.identifier.value}", ${inner} ${params.targetType} descendant${inner === 1 ? '' : 's'} in the first match.`,
    };
  }

  if (params.kind === 'contains-text') {
    const all = matchLocatorInTree(summaryRoot, 'type', params.type);
    if (all.length === 0) {
      return { kind: 'contains-text', matchCount: 0, unique: false, detail: `No widgets of type "${params.type}" on screen.` };
    }
    // Check own text first, then descendant text — summary tree carries
    // textPreview for Text widgets, so the walk is cheap (no RPCs).
    const subtreeContains = (n: VMWidgetNode, sub: string): boolean => {
      if (n.text && n.text.includes(sub)) return true;
      for (const c of (n.children ?? []) as VMWidgetNode[]) {
        if (subtreeContains(c, sub)) return true;
      }
      return false;
    };
    const matched = all.filter(n => subtreeContains(n, params.substring));
    return {
      kind: 'contains-text',
      matchCount: matched.length,
      unique: matched.length === 1,
      detail: `${all.length} ${params.type} on screen, ${matched.length} contain "${params.substring}".`,
    };
  }

  return { kind: (params as VerifyCompoundParams).kind, matchCount: 0, unique: false, detail: 'Unknown compound kind.' };
}

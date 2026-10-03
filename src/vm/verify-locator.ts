import type { DartVMClient, WidgetSummaryNode } from './dart-vm-client.js';
import { transformWidgetSummaryTree } from './vm-widget-tree.js';
import type { VMWidgetNode } from './vm-widget-tree.js';
import { vmWaitFor } from './vm-actions.js';
import { extractFromProperties } from './deep-locators.js';
import { vmLogger as logger } from './vm-logger.js';

const TEXT_TYPE = /text/i; // Text, RichText, EditableText, SelectableText, *TextField*

/**
 * Count text/semanticsLabel matches by enriching text-bearing nodes via details
 * — the summary tree carries no text on this build, so a plain tree walk can't
 * see it. Bounded by node count to stay responsive (text-type nodes only).
 */
export async function enrichedTextMatches(
  client: DartVMClient,
  root: VMWidgetNode,
  by: 'text' | 'semanticsLabel',
  value: string,
  cap = 300,
): Promise<VMWidgetNode[]> {
  const candidates: VMWidgetNode[] = [];
  const collect = (n: VMWidgetNode): void => {
    if (candidates.length >= cap) return;
    // For text, only text-type widgets can match (mirrors Flutter ByText). For
    // semanticsLabel any widget may carry one, so scan all (still capped).
    if (by === 'semanticsLabel' || TEXT_TYPE.test(n.type || '')) candidates.push(n);
    for (const c of (n.children ?? []) as VMWidgetNode[]) collect(c);
  };
  collect(root);

  const matched: VMWidgetNode[] = [];
  for (const n of candidates) {
    if (!n.valueId) continue;
    try {
      const raw = (await client.callServiceExtension(
        'ext.flutter.inspector.getDetailsSubtree',
        { arg: n.valueId, objectGroup: 'verify-enrich', subtreeDepth: 4 },
      )) as any;
      const node = raw?.result ?? raw;
      const found = { keys: [] as string[], texts: [] as string[], semantics: [] as string[], tooltips: [] as string[] };
      // BFS through the candidate's subtree (matches extractDeepLocators) so we
      // surface text from grandchildren — RichText stores its content in
      // TextSpan descendants, not on the RichText node itself.
      const queue: Array<{ node: any; depth: number }> = [{ node, depth: 0 }];
      let visited = 0;
      const MAX_NODES = 60;
      const MAX_DEPTH = 4;
      while (queue.length > 0 && visited < MAX_NODES) {
        const { node: cur, depth } = queue.shift()!;
        visited++;
        extractFromProperties(cur, found);
        if (depth < MAX_DEPTH && Array.isArray(cur?.children)) {
          for (const child of cur.children) {
            if (child?.valueId || child?.properties || Array.isArray(child?.children)) {
              queue.push({ node: child, depth: depth + 1 });
            }
          }
        }
      }
      const vals = by === 'text' ? found.texts : found.semantics;
      if (vals.includes(value)) matched.push(n);
    } catch { /* skip */ }
  }
  return matched;
}

export type LocatorStrategy = 'key' | 'text' | 'type' | 'semanticsLabel';

export interface VerifyMatch {
  type: string;
  key?: string;
  text?: string;
  valueId?: string;
  position?: { x: number; y: number; width: number; height: number };
}

export interface VerifyResult {
  by: LocatorStrategy;
  value: string;
  matchCount: number;
  unique: boolean;
  matches: VerifyMatch[];
  /** Best-effort Flutter-driver finder confirmation; undefined when the driver
   *  extension isn't registered (plain `flutter run --debug`). */
  driverFound?: boolean;
  /** Whether the first match was highlighted on the device via setSelectionById. */
  highlighted: boolean;
  /** When not unique: index of the currently-selected widget among the matches. */
  selectedIndex?: number;
  /** When not unique: indexed locator pinning the selected widget (…get(i)). */
  indexedJava?: string;
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

/**
 * Count how many widgets in the tree match a (by, value) locator, mirroring the
 * Appium-side `countDuplicates` semantics in src/tools/locator.ts: exact match
 * on key/text/semanticsLabel, and generics-stripped exact match on type.
 * Walks the FULL tree (not just interactive nodes) — text/type can match
 * non-interactive widgets, matching how Appium findElements behaves.
 */
export function matchLocatorInTree(
  root: VMWidgetNode | VMWidgetNode[] | null,
  by: LocatorStrategy,
  value: string,
): VMWidgetNode[] {
  const matches: VMWidgetNode[] = [];
  const wantType = by === 'type' ? stripGenerics(value) : value;

  const visit = (node: VMWidgetNode): void => {
    let hit = false;
    switch (by) {
      case 'key': hit = node.key === value; break;
      case 'text': hit = node.text === value; break;
      case 'semanticsLabel': hit = node.semanticsLabel === value; break;
      case 'type': hit = stripGenerics(node.type) === wantType; break;
    }
    if (hit) matches.push(node);
    const children = node.children as VMWidgetNode[] | undefined;
    if (children) for (const c of children) visit(c);
  };

  if (Array.isArray(root)) root.forEach((n) => visit(n));
  else if (root) visit(root);
  return matches;
}

/**
 * All widgets matching a (by, value) locator, in tree order.
 *
 * Walks the UNFILTERED widget tree for every strategy:
 *   - text / semanticsLabel — framework Text/RichText/EditableText live in
 *     `text.dart` and are excluded from the creation-location summary tree.
 *   - key / type — using the unfiltered tree is a strict superset, so any key
 *     present in the summary tree is also present here. Using the same fresh
 *     `getRootWidget()` group avoids stale-default-group dropouts that caused
 *     "key not found" for widgets that are demonstrably on screen.
 */
export async function findMatches(
  client: DartVMClient,
  by: LocatorStrategy,
  value: string,
): Promise<VMWidgetNode[]> {
  let fullRoot: WidgetSummaryNode | null = null;
  try {
    fullRoot = await client.getRootWidget(`find-matches-${Date.now()}`);
  } catch (err) {
    logger.debug('getRootWidget failed, falling back to summary tree', { error: String(err) });
  }
  if (fullRoot) {
    const tree = transformWidgetSummaryTree(fullRoot);
    if (by === 'text' || by === 'semanticsLabel') {
      const direct = matchTextInTree(tree, by, value);
      if (direct.length > 0) return direct;
      return enrichedTextMatches(client, tree, by, value);
    }
    return matchLocatorInTree(tree, by, value);
  }
  // Last resort fallback.
  const tree = transformWidgetSummaryTree(await client.getRootWidgetSummaryTree());
  if (by === 'text' || by === 'semanticsLabel') {
    return enrichedTextMatches(client, tree, by, value);
  }
  return matchLocatorInTree(tree, by, value);
}

/**
 * Walk the unfiltered tree and collect text/semanticsLabel matches WITHOUT
 * RPC enrichment — the full widget tree (via getRootWidgetTree with
 * withPreviews=true) carries text on Text/RichText/EditableText nodes
 * directly.
 *
 * For `by: "text"`, we filter to widgets that actually carry their own text
 * (Text, RichText, EditableText, SelectableText, TextField, TextFormField).
 * Without this filter the count would also include every wrapper above them
 * (Flexible, Semantics, SelectionContainer …) whose `textPreview` is
 * propagated up from a child — Appium-Flutter's `find.text` matches only the
 * leaf, so we mirror that.
 */
const TEXT_BEARING_TYPES = /^(Text|RichText|EditableText|SelectableText|TextField|TextFormField|AutoSizeText)$/;

function matchTextInTree(
  root: VMWidgetNode | null,
  by: 'text' | 'semanticsLabel',
  value: string,
): VMWidgetNode[] {
  if (!root) return [];
  const out: VMWidgetNode[] = [];
  const walk = (n: VMWidgetNode): void => {
    const v = by === 'text' ? n.text : n.semanticsLabel;
    if (v === value && (by === 'semanticsLabel' || TEXT_BEARING_TYPES.test(n.type || ''))) {
      out.push(n);
    }
    for (const c of (n.children ?? []) as VMWidgetNode[]) walk(c);
  };
  walk(root);
  return out;
}

/**
 * Verify a locator against the live device: count matches in the current VM
 * widget tree, highlight the first match on-device, and (best-effort) confirm
 * via the Flutter driver finder when available.
 */
export async function verifyLocator(
  client: DartVMClient,
  by: LocatorStrategy,
  value: string,
  opts: { highlight?: boolean; platform?: string } = {},
): Promise<VerifyResult> {
  const highlight = opts.highlight ?? true;
  // Lightweight: one VM call + local transform. We deliberately avoid
  // buildVMWidgetTree here — its per-node getDetailsSubtree enrichment is
  // expensive and, combined with the 300ms select-mode poll, starves the VM
  // (observed tree builds >50s + getSelectedSummaryWidget timeouts). The
  // summary tree carries key/text/type directly; semanticsLabel is best-effort
  // (not enriched on this path).
  const nodes = await findMatches(client, by, value);

  // When not unique, pin the CURRENTLY-selected widget by its index among the
  // matches. Read the selection BEFORE highlighting (which would overwrite it).
  let selectedIndex: number | undefined;
  let indexedJava: string | undefined;
  if (nodes.length > 1) {
    try {
      const sel = await client.getSelectedSummaryWidget(undefined, '');
      const i = sel ? nodes.findIndex((n) => n.valueId === sel.valueId) : -1;
      if (i >= 0) {
        selectedIndex = i;
        indexedJava = `actions.findElements(${flutterBy(by, value)}).get(${i})`;
      }
    } catch { /* best-effort */ }
  }

  let highlighted = false;
  const first = nodes.find((n) => n.valueId);
  if (highlight && first?.valueId) {
    try {
      await client.setSelectionById(first.valueId);
      highlighted = true;
    } catch (err) {
      logger.debug('verifyLocator highlight failed', { error: String(err) });
    }
  }

  // Optional stronger signal — flutter_driver registers ONE bare extension
  // (ext.flutter.driver, command-dispatched); per-command names never appear.
  // integration_test builds register the same name but only a health subset:
  // a protocol-level error there means "unknown", not "not found".
  let driverFound: boolean | undefined;
  if (client.hasExtension('ext.flutter.driver')) {
    try {
      await vmWaitFor(client, by, value, 2);
      driverFound = true;
    } catch (err) {
      driverFound = String(err).includes('VM Service error') ? undefined : false;
    }
  }

  return {
    by,
    value,
    matchCount: nodes.length,
    unique: nodes.length === 1,
    matches: nodes.slice(0, 20).map((n) => ({
      type: n.type,
      key: n.key,
      text: n.text,
      valueId: n.valueId,
      position: n.position,
    })),
    driverFound,
    highlighted,
    selectedIndex,
    indexedJava,
  };
}

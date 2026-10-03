import type { WidgetNode } from './types.js';

/**
 * Options controlling how aggressively `pruneTreeForLocators` prunes a widget tree.
 */
export interface PruneTreeOptions {
  /**
   * true (default): drop non-interactive nodes/subtrees that have no interactive
   * descendant, even if they carry identity (text/key/semanticsLabel).
   * false: also retain identity-bearing non-interactive nodes as static anchors
   * (section headers, prices, static copy) useful for disambiguating locators
   * (e.g. "the button under the 'Payment Details' header").
   */
  interactiveOnly?: boolean;
  /**
   * Safety backstop against pathological/runaway trees — NOT a routine limit.
   * Verified live: a perfectly ordinary Flutter screen (calendar/booking view) is
   * already 86 raw levels deep before any collapsing, almost entirely from
   * legitimate widget composition (every layout wraps a child in another widget).
   * The cap only exists to guard against a genuinely pathological/runaway tree —
   * it must stay well above any depth real, non-pathological UI can reach.
   * Default 150.
   */
  maxDepth?: number;
  /** Max chars kept per `text` field before truncating with an ellipsis. Default 100. */
  maxTextLen?: number;
}

interface PruneResult {
  node: WidgetNode | null;
  hasInteractive: boolean;
}

const DEFAULT_MAX_DEPTH = 150;
const DEFAULT_MAX_TEXT_LEN = 100;

/**
 * Produce a hierarchical, automation-relevant WidgetNode tree for the
 * get_widget_tree `format: "tree"` branch.
 *
 * Operates purely on the already-converged `WidgetNode` tree returned by
 * `buildWidgetTree()` (post whichever data-path-specific `condenseTree()` already
 * ran) — this function is data-source-agnostic and does not touch the VM or
 * Appium fetch paths.
 *
 * Unlike the fixed `LAYOUT_ONLY_TYPES` collapsing used upstream, this generalizes
 * to ANY identity-less, non-interactive, single-child wrapper node (BlocProvider<X>,
 * MultiProvider, Directionality, MaterialApp, Overlay, Scaffold, etc. — none of
 * which appear in `LAYOUT_ONLY_TYPES` but are pure structural noise in practice),
 * and additionally strips heavy per-node metadata (`valueId`, `creationLocation`,
 * `allLocators`, `properties`, `sourceContext`) that serves no purpose for an LLM
 * building a locator.
 *
 * Dropping pure-decorative leaves here is safe: any locator built from this
 * snapshot is resolved fresh against the live tree at tap-time (via
 * find_elements / VM locator resolution), not against this cached representation,
 * so removing nodes cannot desync index-based locators like
 * `getAllByType('Icon')[8]`.
 */
export function pruneTreeForLocators(
  node: WidgetNode,
  opts?: PruneTreeOptions,
): WidgetNode | null {
  const interactiveOnly = opts?.interactiveOnly !== false;
  const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxTextLen = opts?.maxTextLen ?? DEFAULT_MAX_TEXT_LEN;
  return pruneRec(node, interactiveOnly, maxDepth, maxTextLen, 0).node;
}

/** A node has "identity" if it carries something an agent could use to recognize/target it. */
function hasIdentity(node: WidgetNode): boolean {
  if (node.key) return true;
  if (node.text && node.text.trim().length > 0) return true;
  if (node.semanticsLabel && node.semanticsLabel.trim().length > 0) return true;
  // A bare 'type' locator is a generic fallback with no real disambiguating signal —
  // it doesn't count as identity on its own.
  if (node.locator && node.locator.by !== 'type') return true;
  return false;
}

/** Emit a node with only automation-relevant fields; drops valueId/creationLocation/allLocators/properties/sourceContext. */
function stripFields(node: WidgetNode, maxTextLen: number): WidgetNode {
  const out: WidgetNode = {
    type: node.type,
    interactive: node.interactive,
  };
  if (node.key) out.key = node.key;
  if (node.text) {
    out.text = node.text.length > maxTextLen ? node.text.slice(0, maxTextLen) + '…' : node.text;
  }
  if (node.semanticsLabel) out.semanticsLabel = node.semanticsLabel;
  // Only the informative case (false) is worth a token — `true` is the overwhelming default.
  if (node.enabled === false) out.enabled = false;
  if (node.displayed === false) out.displayed = false;
  if (node.position) out.position = node.position;
  if (node.locator) out.locator = node.locator;
  return out;
}

function containsInteractive(node: WidgetNode): boolean {
  if (node.interactive) return true;
  if (node.children) {
    for (const child of node.children) {
      if (containsInteractive(child)) return true;
    }
  }
  return false;
}

function countNodes(node: WidgetNode): number {
  let count = 1;
  if (node.children) {
    for (const child of node.children) count += countNodes(child);
  }
  return count;
}

/**
 * Render a pruned tree as indented text — one node per line. Compared to the
 * old pretty-printed JSON (which repeated `"type"`, `"interactive"`, `"locator"`
 * object keys on every node and duplicated the flat element list), this cuts
 * the format="tree" payload ~8-10x while staying hierarchical.
 *
 * Line shape: `Type key:foo "text" sem:label (x,y wxh) [disabled]`
 */
export function renderTreeAsText(node: WidgetNode, depth = 0): string {
  const indent = '  '.repeat(depth);
  const parts: string[] = [node.type];
  if (node.key) parts.push(`key:${node.key}`);
  if (node.text) parts.push(`"${node.text}"`);
  if (node.semanticsLabel && node.semanticsLabel !== node.text) parts.push(`sem:${node.semanticsLabel}`);
  if (node.position) parts.push(`(${node.position.x},${node.position.y} ${node.position.width}x${node.position.height})`);
  if (node.enabled === false) parts.push('[disabled]');
  if (node.properties && (node.properties as Record<string, unknown>).truncatedAtMaxDepth) {
    parts.push(`[+${(node.properties as Record<string, unknown>).hiddenDescendantCount} hidden]`);
  }

  const lines = [indent + parts.join(' ')];
  if (node.children) {
    for (const child of node.children) {
      lines.push(renderTreeAsText(child, depth + 1));
    }
  }
  return lines.join('\n');
}

function pruneRec(
  node: WidgetNode,
  interactiveOnly: boolean,
  maxDepth: number,
  maxTextLen: number,
  depth: number,
): PruneResult {
  // Depth backstop: stop expanding further, but never silently vanish real content —
  // emit an explicit truncation stub so the agent sees evidence something was hidden
  // rather than concluding an element doesn't exist.
  if (depth >= maxDepth) {
    const identity = hasIdentity(node);
    if (node.interactive || identity) {
      const stub = stripFields(node, maxTextLen);
      const hiddenCount = countNodes(node) - 1;
      if (hiddenCount > 0) {
        stub.properties = { truncatedAtMaxDepth: true, hiddenDescendantCount: hiddenCount };
      }
      return { node: stub, hasInteractive: node.interactive };
    }
    if (containsInteractive(node)) {
      const stub = stripFields(node, maxTextLen);
      stub.properties = { truncatedAtMaxDepth: true, hiddenDescendantCount: countNodes(node) - 1 };
      return { node: stub, hasInteractive: true };
    }
    return { node: null, hasInteractive: false };
  }

  // Recurse into children first (bottom-up).
  const survivingChildren: WidgetNode[] = [];
  let hasInteractiveDescendant = false;
  if (node.children) {
    for (const child of node.children) {
      const childResult = pruneRec(child, interactiveOnly, maxDepth, maxTextLen, depth + 1);
      if (childResult.node) survivingChildren.push(childResult.node);
      if (childResult.hasInteractive) hasInteractiveDescendant = true;
    }
  }

  const identity = hasIdentity(node);
  const hasInteractive = node.interactive || hasInteractiveDescendant;

  // Keep decision: interactive nodes and structural bridges to interactive descendants
  // are always kept; identity-bearing static anchors are kept only when interactiveOnly=false.
  const keep = node.interactive || hasInteractiveDescendant || (!interactiveOnly && identity);
  if (!keep) {
    return { node: null, hasInteractive: false };
  }

  // Structural collapse: an identity-less, non-interactive pass-through wrapper with
  // exactly one surviving child is spliced away, regardless of its type name — this is
  // what eats arbitrary BlocProvider<X>/MultiProvider/Scaffold-style wrapper chains
  // without needing a hand-maintained type allowlist.
  if (!node.interactive && !identity && survivingChildren.length === 1) {
    return { node: survivingChildren[0], hasInteractive };
  }

  const out = stripFields(node, maxTextLen);
  if (survivingChildren.length > 0) out.children = survivingChildren;
  return { node: out, hasInteractive };
}

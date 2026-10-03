import type { DartVMClient } from './dart-vm-client.js';
import type { LocatorCandidate } from './vm-widget-tree.js';

const DEFAULT_OBJECT_GROUP = 'deep-locators-group';

// Caps so a large/ancestor selection (e.g. MediaQuery) can't flood the result
// with every Text on the screen. Locators should describe the TAPPED widget,
// not its whole subtree.
const MAX_DEPTH = 4;
const MAX_NODES = 80;
const MAX_TEXTS = 3;
const MAX_SEMANTICS = 2;
const MAX_TOOLTIPS = 2;

// Junk that shows up when a non-text `data` property is misread as text:
// object hashcodes like "ThemeData#075ca", "MediaQueryData#1a2b3", "Instance of …".
const OBJECT_HASH = /^[A-Za-z][\w.]*#[0-9a-f]+/;

interface FoundLocators {
  keys: string[];
  texts: string[];
  semantics: string[];
  tooltips: string[];
}

function cleanText(raw: string): string | null {
  const t = raw.replace(/^"|"$/g, '').trim();
  if (!t || t.length > 120) return null;
  if (OBJECT_HASH.test(t)) return null;
  if (t.startsWith('Instance of')) return null;
  return t;
}

/**
 * Given a widget's VM `valueId`, find the locator candidates that best identify
 * THAT widget: its own ValueKey/text/semanticsLabel/tooltip, falling back to a
 * shallow descendant search (e.g. a Button wrapping a Text) — bounded by depth,
 * node count, and per-kind caps so an ancestor selection can't dump the whole
 * screen. Returns candidates ranked by confidence (key > semanticsLabel > text
 * > tooltip > type). A ValueKey short-circuits the walk (it's the ideal locator).
 *
 * Shared by the SelectModeController and the (legacy) Electron inspector.
 */
export async function extractDeepLocators(
  client: DartVMClient,
  valueId: string,
  selectedType: string,
  objectGroup: string = DEFAULT_OBJECT_GROUP,
): Promise<LocatorCandidate[]> {
  const found: FoundLocators = { keys: [], texts: [], semantics: [], tooltips: [] };

  // One bounded fetch, then a breadth-first walk so the widget's OWN properties
  // win over descendants'. Depth-limited payload keeps this cheap even for a
  // near-root selection.
  let root: any = null;
  try {
    const details = (await client.callServiceExtension(
      'ext.flutter.inspector.getDetailsSubtree',
      { arg: valueId, objectGroup, subtreeDepth: MAX_DEPTH },
    )) as any;
    root = details?.result || details;
  } catch {
    /* best-effort — fall through to type-only */
  }

  if (root) {
    const queue: Array<{ node: any; depth: number }> = [{ node: root, depth: 0 }];
    let visited = 0;
    while (queue.length > 0 && visited < MAX_NODES) {
      const { node, depth } = queue.shift()!;
      visited++;
      extractFromProperties(node, found);
      if (found.keys.length > 0) break; // a ValueKey is ideal — stop harvesting
      if (depth < MAX_DEPTH && Array.isArray(node.children)) {
        for (const child of node.children) {
          if (child?.valueId || child?.properties) queue.push({ node: child, depth: depth + 1 });
        }
      }
    }
  }

  const locators: LocatorCandidate[] = [];
  for (const key of found.keys) locators.push({ by: 'key', value: key, confidence: 1.0 });
  for (const s of found.semantics) locators.push({ by: 'semanticsLabel', value: s, confidence: 0.9 });
  for (const t of found.texts) locators.push({ by: 'text', value: t, confidence: 0.8 });
  for (const t of found.tooltips) locators.push({ by: 'tooltip', value: t, confidence: 0.75 });
  locators.push({ by: 'type', value: selectedType.split('<')[0], confidence: 0.4 });
  return locators;
}

/**
 * Extract locator-bearing properties from a SINGLE node (no recursion — the
 * caller controls traversal). Dedupes and applies per-kind caps + junk filters.
 */
export function extractFromProperties(node: any, found: FoundLocators): void {
  // On builds where detail nodes carry no `properties`, the ValueKey is encoded
  // in the node description instead, e.g. `InkWell-[<'left_panel_button_menu'>]`.
  if (typeof node?.description === 'string') {
    const m = node.description.match(/\[<'([^']+)'>\]/);
    if (m && !found.keys.includes(m[1])) found.keys.push(m[1]);
  }
  if (!node?.properties || !Array.isArray(node.properties)) return;
  for (const prop of node.properties) {
    const name = prop.name;
    const desc = prop.description;
    if (!desc || desc === 'null' || desc === '<null>') continue;
    if (name === 'key') {
      const m = desc.match(/(?:ValueKey|Key)\S*\(\s*'([^']+)'\s*\)/) || desc.match(/\[<'([^']+)'>\]/);
      if (m && !found.keys.includes(m[1])) found.keys.push(m[1]);
    } else if (['data', 'text', 'hintText', 'labelText'].includes(name)) {
      const t = cleanText(desc);
      if (t && !found.texts.includes(t) && found.texts.length < MAX_TEXTS) found.texts.push(t);
    } else if (['semanticLabel', 'semanticsLabel', 'label'].includes(name)) {
      const t = cleanText(desc);
      if (t && !found.semantics.includes(t) && found.semantics.length < MAX_SEMANTICS) found.semantics.push(t);
    } else if (name === 'tooltip') {
      const t = cleanText(desc);
      if (t && !found.tooltips.includes(t) && found.tooltips.length < MAX_TOOLTIPS) found.tooltips.push(t);
    }
  }
}

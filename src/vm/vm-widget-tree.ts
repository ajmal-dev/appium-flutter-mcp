import type { WidgetSummaryNode, RenderObjectNode, DetailedNode, DartVMClient } from './dart-vm-client.js';
import { INTERACTIVE_WIDGET_TYPES, LAYOUT_ONLY_TYPES } from '../tree/types.js';
import type { WidgetNode, InteractiveElement, WidgetTree } from '../tree/types.js';
import { vmLogger as logger } from './vm-logger.js';

// --- Extended types for VM-sourced data ---

export interface VMWidgetNode extends WidgetNode {
  valueId?: string;
  creationLocation?: { file: string; line: number; column?: number };
  semanticsLabel?: string;
  allLocators: LocatorCandidate[];
  sourceContext?: {
    filePath: string;
    line: number;
    snippet?: string;
    nearbyKeys: string[];
  };
}

export interface LocatorCandidate {
  by: string;
  value: string;
  confidence: number;
}

// --- Transform VM tree → WidgetNode ---

const INTERACTIVE_SET = new Set(INTERACTIVE_WIDGET_TYPES);

export function transformWidgetSummaryTree(root: WidgetSummaryNode): VMWidgetNode {
  return transformNode(root);
}

function transformNode(node: WidgetSummaryNode): VMWidgetNode {
  if (!node) {
    return { type: 'Unknown', interactive: false, allLocators: [] };
  }
  const desc = node.description || node.widgetRuntimeType || 'Unknown';
  const widgetType = node.widgetRuntimeType || desc.split(/[<(]/)[0].trim();
  const interactive = INTERACTIVE_SET.has(widgetType);
  const keyValue = extractKey(node);
  const textValue = node.textPreview || extractTextFromProperties(node) || '';

  const children: VMWidgetNode[] = [];
  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      if (child) children.push(transformNode(child));
    }
  }

  const locators = buildLocators(widgetType, keyValue, textValue, node);
  const bestLocator = locators.length > 0 ? { by: locators[0].by, value: locators[0].value } : undefined;

  return {
    type: widgetType,
    key: keyValue || undefined,
    text: textValue || undefined,
    interactive,
    displayed: true,
    enabled: true,
    locator: bestLocator,
    children: children.length > 0 ? children : undefined,
    valueId: node.valueId,
    creationLocation: node.creationLocation,
    allLocators: locators,
  };
}

// --- Render Object Position Extraction ---

interface PositionMap {
  [valueId: string]: { x: number; y: number; width: number; height: number };
}

export function extractRenderPositions(renderRoot: RenderObjectNode): PositionMap {
  const positions: PositionMap = {};
  walkRenderTree(renderRoot, positions, 0, 0);
  return positions;
}

function walkRenderTree(
  node: RenderObjectNode,
  positions: PositionMap,
  parentDx: number,
  parentDy: number,
): void {
  let dx = parentDx;
  let dy = parentDy;
  let width = 0;
  let height = 0;

  if (node.properties) {
    for (const prop of node.properties) {
      if (prop.name === 'size' && typeof prop.description === 'string') {
        const sizeMatch = prop.description.match(/Size\(([0-9.]+),\s*([0-9.]+)\)/);
        if (sizeMatch) {
          width = parseFloat(sizeMatch[1]);
          height = parseFloat(sizeMatch[2]);
        }
      }
      if (prop.name === 'offset' && typeof prop.description === 'string') {
        const offsetMatch = prop.description.match(/Offset\(([0-9.]+),\s*([0-9.]+)\)/);
        if (offsetMatch) {
          dx = parentDx + parseFloat(offsetMatch[1]);
          dy = parentDy + parseFloat(offsetMatch[2]);
        }
      }
      if (prop.name === 'paintOffset' && typeof prop.description === 'string') {
        const offsetMatch = prop.description.match(/Offset\(([0-9.]+),\s*([0-9.]+)\)/);
        if (offsetMatch) {
          dx = parentDx + parseFloat(offsetMatch[1]);
          dy = parentDy + parseFloat(offsetMatch[2]);
        }
      }
    }
  }

  if (width > 0 && height > 0) {
    positions[node.valueId] = { x: dx, y: dy, width, height };
  }

  if (node.children) {
    for (const child of node.children) {
      walkRenderTree(child, positions, dx, dy);
    }
  }
}

// --- Merge Widget Tree with Render Positions ---

export function mergePositions(tree: VMWidgetNode, positions: PositionMap): void {
  if (tree.valueId && positions[tree.valueId]) {
    tree.position = positions[tree.valueId];
  }
  if (tree.children) {
    for (const child of tree.children as VMWidgetNode[]) {
      mergePositions(child, positions);
    }
  }
}

export async function enrichPositionsFromDetails(
  tree: VMWidgetNode,
  client: DartVMClient,
): Promise<void> {
  const interactiveNodes = collectInteractiveNodes(tree);

  const batchSize = 5;
  for (let i = 0; i < interactiveNodes.length; i += batchSize) {
    const batch = interactiveNodes.slice(i, i + batchSize);
    await Promise.allSettled(
      batch.map(async (node) => {
        if (!node.valueId || node.position) return;
        try {
          const details = await client.getDetailsSubtree(node.valueId, 1);
          const pos = extractPositionFromDetails(details);
          if (pos) node.position = pos;

          const label = extractSemanticsLabelFromDetails(details);
          if (label) node.semanticsLabel = label;
        } catch { /* skip */ }
      }),
    );
  }
}

function extractPositionFromDetails(details: DetailedNode): { x: number; y: number; width: number; height: number } | null {
  if (!details.properties) return null;

  for (const prop of details.properties) {
    if (prop.name === 'renderObject' && typeof prop.description === 'string') {
      const sizeMatch = prop.description.match(/size:\s*Size\(([0-9.]+),\s*([0-9.]+)\)/);
      const posMatch = prop.description.match(/offset:\s*Offset\(([0-9.]+),\s*([0-9.]+)\)/);
      if (sizeMatch && posMatch) {
        return {
          x: parseFloat(posMatch[1]),
          y: parseFloat(posMatch[2]),
          width: parseFloat(sizeMatch[1]),
          height: parseFloat(sizeMatch[2]),
        };
      }
    }
  }
  return null;
}

function extractSemanticsLabelFromDetails(details: DetailedNode): string | null {
  if (!details.properties) return null;
  for (const prop of details.properties) {
    if ((prop.name === 'semanticLabel' || prop.name === 'label') && prop.description) {
      return prop.description || prop.value || null;
    }
  }
  return null;
}

// --- Condense Tree (remove layout wrappers) ---

export function condenseTree(node: VMWidgetNode): VMWidgetNode | null {
  const condensedChildren: VMWidgetNode[] = [];
  if (node.children) {
    for (const child of node.children as VMWidgetNode[]) {
      const condensed = condenseTree(child);
      if (condensed) condensedChildren.push(condensed);
    }
  }

  if (LAYOUT_ONLY_TYPES.has(node.type) && condensedChildren.length === 1 && !node.interactive) {
    return condensedChildren[0];
  }

  if (LAYOUT_ONLY_TYPES.has(node.type) && condensedChildren.length === 0 && !node.interactive) {
    return null;
  }

  return {
    ...node,
    children: condensedChildren.length > 0 ? condensedChildren : undefined,
  };
}

// --- Collect Interactive Elements ---

export function collectInteractiveElements(tree: VMWidgetNode): InteractiveElement[] {
  const elements: InteractiveElement[] = [];
  collectInteractive(tree, elements, 0);
  return elements;
}

function collectInteractive(node: VMWidgetNode, elements: InteractiveElement[], nextIndex: number): number {
  if (node.interactive && node.allLocators.length > 0) {
    const best = node.allLocators[0];
    elements.push({
      index: nextIndex++,
      type: node.type,
      key: node.key,
      text: node.text,
      enabled: node.enabled,
      displayed: node.displayed,
      position: node.position,
      locator: { by: best.by, value: best.value },
      context: 'flutter',
    });
  }
  if (node.children) {
    for (const child of node.children as VMWidgetNode[]) {
      nextIndex = collectInteractive(child, elements, nextIndex);
    }
  }
  return nextIndex;
}

function collectInteractiveNodes(node: VMWidgetNode): VMWidgetNode[] {
  const nodes: VMWidgetNode[] = [];
  if (node.interactive) nodes.push(node);
  if (node.children) {
    for (const child of node.children as VMWidgetNode[]) {
      nodes.push(...collectInteractiveNodes(child));
    }
  }
  return nodes;
}

// --- Locator Building ---

function buildLocators(
  type: string,
  key: string | undefined,
  text: string | undefined,
  node: WidgetSummaryNode,
): LocatorCandidate[] {
  const locators: LocatorCandidate[] = [];

  if (key) {
    locators.push({ by: 'key', value: key, confidence: 1.0 });
  }

  const semantics = extractSemanticsFromProperties(node);
  if (semantics) {
    locators.push({ by: 'semanticsLabel', value: semantics, confidence: 0.9 });
  }

  if (text) {
    locators.push({ by: 'text', value: text, confidence: 0.8 });
  }

  const tooltip = extractTooltipFromProperties(node);
  if (tooltip) {
    locators.push({ by: 'tooltip', value: tooltip, confidence: 0.75 });
  }

  if (INTERACTIVE_SET.has(type)) {
    locators.push({ by: 'type', value: type, confidence: 0.4 });
  }

  return locators;
}

// --- Key Extraction ---

function extractKey(node: WidgetSummaryNode): string | undefined {
  if (!node.properties) return undefined;
  for (const prop of node.properties) {
    if (prop.name === 'key' && prop.description) {
      const valueKeyMatch = prop.description.match(/(?:ValueKey|Key)\S*\(\s*'([^']+)'\s*\)/);
      if (valueKeyMatch) return valueKeyMatch[1];

      const bracketMatch = prop.description.match(/\[<'([^']+)'>\]/);
      if (bracketMatch) return bracketMatch[1];

      if (prop.description !== 'null' && prop.description !== '<null>') {
        return prop.description.replace(/^\[<|'|>\]$/g, '').trim();
      }
    }
  }
  return undefined;
}

function extractTextFromProperties(node: WidgetSummaryNode): string | undefined {
  if (!node.properties) return undefined;
  for (const prop of node.properties) {
    if ((prop.name === 'data' || prop.name === 'text' || prop.name === 'label') && prop.description) {
      const val = prop.description.replace(/^"|"$/g, '');
      if (val && val !== 'null') return val;
    }
  }
  return undefined;
}

function extractSemanticsFromProperties(node: WidgetSummaryNode): string | undefined {
  if (!node.properties) return undefined;
  for (const prop of node.properties) {
    if ((prop.name === 'semanticLabel' || prop.name === 'label' || prop.name === 'semanticsLabel') && prop.description) {
      const val = prop.description.replace(/^"|"$/g, '');
      if (val && val !== 'null') return val;
    }
  }
  return undefined;
}

function extractTooltipFromProperties(node: WidgetSummaryNode): string | undefined {
  if (!node.properties) return undefined;
  for (const prop of node.properties) {
    if (prop.name === 'tooltip' && prop.description) {
      const val = prop.description.replace(/^"|"$/g, '');
      if (val && val !== 'null') return val;
    }
  }
  return undefined;
}

// --- Build Full WidgetTree ---

export async function buildVMWidgetTree(client: DartVMClient, platform: string): Promise<WidgetTree> {
  const startMs = Date.now();

  const [widgetRoot, renderRoot] = await Promise.all([
    client.getRootWidgetSummaryTree(),
    client.getRootRenderObject().catch(() => null),
  ]);

  let tree = transformWidgetSummaryTree(widgetRoot);

  if (renderRoot) {
    const positions = extractRenderPositions(renderRoot);
    mergePositions(tree, positions);
  }

  await enrichPositionsFromDetails(tree, client);

  const condensed = condenseTree(tree);
  if (condensed) tree = condensed;

  const interactiveElements = collectInteractiveElements(tree);

  const elapsedMs = Date.now() - startMs;
  logger.info('VM widget tree built', {
    elementCount: countNodes(tree),
    interactiveCount: interactiveElements.length,
    elapsedMs,
  });

  return {
    timestamp: new Date().toISOString(),
    context: 'flutter',
    platform,
    source: 'vm' as WidgetTree['source'],
    tree,
    interactiveElements,
    elementCount: countNodes(tree),
    interactiveCount: interactiveElements.length,
  };
}

function countNodes(node: VMWidgetNode): number {
  let count = 1;
  if (node.children) {
    for (const child of node.children as VMWidgetNode[]) {
      count += countNodes(child);
    }
  }
  return count;
}

// --- Enrich node with source context (lazy, on-demand) ---

export async function enrichNodeSourceContext(
  node: VMWidgetNode,
  flutterAppPath?: string,
  flutterComponentsPath?: string,
): Promise<void> {
  if (!node.creationLocation || (!flutterAppPath && !flutterComponentsPath)) return;

  try {
    const { resolveCreationLocation, readWidgetSource } = await import('../source/source-resolver.js');
    const { getDartSourceIndex, findNearbyValueKeys } = await import('../source/dart-source-scanner.js');

    const resolved = resolveCreationLocation(
      node.creationLocation.file,
      flutterAppPath,
      flutterComponentsPath,
    );
    if (!resolved) return;

    const snippet = readWidgetSource(resolved, node.creationLocation.line, 10);
    const index = await getDartSourceIndex(flutterAppPath, flutterComponentsPath);
    const nearbyKeys = index
      ? findNearbyValueKeys(index, resolved, node.creationLocation.line)
      : [];

    node.sourceContext = {
      filePath: resolved,
      line: node.creationLocation.line,
      snippet: snippet || undefined,
      nearbyKeys,
    };
  } catch (e) {
    logger.debug('Failed to enrich source context', { error: String(e) });
  }
}

// --- Find node at position ---

export function findNodeAtPosition(
  tree: VMWidgetNode,
  x: number,
  y: number,
): VMWidgetNode | null {
  let best: VMWidgetNode | null = null;
  let bestArea = Infinity;

  function walk(node: VMWidgetNode) {
    if (node.position) {
      const { x: nx, y: ny, width, height } = node.position;
      if (x >= nx && x <= nx + width && y >= ny && y <= ny + height) {
        const area = width * height;
        if (area < bestArea) {
          best = node;
          bestArea = area;
        }
      }
    }
    if (node.children) {
      for (const child of node.children as VMWidgetNode[]) {
        walk(child);
      }
    }
  }

  walk(tree);
  return best;
}

import { type WidgetNode, LAYOUT_ONLY_TYPES } from './types.js';
import { logger } from '../util/logger.js';

/**
 * Parse the render tree returned by `flutter: renderTree`.
 *
 * The response can be:
 * 1. Structured JSON with { type, children, text, key, ... } — from newer driver versions
 * 2. A text diagnostic dump — from older driver versions
 *
 * This parser handles both formats.
 */
export function parseRenderTree(raw: unknown): WidgetNode | WidgetNode[] | null {
  if (!raw) return null;

  // If it's already structured JSON (newer driver versions)
  if (typeof raw === 'object') {
    return parseStructuredTree(raw as Record<string, unknown>);
  }

  // If it's a text dump (older driver versions)
  if (typeof raw === 'string') {
    return parseTextDump(raw);
  }

  logger.warn('Unknown render tree format', { type: typeof raw });
  return null;
}

/** Parse structured JSON tree from flutter:renderTree */
function parseStructuredTree(node: Record<string, unknown>): WidgetNode {
  const type = String(node.type || node.widgetType || 'Unknown');
  const isInteractive = !LAYOUT_ONLY_TYPES.has(type);

  const result: WidgetNode = {
    type,
    interactive: isInteractive,
  };

  if (node.key) result.key = String(node.key);
  if (node.text) result.text = String(node.text);
  if (node.enabled !== undefined) result.enabled = Boolean(node.enabled);
  if (node.displayed !== undefined) result.displayed = Boolean(node.displayed);

  if (node.rect && typeof node.rect === 'object') {
    const r = node.rect as Record<string, number>;
    result.position = { x: r.x || 0, y: r.y || 0, width: r.width || 0, height: r.height || 0 };
  }

  // Build locator
  if (result.key) {
    result.locator = { by: 'key', value: result.key };
  } else if (result.text) {
    result.locator = { by: 'text', value: result.text };
  } else if (isInteractive) {
    result.locator = { by: 'type', value: type };
  }

  // Parse children
  const children = node.children as unknown[];
  if (Array.isArray(children) && children.length > 0) {
    result.children = children
      .map(child => parseStructuredTree(child as Record<string, unknown>))
      .filter(child => child !== null);
  }

  return result;
}

/**
 * Condense the tree by removing layout-only wrapper nodes.
 * Layout nodes are replaced by their children in the parent.
 */
export function condenseTree(node: WidgetNode): WidgetNode | null {
  // Process children first (bottom-up)
  if (node.children) {
    const condensed: WidgetNode[] = [];
    for (const child of node.children) {
      const result = condenseTree(child);
      if (result) {
        // If child is layout-only, lift its children up
        if (LAYOUT_ONLY_TYPES.has(result.type) && result.children) {
          condensed.push(...result.children);
        } else if (!LAYOUT_ONLY_TYPES.has(result.type)) {
          condensed.push(result);
        }
        // Layout-only with no children gets dropped
      }
    }
    node.children = condensed.length > 0 ? condensed : undefined;
  }

  return node;
}

/** Parse text-based diagnostic dump (fallback for older drivers) */
function parseTextDump(text: string): WidgetNode[] | null {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length === 0) return null;

  const nodes: WidgetNode[] = [];
  const nodePattern = /^(\s*)(\w+)#([a-f0-9]+)/;

  for (const line of lines) {
    const match = line.match(nodePattern);
    if (match) {
      const type = match[2];
      if (!LAYOUT_ONLY_TYPES.has(type.replace('Render', ''))) {
        nodes.push({
          type: type.replace('Render', ''),
          interactive: false,
          properties: { raw: line.trim() },
        });
      }
    }
  }

  return nodes.length > 0 ? nodes : null;
}

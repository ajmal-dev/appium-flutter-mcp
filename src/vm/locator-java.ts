import type { LocatorCandidate } from './vm-widget-tree.js';
import { BLOCKED_TYPE_LOCATORS } from '../agent/locator-playbook.js';

function escapeJava(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Map a locator candidate to a ready-to-paste zmauiautomation AppActions Java
 * line. Returns null for strategies that have no direct AppActions method
 * (e.g. tooltip), which are kept as candidates but omitted from javaLines.
 */
export function formatLocatorJava(by: string, value: string): string | null {
  const v = escapeJava(value);
  switch (by) {
    case 'key':
      return `actions.byValueKey("${v}")`;
    case 'semanticsLabel':
      return `actions.bySemanticsLabel("${v}")`;
    case 'text':
      return `actions.byText("${v}")`;
    case 'type':
      return `actions.byType("${v}")`;
    default:
      return null;
  }
}

export interface JavaLocator extends LocatorCandidate {
  java?: string;
  /** True when this strategy is known not to resolve on Appium-Flutter (e.g. byType("Text")). */
  unsupported?: boolean;
  /** Why the candidate is flagged unsupported. */
  unsupportedReason?: string;
  /** Working substitute that uses the widget's actual text/semanticsLabel. */
  translation?: { by: 'key' | 'text' | 'semanticsLabel' | 'type'; value: string; java: string };
}

/** Attach a `.java` line to each candidate (null-mapped strategies get none). */
export function attachJava(locators: LocatorCandidate[]): JavaLocator[] {
  return locators.map((l) => {
    const java = formatLocatorJava(l.by, l.value);
    const unsupported = l.by === 'type' && BLOCKED_TYPE_LOCATORS.has(l.value);
    const base: JavaLocator = java ? { ...l, java } : { ...l };
    if (unsupported) {
      base.unsupported = true;
      base.unsupportedReason = `FlutterBy.type("${l.value}") does not resolve on Appium-Flutter — use byText / bySemanticsLabel instead.`;
    }
    return base;
  });
}

/** The ranked, deduped list of Java lines (highest confidence first). */
export function toJavaLines(locators: LocatorCandidate[]): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const l of [...locators].sort((a, b) => b.confidence - a.confidence)) {
    const java = formatLocatorJava(l.by, l.value);
    if (java && !seen.has(java)) {
      seen.add(java);
      lines.push(java);
    }
  }
  return lines;
}

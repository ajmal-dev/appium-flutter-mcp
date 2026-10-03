/**
 * Convert a parsed XPath-lite expression into ready-to-paste Java for
 * `zmauiautomation`'s `AppActions` / `org.devicefarm.FlutterBy`.
 *
 * The Flutter driver API has no XPath endpoint, so the output is the same
 * imperative chain the inspector already emits for compound locators —
 * descendant chains use `parent.findElement(FlutterBy.…)`, ancestors are
 * inverted via a `findElementsByType(...).stream().filter(...)` snippet,
 * substring text matches use `.contains(...)`, and indexed steps become
 * `.findElements(...).get(n)`.
 */

import type { PathExpr, Step, Predicate, Attr } from './path-evaluator.js';

function escapeJava(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function flutterByFor(attr: Attr, value: string): string {
  switch (attr) {
    case 'key': return `FlutterBy.valueKey("${escapeJava(value)}")`;
    case 'text': return `FlutterBy.text("${escapeJava(value)}")`;
    case 'semanticsLabel': return `FlutterBy.semanticsLabel("${escapeJava(value)}")`;
    case 'type': return `FlutterBy.type("${escapeJava(value)}")`;
  }
}

function appActionsFor(attr: Attr, value: string): string {
  switch (attr) {
    case 'key': return `actions.byValueKey("${escapeJava(value)}")`;
    case 'text': return `actions.byText("${escapeJava(value)}")`;
    case 'semanticsLabel': return `actions.bySemanticsLabel("${escapeJava(value)}")`;
    case 'type': return `actions.byType("${escapeJava(value)}")`;
  }
}

/** Best single (by,value) for a step — prefer key > semanticsLabel > text > type. */
function bestPredicate(step: Step): Predicate | null {
  // Exact predicates come first. Substring (*=) is handled separately.
  const exact = step.predicates.filter(p => p.op === '=');
  for (const attr of ['key', 'semanticsLabel', 'text', 'type'] as Attr[]) {
    const p = exact.find(x => x.attr === attr);
    if (p) return p;
  }
  return null;
}

function hasSubstringPredicate(step: Step): Predicate | null {
  return step.predicates.find(p => p.op === '*=') ?? null;
}

function stepHumanLabel(step: Step): string {
  const parts: string[] = [step.type];
  for (const p of step.predicates) parts.push(`[@${p.attr}${p.op}"${p.value}"]`);
  if (step.index !== undefined) parts.push(`[${step.index}]`);
  return `${step.axis === 'descendant' ? '' : `${step.axis}::`}${parts.join('')}`;
}

export interface JavaEmission {
  java: string;
  notes: string[];
}

export function pathToJava(expr: PathExpr): JavaEmission {
  if (expr.steps.length === 0) return { java: '// empty path', notes: [] };

  // Simple case: single step → one-liner / small block.
  if (expr.steps.length === 1) {
    const s = expr.steps[0];
    const best = bestPredicate(s);
    const sub = hasSubstringPredicate(s);
    // Substring text predicate (with or without index) → stream filter.
    if (sub && s.type !== '*') {
      const lines = [
        `// FlutterBy has no contains() — filter by getText().`,
        `List<WebElement> hits = actions.findElementsByType("${escapeJava(s.type)}").stream()`,
        `    .filter(e -> e.getText() != null && e.getText().contains("${escapeJava(sub.value)}"))`,
        `    .collect(java.util.stream.Collectors.toList());`,
      ];
      if (s.index !== undefined) {
        lines.push(`WebElement target = hits.get(${s.index});`);
      } else {
        lines.push(`WebElement target = hits.get(0);`);
      }
      return { java: lines.join('\n'), notes: [] };
    }
    // No substring — typed predicate + optional index.
    if (best && s.index !== undefined) {
      const flutterBy = best.attr === 'type' && best.value === s.type
        ? `FlutterBy.type("${escapeJava(s.type)}")`
        : flutterByFor(best.attr, best.value);
      return {
        java: `WebElement target = actions.findElements(${flutterBy}).get(${s.index});`,
        notes: [`Indexed match — order is summary-tree order; prefer a ValueKey if available.`],
      };
    }
    if (best && s.index === undefined) {
      // Pure type can be either byType or filtered. If type is concrete and no predicate, use byType.
      if (best.attr === 'type' || (s.type !== '*' && s.predicates.length === 0)) {
        return { java: `actions.byType("${escapeJava(s.type)}")`, notes: [] };
      }
      return { java: appActionsFor(best.attr, best.value), notes: [] };
    }
    if (s.type !== '*' && s.predicates.length === 0 && s.index !== undefined) {
      return {
        java: `WebElement target = actions.findElementsByType("${escapeJava(s.type)}").get(${s.index});`,
        notes: [`Indexed match — order is summary-tree order; prefer a ValueKey if available.`],
      };
    }
    if (s.type !== '*' && s.predicates.length === 0 && s.index === undefined) {
      return { java: `actions.byType("${escapeJava(s.type)}")`, notes: [] };
    }
  }

  // Multi-step path. Walk steps left → right, emitting:
  //   - descendant/child → `.findElement(FlutterBy.…)` on the running anchor.
  //   - ancestor       → inverted-ancestor stream pattern using the NEXT step's
  //                      identifying predicate.
  // The "anchor" variable holds the current WebElement reference name.
  const notes: string[] = [];
  const lines: string[] = [];
  let anchorVar = 'anchor';
  let lastAnchorWasRoot = true;

  // Helper to declare a new anchor variable assignment.
  const declareAnchor = (name: string, expression: string): string => {
    lines.push(`WebElement ${name} = ${expression};`);
    return name;
  };

  // First step is always rooted (no prior anchor). Emit a root-level expression.
  const first = expr.steps[0];
  const firstBest = bestPredicate(first);
  const firstSub = hasSubstringPredicate(first);

  if (firstSub && first.type !== '*') {
    // First step uses substring text — stream filter from byType.
    notes.push(`First step uses substring text — emits a stream filter.`);
    lines.push(
      `WebElement ${anchorVar} = actions.findElementsByType("${escapeJava(first.type)}").stream()`,
      `    .filter(e -> e.getText() != null && e.getText().contains("${escapeJava(firstSub.value)}"))`,
      `    .findFirst()`,
      `    .orElseThrow();`,
    );
    lastAnchorWasRoot = false;
  } else if (firstBest && first.index === undefined) {
    const expr0 = firstBest.attr === 'type'
      ? `actions.byType("${escapeJava(firstBest.value)}")`
      : appActionsFor(firstBest.attr, firstBest.value);
    declareAnchor(anchorVar, expr0);
    lastAnchorWasRoot = false;
  } else if (first.type !== '*' && first.predicates.length === 0 && first.index !== undefined) {
    declareAnchor(anchorVar, `actions.findElementsByType("${escapeJava(first.type)}").get(${first.index})`);
    notes.push(`First step is indexed — order is summary-tree order.`);
    lastAnchorWasRoot = false;
  } else if (first.type !== '*' && first.predicates.length === 0 && first.index === undefined) {
    declareAnchor(anchorVar, `actions.byType("${escapeJava(first.type)}")`);
    lastAnchorWasRoot = false;
  } else {
    notes.push(`Could not emit first step '${stepHumanLabel(first)}'.`);
  }

  // Subsequent steps.
  for (let i = 1; i < expr.steps.length; i++) {
    const s = expr.steps[i];
    const best = bestPredicate(s);
    const sub = hasSubstringPredicate(s);
    const nextAnchor = `n${i}`;

    if (s.axis === 'descendant' || s.axis === 'child') {
      // anchor.findElement(FlutterBy.…)
      if (sub && s.type !== '*') {
        notes.push(`Step '${stepHumanLabel(s)}' uses substring text — emits a stream filter inside the anchor.`);
        lines.push(
          `WebElement ${nextAnchor} = ${anchorVar}.findElements(FlutterBy.type("${escapeJava(s.type)}")).stream()`,
          `    .filter(e -> e.getText() != null && e.getText().contains("${escapeJava(sub.value)}"))`,
          `    .findFirst()`,
          `    .orElseThrow();`,
        );
      } else if (best && s.index === undefined) {
        lines.push(`WebElement ${nextAnchor} = ${anchorVar}.findElement(${flutterByFor(best.attr === 'type' ? 'type' : best.attr, best.attr === 'type' ? best.value : best.value)});`);
      } else if (s.type !== '*' && s.index !== undefined) {
        lines.push(`WebElement ${nextAnchor} = ${anchorVar}.findElements(FlutterBy.type("${escapeJava(s.type)}")).get(${s.index});`);
      } else if (s.type !== '*' && s.predicates.length === 0) {
        lines.push(`WebElement ${nextAnchor} = ${anchorVar}.findElement(FlutterBy.type("${escapeJava(s.type)}"));`);
      } else {
        notes.push(`Could not emit step '${stepHumanLabel(s)}'.`);
        continue;
      }
      anchorVar = nextAnchor;
    } else if (s.axis === 'ancestor') {
      // Inverted-ancestor stream: find the ancestor parent that *contains* the
      // previous anchor's identifying signal. We need the identifying predicate
      // from the PREVIOUS step (or text from this step's child). For now we
      // emit a comment + stream skeleton that uses the immediately-prior step's
      // best predicate as the identifier inside each ancestor candidate.
      const prev = expr.steps[i - 1];
      const prevBest = bestPredicate(prev);
      const prevSub = hasSubstringPredicate(prev);
      const ancestorType = s.type;
      if (ancestorType === '*') {
        notes.push(`Ancestor axis requires a concrete type at step '${stepHumanLabel(s)}'.`);
        continue;
      }
      let filterExpr: string | null = null;
      if (prevSub) {
        filterExpr = `!p.findElements(FlutterBy.type("${escapeJava(prev.type)}")).stream().filter(e -> e.getText() != null && e.getText().contains("${escapeJava(prevSub.value)}")).findFirst().isPresent() ? false : true`;
        // simpler:
        filterExpr = `p.findElements(FlutterBy.type("${escapeJava(prev.type)}")).stream().anyMatch(e -> e.getText() != null && e.getText().contains("${escapeJava(prevSub.value)}"))`;
      } else if (prevBest) {
        filterExpr = `!p.findElements(${flutterByFor(prevBest.attr, prevBest.value)}).isEmpty()`;
      }
      if (!filterExpr) {
        notes.push(`Could not derive ancestor filter from previous step '${stepHumanLabel(prev)}'.`);
        continue;
      }
      lines.push(
        `// Inverted-ancestor: pick the ${ancestorType} that contains the previous step's match.`,
        `WebElement ${nextAnchor} = actions.findElementsByType("${escapeJava(ancestorType)}").stream()`,
        `    .filter(p -> ${filterExpr})`,
        `    .findFirst()`,
        `    .orElseThrow();`,
      );
      // Strip the previous anchor line — it's logically replaced by this lookup.
      // (Keep it for clarity; the user can edit out.)
      anchorVar = nextAnchor;
    } else if (s.axis === 'self') {
      // No-op — keep anchor, but apply predicates as sanity check.
      notes.push(`'self::' step kept as a comment — no-op in Java.`);
      lines.push(`// self::${stepHumanLabel(s)} — anchor unchanged`);
    }

    // Trailing index on this step (when not consumed above).
    if (s.index !== undefined && lines.length && !lines[lines.length - 1].includes('.get(')) {
      // Replace the last `.findElement(` with `.findElements(...).get(idx)`.
      // For simplicity, append a follow-up line.
      lines.push(`// trailing index [${s.index}] — adjust the line above to use findElements(...).get(${s.index})`);
      notes.push(`Step '${stepHumanLabel(s)}' carries an index — applied as a follow-up note.`);
    }
  }

  // Final variable becomes `target` for readability if it differs.
  if (anchorVar !== 'target') {
    lines.push(`WebElement target = ${anchorVar};`);
  }
  return { java: lines.join('\n'), notes };
}

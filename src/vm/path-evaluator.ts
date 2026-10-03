/**
 * XPath-lite parser + evaluator for the inspector's Tree Explorer.
 *
 * Maps a subset of web-XPath syntax onto VMWidgetNode walks. The grammar is
 * intentionally narrow so every accepted path translates 1:1 to a FlutterBy
 * Java chain (see path-to-java.ts).
 *
 *   path      := step ('/' axis '::' step)*
 *   axis      := 'descendant' | 'ancestor' | 'child' | 'self'     default: descendant
 *   step      := type predicate* index?
 *   type      := IDENT | '*'
 *   predicate := '[@' attr op string ']'
 *   attr      := 'text' | 'key' | 'semanticsLabel' | 'type'
 *   op        := '=' | '*='
 *   index     := '[' INTEGER ']'
 *
 * Examples:
 *   RichText[@text="Select"]
 *   Text[@text="Face"][1]
 *   GuestDetailsFormsImages/descendant::MultipleButtonsRow/descendant::Icon
 *   RichText[@text*="butterfly"]/ancestor::GuestDetailsFormsImageListItem/descendant::Image
 */

import type { VMWidgetNode } from './vm-widget-tree.js';

export type Axis = 'descendant' | 'ancestor' | 'child' | 'self';
export type Attr = 'text' | 'key' | 'semanticsLabel' | 'type';
export type PredOp = '=' | '*=';

export interface Predicate {
  attr: Attr;
  op: PredOp;
  value: string;
}

export interface Step {
  axis: Axis;
  type: string;            // '*' = any
  predicates: Predicate[];
  index?: number;          // 0-based
}

export interface PathExpr {
  steps: Step[];
}

export class PathParseError extends Error {
  constructor(message: string, public readonly position: number) {
    super(`${message} at column ${position + 1}`);
    this.name = 'PathParseError';
  }
}

// ---------------------------------------------------------------------------
// Parser

export function parsePath(src: string): PathExpr {
  const p = new Parser(src);
  const expr = p.parsePath();
  p.expectEnd();
  return expr;
}

class Parser {
  private i = 0;
  constructor(private readonly s: string) {}

  parsePath(): PathExpr {
    this.skipWs();
    const steps: Step[] = [this.parseStep('descendant')];
    while (true) {
      this.skipWs();
      if (this.i >= this.s.length) break;
      if (this.s[this.i] !== '/') break;
      this.i++; // '/'
      let axis: Axis = 'descendant';
      // optional explicit axis: 'descendant::' / 'ancestor::' / 'child::' / 'self::'
      const ident = this.peekIdent();
      if (ident && this.s.startsWith(`${ident}::`, this.i)) {
        if (ident === 'descendant' || ident === 'ancestor' || ident === 'child' || ident === 'self') {
          this.i += ident.length + 2;
          axis = ident as Axis;
        } else {
          throw new PathParseError(`unknown axis '${ident}'`, this.i);
        }
      }
      steps.push(this.parseStep(axis));
    }
    return { steps };
  }

  private parseStep(axis: Axis): Step {
    this.skipWs();
    const type = this.parseType();
    const predicates: Predicate[] = [];
    let index: number | undefined;

    while (this.i < this.s.length && this.s[this.i] === '[') {
      this.i++; // '['
      this.skipWs();
      if (this.s[this.i] === '@') {
        predicates.push(this.parsePredicate());
      } else if (/\d/.test(this.s[this.i] ?? '')) {
        const n = this.parseInt();
        if (index !== undefined) throw new PathParseError('multiple indices in one step', this.i);
        index = n;
      } else {
        throw new PathParseError(`expected '@attr=...' or integer`, this.i);
      }
      this.skipWs();
      if (this.s[this.i] !== ']') throw new PathParseError(`expected ']'`, this.i);
      this.i++;
    }
    return { axis, type, predicates, index };
  }

  private parseType(): string {
    if (this.s[this.i] === '*') { this.i++; return '*'; }
    const ident = this.takeIdent();
    if (!ident) throw new PathParseError('expected widget type', this.i);
    return ident;
  }

  private parsePredicate(): Predicate {
    this.i++; // '@'
    const attrIdent = this.takeIdent();
    if (!attrIdent) throw new PathParseError('expected attribute name after @', this.i);
    if (attrIdent !== 'text' && attrIdent !== 'key' && attrIdent !== 'semanticsLabel' && attrIdent !== 'type') {
      throw new PathParseError(`unsupported attribute '${attrIdent}' — use text|key|semanticsLabel|type`, this.i);
    }
    this.skipWs();
    let op: PredOp;
    if (this.s.startsWith('*=', this.i)) { op = '*='; this.i += 2; }
    else if (this.s[this.i] === '=') { op = '='; this.i++; }
    else throw new PathParseError(`expected '=' or '*='`, this.i);
    this.skipWs();
    const value = this.parseString();
    return { attr: attrIdent as Attr, op, value };
  }

  private parseString(): string {
    const q = this.s[this.i];
    if (q !== '"' && q !== "'") throw new PathParseError(`expected quoted string`, this.i);
    this.i++;
    let out = '';
    while (this.i < this.s.length && this.s[this.i] !== q) {
      if (this.s[this.i] === '\\' && this.i + 1 < this.s.length) {
        out += this.s[this.i + 1];
        this.i += 2;
      } else {
        out += this.s[this.i++];
      }
    }
    if (this.s[this.i] !== q) throw new PathParseError(`unterminated string`, this.i);
    this.i++;
    return out;
  }

  private parseInt(): number {
    let start = this.i;
    while (this.i < this.s.length && /\d/.test(this.s[this.i])) this.i++;
    return parseInt(this.s.slice(start, this.i), 10);
  }

  private takeIdent(): string | null {
    const m = /^[A-Za-z_][A-Za-z0-9_<>]*/.exec(this.s.slice(this.i));
    if (!m) return null;
    this.i += m[0].length;
    return m[0];
  }

  private peekIdent(): string | null {
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.s.slice(this.i));
    return m ? m[0] : null;
  }

  private skipWs(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  expectEnd(): void {
    this.skipWs();
    if (this.i < this.s.length) {
      throw new PathParseError(`unexpected '${this.s.slice(this.i, this.i + 8)}…'`, this.i);
    }
  }
}

// ---------------------------------------------------------------------------
// Evaluator

const TEXT_BEARING_TYPES = /^(Text|RichText|EditableText|SelectableText|TextField|TextFormField|AutoSizeText)$/;

function stripGenerics(t: string): string {
  return (t || '').split(/[<(]/)[0].trim();
}

function nodeType(n: VMWidgetNode): string {
  return stripGenerics(n.type || '');
}

function attrValue(n: VMWidgetNode, attr: Attr): string | undefined {
  switch (attr) {
    case 'text': return n.text;
    case 'key': return n.key;
    case 'semanticsLabel': return (n as { semanticsLabel?: string }).semanticsLabel;
    case 'type': return nodeType(n);
  }
}

function matchesPredicate(n: VMWidgetNode, p: Predicate): boolean {
  const v = attrValue(n, p.attr);
  if (v == null) return false;
  if (p.op === '=') return v === p.value;
  return v.includes(p.value);
}

function matchesStep(n: VMWidgetNode, step: Step): boolean {
  // Type check
  if (step.type !== '*') {
    if (nodeType(n) !== step.type) return false;
  }
  // textPreview propagates up wrappers; for `@text` predicates, restrict to
  // actual text-bearing widget types so counts match Appium's find.text.
  for (const p of step.predicates) {
    if (p.attr === 'text' && !TEXT_BEARING_TYPES.test(nodeType(n))) return false;
    if (!matchesPredicate(n, p)) return false;
  }
  return true;
}

function buildParentMap(root: VMWidgetNode): Map<VMWidgetNode, VMWidgetNode> {
  const parent = new Map<VMWidgetNode, VMWidgetNode>();
  const walk = (n: VMWidgetNode): void => {
    for (const c of (n.children ?? []) as VMWidgetNode[]) {
      parent.set(c, n);
      walk(c);
    }
  };
  walk(root);
  return parent;
}

function* descendants(n: VMWidgetNode): Iterable<VMWidgetNode> {
  for (const c of (n.children ?? []) as VMWidgetNode[]) {
    yield c;
    yield* descendants(c);
  }
}

function* children(n: VMWidgetNode): Iterable<VMWidgetNode> {
  for (const c of (n.children ?? []) as VMWidgetNode[]) yield c;
}

function* ancestors(n: VMWidgetNode, parent: Map<VMWidgetNode, VMWidgetNode>): Iterable<VMWidgetNode> {
  let cur = parent.get(n);
  while (cur) { yield cur; cur = parent.get(cur); }
}

export function evaluatePath(root: VMWidgetNode, expr: PathExpr): VMWidgetNode[] {
  const parent = buildParentMap(root);
  // The first step searches the WHOLE tree (root included) via descendant axis.
  let current: VMWidgetNode[] = [root];

  for (let i = 0; i < expr.steps.length; i++) {
    const step = expr.steps[i];
    const expanded: VMWidgetNode[] = [];
    const seen = new Set<VMWidgetNode>();

    for (const cur of current) {
      let pool: Iterable<VMWidgetNode>;
      switch (step.axis) {
        case 'descendant': pool = descendants(cur); break;
        case 'child':      pool = children(cur); break;
        case 'ancestor':   pool = ancestors(cur, parent); break;
        case 'self':       pool = [cur]; break;
      }
      for (const n of pool) {
        if (matchesStep(n, step)) {
          if (!seen.has(n)) { seen.add(n); expanded.push(n); }
        }
      }
      // First step is an implicit `descendant-or-self` from root: include root itself.
      if (i === 0 && step.axis === 'descendant' && cur === root) {
        if (matchesStep(root, step) && !seen.has(root)) {
          seen.add(root); expanded.push(root);
        }
      }
    }

    // Apply step-level index
    if (step.index !== undefined) {
      const idx = step.index;
      current = idx >= 0 && idx < expanded.length ? [expanded[idx]] : [];
    } else {
      current = expanded;
    }
    if (current.length === 0) return [];
  }
  return current;
}

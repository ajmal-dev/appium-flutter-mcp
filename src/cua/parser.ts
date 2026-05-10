import { readFileSync } from 'fs';

export interface CuaTestCase {
  id: string;
  title: string;
  goal?: string;
  preconditions: string[];
  steps: string[];
  expected?: string;
  tags: string[];
}

export interface CuaTestFile {
  module?: string;
  app?: string;
  mode?: string;
  device?: string;
  defaultTimeout?: number;
  cases: CuaTestCase[];
}

export function parseCuaFile(path: string): CuaTestFile {
  const raw = readFileSync(path, 'utf8');
  return parseCuaContent(raw);
}

export function parseCuaContent(raw: string): CuaTestFile {
  const { frontmatter, body } = splitFrontmatter(raw);
  const meta = parseFrontmatter(frontmatter);

  const cases: CuaTestCase[] = [];
  const caseBlocks = body.split(/^## (?=TC-)/m).slice(1);

  for (const block of caseBlocks) {
    const c = parseCase(block);
    if (c) cases.push(c);
  }

  return {
    module: meta.module,
    app: meta.app,
    mode: meta.mode,
    device: meta.device,
    defaultTimeout: meta.timeout ? Number(meta.timeout) : undefined,
    cases,
  };
}

function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { frontmatter: '', body: raw };
  return { frontmatter: m[1], body: m[2] };
}

function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function parseCase(block: string): CuaTestCase | null {
  const headMatch = block.match(/^(TC-[A-Za-z0-9_-]+):\s*(.+?)\n/);
  if (!headMatch) return null;
  const id = headMatch[1];
  const title = headMatch[2].trim();

  const tags: string[] = [];
  const tagMatch = block.match(/^>\s*tags:\s*(.+)$/m);
  if (tagMatch) {
    for (const t of tagMatch[1].split(',')) tags.push(t.trim());
  }

  const goal = extractSection(block, 'Goal');
  const preconditionsRaw = extractSection(block, 'Preconditions');
  const stepsRaw = extractSection(block, 'Steps');
  const expected = extractSection(block, ['Expected Outcome', 'Expected']);

  const preconditions = preconditionsRaw ? extractBullets(preconditionsRaw) : [];
  const steps = stepsRaw ? extractSteps(stepsRaw) : [];

  return { id, title, goal, preconditions, steps, expected, tags };
}

function extractSection(block: string, names: string | string[]): string | undefined {
  const list = Array.isArray(names) ? names : [names];
  // End-of-input is matched as `(?![\s\S])` — JS regex has no \Z anchor, so an
  // earlier version of this code was unintentionally terminating capture at
  // any literal "Z".
  for (const name of list) {
    const re = new RegExp(`^###\\s+${escapeRe(name)}\\s*\\n([\\s\\S]*?)(?=^###\\s|^---\\s*$|(?![\\s\\S]))`, 'm');
    const m = block.match(re);
    if (m) return m[1].trim();
  }
  return undefined;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractBullets(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*[-*]\s+(.+)$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

/**
 * Pulls the natural-language description out of each numbered step.
 *
 * Accepts both formats:
 *   1. From the dashboard, search for guest "Ajmal Babu"   ← pure NL
 *   1. **tap** the search field                            ← legacy hint format
 *      - by: text
 *      - target: Search                                    ← these hint lines are dropped
 */
function extractSteps(text: string): string[] {
  const lines = text.split('\n');
  const steps: string[] = [];
  let current: string | null = null;

  for (const line of lines) {
    const start = line.match(/^\s*\d+\.\s+(.+)$/);
    if (start) {
      if (current !== null) steps.push(stripLegacyAction(current.trim()));
      current = start[1];
      continue;
    }
    if (current !== null) {
      // Drop legacy hint lines like "   - by: text", "   - target: ...", "   - verify: ..."
      if (/^\s*-\s+(by|target|index|text|verify|recovery|timeout)\s*:/i.test(line)) {
        continue;
      }
      // Continuation paragraph or bullet — keep
      const trimmed = line.trim();
      if (trimmed) current += ' ' + trimmed.replace(/^[-*]\s+/, '');
    }
  }
  if (current !== null) steps.push(stripLegacyAction(current.trim()));

  return steps.filter(Boolean);
}

/**
 * The legacy format starts steps with "**tap** the search field". For CUA
 * mode we strip the leading bolded action verb so the agent reads it as
 * "tap the search field" rather than treating "tap" as a directive.
 * (The agent decides which low-level action to use anyway.)
 */
function stripLegacyAction(s: string): string {
  return s.replace(/^\*\*[a-z_]+\*\*\s+/i, '').replace(/\*\*([^*]+)\*\*/g, '$1');
}

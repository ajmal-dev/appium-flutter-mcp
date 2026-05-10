import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { createHash } from 'crypto';
import { logger } from '../util/logger.js';

/**
 * Cross-run hint store for CUA tests. Each test markdown <path>.cua.md gets a
 * sibling <path>.cua.md.hints.json that records, per (caseId, stepNumber):
 *   - successfulStrategy: the most recent action that worked
 *   - failedStrategies:   bounded list of actions known to fail (with reasons)
 *
 * Lifecycle:
 *   loadHints() at cua_run_test → mutate in memory through the run →
 *   saveHints() at cua_finish_test (atomic .tmp + rename).
 *
 * The agent reads the rendered hints in the case prompt and uses them to skip
 * known traps. There is no ML / no LLM in the MCP — these are plain records.
 */

export type HintAttemptKind = 'tap' | 'type_text' | 'smart_tap' | 'coordinates';

export interface HintAttempt {
  kind: HintAttemptKind;
  by?: string;
  target?: string;
  index?: number;
  x?: number;
  y?: number;
  description?: string;
  text?: string;
  deviceViewport?: string;
}

export interface SuccessfulStrategy extends HintAttempt {
  rationale?: string;
  lastSuccessAt: string;
  successCount: number;
}

export interface FailedStrategy extends HintAttempt {
  outcome: string;
  lastFailureAt: string;
  failCount: number;
}

export interface StepHints {
  stepText: string;
  stepTextHash: string;
  successfulStrategy?: SuccessfulStrategy;
  failedStrategies: FailedStrategy[];
}

export interface CaseHints {
  steps: Record<string, StepHints>; // key = stepNumber as string
}

export interface HintsFile {
  schemaVersion: 1;
  testFile: string;
  lastUpdated: string;
  cases: Record<string, CaseHints>; // key = caseId
}

const SCHEMA_VERSION = 1;
const MAX_FAILED_PER_STEP = 5;

export function hintsPathFor(testFilePath: string): string {
  return `${testFilePath}.hints.json`;
}

export function emptyHints(testFilePath: string): HintsFile {
  return {
    schemaVersion: SCHEMA_VERSION,
    testFile: testFilePath,
    lastUpdated: new Date().toISOString(),
    cases: {},
  };
}

export function loadHints(testFilePath: string): HintsFile {
  const path = hintsPathFor(testFilePath);
  if (!existsSync(path)) return emptyHints(testFilePath);
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.schemaVersion !== SCHEMA_VERSION) {
      logger.warn('CUA hints: schema version mismatch — ignoring', { path, found: parsed?.schemaVersion });
      return emptyHints(testFilePath);
    }
    if (!parsed.cases || typeof parsed.cases !== 'object') parsed.cases = {};
    return parsed as HintsFile;
  } catch (e) {
    logger.warn('CUA hints: failed to parse, ignoring', { path, error: String(e) });
    return emptyHints(testFilePath);
  }
}

export function saveHints(testFilePath: string, hints: HintsFile): void {
  const path = hintsPathFor(testFilePath);
  const tmp = `${path}.tmp`;
  hints.lastUpdated = new Date().toISOString();
  writeFileSync(tmp, JSON.stringify(hints, null, 2));
  renameSync(tmp, path);
}

export function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

function ensureStep(hints: HintsFile, caseId: string, stepNumber: number, stepText: string): StepHints {
  const c = hints.cases[caseId] || (hints.cases[caseId] = { steps: {} });
  const key = String(stepNumber);
  let step = c.steps[key];
  const hash = sha1(stepText);
  if (!step) {
    step = c.steps[key] = { stepText, stepTextHash: hash, failedStrategies: [] };
  }
  return step;
}

function sameAttempt(a: HintAttempt, b: HintAttempt): boolean {
  return a.kind === b.kind
    && (a.by ?? '') === (b.by ?? '')
    && (a.target ?? '') === (b.target ?? '')
    && (a.index ?? 0) === (b.index ?? 0)
    && (a.description ?? '') === (b.description ?? '')
    && (a.x ?? -1) === (b.x ?? -1)
    && (a.y ?? -1) === (b.y ?? -1);
}

export function recordSuccess(
  hints: HintsFile,
  caseId: string,
  stepNumber: number,
  stepText: string,
  attempt: HintAttempt,
  rationale?: string,
): void {
  const step = ensureStep(hints, caseId, stepNumber, stepText);
  // Refresh stepText/hash on every record so renames are caught.
  step.stepText = stepText;
  step.stepTextHash = sha1(stepText);

  const existing = step.successfulStrategy;
  const successCount = existing && sameAttempt(existing, attempt) ? existing.successCount + 1 : 1;
  step.successfulStrategy = {
    ...attempt,
    rationale: rationale ?? existing?.rationale,
    lastSuccessAt: new Date().toISOString(),
    successCount,
  };

  // If the now-successful attempt was previously recorded as a failure, drop it.
  step.failedStrategies = step.failedStrategies.filter(f => !sameAttempt(f, attempt));
}

export function recordFailure(
  hints: HintsFile,
  caseId: string,
  stepNumber: number,
  stepText: string,
  attempt: HintAttempt,
  outcome: string,
): void {
  const step = ensureStep(hints, caseId, stepNumber, stepText);
  step.stepText = stepText;
  step.stepTextHash = sha1(stepText);

  const dup = step.failedStrategies.find(f => sameAttempt(f, attempt));
  if (dup) {
    dup.failCount += 1;
    dup.lastFailureAt = new Date().toISOString();
    dup.outcome = outcome;
    return;
  }
  step.failedStrategies.push({
    ...attempt,
    outcome,
    lastFailureAt: new Date().toISOString(),
    failCount: 1,
  });
  // Bound the list — drop the oldest by lastFailureAt.
  if (step.failedStrategies.length > MAX_FAILED_PER_STEP) {
    step.failedStrategies.sort((a, b) => a.lastFailureAt.localeCompare(b.lastFailureAt));
    step.failedStrategies.splice(0, step.failedStrategies.length - MAX_FAILED_PER_STEP);
  }
}

function describeAttempt(a: HintAttempt): string {
  switch (a.kind) {
    case 'coordinates':
      return `coordinate tap at (${a.x}, ${a.y})${a.deviceViewport ? ` [viewport ${a.deviceViewport}]` : ''}`;
    case 'tap':
      return `tap by=${a.by} target=${JSON.stringify(a.target ?? '')}${a.index ? ` index=${a.index}` : ''}`;
    case 'type_text':
      return `type_text by=${a.by} target=${JSON.stringify(a.target ?? '')} text=${JSON.stringify(a.text ?? '')}`;
    case 'smart_tap':
      return `smart_tap(${JSON.stringify(a.description ?? '')})`;
  }
}

/**
 * Render the hints block injected into the case prompt. Returns null when
 * there's nothing useful to surface (no successes, no failures across all
 * steps in the case).
 */
export function renderHintsForCase(
  hints: HintsFile,
  caseId: string,
  currentSteps: { stepNumber: number; text: string }[],
): string | null {
  const c = hints.cases[caseId];
  if (!c || !c.steps) return null;
  const blocks: string[] = [];

  for (const s of currentSteps) {
    const stored = c.steps[String(s.stepNumber)];
    if (!stored) continue;
    if (!stored.successfulStrategy && stored.failedStrategies.length === 0) continue;

    const stepText = s.text;
    const advisory = stored.stepTextHash !== sha1(stepText);
    const block: string[] = [];
    block.push(`Step ${s.stepNumber} — "${stepText}":`);
    if (advisory) block.push(`  ADVISORY (step text changed since this hint was learned — verify before trusting).`);

    if (stored.successfulStrategy) {
      const ss = stored.successfulStrategy;
      const why = ss.rationale ? `\n    Why: ${ss.rationale}` : '';
      block.push(`  PROVEN (${ss.successCount} success${ss.successCount === 1 ? '' : 'es'}, last ${ss.lastSuccessAt.slice(0, 10)}): ${describeAttempt(ss)}.${why}`);
    }
    for (const f of stored.failedStrategies) {
      block.push(`  AVOID (${f.failCount}× fail): ${describeAttempt(f)}  → ${f.outcome}`);
    }
    blocks.push(block.join('\n'));
  }

  if (blocks.length === 0) return null;
  return `## Hints from previous runs\n${blocks.join('\n\n')}`;
}

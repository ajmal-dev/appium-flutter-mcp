import type { CuaTestCase, CuaTestFile } from './parser.js';
import type { HintAttempt, HintsFile } from './hints.js';
import { emptyHints, loadHints } from './hints.js';

/**
 * Server-side state for an active CUA run. The user's Claude drives the loop
 * (calls tap/type_text/get_screen/etc.) and reports each step's outcome through
 * cua_report_step; this module just remembers what's happening so the final
 * report can be assembled.
 */

export interface CuaStepRecord {
  stepNumber: number;
  text: string;
  status: 'pass' | 'fail' | 'pending';
  observation?: string;
  screenshotFile?: string;
  /** True if the screenshot at report time differed from the previous step's screenshot. */
  screenChanged?: boolean;
  /** Short delta — e.g. "+2 TextField, −1 IconButton" — when screen changed. */
  screenDelta?: string;
}

export interface CuaCaseRecord {
  id: string;
  title: string;
  goal?: string;
  preconditions: string[];
  expected?: string;
  steps: CuaStepRecord[];
  startedAt: string;
  finishedAt?: string;
  verdict?: 'pass' | 'fail';
  summary?: string;
}

export interface CuaRunState {
  runId: string;
  startedAt: string;
  testFile: CuaTestFile;
  testFilePath: string;
  runDir: string;
  shotsDir: string;
  cases: CuaCaseRecord[];
  currentCaseIndex: number;
  /** Number of screenshots saved this run; used to name files. */
  screenshotCount: number;
  /** SHA-1 of the most recent screenshot, used for screen-change diffing. */
  lastScreenshotHash?: string;
  /** Compact element summary captured with the most recent screenshot. */
  lastElementSummary?: string;
  /** Hint store loaded from <testFilePath>.hints.json — mutated through the run, flushed at finish. */
  hints: HintsFile;
  /** Most recent attempt the agent made (set by act tools); promoted to a hint on the next pass-report. */
  lastAttempt?: HintAttempt;
  /** Compact element scan from the most recent failed action; consumed once by the next cua_report_step. */
  lastErrorScan?: { compact: string; capturedAt: number };
}

let active: CuaRunState | null = null;

export function startRun(args: {
  runId: string;
  testFile: CuaTestFile;
  testFilePath: string;
  selectedCases: CuaTestCase[];
  runDir: string;
  shotsDir: string;
}): CuaRunState {
  const startedAt = new Date().toISOString();
  active = {
    runId: args.runId,
    startedAt,
    testFile: args.testFile,
    testFilePath: args.testFilePath,
    runDir: args.runDir,
    shotsDir: args.shotsDir,
    cases: args.selectedCases.map(tc => ({
      id: tc.id,
      title: tc.title,
      goal: tc.goal,
      preconditions: tc.preconditions,
      expected: tc.expected,
      steps: tc.steps.map((text, i) => ({ stepNumber: i + 1, text, status: 'pending' as const })),
      startedAt,
    })),
    currentCaseIndex: 0,
    screenshotCount: 0,
    hints: loadHintsSafe(args.testFilePath),
  };
  return active;
}

function loadHintsSafe(testFilePath: string): HintsFile {
  try {
    return loadHints(testFilePath);
  } catch {
    return emptyHints(testFilePath);
  }
}

export function getActive(): CuaRunState | null {
  return active;
}

export function requireActive(): CuaRunState {
  if (!active) throw new Error('No active CUA run. Call cua_run_test first.');
  return active;
}

export function currentCase(): CuaCaseRecord {
  const a = requireActive();
  if (a.currentCaseIndex >= a.cases.length) throw new Error('All test cases in this run are already complete.');
  return a.cases[a.currentCaseIndex];
}

export function recordStepResult(
  stepNumber: number,
  status: 'pass' | 'fail',
  observation: string,
  extra?: { screenshotFile?: string; screenChanged?: boolean; screenDelta?: string },
): void {
  const c = currentCase();
  const idx = stepNumber - 1;
  if (idx < 0 || idx >= c.steps.length) {
    throw new Error(`Step ${stepNumber} is out of range for ${c.id} (${c.steps.length} steps).`);
  }
  c.steps[idx].status = status;
  c.steps[idx].observation = observation;
  if (extra?.screenshotFile) c.steps[idx].screenshotFile = extra.screenshotFile;
  if (extra?.screenChanged !== undefined) c.steps[idx].screenChanged = extra.screenChanged;
  if (extra?.screenDelta !== undefined) c.steps[idx].screenDelta = extra.screenDelta;
}

export function setLastScreenshot(hash: string, summary?: string): void {
  const a = requireActive();
  a.lastScreenshotHash = hash;
  if (summary !== undefined) a.lastElementSummary = summary;
}

export function getLastScreenshotHash(): string | undefined {
  return active?.lastScreenshotHash;
}

export function getLastElementSummary(): string | undefined {
  return active?.lastElementSummary;
}

export function finishCurrentCase(verdict: 'pass' | 'fail', summary: string): { hasMore: boolean; next?: CuaCaseRecord } {
  const a = requireActive();
  const c = currentCase();
  c.verdict = verdict;
  c.summary = summary;
  c.finishedAt = new Date().toISOString();
  a.currentCaseIndex++;
  if (a.currentCaseIndex < a.cases.length) {
    return { hasMore: true, next: a.cases[a.currentCaseIndex] };
  }
  return { hasMore: false };
}

export function clearRun(): void {
  active = null;
}

export function nextScreenshotIndex(): number {
  const a = requireActive();
  return ++a.screenshotCount;
}

// ---------------------------------------------------------------------------
// Attempt + error tracking — populated by the act tools, consumed by cua tools.
// ---------------------------------------------------------------------------

export function setLastAttempt(attempt: HintAttempt): void {
  if (active) active.lastAttempt = attempt;
}

export function getLastAttempt(): HintAttempt | undefined {
  return active?.lastAttempt;
}

export function clearLastAttempt(): void {
  if (active) active.lastAttempt = undefined;
}

export function setLastErrorScan(scan: { compact: string; capturedAt: number }): void {
  if (active) active.lastErrorScan = scan;
}

export function consumeLastErrorScan(maxAgeMs = 30_000): { compact: string; capturedAt: number } | undefined {
  if (!active?.lastErrorScan) return undefined;
  const scan = active.lastErrorScan;
  active.lastErrorScan = undefined;
  if (Date.now() - scan.capturedAt > maxAgeMs) return undefined;
  return scan;
}

/**
 * The step-number the agent is currently working on (next 'pending' step in
 * the active case). Used by act tools to attribute mid-run failures to the
 * right step without the agent needing to pass it explicitly.
 */
export function currentPendingStep(): number | undefined {
  if (!active) return undefined;
  if (active.currentCaseIndex >= active.cases.length) return undefined;
  const c = active.cases[active.currentCaseIndex];
  return c.steps.find(s => s.status === 'pending')?.stepNumber;
}

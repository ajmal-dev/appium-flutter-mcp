import { z } from 'zod';
import { resolve, isAbsolute, join } from 'path';
import { existsSync } from 'fs';
import { createHash } from 'crypto';

/**
 * Resolve a CUA test file argument to an absolute path.
 *
 * Resolution order for relative paths:
 *   1. CUA_TESTCASES_DIR env var (when set) — the canonical out-of-repo location.
 *      Tests typically live in an Obsidian vault or shared docs folder, not
 *      in the MCP repo itself.
 *   2. process.cwd() — falls back to the legacy in-repo testcases/ path.
 *
 * Absolute paths are returned unchanged.
 */
export function resolveCuaTestFile(file: string): string {
  if (isAbsolute(file)) return file;
  const dir = process.env.CUA_TESTCASES_DIR;
  if (dir && dir.trim()) {
    const fromDir = resolve(dir, file);
    if (existsSync(fromDir)) return fromDir;
    // Fall through to cwd if the env-pointed file doesn't exist — preserves
    // ad-hoc usage where the agent passes a path relative to the project.
  }
  return resolve(process.cwd(), file);
}
import { parseCuaFile } from '../cua/parser.js';
import {
  startRun, getActive, currentCase,
  recordStepResult, finishCurrentCase, clearRun, nextScreenshotIndex,
  setLastScreenshot, getLastScreenshotHash, getLastElementSummary,
  getLastAttempt, clearLastAttempt, consumeLastErrorScan,
} from '../cua/run-state.js';
import { ensureRunDir, makeScreenshotSaver, writeReport } from '../cua/report.js';
import { recordSuccess, renderHintsForCase, saveHints } from '../cua/hints.js';
import { hasBrowser, getBrowserWithReconnect } from '../appium/session.js';
import { captureScreenshot, type ScreenshotResult } from '../util/screenshot.js';
import { buildWidgetTree } from '../tree/tree-builder.js';
import { formatElementsCompact, formatElementsSummaryLine, summarizeValueKeys } from '../util/element-format.js';
import { logger } from '../util/logger.js';
import type { Browser } from 'webdriverio';
import type { McpToolResponse } from '../types.js';

// ---------------------------------------------------------------------------
// cua_run_test — start a run, return the first test case + initial screenshot
//                 + compact widget tree + strategy hints
// ---------------------------------------------------------------------------

export const cuaRunTestSchema = z.object({
  file: z.string().describe('Path to a CUA-mode markdown test file. Relative paths resolve against CUA_TESTCASES_DIR env var if set, then against the project root.'),
  caseId: z.string().optional().describe('Optional TC-NNN id; if set, only that case runs. Default: run every case in the file.'),
  reportDir: z.string().optional().describe('Output dir for reports. Defaults to runs/cua/<timestamp>.'),
});

export async function handleCuaRunTest(params: z.infer<typeof cuaRunTestSchema>): Promise<McpToolResponse> {
  if (!hasBrowser()) {
    return errorResponse('No active Appium session. Call `connect` (and `launch_app` if needed) before running a CUA test.');
  }
  if (getActive()) {
    return errorResponse('A CUA run is already active. Call cua_finish_test on the current run before starting a new one.');
  }

  const filePath = resolveCuaTestFile(params.file);
  if (!existsSync(filePath)) {
    const envHint = process.env.CUA_TESTCASES_DIR ? ` (also tried CUA_TESTCASES_DIR=${process.env.CUA_TESTCASES_DIR})` : '';
    return errorResponse(`Test file not found: ${filePath}${envHint}`);
  }

  const testFile = parseCuaFile(filePath);
  if (testFile.cases.length === 0) {
    return errorResponse(`No test cases parsed from ${filePath}. Cases must be headed with "## TC-NNN: ...".`);
  }

  const selected = params.caseId
    ? testFile.cases.filter(c => c.id === params.caseId)
    : testFile.cases;
  if (selected.length === 0) {
    return errorResponse(`Case ${params.caseId} not found in ${filePath}. Available: ${testFile.cases.map(c => c.id).join(', ')}`);
  }

  const startedAt = new Date();
  const runId = formatRunId(startedAt);
  const baseDir = params.reportDir
    ? (isAbsolute(params.reportDir) ? params.reportDir : resolve(process.cwd(), params.reportDir))
    : join(process.cwd(), 'runs', 'cua');
  const { runDir, shotsDir } = ensureRunDir(baseDir, runId);

  const state = startRun({
    runId, testFile, testFilePath: filePath, selectedCases: selected, runDir, shotsDir,
  });

  logger.info('CUA run starting', { file: filePath, cases: selected.length, runDir });

  const browser = await getBrowserWithReconnect();
  const observation = await captureObservation(browser, state.cases[0].id);
  setLastScreenshot(observation.hash, observation.summary);

  const tc = state.cases[0];
  const hintsBlock = renderHintsForCase(state.hints, tc.id, tc.steps);
  const text = renderCasePrompt(tc, observation.dims, observation.fileName, state.cases.length, observation.summary, hintsBlock);

  return {
    content: [
      { type: 'text' as const, text },
      { type: 'image' as const, data: observation.shot.base64, mimeType: observation.shot.mimeType },
    ],
  };
}

// ---------------------------------------------------------------------------
// cua_report_step — record one step's outcome, capture+diff screenshot,
//                   surface "screen changed?" hint to the caller
// ---------------------------------------------------------------------------

export const cuaReportStepSchema = z.object({
  stepNumber: z.number().int().positive().describe('1-based step number from the current test case.'),
  status: z.enum(['pass', 'fail']).describe('Outcome for this step.'),
  observation: z.string().describe('Short factual note about what you saw on screen that justified the verdict.'),
});

export async function handleCuaReportStep(params: z.infer<typeof cuaReportStepSchema>): Promise<McpToolResponse> {
  const state = getActive();
  if (!state) return errorResponse('No active CUA run. Call cua_run_test first.');

  const c = currentCase();
  const stepIdx = params.stepNumber - 1;
  const stepText = c.steps[stepIdx]?.text ?? '';
  const isAssertion = isAssertionStep(stepText);
  let fileName: string | undefined;
  let screenChanged: boolean | undefined;
  let screenDelta: string | undefined;

  try {
    const browser = await getBrowserWithReconnect();
    const obs = await captureObservation(browser, c.id, { skipElementSummary: isAssertion });
    fileName = obs.fileName;
    const prevHash = getLastScreenshotHash();
    screenChanged = prevHash ? prevHash !== obs.hash : undefined;
    if (!isAssertion) {
      screenDelta = describeDelta(getLastElementSummary(), obs.summary);
      setLastScreenshot(obs.hash, obs.summary);
    } else {
      // For assertion steps we skip the summary rebuild — keep the previous
      // summary in place so the next action step still has it.
      setLastScreenshot(obs.hash, getLastElementSummary() ?? '');
    }
  } catch (e) {
    logger.warn('CUA report_step: screenshot/scan failed', { error: String(e) });
  }

  try {
    recordStepResult(params.stepNumber, params.status, params.observation, {
      screenshotFile: fileName, screenChanged, screenDelta,
    });
  } catch (e) {
    return errorResponse(String(e));
  }

  // Promote the last attempt into a successful hint when the step passed and
  // the agent actually performed an action (assertion-only steps usually
  // don't have a lastAttempt, which is fine).
  if (params.status === 'pass') {
    const attempt = getLastAttempt();
    if (attempt) {
      try {
        recordSuccess(state.hints, c.id, params.stepNumber, stepText, attempt);
      } catch (e) {
        logger.debug('CUA hints: recordSuccess failed (non-critical)', { error: String(e) });
      }
    }
  }
  clearLastAttempt();

  const errorScan = consumeLastErrorScan();

  const remaining = c.steps.filter(s => s.status === 'pending').map(s => s.stepNumber);
  const lines: string[] = [];
  lines.push(`Recorded ${c.id} step ${params.stepNumber} as ${params.status}.`);
  if (screenChanged === true) {
    lines.push(`Screen changed since the previous step${screenDelta ? ` (${screenDelta})` : ''}.`);
  } else if (screenChanged === false) {
    lines.push(`Screen UNCHANGED since the previous step. If you expected a state change, re-evaluate the strategy (try a different locator, scroll/wait, smart_tap, or coordinates as a last resort).`);
  }
  if (errorScan) {
    const ageSec = Math.max(0, Math.round((Date.now() - errorScan.capturedAt) / 1000));
    lines.push(`\n## Pre-existing scan from your last failed action (${ageSec}s ago)\n${errorScan.compact}`);
  }
  if (remaining.length > 0) {
    lines.push(`Remaining steps in this case: ${remaining.join(', ')}. Continue with the next step.`);
  } else {
    lines.push(`All steps for this case are reported — call cua_finish_test with the verdict.`);
  }
  return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}

const ASSERTION_RE = /\b(verify|displayed|visible|shown|present|loaded|highlighted|selected|appears?|confirm)\b/i;
function isAssertionStep(stepText: string): boolean {
  if (!stepText) return false;
  // If the step also asks for an action verb, treat as action.
  if (/\b(tap|click|enter|type|select(\s+the)?|switch|navigate|scroll|swipe|press|open|close|launch)\b/i.test(stepText)) {
    return false;
  }
  return ASSERTION_RE.test(stepText);
}

// ---------------------------------------------------------------------------
// cua_finish_test — finalize current case (or whole run if last) + write report
// ---------------------------------------------------------------------------

export const cuaFinishTestSchema = z.object({
  verdict: z.enum(['pass', 'fail']).describe('Overall verdict for the current test case. "pass" requires every step passed AND the Expected Outcome holds.'),
  summary: z.string().describe('One-paragraph summary of what was verified and any issues observed.'),
});

export async function handleCuaFinishTest(params: z.infer<typeof cuaFinishTestSchema>): Promise<McpToolResponse> {
  const state = getActive();
  if (!state) return errorResponse('No active CUA run. Call cua_run_test first.');

  let next;
  try {
    next = finishCurrentCase(params.verdict, params.summary);
  } catch (e) {
    return errorResponse(String(e));
  }

  if (next.hasMore && next.next) {
    const browser = await getBrowserWithReconnect();
    const obs = await captureObservation(browser, next.next.id);
    setLastScreenshot(obs.hash, obs.summary);
    const hintsBlock = renderHintsForCase(state.hints, next.next.id, next.next.steps);
    const text = `Recorded ${state.cases[state.currentCaseIndex - 1].id} as ${params.verdict}.\n\nNext case:\n` +
      renderCasePrompt(next.next, obs.dims, obs.fileName, state.cases.length, obs.summary, hintsBlock);
    return {
      content: [
        { type: 'text' as const, text },
        { type: 'image' as const, data: obs.shot.base64, mimeType: obs.shot.mimeType },
      ],
    };
  }

  // Persist hints before clearing run state — failures here must never break
  // the report.
  try {
    saveHints(state.testFilePath, state.hints);
  } catch (e) {
    logger.warn('CUA hints: saveHints failed', { error: String(e) });
  }

  const { reportPath, htmlPath, report } = writeReport(state);
  clearRun();
  logger.info('CUA run complete', { reportPath, totals: report.totals });

  const lines = [
    `CUA run finished — ${report.totals.passed}/${report.totals.total} passed`,
    `  Failed: ${report.totals.failed} · Pending: ${report.totals.pending}`,
    `  Report: ${htmlPath}`,
    `  JSON:   ${reportPath}`,
    '',
    ...report.cases.map(c => `  ${c.id}  ${(c.verdict || 'pending').padEnd(8)} ${c.title}`),
  ];
  return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface CapturedObservation {
  shot: ScreenshotResult;
  dims: string;
  fileName: string;
  hash: string;
  summary: string;
}

async function captureObservation(
  browser: Browser,
  caseId: string,
  opts?: { skipElementSummary?: boolean },
): Promise<CapturedObservation> {
  const state = getActive();
  if (!state) throw new Error('No active CUA run');

  const shot = await captureScreenshot(browser);
  let dims = '';
  try { const r = await browser.getWindowRect(); dims = `${r.width}x${r.height}px`; } catch { /* */ }

  const saver = makeScreenshotSaver(state.shotsDir);
  const idx = nextScreenshotIndex();
  const fileName = saver(caseId, idx, shot.base64, shot.mimeType);
  const hash = createHash('sha1').update(shot.base64).digest('hex');

  // Build a compact element summary — best-effort, never block the run on
  // this. Skipped on assertion-only step reports (the agent is using vision,
  // not locators), saving the widget-tree rebuild cost.
  let summary = '';
  if (!opts?.skipElementSummary) {
    try {
      const tree = await buildWidgetTree({ interactiveOnly: true });
      const head = formatElementsSummaryLine(tree.interactiveElements);
      const keys = summarizeValueKeys(tree.interactiveElements);
      const compact = formatElementsCompact(tree.interactiveElements.slice(0, 25));
      summary = [head, keys, compact].filter(Boolean).join('\n');
    } catch (e) {
      logger.debug('CUA capture: widget tree unavailable', { error: String(e) });
    }
  }

  return { shot, dims, fileName, hash, summary };
}

function describeDelta(prev?: string, next?: string): string | undefined {
  if (!prev || !next) return undefined;
  const pHead = prev.split('\n', 1)[0] || '';
  const nHead = next.split('\n', 1)[0] || '';
  if (!pHead && !nHead) return undefined;
  if (pHead === nHead) return undefined;
  return `${pHead} → ${nHead}`;
}

function errorResponse(message: string): McpToolResponse {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message }) }] };
}

function formatRunId(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function renderCasePrompt(
  c: { id: string; title: string; goal?: string; preconditions: string[]; steps: { stepNumber: number; text: string }[]; expected?: string },
  deviceDims: string,
  screenshotFile: string,
  totalCases: number,
  elementSummary?: string,
  hintsBlock?: string | null,
): string {
  const lines: string[] = [];
  lines.push(`# CUA test case: ${c.id} — ${c.title}`);
  lines.push(`Run has ${totalCases} case(s).`);
  if (deviceDims) lines.push(`Device viewport: ${deviceDims} (use these device pixels for any coordinate-based action).`);
  if (c.goal) lines.push(`\n## Goal\n${c.goal}`);
  if (c.preconditions.length) {
    lines.push(`\n## Preconditions`);
    c.preconditions.forEach(p => lines.push(`- ${p}`));
  }
  lines.push(`\n## Steps`);
  c.steps.forEach(s => lines.push(`${s.stepNumber}. ${s.text}`));
  if (c.expected) lines.push(`\n## Expected Outcome\n${c.expected}`);

  if (hintsBlock && hintsBlock.trim()) {
    lines.push(`\n${hintsBlock.trim()}`);
    lines.push(`Trust PROVEN strategies (try them first). Treat AVOID entries as known dead-ends — don't repeat them unless the screen state has materially changed.`);
  }

  lines.push(`\n## Decision flow per step`);
  lines.push(`1. **Classify the step** before doing anything else:`);
  lines.push(`   - **Action step** — the step changes app state (tap, type, scroll, switch context, navigate, login). Drive these with **locators / widget tree**, not vision.`);
  lines.push(`   - **Assertion step** — the step verifies something is visible / displayed / entered / shown / present / highlighted / selected. Drive these with **vision** (the screenshot), not locators.`);
  lines.push(`2. **Observe** — read the latest screenshot + the element summary below. For action steps, if you need more locator detail call \`get_widget_tree({format:"compact"})\` or \`find_elements\`. For assertion steps, the screenshot itself is the source of truth.`);
  lines.push(`3. **For ACTION steps — use locators / widget tree (avoid raw coordinates):**`);
  lines.push(`   - Tap a button/icon → \`tap({by:"key"|"text"|"semanticsLabel"|"type", target})\`. If multiple match, use \`find_elements\` first to pick the right \`index\`.`);
  lines.push(`   - Type into a text field → \`type_text({by:"semanticsLabel"|"key"|"type", target, text, clearFirst?})\`. The Flutter VM's enterText is reliable across iOS/Android.`);
  lines.push(`   - Native (iOS/Android) elements → \`tap/type_text({by:"accessibilityId"|"xpath", target})\`.`);
  lines.push(`   - WebView elements → switch first (\`switch_context({to:"webview"})\` or \`wait_for_webview\`), then \`{by:"css"|"xpath"}\`.`);
  lines.push(`   - Natural-language target with no obvious locator → \`smart_tap({description})\`.`);
  lines.push(`   - Coordinate tap is a **last resort** — only when no stable locator exists after checking the widget tree.`);
  lines.push(`4. **For ASSERTION / VALIDATION steps — use VISION:**`);
  lines.push(`   - "X is visible / displayed / shown / present" → look at the screenshot, confirm visually, then \`cua_report_step\` with what you saw.`);
  lines.push(`   - "Field accepts X" / "X is entered" / "X is highlighted" / "X is selected" / "data is displayed" → confirm visually from the screenshot.`);
  lines.push(`   - "Page / panel / dialog loads with Y" → confirm visually that Y is rendered.`);
  lines.push(`   - Do **not** call \`find_elements\` or \`get_widget_tree\` just to validate visibility — the screenshot is the source of truth for assertions. Locators are an optional cross-check, not the primary signal.`);
  lines.push(`5. **Act** (action steps) using the chosen locator primitive — or skip directly to step 6 for pure assertion steps.`);
  lines.push(`6. **Report** the step: \`cua_report_step({stepNumber, status, observation})\`. The MCP captures a fresh screenshot, diffs it against the previous step, and tells you whether the screen actually changed — use that signal to decide whether to retry with a different strategy.`);
  lines.push(`7. **Finish** after the last step: \`cua_finish_test({verdict, summary})\`. verdict="pass" only if every step passed AND the Expected Outcome holds.`);

  lines.push(`\n## Recovery hints`);
  lines.push(`- "Action OK but screen didn't change" reported by cua_report_step → retry once with a different locator / scroll / wait, then switch strategy (different locator type, smart_tap, or coordinates as a last resort).`);
  lines.push(`- A locator-based call returns \`{error: true, …}\` with an element scan attached — use that scan to pick a working locator.`);
  lines.push(`- For Flutter forms: the VM-friendly strategies are \`key\`, \`text\`, \`type\`, \`semanticsLabel\`, \`tooltip\`. xpath/css apply to webview; accessibilityId applies to native.`);
  lines.push(`- Assertion fails visually but a locator finds the element (or vice versa) → trust vision; the element may be off-screen, occluded, or hidden behind another widget.`);

  if (elementSummary && elementSummary.trim()) {
    lines.push(`\n## Current screen elements (compact)`);
    lines.push(elementSummary.trim());
  }

  lines.push(`\nThe screenshot below is the current device state. Saved to: ${screenshotFile}.`);
  return lines.join('\n');
}

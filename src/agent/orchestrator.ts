/**
 * Agentic run orchestrator.
 *
 * Wires existing primitives (recording, codegen, export, screen-map, debug-loop)
 * into the autonomous create-test workflow described in the agent contract.
 *
 * The MCP holds the state machine and runs the deterministic phases (codegen,
 * export, mvn verify, world-memory writes). Claude (the agent) drives the
 * interactive phases (ground, plan, explore/execute, verify) by calling the
 * existing tap/type_text/etc. tools and reporting through agentic_test_step.
 */

import { createHash } from 'crypto';
import { join } from 'path';
import { writeFileSync } from 'fs';
import { createRequire } from 'module';

import type { Browser } from 'webdriverio';
import { logger } from '../util/logger.js';
import { captureScreenshot, LLM_SCREENSHOT_OPTS } from '../util/screenshot.js';
import { buildWidgetTree } from '../tree/tree-builder.js';
import { scanWebViewInteractiveElements } from '../tree/page-source-scanner.js';
import { formatElementsCompact, formatElementsSummaryLine, summarizeValueKeys } from '../util/element-format.js';
import { getCurrentContext } from '../context/context-manager.js';
import { getCurrentAppId, recordScreen, generateFingerprint, bindScreenName } from '../context/screen-map-store.js';
import { hasVMClient, connectVMAutoDiscover, getVMSessionInfo } from '../vm/vm-session.js';
import { getCurrentPlatform } from '../appium/session.js';

import { ensureRunDir, makeScreenshotSaver } from '../util/run-report.js';
import {
  isRecording, startRecording, stopRecording, getActiveRecording, getLastRecording,
  type Recording, type RecordedAction,
} from '../recording/recorder.js';
import { generateTestScript } from '../recording/test-generator.js';
import { exportToProject } from '../project/exporter.js';
import { scanProject, type ExistingPageObject } from '../project/scanner.js';
import { loadConfig } from '../util/config.js';

import {
  recallFlows, saveFlow, recordFlowSuccess, recordFlowFailure,
  flowIdFromGoal, tagsFromGoal, loadFlow,
  type FlowMatch, type FlowRecord, type FlowStep,
} from '../world/flow-store.js';
import { recallPitfalls, recordPitfall, type PitfallEntry } from '../world/pitfall-store.js';
import { findInventoryByGoal, upsertInventoryEntry, type InventoryEntry } from '../world/test-inventory.js';

import {
  getActive as getAgentRun, requireActive, setActive, clearActive,
  pushEvent, nextScreenshotIndex,
  type AgenticRunState, type AgenticPhase, type StopReason, type AgenticStepEvent,
} from './run-state.js';
import { renderAgentContract, type ContractInputs } from './contract.js';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Public starters / step / finish — wrapped by tool handlers
// ---------------------------------------------------------------------------

export interface StartArgs {
  goal: string;
  projectPath?: string;
  testClassName?: string;
  testMethodName?: string;
  packageName?: string;
  maxSteps?: number;
  exportOnSuccess?: boolean;
  verifyWithMaven?: boolean;
  /** After compile, run the generated test class. Failures returned for live MCP debugging. */
  runTestAfterExport?: boolean;
}

export interface WebViewSummary {
  id: string;
  url?: string;
  title?: string;
}

export interface PreflightReport {
  appiumSession: { ok: true; platform: string; sessionId?: string };
  vmService: { ok: boolean; url?: string; reason?: string };
  app: { ok: boolean; bundleId?: string; state?: string; reason?: string };
  webviews: WebViewSummary[];
  warnings: string[];
}

export interface StartedRun {
  state: AgenticRunState;
  initialObservation: CapturedObservation;
  preflight: PreflightReport;
}

export async function startAgenticRun(browser: Browser, args: StartArgs): Promise<StartedRun> {
  if (getAgentRun()) {
    throw new Error('An agentic run is already active. Call agentic_finish on the current run before starting a new one.');
  }

  const config = loadConfig();
  const projectPath = args.projectPath || config.automationProjectPath;
  const appId = getCurrentAppId() || config.bundleId || config.appPackage || 'unknown-app';
  const preflight = await runPreflight(browser, appId);

  const startedAt = new Date();
  const runId = formatRunId(startedAt);
  const baseDir = join(process.cwd(), 'runs', 'agentic');
  const { runDir, shotsDir } = ensureRunDir(baseDir, runId);

  // Recall world memory for the goal
  const recalledFlows = recallFlows(appId, args.goal, 5);
  const inventoryHit = findInventoryByGoal(appId, args.goal);
  const recalledPitfalls = recallPitfalls(appId, { goal: args.goal, limit: 5 });

  const state: AgenticRunState = {
    runId,
    startedAt: startedAt.toISOString(),
    goal: args.goal,
    tags: tagsFromGoal(args.goal),
    appId,
    projectPath,
    testClassName: args.testClassName,
    testMethodName: args.testMethodName,
    packageName: args.packageName,
    maxSteps: args.maxSteps ?? 60,
    exportOnSuccess: args.exportOnSuccess ?? true,
    verifyWithMaven: args.verifyWithMaven ?? true,
    runTestAfterExport: args.runTestAfterExport ?? false,
    runDir,
    shotsDir,
    phase: 'GROUND',
    stepCount: 0,
    screenshotCount: 0,
    noProgressStreak: 0,
    events: [],
    recalledFlows,
    recalledPitfalls,
    inventoryHit,
    preflight,
  };
  setActive(state);

  // Start recording if one isn't already running. The agent does not need to
  // start it manually — that's the autonomy contract.
  try {
    if (!isRecording()) {
      const recordingName = sanitizeRecordingName(args.goal);
      startRecording(recordingName, /* platform */ inferPlatformFromConfig(config), {
        testClassName: args.testClassName,
        testMethodName: args.testMethodName,
        packageName: args.packageName,
        description: args.goal,
      });
      logger.info('Agentic: recording started', { runId, name: recordingName });
    } else {
      logger.warn('Agentic: a recording was already in progress — actions will be appended to it');
    }
  } catch (e) {
    logger.warn('Agentic: failed to start recording', { error: String(e) });
  }

  const observation = await captureObservation(browser);
  state.lastScreenFingerprint = observation.fingerprint;
  state.lastElementSummary = observation.summary;
  state.lastContext = observation.context;
  state.lastScreenshotFile = observation.fileName;
  state.lastScreenName = observation.screenName;

  return { state, initialObservation: observation, preflight };
}

// ---------------------------------------------------------------------------
// Preflight — verify Appium + VM + app are ready before handing the agent
// the contract. Best-effort: VM auto-discovery is attempted if the client
// isn't connected; app foreground check uses `mobile: queryAppState`.
// ---------------------------------------------------------------------------

async function runPreflight(browser: Browser, appId: string): Promise<PreflightReport> {
  const warnings: string[] = [];
  const platform = getCurrentPlatform();
  const preflight: PreflightReport = {
    appiumSession: { ok: true, platform, sessionId: browser.sessionId },
    vmService: { ok: false },
    app: { ok: false, bundleId: appId },
    webviews: [],
    warnings,
  };

  // VM service — try to (re)discover if not connected. Cheap probe; auto-
  // discovery just scans known localhost ports.
  if (hasVMClient()) {
    const info = getVMSessionInfo();
    preflight.vmService = { ok: true, url: info.url };
  } else {
    try {
      const discovered = await connectVMAutoDiscover();
      if (discovered) {
        preflight.vmService = { ok: true, url: discovered.url };
      } else {
        preflight.vmService = { ok: false, reason: 'no Dart VM Service URL found via auto-discovery' };
        warnings.push('Dart VM Service is not connected. Flutter-context locator calls will use the slower Appium path; reliability drops. To fix: call `connect` with `vmServiceUrl: "ws://127.0.0.1:PORT/ws"` (grab from the Flutter debug console).');
      }
    } catch (e) {
      preflight.vmService = { ok: false, reason: String(e) };
      warnings.push(`Dart VM Service discovery failed: ${String(e)}. Pass an explicit \`vmServiceUrl\` to \`connect\`.`);
    }
  }

  // App foreground check — best-effort. iOS: `mobile: queryAppState` returns
  // 4 for "running in foreground". Android: same shape via `mobile: queryAppState`
  // with appId.
  try {
    const stateArg = platform === 'android' ? { appId } : { bundleId: appId };
    const raw = await browser.execute('mobile: queryAppState', stateArg);
    const stateCode = typeof raw === 'number' ? raw : Number(raw);
    preflight.app.state = appStateLabel(stateCode);
    preflight.app.ok = stateCode === 4;
    if (!preflight.app.ok) {
      warnings.push(`App \`${appId}\` is not in the foreground (state=${preflight.app.state}). The agent should call \`launch_app\` before driving the test, or expect the first action to fail.`);
    }
  } catch (e) {
    preflight.app.reason = String(e);
    warnings.push(`Could not query app state for \`${appId}\`: ${String(e)}. Verify the app is launched.`);
  }

  // WebView enumeration via `mobile: getContexts` (full metadata, no switching).
  // Matches zmauiautomation's findWebViewContextByUrl pattern.
  try {
    const raw = await browser.executeScript('mobile: getContexts', []);
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const ctx = item as Record<string, unknown>;
        const id = typeof ctx.id === 'string' ? ctx.id : undefined;
        if (!id || !id.startsWith('WEBVIEW')) continue;
        preflight.webviews.push({
          id,
          url: typeof ctx.url === 'string' ? ctx.url : undefined,
          title: typeof ctx.title === 'string' ? ctx.title : undefined,
        });
      }
    }
    if (preflight.webviews.length === 0 && platform === 'ios') {
      warnings.push(
        'No WKWebView contexts are exposed by Appium. If this build is supposed to surface webviews (booking wizard, guest form), verify the app was built with WebKit inspectability enabled and that the session was created with `appium:webviewConnectTimeout` + `appium:webviewConnectRetries` (auto-set as of this MCP version — reconnect if you connected before the upgrade).',
      );
    }
  } catch (e) {
    warnings.push(`WebView enumeration via \`mobile: getContexts\` failed: ${String(e)}.`);
  }

  return preflight;
}

function appStateLabel(code: number): string {
  switch (code) {
    case 0: return 'not_installed';
    case 1: return 'not_running';
    case 2: return 'running_background_suspended';
    case 3: return 'running_background';
    case 4: return 'running_foreground';
    default: return `unknown(${code})`;
  }
}

export interface StepArgs {
  status?: 'ok' | 'stuck' | 'progress' | 'note';
  observation: string;
  phase?: AgenticPhase;
  screenName?: string;
  /** Screenshot policy for this cycle. Default 'auto': skip the capture when
   *  the element summary is unchanged since the previous cycle. */
  screenshot?: ScreenshotPolicy;
}

export interface SteppedRun {
  state: AgenticRunState;
  observation: CapturedObservation;
  screenChanged?: boolean;
  screenDelta?: string;
  /** true when the agent's phase advanced during THIS step call. */
  phaseChanged: boolean;
  errorScan?: { compact: string; capturedAt: number };
  stopFired: boolean;
  /** Auto-set when a hard stop condition fired — the handler should report and abort. */
  autoStopReason?: StopReason;
}

export async function stepAgenticRun(browser: Browser, args: StepArgs): Promise<SteppedRun> {
  const state = requireActive();

  // Phase advance — if the agent explicitly bumped it, accept it; otherwise
  // keep the current phase. The orchestrator never silently regresses.
  const phaseBefore = state.phase;
  if (args.phase && phaseRank(args.phase) >= phaseRank(state.phase)) {
    state.phase = args.phase;
  }
  const phaseChanged = state.phase !== phaseBefore;

  state.stepCount += 1;

  // Capture fresh observation (tree-first; screenshot only when needed)
  const observation = await captureObservation(browser, {
    screenshotPolicy: args.screenshot ?? 'auto',
    prevSummary: state.lastElementSummary,
    prevFingerprint: state.lastScreenFingerprint,
  });
  // Change detection: prefer the content-level summary compare (catches text
  // changes like a date flip that structural fingerprints miss); fall back to
  // fingerprint compare when summaries aren't available (webview/native).
  let screenChanged: boolean | undefined;
  if (!state.lastScreenFingerprint) {
    screenChanged = undefined;
  } else if (observation.summary && typeof state.lastElementSummary === 'string') {
    screenChanged = !observation.elementsUnchanged;
  } else {
    screenChanged = state.lastScreenFingerprint !== observation.fingerprint;
  }
  const screenDelta = screenChanged === true
    ? describeDelta(state.lastElementSummary, observation.summary)
    : undefined;

  // Compute no-progress streak: count consecutive steps where the screen did
  // not change AND the recording did not grow. The recording-grew check lets
  // typing in a text field (which often doesn't change the screen markedly)
  // still count as progress.
  const recordingActionsAtReport = getActiveRecording()?.actions.length ?? 0;
  const lastRecordedCount = lastRecordedActionCount(state) ?? recordingActionsAtReport;
  const recordingGrew = recordingActionsAtReport > lastRecordedCount;

  if (args.status === 'progress' || screenChanged === true || recordingGrew) {
    state.noProgressStreak = 0;
  } else if (state.phase === 'EXPLORE_EXECUTE') {
    state.noProgressStreak += 1;
  }

  if (args.screenName) {
    state.lastScreenName = args.screenName;
    // Persist the binding so future sessions resolve this screen by name
    if (observation.screenMapId) {
      try { bindScreenName(state.appId, observation.screenMapId, args.screenName); } catch { /* non-critical */ }
    }
  }
  state.lastScreenFingerprint = observation.fingerprint;
  state.lastElementSummary = observation.summary;
  state.lastContext = observation.context;
  if (!observation.screenshotSkipped) state.lastScreenshotFile = observation.fileName;
  if (observation.screenName && !args.screenName) state.lastScreenName = observation.screenName;

  pushEvent({
    index: state.stepCount,
    at: new Date().toISOString(),
    phase: state.phase,
    status: args.status ?? 'ok',
    observation: args.observation,
    screenshotFile: observation.screenshotSkipped ? undefined : observation.fileName,
    screenFingerprint: observation.fingerprint,
    screenName: state.lastScreenName,
    context: observation.context,
    screenChanged,
    recordingActionsAtReport,
  });

  // Stop conditions
  let autoStopReason: StopReason | undefined;
  if (state.stepCount >= state.maxSteps) autoStopReason = 'step_budget';
  else if (state.noProgressStreak >= 3) autoStopReason = 'no_progress';

  return {
    state,
    observation,
    screenChanged,
    screenDelta,
    phaseChanged,
    stopFired: !!autoStopReason,
    autoStopReason,
  };
}

export interface FinishArgs {
  verdict: 'pass' | 'fail' | 'abort';
  summary: string;
}

export interface FinishResult {
  stopReason: StopReason;
  summary: string;
  recording?: Recording;
  generated?: ReturnType<typeof generateTestScript>;
  exportResult?: ReturnType<typeof exportToProject>;
  compileResult?: { ok: boolean; output: string };
  testRunResult?: { ok: boolean; output: string; failures: string[] };
  flow?: FlowRecord;
  inventory?: InventoryEntry;
  pitfall?: PitfallEntry;
  reportPaths: { reportJson: string; reportHtml: string };
}

export async function finishAgenticRun(args: FinishArgs): Promise<FinishResult> {
  const state = requireActive();
  const stopReason: StopReason = args.verdict === 'pass'
    ? 'success'
    : args.verdict === 'abort'
      ? 'aborted'
      : 'failed';
  state.stopReason = stopReason;
  state.finishSummary = args.summary;
  state.phase = 'FINISH';

  let recording: Recording | undefined;
  let generated: ReturnType<typeof generateTestScript> | undefined;
  let exportResult: ReturnType<typeof exportToProject> | undefined;
  let compileResult: { ok: boolean; output: string } | undefined;
  let testRunResult: { ok: boolean; output: string; failures: string[] } | undefined;
  let flow: FlowRecord | undefined;
  let inventory: InventoryEntry | undefined;
  let pitfall: PitfallEntry | undefined;

  // Always stop the recording so we don't leave it dangling for the next run.
  try {
    if (isRecording()) recording = stopRecording();
    else recording = getLastRecording() ?? undefined;
  } catch (e) {
    logger.warn('Agentic: stopRecording failed', { error: String(e) });
  }

  const isPass = stopReason === 'success';

  if (isPass && recording && recording.actions.length > 0) {
    // Apply name overrides we held since start.
    if (state.testClassName) recording.metadata.testClassName = state.testClassName;
    if (state.testMethodName) recording.metadata.testMethodName = state.testMethodName;
    if (state.packageName) recording.metadata.packageName = state.packageName;
    if (!recording.metadata.description) recording.metadata.description = state.goal;

    // Codegen — reuse existing page objects if we have a project path.
    let existingPages: ExistingPageObject[] | undefined;
    if (state.projectPath) {
      try {
        existingPages = scanProject(state.projectPath).pageObjects;
      } catch (e) {
        logger.warn('Agentic: scanProject failed (continuing without reuse)', { error: String(e) });
      }
    }

    try {
      generated = generateTestScript(recording, existingPages);
    } catch (e) {
      logger.error('Agentic: generateTestScript failed', { error: String(e) });
    }

    if (generated && state.exportOnSuccess && state.projectPath) {
      try {
        exportResult = exportToProject(state.projectPath, generated);
      } catch (e) {
        logger.error('Agentic: exportToProject failed', { error: String(e) });
      }
    }

    if (exportResult?.success && state.verifyWithMaven && state.projectPath) {
      compileResult = mavenCompile(state.projectPath);
      if (!compileResult.ok) {
        logger.warn('Agentic: mvn compile failed', {
          firstError: firstCompileError(compileResult.output),
        });
      }
    }

    // After a clean compile, optionally run the test class to verify it passes
    // on the live device. Failures are returned to Claude so it can use MCP
    // live inspection to diagnose — rather than making static code fixes.
    if (
      compileResult?.ok &&
      state.runTestAfterExport &&
      state.projectPath &&
      generated?.testClass
    ) {
      const className = generated.testClass.fileName.replace(/\.java$/, '');
      logger.info('Agentic: running generated test to verify', { className });
      testRunResult = mavenRunTest(state.projectPath, className);
      if (!testRunResult.ok) {
        logger.warn('Agentic: generated test failed — Claude should use MCP to diagnose', {
          failures: testRunResult.failures,
        });
      } else {
        logger.info('Agentic: generated test passed ✅', { className });
      }
    }

    // Save a flow record either way — the run did produce a working sequence
    // even if mvn compile flaked. If a flow with this id exists, bump its
    // success counter and refresh steps.
    const flowSteps = recordingToFlowSteps(recording, state);
    const flowId = preferredFlowId(state);
    const existing = loadFlow(state.appId, flowId);
    if (existing) {
      existing.steps = flowSteps;
      existing.lastVerifiedAt = new Date().toISOString();
      existing.runReportPath = join(state.runDir, 'report.json');
      if (exportResult?.success) {
        const generatedPath = generated?.testClass?.filePath;
        if (generatedPath) existing.generatedTestPath = generatedPath;
      }
      recordFlowSuccess(existing);
      flow = existing;
    } else {
      flow = {
        schemaVersion: 1,
        id: flowId,
        goal: state.goal,
        tags: state.tags,
        appId: state.appId,
        createdAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        successCount: 1,
        failCount: 0,
        steps: flowSteps,
        generatedTestPath: generated?.testClass?.filePath,
        runReportPath: join(state.runDir, 'report.json'),
      };
      saveFlow(flow);
    }

    if (exportResult?.success && generated) {
      inventory = upsertInventoryEntry(state.appId, {
        flowId: flow.id,
        goal: state.goal,
        testClassName: generated.testClass.fileName.replace(/\.java$/, ''),
        testMethodName: recording.metadata.testMethodName,
        packageName: recording.metadata.packageName,
        filePath: generated.testClass.filePath,
        projectPath: state.projectPath || '',
        generatedAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        compileStatus: compileResult ? (compileResult.ok ? 'ok' : 'failed') : 'skipped',
      });
    }
  } else if (!isPass) {
    // Pitfall write for fail/abort — capture the screen we were stuck on.
    pitfall = recordPitfall(state.appId, {
      goal: state.goal,
      screenFingerprint: state.lastScreenFingerprint,
      screenName: state.lastScreenName,
      context: state.lastContext,
      failureKind: stopReason === 'aborted' ? 'agent_aborted' : 'other',
      summary: args.summary,
      runReportPath: join(state.runDir, 'report.json'),
    });
    if (flow === undefined) {
      // If a flow with this id exists (warm fail of a known flow), bump its fail
      // counter so the next recall block reflects degraded confidence.
      const existing = loadFlow(state.appId, preferredFlowId(state));
      if (existing) {
        recordFlowFailure(existing);
        flow = existing;
      }
    }
  }

  const reportPaths = writeAgenticReport(state, {
    recording, generated, exportResult, compileResult, flow, inventory, pitfall,
    verdict: args.verdict, summary: args.summary,
  });

  clearActive();
  return {
    stopReason, summary: args.summary,
    recording, generated, exportResult, compileResult, testRunResult,
    flow, inventory, pitfall,
    reportPaths,
  };
}

// ---------------------------------------------------------------------------
// Contract rendering — single entrypoint used by all tool handlers
// ---------------------------------------------------------------------------

export function renderContractFor(extra?: Partial<ContractInputs>): string {
  const state = requireActive();
  return renderAgentContract({
    state,
    elementSummary: state.lastElementSummary,
    deviceDims: extra?.deviceDims,
    currentScreenName: state.lastScreenName,
    screenshotFile: state.lastScreenshotFile,
    screenChanged: extra?.screenChanged,
    screenDelta: extra?.screenDelta,
    errorScan: extra?.errorScan,
    lastObservation: extra?.lastObservation,
    cycle: extra?.cycle,
    phaseChanged: extra?.phaseChanged,
    elementsUnchanged: extra?.elementsUnchanged,
    screenshotSkipped: extra?.screenshotSkipped,
  });
}

// ---------------------------------------------------------------------------
// Observation capture
// ---------------------------------------------------------------------------

export interface CapturedObservation {
  /** Empty string when the screenshot was skipped (screenshotSkipped=true). */
  base64: string;
  mimeType: 'image/png' | 'image/jpeg';
  dims: string;
  fileName: string;
  fingerprint: string;
  summary: string;
  context: 'flutter' | 'webview' | 'native' | 'unknown';
  /** Name from screen-map if the current fingerprint matches a known screen. */
  screenName?: string;
  /** Stable screen-map id of the current screen (for name binding / edges). */
  screenMapId?: string;
  /** true when the compact element summary is byte-identical to the previous cycle. */
  elementsUnchanged: boolean;
  /** true when no screenshot was captured this cycle (policy=never, or auto + unchanged). */
  screenshotSkipped: boolean;
}

export type ScreenshotPolicy = 'auto' | 'always' | 'never';

interface ObservationOpts {
  /** 'always' (kickoff default), 'auto' (cycle default — skip when the element
   *  summary is unchanged), or 'never'. */
  screenshotPolicy?: ScreenshotPolicy;
  prevSummary?: string;
  prevFingerprint?: string;
}

async function captureObservation(browser: Browser, opts?: ObservationOpts): Promise<CapturedObservation> {
  const state = requireActive();
  const policy: ScreenshotPolicy = opts?.screenshotPolicy ?? 'always';

  // Device dims are static per session — fetch once, reuse from state.
  let dims = state.deviceDims ?? '';
  if (!dims) {
    try {
      const r = await browser.getWindowRect();
      dims = `${r.width}x${r.height}px`;
      state.deviceDims = dims;
    } catch { /* */ }
  }

  let summary = '';
  let fingerprint = '';
  let screenName: string | undefined;
  let screenMapId: string | undefined;
  let context: CapturedObservation['context'] = 'unknown';

  try {
    const ctxInfo = await getCurrentContext();
    context = normalizeAppiumContext(ctxInfo);
  } catch { /* */ }

  // Element summary + screen-map fingerprint come from the Flutter tree, or —
  // inside a webview — from a DOM interactive-element scan. Elements first,
  // screenshot second: the element list is the cheap change-detector that lets
  // us skip the expensive capture+encode when nothing moved.
  // NOTE: with the FlutterIntegration driver the AMBIENT Appium context is
  // NATIVE_APP even though the app is a Flutter host — the VM-backed tree works
  // regardless.
  if (context !== 'webview') {
    try {
      const tree = await buildWidgetTree({ interactiveOnly: true });
      const head = formatElementsSummaryLine(tree.interactiveElements);
      const keys = summarizeValueKeys(tree.interactiveElements);
      const compact = formatElementsCompact(tree.interactiveElements.slice(0, 25));
      summary = [head, keys, compact].filter(Boolean).join('\n');

      const elFingerprint = generateFingerprint(tree.interactiveElements);
      if (elFingerprint) fingerprint = elFingerprint;

      // Best-effort: register the screen (structural identity), capture its name.
      try {
        const entry = recordScreen(state.appId, tree.interactiveElements);
        if (entry) {
          screenName = entry.name;
          screenMapId = entry.screenId;
        }
      } catch { /* screen-map is non-critical */ }
    } catch (e) {
      logger.debug('Agentic: widget tree unavailable for observation', { error: String(e) });
    }
  } else {
    // Webview: DOM scan gives the same change-detection + element summary the
    // Flutter tree gives elsewhere — without it, every webview cycle was blind
    // (no elements, no elementsUnchanged, screenshot every time).
    try {
      const ctxId = await getCurrentContext();
      const els = await scanWebViewInteractiveElements(ctxId, 0, { timeoutMs: 4000 });
      if (els.length > 0) {
        const head = `${formatElementsSummaryLine(els)} [webview ${ctxId}]`;
        const compact = formatElementsCompact(els.slice(0, 25));
        summary = [head, compact].join('\n');
        const elFingerprint = generateFingerprint(els);
        if (elFingerprint) fingerprint = elFingerprint;
        try {
          const entry = recordScreen(state.appId, els);
          if (entry) {
            screenName = entry.name;
            screenMapId = entry.screenId;
          }
        } catch { /* screen-map is non-critical */ }
      }
    } catch (e) {
      logger.debug('Agentic: webview element scan unavailable for observation', { error: String(e) });
    }
  }

  // Content-change detection uses the FULL compact summary (includes text labels),
  // not just the structural fingerprint — so a date flip or list refresh still
  // counts as changed even when the widget structure is identical.
  const comparable = summary.length > 0 && typeof opts?.prevSummary === 'string';
  const elementsUnchanged = comparable && summary === opts!.prevSummary;

  let capture: boolean;
  switch (policy) {
    case 'always': capture = true; break;
    case 'never': capture = false; break;
    default: capture = !elementsUnchanged; // 'auto' — also captures when summary is unavailable
  }

  let base64 = '';
  let mimeType: CapturedObservation['mimeType'] = 'image/jpeg';
  let fileName = '';
  if (capture) {
    const shot = await captureScreenshot(browser, LLM_SCREENSHOT_OPTS);
    base64 = shot.base64;
    mimeType = shot.mimeType;
    const saver = makeScreenshotSaver(state.shotsDir);
    const idx = nextScreenshotIndex();
    fileName = saver(`run`, idx, shot.base64, shot.mimeType);
    if (!fingerprint) fingerprint = sha1(shot.base64).slice(0, 16);
  } else if (!fingerprint) {
    // No tree AND no screenshot — carry the previous fingerprint so the streak
    // logic doesn't misread "unknown" as "changed".
    fingerprint = opts?.prevFingerprint ?? '';
  }

  return {
    base64, mimeType,
    dims, fileName, fingerprint, summary, context, screenName, screenMapId,
    elementsUnchanged,
    screenshotSkipped: !capture,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function describeDelta(prev?: string, next?: string): string | undefined {
  if (!prev || !next) return undefined;
  const pHead = prev.split('\n', 1)[0] || '';
  const nHead = next.split('\n', 1)[0] || '';
  if (!pHead || !nHead || pHead === nHead) return undefined;
  return `${pHead} → ${nHead}`;
}

function phaseRank(p: AgenticPhase): number {
  return ['GROUND', 'PLAN', 'EXPLORE_EXECUTE', 'VERIFY', 'FINISH'].indexOf(p);
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

function formatRunId(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function sanitizeRecordingName(goal: string): string {
  return goal.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'agentic_run';
}

function inferPlatformFromConfig(config: ReturnType<typeof loadConfig>): string {
  return config.platform === 'android' ? 'android' : 'ios';
}

function lastRecordedActionCount(state: AgenticRunState): number | undefined {
  for (let i = state.events.length - 1; i >= 0; i--) {
    const v = state.events[i].recordingActionsAtReport;
    if (typeof v === 'number') return v;
  }
  return undefined;
}

function preferredFlowId(state: AgenticRunState): string {
  // Prefer the inventory-derived id when this run augments a known test;
  // otherwise derive a fresh slug from the goal.
  if (state.inventoryHit?.flowId) return state.inventoryHit.flowId;
  return flowIdFromGoal(state.goal);
}

function recordingToFlowSteps(recording: Recording, state: AgenticRunState): FlowStep[] {
  const steps: FlowStep[] = [];
  for (const a of recording.actions) {
    if (a.type === 'screenshot') continue;
    const step: FlowStep = {
      action: a.type,
      context: normalizeContext(a.context),
      screenName: state.lastScreenName,
      screenFingerprint: state.lastScreenFingerprint,
    };
    const by = a.params['by'];
    const target = a.params['target'] ?? a.params['value'];
    const text = a.params['text'];
    if (typeof by === 'string') step.by = by;
    if (typeof target === 'string' || typeof target === 'number') step.target = String(target);
    if (typeof text === 'string') step.text = text;
    if (a.description) step.note = a.description;
    steps.push(step);
  }
  return steps;
}

function normalizeContext(c: RecordedAction['context']): FlowStep['context'] {
  if (c === 'flutter' || c === 'webview' || c === 'native') return c;
  return 'unknown';
}

function normalizeAppiumContext(raw: string): 'flutter' | 'webview' | 'native' | 'unknown' {
  if (!raw) return 'unknown';
  const upper = raw.toUpperCase();
  if (upper === 'FLUTTER') return 'flutter';
  if (upper.startsWith('WEBVIEW')) return 'webview';
  if (upper === 'NATIVE_APP') return 'native';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Maven compile + test run — verification steps after export
// ---------------------------------------------------------------------------

/**
 * Runs the generated test class via `mvn clean test`.
 * Returns pass/fail + truncated output so the agent can decide whether to
 * use MCP live inspection to diagnose failures.
 */
function mavenRunTest(
  projectPath: string,
  testClassName: string,
): { ok: boolean; output: string; failures: string[] } {
  try {
    const { execSync } = require('child_process') as typeof import('child_process');
    const out = execSync(`mvn clean test -Dtest="${testClassName}"`, {
      cwd: projectPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, output: out || '', failures: [] };
  } catch (e: any) {
    const stdout = typeof e?.stdout === 'string' ? e.stdout : '';
    const stderr = typeof e?.stderr === 'string' ? e.stderr : '';
    const combined = `${stdout}\n${stderr}`.trim() || String(e);
    // Extract failure lines for quick scanning
    const failures = combined
      .split('\n')
      .filter(l => l.includes('FAILED') || l.includes('AssertionError') || l.includes('Cause:'))
      .slice(0, 10);
    return { ok: false, output: combined, failures };
  }
}

function mavenCompile(projectPath: string): { ok: boolean; output: string } {
  try {
    const { execSync } = require('child_process') as typeof import('child_process');
    const out = execSync('mvn -q -DskipTests compile', {
      cwd: projectPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, output: out || '' };
  } catch (e: any) {
    const stdout = typeof e?.stdout === 'string' ? e.stdout : '';
    const stderr = typeof e?.stderr === 'string' ? e.stderr : '';
    return { ok: false, output: `${stdout}\n${stderr}`.trim() || String(e) };
  }
}

function firstCompileError(output: string): string | undefined {
  const m = output.match(/\[ERROR\][^\n]*/);
  return m ? m[0] : undefined;
}

// ---------------------------------------------------------------------------
// Report writer — small HTML + JSON snapshot under runs/agentic/<runId>/
// ---------------------------------------------------------------------------

interface ReportArgs {
  recording?: Recording;
  generated?: ReturnType<typeof generateTestScript>;
  exportResult?: ReturnType<typeof exportToProject>;
  compileResult?: { ok: boolean; output: string };
  flow?: FlowRecord;
  inventory?: InventoryEntry;
  pitfall?: PitfallEntry;
  verdict: 'pass' | 'fail' | 'abort';
  summary: string;
}

function writeAgenticReport(state: AgenticRunState, args: ReportArgs): { reportJson: string; reportHtml: string } {
  const finishedAt = new Date().toISOString();
  const report = {
    runId: state.runId,
    appId: state.appId,
    goal: state.goal,
    startedAt: state.startedAt,
    finishedAt,
    verdict: args.verdict,
    summary: args.summary,
    stopReason: state.stopReason,
    steps: state.stepCount,
    maxSteps: state.maxSteps,
    events: state.events,
    recalled: {
      flows: state.recalledFlows.map(f => ({ id: f.flow.id, score: f.score, matched: f.matchedTokens })),
      pitfalls: state.recalledPitfalls.map(p => ({ summary: p.summary, occurrences: p.occurrences })),
      inventoryHit: state.inventoryHit
        ? { testClassName: state.inventoryHit.testClassName, filePath: state.inventoryHit.filePath }
        : undefined,
    },
    recording: args.recording
      ? { id: args.recording.id, actions: args.recording.actions.length }
      : undefined,
    export: args.exportResult
      ? { success: args.exportResult.success, summary: args.exportResult.summary }
      : undefined,
    compile: args.compileResult
      ? { ok: args.compileResult.ok, firstError: firstCompileError(args.compileResult.output) }
      : undefined,
    flow: args.flow ? { id: args.flow.id, successCount: args.flow.successCount } : undefined,
    inventory: args.inventory,
    pitfall: args.pitfall,
  };

  const reportJson = join(state.runDir, 'report.json');
  writeFileSync(reportJson, JSON.stringify(report, null, 2));
  const reportHtml = join(state.runDir, 'index.html');
  writeFileSync(reportHtml, renderHtmlReport(report, state));
  return { reportJson, reportHtml };
}

function renderHtmlReport(report: any, state: AgenticRunState): string {
  const verdictColor = report.verdict === 'pass' ? '#1b8e3a'
    : report.verdict === 'abort' ? '#7a5b00' : '#c1342f';
  const events = (state.events as AgenticStepEvent[]).map(e => `
    <tr>
      <td>${e.index}</td>
      <td>${e.phase}</td>
      <td>${e.status}</td>
      <td>${e.screenName || ''}</td>
      <td>${e.screenChanged === true ? 'Δ' : e.screenChanged === false ? '—' : ''}</td>
      <td>${escapeHtml(e.observation)}</td>
      <td>${e.screenshotFile ? `<a href="screenshots/${e.screenshotFile}" target="_blank">img</a>` : ''}</td>
    </tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Agentic run ${escapeHtml(state.runId)}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:24px;color:#222}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border:1px solid #eee;padding:4px 8px;vertical-align:top}
.badge{padding:2px 8px;border-radius:4px;color:#fff;font-weight:600;font-size:12px}
</style></head><body>
<h1>Agentic run ${escapeHtml(state.runId)}</h1>
<p><strong>Goal:</strong> ${escapeHtml(state.goal)}</p>
<p><strong>Verdict:</strong> <span class="badge" style="background:${verdictColor}">${report.verdict.toUpperCase()}</span>
   · <strong>Stop:</strong> ${escapeHtml(report.stopReason || '')}
   · <strong>Steps:</strong> ${report.steps}/${report.maxSteps}</p>
<p><strong>Summary:</strong> ${escapeHtml(report.summary)}</p>
${report.export ? `<p><strong>Export:</strong> ${report.export.success ? 'success' : 'failed'} — ${escapeHtml(report.export.summary || '')}</p>` : ''}
${report.compile ? `<p><strong>mvn compile:</strong> ${report.compile.ok ? 'ok' : 'failed'} ${report.compile.firstError ? `· ${escapeHtml(report.compile.firstError)}` : ''}</p>` : ''}
${report.flow ? `<p><strong>Flow:</strong> ${escapeHtml(report.flow.id)} (successCount ${report.flow.successCount})</p>` : ''}
${report.inventory ? `<p><strong>Generated test:</strong> <code>${escapeHtml(report.inventory.testClassName)}</code> → ${escapeHtml(report.inventory.filePath)}</p>` : ''}
${report.pitfall ? `<p><strong>Pitfall recorded:</strong> [${escapeHtml(report.pitfall.failureKind)}] ${escapeHtml(report.pitfall.summary)}</p>` : ''}
<h2>Events</h2>
<table><thead><tr><th>#</th><th>Phase</th><th>Status</th><th>Screen</th><th>Δ</th><th>Observation</th><th>Shot</th></tr></thead><tbody>${events}</tbody></table>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

// re-export for handlers
export type { FlowMatch, FlowRecord, FlowStep, PitfallEntry, InventoryEntry, AgenticRunState };

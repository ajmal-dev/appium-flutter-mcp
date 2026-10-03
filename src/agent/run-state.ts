/**
 * Server-side state for an active agentic_create_test run.
 *
 * Singleton run-state pattern. Claude (the caller) drives
 * the loop; this module remembers what's happening, tracks stop conditions,
 * and gives the orchestrator the data it needs to render the next contract
 * cycle and to commit a flow record / pitfall at the end.
 */

import type { FlowMatch } from '../world/flow-store.js';
import type { PitfallEntry } from '../world/pitfall-store.js';
import type { InventoryEntry } from '../world/test-inventory.js';

export type AgenticPhase =
  | 'GROUND'
  | 'PLAN'
  | 'EXPLORE_EXECUTE'
  | 'VERIFY'
  | 'FINISH';

export type StopReason =
  | 'success'
  | 'step_budget'
  | 'no_progress'
  | 'aborted'
  | 'failed';

export interface AgenticStepEvent {
  index: number;
  at: string;
  phase: AgenticPhase;
  status: 'ok' | 'stuck' | 'progress' | 'note';
  observation: string;
  screenshotFile?: string;
  screenFingerprint?: string;
  screenName?: string;
  context?: 'flutter' | 'webview' | 'native' | 'unknown';
  screenChanged?: boolean;
  recordingActionsAtReport?: number;
}

export interface AgenticRunState {
  runId: string;
  startedAt: string;
  goal: string;
  tags: string[];
  appId: string;

  /** Where Java tests get exported. */
  projectPath?: string;
  /** Override for test class / method / package, if provided. */
  testClassName?: string;
  testMethodName?: string;
  packageName?: string;

  maxSteps: number;
  exportOnSuccess: boolean;
  verifyWithMaven: boolean;
  /** After compile succeeds, run `mvn clean test -Dtest=<ClassName>` and return results. */
  runTestAfterExport: boolean;

  runDir: string;
  shotsDir: string;

  phase: AgenticPhase;
  stepCount: number;
  screenshotCount: number;
  noProgressStreak: number;
  events: AgenticStepEvent[];

  lastScreenFingerprint?: string;
  lastElementSummary?: string;
  lastContext?: 'flutter' | 'webview' | 'native' | 'unknown';
  lastScreenshotFile?: string;
  lastScreenName?: string;
  /** Cached device viewport ("1180x820px") — static per session, avoids a
   *  getWindowRect round trip on every cycle. */
  deviceDims?: string;

  /** Recall hits surfaced at start. Kept for the final report. */
  recalledFlows: FlowMatch[];
  recalledPitfalls: PitfallEntry[];
  /** Existing inventory entry that matches the goal — set when this is an
   *  augmentation rather than a fresh test. */
  inventoryHit?: InventoryEntry;

  /** Set on finish — drives report formatting and flow-record writing. */
  stopReason?: StopReason;
  finishSummary?: string;

  /** Snapshot of the preflight checks from agentic_create_test. */
  preflight?: {
    appiumSession: { ok: true; platform: string; sessionId?: string };
    vmService: { ok: boolean; url?: string; reason?: string };
    app: { ok: boolean; bundleId?: string; state?: string; reason?: string };
    webviews: { id: string; url?: string; title?: string }[];
    warnings: string[];
  };
}

let active: AgenticRunState | null = null;

export function getActive(): AgenticRunState | null {
  return active;
}

export function requireActive(): AgenticRunState {
  if (!active) throw new Error('No active agentic run. Call agentic_create_test first.');
  return active;
}

export function setActive(state: AgenticRunState): void {
  active = state;
}

export function clearActive(): void {
  active = null;
}

export function nextScreenshotIndex(): number {
  const a = requireActive();
  return ++a.screenshotCount;
}

export function pushEvent(event: AgenticStepEvent): void {
  const a = requireActive();
  a.events.push(event);
}

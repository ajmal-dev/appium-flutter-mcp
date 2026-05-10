/**
 * Action Recorder — captures exploration actions for test script generation.
 *
 * Records taps, text input, gestures, context switches, element finds,
 * and assertions performed during a live exploration session.
 */

export interface RecordedAction {
  /** Monotonically increasing sequence number */
  seq: number;
  /** ISO timestamp */
  timestamp: string;
  /** Action category */
  type: 'tap' | 'type_text' | 'gesture' | 'switch_context' | 'find_elements'
      | 'wait' | 'assertion' | 'screenshot' | 'navigate_back' | 'launch_app'
      | 'webview_action' | 'native_inspect';
  /** Current app context when action was recorded */
  context: 'flutter' | 'webview' | 'native' | 'unknown';
  /** Action-specific payload */
  params: Record<string, unknown>;
  /** Optional description / annotation from the user or AI */
  description?: string;
  /** Screen elements visible at time of action (optional snapshot) */
  screenElements?: Array<{
    type: string;
    key?: string;
    text?: string;
    locator?: { by: string; value: string };
  }>;
}

export interface Recording {
  id: string;
  name: string;
  startedAt: string;
  stoppedAt?: string;
  platform: 'ios' | 'android' | 'unknown';
  actions: RecordedAction[];
  /** User-provided metadata */
  metadata: {
    description?: string;
  };
}

// ── Singleton state ──────────────────────────────────────────────────────────

let activeRecording: Recording | null = null;
let lastRecording: Recording | null = null;
let actionSeq = 0;

export function isRecording(): boolean {
  return activeRecording !== null;
}

export function getActiveRecording(): Recording | null {
  return activeRecording;
}

/** Get the last completed recording (available after stop_recording) */
export function getLastRecording(): Recording | null {
  return lastRecording;
}

export function startRecording(name: string, platform: string, metadata?: Recording['metadata']): Recording {
  if (activeRecording) {
    throw new Error(`Recording "${activeRecording.name}" is already in progress. Stop it first.`);
  }
  actionSeq = 0;
  activeRecording = {
    id: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    startedAt: new Date().toISOString(),
    platform: (platform === 'ios' || platform === 'android') ? platform : 'unknown',
    actions: [],
    metadata: metadata ?? {},
  };
  return activeRecording;
}

export function stopRecording(): Recording {
  if (!activeRecording) {
    throw new Error('No recording is in progress.');
  }
  activeRecording.stoppedAt = new Date().toISOString();
  const finished = { ...activeRecording };
  lastRecording = finished;
  activeRecording = null;
  return finished;
}

export function recordAction(
  type: RecordedAction['type'],
  params: Record<string, unknown>,
  context?: string,
  description?: string,
  screenElements?: RecordedAction['screenElements'],
): void {
  if (!activeRecording) return; // silently skip if not recording

  const ctx = (context === 'flutter' || context === 'webview' || context === 'native')
    ? context : 'unknown';

  activeRecording.actions.push({
    seq: ++actionSeq,
    timestamp: new Date().toISOString(),
    type,
    context: ctx,
    params,
    description,
    screenElements,
  });
}

/** Add a user-annotated assertion to the recording */
export function recordAssertion(
  assertionType: 'assertTrue' | 'assertFalse' | 'assertEquals' | 'assertNotNull' | 'assertVisible',
  params: Record<string, unknown>,
  context?: string,
  description?: string,
): void {
  recordAction('assertion', { assertionType, ...params }, context, description);
}

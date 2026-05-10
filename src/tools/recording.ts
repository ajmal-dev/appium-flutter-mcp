/**
 * MCP tool handlers for action recording.
 *
 * Tools:
 *  - start_recording   — begin capturing actions
 *  - stop_recording    — stop and return the recording (raw JSON action log)
 *  - add_assertion     — insert an assertion marker into the recording
 *  - get_recording     — peek at the current recording state
 *
 * The recorded JSON can be fed to your test framework of choice — this MCP
 * intentionally does not emit framework-specific code so it stays neutral.
 */

import { z } from 'zod';
import {
  startRecording, stopRecording, isRecording,
  getActiveRecording, recordAssertion,
} from '../recording/recorder.js';
import { getSessionInfo } from '../appium/session.js';
import type { McpToolResponse } from '../types.js';

// ── Schemas ──────────────────────────────────────────────────────────────────

export const startRecordingSchema = z.object({
  name: z.string().describe('Name for this recording session (e.g., "login_flow", "checkout")'),
  description: z.string().optional()
    .describe('Free-form description stored alongside the recording.'),
});

export const stopRecordingSchema = z.object({});

export const addAssertionSchema = z.object({
  type: z.enum(['assertTrue', 'assertFalse', 'assertEquals', 'assertNotNull', 'assertVisible'])
    .describe('Assertion type'),
  target: z.string().optional()
    .describe('Element locator value (for assertVisible)'),
  by: z.enum(['key', 'text', 'type']).optional().default('key')
    .describe('Locator strategy for assertVisible'),
  message: z.string().optional()
    .describe('Assertion failure message'),
  condition: z.string().optional()
    .describe('Boolean expression for assertTrue/assertFalse'),
  actual: z.string().optional()
    .describe('Actual value for assertEquals'),
  expected: z.string().optional()
    .describe('Expected value for assertEquals'),
  value: z.string().optional()
    .describe('Value expression for assertNotNull'),
});

export const getRecordingSchema = z.object({});

// ── Handlers ─────────────────────────────────────────────────────────────────

export async function handleStartRecording(
  params: z.infer<typeof startRecordingSchema>,
): Promise<McpToolResponse> {
  try {
    // Get platform from active session
    let platform = 'unknown';
    try {
      const session = getSessionInfo();
      platform = session.platform || 'unknown';
    } catch { /* no active session yet */ }

    const recording = startRecording(params.name, platform, {
      description: params.description,
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'recording_started',
          id: recording.id,
          name: recording.name,
          platform: recording.platform,
          message: 'Recording started. All tap, type_text, gesture, switch_context actions will be captured. Use "stop_recording" when done.',
        }, null, 2),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: true, message: String(error) }),
      }],
    };
  }
}

export async function handleStopRecording(
  _params: z.infer<typeof stopRecordingSchema>,
): Promise<McpToolResponse> {
  try {
    const recording = stopRecording();

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'recording_stopped',
          id: recording.id,
          name: recording.name,
          actionsRecorded: recording.actions.length,
          duration: recording.stoppedAt && recording.startedAt
            ? `${((new Date(recording.stoppedAt).getTime() - new Date(recording.startedAt).getTime()) / 1000).toFixed(0)}s`
            : 'unknown',
          actions: recording.actions.map(a => ({
            seq: a.seq,
            type: a.type,
            context: a.context,
            target: a.params.target || a.params.value || '',
            by: a.params.by || '',
            description: a.description || describeAction(a),
          })),
          message: 'Recording stopped. The raw action log above can be saved or transformed into your test framework of choice.',
        }, null, 2),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: true, message: String(error) }),
      }],
    };
  }
}

export async function handleAddAssertion(
  params: z.infer<typeof addAssertionSchema>,
): Promise<McpToolResponse> {
  if (!isRecording()) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: true, message: 'No recording in progress. Start one with start_recording first.' }),
      }],
    };
  }

  // Determine context from current session
  let context = 'unknown';
  try {
    const session = getSessionInfo();
    context = session.context || 'unknown';
  } catch { /* use unknown */ }

  recordAssertion(
    params.type as any,
    {
      target: params.target,
      by: params.by,
      message: params.message,
      condition: params.condition,
      actual: params.actual,
      expected: params.expected,
      value: params.value,
    },
    context,
    params.message,
  );

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        status: 'assertion_added',
        type: params.type,
        message: params.message || '',
        target: params.target || '',
      }),
    }],
  };
}

export async function handleGetRecording(
  _params: z.infer<typeof getRecordingSchema>,
): Promise<McpToolResponse> {
  const recording = getActiveRecording();

  if (!recording) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ recording: false, message: 'No active recording.' }),
      }],
    };
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        recording: true,
        id: recording.id,
        name: recording.name,
        platform: recording.platform,
        actionsCount: recording.actions.length,
        actions: recording.actions.map(a => ({
          seq: a.seq,
          type: a.type,
          context: a.context,
          target: a.params.target || a.params.value || '',
          by: a.params.by || '',
        })),
      }, null, 2),
    }],
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function describeAction(a: { type: string; params: Record<string, unknown> }): string {
  const target = a.params.target || a.params.value || '';
  const by = a.params.by || '';
  switch (a.type) {
    case 'tap': return `Tap ${by}="${target}"`;
    case 'type_text': return `Type into ${by}="${target}"`;
    case 'gesture': return `Gesture: ${a.params.action || ''}`;
    case 'switch_context': return `Switch to ${a.params.to || ''}`;
    case 'assertion': return `Assert: ${a.params.assertionType || ''}`;
    default: return a.type;
  }
}

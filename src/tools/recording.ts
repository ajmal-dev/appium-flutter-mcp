/**
 * MCP tool handlers for test recording & generation.
 *
 * Tools:
 *  - start_recording   — begin capturing actions
 *  - stop_recording    — stop and return the recording
 *  - add_assertion     — insert an assertion marker into the recording
 *  - generate_test     — convert recorded actions to ZMA Java test code
 *  - get_recording     — peek at the current recording state
 */

import { z } from 'zod';
import {
  startRecording, stopRecording, isRecording,
  getActiveRecording, getLastRecording, recordAssertion,
} from '../recording/recorder.js';
import { generateTestScript } from '../recording/test-generator.js';
import { scanProject } from '../project/scanner.js';
import { loadConfig } from '../util/config.js';
import { getSessionInfo } from '../appium/session.js';
import type { McpToolResponse } from '../types.js';

// ── Schemas ──────────────────────────────────────────────────────────────────

export const startRecordingSchema = z.object({
  name: z.string().describe('Name for this recording session (e.g., "login_flow", "appointment_booking")'),
  testClassName: z.string().optional()
    .describe('Java test class name to generate (e.g., "AppointmentBookingTests"). Auto-derived from name if omitted.'),
  testMethodName: z.string().optional()
    .describe('Java test method name (e.g., "testBookAppointment"). Auto-derived from name if omitted.'),
  testGroups: z.array(z.string()).optional()
    .describe('TestNG groups (e.g., ["Smoke", "E2E"]). Auto-inferred from actions if omitted.'),
  packageName: z.string().optional()
    .describe('Java package (default: com.zma.automation.tests)'),
  description: z.string().optional()
    .describe('Test description for the @Test annotation'),
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

export const generateTestSchema = z.object({
  testClassName: z.string().optional()
    .describe('Override class name for generation'),
  testMethodName: z.string().optional()
    .describe('Override method name for generation'),
  testGroups: z.array(z.string()).optional()
    .describe('Override TestNG groups'),
  packageName: z.string().optional()
    .describe('Override Java package'),
  description: z.string().optional()
    .describe('Override test description'),
  projectPath: z.string().optional()
    .describe('Path to the automation project root. Used to scan existing page objects for reuse. If omitted, uses AUTOMATION_PROJECT_PATH from config.'),
  export: z.boolean().optional().default(false)
    .describe('Write the generated test class and page objects directly into the automation project (reuses existing page objects). Equivalent to the old export_to_project tool.'),
  dryRun: z.boolean().optional().default(false)
    .describe('With export=true: only scan the project and show what would be done without writing files.'),
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
      testClassName: params.testClassName,
      testMethodName: params.testMethodName,
      testGroups: params.testGroups,
      packageName: params.packageName,
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
          message: `Recording started. All tap, type_text, gesture, switch_context actions will be captured. Use "stop_recording" when done, then "generate_test" to preview the Java test script, or "export_to_project" to generate and place files directly into your automation project.`,
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
          message: 'Recording stopped. Use "generate_test" to preview the script, or "export_to_project" to generate and place files directly into your automation project.',
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

export async function handleGenerateTest(
  params: z.infer<typeof generateTestSchema>,
): Promise<McpToolResponse> {
  // Export mode (absorbed export_to_project): generate AND write into the project
  if (params.export) {
    const { handleExportToProject } = await import('./export.js');
    return handleExportToProject({
      projectPath: params.projectPath,
      testClassName: params.testClassName,
      testMethodName: params.testMethodName,
      testGroups: params.testGroups,
      packageName: params.packageName,
      description: params.description,
      dryRun: params.dryRun ?? false,
    });
  }

  // Get active recording, or the last stopped recording
  let recording = getActiveRecording();

  // If there's an active recording, stop it first
  if (recording && !recording.stoppedAt) {
    recording = stopRecording();
  }

  // Fall back to last completed recording
  if (!recording) {
    recording = getLastRecording();
  }

  if (!recording) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: true,
          message: 'No recording available. Start a recording with start_recording, perform actions, then stop_recording before generating.',
        }),
      }],
    };
  }

  // Apply overrides
  if (params.testClassName) recording.metadata.testClassName = params.testClassName;
  if (params.testMethodName) recording.metadata.testMethodName = params.testMethodName;
  if (params.testGroups) recording.metadata.testGroups = params.testGroups;
  if (params.packageName) recording.metadata.packageName = params.packageName;
  if (params.description) recording.metadata.description = params.description;

  try {
    // Scan project for existing page objects to reuse
    const config = loadConfig();
    const projectPath = params.projectPath || config.automationProjectPath;
    let existingPages: import('../project/scanner.js').ExistingPageObject[] | undefined;
    if (projectPath) {
      try {
        const project = scanProject(projectPath);
        existingPages = project.pageObjects;
      } catch { /* scan failed, generate without reuse */ }
    }

    const result = generateTestScript(recording, existingPages);

    // Build combined output
    const output: string[] = [];
    output.push(result.summary);
    output.push('');
    output.push('---');
    output.push('');
    output.push(`### ${result.testClass.fileName}`);
    output.push(`**Path**: \`${result.testClass.filePath}\``);
    output.push('```java');
    output.push(result.testClass.content);
    output.push('```');

    for (const po of result.pageObjects) {
      output.push('');
      output.push(`### ${po.fileName}`);
      output.push(`**Path**: \`${po.filePath}\``);
      output.push('```java');
      output.push(po.content);
      output.push('```');
    }

    return {
      content: [{
        type: 'text',
        text: output.join('\n'),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: true, message: `Generation failed: ${String(error)}` }),
      }],
    };
  }
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

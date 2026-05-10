/**
 * MCP tool handlers for Visual AI Test Oracle.
 */

import { z } from 'zod';
import { getActiveRecording, getLastRecording } from '../recording/recorder.js';
import { saveBaseline, listBaselines } from '../visual/baseline.js';
import { compareWithBaseline, runVisualRegression } from '../visual/comparator.js';
import type { VisualBaseline, VisualStep } from '../visual/diff.js';
import type { McpToolResponse } from '../types.js';

export const saveBaselineSchema = z.object({
  recordingId: z.string().optional()
    .describe('Recording ID to save as baseline. Uses last recording if omitted.'),
});

export const compareBaselineSchema = z.object({
  recordingId: z.string().describe('Baseline recording ID to compare against'),
  step: z.number().optional().default(1)
    .describe('Step number to compare (default: 1)'),
});

export const visualRegressionSchema = z.object({
  recordingId: z.string().describe('Baseline recording ID to run regression against'),
});

export async function handleSaveBaseline(
  params: z.infer<typeof saveBaselineSchema>,
): Promise<McpToolResponse> {
  // Get recording (active or last)
  const recording = getActiveRecording() || getLastRecording();
  if (!recording) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: true, message: 'No recording available. Record a session first.' }),
      }],
    };
  }

  // Build baseline from recording actions
  const steps: VisualStep[] = recording.actions
    .filter(a => a.params.baselineScreenshot)
    .map((a, i) => ({
      seq: i + 1,
      actionType: a.type,
      description: a.description || `${a.type} ${a.params.target || ''}`,
      screenshot: a.params.baselineScreenshot as string,
      timestamp: a.timestamp,
      interactiveElements: a.screenElements?.map(el => ({
        type: el.type,
        text: el.text,
        locator: el.locator || { by: 'type', value: el.type },
        position: undefined,
      })),
    }));

  if (steps.length === 0) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: true,
          message: 'No screenshots captured in recording. Re-record with screenshot=true to capture baseline images.',
        }),
      }],
    };
  }

  const baseline: VisualBaseline = {
    recordingId: params.recordingId || recording.id,
    recordingName: recording.name,
    platform: recording.platform,
    createdAt: new Date().toISOString(),
    steps,
  };

  const dir = saveBaseline(baseline);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        status: 'baseline_saved',
        recordingId: baseline.recordingId,
        name: baseline.recordingName,
        steps: steps.length,
        directory: dir,
      }, null, 2),
    }],
  };
}

export async function handleCompareBaseline(
  params: z.infer<typeof compareBaselineSchema>,
): Promise<McpToolResponse> {
  try {
    const diff = await compareWithBaseline(params.recordingId, params.step);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          comparison: diff,
          message: diff.status === 'pass'
            ? 'Screen matches baseline'
            : `${diff.structuralChanges.length} change(s) detected`,
        }, null, 2),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: true, message: `Comparison failed: ${String(error)}` }),
      }],
    };
  }
}

export async function handleVisualRegression(
  params: z.infer<typeof visualRegressionSchema>,
): Promise<McpToolResponse> {
  try {
    const report = await runVisualRegression(params.recordingId);

    const baselines = listBaselines();

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          report,
          availableBaselines: baselines,
          message: report.failed > 0
            ? `REGRESSION DETECTED: ${report.failed} step(s) failed`
            : report.warnings > 0
              ? `${report.warnings} warning(s), ${report.passed} passed`
              : `All ${report.passed} step(s) passed`,
        }, null, 2),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: true, message: `Regression report failed: ${String(error)}` }),
      }],
    };
  }
}

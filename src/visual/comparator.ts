/**
 * Visual Comparator — compares current screen state against baselines.
 * Uses structural comparison (fast, local) as the primary method.
 */

import { getBrowserWithReconnect } from '../appium/session.js';
import { captureScreenshot } from '../util/screenshot.js';
import { buildWidgetTree } from '../tree/tree-builder.js';
import { loadBaseline, getBaselineStep } from './baseline.js';
import { logger } from '../util/logger.js';
import type { VisualStep, VisualDiff, StructuralChange, VisualReport } from './diff.js';

/**
 * Compare current screen against a specific baseline step.
 * Returns structural diff (fast, no AI needed).
 */
export async function compareWithBaseline(
  recordingId: string,
  stepSeq: number,
): Promise<VisualDiff> {
  const baselineStep = getBaselineStep(recordingId, stepSeq);
  if (!baselineStep) {
    return {
      step: stepSeq,
      status: 'fail',
      structuralChanges: [{
        type: 'count_changed',
        details: `No baseline found for recording "${recordingId}" step ${stepSeq}`,
        severity: 'high',
      }],
      confidence: 0,
      summary: 'Baseline not found',
    };
  }

  // Get current screen state
  const browser = await getBrowserWithReconnect();
  const currentScreenshot = await captureScreenshot(browser, { maxWidth: 800, quality: 75 });

  let currentElements: VisualStep['interactiveElements'] = [];
  try {
    const tree = await buildWidgetTree({ interactiveOnly: true });
    currentElements = tree.interactiveElements.map(el => ({
      type: el.type,
      text: el.text,
      locator: el.locator,
      position: el.position ? {
        x: Number(el.position.x),
        y: Number(el.position.y),
        width: Number(el.position.width),
        height: Number(el.position.height),
      } : undefined,
    }));
  } catch {
    logger.warn('Could not get current widget tree for comparison');
  }

  // Structural comparison
  const changes = structuralCompare(
    baselineStep.interactiveElements || [],
    currentElements || [],
  );

  // Determine status
  const highSeverity = changes.filter(c => c.severity === 'high').length;
  const medSeverity = changes.filter(c => c.severity === 'medium').length;

  let status: VisualDiff['status'] = 'pass';
  if (highSeverity > 0) status = 'fail';
  else if (medSeverity > 0) status = 'warning';

  const confidence = changes.length === 0 ? 1.0 : Math.max(0, 1 - (highSeverity * 0.3 + medSeverity * 0.1));

  const summary = changes.length === 0
    ? 'Screen matches baseline'
    : `${changes.length} structural change(s) detected: ${highSeverity} high, ${medSeverity} medium severity`;

  return {
    step: stepSeq,
    status,
    structuralChanges: changes,
    confidence,
    summary,
  };
}

/**
 * Run visual regression across all steps in a baseline.
 */
export async function runVisualRegression(recordingId: string): Promise<VisualReport> {
  const baseline = loadBaseline(recordingId);
  if (!baseline) {
    return {
      baselineId: recordingId,
      baselineName: 'unknown',
      timestamp: new Date().toISOString(),
      totalSteps: 0,
      passed: 0,
      warnings: 0,
      failed: 1,
      diffs: [{
        step: 0,
        status: 'fail',
        structuralChanges: [{
          type: 'count_changed',
          details: `Baseline "${recordingId}" not found`,
          severity: 'high',
        }],
        confidence: 0,
        summary: 'Baseline not found',
      }],
    };
  }

  // Note: This compares current screen state against each baseline step.
  // In a real replay scenario, you'd execute each recorded action and compare after.
  // For now, it compares the current screen against step 1 (or last step) as a spot check.
  const diffs: VisualDiff[] = [];
  const lastStep = baseline.steps[baseline.steps.length - 1];

  if (lastStep) {
    const diff = await compareWithBaseline(recordingId, lastStep.seq);
    diffs.push(diff);
  }

  const passed = diffs.filter(d => d.status === 'pass').length;
  const warnings = diffs.filter(d => d.status === 'warning').length;
  const failed = diffs.filter(d => d.status === 'fail').length;

  return {
    baselineId: baseline.recordingId,
    baselineName: baseline.recordingName,
    timestamp: new Date().toISOString(),
    totalSteps: diffs.length,
    passed,
    warnings,
    failed,
    diffs,
  };
}

/** Compare two sets of interactive elements structurally */
function structuralCompare(
  baseline: NonNullable<VisualStep['interactiveElements']>,
  current: NonNullable<VisualStep['interactiveElements']>,
): StructuralChange[] {
  const changes: StructuralChange[] = [];

  // Element count change
  if (baseline.length !== current.length) {
    changes.push({
      type: 'count_changed',
      details: `Element count changed: ${baseline.length} → ${current.length}`,
      severity: Math.abs(baseline.length - current.length) > 3 ? 'high' : 'medium',
    });
  }

  // Build maps by locator for matching
  const baselineMap = new Map<string, typeof baseline[0]>();
  for (const el of baseline) {
    baselineMap.set(`${el.locator.by}:${el.locator.value}`, el);
  }

  const currentMap = new Map<string, typeof current[0]>();
  for (const el of current) {
    currentMap.set(`${el.locator.by}:${el.locator.value}`, el);
  }

  // Find missing elements (in baseline but not in current)
  for (const [key, bEl] of baselineMap) {
    if (!currentMap.has(key)) {
      changes.push({
        type: 'element_missing',
        element: `${bEl.type} (${key})`,
        details: `Element "${bEl.text || bEl.type}" not found in current screen`,
        severity: 'high',
      });
    }
  }

  // Find added elements (in current but not in baseline)
  for (const [key, cEl] of currentMap) {
    if (!baselineMap.has(key)) {
      changes.push({
        type: 'element_added',
        element: `${cEl.type} (${key})`,
        details: `New element "${cEl.text || cEl.type}" found on current screen`,
        severity: 'low',
      });
    }
  }

  // Compare matching elements for text changes and position shifts
  for (const [key, bEl] of baselineMap) {
    const cEl = currentMap.get(key);
    if (!cEl) continue;

    // Text change
    if (bEl.text && cEl.text && bEl.text !== cEl.text) {
      changes.push({
        type: 'text_changed',
        element: `${bEl.type} (${key})`,
        details: `Text changed: "${bEl.text}" → "${cEl.text}"`,
        severity: 'medium',
      });
    }

    // Position shift (if both have positions)
    if (bEl.position && cEl.position) {
      const dx = Math.abs(bEl.position.x - cEl.position.x);
      const dy = Math.abs(bEl.position.y - cEl.position.y);
      if (dx > 50 || dy > 50) {
        changes.push({
          type: 'element_moved',
          element: `${bEl.type} (${key})`,
          details: `Moved by (${dx}px, ${dy}px)`,
          severity: dx > 100 || dy > 100 ? 'high' : 'medium',
        });
      }
    }
  }

  return changes;
}

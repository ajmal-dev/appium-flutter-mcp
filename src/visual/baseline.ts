/**
 * Visual Baseline Manager — stores and retrieves golden baseline screenshots.
 * Baselines are saved to ~/.appium-flutter-mcp/baselines/<recordingId>/
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../util/logger.js';
import type { VisualBaseline, VisualStep } from './diff.js';

const BASELINES_DIR = join(homedir(), '.appium-flutter-mcp', 'baselines');

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Save a baseline to disk */
export function saveBaseline(baseline: VisualBaseline): string {
  ensureDir(BASELINES_DIR);
  const dir = join(BASELINES_DIR, baseline.recordingId);
  ensureDir(dir);

  // Save metadata (without screenshot data to keep JSON small)
  const metadata = {
    ...baseline,
    steps: baseline.steps.map(s => ({
      ...s,
      screenshot: `step_${String(s.seq).padStart(3, '0')}.jpg`,
    })),
  };
  writeFileSync(join(dir, 'baseline.json'), JSON.stringify(metadata, null, 2));

  // Save screenshots as separate files
  for (const step of baseline.steps) {
    const imgPath = join(dir, `step_${String(step.seq).padStart(3, '0')}.jpg`);
    writeFileSync(imgPath, Buffer.from(step.screenshot, 'base64'));
  }

  logger.info('Baseline saved', { id: baseline.recordingId, steps: baseline.steps.length, dir });
  return dir;
}

/** Load a baseline from disk */
export function loadBaseline(recordingId: string): VisualBaseline | null {
  const dir = join(BASELINES_DIR, recordingId);
  const metaPath = join(dir, 'baseline.json');

  if (!existsSync(metaPath)) return null;

  try {
    const metadata = JSON.parse(readFileSync(metaPath, 'utf-8'));

    // Reload screenshots
    const steps: VisualStep[] = metadata.steps.map((s: any) => {
      const imgPath = join(dir, s.screenshot);
      let screenshot = '';
      if (existsSync(imgPath)) {
        screenshot = readFileSync(imgPath).toString('base64');
      }
      return { ...s, screenshot };
    });

    return { ...metadata, steps };
  } catch (error) {
    logger.warn('Failed to load baseline', { recordingId, error: String(error) });
    return null;
  }
}

/** List all saved baselines (metadata only, no screenshots) */
export function listBaselines(): Array<{ id: string; name: string; createdAt: string; stepCount: number }> {
  ensureDir(BASELINES_DIR);
  const results: Array<{ id: string; name: string; createdAt: string; stepCount: number }> = [];

  try {
    const dirs = readdirSync(BASELINES_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const dir of dirs) {
      const metaPath = join(BASELINES_DIR, dir, 'baseline.json');
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
          results.push({
            id: meta.recordingId,
            name: meta.recordingName,
            createdAt: meta.createdAt,
            stepCount: meta.steps?.length || 0,
          });
        } catch { /* skip malformed */ }
      }
    }
  } catch { /* baselines dir doesn't exist yet */ }

  return results;
}

/** Get a specific step's baseline screenshot */
export function getBaselineStep(recordingId: string, stepSeq: number): VisualStep | null {
  const baseline = loadBaseline(recordingId);
  if (!baseline) return null;
  return baseline.steps.find(s => s.seq === stepSeq) || null;
}

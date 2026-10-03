/**
 * Shared run-report filesystem helpers: per-run output directory layout and
 * screenshot persistence. Used by the agentic test-creation orchestrator.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

export function ensureRunDir(baseDir: string, runId: string): { runDir: string; shotsDir: string } {
  const runDir = join(baseDir, runId);
  const shotsDir = join(runDir, 'screenshots');
  mkdirSync(shotsDir, { recursive: true });
  return { runDir, shotsDir };
}

export function makeScreenshotSaver(shotsDir: string): (caseId: string, index: number, base64: string, mime: string) => string {
  return (caseId, index, base64, mime) => {
    const ext = mime === 'image/jpeg' ? 'jpg' : 'png';
    const safeId = caseId.replace(/[^A-Za-z0-9_-]/g, '_');
    const fileName = `${safeId}_${String(index).padStart(3, '0')}.${ext}`;
    const fullPath = join(shotsDir, fileName);
    writeFileSync(fullPath, Buffer.from(base64, 'base64'));
    return fileName;
  };
}

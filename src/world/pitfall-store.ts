/**
 * Pitfall store — append-only memory of known failures and the conditions
 * under which they occurred. Surfaced to the agent at the start of a new run
 * so it can avoid the same traps.
 *
 * Persisted at ~/.appium-flutter-mcp/pitfalls/<appId>.json (single file per app).
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../util/logger.js';
import { sanitize, worldDir } from './paths.js';

export interface PitfallEntry {
  recordedAt: string;
  goal: string;
  screenFingerprint?: string;
  screenName?: string;
  context?: 'flutter' | 'webview' | 'native' | 'unknown';
  failureKind:
    | 'no_progress'
    | 'step_budget'
    | 'compile_failed'
    | 'export_failed'
    | 'app_crashed'
    | 'session_dropped'
    | 'auth_blocked'
    | 'agent_aborted'
    | 'other';
  summary: string;
  hint?: string;
  /** Run report path so we can revisit context. */
  runReportPath?: string;
  occurrences: number;
}

export interface PitfallsFile {
  schemaVersion: 1;
  appId: string;
  entries: PitfallEntry[];
}

const SCHEMA_VERSION = 1 as const;
const MAX_ENTRIES = 100;

function pitfallsPath(appId: string): string {
  return join(worldDir('pitfalls'), `${sanitize(appId)}.json`);
}

function emptyFile(appId: string): PitfallsFile {
  return { schemaVersion: SCHEMA_VERSION, appId, entries: [] };
}

export function loadPitfalls(appId: string): PitfallsFile {
  const path = pitfallsPath(appId);
  if (!existsSync(path)) return emptyFile(appId);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed?.schemaVersion !== SCHEMA_VERSION) return emptyFile(appId);
    if (!Array.isArray(parsed.entries)) parsed.entries = [];
    return parsed as PitfallsFile;
  } catch (e) {
    logger.warn('Pitfalls load failed', { appId, error: String(e) });
    return emptyFile(appId);
  }
}

function savePitfalls(file: PitfallsFile): void {
  const path = pitfallsPath(file.appId);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2));
  renameSync(tmp, path);
}

function fingerprint(e: Pick<PitfallEntry, 'goal' | 'screenFingerprint' | 'failureKind'>): string {
  return `${e.failureKind}::${e.goal.toLowerCase().slice(0, 80)}::${e.screenFingerprint ?? ''}`;
}

export function recordPitfall(
  appId: string,
  entry: Omit<PitfallEntry, 'recordedAt' | 'occurrences'>,
): PitfallEntry {
  const file = loadPitfalls(appId);
  const fp = fingerprint(entry);
  const existing = file.entries.find(e => fingerprint(e) === fp);
  if (existing) {
    existing.recordedAt = new Date().toISOString();
    existing.occurrences += 1;
    existing.summary = entry.summary;
    if (entry.hint) existing.hint = entry.hint;
    if (entry.runReportPath) existing.runReportPath = entry.runReportPath;
    savePitfalls(file);
    return existing;
  }
  const next: PitfallEntry = {
    ...entry,
    recordedAt: new Date().toISOString(),
    occurrences: 1,
  };
  file.entries.push(next);
  // Bound the list — drop the oldest.
  if (file.entries.length > MAX_ENTRIES) {
    file.entries.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
    file.entries.splice(0, file.entries.length - MAX_ENTRIES);
  }
  savePitfalls(file);
  return next;
}

export function recallPitfalls(appId: string, opts: { screenFingerprint?: string; goal?: string; limit?: number }): PitfallEntry[] {
  const file = loadPitfalls(appId);
  const lower = (opts.goal ?? '').toLowerCase();
  const filtered = file.entries.filter(e => {
    if (opts.screenFingerprint && e.screenFingerprint === opts.screenFingerprint) return true;
    if (lower && e.goal.toLowerCase().includes(lower.slice(0, 30))) return true;
    return false;
  });
  filtered.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  return filtered.slice(0, opts.limit ?? 5);
}

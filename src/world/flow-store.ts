/**
 * Flow store — named end-to-end flows that accomplish a goal.
 *
 * One flow record = one successful agentic_create_test run. Replayed on warm
 * runs so the agent can short-circuit known territory instead of re-exploring.
 *
 * Persisted at ~/.appium-flutter-mcp/flows/<appId>/<flowId>.json
 */

import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../util/logger.js';
import { appScopedDir, sanitize } from './paths.js';

export interface FlowStep {
  /** Stable screen fingerprint at the time the step was recorded (if known). */
  screenFingerprint?: string;
  /** Human-friendly screen name (best-effort). */
  screenName?: string;
  /** Action category — kept aligned with recorder.RecordedAction['type']. */
  action: string;
  /** Locator strategy when applicable: key|text|type|semanticsLabel|css|xpath|accessibilityId|coordinates. */
  by?: string;
  /** Locator value or coordinates string ("x,y"). */
  target?: string;
  /** Literal text to enter for type_text steps. */
  text?: string;
  /** Context the action ran in. */
  context?: 'flutter' | 'webview' | 'native' | 'unknown';
  /** Free-form note the agent attached. */
  note?: string;
}

export interface FlowRecord {
  schemaVersion: 1;
  id: string;
  goal: string;
  tags: string[];
  appId: string;
  env?: string;
  createdAt: string;
  lastVerifiedAt: string;
  successCount: number;
  failCount: number;
  steps: FlowStep[];
  /** Path of the Java test that this flow generated (if export succeeded). */
  generatedTestPath?: string;
  /** Path of the agentic run report that produced this flow. */
  runReportPath?: string;
}

const SCHEMA_VERSION = 1 as const;

export function flowIdFromGoal(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return slug || `flow_${Date.now()}`;
}

export function tagsFromGoal(goal: string): string[] {
  return Array.from(new Set(
    goal.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !STOP_WORDS.has(t)),
  )).slice(0, 10);
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'into', 'from', 'this', 'that', 'them', 'they',
  'test', 'create', 'verify', 'check', 'ensure', 'should',
]);

function flowPath(appId: string, id: string): string {
  return join(appScopedDir('flows', appId), `${sanitize(id)}.json`);
}

/**
 * Redact secrets before persisting: any typed text whose step targets a
 * password/secure/PIN field must never land on disk (flow stores can be
 * git-tracked via APPIUM_FLUTTER_MCP_HOME). Replay of a redacted step must
 * re-source the credential (config/env), never the flow record.
 */
const SECRET_TARGET_RE = /password|passcode|secure|secret|pin\b|otp\b/i;

function redactSecretSteps(steps: FlowStep[]): FlowStep[] {
  return steps.map(s => {
    if (s.text && (SECRET_TARGET_RE.test(s.target ?? '') || SECRET_TARGET_RE.test(s.note ?? ''))) {
      return { ...s, text: '«redacted»' };
    }
    return s;
  });
}

export function saveFlow(record: FlowRecord): string {
  const path = flowPath(record.appId, record.id);
  const tmp = `${path}.tmp`;
  const safe: FlowRecord = { ...record, steps: redactSecretSteps(record.steps) };
  writeFileSync(tmp, JSON.stringify(safe, null, 2));
  renameSync(tmp, path);
  logger.info('Flow saved', { appId: record.appId, id: record.id, steps: record.steps.length });
  return path;
}

export function loadFlow(appId: string, id: string): FlowRecord | null {
  try {
    const path = flowPath(appId, id);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed?.schemaVersion === SCHEMA_VERSION ? parsed as FlowRecord : null;
  } catch (e) {
    logger.debug('Flow load failed', { id, error: String(e) });
    return null;
  }
}

export function loadAllFlows(appId: string): FlowRecord[] {
  try {
    const dir = appScopedDir('flows', appId);
    return readdirSync(dir)
      .filter(f => f.endsWith('.json') && !f.endsWith('.tmp'))
      .map(f => {
        try {
          const parsed = JSON.parse(readFileSync(join(dir, f), 'utf8'));
          return parsed?.schemaVersion === SCHEMA_VERSION ? parsed as FlowRecord : null;
        } catch { return null; }
      })
      .filter((x): x is FlowRecord => x !== null);
  } catch { return []; }
}

export interface FlowMatch {
  flow: FlowRecord;
  score: number;
  matchedTokens: string[];
}

/**
 * Fuzzy-match flows by goal/tags against a query. Pure keyword scoring — fast
 * and predictable, no embeddings needed at this scale.
 */
export function recallFlows(appId: string, query: string, limit = 5): FlowMatch[] {
  const queryTokens = new Set(tagsFromGoal(query));
  if (queryTokens.size === 0) return [];

  const flows = loadAllFlows(appId);
  const scored: FlowMatch[] = [];
  for (const f of flows) {
    const flowTokens = new Set([...f.tags, ...tagsFromGoal(f.goal)]);
    const matched: string[] = [];
    for (const t of queryTokens) if (flowTokens.has(t)) matched.push(t);
    if (matched.length === 0) continue;

    // Simple Jaccard with a small successCount tiebreaker so well-worn flows surface first.
    const union = new Set([...queryTokens, ...flowTokens]).size;
    const jaccard = matched.length / union;
    const score = jaccard + Math.min(f.successCount, 10) * 0.01;
    scored.push({ flow: f, score, matchedTokens: matched });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export function recordFlowSuccess(record: FlowRecord): void {
  record.successCount += 1;
  record.lastVerifiedAt = new Date().toISOString();
  saveFlow(record);
}

export function recordFlowFailure(record: FlowRecord): void {
  record.failCount += 1;
  saveFlow(record);
}

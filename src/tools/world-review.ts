import { z } from 'zod';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { getCurrentAppId } from '../context/screen-map-store.js';
import { loadDriverProfile } from '../world/driver-profile.js';
import { getCurrentPlatform } from '../appium/session.js';
import type { McpToolResponse } from '../types.js';

const MCP_HOME = resolve(
  process.env.APPIUM_FLUTTER_MCP_HOME ?? join(homedir(), '.appium-flutter-mcp'),
);
// Must honour APPIUM_FLUTTER_MCP_HOME like every other store (see world/paths.ts):
// pitfalls are written under the relocated world root, so reading from the default
// per-machine dir triages an empty store.
const PITFALLS_DIR = join(MCP_HOME, 'pitfalls');

export const worldReviewSchema = z.object({
  appId: z.string().optional().describe('App bundle ID to review (defaults to the current session app)'),
  includeRawTelemetry: z.boolean().optional().default(false)
    .describe('Include the last 50 raw telemetry lines in the output'),
});

interface TelemetrySummary {
  tool: string;
  strategy: string;
  total: number;
  failures: number;
  failureRate: string;
  avgMs: number;
}

function readTelemetry(appId: string): Array<Record<string, unknown>> {
  const telemetryFile = join(MCP_HOME, 'telemetry', `${appId.replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`);
  if (!existsSync(telemetryFile)) return [];
  try {
    return readFileSync(telemetryFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function summarizeTelemetry(entries: Array<Record<string, unknown>>): TelemetrySummary[] {
  const buckets = new Map<string, { total: number; failures: number; totalMs: number }>();
  for (const e of entries) {
    const key = `${e.tool}:${e.strategy}`;
    const existing = buckets.get(key) ?? { total: 0, failures: 0, totalMs: 0 };
    existing.total++;
    if (!e.ok) existing.failures++;
    existing.totalMs += (e.ms as number) ?? 0;
    buckets.set(key, existing);
  }
  return Array.from(buckets.entries())
    .map(([k, v]) => {
      const [tool, strategy] = k.split(':');
      return {
        tool,
        strategy,
        total: v.total,
        failures: v.failures,
        failureRate: `${Math.round((v.failures / v.total) * 100)}%`,
        avgMs: Math.round(v.totalMs / v.total),
      };
    })
    .sort((a, b) => b.failures - a.failures);
}

function readPitfalls(appId: string): Array<Record<string, unknown>> {
  const p = join(PITFALLS_DIR, `${appId.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`);
  if (!existsSync(p)) return [];
  try {
    const data = JSON.parse(readFileSync(p, 'utf8')) as { entries?: Array<Record<string, unknown>> };
    return data.entries ?? [];
  } catch {
    return [];
  }
}

/**
 * Triage accumulated pitfalls + telemetry into the 3-bucket framework:
 *   1. tool-gap → propose an MCP backlog item
 *   2. knowledge-to-codify → hand to auto-surface (zena-skillify)
 *   3. app/env ticket → emit a JIRA-ready block
 */
export async function handleWorldReview(params: z.infer<typeof worldReviewSchema>): Promise<McpToolResponse> {
  const appId = params.appId ?? getCurrentAppId() ?? 'unknown-app';
  const platform = getCurrentPlatform() ?? 'ios';

  const telemetryEntries = readTelemetry(appId);
  const telemetrySummary = summarizeTelemetry(telemetryEntries);
  const pitfalls = readPitfalls(appId);
  const driverProfile = loadDriverProfile(appId, platform);

  // ── Bucket 1: tool-gaps ────────────────────────────────────────────────────
  const toolGaps: string[] = [];

  // High failure-rate strategies are MCP tool-gaps
  for (const s of telemetrySummary) {
    if (s.total >= 3 && s.failures / s.total >= 0.5) {
      toolGaps.push(
        `find_elements[${s.strategy}] failing ${s.failureRate} of ${s.total} calls` +
          ` (avg ${s.avgMs}ms) — investigate locator channel stability for this strategy`,
      );
    }
  }

  if (driverProfile?.vmDriverCommands === 'broken') {
    toolGaps.push(
      `VM driver commands marked broken for ${appId}/${platform} ` +
        `(last confirmed ${driverProfile.lastConfirmed}, ${driverProfile.sessions} session(s)) ` +
        `— the tap/type_text VM fast path is wasted; session.ts now pre-skips it per E1`,
    );
  }

  // ── Bucket 2: knowledge-to-codify ─────────────────────────────────────────
  const knowledgeItems: string[] = [];

  for (const p of pitfalls) {
    const kind = String(p.failureKind ?? 'other');
    const summary = String(p.summary ?? '');
    const hint = p.hint ? `Hint: ${String(p.hint)}` : '';
    if (kind === 'app_crashed' || kind === 'session_dropped') {
      knowledgeItems.push(
        `Recurring ${kind} pitfall: "${summary}" (${Number(p.occurrences ?? 1)}×)${hint ? ' — ' + hint : ''}` +
          ' → candidate for debug-fix/app-up skill note or CLAUDE.md pitfall rule',
      );
    } else if (summary.toLowerCase().includes('overlay') || summary.toLowerCase().includes('platform_view')) {
      knowledgeItems.push(
        `Overlay/platform_view pitfall: "${summary}" → ` +
          'candidate for CLAUDE.md locator-strategy note or new ValueKey request',
      );
    }
  }

  // Telemetry patterns that indicate a workaround worth codifying
  for (const s of telemetrySummary) {
    if (s.strategy === 'key' && s.total >= 5 && s.failures / s.total >= 0.3) {
      knowledgeItems.push(
        `ValueKey find_elements failing ${s.failureRate} on ${appId} ` +
          `— overlay barrier likely; add rule: "use tapByKey not find_elements for overlay keys"`,
      );
    }
  }

  // ── Bucket 3: app/env JIRA candidates ─────────────────────────────────────
  const jiraItems: string[] = [];

  for (const p of pitfalls) {
    const kind = String(p.failureKind ?? 'other');
    if (Number(p.occurrences ?? 1) >= 3 && (kind === 'auth_blocked' || kind === 'app_crashed')) {
      jiraItems.push(
        `[JIRA candidate] ${kind} recurring ${Number(p.occurrences)}×: "${String(p.summary ?? '')}"\n` +
          `  Screen: ${String(p.screenName ?? 'unknown')} | Goal: ${String(p.goal ?? '')}`,
      );
    }
  }

  // ── Format output ──────────────────────────────────────────────────────────
  const lines: string[] = [
    `## world_review — ${appId} / ${platform}`,
    `Telemetry entries: ${telemetryEntries.length} | Pitfalls: ${pitfalls.length}`,
    '',
  ];

  lines.push('### Bucket 1 — Tool-gaps (MCP improvements)');
  if (toolGaps.length === 0) {
    lines.push('  (none — no high-failure-rate strategy patterns detected)');
  } else {
    for (const g of toolGaps) lines.push(`  • ${g}`);
  }

  lines.push('');
  lines.push('### Bucket 2 — Knowledge to codify (run /zena-skillify to apply)');
  if (knowledgeItems.length === 0) {
    lines.push('  (none)');
  } else {
    for (const k of knowledgeItems) lines.push(`  • ${k}`);
  }

  lines.push('');
  lines.push('### Bucket 3 — App/env JIRA candidates');
  if (jiraItems.length === 0) {
    lines.push('  (none — no recurring app-crash / auth-blocked pattern above threshold)');
  } else {
    for (const j of jiraItems) lines.push(j);
  }

  if (telemetrySummary.length > 0) {
    lines.push('');
    lines.push('### Telemetry summary (by tool:strategy, sorted by failures)');
    for (const s of telemetrySummary) {
      lines.push(`  ${s.tool}[${s.strategy}]  ${s.failures}/${s.total} failures (${s.failureRate})  avg ${s.avgMs}ms`);
    }
  }

  if (params.includeRawTelemetry && telemetryEntries.length > 0) {
    lines.push('');
    lines.push('### Last 50 raw telemetry entries');
    lines.push('```json');
    lines.push(JSON.stringify(telemetryEntries.slice(-50), null, 2));
    lines.push('```');
  }

  if (toolGaps.length > 0 || knowledgeItems.length > 0) {
    lines.push('');
    lines.push('_Run `/zena-skillify` to apply knowledge items. Backlog items tracked in docs/MCP_IMPROVEMENTS_BACKLOG.md._');
  }

  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
  };
}

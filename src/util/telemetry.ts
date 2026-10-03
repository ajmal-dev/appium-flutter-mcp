import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';

const MCP_HOME = resolve(
  process.env.APPIUM_FLUTTER_MCP_HOME ?? join(homedir(), '.appium-flutter-mcp'),
);

function telemetryPath(appId: string): string {
  const dir = join(MCP_HOME, 'telemetry');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `${appId.replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`);
}

export interface TelemetryEntry {
  ts: number;
  tool: string;
  strategy: string;
  ok: boolean;
  ms?: number;
  error?: string;
}

/**
 * Fire-and-forget JSONL append. Never throws — telemetry must not fail a tool call.
 */
export function recordTelemetry(appId: string, entry: TelemetryEntry): void {
  if (!appId) return;
  try {
    appendFileSync(telemetryPath(appId), JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // silent — telemetry is best-effort
  }
}

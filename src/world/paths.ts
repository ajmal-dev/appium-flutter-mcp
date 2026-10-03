import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Same override contract as screen-map-store's STORE_ROOT: set
// APPIUM_FLUTTER_MCP_HOME to relocate the whole world model (flows /
// pitfalls / test-inventory / agentic-runs) — e.g. to a project-local,
// git-tracked dir like `app-knowledge` so learned app knowledge is shared
// and versioned instead of per-machine. Relative values resolve against
// the server's cwd (the project root when launched via .mcp.json).
const WORLD_ROOT = process.env.APPIUM_FLUTTER_MCP_HOME ?? join(homedir(), '.appium-flutter-mcp');

export function worldDir(scope: 'flows' | 'pitfalls' | 'test-inventory' | 'agentic-runs'): string {
  const dir = join(WORLD_ROOT, scope);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function appScopedDir(scope: 'flows' | 'pitfalls' | 'test-inventory' | 'agentic-runs', appId: string): string {
  const dir = join(worldDir(scope), sanitize(appId));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

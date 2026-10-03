/**
 * Test inventory — index of every Java test the agentic flow has generated.
 *
 * Lets the orchestrator detect duplicates ("we already have a test for that
 * goal") before regenerating, and lets the agent recall the existing class
 * path so it can suggest augmenting instead of re-creating.
 *
 * Persisted at ~/.appium-flutter-mcp/test-inventory/<appId>.json.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../util/logger.js';
import { sanitize, worldDir } from './paths.js';

export interface InventoryEntry {
  flowId: string;
  goal: string;
  testClassName: string;
  testMethodName?: string;
  packageName?: string;
  filePath: string;
  projectPath: string;
  generatedAt: string;
  lastVerifiedAt?: string;
  /** Result of the latest mvn compile invocation. */
  compileStatus?: 'ok' | 'failed' | 'skipped';
}

export interface InventoryFile {
  schemaVersion: 1;
  appId: string;
  entries: InventoryEntry[];
}

const SCHEMA_VERSION = 1 as const;

function inventoryPath(appId: string): string {
  return join(worldDir('test-inventory'), `${sanitize(appId)}.json`);
}

function emptyFile(appId: string): InventoryFile {
  return { schemaVersion: SCHEMA_VERSION, appId, entries: [] };
}

export function loadInventory(appId: string): InventoryFile {
  const path = inventoryPath(appId);
  if (!existsSync(path)) return emptyFile(appId);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed?.schemaVersion !== SCHEMA_VERSION) return emptyFile(appId);
    if (!Array.isArray(parsed.entries)) parsed.entries = [];
    return parsed as InventoryFile;
  } catch (e) {
    logger.warn('Inventory load failed', { appId, error: String(e) });
    return emptyFile(appId);
  }
}

function save(file: InventoryFile): void {
  const path = inventoryPath(file.appId);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2));
  renameSync(tmp, path);
}

export function upsertInventoryEntry(appId: string, entry: InventoryEntry): InventoryEntry {
  const file = loadInventory(appId);
  const idx = file.entries.findIndex(e =>
    e.flowId === entry.flowId
    || (e.filePath === entry.filePath && e.testClassName === entry.testClassName),
  );
  if (idx >= 0) {
    file.entries[idx] = { ...file.entries[idx], ...entry };
  } else {
    file.entries.push(entry);
  }
  save(file);
  return entry;
}

export function findInventoryByGoal(appId: string, goal: string): InventoryEntry | undefined {
  const file = loadInventory(appId);
  const lower = goal.toLowerCase();
  return file.entries.find(e => e.goal.toLowerCase() === lower)
    ?? file.entries.find(e => e.goal.toLowerCase().includes(lower.slice(0, 30)) || lower.includes(e.goal.toLowerCase().slice(0, 30)));
}

export function findInventoryByFlowId(appId: string, flowId: string): InventoryEntry | undefined {
  return loadInventory(appId).entries.find(e => e.flowId === flowId);
}

/**
 * Persistent Screen Map Store — remembers app screens across sessions.
 *
 * Stores discovered screens at ~/.appium-flutter-mcp/screen-maps/<appId>/<screenId>.json
 * Each screen is identified by a fingerprint (hash of element types + labels).
 * Navigation edges track which actions lead to which screens.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../util/logger.js';
import type { InteractiveElement } from '../tree/types.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ScreenMapEntry {
  screenId: string;
  name: string;
  fingerprint: string;
  elements: InteractiveElement[];
  edges: NavigationEdge[];
  lastVerified: string;
  appId: string;
  routeName?: string;
  screenWidget?: string;
}

export interface NavigationEdge {
  action: { by: string; value: string };
  toScreenId: string;
  toScreenName?: string;
}

// ── Storage paths ──────────────────────────────────────────────────────────

const STORE_ROOT = join(homedir(), '.appium-flutter-mcp', 'screen-maps');

function getAppDir(appId: string): string {
  const dir = join(STORE_ROOT, sanitizeFilename(appId));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

// ── Fingerprinting ─────────────────────────────────────────────────────────

/**
 * Generate a stable fingerprint for a set of interactive elements.
 * Uses sorted element types + text labels to produce a hash.
 * The same screen with the same elements will always produce the same fingerprint.
 */
export function generateFingerprint(elements: InteractiveElement[]): string {
  const tokens = elements
    .map(el => {
      const parts = [el.type];
      if (el.text) parts.push(el.text.slice(0, 30)); // truncate long texts
      if (el.locator) parts.push(`${el.locator.by}:${el.locator.value}`);
      return parts.join('|');
    })
    .sort();

  return simpleHash(tokens.join('\n'));
}

/**
 * Generate a human-readable screen name from the elements on screen.
 * Heuristic: uses prominent text elements (buttons, titles) to guess the screen purpose.
 */
export function inferScreenName(elements: InteractiveElement[]): string {
  // Look for prominent text labels
  const labels: string[] = [];
  for (const el of elements) {
    if (el.text && el.text.length > 2 && el.text.length < 40) {
      labels.push(el.text);
    }
  }

  if (labels.length === 0) return 'Unknown Screen';

  // Use the first few labels to form a name
  const name = labels.slice(0, 3).join(' / ');
  return name.length > 50 ? name.slice(0, 47) + '...' : name;
}

// ── CRUD Operations ────────────────────────────────────────────────────────

/**
 * Save a screen map entry to disk.
 */
export function saveScreenMap(entry: ScreenMapEntry): void {
  try {
    const dir = getAppDir(entry.appId);
    const filePath = join(dir, `${entry.screenId}.json`);
    writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf-8');
    logger.info('Screen map saved', { screenId: entry.screenId, name: entry.name, appId: entry.appId });
  } catch (error) {
    logger.warn('Failed to save screen map', { error: String(error) });
  }
}

/**
 * Load a screen map by fingerprint (screenId).
 */
export function loadScreenMap(appId: string, screenId: string): ScreenMapEntry | null {
  try {
    const filePath = join(getAppDir(appId), `${screenId}.json`);
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf-8')) as ScreenMapEntry;
  } catch (error) {
    logger.debug('Failed to load screen map', { screenId, error: String(error) });
    return null;
  }
}

/**
 * Load all screen maps for an app.
 */
export function loadAllScreenMaps(appId: string): ScreenMapEntry[] {
  try {
    const dir = getAppDir(appId);
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    return files.map(f => {
      try {
        return JSON.parse(readFileSync(join(dir, f), 'utf-8')) as ScreenMapEntry;
      } catch {
        return null;
      }
    }).filter((e): e is ScreenMapEntry => e !== null);
  } catch {
    return [];
  }
}

/**
 * Find a screen by name (fuzzy match).
 */
export function getScreenByName(appId: string, name: string): ScreenMapEntry | null {
  const screens = loadAllScreenMaps(appId);
  const lower = name.toLowerCase();

  // Exact match first
  const exact = screens.find(s => s.name.toLowerCase() === lower);
  if (exact) return exact;

  // Partial match
  const partial = screens.find(s => s.name.toLowerCase().includes(lower) || lower.includes(s.name.toLowerCase()));
  return partial || null;
}

/**
 * Add a navigation edge from one screen to another.
 */
export function addNavigationEdge(
  appId: string,
  fromScreenId: string,
  action: { by: string; value: string },
  toScreenId: string,
  toScreenName?: string,
): void {
  const screen = loadScreenMap(appId, fromScreenId);
  if (!screen) return;

  // Check if edge already exists
  const existingEdge = screen.edges.find(
    e => e.action.by === action.by && e.action.value === action.value,
  );

  if (existingEdge) {
    existingEdge.toScreenId = toScreenId;
    existingEdge.toScreenName = toScreenName;
  } else {
    screen.edges.push({ action, toScreenId, toScreenName });
  }

  saveScreenMap(screen);
  logger.info('Navigation edge recorded', { from: fromScreenId, action, to: toScreenId });
}

/**
 * Record current screen state and return the screen map entry.
 * If the screen is already known, returns the existing entry (updated).
 * If new, creates and saves a new entry.
 */
export function recordScreen(appId: string, elements: InteractiveElement[]): ScreenMapEntry {
  const fingerprint = generateFingerprint(elements);
  const screenId = fingerprint;

  // Check if screen already exists
  const existing = loadScreenMap(appId, screenId);
  if (existing) {
    // Update with fresh element data and timestamp
    existing.elements = elements;
    existing.lastVerified = new Date().toISOString();
    saveScreenMap(existing);
    return existing;
  }

  // New screen — create entry
  const entry: ScreenMapEntry = {
    screenId,
    name: inferScreenName(elements),
    fingerprint,
    elements,
    edges: [],
    lastVerified: new Date().toISOString(),
    appId,
  };

  saveScreenMap(entry);
  return entry;
}

/**
 * Find shortest path between two screens using BFS on navigation edges.
 * Returns array of steps: [{screenId, action}] or null if no path found.
 */
export function findNavigationPath(
  appId: string,
  fromScreenId: string,
  toScreenId: string,
): Array<{ screenId: string; action: { by: string; value: string } }> | null {
  if (fromScreenId === toScreenId) return [];

  const screens = loadAllScreenMaps(appId);
  const screenMap = new Map(screens.map(s => [s.screenId, s]));

  // BFS
  const queue: Array<{ screenId: string; path: Array<{ screenId: string; action: { by: string; value: string } }> }> = [];
  const visited = new Set<string>();

  visited.add(fromScreenId);
  const startScreen = screenMap.get(fromScreenId);
  if (!startScreen) return null;

  for (const edge of startScreen.edges) {
    queue.push({
      screenId: edge.toScreenId,
      path: [{ screenId: fromScreenId, action: edge.action }],
    });
  }

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (current.screenId === toScreenId) {
      return current.path;
    }

    if (visited.has(current.screenId)) continue;
    visited.add(current.screenId);

    const screen = screenMap.get(current.screenId);
    if (!screen) continue;

    for (const edge of screen.edges) {
      if (!visited.has(edge.toScreenId)) {
        queue.push({
          screenId: edge.toScreenId,
          path: [...current.path, { screenId: current.screenId, action: edge.action }],
        });
      }
    }
  }

  return null; // No path found
}

// ── Route-aware helpers ────────────────────────────────────────────────────
// Route enrichment was previously sourced from a project-specific Dart router
// file. v1 ships without a generic router parser; these helpers are stubs so
// callers don't need to special-case missing route info. A future release can
// replace them with a parser configurable for any router pattern.

export async function enrichScreenWithRoute(_entry: ScreenMapEntry): Promise<void> {
  return;
}

export async function getAvailableRoutes(): Promise<Array<{ routeName: string; screenWidget?: string }>> {
  return [];
}

// ── Internal helpers ───────────────────────────────────────────────────────

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  // Convert to positive hex string
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// ── Session-level state for tracking screen transitions ────────────────────

let currentScreenId: string | null = null;
let currentAppId: string | null = null;
let lastAction: { by: string; value: string } | null = null;

export function setCurrentAppId(appId: string): void {
  currentAppId = appId;
}

export function getCurrentAppId(): string | null {
  return currentAppId;
}

export function getCurrentScreenId(): string | null {
  return currentScreenId;
}

/**
 * Track a screen transition: record the current screen and, if the screen changed,
 * record the navigation edge from the previous screen.
 */
export function trackScreenTransition(
  elements: InteractiveElement[],
  action?: { by: string; value: string },
): ScreenMapEntry | null {
  if (!currentAppId) return null;

  const screen = recordScreen(currentAppId, elements);
  const previousScreenId = currentScreenId;

  // If screen changed and we know the action that caused it, record the edge
  if (previousScreenId && previousScreenId !== screen.screenId && lastAction) {
    addNavigationEdge(currentAppId, previousScreenId, lastAction, screen.screenId, screen.name);
  }

  currentScreenId = screen.screenId;
  lastAction = action || null;

  return screen;
}

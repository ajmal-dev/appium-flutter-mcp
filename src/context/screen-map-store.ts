/**
 * Persistent Screen Map Store — remembers app screens across sessions.
 *
 * Stores discovered screens at ~/.appium-flutter-mcp/screen-maps/<appId>/<screenId>.json
 *
 * Screen identity is STRUCTURAL, not content-based: a screen is identified by
 * its stable tokens (ValueKeys, semantics labels, button/tab chrome text, and
 * a widget-type histogram) — never by dynamic display text. Re-visiting the
 * same logical screen with different data (another month, another guest list)
 * resolves to the SAME entry via weighted-Jaccard similarity matching, so
 * navigation edges and locator caches accumulate instead of fragmenting.
 *
 * Screens carry a canonical name plus aliases. Agent-bound names (via
 * bindScreenName) are authoritative and never overwritten by inferred names.
 * Navigation edges track which actions lead to which screens.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../util/logger.js';
import { getRouteIndex, findRoute } from '../source/route-parser.js';
import { loadConfig } from '../util/config.js';
import type { InteractiveElement } from '../tree/types.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ResolvedLocatorCache {
  by: string;
  value: string;
  matchCount: number;
  contextType: 'flutter' | 'webview' | 'native';
  resolvedAt: string;
}

export interface ScreenMapEntry {
  /** Stable identity — assigned on first discovery, survives content changes. */
  screenId: string;
  name: string;
  /** Where the canonical name came from. Agent-bound names are never overwritten. */
  nameSource?: 'agent' | 'inferred' | 'route';
  /** Alternative names this screen is known by (old inferred names, merged-entry names). */
  aliases?: string[];
  /** Latest structural fingerprint (hash of stable tokens). */
  fingerprint: string;
  /** Stable token → weight map used for similarity matching. */
  stableTokens?: Record<string, number>;
  elements: InteractiveElement[];
  edges: NavigationEdge[];
  lastVerified: string;
  appId: string;
  routeName?: string;
  screenWidget?: string;
  /** Locators resolved on this screen, keyed by description slug. */
  resolvedLocators?: Record<string, ResolvedLocatorCache>;
}

export interface NavigationEdge {
  action: { by: string; value: string };
  toScreenId: string;
  toScreenName?: string;
}

// ── Storage paths ──────────────────────────────────────────────────────────

const STORE_ROOT = join(
  process.env.APPIUM_FLUTTER_MCP_HOME ?? join(homedir(), '.appium-flutter-mcp'),
  'screen-maps',
);

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

// ── Stable tokens & structural fingerprinting ─────────────────────────────

/** Similarity at or above this means "same logical screen". */
export const SCREEN_SIMILARITY_THRESHOLD = 0.6;

/** Widget types whose text is usually static chrome (tabs, buttons) rather than data. */
const CHROME_TEXT_TYPES = /Button$|^Tab$|Chip$|^BottomNavigationBar$|^NavigationBar$|^NavigationRail$/;

/**
 * Compute the stable token set for a screen. Tokens deliberately EXCLUDE
 * free-form display text (dates, guest names, counters) so that the same
 * screen with different data produces a near-identical token set.
 *
 * Weights: ValueKeys (3) > semantics labels / chrome text (2) > type histogram (1).
 */
export function computeStableTokens(elements: InteractiveElement[]): Record<string, number> {
  const tokens: Record<string, number> = {};
  const typeCounts = new Map<string, number>();

  for (const el of elements) {
    typeCounts.set(el.type, (typeCounts.get(el.type) ?? 0) + 1);

    const key = el.key ?? (el.locator?.by === 'key' ? el.locator.value : undefined);
    if (key) tokens[`key:${key}`] = 3;

    if (el.locator?.by === 'semanticsLabel' && el.locator.value) {
      tokens[`sem:${el.locator.value.slice(0, 40)}`] = 2;
    }

    if (el.text && el.text.length <= 30 && CHROME_TEXT_TYPES.test(el.type)) {
      tokens[`btn:${el.type}:${el.text.toLowerCase()}`] = 2;
    }
  }

  for (const [type, count] of typeCounts) {
    tokens[`type:${type}:${countBucket(count)}`] = 1;
  }

  return tokens;
}

/** Bucket element counts so list-length jitter doesn't shift the fingerprint. */
function countBucket(n: number): string {
  if (n <= 2) return String(n);
  if (n <= 5) return '3-5';
  return '6+';
}

/** Hash of the stable token set — exact-match fast path for identity lookup. */
export function stableFingerprint(tokens: Record<string, number>): string {
  return simpleHash(Object.keys(tokens).sort().join('\n'));
}

/**
 * Weighted Jaccard similarity between two stable token sets.
 * 1.0 = identical structure; 0 = nothing in common.
 */
export function screenSimilarity(a: Record<string, number>, b: Record<string, number>): number {
  let intersection = 0;
  let union = 0;
  const seen = new Set<string>();
  for (const [t, w] of Object.entries(a)) {
    seen.add(t);
    union += w;
    if (t in b) intersection += w;
  }
  for (const [t, w] of Object.entries(b)) {
    if (!seen.has(t)) union += w;
  }
  return union === 0 ? 0 : intersection / union;
}

/** Token set for an entry — falls back to recomputing from stored elements (legacy entries). */
function entryTokens(entry: ScreenMapEntry): Record<string, number> {
  if (entry.stableTokens && Object.keys(entry.stableTokens).length > 0) return entry.stableTokens;
  return computeStableTokens(entry.elements ?? []);
}

/**
 * Session-fingerprint of a screen INCLUDING display text. Changes whenever
 * visible content changes — use for "did the screen change since my last
 * action" detection, NOT for cross-session identity (use identifyScreen).
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
    const filePath = join(dir, `${sanitizeFilename(entry.screenId)}.json`);
    writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf-8');
    logger.info('Screen map saved', { screenId: entry.screenId, name: entry.name, appId: entry.appId });
  } catch (error) {
    logger.warn('Failed to save screen map', { error: String(error) });
  }
}

/**
 * Load a screen map by screenId.
 */
export function loadScreenMap(appId: string, screenId: string): ScreenMapEntry | null {
  try {
    const filePath = join(getAppDir(appId), `${sanitizeFilename(screenId)}.json`);
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf-8')) as ScreenMapEntry;
  } catch (error) {
    logger.debug('Failed to load screen map', { screenId, error: String(error) });
    return null;
  }
}

/** Delete a screen map entry from disk. */
export function deleteScreenMap(appId: string, screenId: string): void {
  try {
    const filePath = join(getAppDir(appId), `${sanitizeFilename(screenId)}.json`);
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch (error) {
    logger.debug('Failed to delete screen map', { screenId, error: String(error) });
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

// ── Name resolution (canonical name + aliases, fuzzy) ─────────────────────

const NAME_STOP_TOKENS = new Set(['screen', 'page', 'view', 'tab', 'the']);

/** Split a name into normalized tokens. Handles camelCase widget names. */
function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase → spaced
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 2 && !NAME_STOP_TOKENS.has(t));
}

/** All names an entry answers to: canonical, aliases, route, widget class. */
function allNamesOf(entry: ScreenMapEntry): string[] {
  const names = [entry.name, ...(entry.aliases ?? [])];
  if (entry.routeName) names.push(entry.routeName);
  if (entry.screenWidget) names.push(entry.screenWidget);
  return names.filter((n): n is string => !!n && n.length > 0);
}

/**
 * Find a screen by name. Matching tiers:
 *  1. exact (case-insensitive) on canonical name, aliases, route, or widget class
 *  2. substring either way (normalized, camelCase-aware)
 *  3. token-overlap scoring (Jaccard ≥ 0.5) — best match wins
 */
export function getScreenByName(appId: string, name: string): ScreenMapEntry | null {
  const screens = loadAllScreenMaps(appId);
  const query = name.trim().toLowerCase();
  if (!query) return null;

  // Tier 1: exact match on any known name
  for (const s of screens) {
    if (allNamesOf(s).some(n => n.toLowerCase() === query)) return s;
  }

  // Tier 2: substring either way (camelCase-normalized)
  const queryNorm = nameTokens(name).join(' ');
  for (const s of screens) {
    for (const n of allNamesOf(s)) {
      const norm = nameTokens(n).join(' ');
      if (!norm) continue;
      if (norm.includes(queryNorm) || queryNorm.includes(norm)) return s;
    }
  }

  // Tier 3: token-overlap scoring
  const qTokens = new Set(nameTokens(name));
  if (qTokens.size === 0) return null;

  let best: { entry: ScreenMapEntry; score: number } | null = null;
  for (const s of screens) {
    for (const n of allNamesOf(s)) {
      const nTokens = new Set(nameTokens(n));
      if (nTokens.size === 0) continue;
      let overlap = 0;
      for (const t of qTokens) if (nTokens.has(t)) overlap++;
      const score = overlap / new Set([...qTokens, ...nTokens]).size;
      if (score >= 0.5 && (!best || score > best.score)) {
        best = { entry: s, score };
      }
    }
  }
  return best?.entry ?? null;
}

/**
 * Bind a human-chosen name to a screen. Agent-bound names are canonical:
 * the previous name is preserved as an alias, and future inferred names
 * never overwrite an agent binding.
 */
export function bindScreenName(appId: string, screenId: string, name: string): ScreenMapEntry | null {
  const entry = loadScreenMap(appId, screenId);
  if (!entry) return null;

  const newName = name.trim();
  if (!newName) return entry;

  if (entry.name !== newName) {
    const oldName = entry.name;
    entry.name = newName;
    addAlias(entry, oldName);
  }
  entry.nameSource = 'agent';
  // Make sure the new name isn't duplicated in aliases
  entry.aliases = (entry.aliases ?? []).filter(a => a.toLowerCase() !== newName.toLowerCase());

  saveScreenMap(entry);
  logger.info('Screen name bound', { screenId, name: newName, appId });
  return entry;
}

function addAlias(entry: ScreenMapEntry, alias: string): void {
  const a = alias.trim();
  if (!a || a === 'Unknown Screen') return;
  if (a.toLowerCase() === entry.name.toLowerCase()) return;
  const aliases = entry.aliases ?? [];
  if (aliases.some(x => x.toLowerCase() === a.toLowerCase())) return;
  aliases.push(a);
  entry.aliases = aliases.slice(-8); // cap to the most recent 8
}

// ── Identity: match-or-create ──────────────────────────────────────────────

/**
 * Identify the current screen against the store WITHOUT creating an entry.
 * Returns the best match at or above SCREEN_SIMILARITY_THRESHOLD, or null.
 */
export function identifyScreen(
  appId: string,
  elements: InteractiveElement[],
): { entry: ScreenMapEntry; score: number } | null {
  if (!elements || elements.length === 0) return null;
  const tokens = computeStableTokens(elements);
  const fp = stableFingerprint(tokens);

  const all = loadAllScreenMaps(appId);

  // Exact structural fingerprint — fast path
  const exact = all.find(e => e.fingerprint === fp);
  if (exact) return { entry: exact, score: 1 };

  // Similarity scan
  let best: { entry: ScreenMapEntry; score: number } | null = null;
  for (const e of all) {
    const score = screenSimilarity(tokens, entryTokens(e));
    if (score >= SCREEN_SIMILARITY_THRESHOLD && (!best || score > best.score)) {
      best = { entry: e, score };
    }
  }
  return best;
}

/**
 * Record current screen state and return the screen map entry.
 * Matches structurally (similarity, not exact hash): the same logical screen
 * with different data updates the EXISTING entry, keeping its screenId, name,
 * aliases, and edges. Duplicate entries that now match are merged in.
 * Returns null for empty scans (never persists ghost screens).
 */
export function recordScreen(appId: string, elements: InteractiveElement[]): ScreenMapEntry | null {
  if (!elements || elements.length === 0) return null;

  const tokens = computeStableTokens(elements);
  const fp = stableFingerprint(tokens);
  const all = loadAllScreenMaps(appId);

  const matches = all
    .map(e => ({ entry: e, score: screenSimilarity(tokens, entryTokens(e)) }))
    .filter(m => m.score >= SCREEN_SIMILARITY_THRESHOLD);

  if (matches.length === 0) {
    // New screen — create entry
    const entry: ScreenMapEntry = {
      screenId: fp,
      name: inferScreenName(elements),
      nameSource: 'inferred',
      fingerprint: fp,
      stableTokens: tokens,
      elements,
      edges: [],
      lastVerified: new Date().toISOString(),
      appId,
    };
    saveScreenMap(entry);
    return entry;
  }

  // Survivor = the best-ESTABLISHED matching entry (agent-named > most edges >
  // most recent), NOT the highest-scoring one — a stale fragment can score a
  // perfect match against the current scan yet must merge into the real entry.
  let best = matches[0].entry;
  for (const m of matches.slice(1)) {
    best = pickMergeOrder(best, m.entry)[0];
  }

  // Merge any other entries that also match — they were fragments of this screen
  for (const m of matches) {
    if (m.entry.screenId !== best.screenId) mergeEntries(appId, best, m.entry, all);
  }

  // Refresh the surviving entry with the latest observation
  best.elements = elements;
  best.stableTokens = tokens;
  best.fingerprint = fp;
  best.lastVerified = new Date().toISOString();
  saveScreenMap(best);
  return best;
}

function rankNameSource(e: ScreenMapEntry): number {
  return e.nameSource === 'agent' ? 2 : e.nameSource === 'route' ? 1 : 0;
}

/**
 * Merge `victim` into `target`: union edges/aliases/locator-cache, adopt
 * agent-bound names, repoint edges across the whole store, delete the victim.
 */
function mergeEntries(
  appId: string,
  target: ScreenMapEntry,
  victim: ScreenMapEntry,
  all: ScreenMapEntry[],
): void {
  if (victim.screenId === target.screenId) return;

  // Names: an agent-bound victim name beats an inferred target name
  if (victim.nameSource === 'agent' && target.nameSource !== 'agent') {
    const oldName = target.name;
    target.name = victim.name;
    target.nameSource = 'agent';
    addAlias(target, oldName);
  } else {
    addAlias(target, victim.name);
  }
  for (const a of victim.aliases ?? []) addAlias(target, a);

  // Edges: union by action, repoint self-references
  for (const edge of victim.edges) {
    const to = edge.toScreenId === victim.screenId ? target.screenId : edge.toScreenId;
    if (to === target.screenId && edge.toScreenId === victim.screenId) continue; // drop self-loop
    const exists = target.edges.some(e => e.action.by === edge.action.by && e.action.value === edge.action.value);
    if (!exists) target.edges.push({ ...edge, toScreenId: to });
  }

  // Route info + locator cache: fill gaps, target wins conflicts
  if (!target.routeName && victim.routeName) target.routeName = victim.routeName;
  if (!target.screenWidget && victim.screenWidget) target.screenWidget = victim.screenWidget;
  if (victim.resolvedLocators) {
    target.resolvedLocators = { ...victim.resolvedLocators, ...(target.resolvedLocators ?? {}) };
  }

  // Repoint edges in every other entry that referenced the victim
  for (const other of all) {
    if (other.screenId === victim.screenId || other.screenId === target.screenId) continue;
    let changed = false;
    for (const edge of other.edges) {
      if (edge.toScreenId === victim.screenId) {
        edge.toScreenId = target.screenId;
        edge.toScreenName = target.name;
        changed = true;
      }
    }
    if (changed) saveScreenMap(other);
  }

  // Session pointer may reference the merged-away id
  if (currentScreenId === victim.screenId) currentScreenId = target.screenId;

  deleteScreenMap(appId, victim.screenId);
  logger.info('Screen maps merged', { appId, kept: target.screenId, merged: victim.screenId, name: target.name });
}

/**
 * One-shot store maintenance: drop empty entries and merge structural
 * duplicates left over from the old text-based fingerprinting.
 * Safe to run repeatedly; called once per session on connect.
 */
export function consolidateScreenMaps(appId: string): { before: number; after: number } {
  let all = loadAllScreenMaps(appId);
  const before = all.length;

  // Drop ghost entries (empty element lists, e.g. the all-zero hash)
  for (const e of all) {
    if (!e.elements || e.elements.length === 0) deleteScreenMap(appId, e.screenId);
  }

  // Greedy pairwise merge until stable
  let merged = true;
  while (merged) {
    merged = false;
    all = loadAllScreenMaps(appId);
    outer: for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const score = screenSimilarity(entryTokens(all[i]), entryTokens(all[j]));
        if (score >= SCREEN_SIMILARITY_THRESHOLD) {
          // Keep the better-established entry
          const [target, victim] = pickMergeOrder(all[i], all[j]);
          mergeEntries(appId, target, victim, all);
          saveScreenMap(target);
          merged = true;
          break outer;
        }
      }
    }
  }

  const after = loadAllScreenMaps(appId).length;
  if (after !== before) {
    logger.info('Screen map store consolidated', { appId, before, after });
  }
  return { before, after };
}

function pickMergeOrder(a: ScreenMapEntry, b: ScreenMapEntry): [ScreenMapEntry, ScreenMapEntry] {
  if (rankNameSource(a) !== rankNameSource(b)) {
    return rankNameSource(a) > rankNameSource(b) ? [a, b] : [b, a];
  }
  if (a.edges.length !== b.edges.length) {
    return a.edges.length > b.edges.length ? [a, b] : [b, a];
  }
  return a.lastVerified >= b.lastVerified ? [a, b] : [b, a];
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

/**
 * Enrich a screen map entry with route information from Dart source.
 * Tries to match the screen name against known routes.
 */
export async function enrichScreenWithRoute(entry: ScreenMapEntry): Promise<void> {
  if (entry.routeName) return; // already enriched

  try {
    const config = loadConfig();
    const routeIndex = await getRouteIndex(config.flutterAppPath, config.flutterComponentsPath);
    if (!routeIndex) return;

    // Try matching by screen name
    const route = findRoute(routeIndex, entry.name);
    if (route) {
      entry.routeName = route.routeName;
      entry.screenWidget = route.screenWidget;
      saveScreenMap(entry);
    }
  } catch {
    // Non-critical — route enrichment is optional
  }
}

/**
 * Get all known routes from Dart source (for suggesting navigation targets).
 */
export async function getAvailableRoutes(): Promise<Array<{ routeName: string; screenWidget?: string }>> {
  try {
    const config = loadConfig();
    const routeIndex = await getRouteIndex(config.flutterAppPath, config.flutterComponentsPath);
    if (!routeIndex) return [];
    return routeIndex.routes.map(r => ({ routeName: r.routeName, screenWidget: r.screenWidget }));
  } catch {
    return [];
  }
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
  // One-shot store maintenance per connect: merge legacy duplicates
  try {
    consolidateScreenMaps(appId);
  } catch (error) {
    logger.debug('Screen map consolidation failed (non-critical)', { error: String(error) });
  }
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
  if (!screen) return null; // empty scan — don't record ghost screens or edges

  const previousScreenId = currentScreenId;

  // If screen changed and we know the action that caused it, record the edge
  if (previousScreenId && previousScreenId !== screen.screenId && lastAction) {
    addNavigationEdge(currentAppId, previousScreenId, lastAction, screen.screenId, screen.name);
  }

  currentScreenId = screen.screenId;
  lastAction = action || null;

  return screen;
}

// ── Per-screen locator cache ───────────────────────────────────────────────

/** Normalize a description string into a stable cache key. */
export function descriptionSlug(description: string): string {
  return description.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 60);
}

/**
 * Look up a previously-resolved locator for a description on the given screen.
 * Returns null on miss or if the cached entry is older than maxAgeMs (default 24h).
 */
export function getCachedLocator(
  appId: string,
  screenId: string,
  description: string,
  maxAgeMs = 86_400_000,
): ResolvedLocatorCache | null {
  const entry = loadScreenMap(appId, screenId);
  if (!entry?.resolvedLocators) return null;
  const hit = entry.resolvedLocators[descriptionSlug(description)];
  if (!hit) return null;
  if (Date.now() - new Date(hit.resolvedAt).getTime() > maxAgeMs) return null;
  return hit;
}

/**
 * Persist a successfully-resolved locator against the current screen so future
 * calls can skip the expensive verify round-trips.
 */
export function cacheResolvedLocator(
  appId: string,
  screenId: string,
  description: string,
  locator: Omit<ResolvedLocatorCache, 'resolvedAt'>,
): void {
  const entry = loadScreenMap(appId, screenId);
  if (!entry) return;
  if (!entry.resolvedLocators) entry.resolvedLocators = {};
  entry.resolvedLocators[descriptionSlug(description)] = {
    ...locator,
    resolvedAt: new Date().toISOString(),
  };
  saveScreenMap(entry);
}

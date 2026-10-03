/**
 * Route Parser — extracts route definitions from Dart route constants and router switch cases.
 *
 * Scans the configured Flutter app and component packages for *routes.dart and *router.dart.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { logger } from '../util/logger.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface RouteDef {
  routeName: string;        // e.g. '/home'
  constantName: string;     // e.g. 'homeRoute'
  screenWidget?: string;    // e.g. 'HomeScreen' (from router switch)
  filePath: string;
  line: number;
}

export interface RouteIndex {
  routes: RouteDef[];
  indexedAt: string;
}

// ── Cache ──────────────────────────────────────────────────────────────────

let cachedRouteIndex: RouteIndex | null = null;
let routeCacheTimestamp = 0;
const ROUTE_CACHE_TTL_MS = 60_000;

export function clearRouteCache(): void {
  cachedRouteIndex = null;
  routeCacheTimestamp = 0;
}

// ── Main entry point ───────────────────────────────────────────────────────

export async function getRouteIndex(
  flutterAppPath?: string,
  flutterComponentsPath?: string,
): Promise<RouteIndex | null> {
  if (!flutterAppPath && !flutterComponentsPath) return null;

  if (cachedRouteIndex && Date.now() - routeCacheTimestamp < ROUTE_CACHE_TTL_MS) {
    return cachedRouteIndex;
  }

  cachedRouteIndex = buildRouteIndex(flutterAppPath, flutterComponentsPath);
  routeCacheTimestamp = Date.now();
  return cachedRouteIndex;
}

function collectDartFilesNamed(root: string, fileRe: RegExp): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name === '.dart_tool' || name === 'build' || name === '.git') continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (fileRe.test(name)) found.push(full);
    }
  };
  if (existsSync(root)) walk(root);
  return found;
}

function buildRouteIndex(
  flutterAppPath?: string,
  flutterComponentsPath?: string,
): RouteIndex {
  const routes: RouteDef[] = [];
  const roots = [flutterAppPath, flutterComponentsPath].filter((p): p is string => !!p);

  // 1. Parse route constant files (route name → constant name mapping)
  const routesFilePaths = roots.flatMap((root) => collectDartFilesNamed(root, /routes\.dart$/i));

  const routeConstants = new Map<string, { constantName: string; routeName: string; line: number; filePath: string }>();

  for (const filePath of routesFilePaths) {
    const parsed = parseRouteConstants(filePath);
    for (const entry of parsed) {
      routeConstants.set(entry.constantName, entry);
    }
  }

  // 2. Parse router switch cases to find screen widget mappings
  const screenMappings = new Map<string, string>();
  for (const routerPath of roots.flatMap((root) => collectDartFilesNamed(root, /router\.dart$/i))) {
    const mappings = parseRouterSwitchCases(routerPath);
    for (const [constName, widgetName] of mappings) {
      screenMappings.set(constName, widgetName);
    }
  }

  // 3. Merge: combine constants + screen mappings
  for (const [constName, entry] of routeConstants) {
    routes.push({
      routeName: entry.routeName,
      constantName: constName,
      screenWidget: screenMappings.get(constName),
      filePath: entry.filePath,
      line: entry.line,
    });
  }

  logger.info('Route index built', { routeCount: routes.length });

  return {
    routes,
    indexedAt: new Date().toISOString(),
  };
}

// ── Route constants parser ─────────────────────────────────────────────────

// Pattern: static const String constantName = '/routeName';
const ROUTE_CONST_RE = /static\s+const\s+String\s+(\w+)\s*=\s*['"]([^'"]+)['"]/g;

function parseRouteConstants(filePath: string): Array<{ constantName: string; routeName: string; line: number; filePath: string }> {
  const results: Array<{ constantName: string; routeName: string; line: number; filePath: string }> = [];
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      ROUTE_CONST_RE.lastIndex = 0;
      const match = ROUTE_CONST_RE.exec(lines[i]);
      if (match) {
        results.push({
          constantName: match[1],
          routeName: match[2],
          line: i + 1,
          filePath,
        });
      }
    }
  } catch (e) {
    logger.debug('Failed to parse route constants', { filePath, error: String(e) });
  }
  return results;
}

// ── Router switch case parser ──────────────────────────────────────────────

/**
 * Parses `switch (routeName)` cases.
 * Maps Routes.constantName → the widget class being returned.
 */
function parseRouterSwitchCases(filePath: string): Map<string, string> {
  const mappings = new Map<string, string>();
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    let currentCase: string | null = null;

    for (const line of lines) {
      const caseMatch = line.match(/case\s+\w+\.(\w+)\s*:/);
      if (caseMatch) {
        currentCase = caseMatch[1];
        continue;
      }

      // Within a case block, look for widget construction
      if (currentCase) {
        // Match: return MaterialPageRoute(builder: ... => WidgetName( or new WidgetName(
        const widgetMatch = line.match(/(?:child|builder|settings).*?(?:=>|return)\s*(\w+Screen|\w+Widget|\w+Page|\w+Manager)\s*\(/);
        if (widgetMatch) {
          mappings.set(currentCase, widgetMatch[1]);
          currentCase = null;
          continue;
        }

        // Match simpler: WidgetName( on the next line after MaterialPageRoute
        const simpleWidget = line.match(/^\s*(?:return\s+)?(?:MaterialPageRoute|CupertinoPageRoute|PageRouteBuilder).*?(\w+Screen|\w+Widget|\w+Page)\s*\(/);
        if (simpleWidget) {
          mappings.set(currentCase, simpleWidget[1]);
          currentCase = null;
          continue;
        }

        // Reset if we hit another case or default
        if (line.match(/^\s*(case|default)\s/)) {
          currentCase = null;
        }
      }
    }
  } catch (e) {
    logger.debug('Failed to parse router switch cases', { filePath, error: String(e) });
  }
  return mappings;
}

// ── Search helpers ─────────────────────────────────────────────────────────

/** Find route by name or partial match */
export function findRoute(index: RouteIndex, query: string): RouteDef | null {
  const lower = query.toLowerCase();

  // Exact route name match
  const exact = index.routes.find(r => r.routeName === query || r.routeName === `/${query}`);
  if (exact) return exact;

  // Constant name match
  const byConst = index.routes.find(r => r.constantName.toLowerCase() === lower);
  if (byConst) return byConst;

  // Partial match
  return index.routes.find(r =>
    r.routeName.toLowerCase().includes(lower) ||
    r.constantName.toLowerCase().includes(lower) ||
    r.screenWidget?.toLowerCase().includes(lower),
  ) || null;
}

/** Get all available route names */
export function getAllRouteNames(index: RouteIndex): string[] {
  return index.routes.map(r => r.routeName);
}

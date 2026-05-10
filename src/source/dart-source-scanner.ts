/**
 * Dart Source Scanner — indexes ValueKey definitions, widget classes,
 * and semantics labels from Flutter Dart source code.
 *
 * Uses regex-based extraction (no Dart AST dependency).
 * Requires FLUTTER_APP_PATH and/or FLUTTER_COMPONENTS_PATH env vars.
 *
 * Conventions:
 *  - {FLUTTER_APP_PATH}/lib                    — main app source
 *  - {FLUTTER_APP_PATH}/lib/test_keys          — preferred ValueKey registry
 *  - {FLUTTER_COMPONENTS_PATH}/<pkg>/lib       — shared package source
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative, basename } from 'path';
import { logger } from '../util/logger.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ValueKeyDef {
  keyValue: string;
  dartClass: string;
  dartField: string;
  filePath: string;
  line: number;
  source: 'test_keys' | 'inline';
}

export interface WidgetClassDef {
  className: string;
  filePath: string;
  extendsType: string;
  line: number;
  keyValues: string[];
}

export interface DartSourceIndex {
  valueKeys: Map<string, ValueKeyDef[]>;
  widgetClasses: WidgetClassDef[];
  indexedAt: string;
  fileCount: number;
}

// ── Cache ──────────────────────────────────────────────────────────────────

let cachedIndex: DartSourceIndex | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000;

export function clearSourceIndexCache(): void {
  cachedIndex = null;
  cacheTimestamp = 0;
}

// ── Main entry point ───────────────────────────────────────────────────────

export async function getDartSourceIndex(
  flutterAppPath?: string,
  flutterComponentsPath?: string,
): Promise<DartSourceIndex | null> {
  if (!flutterAppPath && !flutterComponentsPath) return null;

  if (cachedIndex && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedIndex;
  }

  cachedIndex = buildDartSourceIndex(flutterAppPath, flutterComponentsPath);
  cacheTimestamp = Date.now();
  return cachedIndex;
}

export function buildDartSourceIndex(
  flutterAppPath?: string,
  flutterComponentsPath?: string,
): DartSourceIndex {
  const valueKeys = new Map<string, ValueKeyDef[]>();
  const widgetClasses: WidgetClassDef[] = [];
  let fileCount = 0;

  const addValueKey = (def: ValueKeyDef) => {
    const existing = valueKeys.get(def.keyValue) || [];
    existing.push(def);
    valueKeys.set(def.keyValue, existing);
  };

  // Priority 1: scan test_keys directory first (canonical key registry)
  if (flutterAppPath) {
    const testKeysDir = join(flutterAppPath, 'lib', 'test_keys');
    if (existsSync(testKeysDir)) {
      const dartFiles = collectDartFiles(testKeysDir);
      for (const filePath of dartFiles) {
        fileCount++;
        const defs = extractValueKeysFromFile(filePath, 'test_keys');
        for (const def of defs) addValueKey(def);
      }
    }

    // Priority 2: scan rest of {flutterAppPath}/lib
    const appLibDir = join(flutterAppPath, 'lib');
    if (existsSync(appLibDir)) {
      const dartFiles = collectDartFiles(appLibDir);
      for (const filePath of dartFiles) {
        // Skip test_keys (already scanned)
        if (filePath.includes('/test_keys/')) continue;
        fileCount++;
        const keyDefs = extractValueKeysFromFile(filePath, 'inline');
        for (const def of keyDefs) addValueKey(def);
        const classDefs = extractWidgetClasses(filePath);
        widgetClasses.push(...classDefs);
      }
    }
  }

  // Priority 3: scan Flutter component packages
  if (flutterComponentsPath && existsSync(flutterComponentsPath)) {
    const packages = readdirSync(flutterComponentsPath).filter(name => {
      const pkgDir = join(flutterComponentsPath, name);
      return statSync(pkgDir).isDirectory() && existsSync(join(pkgDir, 'lib'));
    });

    for (const pkg of packages) {
      const libDir = join(flutterComponentsPath, pkg, 'lib');
      const dartFiles = collectDartFiles(libDir);
      for (const filePath of dartFiles) {
        fileCount++;
        const keyDefs = extractValueKeysFromFile(filePath, 'inline');
        for (const def of keyDefs) addValueKey(def);
        const classDefs = extractWidgetClasses(filePath);
        widgetClasses.push(...classDefs);
      }
    }
  }

  logger.info('Dart source index built', {
    valueKeyCount: valueKeys.size,
    widgetClassCount: widgetClasses.length,
    fileCount,
  });

  return {
    valueKeys,
    widgetClasses,
    indexedAt: new Date().toISOString(),
    fileCount,
  };
}

// ── File collection ────────────────────────────────────────────────────────

function collectDartFiles(dir: string): string[] {
  const files: string[] = [];
  walkDir(dir, files);
  return files;
}

function walkDir(dir: string, files: string[]): void {
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      // Skip hidden dirs, build dirs, generated files
      if (entry.startsWith('.') || entry === 'build' || entry === '.dart_tool') continue;
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walkDir(fullPath, files);
        } else if (entry.endsWith('.dart') && !entry.endsWith('.g.dart') && !entry.endsWith('.freezed.dart')) {
          files.push(fullPath);
        }
      } catch { /* skip inaccessible files */ }
    }
  } catch { /* skip inaccessible dirs */ }
}

// ── ValueKey extraction ────────────────────────────────────────────────────

// Pattern for structured key definitions: static const fieldName = ValueKey('key_value');
const STRUCTURED_KEY_RE = /static\s+const\s+(\w+)\s*=\s*(?:const\s+)?ValueKey\s*\(\s*'([^']+)'\s*\)/g;

// Pattern for inline ValueKey usage: ValueKey('key_value') or Key('key_value')
const INLINE_KEY_RE = /(?:ValueKey|Key)\s*\(\s*'([^']+)'\s*\)/g;

function extractValueKeysFromFile(filePath: string, source: 'test_keys' | 'inline'): ValueKeyDef[] {
  const defs: ValueKeyDef[] = [];
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Find the current class context
    let currentClass = basename(filePath, '.dart');
    const classRe = /^class\s+(\w+)/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Track class context
      const classMatch = classRe.exec(line);
      if (classMatch) {
        currentClass = classMatch[1];
      }

      // Structured key definitions (higher priority)
      STRUCTURED_KEY_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = STRUCTURED_KEY_RE.exec(line)) !== null) {
        defs.push({
          keyValue: match[2],
          dartClass: currentClass,
          dartField: match[1],
          filePath,
          line: i + 1,
          source,
        });
      }

      // Inline key usage (only if no structured match found on this line)
      if (source === 'inline' && !line.includes('static const')) {
        INLINE_KEY_RE.lastIndex = 0;
        while ((match = INLINE_KEY_RE.exec(line)) !== null) {
          // Avoid duplicating keys already found by the structured pattern
          if (!defs.some(d => d.keyValue === match![1] && d.line === i + 1)) {
            defs.push({
              keyValue: match[1],
              dartClass: currentClass,
              dartField: '',
              filePath,
              line: i + 1,
              source,
            });
          }
        }
      }
    }
  } catch (e) {
    logger.debug('Failed to scan file for ValueKeys', { filePath, error: String(e) });
  }
  return defs;
}

// ── Widget class extraction ────────────────────────────────────────────────

const WIDGET_CLASS_RE = /^class\s+(\w+)\s+extends\s+(StatelessWidget|StatefulWidget|State<\w+>)/;

function extractWidgetClasses(filePath: string): WidgetClassDef[] {
  const defs: WidgetClassDef[] = [];
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const match = WIDGET_CLASS_RE.exec(lines[i]);
      if (match) {
        // Scan the next ~100 lines for ValueKey usage in this class
        const classBody = lines.slice(i, Math.min(i + 100, lines.length)).join('\n');
        const keyValues: string[] = [];
        INLINE_KEY_RE.lastIndex = 0;
        let km: RegExpExecArray | null;
        while ((km = INLINE_KEY_RE.exec(classBody)) !== null) {
          if (!keyValues.includes(km[1])) keyValues.push(km[1]);
        }

        defs.push({
          className: match[1],
          filePath,
          extendsType: match[2],
          line: i + 1,
          keyValues,
        });
      }
    }
  } catch (e) {
    logger.debug('Failed to scan file for widget classes', { filePath, error: String(e) });
  }
  return defs;
}

// ── Search helpers ─────────────────────────────────────────────────────────

/** Find ValueKey definitions matching a search term (fuzzy) */
export function searchValueKeys(
  index: DartSourceIndex,
  query: string,
): ValueKeyDef[] {
  const lower = query.toLowerCase().replace(/\s+/g, '_');
  const results: Array<ValueKeyDef & { relevance: number }> = [];

  for (const [keyValue, defs] of index.valueKeys) {
    const keyLower = keyValue.toLowerCase();

    // Exact match
    if (keyLower === lower) {
      for (const def of defs) results.push({ ...def, relevance: 1.0 });
      continue;
    }

    // Contains match
    if (keyLower.includes(lower) || lower.includes(keyLower)) {
      const relevance = lower.length / Math.max(keyLower.length, lower.length);
      for (const def of defs) results.push({ ...def, relevance: Math.max(0.5, relevance) });
      continue;
    }

    // Word overlap match
    const queryWords = lower.split('_').filter(w => w.length > 1);
    const keyWords = keyLower.split('_').filter(w => w.length > 1);
    const overlap = queryWords.filter(w => keyWords.some(kw => kw.includes(w) || w.includes(kw)));
    if (overlap.length > 0) {
      const relevance = overlap.length / Math.max(queryWords.length, 1);
      if (relevance >= 0.4) {
        for (const def of defs) results.push({ ...def, relevance });
      }
    }
  }

  // Sort by relevance, prefer test_keys source
  results.sort((a, b) => {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    if (a.source !== b.source) return a.source === 'test_keys' ? -1 : 1;
    return 0;
  });

  return results.slice(0, 10);
}

/** Find all ValueKeys defined near a given file/line (within contextLines) */
export function findNearbyValueKeys(
  index: DartSourceIndex,
  filePath: string,
  line: number,
  contextLines = 30,
): string[] {
  const nearby: string[] = [];
  for (const [keyValue, defs] of index.valueKeys) {
    for (const def of defs) {
      if (def.filePath === filePath && Math.abs(def.line - line) <= contextLines) {
        if (!nearby.includes(keyValue)) nearby.push(keyValue);
      }
    }
  }
  return nearby;
}

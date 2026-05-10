/**
 * Source Resolver — resolves Dart VM creationLocation paths to filesystem paths.
 *
 * The Dart VM returns creation locations as either:
 * - Package URIs: package:my_app/screens/MainScreen.dart
 * - Absolute paths: /Users/.../my_app/lib/screens/MainScreen.dart
 *
 * This module maps them to actual filesystem paths using FLUTTER_APP_PATH
 * and FLUTTER_COMPONENTS_PATH.
 *
 * Convention: the main app's pub package name is assumed to match
 * basename(FLUTTER_APP_PATH). For apps where the package name differs
 * from the directory name, you can either symlink or set FLUTTER_APP_PATH
 * to the package root containing pubspec.yaml + lib/.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { basename, join } from 'path';
import { logger } from '../util/logger.js';

// ── Package-to-path mapping ────────────────────────────────────────────────

interface PackageMapping {
  packageName: string;
  libPath: string;
}

let packageMappings: PackageMapping[] | null = null;

/**
 * Build package-to-filesystem mappings from the configured source paths.
 */
export function buildPackageMappings(
  flutterAppPath?: string,
  flutterComponentsPath?: string,
): PackageMapping[] {
  const mappings: PackageMapping[] = [];

  // The main app: package:<name>/ → {flutterAppPath}/lib/
  if (flutterAppPath) {
    const appLib = join(flutterAppPath, 'lib');
    if (existsSync(appLib)) {
      const packageName = readPubspecName(flutterAppPath) || basename(flutterAppPath);
      mappings.push({ packageName, libPath: appLib });
    }
  }

  // Flutter component packages: each subdir of FLUTTER_COMPONENTS_PATH is a pub package
  if (flutterComponentsPath && existsSync(flutterComponentsPath)) {
    try {
      const entries = readdirSync(flutterComponentsPath);
      for (const entry of entries) {
        const pkgDir = join(flutterComponentsPath, entry);
        try {
          if (!statSync(pkgDir).isDirectory()) continue;
          const libDir = join(pkgDir, 'lib');
          if (existsSync(libDir)) {
            const packageName = readPubspecName(pkgDir) || entry;
            mappings.push({ packageName, libPath: libDir });
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  packageMappings = mappings;
  return mappings;
}

/**
 * Resolve a Dart VM creationLocation file path to an actual filesystem path.
 *
 * Handles:
 * - package:<name>/x.dart → mapped lib/ + x.dart
 * - Absolute paths → returned as-is if they exist
 */
export function resolveCreationLocation(
  file: string,
  flutterAppPath?: string,
  flutterComponentsPath?: string,
): string | null {
  // Absolute path — check if it exists
  if (file.startsWith('/')) {
    return existsSync(file) ? file : null;
  }

  // Package URI: package:name/path.dart
  const packageMatch = file.match(/^package:([^/]+)\/(.+)$/);
  if (!packageMatch) return null;

  const [, packageName, relPath] = packageMatch;

  // Build mappings if not cached
  if (!packageMappings) {
    buildPackageMappings(flutterAppPath, flutterComponentsPath);
  }

  const mapping = packageMappings?.find(m => m.packageName === packageName);
  if (!mapping) return null;

  const resolved = join(mapping.libPath, relPath);
  return existsSync(resolved) ? resolved : null;
}

/**
 * Read source code surrounding a specific line.
 * Returns the lines before/after the target line for context.
 */
export function readWidgetSource(
  filePath: string,
  line: number,
  contextLines = 15,
): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    const startLine = Math.max(0, line - contextLines - 1);
    const endLine = Math.min(lines.length, line + contextLines);

    const snippet = lines
      .slice(startLine, endLine)
      .map((l, i) => {
        const lineNum = startLine + i + 1;
        const marker = lineNum === line ? ' → ' : '   ';
        return `${marker}${lineNum}: ${l}`;
      })
      .join('\n');

    return snippet;
  } catch (e) {
    logger.debug('Failed to read widget source', { filePath, line, error: String(e) });
    return null;
  }
}

/**
 * Clear cached package mappings (e.g., if paths change).
 */
export function clearPackageMappings(): void {
  packageMappings = null;
}

/**
 * Read the `name:` field from a pubspec.yaml. Returns null on any failure.
 */
function readPubspecName(packageDir: string): string | null {
  try {
    const pubspec = join(packageDir, 'pubspec.yaml');
    if (!existsSync(pubspec)) return null;
    const content = readFileSync(pubspec, 'utf-8');
    const match = content.match(/^name\s*:\s*([A-Za-z0-9_]+)/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

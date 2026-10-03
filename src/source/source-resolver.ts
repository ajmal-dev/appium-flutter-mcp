/**
 * Source Resolver — resolves Dart VM creationLocation paths to filesystem paths.
 *
 * The Dart VM returns creation locations as either:
 * - Package URIs: package:my_app/screens/MainScreen.dart
 * - Absolute paths: /path/to/my_app/lib/screens/MainScreen.dart
 *
 * This module maps them to filesystem paths using FLUTTER_APP_PATH
 * and FLUTTER_COMPONENTS_PATH. The app package name is read from pubspec.yaml.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { logger } from '../util/logger.js';

// ── Package-to-path mapping ────────────────────────────────────────────────

interface PackageMapping {
  packageName: string;
  libPath: string;
}

let packageMappings: PackageMapping[] | null = null;

function packageNameFromPubspec(dir: string): string | undefined {
  const pubspec = join(dir, 'pubspec.yaml');
  if (!existsSync(pubspec)) return undefined;
  const match = readFileSync(pubspec, 'utf8').match(/^name:\s*([A-Za-z0-9_]+)/m);
  return match?.[1];
}

/**
 * Build package-to-filesystem mappings from the configured source paths.
 */
export function buildPackageMappings(
  flutterAppPath?: string,
  flutterComponentsPath?: string,
): PackageMapping[] {
  const mappings: PackageMapping[] = [];

  if (flutterAppPath) {
    const appLib = join(flutterAppPath, 'lib');
    const packageName = packageNameFromPubspec(flutterAppPath);
    if (packageName && existsSync(appLib)) {
      mappings.push({ packageName, libPath: appLib });
    }
  }

  // Flutter component packages
  if (flutterComponentsPath && existsSync(flutterComponentsPath)) {
    try {
      const entries = readdirSync(flutterComponentsPath);
      for (const entry of entries) {
        const pkgDir = join(flutterComponentsPath, entry);
        try {
          if (!statSync(pkgDir).isDirectory()) continue;
          const libDir = join(pkgDir, 'lib');
          if (existsSync(libDir)) {
            mappings.push({ packageName: entry, libPath: libDir });
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
 * - package:my_app/x.dart → {FLUTTER_APP_PATH}/lib/x.dart
 * - package:shared_widgets/x.dart → {FLUTTER_COMPONENTS_PATH}/shared_widgets/lib/x.dart
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

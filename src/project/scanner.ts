/**
 * Project Scanner — analyzes an existing ZMA automation project to discover
 * page objects, their locators, and the project's folder structure.
 *
 * Used by the exporter to avoid creating duplicate page objects.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative, basename, extname } from 'path';

// ── Public types ─────────────────────────────────────────────────────────────

export interface ProjectStructure {
  /** Root path of the automation project */
  rootPath: string;
  /** Detected source root (e.g., src/main/java or src/test/java) */
  testSourceRoot: string | null;
  mainSourceRoot: string | null;
  /** Existing page object files */
  pageObjects: ExistingPageObject[];
  /** Existing test class files */
  testClasses: ExistingTestClass[];
  /** Base package name detected from project */
  basePackage: string | null;
  /** Page object directories found */
  pageDirectories: string[];
}

export interface ExistingPageObject {
  /** Full file path */
  filePath: string;
  /** Relative path from project root */
  relativePath: string;
  /** Java class name */
  className: string;
  /** Java package */
  packageName: string;
  /** Locator constants found (ValueKeys, selectors) */
  locators: ExistingLocator[];
  /** Action methods found */
  methods: string[];
  /** Whether it's a Flutter or WebView page */
  pageType: 'flutter' | 'webview' | 'native' | 'unknown';
}

export interface ExistingLocator {
  /** Constant name (e.g., KEY_LOGIN_BUTTON) */
  constantName: string;
  /** Locator value (e.g., "loginButton") */
  value: string;
  /** Strategy: key, text, css, xpath, accessibilityId */
  strategy: string;
}

export interface ExistingTestClass {
  filePath: string;
  relativePath: string;
  className: string;
  packageName: string;
}

// ── Scanner ──────────────────────────────────────────────────────────────────

export function scanProject(projectPath: string): ProjectStructure {
  if (!existsSync(projectPath)) {
    throw new Error(`Automation project path does not exist: ${projectPath}`);
  }

  const structure: ProjectStructure = {
    rootPath: projectPath,
    testSourceRoot: null,
    mainSourceRoot: null,
    pageObjects: [],
    testClasses: [],
    basePackage: null,
    pageDirectories: [],
  };

  // Detect source roots
  const testSrc = join(projectPath, 'src', 'test', 'java');
  const mainSrc = join(projectPath, 'src', 'main', 'java');

  if (existsSync(testSrc)) structure.testSourceRoot = testSrc;
  if (existsSync(mainSrc)) structure.mainSourceRoot = mainSrc;

  // Scan for page objects in both source roots
  const searchRoots: string[] = [];
  if (structure.mainSourceRoot) searchRoots.push(structure.mainSourceRoot);
  if (structure.testSourceRoot) searchRoots.push(structure.testSourceRoot);

  for (const root of searchRoots) {
    // Find page directories (folders named "pages", "page", "pageobjects", "pom")
    const pageDirs = findDirectoriesByName(root, ['pages', 'page', 'pageobjects', 'pom']);
    structure.pageDirectories.push(...pageDirs);

    // Scan page directories for Java files
    for (const pageDir of pageDirs) {
      const javaFiles = findJavaFiles(pageDir);
      for (const file of javaFiles) {
        const po = parsePageObject(file, projectPath);
        if (po) structure.pageObjects.push(po);
      }
    }

    // Find test classes (files ending with Test.java or Tests.java)
    const allJavaFiles = findJavaFiles(root);
    for (const file of allJavaFiles) {
      const name = basename(file, '.java');
      if (name.endsWith('Test') || name.endsWith('Tests')) {
        const tc = parseTestClass(file, projectPath);
        if (tc) structure.testClasses.push(tc);
      }
    }
  }

  // Detect base package from existing files
  if (structure.pageObjects.length > 0) {
    structure.basePackage = detectBasePackage(structure.pageObjects.map(p => p.packageName));
  } else if (structure.testClasses.length > 0) {
    structure.basePackage = detectBasePackage(structure.testClasses.map(t => t.packageName));
  }

  return structure;
}

// ── Page Object Parser ───────────────────────────────────────────────────────

function parsePageObject(filePath: string, projectRoot: string): ExistingPageObject | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const className = basename(filePath, '.java');
    const packageName = extractPackage(content) || '';
    const locators = extractLocators(content);
    const methods = extractMethods(content);
    const pageType = detectPageType(filePath, content);

    return {
      filePath,
      relativePath: relative(projectRoot, filePath),
      className,
      packageName,
      locators,
      methods,
      pageType,
    };
  } catch {
    return null;
  }
}

function parseTestClass(filePath: string, projectRoot: string): ExistingTestClass | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return {
      filePath,
      relativePath: relative(projectRoot, filePath),
      className: basename(filePath, '.java'),
      packageName: extractPackage(content) || '',
    };
  } catch {
    return null;
  }
}

function extractPackage(content: string): string | null {
  const match = content.match(/^\s*package\s+([\w.]+)\s*;/m);
  return match ? match[1] : null;
}

function extractLocators(content: string): ExistingLocator[] {
  const locators: ExistingLocator[] = [];

  // Match static final String constants that look like locators
  const constRegex = /(?:private|public|protected)?\s*static\s+final\s+String\s+(\w+)\s*=\s*"([^"]+)"\s*;/g;
  let match;
  while ((match = constRegex.exec(content)) !== null) {
    const constantName = match[1];
    const value = match[2];
    const strategy = inferStrategy(constantName, value, content);
    locators.push({ constantName, value, strategy });
  }

  // Also match inline locator usages: byValueKey("..."), byText("..."), etc.
  const inlineKeyRegex = /byValueKey\s*\(\s*"([^"]+)"\s*\)/g;
  while ((match = inlineKeyRegex.exec(content)) !== null) {
    const value = match[1];
    if (!locators.some(l => l.value === value)) {
      locators.push({ constantName: '', value, strategy: 'key' });
    }
  }

  const inlineTextRegex = /byText\s*\(\s*"([^"]+)"\s*\)/g;
  while ((match = inlineTextRegex.exec(content)) !== null) {
    const value = match[1];
    if (!locators.some(l => l.value === value)) {
      locators.push({ constantName: '', value, strategy: 'text' });
    }
  }

  return locators;
}

function extractMethods(content: string): string[] {
  const methods: string[] = [];
  const methodRegex = /public\s+\w+\s+(\w+)\s*\(/g;
  let match;
  while ((match = methodRegex.exec(content)) !== null) {
    const name = match[1];
    // Skip constructor and standard methods
    if (name !== content.match(/class\s+(\w+)/)?.[1] && name !== 'toString' && name !== 'equals' && name !== 'hashCode') {
      methods.push(name);
    }
  }
  return methods;
}

function detectPageType(filePath: string, content: string): 'flutter' | 'webview' | 'native' | 'unknown' {
  const lowerPath = filePath.toLowerCase();
  if (lowerPath.includes('/flutter/') || lowerPath.includes('flutter')) {
    return 'flutter';
  }
  if (lowerPath.includes('/webview/') || lowerPath.includes('/web/')) {
    return 'webview';
  }
  if (lowerPath.includes('/native/')) {
    return 'native';
  }

  // Infer from content
  if (content.includes('byValueKey') || content.includes('byText') || content.includes('bySemanticsLabel')) {
    return 'flutter';
  }
  if (content.includes('switchToWebView') || content.includes('webFindByCss') || content.includes('webFindByXPath')) {
    return 'webview';
  }
  if (content.includes('nativeFindByAccessibilityId') || content.includes('nativeFindByXPath')) {
    return 'native';
  }

  return 'unknown';
}

function inferStrategy(constantName: string, value: string, content: string): string {
  const upper = constantName.toUpperCase();

  // Check constant naming hints
  if (upper.startsWith('KEY_') || upper.includes('_KEY')) return 'key';
  if (upper.startsWith('TEXT_') || upper.includes('_TEXT')) return 'text';
  if (upper.startsWith('CSS_') || upper.includes('_CSS')) return 'css';
  if (upper.startsWith('XPATH_') || upper.includes('_XPATH')) return 'xpath';
  if (upper.startsWith('ID_') || upper.includes('_ID')) return 'accessibilityId';

  // Check how the constant is used in the file
  if (content.includes(`byValueKey(${constantName})`) || content.includes(`byValueKey("${value}")`)) return 'key';
  if (content.includes(`byText(${constantName})`) || content.includes(`byText("${value}")`)) return 'text';
  if (content.includes(`webFindByCss(${constantName})`)) return 'css';
  if (content.includes(`webFindByXPath(${constantName})`)) return 'xpath';

  // Default: if it looks like a camelCase key, it's probably a Flutter key
  if (/^[a-z][a-zA-Z0-9]+$/.test(value)) return 'key';

  return 'unknown';
}

// ── Matching ─────────────────────────────────────────────────────────────────

/**
 * Find existing page objects that already contain the given locators.
 * Returns a map of locator value → existing page object that has it.
 */
export function findMatchingPages(
  existingPages: ExistingPageObject[],
  newLocators: Array<{ by: string; value: string }>,
): Map<string, ExistingPageObject> {
  const matches = new Map<string, ExistingPageObject>();

  for (const locator of newLocators) {
    for (const page of existingPages) {
      const hasLocator = page.locators.some(l =>
        l.value === locator.value ||
        l.value.toLowerCase() === locator.value.toLowerCase()
      );
      if (hasLocator) {
        matches.set(locator.value, page);
        break;
      }
    }
  }

  return matches;
}

/**
 * Find existing page objects whose name/purpose overlaps with a new page.
 * Uses class name similarity and locator overlap.
 */
export function findRelevantExistingPage(
  existingPages: ExistingPageObject[],
  newPageClassName: string,
  newLocators: Array<{ value: string }>,
): ExistingPageObject | null {
  // First: exact class name match
  const exactMatch = existingPages.find(p => p.className === newPageClassName);
  if (exactMatch) return exactMatch;

  // Second: significant locator overlap (>50% of new locators exist in a page)
  let bestMatch: ExistingPageObject | null = null;
  let bestOverlap = 0;

  for (const page of existingPages) {
    const existingValues = new Set(page.locators.map(l => l.value.toLowerCase()));
    const overlapCount = newLocators.filter(l => existingValues.has(l.value.toLowerCase())).length;
    const overlapRatio = newLocators.length > 0 ? overlapCount / newLocators.length : 0;

    if (overlapRatio > 0.5 && overlapCount > bestOverlap) {
      bestOverlap = overlapCount;
      bestMatch = page;
    }
  }

  return bestMatch;
}

// ── File system helpers ──────────────────────────────────────────────────────

function findDirectoriesByName(root: string, names: string[]): string[] {
  const results: string[] = [];
  const lowerNames = names.map(n => n.toLowerCase());

  function walk(dir: string, depth: number) {
    if (depth > 10) return; // prevent deep recursion
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry.startsWith('.') || entry === 'node_modules' || entry === 'build' || entry === 'target') continue;
        const fullPath = join(dir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            if (lowerNames.includes(entry.toLowerCase())) {
              results.push(fullPath);
            }
            walk(fullPath, depth + 1);
          }
        } catch { /* skip unreadable */ }
      }
    } catch { /* skip unreadable */ }
  }

  walk(root, 0);
  return results;
}

function findJavaFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(d: string, depth: number) {
    if (depth > 15) return;
    try {
      const entries = readdirSync(d);
      for (const entry of entries) {
        if (entry.startsWith('.')) continue;
        const fullPath = join(d, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            walk(fullPath, depth + 1);
          } else if (extname(entry) === '.java') {
            results.push(fullPath);
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  walk(dir, 0);
  return results;
}

function detectBasePackage(packages: string[]): string | null {
  if (packages.length === 0) return null;
  if (packages.length === 1) return packages[0];

  // Find longest common prefix of all packages
  const parts = packages.map(p => p.split('.'));
  const common: string[] = [];

  for (let i = 0; i < parts[0].length; i++) {
    const part = parts[0][i];
    if (parts.every(p => p[i] === part)) {
      common.push(part);
    } else {
      break;
    }
  }

  return common.length > 0 ? common.join('.') : null;
}

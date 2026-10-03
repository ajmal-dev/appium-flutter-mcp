/**
 * Project Exporter — takes generated test output and intelligently places it
 * into an existing ZMA automation project, respecting the Page Object Model.
 *
 * Key behaviors:
 *  - Scans existing page objects to avoid duplicates
 *  - Merges new locators/methods into existing pages when relevant
 *  - Only creates new page files when no existing page covers the elements
 *  - Places test classes in the correct test source directory
 *  - Respects the project's existing package structure
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import {
  scanProject,
  findRelevantExistingPage,
  type ProjectStructure,
  type ExistingPageObject,
} from './scanner.js';
import type { GeneratedTestOutput, GeneratedFile, MergeRequest } from '../recording/test-generator.js';

// ── Public types ─────────────────────────────────────────────────────────────

export interface ExportResult {
  success: boolean;
  projectPath: string;
  filesCreated: ExportedFile[];
  filesUpdated: ExportedFile[];
  filesSkipped: SkippedFile[];
  summary: string;
}

export interface ExportedFile {
  /** Absolute path where file was written */
  absolutePath: string;
  /** Relative path from project root */
  relativePath: string;
  /** What was done: created, updated */
  action: 'created' | 'updated';
  /** File type */
  type: 'test_class' | 'page_object';
}

export interface SkippedFile {
  fileName: string;
  reason: string;
  existingPage?: string;
}

// ── Main export function ─────────────────────────────────────────────────────

export function exportToProject(
  projectPath: string,
  generated: GeneratedTestOutput,
): ExportResult {
  // Scan the existing project
  const project = scanProject(projectPath);

  const result: ExportResult = {
    success: true,
    projectPath,
    filesCreated: [],
    filesUpdated: [],
    filesSkipped: [],
    summary: '',
  };

  // 1. Export test class
  exportTestClass(project, generated.testClass, result);

  // 2. Export page objects (with deduplication)
  for (const po of generated.pageObjects) {
    exportPageObject(project, po, generated, result);
  }

  // 3. Apply merge requests (new methods/constants on existing POs)
  if (generated.methodsToMerge) {
    for (const mr of generated.methodsToMerge) {
      applyMergeRequest(mr, result);
    }
  }

  // Build summary
  result.summary = buildExportSummary(result, project);

  return result;
}

// ── Test class export ────────────────────────────────────────────────────────

function exportTestClass(
  project: ProjectStructure,
  testClass: GeneratedFile,
  result: ExportResult,
): void {
  // Determine target directory
  const targetRoot = project.testSourceRoot || join(project.rootPath, 'src', 'test', 'java');
  const targetPath = join(targetRoot, ...testClass.filePath.replace('src/test/java/', '').split('/'));

  // Check if test class already exists
  if (existsSync(targetPath)) {
    // Don't overwrite existing tests — create with a suffix
    const baseName = testClass.fileName.replace('.java', '');
    const newName = `${baseName}_generated.java`;
    const newPath = targetPath.replace(testClass.fileName, newName);
    const newContent = testClass.content.replace(
      `public class ${baseName}`,
      `public class ${baseName}_generated`,
    );

    ensureDir(dirname(newPath));
    writeFileSync(newPath, newContent, 'utf-8');
    result.filesCreated.push({
      absolutePath: newPath,
      relativePath: newPath.replace(project.rootPath + '/', ''),
      action: 'created',
      type: 'test_class',
    });
  } else {
    ensureDir(dirname(targetPath));
    writeFileSync(targetPath, testClass.content, 'utf-8');
    result.filesCreated.push({
      absolutePath: targetPath,
      relativePath: targetPath.replace(project.rootPath + '/', ''),
      action: 'created',
      type: 'test_class',
    });
  }
}

// ── Page object export with deduplication ────────────────────────────────────

function exportPageObject(
  project: ProjectStructure,
  pageFile: GeneratedFile,
  generated: GeneratedTestOutput,
  result: ExportResult,
): void {
  const newClassName = pageFile.fileName.replace('.java', '');
  const newLocators = extractLocatorsFromGeneratedContent(pageFile.content);

  // Check if an existing page object already covers these elements
  const existingPage = findRelevantExistingPage(
    project.pageObjects,
    newClassName,
    newLocators,
  );

  if (existingPage) {
    // Found existing page — check if we need to add new locators/methods
    const newElements = findNewElements(existingPage, newLocators, pageFile.content);

    if (newElements.length === 0) {
      // Existing page already has everything — skip
      result.filesSkipped.push({
        fileName: pageFile.fileName,
        reason: `All locators already exist in ${existingPage.className}`,
        existingPage: existingPage.className,
      });
      return;
    }

    // Merge new elements into existing page
    const mergedContent = mergeIntoExistingPage(existingPage, newElements);
    if (mergedContent) {
      writeFileSync(existingPage.filePath, mergedContent, 'utf-8');
      result.filesUpdated.push({
        absolutePath: existingPage.filePath,
        relativePath: existingPage.relativePath,
        action: 'updated',
        type: 'page_object',
      });
    }
    return;
  }

  // No matching existing page — create new one
  const targetRoot = project.mainSourceRoot || project.testSourceRoot || join(project.rootPath, 'src', 'main', 'java');

  // Determine the best directory for the new page object
  const targetDir = findBestPageDirectory(project, pageFile, targetRoot);
  const targetPath = join(targetDir, pageFile.fileName);

  // If the target package differs from what was generated, update the package declaration
  let content = pageFile.content;
  const targetPackage = pathToPackage(targetDir, targetRoot);
  if (targetPackage) {
    content = content.replace(/^package\s+[\w.]+;/m, `package ${targetPackage};`);
  }

  ensureDir(targetDir);
  writeFileSync(targetPath, content, 'utf-8');
  result.filesCreated.push({
    absolutePath: targetPath,
    relativePath: targetPath.replace(project.rootPath + '/', ''),
    action: 'created',
    type: 'page_object',
  });
}

// ── Merge logic ──────────────────────────────────────────────────────────────

interface NewElement {
  /** The constant declaration line (e.g., private static final String KEY_X = "x";) */
  constantLine: string | null;
  /** The method block to add */
  methodBlock: string | null;
  /** The locator value */
  locatorValue: string;
}

function findNewElements(
  existingPage: ExistingPageObject,
  newLocators: Array<{ value: string }>,
  newContent: string,
): NewElement[] {
  const existingValues = new Set(existingPage.locators.map(l => l.value.toLowerCase()));
  const existingMethods = new Set(existingPage.methods.map(m => m.toLowerCase()));
  const newElements: NewElement[] = [];

  for (const locator of newLocators) {
    if (existingValues.has(locator.value.toLowerCase())) continue;

    // Extract the constant line and method block for this locator from the new content
    const constantLine = extractConstantForValue(newContent, locator.value);
    const methodBlock = extractMethodForValue(newContent, locator.value);

    // Check if the method already exists by name
    if (methodBlock) {
      const methodName = methodBlock.match(/public\s+\w+\s+(\w+)\s*\(/)?.[1];
      if (methodName && existingMethods.has(methodName.toLowerCase())) continue;
    }

    newElements.push({
      constantLine,
      methodBlock,
      locatorValue: locator.value,
    });
  }

  return newElements;
}

function mergeIntoExistingPage(
  existingPage: ExistingPageObject,
  newElements: NewElement[],
): string | null {
  try {
    let content = readFileSync(existingPage.filePath, 'utf-8');

    // Find insertion points
    const constantLines = newElements
      .map(e => e.constantLine)
      .filter((l): l is string => l !== null);

    const methodBlocks = newElements
      .map(e => e.methodBlock)
      .filter((b): b is string => b !== null);

    if (constantLines.length === 0 && methodBlocks.length === 0) return null;

    // Insert constants after the last existing constant (before constructor)
    if (constantLines.length > 0) {
      // Match both old-style WebDriver constructors and no-arg BasePage constructors
      const constructorMatch = content.match(/(\s+public\s+\w+\s*\()/);
      if (constructorMatch && constructorMatch.index !== undefined) {
        const insertPos = constructorMatch.index;
        const constantBlock = '\n    // --- New locators (auto-merged) ---\n' +
          constantLines.map(l => `    ${l.trim()}`).join('\n') + '\n';
        content = content.slice(0, insertPos) + constantBlock + content.slice(insertPos);
      }
    }

    // Insert methods before the closing brace of the class
    if (methodBlocks.length > 0) {
      const lastBrace = content.lastIndexOf('}');
      if (lastBrace > 0) {
        const methodsBlock = '\n    // --- New methods (auto-merged) ---\n\n' +
          methodBlocks.map(m => indentBlock(m.trim(), '    ')).join('\n\n') + '\n\n';
        content = content.slice(0, lastBrace) + methodsBlock + content.slice(lastBrace);
      }
    }

    return content;
  } catch {
    return null;
  }
}

// ── Merge request application ─────────────────────────────────────────────────

function applyMergeRequest(mr: MergeRequest, result: ExportResult): void {
  if (!existsSync(mr.targetFilePath)) return;
  if (mr.newConstants.length === 0 && mr.newMethods.length === 0) return;

  try {
    let content = readFileSync(mr.targetFilePath, 'utf-8');

    // Insert constants before the first method or constructor
    if (mr.newConstants.length > 0) {
      // Try to find insertion point: before constructor or first public method
      const insertMatch = content.match(/(\s+(?:public|@Override)\s+)/);
      if (insertMatch && insertMatch.index !== undefined) {
        const constantBlock = '\n    // --- New locators (auto-merged) ---\n' +
          mr.newConstants.join('\n') + '\n';
        content = content.slice(0, insertMatch.index) + constantBlock + content.slice(insertMatch.index);
      }
    }

    // Insert methods before the closing brace
    if (mr.newMethods.length > 0) {
      const lastBrace = content.lastIndexOf('}');
      if (lastBrace > 0) {
        const methodsBlock = '\n    // --- New methods (auto-merged) ---\n' +
          mr.newMethods.join('\n') + '\n\n';
        content = content.slice(0, lastBrace) + methodsBlock + content.slice(lastBrace);
      }
    }

    writeFileSync(mr.targetFilePath, content, 'utf-8');
    result.filesUpdated.push({
      absolutePath: mr.targetFilePath,
      relativePath: mr.targetFilePath.replace(/.*\/zmauiautomation\//, ''),
      action: 'updated',
      type: 'page_object',
    });
  } catch {
    // Non-critical — skip
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractLocatorsFromGeneratedContent(content: string): Array<{ value: string }> {
  const locators: Array<{ value: string }> = [];
  const seen = new Set<string>();

  // Extract from constants
  const constRegex = /static\s+final\s+String\s+\w+\s*=\s*"([^"]+)"/g;
  let match;
  while ((match = constRegex.exec(content)) !== null) {
    if (!seen.has(match[1])) {
      locators.push({ value: match[1] });
      seen.add(match[1]);
    }
  }

  // Extract from inline usage
  const inlineRegex = /by(?:ValueKey|Text|Type|SemanticsLabel|CssSelector|XPath)\s*\(\s*"([^"]+)"/g;
  while ((match = inlineRegex.exec(content)) !== null) {
    if (!seen.has(match[1])) {
      locators.push({ value: match[1] });
      seen.add(match[1]);
    }
  }

  return locators;
}

function extractConstantForValue(content: string, value: string): string | null {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`((?:private|public|protected)?\\s*static\\s+final\\s+String\\s+\\w+\\s*=\\s*"${escaped}"\\s*;)`);
  const match = content.match(regex);
  return match ? match[1].trim() : null;
}

function extractMethodForValue(content: string, value: string): string | null {
  // Find method that references this value
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const methodRegex = new RegExp(
    `(public\\s+\\w+\\s+\\w+\\s*\\([^)]*\\)\\s*\\{[^}]*${escaped}[^}]*\\})`,
    's',
  );
  const match = content.match(methodRegex);
  return match ? match[1] : null;
}

function findBestPageDirectory(
  project: ProjectStructure,
  pageFile: GeneratedFile,
  sourceRoot: string,
): string {
  const isFlutter = pageFile.filePath.includes('/flutter/');
  const isWebView = pageFile.filePath.includes('/webview/');
  const isNative = pageFile.filePath.includes('/nativeui/');

  // Prefer existing page directories of the same type
  for (const dir of project.pageDirectories) {
    if (isFlutter && dir.toLowerCase().includes('flutter')) return dir;
    if (isWebView && (dir.toLowerCase().includes('webview') || dir.toLowerCase().includes('web'))) return dir;
    if (isNative && (dir.toLowerCase().includes('nativeui') || dir.toLowerCase().includes('native'))) return dir;
  }

  // If there are any page directories, use the first one and create a subdirectory
  if (project.pageDirectories.length > 0) {
    const basePageDir = project.pageDirectories[0];
    if (isFlutter) return join(basePageDir, 'flutter');
    if (isWebView) return join(basePageDir, 'webview');
    if (isNative) return join(basePageDir, 'nativeui');
    return basePageDir;
  }

  // Fallback: create based on the generated file path
  const relPath = pageFile.filePath.replace(/^src\/(main|test)\/java\//, '');
  return join(sourceRoot, dirname(relPath));
}

function pathToPackage(dirPath: string, sourceRoot: string): string | null {
  if (!dirPath.startsWith(sourceRoot)) return null;
  const relative = dirPath.slice(sourceRoot.length + 1);
  return relative.replace(/\//g, '.') || null;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function indentBlock(text: string, indent: string): string {
  return text.split('\n').map(line => line ? indent + line : line).join('\n');
}

// ── Summary ──────────────────────────────────────────────────────────────────

function buildExportSummary(result: ExportResult, project: ProjectStructure): string {
  const lines: string[] = [];
  lines.push(`## Export to Project Complete`);
  lines.push('');
  lines.push(`**Project**: \`${result.projectPath}\``);
  lines.push(`**Existing pages scanned**: ${project.pageObjects.length}`);
  lines.push(`**Existing tests found**: ${project.testClasses.length}`);
  lines.push('');

  if (result.filesCreated.length > 0) {
    lines.push('### Files Created');
    for (const f of result.filesCreated) {
      const icon = f.type === 'test_class' ? 'Test' : 'Page';
      lines.push(`- **[${icon}]** \`${f.relativePath}\``);
    }
    lines.push('');
  }

  if (result.filesUpdated.length > 0) {
    lines.push('### Files Updated (Merged)');
    for (const f of result.filesUpdated) {
      lines.push(`- **[Page]** \`${f.relativePath}\` — new locators/methods added`);
    }
    lines.push('');
  }

  if (result.filesSkipped.length > 0) {
    lines.push('### Files Skipped (Already Covered)');
    for (const f of result.filesSkipped) {
      lines.push(`- **${f.fileName}** — ${f.reason}`);
      if (f.existingPage) {
        lines.push(`  - Existing page: \`${f.existingPage}\``);
      }
    }
    lines.push('');
  }

  if (result.filesCreated.length === 0 && result.filesUpdated.length === 0) {
    lines.push('> All generated page objects already exist in the project. No changes needed.');
  }

  return lines.join('\n');
}

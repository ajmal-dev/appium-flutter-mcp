/**
 * Code fix engine: applies fixes to zmauiautomation test/page object files.
 * Reuses project/scanner.ts to locate files.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../util/logger.js';
import type { FixProposal } from './types.js';

const DEFAULT_PROJECT_PATH = process.env.AUTOMATION_PROJECT_PATH || '/Users/ajmal/projects/zmauiautomation';

export interface FixResult {
  applied: boolean;
  file: string;
  diff: string;
  error?: string;
}

/**
 * Apply a fix proposal to the project source code.
 */
export function applyFix(proposal: FixProposal, projectPath: string = DEFAULT_PROJECT_PATH): FixResult {
  const filePath = proposal.file.startsWith('/')
    ? proposal.file
    : join(projectPath, proposal.file);

  if (!existsSync(filePath)) {
    return { applied: false, file: filePath, diff: '', error: `File not found: ${filePath}` };
  }

  try {
    const content = readFileSync(filePath, 'utf-8');

    switch (proposal.type) {
      case 'update_locator':
        return applyStringReplace(filePath, content, proposal);
      case 'update_coordinate':
        return applyStringReplace(filePath, content, proposal);
      case 'add_wait':
        return applyInsertBefore(filePath, content, proposal);
      case 'add_scroll':
        return applyInsertBefore(filePath, content, proposal);
      case 'change_context':
        return applyInsertBefore(filePath, content, proposal);
      case 'custom':
        return applyStringReplace(filePath, content, proposal);
      default:
        return { applied: false, file: filePath, diff: '', error: `Unknown fix type: ${proposal.type}` };
    }
  } catch (error) {
    return { applied: false, file: filePath, diff: '', error: String(error) };
  }
}

/**
 * Replace a string in the file.
 */
function applyStringReplace(filePath: string, content: string, proposal: FixProposal): FixResult {
  if (!content.includes(proposal.from)) {
    return {
      applied: false,
      file: filePath,
      diff: `String not found: "${proposal.from.substring(0, 80)}"`,
      error: 'Target string not found in file',
    };
  }

  const newContent = content.replace(proposal.from, proposal.to);
  writeFileSync(filePath, newContent, 'utf-8');

  const diff = `--- ${filePath}\n+++ ${filePath}\n@@ @@\n- ${proposal.from}\n+ ${proposal.to}`;
  logger.info('Fix applied', { type: proposal.type, file: filePath });

  return { applied: true, file: filePath, diff };
}

/**
 * Insert code before the target line/string.
 */
function applyInsertBefore(filePath: string, content: string, proposal: FixProposal): FixResult {
  // If `from` is in the content, insert `to` before it
  const target = proposal.from;
  if (!content.includes(target)) {
    // Try by line number
    if (proposal.line && proposal.line > 0) {
      const lines = content.split('\n');
      if (proposal.line <= lines.length) {
        const indent = lines[proposal.line - 1].match(/^(\s*)/)?.[1] || '        ';
        lines.splice(proposal.line - 1, 0, indent + proposal.to);
        writeFileSync(filePath, lines.join('\n'), 'utf-8');

        const diff = `--- ${filePath}\n+++ ${filePath}\n@@ line ${proposal.line} @@\n+ ${proposal.to}`;
        logger.info('Fix applied (by line number)', { type: proposal.type, file: filePath, line: proposal.line });
        return { applied: true, file: filePath, diff };
      }
    }
    return {
      applied: false,
      file: filePath,
      diff: '',
      error: `Target not found for insert: "${target.substring(0, 80)}"`,
    };
  }

  const indent = content.split(target)[0].split('\n').pop() || '        ';
  const newContent = content.replace(target, proposal.to + '\n' + indent + target);
  writeFileSync(filePath, newContent, 'utf-8');

  const diff = `--- ${filePath}\n+++ ${filePath}\n@@ @@\n+ ${proposal.to}\n  ${target}`;
  logger.info('Fix applied (insert before)', { type: proposal.type, file: filePath });

  return { applied: true, file: filePath, diff };
}

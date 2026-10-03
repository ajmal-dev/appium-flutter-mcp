/**
 * MCP tool handler for exporting generated tests to an automation project.
 *
 * Tool:
 *  - export_to_project — export generated test + page objects to the ZMA project,
 *    placing files in the correct directories and reusing existing page objects.
 */

import { z } from 'zod';
import { getActiveRecording, getLastRecording, stopRecording } from '../recording/recorder.js';
import { generateTestScript } from '../recording/test-generator.js';
import { exportToProject } from '../project/exporter.js';
import { scanProject } from '../project/scanner.js';
import { loadConfig } from '../util/config.js';
import type { McpToolResponse } from '../types.js';

// ── Schema ───────────────────────────────────────────────────────────────────

export const exportToProjectSchema = z.object({
  projectPath: z.string().optional()
    .describe('Path to the automation project root. If omitted, uses AUTOMATION_PROJECT_PATH from config.'),
  testClassName: z.string().optional()
    .describe('Override class name for generation'),
  testMethodName: z.string().optional()
    .describe('Override method name for generation'),
  testGroups: z.array(z.string()).optional()
    .describe('Override TestNG groups'),
  packageName: z.string().optional()
    .describe('Override Java package'),
  description: z.string().optional()
    .describe('Override test description'),
  dryRun: z.boolean().optional().default(false)
    .describe('If true, only scan the project and show what would be done without writing files'),
});

// ── Handler ──────────────────────────────────────────────────────────────────

export async function handleExportToProject(
  params: z.infer<typeof exportToProjectSchema>,
): Promise<McpToolResponse> {
  // Resolve project path
  const config = loadConfig();
  const projectPath = params.projectPath || config.automationProjectPath;

  if (!projectPath) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: true,
          message: 'No automation project path specified. Either provide "projectPath" parameter or set AUTOMATION_PROJECT_PATH in your .env file.',
        }, null, 2),
      }],
    };
  }

  // Get the recording
  let recording = getActiveRecording();
  if (recording && !recording.stoppedAt) {
    recording = stopRecording();
  }
  if (!recording) {
    recording = getLastRecording();
  }

  if (!recording) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: true,
          message: 'No recording available. Start a recording with start_recording, perform actions, then use export_to_project.',
        }),
      }],
    };
  }

  // Apply overrides
  if (params.testClassName) recording.metadata.testClassName = params.testClassName;
  if (params.testMethodName) recording.metadata.testMethodName = params.testMethodName;
  if (params.testGroups) recording.metadata.testGroups = params.testGroups;
  if (params.packageName) recording.metadata.packageName = params.packageName;
  if (params.description) recording.metadata.description = params.description;

  try {
    // Generate test scripts
    const generated = generateTestScript(recording);

    if (params.dryRun) {
      // Dry run: scan project and show what would happen
      return handleDryRun(projectPath, generated);
    }

    // Export to project
    const result = exportToProject(projectPath, generated);

    // Build response with both the generated code and export results
    const output: string[] = [];
    output.push(result.summary);
    output.push('');
    output.push('---');
    output.push('');

    // Show generated test class
    output.push(`### ${generated.testClass.fileName}`);
    output.push('```java');
    output.push(generated.testClass.content);
    output.push('```');

    // Show generated page objects
    for (const po of generated.pageObjects) {
      output.push('');
      output.push(`### ${po.fileName}`);
      output.push('```java');
      output.push(po.content);
      output.push('```');
    }

    return {
      content: [{
        type: 'text',
        text: output.join('\n'),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: true, message: `Export failed: ${String(error)}` }),
      }],
    };
  }
}

// ── Dry run ──────────────────────────────────────────────────────────────────

function handleDryRun(
  projectPath: string,
  generated: ReturnType<typeof generateTestScript>,
): McpToolResponse {
  try {
    const project = scanProject(projectPath);

    const output: string[] = [];
    output.push('## Dry Run — Export Analysis');
    output.push('');
    output.push(`**Project**: \`${projectPath}\``);
    output.push(`**Test source root**: \`${project.testSourceRoot || 'not found'}\``);
    output.push(`**Main source root**: \`${project.mainSourceRoot || 'not found'}\``);
    output.push(`**Base package**: \`${project.basePackage || 'unknown'}\``);
    output.push('');

    // Show existing page objects
    if (project.pageObjects.length > 0) {
      output.push('### Existing Page Objects');
      for (const po of project.pageObjects) {
        output.push(`- **${po.className}** (${po.pageType}) — ${po.locators.length} locators, ${po.methods.length} methods`);
        output.push(`  - Path: \`${po.relativePath}\``);
        if (po.locators.length > 0) {
          const locatorList = po.locators.slice(0, 5).map(l => `\`${l.value}\``).join(', ');
          const more = po.locators.length > 5 ? ` +${po.locators.length - 5} more` : '';
          output.push(`  - Locators: ${locatorList}${more}`);
        }
      }
      output.push('');
    } else {
      output.push('### No Existing Page Objects Found');
      output.push('All page objects will be newly created.');
      output.push('');
    }

    // Show what would be generated
    output.push('### Files to Generate');
    output.push(`1. **Test Class**: \`${generated.testClass.fileName}\` → \`${generated.testClass.filePath}\``);
    for (const po of generated.pageObjects) {
      output.push(`2. **Page Object**: \`${po.fileName}\` → \`${po.filePath}\``);
    }
    output.push('');

    // Show overlap analysis
    if (project.pageObjects.length > 0 && generated.pageObjects.length > 0) {
      output.push('### Overlap Analysis');
      for (const po of generated.pageObjects) {
        const newClassName = po.fileName.replace('.java', '');
        const newLocators = extractLocatorsFromContent(po.content);

        // Check for matches
        let matchInfo = 'No matching existing page — will create new file';
        for (const existing of project.pageObjects) {
          const existingValues = new Set(existing.locators.map(l => l.value.toLowerCase()));
          const overlap = newLocators.filter(l => existingValues.has(l.toLowerCase()));

          if (existing.className === newClassName) {
            matchInfo = `Exact class name match: \`${existing.className}\` — will merge new locators`;
            break;
          }
          if (overlap.length > 0) {
            const ratio = Math.round((overlap.length / newLocators.length) * 100);
            if (ratio > 50) {
              matchInfo = `${ratio}% locator overlap with \`${existing.className}\` — will merge into existing page`;
            } else {
              matchInfo = `${ratio}% locator overlap with \`${existing.className}\` — will create new page (overlap below threshold)`;
            }
          }
        }
        output.push(`- **${po.fileName}**: ${matchInfo}`);
      }
      output.push('');
    }

    output.push('> Run without `dryRun: true` to execute the export.');

    return {
      content: [{
        type: 'text',
        text: output.join('\n'),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: true, message: `Dry run failed: ${String(error)}` }),
      }],
    };
  }
}

function extractLocatorsFromContent(content: string): string[] {
  const locators: string[] = [];
  const regex = /by(?:ValueKey|Text|Type|SemanticsLabel)\s*\(\s*"([^"]+)"/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    locators.push(match[1]);
  }
  return locators;
}

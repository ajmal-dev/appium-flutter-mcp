/**
 * MCP tools for the test-debug-fix feedback loop.
 * Tools: run_zma_tests, diagnose_failure, apply_fix
 */

import { z } from 'zod';
import { execSync } from 'child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../util/logger.js';
import { parseTestResults, readScreenshotBase64 } from '../debug/result-parser.js';
import { diagnoseFailure } from '../debug/diagnose.js';
import { applyFix } from '../debug/fixer.js';
import type { McpToolResponse } from '../types.js';
import type { FixProposal } from '../debug/types.js';

const DEFAULT_PROJECT_PATH = process.env.AUTOMATION_PROJECT_PATH || '';

// --- Schemas ---

export const runZmaTestsSchema = z.object({
  projectPath: z.string().optional().describe('Path to zmauiautomation project'),
  testClass: z.string().optional().describe('Specific test class to run (short name, e.g. "CameraAndGalleryValidationTest")'),
  testMethod: z.string().optional().describe('Specific test method to run'),
  groups: z.array(z.string()).optional().describe('TestNG groups to include'),
  debugMode: z.boolean().optional().default(false).describe('Keep driver alive on failure for debugging'),
  suiteXmlFile: z.string().optional().describe('TestNG suite XML to run (default: testng.xml). Passed as -DsuiteXmlFile.'),
  platform: z.string().optional().describe(
    'Profile from zenapp-config.yaml — maps to -Dzena.profile (e.g. "ios-device" = physical iPad, "ios-simulator" = simulator, "android"). ' +
    'REQUIRED in practice: if the user did not say which device/platform, ASK THE USER first. ' +
    'When omitted, the tool does not run — it returns the list of available profiles to choose from.'),
});

export const diagnoseFailureSchema = z.object({
  failureReportPath: z.string().optional().describe('Path to failure report JSON file'),
  testClass: z.string().optional().describe('Test class name to find failure report'),
  testMethod: z.string().optional().describe('Test method name to find failure report'),
  projectPath: z.string().optional().describe('Path to zmauiautomation project'),
});

export const applyFixSchema = z.object({
  fixType: z.enum(['update_locator', 'add_wait', 'update_coordinate', 'add_scroll', 'change_context', 'custom'])
    .describe('Type of fix to apply'),
  file: z.string().describe('File path relative to project root'),
  line: z.number().optional().describe('Line number for the fix'),
  from: z.string().describe('Original code/string to replace'),
  to: z.string().describe('New code/string'),
  projectPath: z.string().optional().describe('Path to zmauiautomation project'),
});

// --- Core Maven runner (reusable by full-pipeline) ---

export interface MavenSuiteOpts {
  projectPath: string;
  testClass?: string;
  testMethod?: string;
  debugMode?: boolean;
  suiteXmlFile?: string;
  /** Platform config (-Dplatform): selects config/<platform>.properties; overrides the testng.xml parameter. */
  platform?: string;
}

export interface MavenSuiteResult {
  output: string;
  results: ReturnType<typeof parseTestResults>;
}

export async function runMavenSuite(opts: MavenSuiteOpts): Promise<MavenSuiteResult> {
  const { projectPath, testClass, testMethod, debugMode, suiteXmlFile, platform } = opts;

  // Multi-module project: always use -pl zenappautomation-tests -am
  // Profile is -Dzena.profile (zenapp-config.yaml), not the old -Dplatform
  const baseCmd = 'mvn -pl zenappautomation-tests -am';

  let mvnCmd: string;
  if (testClass) {
    // Run a specific test class/method directly
    const method = testMethod ? `#${testMethod}` : '';
    mvnCmd = `${baseCmd} test -Dtest=${testClass}${method}`;
  } else if (suiteXmlFile && suiteXmlFile !== 'testng.xml') {
    mvnCmd = `${baseCmd} test -DsuiteXmlFile=${suiteXmlFile}`;
  } else {
    mvnCmd = `${baseCmd} test`;
  }

  // -Dzena.profile selects the device profile from zenapp-config.yaml
  if (platform) mvnCmd += ` -Dzena.profile=${platform}`;

  if (debugMode) mvnCmd += ' -Dtest.debug.keepAlive=true';

  let output = '';
  try {
    output = execSync(mvnCmd, {
      cwd: projectPath,
      timeout: 1_800_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    output = e.stdout || e.stderr || String(e);
  }

  return { output, results: parseTestResults(projectPath) };
}

/**
 * Discover available profiles from zenapp-config.yaml (the new config system).
 * Each top-level key under `profiles:` is a valid -Dzena.profile value.
 * Falls back to hardcoded defaults if YAML is unreadable.
 */
export function listAvailablePlatforms(projectPath: string): Array<{
  platform: string;
  deviceName?: string;
  udid?: string;
}> {
  const yamlPath = join(projectPath, 'zenappautomation-tests', 'src', 'test', 'resources', 'zenapp-config.yaml');
  if (existsSync(yamlPath)) {
    try {
      const content = readFileSync(yamlPath, 'utf-8');
      const profileMatches = [...content.matchAll(/^  ([\w-]+):\s*$/gm)];
      if (profileMatches.length > 0) {
        return profileMatches.map(m => {
          const profile = m[1];
          const deviceName = content.match(new RegExp(`name:\\s*(.+)`, 'm'))?.[1]?.trim();
          const udid = content.match(new RegExp(`udid:\\s*(.+)`, 'm'))?.[1]?.trim();
          return { platform: profile, deviceName, udid };
        });
      }
    } catch { /* fall through to defaults */ }
  }
  // Hardcoded defaults matching the known profiles in zenapp-config.yaml
  return [
    { platform: 'ios-device', deviceName: 'iPad (10th generation)', udid: '00008101-000238222EA3A01E' },
    { platform: 'ios-simulator', deviceName: 'iPad Pro 13-inch (M4)' },
    { platform: 'android', deviceName: 'Android Emulator' },
  ];
}

// --- Handlers ---

export async function handleRunZmaTests(params: z.infer<typeof runZmaTestsSchema>): Promise<McpToolResponse> {
  const projectPath = params.projectPath || DEFAULT_PROJECT_PATH;

  // Platform gate: never silently pick a device. If the caller didn't specify,
  // list the available platform configs and ask the user to choose one.
  if (!params.platform) {
    const platforms = listAvailablePlatforms(projectPath);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          needsInput: 'platform',
          message: 'Which platform should the tests run on? Ask the user to pick one, then call run_zma_tests again with the "platform" parameter set.',
          availablePlatforms: platforms,
          hint: platforms.map(p => p.platform === 'ios'
            ? 'ios = physical iPad'
            : p.platform === 'ios-simulator'
              ? 'ios-simulator = iOS simulator'
              : p.platform).join(' | '),
        }, null, 2),
      }],
    };
  }

  logger.info('Running ZMA tests', {
    projectPath, testClass: params.testClass, debugMode: params.debugMode,
    platform: params.platform, suiteXmlFile: params.suiteXmlFile,
  });

  try {
    const { results } = await runMavenSuite({
      projectPath,
      testClass: params.testClass,
      testMethod: params.testMethod,
      debugMode: params.debugMode,
      suiteXmlFile: params.suiteXmlFile,
      platform: params.platform,
    });

    const content: McpToolResponse['content'] = [];

    content.push({
      type: 'text' as const,
      text: JSON.stringify({
        summary: `Tests: ${results.totalTests} | Passed: ${results.passed} | Failed: ${results.failed} | Skipped: ${results.skipped}`,
        durationMs: results.durationMs,
        tests: results.tests,
        failureReports: results.failureReports.map(r => ({
          testMethod: r.testMethod,
          exception: r.exception,
          lastAction: r.lastAction,
          lastPageObject: r.lastPageObject,
          actionHistory: r.actionHistory,
          stepLog: r.stepLog,
          sessionId: r.sessionId,
          screenshotPath: r.screenshotPath,
        })),
      }, null, 2),
    });

    for (const report of results.failureReports) {
      if (report.screenshotPath) {
        const base64 = readScreenshotBase64(report.screenshotPath, projectPath);
        if (base64) {
          content.push({ type: 'image' as const, data: base64, mimeType: 'image/png' });
        }
      }
    }

    return { content };

  } catch (error) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: true, message: `Failed to run tests: ${String(error)}` }),
      }],
    };
  }
}

export async function handleDiagnoseFailure(params: z.infer<typeof diagnoseFailureSchema>): Promise<McpToolResponse> {
  const projectPath = params.projectPath || DEFAULT_PROJECT_PATH;

  try {
    // Find the failure report
    let report;

    if (params.failureReportPath) {
      const fullPath = params.failureReportPath.startsWith('/')
        ? params.failureReportPath
        : join(projectPath, params.failureReportPath);
      report = JSON.parse(readFileSync(fullPath, 'utf-8'));
    } else {
      // Find by test class/method
      const results = parseTestResults(projectPath);
      report = results.failureReports.find(r =>
        (!params.testClass || r.testClass === params.testClass) &&
        (!params.testMethod || r.testMethod === params.testMethod)
      );
    }

    if (!report) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message: 'No failure report found' }) }],
      };
    }

    // Run diagnosis
    const diagnosis = await diagnoseFailure(report);

    const content: McpToolResponse['content'] = [];
    content.push({
      type: 'text' as const,
      text: JSON.stringify({
        rootCause: diagnosis.rootCause,
        confidence: diagnosis.confidence,
        evidence: diagnosis.evidence,
        suggestedFixes: diagnosis.suggestedFixes,
        failureContext: {
          testMethod: report.testMethod,
          lastAction: report.lastAction,
          actionHistory: report.actionHistory,
          stepLog: report.stepLog,
        },
      }, null, 2),
    });

    // Attach current screenshot
    if (diagnosis.currentScreenshot) {
      content.push({
        type: 'image' as const,
        data: diagnosis.currentScreenshot,
        mimeType: 'image/jpeg',
      });
    }

    return { content };

  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message: String(error) }) }],
    };
  }
}

export async function handleApplyFix(params: z.infer<typeof applyFixSchema>): Promise<McpToolResponse> {
  const projectPath = params.projectPath || DEFAULT_PROJECT_PATH;

  const proposal: FixProposal = {
    type: params.fixType,
    file: params.file,
    line: params.line,
    from: params.from,
    to: params.to,
    confidence: 1.0,
    description: `Manual fix: ${params.fixType}`,
  };

  const result = applyFix(proposal, projectPath);

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(result, null, 2),
    }],
  };
}

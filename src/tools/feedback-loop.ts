/**
 * High-level orchestration tool: test_debug_fix
 * Runs the full feedback loop: test → diagnose → fix → re-test
 */

import { z } from 'zod';
import { logger } from '../util/logger.js';
import { handleRunZmaTests, handleDiagnoseFailure, handleApplyFix, listAvailablePlatforms } from './debug-loop.js';
import { parseTestResults } from '../debug/result-parser.js';
import { diagnoseFailure } from '../debug/diagnose.js';
import { applyFix } from '../debug/fixer.js';
import type { McpToolResponse } from '../types.js';

export const testDebugFixSchema = z.object({
  projectPath: z.string().optional().describe('Path to zmauiautomation project'),
  testClass: z.string().optional().describe('Specific test class to run'),
  maxIterations: z.number().optional().default(3).describe('Maximum fix-and-retry iterations'),
  autoFix: z.boolean().optional().default(false).describe('Automatically apply fixes with confidence > 0.8'),
  platform: z.string().optional().describe(
    'Platform config (-Dplatform), e.g. "ios" (physical iPad), "ios-simulator", "android". ' +
    'If the user did not say which platform, ASK THE USER first — when omitted, the loop does not start.'),
});

export async function handleTestDebugFix(params: z.infer<typeof testDebugFixSchema>): Promise<McpToolResponse> {
  const projectPath = params.projectPath || process.env.AUTOMATION_PROJECT_PATH || '/Users/ajmal/projects/zmauiautomation';
  const maxIterations = params.maxIterations || 3;
  const autoFix = params.autoFix || false;

  // Platform gate — same contract as run_zma_tests: never silently pick a device.
  if (!params.platform) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          needsInput: 'platform',
          message: 'Which platform should the debug loop run on? Ask the user, then call test_debug_fix again with "platform" set.',
          availablePlatforms: listAvailablePlatforms(projectPath),
        }, null, 2),
      }],
    };
  }

  logger.info('Starting test-debug-fix loop', { projectPath, testClass: params.testClass, maxIterations, autoFix });

  const iterationResults: Array<{
    iteration: number;
    passed: number;
    failed: number;
    diagnoses: Array<{ testMethod: string; rootCause: string; confidence: number; evidence: string }>;
    fixes: Array<{ type: string; file: string; applied: boolean }>;
  }> = [];

  for (let i = 0; i < maxIterations; i++) {
    logger.info(`=== Iteration ${i + 1}/${maxIterations} ===`);

    // 1. Run tests
    const runResult = await handleRunZmaTests({
      projectPath,
      testClass: params.testClass,
      debugMode: true,
      platform: params.platform,
    });

    const results = parseTestResults(projectPath);

    if (results.failed === 0) {
      // All passed!
      iterationResults.push({
        iteration: i + 1,
        passed: results.passed,
        failed: 0,
        diagnoses: [],
        fixes: [],
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: 'ALL_PASSED',
            message: i === 0
              ? `All ${results.passed} tests passed on first run.`
              : `All tests passed after ${i} fix iteration(s).`,
            iterations: iterationResults,
          }, null, 2),
        }],
      };
    }

    // 2. Diagnose failures
    const diagnoses: typeof iterationResults[0]['diagnoses'] = [];
    const fixes: typeof iterationResults[0]['fixes'] = [];

    for (const failureReport of results.failureReports) {
      try {
        const diagnosis = await diagnoseFailure(failureReport);
        diagnoses.push({
          testMethod: failureReport.testMethod,
          rootCause: diagnosis.rootCause,
          confidence: diagnosis.confidence,
          evidence: diagnosis.evidence,
        });

        // 3. Auto-fix if enabled and confident
        if (autoFix) {
          for (const fix of diagnosis.suggestedFixes) {
            if (fix.confidence >= 0.8) {
              const result = applyFix(fix, projectPath);
              fixes.push({ type: fix.type, file: fix.file, applied: result.applied });
              logger.info('Auto-fix applied', { type: fix.type, file: fix.file, applied: result.applied });
            } else {
              logger.info('Fix skipped (low confidence)', { type: fix.type, confidence: fix.confidence });
            }
          }
        }
      } catch (error) {
        logger.warn('Diagnosis failed for test', { testMethod: failureReport.testMethod, error: String(error) });
        diagnoses.push({
          testMethod: failureReport.testMethod,
          rootCause: 'unknown',
          confidence: 0,
          evidence: `Diagnosis failed: ${String(error)}`,
        });
      }
    }

    iterationResults.push({
      iteration: i + 1,
      passed: results.passed,
      failed: results.failed,
      diagnoses,
      fixes,
    });

    // If no fixes were applied, stop iterating
    if (fixes.length === 0 || fixes.every(f => !f.applied)) {
      logger.info('No fixes applied — stopping loop');
      break;
    }
  }

  // Final summary
  const lastIteration = iterationResults[iterationResults.length - 1];
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        status: lastIteration.failed === 0 ? 'ALL_PASSED' : 'FAILURES_REMAIN',
        message: lastIteration.failed === 0
          ? `All tests passed after ${iterationResults.length} iteration(s).`
          : `${lastIteration.failed} test(s) still failing after ${iterationResults.length} iteration(s).`,
        iterations: iterationResults,
      }, null, 2),
    }],
  };
}

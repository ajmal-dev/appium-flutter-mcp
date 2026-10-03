/**
 * Parses ZMA test results: TestNG XML + JSON failure reports + screenshots.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../util/logger.js';
import type { FailureReport, TestRunResult, TestMethodResult } from './types.js';

const DEFAULT_PROJECT_PATH = process.env.AUTOMATION_PROJECT_PATH || '/Users/ajmal/projects/zmauiautomation';

/**
 * Parse the full test run results from a zmauiautomation project.
 */
export function parseTestResults(projectPath: string = DEFAULT_PROJECT_PATH): TestRunResult {
  const result: TestRunResult = {
    suiteName: 'Unknown',
    totalTests: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0,
    tests: [],
    failureReports: [],
  };

  // 1. Parse TestNG XML results
  const xmlPath = join(projectPath, 'target/surefire-reports/testng-results.xml');
  if (existsSync(xmlPath)) {
    try {
      const xml = readFileSync(xmlPath, 'utf-8');
      parseTestNGXml(xml, result);
    } catch (error) {
      logger.warn('Failed to parse testng-results.xml', { error: String(error) });
    }
  } else {
    logger.warn('testng-results.xml not found', { path: xmlPath });
  }

  // 2. Load JSON failure reports
  const failureDir = join(projectPath, 'target/failure-reports');
  if (existsSync(failureDir)) {
    try {
      const files = readdirSync(failureDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const content = readFileSync(join(failureDir, file), 'utf-8');
          const report: FailureReport = JSON.parse(content);
          result.failureReports.push(report);
        } catch (e) {
          logger.warn('Failed to parse failure report', { file, error: String(e) });
        }
      }
    } catch (e) {
      logger.warn('Failed to read failure-reports directory', { error: String(e) });
    }
  }

  logger.info('Test results parsed', {
    total: result.totalTests,
    passed: result.passed,
    failed: result.failed,
    skipped: result.skipped,
    failureReports: result.failureReports.length,
  });

  return result;
}

/**
 * Parse TestNG XML using regex (lightweight, no dependency needed).
 */
function parseTestNGXml(xml: string, result: TestRunResult): void {
  // Extract suite-level attributes
  const suiteMatch = xml.match(/<suite\s+name="([^"]*)"[^>]*duration-ms="(\d+)"/);
  if (suiteMatch) {
    result.suiteName = suiteMatch[1];
    result.durationMs = parseInt(suiteMatch[2], 10);
  }

  // Extract top-level counts
  const countsMatch = xml.match(/<testng-results[^>]*passed="(\d+)"[^>]*failed="(\d+)"[^>]*skipped="(\d+)"/);
  if (countsMatch) {
    result.passed = parseInt(countsMatch[1], 10);
    result.failed = parseInt(countsMatch[2], 10);
    result.skipped = parseInt(countsMatch[3], 10);
    result.totalTests = result.passed + result.failed + result.skipped;
  }

  // Extract individual test methods
  const methodRegex = /<test-method\s+([^>]+?)(?:\/>|>([\s\S]*?)<\/test-method>)/g;
  let methodMatch: RegExpExecArray | null;

  while ((methodMatch = methodRegex.exec(xml)) !== null) {
    const attrs = methodMatch[1];
    const body = methodMatch[2] || '';

    // Skip config methods (@Before/@After)
    const isConfig = getAttr(attrs, 'is-config');
    if (isConfig === 'true') continue;

    const status = getAttr(attrs, 'status') as 'PASS' | 'FAIL' | 'SKIP' || 'PASS';
    const className = getAttr(attrs, 'signature')?.split('(')[0]?.split('.').slice(0, -1).join('.') || '';
    const methodName = getAttr(attrs, 'name') || '';
    const durationMs = parseInt(getAttr(attrs, 'duration-ms') || '0', 10);
    const description = getAttr(attrs, 'description') || undefined;

    // Extract exception message from body
    let exceptionMessage: string | undefined;
    const exMatch = body.match(/<message>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/message>/);
    if (exMatch) {
      exceptionMessage = exMatch[1].trim().substring(0, 500);
    }

    const testMethod: TestMethodResult = {
      className,
      methodName,
      status,
      durationMs,
      description,
      exceptionMessage,
    };

    result.tests.push(testMethod);
  }
}

function getAttr(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`${name}="([^"]*)"`));
  return match ? match[1] : undefined;
}

/**
 * Read a failure screenshot as base64.
 */
export function readScreenshotBase64(screenshotPath: string, projectPath: string = DEFAULT_PROJECT_PATH): string | null {
  const fullPath = screenshotPath.startsWith('/') ? screenshotPath : join(projectPath, screenshotPath);
  try {
    if (existsSync(fullPath)) {
      return readFileSync(fullPath).toString('base64');
    }
  } catch (e) {
    logger.warn('Failed to read screenshot', { path: fullPath, error: String(e) });
  }
  return null;
}

/**
 * Read the test source file and extract the failing method's code.
 */
export function readTestSource(sourceFilePath: string, projectPath: string = DEFAULT_PROJECT_PATH): string | null {
  const fullPath = join(projectPath, sourceFilePath);
  try {
    if (existsSync(fullPath)) {
      return readFileSync(fullPath, 'utf-8');
    }
  } catch (e) {
    logger.warn('Failed to read test source', { path: fullPath, error: String(e) });
  }
  return null;
}

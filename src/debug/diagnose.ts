/**
 * Diagnosis engine: compares failure context with live device state
 * to determine root cause and suggest fixes.
 *
 * Reuses existing modules: healer.ts, fuzzy.ts, page-source-scanner.ts, tree-builder.ts
 */

import { getBrowser, getBrowserWithReconnect } from '../appium/session.js';
import { captureScreenshot } from '../util/screenshot.js';
import { pageSourceScan } from '../tree/page-source-scanner.js';
import { healLocator } from '../locator/healer.js';
import { enhancedSimilarity } from '../locator/fuzzy.js';
import { logger } from '../util/logger.js';
import { loadConfig } from '../util/config.js';
import { getDartSourceIndex, searchValueKeys, findNearbyValueKeys } from '../source/dart-source-scanner.js';
import { resolveCreationLocation, readWidgetSource } from '../source/source-resolver.js';
import type { FailureReport, Diagnosis, FixProposal, RootCause, ElementInfo } from './types.js';

/**
 * Diagnose a test failure by comparing failure context with live device state.
 */
export async function diagnoseFailure(report: FailureReport): Promise<Diagnosis> {
  logger.info('Diagnosing failure', { testMethod: report.testMethod, lastAction: report.lastAction });

  const fixes: FixProposal[] = [];
  let rootCause: RootCause = 'unknown';
  let confidence = 0;
  let evidence = '';

  // 1. Capture current device state
  let currentScreenshot: string | undefined;
  try {
    const browser = await getBrowserWithReconnect();
    const screenshot = await captureScreenshot(browser);
    currentScreenshot = screenshot.base64;
  } catch (e) {
    logger.warn('Failed to capture current screenshot', { error: String(e) });
  }

  // 2. Scan current elements on screen
  let currentElements: ElementInfo[] = [];
  try {
    const elements = await pageSourceScan(true);
    currentElements = elements.map(el => ({
      type: el.type,
      text: el.text,
      position: el.position,
      locator: el.locator,
    }));
  } catch (e) {
    logger.warn('Failed to scan current elements', { error: String(e) });
  }

  // 3. Check exception first — the exception message is the most direct signal
  const exceptionMsg = report.exception?.message || '';
  const exceptionType = report.exception?.type || '';
  const lastStep = report.stepLog?.[report.stepLog.length - 1] || '';

  if (exceptionType.includes('Assert') || exceptionMsg.includes('expected') || exceptionMsg.includes('AssertionError')) {
    // Assertion failure — analyze what was being asserted
    rootCause = 'assertion_failure';
    confidence = 0.9;
    evidence = `Assertion failed at step: "${lastStep}". ` +
      `Exception: ${exceptionMsg.substring(0, 300)}. ` +
      `The last action (${report.lastAction?.method || 'unknown'}) may have succeeded — ` +
      `the failure is in the assertion that followed.`;

    // Check if it's a page-load timing issue
    if (lastStep.toLowerCase().includes('assert') && lastStep.toLowerCase().includes('page')) {
      rootCause = 'timing_issue';
      evidence += ' This may be a page-load timing issue — the UI may not have been ready when the assertion ran.';
      fixes.push({
        type: 'add_wait',
        file: report.sourceFilePath || '',
        line: report.sourceLineNumber,
        from: '// before assertion',
        to: 'waitForPageLoaded(10); // Use polling wait instead of fixed delay',
        confidence: 0.8,
        description: 'Replace fixed wait with polling wait for page load',
      });
    }
  }

  // 4. Analyze based on last action (if no assertion failure found)
  if (rootCause === 'unknown' && report.lastAction) {
    const { method, locatorStrategy, locatorValue } = report.lastAction;

    if (method.includes('byText') || method.includes('byValueKey') || method.includes('byType') ||
        method.includes('waitForElement') || method.includes('existsByText')) {

      // Locator-based failure: check if the element exists now
      const locatorFound = await tryLocatorOnDevice(locatorStrategy, locatorValue);

      if (locatorFound) {
        // Element exists now but didn't at failure time → timing issue
        rootCause = 'timing_issue';
        confidence = 0.85;
        evidence = `Element ${locatorStrategy}="${locatorValue}" is NOW visible on device. ` +
          `At failure time it was not found — page was likely still loading.`;

        fixes.push({
          type: 'add_wait',
          file: report.sourceFilePath || '',
          line: report.sourceLineNumber,
          from: `// before ${method}("${locatorValue}")`,
          to: `waitFor(5); // Add wait before ${method}`,
          confidence: 0.8,
          description: 'Add wait before the failing action to allow page to load',
        });

      } else {
        // Element still not found → try fuzzy matching to find alternatives
        const alternatives = findAlternatives(locatorValue, currentElements);

        if (alternatives.length > 0) {
          rootCause = 'locator_changed';
          confidence = 0.85;
          const best = alternatives[0];
          evidence = `Element ${locatorStrategy}="${locatorValue}" not found. ` +
            `Best match: "${best.text || best.locator?.value}" (${best.type}) ` +
            `with similarity ${alternatives[0].similarity?.toFixed(2) || 'N/A'}`;

          fixes.push({
            type: 'update_locator',
            file: report.sourceFilePath || '',
            line: report.sourceLineNumber,
            from: `"${locatorValue}"`,
            to: `"${best.text || best.locator?.value}"`,
            confidence: alternatives[0].similarity || 0.5,
            description: `Update locator from "${locatorValue}" to "${best.text || best.locator?.value}"`,
          });
        } else {
          // No alternatives found — page might be wrong
          rootCause = 'app_state_wrong';
          confidence = 0.6;
          evidence = `Element ${locatorStrategy}="${locatorValue}" not found and no similar elements on screen. ` +
            `The app may be on a different page than expected. ` +
            `Current screen has ${currentElements.length} elements.`;
        }
      }

    } else if (method.includes('tapAt')) {
      // Coordinate-based action — but check if it's really the cause
      // If stepLog has entries AFTER this tap, the tap likely worked and
      // the failure is in a subsequent assertion
      const tapStepIndex = report.stepLog?.findIndex(s =>
        s.includes('Tapping') || s.includes('Tap ') || s.includes('Close')
      ) ?? -1;
      const stepsAfterTap = report.stepLog?.length
        ? report.stepLog.length - 1 - tapStepIndex
        : 0;

      if (stepsAfterTap > 2) {
        // Multiple steps after the tap — tap likely worked, failure is elsewhere
        rootCause = 'assertion_failure';
        confidence = 0.75;
        evidence = `Coordinate tap ${locatorValue} appears to have worked (${stepsAfterTap} steps followed). ` +
          `Actual failure at: "${lastStep}". Exception: ${exceptionMsg.substring(0, 200)}`;
      } else {
        rootCause = 'coordinate_drift';
        confidence = 0.7;
        evidence = `Coordinate tap ${locatorValue} may have missed the target. ` +
          `Last step: "${lastStep}". Verify the element position on the current screen.`;
      }

      // Try to find the expected element near those coordinates
      const [xStr, yStr] = locatorValue.split(',');
      const x = parseInt(xStr, 10);
      const y = parseInt(yStr, 10);

      const nearbyElements = currentElements.filter(el => {
        if (!el.position) return false;
        const cx = el.position.x + el.position.width / 2;
        const cy = el.position.y + el.position.height / 2;
        return Math.abs(cx - x) < 50 && Math.abs(cy - y) < 50;
      });

      if (nearbyElements.length > 0) {
        const nearest = nearbyElements[0];
        const newX = Math.round(nearest.position!.x + nearest.position!.width / 2);
        const newY = Math.round(nearest.position!.y + nearest.position!.height / 2);

        fixes.push({
          type: 'update_coordinate',
          file: report.sourceFilePath || '',
          from: `tapAt(${x}, ${y})`,
          to: `tapAt(${newX}, ${newY})`,
          confidence: 0.75,
          description: `Update coordinates from (${x},${y}) to (${newX},${newY}) — nearest element: ${nearest.type}`,
        });
      }
    }
  }

  // 5. Use screen detection from failure report
  if (report.detectedScreen && report.detectedScreen !== 'Unknown') {
    // Check if device is still on the same screen
    const expectedScreen = report.detectedScreen;
    let currentScreen = 'Unknown';

    // Probe known screen keys on live device
    const screenProbes: Record<string, string> = {
      'Login': 'login_button_settings',
      'Appointment Book': 'left_panel_tab_appointments',
      'Appointment Detail': 'bryntum_appt_label_guest_name',
      'Guest Profile': 'overview_guest_card_text_name',
      'Medical Record': 'guest_medical_button_intake_form',
      'Gallery': 'guest_gallery_button_filter',
      'Forms': 'guest_forms_button_filter',
    };

    for (const [screen, key] of Object.entries(screenProbes)) {
      if (await tryLocatorOnDevice('key', key)) {
        currentScreen = screen;
        break;
      }
    }

    if (currentScreen !== expectedScreen && currentScreen !== 'Unknown') {
      if (rootCause === 'unknown') {
        rootCause = 'app_state_wrong';
        confidence = 0.9;
      }
      evidence += ` Screen mismatch: app was on "${expectedScreen}" at failure, now on "${currentScreen}".`;
    } else if (currentScreen === expectedScreen) {
      evidence += ` App is still on "${currentScreen}" screen.`;
    }
  }

  // 5b. Report visible ValueKeys from failure time
  if (report.visibleValueKeys && report.visibleValueKeys.length > 0) {
    evidence += ` ValueKeys at failure: [${report.visibleValueKeys.join(', ')}].`;
  }

  // 6. Compare element counts between failure and current state
  if (report.pageSource) {
    const failureElementCount = (report.pageSource.match(/<XCUIElement/g) || []).length;
    if (failureElementCount < 5 && currentElements.length > 10) {
      evidence += ` Page was likely still loading at failure (${failureElementCount} elements then, ${currentElements.length} now).`;
      if (rootCause === 'unknown') {
        rootCause = 'page_not_loaded';
        confidence = 0.75;
      }
    }
  }

  // 7. Source code analysis (if FLUTTER_APP_PATH is configured)
  const config = loadConfig();
  if (config.flutterAppPath) {
    try {
      const sourceAnalysis = await analyzeWithSourceCode(report, rootCause, config.flutterAppPath, config.flutterComponentsPath);
      if (sourceAnalysis) {
        evidence += sourceAnalysis;
      }
    } catch (e) {
      logger.debug('Source analysis failed (non-critical)', { error: String(e) });
    }
  }

  const diagnosis: Diagnosis = {
    rootCause,
    confidence,
    evidence,
    currentScreenshot,
    suggestedFixes: fixes,
  };

  logger.info('Diagnosis complete', { rootCause, confidence, fixCount: fixes.length });
  return diagnosis;
}

/**
 * Try finding an element on the live device using the given locator.
 */
async function tryLocatorOnDevice(strategy: string, value: string): Promise<boolean> {
  try {
    const browser = await getBrowserWithReconnect();
    const strategyMap: Record<string, string> = {
      key: '-flutter key',
      text: '-flutter text',
      type: '-flutter type',
      semanticsLabel: '-flutter semantics label',
      xpath: 'xpath',
    };

    const appiumStrategy = strategyMap[strategy];
    if (!appiumStrategy) return false;

    const elements = await browser.findElements(appiumStrategy, value);
    return elements.length > 0;
  } catch {
    return false;
  }
}

/**
 * Find elements on the current screen that are similar to the target value.
 */
function findAlternatives(
  targetValue: string,
  currentElements: (ElementInfo & { similarity?: number })[],
): (ElementInfo & { similarity?: number })[] {
  const scored: (ElementInfo & { similarity: number })[] = [];

  for (const el of currentElements) {
    const textScore = el.text ? enhancedSimilarity(targetValue, el.text) : 0;
    const locatorScore = el.locator?.value ? enhancedSimilarity(targetValue, el.locator.value) : 0;
    const score = Math.max(textScore, locatorScore);

    if (score > 0.4) {
      scored.push({ ...el, similarity: score });
    }
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, 5);
}

/**
 * Analyze failure using Dart source code knowledge.
 * Returns additional evidence string or null.
 */
async function analyzeWithSourceCode(
  report: FailureReport,
  rootCause: RootCause,
  flutterAppPath: string,
  flutterComponentsPath?: string,
): Promise<string | null> {
  const index = await getDartSourceIndex(flutterAppPath, flutterComponentsPath);
  if (!index) return null;

  const parts: string[] = [];
  const locatorValue = report.lastAction?.locatorValue;

  if (locatorValue && report.lastAction?.locatorStrategy === 'key') {
    // Check if the ValueKey exists in source
    const defs = index.valueKeys.get(locatorValue);
    if (defs && defs.length > 0) {
      const def = defs[0];
      const shortPath = def.filePath.split('/').slice(-2).join('/');
      parts.push(` Source: key "${locatorValue}" defined at ${def.dartClass}.${def.dartField || '(inline)'} (${shortPath}:${def.line}).`);

      // Read surrounding source for conditional rendering clues
      const snippet = readWidgetSource(def.filePath, def.line, 5);
      if (snippet) {
        const hasConditional = /if\s*\(|Visibility\s*\(|Offstage\s*\(|visible\s*:|\.when\s*\(/i.test(snippet);
        if (hasConditional && rootCause === 'element_not_visible') {
          parts.push(` Widget has conditional rendering near line ${def.line} — element may be hidden by a visibility guard.`);
        }
      }

      // Find nearby keys for context
      const nearby = findNearbyValueKeys(index, def.filePath, def.line, 20);
      if (nearby.length > 1) {
        const others = nearby.filter(k => k !== locatorValue).slice(0, 5);
        if (others.length > 0) {
          parts.push(` Nearby keys in same widget: [${others.join(', ')}].`);
        }
      }
    } else {
      // Key NOT found in source — may have been renamed or removed
      parts.push(` Source: key "${locatorValue}" NOT found in Dart source — it may have been renamed or removed.`);

      // Try fuzzy search for similar keys
      const similar = searchValueKeys(index, locatorValue);
      if (similar.length > 0) {
        const suggestions = similar.slice(0, 3).map(s => s.keyValue);
        parts.push(` Similar keys found: [${suggestions.join(', ')}].`);
      }
    }
  }

  return parts.length > 0 ? parts.join('') : null;
}

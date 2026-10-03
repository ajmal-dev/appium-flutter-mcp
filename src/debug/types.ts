/**
 * TypeScript interfaces for the test-debug-fix feedback loop.
 * Mirrors the Java FailureReport POJO and defines diagnosis/fix types.
 */

/** Mirrors com.zma.automation.report.FailureReport */
export interface FailureReport {
  testClass: string;
  testMethod: string;
  description?: string;
  groups?: string[];

  exception?: {
    type: string;
    message: string;
    stackFrame?: string;
  };

  lastAction?: {
    method: string;
    locatorStrategy: string;
    locatorValue: string;
  };

  lastPageObject?: string;
  actionHistory?: string[];
  stepLog?: string[];

  appContext?: string;
  sessionId?: string;
  platform?: string;
  screenshotPath?: string;
  pageSource?: string;
  appiumLogs?: string[];

  durationMs: number;
  timestamp: string;

  sourceFilePath?: string;
  sourceLineNumber?: number;

  // Flutter state at failure (for Claude diagnosis)
  visibleValueKeys?: string[];
  detectedScreen?: string;
  flutterElementCount?: number;

  // Source-aware fields (populated when FLUTTER_APP_PATH is configured)
  widgetSourceSnippet?: string;
  widgetSourceFile?: string;
  nearbyValueKeys?: string[];
}

/** Summary of a test run parsed from testng-results.xml */
export interface TestRunResult {
  suiteName: string;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  tests: TestMethodResult[];
  failureReports: FailureReport[];
}

export interface TestMethodResult {
  className: string;
  methodName: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  durationMs: number;
  description?: string;
  groups?: string[];
  exceptionMessage?: string;
}

/** Root cause classification */
export type RootCause =
  | 'locator_changed'
  | 'timing_issue'
  | 'page_not_loaded'
  | 'element_not_visible'
  | 'coordinate_drift'
  | 'context_wrong'
  | 'app_state_wrong'
  | 'assertion_failure'
  | 'data_mismatch'
  | 'unknown';

/** Diagnosis result from comparing failure state vs live device */
export interface Diagnosis {
  rootCause: RootCause;
  confidence: number; // 0-1
  evidence: string;
  currentScreenshot?: string; // base64
  elementDiff?: {
    missing: ElementInfo[];
    added: ElementInfo[];
    changed: ElementInfo[];
  };
  suggestedFixes: FixProposal[];
}

export interface ElementInfo {
  type: string;
  text?: string;
  position?: { x: number; y: number; width: number; height: number };
  locator?: { by: string; value: string };
}

/** A proposed fix that can be applied to the test/page object code */
export interface FixProposal {
  type: 'update_locator' | 'add_wait' | 'update_coordinate' | 'add_scroll' | 'change_context' | 'custom';
  file: string;
  line?: number;
  from: string;
  to: string;
  confidence: number; // 0-1
  description: string;
}

/** Tracks an active debug-fix session */
export interface DebugSession {
  failureReport: FailureReport;
  diagnosis?: Diagnosis;
  appliedFixes: FixProposal[];
  rerunResult?: TestMethodResult;
  iteration: number;
}

/** Full feedback loop result */
export interface FeedbackLoopResult {
  projectPath: string;
  iterations: Array<{
    runResult: TestRunResult;
    diagnoses: Map<string, Diagnosis>;
    appliedFixes: FixProposal[];
  }>;
  finalResult: TestRunResult;
  totalDurationMs: number;
}

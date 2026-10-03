/**
 * ZMA Test Script Generator — converts recorded exploration actions
 * into Java test classes matching the ZMA automation framework patterns.
 *
 * Key behaviour:
 *  - Scans the target automation project FIRST to discover existing page objects
 *  - Maps recorded actions to existing PO methods (by locator value match)
 *  - Only generates new page objects / methods for truly unmapped actions
 *  - Test class references existing PO classes with their real method names
 *
 * Generates:
 *  - Test class extending BaseTest (with TestNG annotations, @BeforeClass, multi-method)
 *  - Page Object classes extending BasePage (only for new, unmapped elements)
 *  - Merge requests for new methods to add to existing page objects
 */

import type { Recording, RecordedAction } from './recorder.js';
import type { ExistingPageObject, ExistingLocator } from '../project/scanner.js';

// ── Public API ───────────────────────────────────────────────────────────────

export interface GeneratedTestOutput {
  testClass: GeneratedFile;
  pageObjects: GeneratedFile[];
  methodsToMerge: MergeRequest[];
  summary: string;
}

export interface GeneratedFile {
  fileName: string;
  filePath: string;
  content: string;
}

export interface MergeRequest {
  targetClassName: string;
  targetFilePath: string;
  newConstants: string[];
  newMethods: string[];
}

export function generateTestScript(
  recording: Recording,
  existingPages?: ExistingPageObject[],
): GeneratedTestOutput {
  const className = resolveClassName(recording);
  const pkg = recording.metadata.packageName || 'zma.tests';
  const groups = recording.metadata.testGroups || inferGroups(recording);
  const description = recording.metadata.description || `Auto-generated test from exploration: ${recording.name}`;

  // Analyze actions and map to existing page objects
  const analysis = analyzeRecording(recording, existingPages || []);

  // Generate only truly new page objects (unmapped elements)
  const { pageObjects, mergeRequests } = generatePageObjects(analysis, recording);

  // Generate the test class using PO method calls
  const testClass = buildTestClass({
    pkg,
    className,
    groups,
    description,
    recording,
    analysis,
    pageObjects,
  });

  const summary = buildSummary(recording, analysis, className, pageObjects, mergeRequests);

  return {
    testClass: {
      fileName: `${className}.java`,
      filePath: `src/test/java/${pkg.replace(/\./g, '/')}/${className}.java`,
      content: testClass,
    },
    pageObjects,
    methodsToMerge: mergeRequests,
    summary,
  };
}

// ── Action Mapping ──────────────────────────────────────────────────────────

export interface ActionMapping {
  actionSeq: number;
  /** Matched to an existing page object */
  existingPage?: { className: string; packageName: string; varName: string };
  /** The real method name from the existing PO that handles this action */
  existingMethod?: string;
  /** Whether this method takes a String parameter (e.g. enterUsername(text)) */
  existingMethodTakesParam?: boolean;
  /** True if locator exists in a PO but no matching method — needs new method added */
  needsNewMethod: boolean;
  /** True if no existing PO covers this locator at all — needs new PO */
  needsNewPage: boolean;
  /** Generated method name for new methods */
  generatedMethodName?: string;
  /** For type_text: the data constant name to use */
  dataConstantName?: string;
}

// ── Analysis ─────────────────────────────────────────────────────────────────

interface ActionAnalysis {
  contexts: Set<string>;
  isHybrid: boolean;
  flutterKeys: Set<string>;
  flutterTexts: Set<string>;
  flutterTypes: Set<string>;
  webSelectors: Array<{ by: string; value: string }>;
  nativeSelectors: Array<{ by: string; value: string }>;
  contextBlocks: ContextBlock[];
  textInputs: Array<{ target: string; by: string; text: string; context: string }>;
  hasAssertions: boolean;
  /** Mapping of each action to an existing or new page object method */
  actionMappings: ActionMapping[];
  /** All existing page objects available */
  existingPages: ExistingPageObject[];
  /** Set of unique page objects referenced (existing + new) for @BeforeClass */
  referencedPages: Map<string, { className: string; packageName: string; varName: string; isNew: boolean }>;
  /** Test data constants extracted from text inputs */
  dataConstants: Map<string, { name: string; value: string }>;
  /** Indices into recording.actions where a new @Test method should begin */
  splitPoints: number[];
}

interface ContextBlock {
  context: string;
  actions: RecordedAction[];
}

function analyzeRecording(recording: Recording, existingPages: ExistingPageObject[]): ActionAnalysis {
  const analysis: ActionAnalysis = {
    contexts: new Set(),
    isHybrid: false,
    flutterKeys: new Set(),
    flutterTexts: new Set(),
    flutterTypes: new Set(),
    webSelectors: [],
    nativeSelectors: [],
    contextBlocks: [],
    textInputs: [],
    hasAssertions: false,
    actionMappings: [],
    existingPages,
    referencedPages: new Map(),
    dataConstants: new Map(),
    splitPoints: [],
  };

  let currentBlock: ContextBlock | null = null;
  let lastPageVarName: string | null = null;
  let actionsSinceLastSplit = 0;

  for (let i = 0; i < recording.actions.length; i++) {
    const action = recording.actions[i];
    analysis.contexts.add(action.context);

    // Track context blocks
    if (!currentBlock || currentBlock.context !== action.context) {
      currentBlock = { context: action.context, actions: [] };
      analysis.contextBlocks.push(currentBlock);
    }
    currentBlock.actions.push(action);

    // Track locators by type
    const by = (action.params.by as string) || '';
    const target = (action.params.target as string) || '';

    if (action.type === 'tap' || action.type === 'type_text' || action.type === 'find_elements') {
      if (by === 'key' && target) analysis.flutterKeys.add(target);
      if (by === 'text' && target) analysis.flutterTexts.add(target);
      if (by === 'type' && target) analysis.flutterTypes.add(target);
      if (by === 'xpath' || by === 'css') analysis.webSelectors.push({ by, value: target });
      if (by === 'accessibilityId') analysis.nativeSelectors.push({ by, value: target });
    }

    if (action.type === 'type_text') {
      const text = action.params.text as string || '';
      analysis.textInputs.push({ target, by, text, context: action.context });
      // Create data constant
      const constName = `TEST_${toConstantName(target || 'INPUT_' + i)}`;
      analysis.dataConstants.set(constName, { name: constName, value: text });
    }

    if (action.type === 'assertion') {
      analysis.hasAssertions = true;
    }

    // Map action to existing page object
    const mapping = mapActionToPageObject(action, i, existingPages, analysis);
    analysis.actionMappings.push(mapping);

    // Track referenced pages
    if (mapping.existingPage) {
      analysis.referencedPages.set(mapping.existingPage.varName, {
        ...mapping.existingPage,
        isNew: false,
      });
    }

    // Determine split points for multiple @Test methods
    actionsSinceLastSplit++;
    const currentPageVar = mapping.existingPage?.varName || mapping.needsNewPage ? 'new' : null;

    if (
      (action.type === 'assertion' && actionsSinceLastSplit >= 2) ||
      (action.type === 'screenshot') ||
      (lastPageVarName && currentPageVar && lastPageVarName !== currentPageVar && actionsSinceLastSplit >= 3) ||
      (actionsSinceLastSplit >= 8)
    ) {
      // Split AFTER this action
      if (i < recording.actions.length - 1) {
        analysis.splitPoints.push(i + 1);
        actionsSinceLastSplit = 0;
      }
    }

    if (currentPageVar) lastPageVarName = currentPageVar;
  }

  analysis.isHybrid = analysis.contexts.size > 1;
  return analysis;
}

/**
 * Match a single recorded action to an existing page object method.
 *
 * Matching strategy:
 *  1. Look up target locator value in all existing POs locator lists
 *  2. If locator found, check if the PO has a method that uses that locator
 *     AND matches the action type (tap -> tapX/clickX, type_text -> enterX/fillX)
 *  3. If method found -> full match (reuse)
 *  4. If locator found but no method -> needsNewMethod
 *  5. If no locator found -> needsNewPage
 */
function mapActionToPageObject(
  action: RecordedAction,
  actionIndex: number,
  existingPages: ExistingPageObject[],
  analysis: ActionAnalysis,
): ActionMapping {
  const by = (action.params.by as string) || '';
  const target = (action.params.target as string) || '';
  const x = action.params.x as number | undefined;
  const y = action.params.y as number | undefined;

  // Non-element actions (gestures without target, waits, screenshots, etc.) don't map to POs
  if (!target && x === undefined && y === undefined) {
    return { actionSeq: actionIndex, needsNewMethod: false, needsNewPage: false };
  }

  // Coordinate-based actions don't map to POs (inline as actions.tapAt)
  if (by === 'coordinates' || (x !== undefined && y !== undefined && !target)) {
    return { actionSeq: actionIndex, needsNewMethod: false, needsNewPage: false };
  }

  // Search all existing POs for a locator match
  for (const page of existingPages) {
    const locatorMatch = page.locators.find(l =>
      l.value.toLowerCase() === target.toLowerCase()
    );

    if (locatorMatch) {
      const varName = toCamelCase(page.className);
      const pageRef = { className: page.className, packageName: page.packageName, varName };

      // Find a matching method by checking method names against the action type + target
      const matchedMethod = findMatchingMethod(page, action, target);

      if (matchedMethod) {
        const takesParam = action.type === 'type_text' && matchedMethod.takesParam;
        return {
          actionSeq: actionIndex,
          existingPage: pageRef,
          existingMethod: matchedMethod.name,
          existingMethodTakesParam: takesParam,
          needsNewMethod: false,
          needsNewPage: false,
          dataConstantName: action.type === 'type_text'
            ? `TEST_${toConstantName(target || 'INPUT_' + actionIndex)}`
            : undefined,
        };
      }

      // Locator found but no matching method — need to add a method
      const genMethodName = toMethodName(target, action.type);
      return {
        actionSeq: actionIndex,
        existingPage: pageRef,
        needsNewMethod: true,
        needsNewPage: false,
        generatedMethodName: genMethodName,
        dataConstantName: action.type === 'type_text'
          ? `TEST_${toConstantName(target || 'INPUT_' + actionIndex)}`
          : undefined,
      };
    }
  }

  // Check for text-based matching in existing POs (byText locators often aren't in constants)
  if (by === 'text' && target) {
    for (const page of existingPages) {
      const matchedMethod = findMatchingMethod(page, action, target);
      if (matchedMethod) {
        const varName = toCamelCase(page.className);
        const pageRef = { className: page.className, packageName: page.packageName, varName };
        const takesParam = action.type === 'type_text' && matchedMethod.takesParam;
        return {
          actionSeq: actionIndex,
          existingPage: pageRef,
          existingMethod: matchedMethod.name,
          existingMethodTakesParam: takesParam,
          needsNewMethod: false,
          needsNewPage: false,
          dataConstantName: action.type === 'type_text'
            ? `TEST_${toConstantName(target || 'INPUT_' + actionIndex)}`
            : undefined,
        };
      }
    }
  }

  // No match found — needs new page object
  const genMethodName = toMethodName(target, action.type);
  return {
    actionSeq: actionIndex,
    needsNewMethod: false,
    needsNewPage: true,
    generatedMethodName: genMethodName,
    dataConstantName: action.type === 'type_text'
      ? `TEST_${toConstantName(target || 'INPUT_' + actionIndex)}`
      : undefined,
  };
}

interface MethodMatch { name: string; takesParam: boolean }

/**
 * Find a method in an existing page object that likely handles the given action.
 * Matches by checking if method name relates to the target and action type.
 */
function findMatchingMethod(
  page: ExistingPageObject,
  action: RecordedAction,
  target: string,
): MethodMatch | null {
  const actionType = action.type;
  const targetLower = target.toLowerCase().replace(/[^a-z0-9]/g, '');

  for (const method of page.methods) {
    const methodLower = method.toLowerCase();

    // For tap actions: look for tap*, click*, open*, navigate*, dismiss*, close*, select*
    if (actionType === 'tap') {
      const isTapMethod = methodLower.startsWith('tap') || methodLower.startsWith('click') ||
        methodLower.startsWith('open') || methodLower.startsWith('navigate') ||
        methodLower.startsWith('dismiss') || methodLower.startsWith('close') ||
        methodLower.startsWith('select');
      if (isTapMethod && methodLower.includes(targetLower.slice(0, Math.min(targetLower.length, 6)))) {
        return { name: method, takesParam: false };
      }
    }

    // For type_text actions: look for enter*, fill*, type*, search*
    if (actionType === 'type_text') {
      const isTextMethod = methodLower.startsWith('enter') || methodLower.startsWith('fill') ||
        methodLower.startsWith('type') || methodLower.startsWith('search') ||
        methodLower.includes('text');
      if (isTextMethod && methodLower.includes(targetLower.slice(0, Math.min(targetLower.length, 6)))) {
        return { name: method, takesParam: true };
      }
    }
  }

  // Broader match: check if any method name contains a significant portion of the target
  if (targetLower.length >= 4) {
    for (const method of page.methods) {
      const methodLower = method.toLowerCase();
      if (methodLower.includes(targetLower) || targetLower.includes(methodLower.replace(/^(tap|click|enter|fill|navigate|open|close|dismiss|select)/, ''))) {
        const takesParam = actionType === 'type_text';
        return { name: method, takesParam };
      }
    }
  }

  return null;
}

// ── Test class generation ────────────────────────────────────────────────────

interface TestClassParams {
  pkg: string;
  className: string;
  groups: string[];
  description: string;
  recording: Recording;
  analysis: ActionAnalysis;
  pageObjects: GeneratedFile[];
}

function buildTestClass(p: TestClassParams): string {
  const lines: string[] = [];
  const { pkg, className, groups, description, recording, analysis } = p;

  // Package
  lines.push(`package ${pkg};`);
  lines.push('');

  // Imports
  const imports = new Set<string>();
  imports.add('import org.testng.annotations.Test;');
  imports.add('import org.testng.Assert;');
  imports.add('import com.zena.automation.ZenaTest;');
  imports.add('import com.zena.automation.base.ZenAppLogin;');

  // Check if any actions need raw AppActions (coordinates, unmapped gestures)
  let needsRawActions = false;
  for (let i = 0; i < recording.actions.length; i++) {
    const action = recording.actions[i];
    const mapping = analysis.actionMappings[i];
    if (action.type === 'gesture' || action.type === 'switch_context' || action.type === 'navigate_back' ||
        action.type === 'webview_action' || (action.params.x !== undefined && action.params.y !== undefined)) {
      needsRawActions = true;
    }
    if (!mapping.existingPage && !mapping.needsNewPage && action.type !== 'wait' &&
        action.type !== 'screenshot' && action.type !== 'assertion' && action.type !== 'launch_app' &&
        action.type !== 'native_inspect' && action.type !== 'find_elements') {
      needsRawActions = true;
    }
  }
  // ZenaTest provides the `app` DSL fixture — prefer app.flutter()/native_()/webView() over AppActions
  if (needsRawActions) {
    imports.add('import com.zena.automation.actions.AppActions;');
  }

  // Page object imports (existing)
  for (const [, pageInfo] of analysis.referencedPages) {
    if (pageInfo.packageName) {
      imports.add(`import ${pageInfo.packageName}.${pageInfo.className};`);
    }
  }

  // Page object imports (new)
  for (const po of p.pageObjects) {
    const poPackage = extractPackageFromContent(po.content);
    const poClassName = po.fileName.replace('.java', '');
    if (poPackage) {
      imports.add(`import ${poPackage}.${poClassName};`);
    }
  }

  for (const imp of [...imports].sort()) {
    lines.push(imp);
  }
  lines.push('');

  // Class javadoc
  lines.push('/**');
  lines.push(` * ${description}`);
  lines.push(` * Generated from exploration session: ${recording.name}`);
  lines.push(` * Platform: ${recording.platform}`);
  lines.push(` * Recorded: ${recording.startedAt}`);
  lines.push(' */');

  // Class declaration — add @ZenAppLogin to auto-login before tests
  // Fill in account/username/password/environment from zenapp-config.yaml users.valid
  lines.push('// @ZenAppLogin(account = "medspabeta", username = "...", password = "...", environment = "Beta")');
  lines.push(`public class ${className} extends ZenaTest {`);
  lines.push('');

  // Test data constants
  if (analysis.dataConstants.size > 0) {
    for (const [, dc] of analysis.dataConstants) {
      lines.push(`    private static final String ${dc.name} = "${escapeJava(dc.value)}";`);
    }
    lines.push('');
  }

  // Page object fields
  const allPages = collectAllPages(analysis, p.pageObjects);
  for (const [varName, pageInfo] of allPages) {
    lines.push(`    private ${pageInfo.className} ${varName};`);
  }
  if (needsRawActions) {
    lines.push('    private AppActions actions;');
  }
  lines.push('');

  // Split actions into test methods
  const testMethods = splitIntoTestMethods(recording, analysis, groups, description);

  for (let mi = 0; mi < testMethods.length; mi++) {
    const tm = testMethods[mi];
    const groupStr = groups.map(g => `"${g}"`).join(', ');

    let testAnnotation = `    @Test(priority = ${mi + 1}, groups = {${groupStr}}`;
    if (mi > 0) {
      testAnnotation += `, dependsOnMethods = "${testMethods[mi - 1].methodName}"`;
    }
    testAnnotation += `,\n            description = "${escapeJava(tm.description)}")`;
    lines.push(testAnnotation);
    lines.push(`    public void ${tm.methodName}() {`);

    // Generate steps
    for (const step of tm.steps) {
      const action = recording.actions[step.actionIndex];
      const mapping = analysis.actionMappings[step.actionIndex];
      const stepLines = generateMappedActionCode(action, step.stepNum, mapping, analysis);
      for (const sl of stepLines) {
        lines.push(`        ${sl}`);
      }
      lines.push('');
    }

    // Add waitFor + screenshot at end of each test method
    if (tm.steps.length > 0) {
      const lastAction = recording.actions[tm.steps[tm.steps.length - 1].actionIndex];
      if (lastAction.type === 'tap' || lastAction.type === 'gesture') {
        lines.push(`        waitFor(2);`);
      }
      const screenshotName = tm.methodName.replace(/^test/, '').replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
      lines.push(`        captureScreenshot("${screenshotName}");`);
    }

    lines.push('    }');
    if (mi < testMethods.length - 1) lines.push('');
  }

  lines.push('}');
  return lines.join('\n');
}

interface TestMethod {
  methodName: string;
  description: string;
  steps: Array<{ actionIndex: number; stepNum: number }>;
}

function splitIntoTestMethods(
  recording: Recording,
  analysis: ActionAnalysis,
  _groups: string[],
  description: string,
): TestMethod[] {
  const methods: TestMethod[] = [];
  const splitSet = new Set(analysis.splitPoints);
  let currentSteps: Array<{ actionIndex: number; stepNum: number }> = [];
  let globalStepNum = 0;

  for (let i = 0; i < recording.actions.length; i++) {
    // Skip non-meaningful actions for test methods
    const action = recording.actions[i];
    if (action.type === 'launch_app' || action.type === 'native_inspect') continue;

    globalStepNum++;
    currentSteps.push({ actionIndex: i, stepNum: globalStepNum });

    if (splitSet.has(i + 1) || i === recording.actions.length - 1) {
      // End this method
      const methodIndex = methods.length + 1;
      const methodDesc = currentSteps.length > 0
        ? describeAction(recording.actions[currentSteps[0].actionIndex])
        : description;

      methods.push({
        methodName: methods.length === 0
          ? resolveMethodName(recording)
          : `test${toPascalCase(recording.name)}Part${methodIndex}`,
        description: methodDesc,
        steps: [...currentSteps],
      });
      currentSteps = [];
    }
  }

  // If no methods were created (empty recording), create one empty method
  if (methods.length === 0) {
    methods.push({
      methodName: resolveMethodName(recording),
      description,
      steps: [],
    });
  }

  return methods;
}

/**
 * Generate Java code for a single action using the PO mapping.
 */
function generateMappedActionCode(
  action: RecordedAction,
  stepNum: number,
  mapping: ActionMapping,
  analysis: ActionAnalysis,
): string[] {
  const lines: string[] = [];
  const desc = action.description || describeAction(action);
  lines.push(`logStep("Step ${stepNum}: ${escapeJava(desc)}");`);

  // If mapped to existing PO method → generate PO call
  if (mapping.existingMethod && mapping.existingPage) {
    const varName = mapping.existingPage.varName;
    if (mapping.existingMethodTakesParam && action.type === 'type_text') {
      const constName = mapping.dataConstantName || `"${escapeJava(action.params.text as string || '')}"`;
      const isConst = analysis.dataConstants.has(constName);
      lines.push(`${varName}.${mapping.existingMethod}(${isConst ? constName : `"${escapeJava(action.params.text as string || '')}"`});`);
    } else {
      lines.push(`${varName}.${mapping.existingMethod}();`);
    }
    return lines;
  }

  // If needs new method on existing PO → call the generated method name
  if (mapping.needsNewMethod && mapping.existingPage && mapping.generatedMethodName) {
    const varName = mapping.existingPage.varName;
    if (action.type === 'type_text') {
      const constName = mapping.dataConstantName;
      const isConst = constName && analysis.dataConstants.has(constName);
      lines.push(`${varName}.${mapping.generatedMethodName}(${isConst ? constName : `"${escapeJava(action.params.text as string || '')}"`});`);
    } else {
      lines.push(`${varName}.${mapping.generatedMethodName}();`);
    }
    return lines;
  }

  // Fallback: raw action code (unmapped or non-element actions)
  switch (action.type) {
    case 'tap':
      lines.push(...generateRawTapCode(action));
      break;
    case 'type_text':
      lines.push(...generateRawTypeTextCode(action, stepNum, analysis));
      break;
    case 'gesture':
      lines.push(...generateGestureCode(action));
      break;
    case 'switch_context':
      lines.push(...generateSwitchContextCode(action));
      break;
    case 'navigate_back':
      lines.push('actions.goBack();');
      break;
    case 'wait':
      lines.push(`waitFor(${action.params.seconds || 2});`);
      break;
    case 'assertion':
      lines.push(...generateAssertionCode(action));
      break;
    case 'screenshot':
      lines.push(`captureScreenshot("${escapeJava(String(action.params.name || `step_${stepNum}`))}");`);
      break;
    case 'find_elements':
      lines.push(...generateFindElementsCode(action, stepNum));
      break;
    case 'webview_action':
      lines.push(...generateWebviewActionCode(action));
      break;
    case 'launch_app':
      lines.push(`// App launch: ${action.params.bundleId || action.params.appPackage || ''}`);
      break;
    case 'native_inspect':
      lines.push('// Native inspection performed during exploration');
      break;
  }

  return lines;
}

// ── Raw action code generators (fallback when no PO match) ──────────────────

function generateRawTapCode(action: RecordedAction): string[] {
  const by = action.params.by as string || 'key';
  const target = action.params.target as string || '';
  const x = action.params.x as number | undefined;
  const y = action.params.y as number | undefined;

  // Coordinate-based tap
  if (by === 'coordinates' || (x !== undefined && y !== undefined)) {
    return [`actions.tapAt(${x}, ${y});`];
  }

  if (action.context === 'flutter') {
    switch (by) {
      case 'key':
        return [`actions.tap(actions.byValueKey("${escapeJava(target)}"));`];
      case 'text':
        return [`actions.tap(actions.byText("${escapeJava(target)}"));`];
      case 'type':
        return [`actions.tap(actions.byType("${escapeJava(target)}"));`];
      case 'semanticsLabel':
        return [`actions.tap(actions.bySemanticsLabel("${escapeJava(target)}"));`];
      default:
        return [`actions.tap(actions.byValueKey("${escapeJava(target)}"));`];
    }
  }

  if (action.context === 'webview') {
    if (by === 'css') return [`actions.click(actions.webFindByCss("${escapeJava(target)}"));`];
    return [`actions.click(actions.webFindByXPath("${escapeJava(target)}"));`];
  }

  if (action.context === 'native') {
    if (by === 'accessibilityId') return [`actions.click(actions.nativeFindByAccessibilityId("${escapeJava(target)}"));`];
    return [`actions.click(actions.nativeFindByXPath("${escapeJava(target)}"));`];
  }

  return [`actions.tap(actions.byValueKey("${escapeJava(target)}"));`];
}

function generateRawTypeTextCode(action: RecordedAction, stepNum: number, analysis: ActionAnalysis): string[] {
  const by = action.params.by as string || 'key';
  const target = action.params.target as string || '';
  const text = action.params.text as string || '';
  const varName = `field${stepNum}`;
  const lines: string[] = [];

  const constName = `TEST_${toConstantName(target || 'INPUT_' + stepNum)}`;
  const textRef = analysis.dataConstants.has(constName) ? constName : `"${escapeJava(text)}"`;

  if (action.context === 'flutter') {
    const finder = by === 'type'
      ? `actions.byType("${escapeJava(target)}")`
      : by === 'text'
        ? `actions.byText("${escapeJava(target)}")`
        : `actions.byValueKey("${escapeJava(target)}")`;
    lines.push(`WebElement ${varName} = ${finder};`);
    lines.push(`actions.enterText(${varName}, ${textRef});`);
  } else if (action.context === 'webview') {
    const finder = by === 'css'
      ? `actions.webFindByCss("${escapeJava(target)}")`
      : `actions.webFindByXPath("${escapeJava(target)}")`;
    lines.push(`WebElement ${varName} = ${finder};`);
    lines.push(`${varName}.click();`);
    lines.push(`${varName}.clear();`);
    lines.push(`${varName}.sendKeys(${textRef});`);
  } else {
    lines.push(`WebElement ${varName} = actions.nativeFindByXPath("${escapeJava(target)}");`);
    lines.push(`${varName}.click();`);
    lines.push(`${varName}.clear();`);
    lines.push(`${varName}.sendKeys(${textRef});`);
  }

  return lines;
}

function generateGestureCode(action: RecordedAction): string[] {
  const gestureAction = action.params.action as string;
  switch (gestureAction) {
    case 'scroll_down':
      return ['actions.scrollDown();'];
    case 'scroll_up':
      return ['actions.scrollUp();'];
    case 'back':
      return ['actions.goBack();'];
    case 'long_press': {
      const target = action.params.target as string;
      const by = action.params.targetBy as string || 'key';
      if (target) {
        const finder = by === 'text' ? `actions.byText("${escapeJava(target)}")`
          : by === 'type' ? `actions.byType("${escapeJava(target)}")`
          : `actions.byValueKey("${escapeJava(target)}")`;
        return [`actions.longPress(${finder}, java.time.Duration.ofSeconds(2));`];
      }
      return ['// long_press without target'];
    }
    case 'double_tap': {
      const target = action.params.target as string;
      const by = action.params.targetBy as string || 'key';
      if (target) {
        const finder = by === 'text' ? `actions.byText("${escapeJava(target)}")`
          : by === 'type' ? `actions.byType("${escapeJava(target)}")`
          : `actions.byValueKey("${escapeJava(target)}")`;
        return [`actions.doubleClick(${finder});`];
      }
      return ['// double_tap without target'];
    }
    case 'swipe': {
      const p = action.params.params as Record<string, number> || {};
      return [
        `actions.swipe(${p.startX || 500}, ${p.startY || 500}, ${p.endX || 500}, ${p.endY || 200}, java.time.Duration.ofMillis(${p.duration || 600}));`,
      ];
    }
    case 'scroll_until_visible': {
      const target = action.params.target as string;
      const by = action.params.by as string || 'key';
      if (target) {
        const finder = by === 'text' ? `actions.byText("${escapeJava(target)}")`
          : by === 'type' ? `actions.byType("${escapeJava(target)}")`
          : `actions.byValueKey("${escapeJava(target)}")`;
        return [`actions.waitUntilVisible(${finder}, 15);`];
      }
      return ['actions.scrollDown();'];
    }
    default:
      return [`// Gesture: ${gestureAction}`];
  }
}

function generateSwitchContextCode(action: RecordedAction): string[] {
  const to = action.params.to as string;
  switch (to) {
    case 'webview':
      return ['actions.switchToWebView();'];
    case 'native':
      return ['actions.switchToNativeContext();'];
    case 'flutter':
      return ['actions.switchToNativeContext(); // Flutter uses NATIVE_APP context'];
    default:
      return [`// Switch context to: ${to}`];
  }
}

function generateAssertionCode(action: RecordedAction): string[] {
  const assertionType = action.params.assertionType as string;
  const message = action.params.message as string || '';
  const target = action.params.target as string || '';
  const by = action.params.by as string || 'key';

  switch (assertionType) {
    case 'assertTrue':
      return [`Assert.assertTrue(${action.params.condition || 'true'}, "${escapeJava(message)}");`];
    case 'assertFalse':
      return [`Assert.assertFalse(${action.params.condition || 'false'}, "${escapeJava(message)}");`];
    case 'assertEquals':
      return [`Assert.assertEquals(${action.params.actual}, ${action.params.expected}, "${escapeJava(message)}");`];
    case 'assertNotNull':
      return [`Assert.assertNotNull(${action.params.value || 'null'}, "${escapeJava(message)}");`];
    case 'assertVisible': {
      if (target) {
        const finder = by === 'text' ? `actions.byText("${escapeJava(target)}")`
          : by === 'type' ? `actions.byType("${escapeJava(target)}")`
          : `actions.byValueKey("${escapeJava(target)}")`;
        return [
          `Assert.assertTrue(actions.isDisplayed(${finder}), "${escapeJava(message || `Element ${target} should be visible`)}");`,
        ];
      }
      return [`// assertVisible: no target specified`];
    }
    default:
      return [`// Unknown assertion type: ${assertionType}`];
  }
}

function generateFindElementsCode(action: RecordedAction, stepNum: number): string[] {
  const by = action.params.by as string || 'key';
  const value = action.params.value as string || '';

  switch (by) {
    case 'key':
      return [`WebElement element${stepNum} = actions.byValueKey("${escapeJava(value)}");`];
    case 'text':
      return [`WebElement element${stepNum} = actions.byText("${escapeJava(value)}");`];
    case 'type':
      return [`java.util.List<WebElement> elements${stepNum} = actions.allByType("${escapeJava(value)}");`];
    default:
      return [`// find_elements by=${by} value=${value}`];
  }
}

function generateWebviewActionCode(action: RecordedAction): string[] {
  const webAction = action.params.action as string;
  switch (webAction) {
    case 'execute_js':
      return [`actions.executeJavaScript("${escapeJava(action.params.script as string || '')}");`];
    case 'get_url':
      return ['String currentUrl = actions.getCurrentUrl();', 'logger.info("Current URL: " + currentUrl);'];
    case 'page_source':
      return ['// Inspected page source during exploration'];
    default:
      return [`// WebView action: ${webAction}`];
  }
}

// ── Page Object Generation ───────────────────────────────────────────────────

function collectAllPages(
  analysis: ActionAnalysis,
  newPageObjects: GeneratedFile[],
): Map<string, { className: string; packageName: string; varName: string; isNew: boolean }> {
  const pages = new Map(analysis.referencedPages);

  // Add new page objects
  for (const po of newPageObjects) {
    const poClassName = po.fileName.replace('.java', '');
    const poPackage = extractPackageFromContent(po.content) || '';
    const varName = toCamelCase(poClassName);
    if (!pages.has(varName)) {
      pages.set(varName, { className: poClassName, packageName: poPackage, varName, isNew: true });
    }
  }

  return pages;
}

function generatePageObjects(
  analysis: ActionAnalysis,
  recording: Recording,
): { pageObjects: GeneratedFile[]; mergeRequests: MergeRequest[] } {
  const pages: GeneratedFile[] = [];
  const mergeRequests: MergeRequest[] = [];

  // Collect elements that need NEW page objects (unmapped)
  const newFlutterElements = new Map<string, { by: string; value: string; usedFor: string }>();
  const newWebviewElements = new Map<string, { by: string; value: string; usedFor: string }>();
  const newNativeElements = new Map<string, { by: string; value: string; usedFor: string }>();

  // Collect elements that need NEW METHODS on existing page objects
  const existingPageNewMethods = new Map<string, {
    page: ExistingPageObject;
    elements: Map<string, { by: string; value: string; usedFor: string }>;
  }>();

  for (let i = 0; i < recording.actions.length; i++) {
    const action = recording.actions[i];
    const mapping = analysis.actionMappings[i];
    const by = (action.params.by as string) || '';
    const target = (action.params.target as string) || (action.params.value as string) || '';
    if (!target) continue;

    if (mapping.needsNewPage) {
      const key = `${by}_${target}`;
      const elem = { by, value: target, usedFor: action.type };

      if (action.context === 'flutter' && ['key', 'text', 'type', 'semanticsLabel'].includes(by)) {
        newFlutterElements.set(key, elem);
      } else if (action.context === 'webview' && ['css', 'xpath'].includes(by)) {
        newWebviewElements.set(key, elem);
      } else if (action.context === 'native' && ['xpath', 'accessibilityId'].includes(by)) {
        newNativeElements.set(key, elem);
      }
    }

    if (mapping.needsNewMethod && mapping.existingPage) {
      const pageKey = mapping.existingPage.className;
      if (!existingPageNewMethods.has(pageKey)) {
        const existingPage = analysis.existingPages.find(p => p.className === mapping.existingPage!.className);
        if (existingPage) {
          existingPageNewMethods.set(pageKey, { page: existingPage, elements: new Map() });
        }
      }
      const entry = existingPageNewMethods.get(pageKey);
      if (entry) {
        const key = `${by}_${target}`;
        entry.elements.set(key, { by, value: target, usedFor: action.type });
      }

      // Track in referencedPages
      analysis.referencedPages.set(mapping.existingPage.varName, {
        ...mapping.existingPage,
        isNew: false,
      });
    }
  }

  const basePkg = recording.metadata.packageName || 'zma.tests';
  const pagePkg = basePkg.replace('.tests', '.pages');

  // Generate NEW Flutter page object
  if (newFlutterElements.size > 0) {
    const pageName = toPascalCase(recording.name) + 'Page';
    const poContent = buildFlutterPageObject(pagePkg + '.flutter', pageName, newFlutterElements);
    pages.push({
      fileName: `${pageName}.java`,
      filePath: `src/main/java/${pagePkg.replace(/\./g, '/')}/flutter/${pageName}.java`,
      content: poContent,
    });

    // Track new page methods in actionMappings for test class generation
    const varName = toCamelCase(pageName);
    analysis.referencedPages.set(varName, {
      className: pageName,
      packageName: pagePkg + '.flutter',
      varName,
      isNew: true,
    });

    // Update action mappings for new page elements
    for (let i = 0; i < recording.actions.length; i++) {
      const mapping = analysis.actionMappings[i];
      if (mapping.needsNewPage) {
        const action = recording.actions[i];
        const by = (action.params.by as string) || '';
        const target = (action.params.target as string) || '';
        const key = `${by}_${target}`;
        if (newFlutterElements.has(key)) {
          mapping.existingPage = { className: pageName, packageName: pagePkg + '.flutter', varName };
          mapping.needsNewPage = false;
          mapping.needsNewMethod = false;
          mapping.existingMethod = mapping.generatedMethodName;
          mapping.existingMethodTakesParam = action.type === 'type_text';
        }
      }
    }
  }

  // Generate NEW WebView page object
  if (newWebviewElements.size > 0) {
    const pageName = toPascalCase(recording.name) + 'WebPage';
    const poContent = buildWebViewPageObject(pagePkg + '.webview', pageName, newWebviewElements);
    pages.push({
      fileName: `${pageName}.java`,
      filePath: `src/main/java/${pagePkg.replace(/\./g, '/')}/webview/${pageName}.java`,
      content: poContent,
    });

    const varName = toCamelCase(pageName);
    analysis.referencedPages.set(varName, {
      className: pageName,
      packageName: pagePkg + '.webview',
      varName,
      isNew: true,
    });
  }

  // Generate NEW Native page object
  if (newNativeElements.size > 0) {
    const pageName = toPascalCase(recording.name) + 'NativePage';
    const poContent = buildNativePageObject(pagePkg + '.nativeui', pageName, newNativeElements);
    pages.push({
      fileName: `${pageName}.java`,
      filePath: `src/main/java/${pagePkg.replace(/\./g, '/')}/nativeui/${pageName}.java`,
      content: poContent,
    });

    const varName = toCamelCase(pageName);
    analysis.referencedPages.set(varName, {
      className: pageName,
      packageName: pagePkg + '.nativeui',
      varName,
      isNew: true,
    });
  }

  // Generate merge requests for existing POs that need new methods
  for (const [, entry] of existingPageNewMethods) {
    const newConstants: string[] = [];
    const newMethods: string[] = [];

    for (const [, elem] of entry.elements) {
      const constName = `${strategyPrefix(elem.by)}${toConstantName(elem.value)}`;

      // Only add constant if not already in page
      const existingConst = entry.page.locators.find(l => l.value === elem.value);
      if (!existingConst) {
        newConstants.push(`    private static final String ${constName} = "${escapeJava(elem.value)}";`);
      }

      const methodName = toMethodName(elem.value, elem.usedFor);
      // Only add method if not already in page
      if (!entry.page.methods.includes(methodName)) {
        newMethods.push(buildNewMethod(entry.page.className, elem, methodName, constName));
      }
    }

    if (newConstants.length > 0 || newMethods.length > 0) {
      mergeRequests.push({
        targetClassName: entry.page.className,
        targetFilePath: entry.page.filePath,
        newConstants,
        newMethods,
      });
    }
  }

  return { pageObjects: pages, mergeRequests };
}

function buildNewMethod(
  pageClassName: string,
  elem: { by: string; value: string; usedFor: string },
  methodName: string,
  constName: string,
): string {
  const lines: string[] = [];
  const finder = buildFinder(elem.by, constName);

  if (elem.usedFor === 'tap') {
    lines.push('');
    lines.push(`    public ${pageClassName} ${methodName}() {`);
    lines.push(`        logAction("${humanize(methodName)}");`);
    lines.push(`        actions.tap(${finder});`);
    lines.push('        waitForFlutterIdle();');
    lines.push('        return this;');
    lines.push('    }');
  } else if (elem.usedFor === 'type_text') {
    lines.push('');
    lines.push(`    public ${pageClassName} ${methodName}(String text) {`);
    lines.push(`        logAction("${humanize(methodName)}: " + text);`);
    lines.push(`        WebElement field = ${finder};`);
    lines.push('        actions.enterText(field, text);');
    lines.push('        return this;');
    lines.push('    }');
  }

  return lines.join('\n');
}

// ── Page Object Builders (BasePage convention) ──────────────────────────────

function buildFlutterPageObject(
  pkg: string,
  className: string,
  elements: Map<string, { by: string; value: string; usedFor: string }>,
): string {
  const lines: string[] = [];

  lines.push(`package ${pkg};`);
  lines.push('');
  lines.push('import org.openqa.selenium.WebElement;');
  lines.push('');
  lines.push('import com.zena.automation.pages.BasePage;');
  lines.push('');

  // Class declaration extending BasePage
  lines.push(`/**`);
  lines.push(` * Page Object for ${humanize(className.replace('Page', ''))} screen.`);
  lines.push(` */`);
  lines.push(`public class ${className} extends BasePage {`);
  lines.push('');

  // Constants for ALL locator strategies
  for (const [, elem] of elements) {
    const prefix = strategyPrefix(elem.by);
    const constName = `${prefix}${toConstantName(elem.value)}`;
    lines.push(`    private static final String ${constName} = "${escapeJava(elem.value)}";`);
  }
  lines.push('');

  // isPageLoaded
  const firstElem = [...elements.values()][0];
  if (firstElem) {
    const prefix = strategyPrefix(firstElem.by);
    const constRef = `${prefix}${toConstantName(firstElem.value)}`;
    lines.push('    @Override');
    lines.push('    public boolean isPageLoaded() {');
    lines.push('        try {');
    lines.push(`            return actions.isDisplayed(${buildFinder(firstElem.by, constRef)});`);
    lines.push('        } catch (Exception e) {');
    lines.push(`            logger.error("${className} not loaded", e);`);
    lines.push('            return false;');
    lines.push('        }');
    lines.push('    }');
    lines.push('');
  }

  // getPageTitle
  lines.push('    @Override');
  lines.push('    public String getPageTitle() {');
  lines.push(`        return "${humanize(className.replace('Page', ''))}";`);
  lines.push('    }');
  lines.push('');

  // Action methods
  for (const [, elem] of elements) {
    const methodName = toMethodName(elem.value, elem.usedFor);
    const prefix = strategyPrefix(elem.by);
    const constRef = `${prefix}${toConstantName(elem.value)}`;
    const finder = buildFinder(elem.by, constRef);

    if (elem.usedFor === 'tap') {
      lines.push(`    /**`);
      lines.push(`     * Tap ${elem.value}.`);
      lines.push(`     * @return this page for fluent chaining`);
      lines.push(`     */`);
      lines.push(`    public ${className} ${methodName}() {`);
      lines.push(`        logAction("${humanize(methodName)}");`);
      lines.push(`        actions.tap(${finder});`);
      lines.push('        waitForFlutterIdle();');
      lines.push('        return this;');
      lines.push('    }');
      lines.push('');
    } else if (elem.usedFor === 'type_text') {
      lines.push(`    /**`);
      lines.push(`     * Enter text into ${elem.value}.`);
      lines.push(`     * @param text the text to enter`);
      lines.push(`     * @return this page for fluent chaining`);
      lines.push(`     */`);
      lines.push(`    public ${className} ${methodName}(String text) {`);
      lines.push(`        logAction("${humanize(methodName)}: " + text);`);
      lines.push(`        WebElement field = ${finder};`);
      lines.push('        actions.enterText(field, text);');
      lines.push('        return this;');
      lines.push('    }');
      lines.push('');
    }
  }

  lines.push('}');
  return lines.join('\n');
}

function buildWebViewPageObject(
  pkg: string,
  className: string,
  elements: Map<string, { by: string; value: string; usedFor: string }>,
): string {
  const lines: string[] = [];

  lines.push(`package ${pkg};`);
  lines.push('');
  lines.push('import org.openqa.selenium.WebElement;');
  lines.push('');
  lines.push('import com.zena.automation.pages.BasePage;');
  lines.push('');
  lines.push(`/**`);
  lines.push(` * Page Object for ${humanize(className.replace('WebPage', ''))} WebView screen.`);
  lines.push(` */`);
  lines.push(`public class ${className} extends BasePage {`);
  lines.push('');

  // Constants
  for (const [, elem] of elements) {
    const prefix = strategyPrefix(elem.by);
    const constName = `${prefix}${toConstantName(elem.value)}`;
    lines.push(`    private static final String ${constName} = "${escapeJava(elem.value)}";`);
  }
  lines.push('');

  // isPageLoaded
  const firstElem = [...elements.values()][0];
  if (firstElem) {
    const prefix = strategyPrefix(firstElem.by);
    const constRef = `${prefix}${toConstantName(firstElem.value)}`;
    lines.push('    @Override');
    lines.push('    public boolean isPageLoaded() {');
    lines.push('        try {');
    lines.push(`            switchToWebView();`);
    lines.push(`            return actions.isDisplayed(${buildWebFinder(firstElem.by, constRef)});`);
    lines.push('        } catch (Exception e) {');
    lines.push(`            logger.error("${className} not loaded", e);`);
    lines.push('            return false;');
    lines.push('        }');
    lines.push('    }');
    lines.push('');
  }

  lines.push('    @Override');
  lines.push('    public String getPageTitle() {');
  lines.push(`        return "${humanize(className.replace('WebPage', ''))}";`);
  lines.push('    }');
  lines.push('');

  // Action methods
  for (const [, elem] of elements) {
    const methodName = toMethodName(elem.value, elem.usedFor);
    const prefix = strategyPrefix(elem.by);
    const constRef = `${prefix}${toConstantName(elem.value)}`;
    const finder = buildWebFinder(elem.by, constRef);

    if (elem.usedFor === 'tap') {
      lines.push(`    public ${className} ${methodName}() {`);
      lines.push(`        logAction("${humanize(methodName)}");`);
      lines.push(`        actions.click(${finder});`);
      lines.push('        return this;');
      lines.push('    }');
      lines.push('');
    } else if (elem.usedFor === 'type_text') {
      lines.push(`    public ${className} ${methodName}(String text) {`);
      lines.push(`        logAction("${humanize(methodName)}: " + text);`);
      lines.push(`        WebElement field = ${finder};`);
      lines.push('        field.click();');
      lines.push('        field.clear();');
      lines.push('        field.sendKeys(text);');
      lines.push('        return this;');
      lines.push('    }');
      lines.push('');
    }
  }

  lines.push('}');
  return lines.join('\n');
}

function buildNativePageObject(
  pkg: string,
  className: string,
  elements: Map<string, { by: string; value: string; usedFor: string }>,
): string {
  const lines: string[] = [];

  lines.push(`package ${pkg};`);
  lines.push('');
  lines.push('import org.openqa.selenium.WebElement;');
  lines.push('');
  lines.push('import com.zena.automation.pages.BasePage;');
  lines.push('');
  lines.push(`/**`);
  lines.push(` * Page Object for ${humanize(className.replace('NativePage', ''))} native UI.`);
  lines.push(` */`);
  lines.push(`public class ${className} extends BasePage {`);
  lines.push('');

  // Constants
  for (const [, elem] of elements) {
    const prefix = strategyPrefix(elem.by);
    const constName = `${prefix}${toConstantName(elem.value)}`;
    lines.push(`    private static final String ${constName} = "${escapeJava(elem.value)}";`);
  }
  lines.push('');

  // isPageLoaded
  const firstElem = [...elements.values()][0];
  if (firstElem) {
    const prefix = strategyPrefix(firstElem.by);
    const constRef = `${prefix}${toConstantName(firstElem.value)}`;
    lines.push('    @Override');
    lines.push('    public boolean isPageLoaded() {');
    lines.push('        try {');
    lines.push(`            switchToNativeContext();`);
    lines.push(`            return actions.isDisplayed(${buildNativeFinder(firstElem.by, constRef)});`);
    lines.push('        } catch (Exception e) {');
    lines.push(`            logger.error("${className} not loaded", e);`);
    lines.push('            return false;');
    lines.push('        }');
    lines.push('    }');
    lines.push('');
  }

  lines.push('    @Override');
  lines.push('    public String getPageTitle() {');
  lines.push(`        return "${humanize(className.replace('NativePage', ''))}";`);
  lines.push('    }');
  lines.push('');

  // Action methods
  for (const [, elem] of elements) {
    const methodName = toMethodName(elem.value, elem.usedFor);
    const prefix = strategyPrefix(elem.by);
    const constRef = `${prefix}${toConstantName(elem.value)}`;
    const finder = buildNativeFinder(elem.by, constRef);

    if (elem.usedFor === 'tap') {
      lines.push(`    public ${className} ${methodName}() {`);
      lines.push(`        logAction("${humanize(methodName)}");`);
      lines.push(`        actions.click(${finder});`);
      lines.push('        return this;');
      lines.push('    }');
      lines.push('');
    } else if (elem.usedFor === 'type_text') {
      lines.push(`    public ${className} ${methodName}(String text) {`);
      lines.push(`        logAction("${humanize(methodName)}: " + text);`);
      lines.push(`        WebElement field = ${finder};`);
      lines.push('        field.click();');
      lines.push('        field.clear();');
      lines.push('        field.sendKeys(text);');
      lines.push('        return this;');
      lines.push('    }');
      lines.push('');
    }
  }

  lines.push('}');
  return lines.join('\n');
}

// ── Summary ──────────────────────────────────────────────────────────────────

function buildSummary(
  recording: Recording,
  analysis: ActionAnalysis,
  className: string,
  pageObjects: GeneratedFile[],
  mergeRequests: MergeRequest[],
): string {
  const lines: string[] = [];
  lines.push(`## Generated Test: ${className}`);
  lines.push('');
  lines.push(`- **Source**: Exploration session "${recording.name}"`);
  lines.push(`- **Platform**: ${recording.platform}`);
  lines.push(`- **Actions recorded**: ${recording.actions.length}`);
  lines.push(`- **Contexts used**: ${[...analysis.contexts].join(', ')}`);
  lines.push(`- **Hybrid test**: ${analysis.isHybrid ? 'Yes' : 'No'}`);
  lines.push('');

  // Reuse stats
  const mapped = analysis.actionMappings.filter(m => m.existingMethod && !m.needsNewMethod).length;
  const newMethods = analysis.actionMappings.filter(m => m.needsNewMethod).length;
  const newPages = analysis.actionMappings.filter(m => m.needsNewPage).length;
  const unmapped = analysis.actionMappings.filter(m => !m.existingPage && !m.needsNewPage &&
    !['wait', 'screenshot', 'assertion', 'launch_app', 'native_inspect', 'gesture', 'switch_context', 'navigate_back', 'webview_action'].includes(
      recording.actions[m.actionSeq]?.type || ''
    )).length;

  lines.push('### Page Object Reuse');
  lines.push(`- **Reused existing PO methods**: ${mapped}`);
  lines.push(`- **New methods on existing POs**: ${newMethods}`);
  lines.push(`- **Actions needing new POs**: ${newPages}`);
  lines.push(`- **Inline (raw) actions**: ${unmapped}`);
  lines.push('');

  // Existing POs referenced
  const existingRefs = [...analysis.referencedPages.values()].filter(p => !p.isNew);
  if (existingRefs.length > 0) {
    lines.push('### Existing Page Objects Used');
    for (const ref of existingRefs) {
      lines.push(`- **${ref.className}** (${ref.packageName})`);
    }
    lines.push('');
  }

  lines.push('### Generated Files');
  lines.push(`1. **Test Class**: \`${className}.java\``);
  for (const po of pageObjects) {
    lines.push(`- **New Page Object**: \`${po.fileName}\` → \`${po.filePath}\``);
  }
  for (const mr of mergeRequests) {
    lines.push(`- **Merge into existing**: \`${mr.targetClassName}\` (+${mr.newConstants.length} constants, +${mr.newMethods.length} methods)`);
  }
  lines.push('');

  if (analysis.dataConstants.size > 0) {
    lines.push('### Test Data Constants');
    for (const [, dc] of analysis.dataConstants) {
      lines.push(`- \`${dc.name}\` = "${dc.value}"`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Finder builders ──────────────────────────────────────────────────────────

export function buildFinder(by: string, constRef: string): string {
  switch (by) {
    case 'key': return `actions.byValueKey(${constRef})`;
    case 'text': return `actions.byText(${constRef})`;
    case 'type': return `actions.byType(${constRef})`;
    case 'semanticsLabel': return `actions.bySemanticsLabel(${constRef})`;
    default: return `actions.byValueKey(${constRef})`;
  }
}

export function buildWebFinder(by: string, constRef: string): string {
  switch (by) {
    case 'css': return `actions.webFindByCss(${constRef})`;
    case 'xpath': return `actions.webFindByXPath(${constRef})`;
    default: return `actions.webFindByXPath(${constRef})`;
  }
}

export function buildNativeFinder(by: string, constRef: string): string {
  switch (by) {
    case 'accessibilityId': return `actions.nativeFindByAccessibilityId(${constRef})`;
    case 'xpath': return `actions.nativeFindByXPath(${constRef})`;
    default: return `actions.nativeFindByXPath(${constRef})`;
  }
}

export function strategyPrefix(by: string): string {
  switch (by) {
    case 'key': return 'KEY_';
    case 'text': return 'TEXT_';
    case 'type': return 'TYPE_';
    case 'semanticsLabel': return 'LABEL_';
    case 'css': return 'CSS_';
    case 'xpath': return 'XPATH_';
    case 'accessibilityId': return 'ID_';
    default: return '';
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

function resolveClassName(rec: Recording): string {
  if (rec.metadata.testClassName) return rec.metadata.testClassName;
  return toPascalCase(rec.name) + 'Tests';
}

function resolveMethodName(rec: Recording): string {
  if (rec.metadata.testMethodName) return rec.metadata.testMethodName;
  return 'test' + toPascalCase(rec.name);
}

function inferGroups(rec: Recording): string[] {
  const groups: string[] = [];
  const actions = rec.actions;
  const contexts = new Set(actions.map(a => a.context));

  if (contexts.has('flutter')) groups.push('Flutter');
  if (contexts.has('webview')) groups.push('WebView');
  if (contexts.has('native')) groups.push('Native');
  if (contexts.size > 1) groups.push('Hybrid');

  const hasLogin = actions.some(a =>
    (a.params.target as string || '').toLowerCase().includes('login') ||
    (a.params.target as string || '').toLowerCase().includes('password')
  );
  if (hasLogin) groups.push('Authentication');

  if (groups.length === 0) groups.push('E2E');
  return groups;
}

function toPascalCase(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

function toCamelCase(str: string): string {
  const pascal = toPascalCase(str);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

export function toConstantName(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    || 'ELEMENT';
}

function toMethodName(target: string, action: string): string {
  const clean = target.replace(/[^a-zA-Z0-9]/g, ' ').trim();
  const pascal = clean.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');

  if (action === 'tap') return `tap${pascal}`;
  if (action === 'type_text') return `enterTextIn${pascal}`;
  if (action === 'find_elements') return `find${pascal}`;
  return `interact${pascal}`;
}

function humanize(str: string): string {
  // Convert camelCase/PascalCase to "Human Readable"
  return str
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/^./, s => s.toUpperCase());
}

function escapeJava(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function extractPackageFromContent(content: string): string | null {
  const match = content.match(/^package\s+([\w.]+);/m);
  return match ? match[1] : null;
}

function describeAction(action: RecordedAction): string {
  switch (action.type) {
    case 'tap': {
      const x = action.params.x as number | undefined;
      const y = action.params.y as number | undefined;
      if (x !== undefined && y !== undefined) return `Tap at (${x}, ${y})`;
      return `Tap ${action.params.by || 'key'}="${action.params.target || ''}"`;
    }
    case 'type_text':
      return `Enter text in ${action.params.by || 'key'}="${action.params.target || ''}"`;
    case 'gesture':
      return `Gesture: ${action.params.action || 'unknown'}`;
    case 'switch_context':
      return `Switch to ${action.params.to || 'unknown'} context`;
    case 'navigate_back':
      return 'Navigate back';
    case 'wait':
      return `Wait ${action.params.seconds || 2}s`;
    case 'assertion':
      return `Assert: ${action.params.message || action.params.assertionType || ''}`;
    case 'screenshot':
      return `Capture screenshot: ${action.params.name || ''}`;
    case 'find_elements':
      return `Find elements by ${action.params.by || 'key'}="${action.params.value || ''}"`;
    case 'webview_action':
      return `WebView: ${action.params.action || ''}`;
    default:
      return action.type;
  }
}

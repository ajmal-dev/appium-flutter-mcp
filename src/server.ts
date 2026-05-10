import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  connectSchema, disconnectSchema,
  handleConnect, handleDisconnect, handleGetStatus,
} from './tools/session.js';
import {
  getScreenSchema, getWidgetTreeSchema, getWidgetTreeCompactSchema,
  findElementsSchema, getElementDetailsSchema, getKnownScreenSchema,
  handleGetScreen, handleGetWidgetTree, handleFindElements,
  handleGetElementDetails, handleGetKnownScreen,
} from './tools/observe.js';
import {
  tapSchema, typeTextSchema, gestureSchema, waitForSchema, scrollUntilVisibleSchema, waitForPageStableSchema,
  smartTapSchema, batchActionsSchema,
  handleTap, handleTypeText, handleGesture, handleWaitFor, handleScrollUntilVisible, handleWaitForPageStable,
  handleSmartTap, handleBatchActions,
} from './tools/act.js';
import {
  switchContextSchema, inspectWebviewSchema, inspectNativeSchema, navigateToSchema,
  waitForWebviewSchema, webviewFillFormSchema,
  handleSwitchContext, handleInspectWebview, handleInspectNative, handleNavigateTo,
  handleWaitForWebview, handleWebviewFillForm,
} from './tools/navigate.js';
import {
  launchAppSchema, terminateAppSchema,
  handleLaunchApp, handleTerminateApp, handleDeviceInfo,
} from './tools/device.js';
import {
  startRecordingSchema, stopRecordingSchema, addAssertionSchema, getRecordingSchema,
  handleStartRecording, handleStopRecording, handleAddAssertion, handleGetRecording,
} from './tools/recording.js';
import {
  getHealingLogSchema, configureHealingSchema,
  handleGetHealingLog, handleConfigureHealing,
} from './tools/healing.js';
import {
  saveBaselineSchema, compareBaselineSchema, visualRegressionSchema,
  handleSaveBaseline, handleCompareBaseline, handleVisualRegression,
} from './tools/visual.js';
import {
  flutterLocatorSchema, handleFlutterLocator,
} from './tools/locator.js';
import {
  cuaRunTestSchema, handleCuaRunTest,
  cuaReportStepSchema, handleCuaReportStep,
  cuaFinishTestSchema, handleCuaFinishTest,
} from './tools/cua.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'appium-flutter-mcp',
    version: '1.0.0',
  });

  // --- Session Tools ---

  server.tool(
    'connect',
    'Connect to Appium server and create/attach to a Flutter app session. IMPORTANT: Before calling this tool, always ask the user for: (1) platform — ios or android, (2) Dart VM Service URL (ws://...) — ask them to check the Flutter debug console for the Observatory/VM service URL. If the user declines to provide a VM URL, proceed without it (auto-discovery will be attempted).',
    connectSchema.shape,
    async (params) => handleConnect(params),
  );

  server.tool(
    'disconnect',
    'Disconnect from the current Appium session',
    disconnectSchema.shape,
    async (params) => handleDisconnect(params),
  );

  server.tool(
    'get_status',
    'Get current session status, platform, and available contexts',
    {},
    async () => handleGetStatus(),
  );

  // --- Observe Tools ---

  server.tool(
    'get_screen',
    'Take a compressed screenshot of the current app screen. Optionally include interactive widget tree. Screenshots are ephemeral — always re-fetch after actions.',
    getScreenSchema.shape,
    async (params) => handleGetScreen(params) as any,
  );

  server.tool(
    'get_widget_tree',
    'Get the Flutter widget tree structure with interactive elements list. Returns element types, text, keys, positions, and locators. Use interactiveOnly=true for faster results. Use format="compact" for 3-5x fewer tokens.',
    getWidgetTreeCompactSchema.shape,
    async (params) => {
      const tree = await import('./tree/tree-builder.js').then(m => m.buildWidgetTree({
        interactiveOnly: params.interactiveOnly,
        refresh: params.refresh,
      }));
      if (params.format === 'compact') {
        const { formatElementsCompact, summarizeValueKeys } = await import('./util/element-format.js');
        const keySummary = summarizeValueKeys(tree.interactiveElements);
        const compactText = formatElementsCompact(tree.interactiveElements);
        return {
          content: [{
            type: 'text' as const,
            text: keySummary ? `${keySummary}\n\n${compactText}` : compactText,
          }],
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(tree, null, 2) }],
      };
    },
  );

  server.tool(
    'find_elements',
    'Find Flutter elements by locator strategy (key, text, type, semanticsLabel). Returns matched elements with text, position, enabled/displayed state.',
    findElementsSchema.shape,
    async (params) => handleFindElements(params),
  );

  server.tool(
    'get_element_details',
    'Get detailed widget and render diagnostics for a specific element. Expensive — use only when you need deep inspection.',
    getElementDetailsSchema.shape,
    async (params) => handleGetElementDetails(params),
  );

  server.tool(
    'get_known_screen',
    'Identify the current screen using persistent screen maps. If the screen was seen before, returns cached elements instantly (no Appium calls). Use name param to look up a specific screen, or listAll=true to see all known screens. Screen maps are built automatically as you explore.',
    getKnownScreenSchema.shape,
    async (params) => handleGetKnownScreen(params),
  );

  server.tool(
    'flutter_locator',
    'Find the exact locator for a UI element by natural-language description (e.g., "book button", "search field"). Returns the unique locator in compact, raw, and Java formats. Read-only — does not interact with the element. Use topN > 1 to see alternative matches. Use mode="structured" + verify=true for AI-powered locator discovery.',
    flutterLocatorSchema.shape,
    async (params) => handleFlutterLocator(params),
  );

  server.tool(
    'get_locator',
    'AI-powered locator discovery. Returns structured JSON with all candidate locators (key/text/type/semanticsLabel), live verification results (matchCount), parent keys for descendant axis, and Dart source info. Use mode="structured" and verify=true. Claude analyzes the response to pick the single best working Appium locator.',
    flutterLocatorSchema.shape,
    async (params) => handleFlutterLocator({ ...params, mode: 'structured', verify: true }),
  );

  // --- Act Tools ---

  server.tool(
    'tap',
    'Tap/click an element. Supports Flutter (key/text/type/semanticsLabel), Native (xpath/accessibilityId), and WebView (css/xpath) locators. Returns screenshot after action.',
    tapSchema.shape,
    async (params) => handleTap(params) as any,
  );

  server.tool(
    'type_text',
    'Enter text into a field. Supports Flutter (key/text/type/semanticsLabel), Native (xpath/accessibilityId), and WebView (css/xpath) locators. Returns screenshot after action.',
    typeTextSchema.shape,
    async (params) => handleTypeText(params) as any,
  );

  server.tool(
    'gesture',
    'Perform gesture: swipe, scroll_down, scroll_up, long_press, double_tap, or back navigation. Returns screenshot after action.',
    gestureSchema.shape,
    async (params) => handleGesture(params) as any,
  );

  server.tool(
    'wait_for',
    'Wait for an element to appear on screen. Use instead of manual delays after navigation or page transitions. Returns screenshot when found.',
    waitForSchema.shape,
    async (params) => handleWaitFor(params) as any,
  );

  server.tool(
    'scroll_until_visible',
    'Scroll in a direction until a target element becomes visible. Uses Flutter scrollTillVisible for Flutter locators, manual scroll loop for native/webview. Supports specifying a scrollable container.',
    scrollUntilVisibleSchema.shape,
    async (params) => handleScrollUntilVisible(params) as any,
  );

  server.tool(
    'wait_for_page_stable',
    'Wait for the page to stop changing — detects when navigation, loading, or animations have completed by monitoring structural changes. More reliable than fixed delays. Use after navigation, page transitions, or data loading.',
    waitForPageStableSchema.shape,
    async (params) => handleWaitForPageStable(params) as any,
  );

  server.tool(
    'smart_tap',
    'Tap an element by natural-language description (e.g., "Login button", "search field"). Fuzzy-matches against visible elements and taps the best match. Combines element discovery + tap in a single call — no need to call get_widget_tree or find_elements first.',
    smartTapSchema.shape,
    async (params) => handleSmartTap(params) as any,
  );

  server.tool(
    'batch_actions',
    'Execute multiple actions (tap, type_text, gesture, wait_for) in sequence with a single tool call. Only returns the final screen state. Perfect for form fills or multi-step flows. Example: [{action:"tap",params:{target:"emailField"}},{action:"type_text",params:{target:"emailField",text:"user@test.com"}},{action:"tap",params:{target:"submitBtn"}}]',
    batchActionsSchema.shape,
    async (params) => handleBatchActions(params) as any,
  );

  // --- Navigate Tools ---

  server.tool(
    'switch_context',
    'Switch between Flutter, WebView, and Native contexts. Required for hybrid app interaction. Returns current context and all available contexts.',
    switchContextSchema.shape,
    async (params) => handleSwitchContext(params),
  );

  server.tool(
    'inspect_webview',
    'Inspect WebView content: get page source (HTML DOM), execute JavaScript, or get current URL. Auto-switches to WebView context if needed.',
    inspectWebviewSchema.shape,
    async (params) => handleInspectWebview(params),
  );

  server.tool(
    'inspect_native',
    'Inspect native UI. "structured" format returns parsed accessibility tree as JSON with element types, text, labels, rects (recommended). "raw_xml" returns full XML page source.',
    inspectNativeSchema.shape,
    async (params) => handleInspectNative(params),
  );

  server.tool(
    'navigate_to',
    'Navigate to a known screen using the persistent navigation graph. Uses BFS to find shortest path and executes taps automatically. Screens are discovered automatically as you explore the app. Use get_known_screen with listAll=true to see available screens.',
    navigateToSchema.shape,
    async (params) => handleNavigateTo(params),
  );

  server.tool(
    'wait_for_webview',
    'Robust webview lifecycle helper for hybrid (Flutter + WebView) flows. Snapshots existing webview IDs first (so a stale "about:blank" preloaded form context can be skipped), polls `mobile: getContexts` metadata for a NEW webview whose URL matches `urlFragment`, switches to it, then waits for a JS content predicate to become truthy (e.g. `document.querySelectorAll(\'input\').length > 0` for forms). Use this BEFORE inspect_webview/find_elements when entering a form or any webview surface that is loaded asynchronously.',
    waitForWebviewSchema.shape,
    async (params) => handleWaitForWebview(params),
  );

  server.tool(
    'webview_fill_form',
    'Fill multiple form fields by visible label inside the current webview. Walks the DOM to match each {label, value}, finds the associated input/textarea/select via <label for>, nested input, table-row, sibling, or parent fallback, sets the value via the native setter (so React controlled inputs notice it), and dispatches `input`+`change` events. Returns per-field {ok, reason} so you can see which labels matched. Switch to the right webview first (use wait_for_webview).',
    webviewFillFormSchema.shape,
    async (params) => handleWebviewFillForm(params),
  );

  // --- Device & App Lifecycle Tools ---

  server.tool(
    'launch_app',
    'Launch/activate an app by bundle ID (iOS) or package name (Android). Bundle ID / package come from APPIUM_BUNDLE_ID / APPIUM_APP_PACKAGE env when not passed explicitly.',
    launchAppSchema.shape,
    async (params) => handleLaunchApp(params),
  );

  server.tool(
    'terminate_app',
    'Terminate a running app by bundle ID (iOS) or package name (Android).',
    terminateAppSchema.shape,
    async (params) => handleTerminateApp(params),
  );

  server.tool(
    'device_info',
    'Get device information: screen size, orientation, platform, session ID.',
    {},
    async () => handleDeviceInfo(),
  );

  // --- Test Recording & Generation Tools ---

  server.tool(
    'start_recording',
    'Start recording exploration actions for test script generation. All subsequent tap, type_text, gesture, and context switch actions will be captured.',
    startRecordingSchema.shape,
    async (params) => handleStartRecording(params),
  );

  server.tool(
    'stop_recording',
    'Stop the current recording session. Returns a summary of all captured actions.',
    stopRecordingSchema.shape,
    async (params) => handleStopRecording(params),
  );

  server.tool(
    'add_assertion',
    'Add a test assertion to the current recording (e.g., element should be visible, values should match). Used to inject verification points into generated tests.',
    addAssertionSchema.shape,
    async (params) => handleAddAssertion(params),
  );

  server.tool(
    'get_recording',
    'Get the current recording state — shows actions captured so far without stopping the recording.',
    getRecordingSchema.shape,
    async (params) => handleGetRecording(params),
  );

  // --- Self-Healing Locator Tools ---

  server.tool(
    'get_healing_log',
    'View self-healing locator events from this session. Shows when locators were auto-healed, what strategy was used, and confidence scores.',
    getHealingLogSchema.shape,
    async (params) => handleGetHealingLog(params),
  );

  server.tool(
    'configure_healing',
    'Configure self-healing locator behavior. Modes: off (disabled), passive (log only), active (auto-heal). Set confidence thresholds for fuzzy matching.',
    configureHealingSchema.shape,
    async (params) => handleConfigureHealing(params),
  );

  // --- Visual AI Test Oracle Tools ---

  server.tool(
    'save_baseline',
    'Save the current/last recording as a visual baseline. Captures screenshots at each step for future regression comparison.',
    saveBaselineSchema.shape,
    async (params) => handleSaveBaseline(params),
  );

  server.tool(
    'compare_baseline',
    'Compare current screen against a saved baseline step. Detects structural changes: missing/added elements, text changes, layout shifts.',
    compareBaselineSchema.shape,
    async (params) => handleCompareBaseline(params),
  );

  server.tool(
    'visual_regression_report',
    'Run visual regression against a saved baseline. Compares current app state against golden screenshots and reports all differences.',
    visualRegressionSchema.shape,
    async (params) => handleVisualRegression(params),
  );

  // --- CUA (Computer-Use Agent) Test Runner ---
  // Vision-driven, locator-free MD execution. Claude (the caller) is the agent —
  // it reads each step, decides what to tap/type/swipe based on the screen, and
  // reports per-step results. The MCP just tracks state and writes the report.

  server.tool(
    'cua_run_test',
    'Start a CUA-mode test run from a markdown file. Parses the MD, captures the initial screenshot, and returns the first test case (goal, preconditions, numbered steps in plain language, expected outcome) plus execution guidance. The agent (caller) drives the test vision-led but is free to use any primitive — coordinate-based tap/type_text/gesture, locator-based tap/type_text (key/text/type/semanticsLabel/xpath/accessibilityId/css), smart_tap, get_widget_tree, find_elements, flutter_locator. Coordinates are best for visible buttons/icons; locators are usually more reliable for text input on iOS. After each numbered step, call cua_report_step. After the last step, call cua_finish_test. Requires an active Appium session (`connect` first).',
    cuaRunTestSchema.shape,
    async (params) => handleCuaRunTest(params) as any,
  );

  server.tool(
    'cua_report_step',
    'Record the outcome of one numbered step in the active CUA run. Call this once per step, in order, after you finish executing it. The MCP captures a fresh screenshot, attaches it to the step record, and tells you the remaining steps for the current case.',
    cuaReportStepSchema.shape,
    async (params) => handleCuaReportStep(params) as any,
  );

  server.tool(
    'cua_finish_test',
    'Finish the current test case in the active CUA run. verdict="pass" requires every step passed AND the Expected Outcome holds. If more cases remain in the file, returns the next case + screenshot; otherwise writes the HTML+JSON report under runs/cua/<timestamp>/ and clears the run state.',
    cuaFinishTestSchema.shape,
    async (params) => handleCuaFinishTest(params) as any,
  );

  return server;
}

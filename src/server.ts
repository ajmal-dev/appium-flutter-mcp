import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  connectSchema, disconnectSchema,
  handleConnect, handleDisconnect, handleGetStatus,
} from './tools/session.js';
import {
  getScreenSchema, getWidgetTreeCompactSchema,
  findElementsSchema, getKnownScreenSchema,
  handleGetScreen, handleFindElements, handleGetKnownScreen,
} from './tools/observe.js';
import {
  tapSchema, typeTextSchema, gestureSchema, waitForSchema, batchActionsSchema,
  handleTap, handleTypeText, handleGesture, handleWaitFor, handleBatchActions,
} from './tools/act.js';
import {
  switchContextSchema, inspectSchema, navigateToSchema, webviewFillFormSchema,
  webNavigateSchema,
  handleSwitchContext, handleInspect, handleNavigateTo, handleWebviewFillForm,
  handleWebNavigate,
} from './tools/navigate.js';
import { getSessionMode } from './appium/session.js';
import {
  appControlSchema, handleAppControl,
} from './tools/device.js';
import {
  startRecordingSchema, stopRecordingSchema, addAssertionSchema, generateTestSchema,
  handleStartRecording, handleStopRecording, handleAddAssertion, handleGenerateTest,
} from './tools/recording.js';
import {
  zmaShortcutSchema, handleZmaShortcut,
} from './tools/zma-workflows.js';
import {
  flutterLocatorSchema, handleFlutterLocator,
} from './tools/locator.js';
import {
  runZmaTestsSchema, diagnoseFailureSchema, applyFixSchema,
  handleRunZmaTests, handleDiagnoseFailure, handleApplyFix,
} from './tools/debug-loop.js';
import {
  testDebugFixSchema, handleTestDebugFix,
} from './tools/feedback-loop.js';
import {
  agenticCreateTestSchema, handleAgenticCreateTest,
  agenticTestStepSchema, handleAgenticTestStep,
  agenticFinishSchema, handleAgenticFinish,
  worldRecallSchema, handleWorldRecall,
  worldRememberSchema, handleWorldRemember,
} from './tools/agentic.js';
import {
  runFullPipelineSchema, handleRunFullPipeline,
} from './tools/full-pipeline.js';
import {
  worldReviewSchema, handleWorldReview,
} from './tools/world-review.js';
import {
  startTapInspectSchema, handleStartTapInspect,
  getTapSelectionSchema, handleGetTapSelection,
  stopTapInspectSchema, handleStopTapInspect,
  verifyLocatorSchema, handleVerifyLocator,
} from './tools/tap-inspect.js';
import { SERVER_INSTRUCTIONS } from './server-instructions.js';

export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'appium-flutter-mcp', version: '1.0.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // --- ZMA-Specific Workflow Tools ---

  server.tool(
    'zma_shortcut',
    'Run a canned app flow: flow="login" performs login (settings → env → account → WebView credentials → Login; auto-connects to Appium if needed); flow="navigate_to_guest" searches and opens a guest profile; flow="select_appointment" finds and taps an appointment card by guest name.',
    zmaShortcutSchema.shape,
    async (params) => handleZmaShortcut(params),
  );

  // --- Session Tools ---

  server.tool(
    'connect',
    'Connect to Appium server and create/attach to a Flutter app session. IMPORTANT: Before calling this tool, always ask the user for: (1) platform — ios or android, (2) Dart VM Service URL (ws://...) — ask them to check the Flutter debug console for the Observatory/VM service URL. If the user declines to provide a VM URL, proceed without it (auto-discovery will be attempted). After connecting, always check vmService.connected in the response — without it, text/key finders return empty results even for visible widgets.',
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
    'Get current session status: platform, current/available contexts, VM service connection, device info (screen size, orientation, session ID), active recording state, and current-screen hint from the persistent screen map.',
    {},
    async () => handleGetStatus(),
  );

  // --- Observe Tools ---

  server.tool(
    'get_screen',
    'Take a compressed screenshot of the current app screen. Optionally include interactive widget tree. Screenshots are ephemeral — always re-fetch after actions. NOTE: positions in the screenshot are pixels at the image resolution, NOT device points; to tap a position from a screenshot, scale it: device_x = image_x * 1180 / image_width (landscape iPad is 1180×820 device points).',
    getScreenSchema.shape,
    async (params) => handleGetScreen(params) as any,
  );

  server.tool(
    'get_widget_tree',
    'Get the Flutter widget tree with text labels, keys, and locators. Defaults to format="tree" — a pruned hierarchy rendered as indented text (one node per line: Type key:… "text"). Use format="compact" for a flat numbered element list, format="full" only for raw JSON debugging.',
    getWidgetTreeCompactSchema.shape,
    async (params) => {
      // Flutter-mode guard — the widget tree is fetched via the Flutter Integration
      // driver over the Dart VM. In Safari / native XCUITest sessions there is no
      // widget tree; short-circuit with guidance instead of firing a hopeless request.
      const mode = getSessionMode();
      if (mode !== 'flutter') {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: true,
              message: `get_widget_tree is Flutter-only (current sessionMode = "${mode}"). ` +
                (mode === 'safari'
                  ? 'For Safari use inspect(target:"webview") to list DOM elements, or execute JS via inspect(action:"execute_js").'
                  : 'For native XCUITest use inspect(target:"native") to get the accessibility tree.'),
            }, null, 2),
          }],
        };
      }
      // Both "full" and "tree" need the actual hierarchical tree fetched — buildWidgetTree's
      // interactiveOnly controls whether the tree is fetched AT ALL, not just how it's
      // filtered afterward. Force a real fetch for both; the caller's interactiveOnly is
      // applied afterward, as pruning semantics, for format:"tree".
      const needsTree = params.format === 'full' || params.format === 'tree';
      const tree = await import('./tree/tree-builder.js').then(m => m.buildWidgetTree({
        interactiveOnly: needsTree ? false : params.interactiveOnly,
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

      if (params.format === 'tree') {
        const { pruneTreeForLocators, renderTreeAsText } = await import('./tree/prune-tree.js');
        const { summarizeValueKeys } = await import('./util/element-format.js');
        const raw = tree.tree;
        const prunedNodes = raw == null
          ? []
          : (Array.isArray(raw) ? raw : [raw])
            .map(n => pruneTreeForLocators(n, { interactiveOnly: params.interactiveOnly }))
            .filter((n): n is NonNullable<typeof n> => n !== null);

        // Indented-text rendering: hierarchical like JSON, ~8-10x fewer tokens,
        // and no duplicated flat interactiveElements list.
        const header = `context=${tree.context} source=${tree.source} elements=${tree.elementCount} interactive=${tree.interactiveCount}`;
        const keySummary = summarizeValueKeys(tree.interactiveElements);
        const treeText = prunedNodes.length > 0
          ? prunedNodes.map(n => renderTreeAsText(n)).join('\n')
          : '(tree unavailable)';
        return {
          content: [{
            type: 'text' as const,
            text: [header, keySummary, '', treeText].filter(Boolean).join('\n'),
          }],
        };
      }

      // format === 'full' — unchanged, intentionally unfiltered for debugging
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(tree, null, 2) }],
      };
    },
  );

  server.tool(
    'find_elements',
    'Find Flutter elements by locator strategy (key, text, type, semanticsLabel). Returns matched elements with text, position, enabled/displayed state. Set details=true for deep widget + render diagnostics (expensive). WARNING: returns count:0 for ALL strategies when vmService is disconnected — call get_status first to verify vmService.connected, or a zero result proves nothing.',
    findElementsSchema.shape,
    async (params) => handleFindElements(params),
  );

  server.tool(
    'get_known_screen',
    'Identify the current screen using persistent screen maps. If the screen was seen before, returns cached elements instantly (no Appium calls). Use name param to look up a specific screen, or listAll=true to see all known screens. Screen maps are built automatically as you explore.',
    getKnownScreenSchema.shape,
    async (params) => handleGetKnownScreen(params),
  );

  server.tool(
    'flutter_locator',
    'Find the exact locator for a UI element by natural-language description (e.g., "book button", "search field"). Read-only — does not interact with the element. Default mode returns the unique locator in compact, raw, and Java format ready for the ZMA automation project; use topN > 1 for alternatives. For locator-discovery workflows use mode="structured" + verify=true: returns JSON with ALL candidate locators (key/text/type/semanticsLabel), live verification results (matchCount), parent keys for descendant-axis disambiguation, and Dart source info.',
    flutterLocatorSchema.shape,
    async (params) => handleFlutterLocator(params),
  );

  // --- Act Tools ---

  server.tool(
    'tap',
    'Tap/click an element. Supports Flutter (key/text/type/semanticsLabel), Native (xpath/accessibilityId), WebView (css/xpath) locators, coordinates (x/y), or a natural-language description (fuzzy-matches visible elements — no locator needed). Returns screenshot after action. NOTE: elements reporting disabled/enabled=false are usually still tappable — in Flutter, GestureDetectors and list rows set enabled=false in semantics as an artifact; tap them anyway.',
    tapSchema.shape,
    async (params) => handleTap(params) as any,
  );

  server.tool(
    'type_text',
    'Enter text into a field. Supports Flutter (key/text/type/semanticsLabel), Native (xpath/accessibilityId), and WebView (css/xpath) locators. Returns screenshot after action. WARNING: do NOT tap a Flutter TextField before typing — the keyboard breaks widget re-resolution on that screen; use clearFirst=true instead of a separate tap to clear and focus. Exception: the calendar guest-search field — its clear() crashes with RangeError; clear it via the built-in X button (coordinate tap ~742,65) instead.',
    typeTextSchema.shape,
    async (params) => handleTypeText(params) as any,
  );

  server.tool(
    'gesture',
    'Perform gesture: swipe, scroll_down, scroll_up, long_press, double_tap, back, or scroll_until_visible (scrolls until target element appears — uses Flutter scrollTillVisible for Flutter locators). Returns screenshot after action.',
    gestureSchema.shape,
    async (params) => handleGesture(params) as any,
  );

  server.tool(
    'wait_for',
    'Wait for an element to appear (target + by), or — with no target — wait for the page to become STABLE (no structural changes; use after navigation, transitions, or data loading). Use instead of manual delays. Returns screenshot when done.',
    waitForSchema.shape,
    async (params) => handleWaitFor(params) as any,
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
    'Switch between Flutter, WebView, and Native contexts. Required for hybrid app interaction. For webviews that spawn asynchronously (booking wizard, guest form): set waitForNew=true + urlFragment to snapshot existing webview IDs, wait for the NEW matching webview, switch to it, and optionally wait for a contentPredicate (e.g. form inputs present). Returns current context and all available contexts.',
    switchContextSchema.shape,
    async (params) => handleSwitchContext(params),
  );

  server.tool(
    'inspect',
    'Inspect the non-Flutter layers of the app. target="webview": action="elements" (default) returns a compact numbered list of interactive DOM elements with ready-to-tap CSS selectors (pass selector:".b-sch-event" etc. to widen the scan); "page_source" returns stripped+capped HTML; "execute_js" runs JS; "get_url" returns the URL. target="native": parsed accessibility tree as JSON (or raw_xml page source) — use for system dialogs and permission prompts.',
    inspectSchema.shape,
    async (params) => handleInspect(params),
  );

  server.tool(
    'navigate_to',
    'Navigate to a known screen using the persistent navigation graph. Uses BFS to find shortest path and executes taps automatically. Screens are discovered automatically as you explore the app. Use get_known_screen with listAll=true to see available screens.',
    navigateToSchema.shape,
    async (params) => handleNavigateTo(params),
  );

  server.tool(
    'webview_fill_form',
    'Fill multiple form fields by visible label inside the current webview. Walks the DOM to match each {label, value}, finds the associated input/textarea/select via <label for>, nested input, table-row, sibling, or parent fallback, sets the value via the native setter (so React controlled inputs notice it), and dispatches `input`+`change` events. Returns per-field {ok, reason} so you can see which labels matched. Switch to the right webview first (switch_context with waitForNew + urlFragment).',
    webviewFillFormSchema.shape,
    async (params) => handleWebviewFillForm(params),
  );

  server.tool(
    'web_navigate',
    'Load a URL in the Safari browser session (Mobile Safari on iOS). ONLY works when the session was started with capabilities `browserName:"Safari"` + `automationName:"XCUITest"` (i.e. sessionMode="safari"). Returns the final URL, page title, and readiness state. Follow-up with get_screen for a screenshot or inspect(target:"webview") for DOM elements.',
    webNavigateSchema.shape,
    async (params) => handleWebNavigate(params),
  );

  // --- Device & App Lifecycle Tools ---

  server.tool(
    'app_control',
    'Launch/activate or terminate an app by bundle ID (iOS) or package name (Android). Defaults to APPIUM_BUNDLE_ID. Launch auto-scans the screen after the app settles.',
    appControlSchema.shape,
    async (params) => handleAppControl(params),
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
    'generate_test',
    'Generate a ZMA-compatible Java test class from the recorded exploration actions (TestNG, extends BaseTest, AppActions, page objects, proper locators, context handling). Set export=true to also write the test + page objects directly into the automation project (reuses existing page objects; dryRun=true previews without writing). Check recording progress anytime via get_status.',
    generateTestSchema.shape,
    async (params) => handleGenerateTest(params),
  );

  // --- Debug Loop Tools ---

  server.tool(
    'run_zma_tests',
    'Run ZMA UI automation tests (mvn test). IMPORTANT: always ask the user which platform to run on first (ios = physical iPad, ios-simulator = simulator, android) and pass it as "platform" — calling without it returns the available platform list instead of running. Optionally pass suiteXmlFile to run a different suite (default testng.xml). Returns structured results with pass/fail summary, failure reports (JSON with last action, locator, action history, screenshots), and diagnosis-ready context. Use debugMode=true to keep driver alive on failure for live debugging.',
    runZmaTestsSchema.shape,
    async (params) => handleRunZmaTests(params) as any,
  );

  server.tool(
    'diagnose_failure',
    'Diagnose a test failure by comparing failure context (from JSON report) with live device state. Connects to device, tries the failing locator, fuzzy-matches alternatives, compares element trees, and classifies root cause (locator_changed, timing_issue, coordinate_drift, etc.). Returns diagnosis with suggested fixes.',
    diagnoseFailureSchema.shape,
    async (params) => handleDiagnoseFailure(params) as any,
  );

  server.tool(
    'apply_fix',
    'Apply a code fix to the zmauiautomation project. Supports: update_locator, add_wait, update_coordinate, add_scroll, change_context, custom. Modifies the source file and returns a diff.',
    applyFixSchema.shape,
    async (params) => handleApplyFix(params) as any,
  );

  server.tool(
    'test_debug_fix',
    'Full automated feedback loop: run tests → diagnose failures → apply fixes → re-run. Iterates up to maxIterations times. Set autoFix=true to automatically apply fixes with confidence > 0.8. IMPORTANT: always ask the user which platform first (ios / ios-simulator / android) and pass it as "platform" — without it the loop does not start.',
    testDebugFixSchema.shape,
    async (params) => handleTestDebugFix(params) as any,
  );

  // --- Agentic Test Creation (autonomous "create a test for X" workflow) ---
  // Single entry point that ties together: explore → record → assert →
  // generate Java test → export into the zmauiautomation project → mvn verify
  // → persist a flow record for cross-run learning. The MCP does no LLM work;
  // it hands the agent a tight contract per cycle and runs the deterministic
  // phases (codegen, export, verify, memory writes) itself.

  server.tool(
    'agentic_create_test',
    'Start an autonomous "create a test case for X" run. Captures the current device state, recalls matching flows / pitfalls / existing tests from the world model, and returns a structured agent contract telling you exactly how to drive the run. The orchestrator starts a recording for you; every tap / type_text / gesture is captured. You loop by calling agentic_test_step until the goal is verified, then agentic_finish to codegen + export + mvn verify + commit a flow record. Use this when the user asks to "create a test for ...", "write a test that ...", or "automate the X flow". Requires an active Appium session.',
    agenticCreateTestSchema.shape,
    async (params) => handleAgenticCreateTest(params) as any,
  );

  server.tool(
    'agentic_test_step',
    'Report progress on the active agentic run and receive a LEAN cycle update (screen-change flag, element delta, screenshot only when the screen changed). Call at CHECKPOINTS — after a screen transition, sub-goal, phase advance, or when stuck — NOT after every micro-action (actions are auto-recorded regardless). Use screenshot:"never" for text-only cycles, "always" to force a capture. The server tracks step-budget and no-progress streaks; if a stop condition fires the response will say so.',
    agenticTestStepSchema.shape,
    async (params) => handleAgenticTestStep(params) as any,
  );

  server.tool(
    'agentic_finish',
    'Finish the active agentic run. verdict="pass" triggers the deterministic pipeline: stop recording → generateTestScript (reuses existing page objects) → exportToProject → `mvn -q -DskipTests compile` → write the flow record + test-inventory entry. verdict="fail" / "abort" writes a pitfall entry so future runs can avoid the trap. The run report (JSON + HTML) is written to runs/agentic/<runId>/.',
    agenticFinishSchema.shape,
    async (params) => handleAgenticFinish(params) as any,
  );

  server.tool(
    'world_recall',
    'Query the persistent agentic world model: prior flows (named sequences that accomplish a goal), pitfalls (known failure patterns), and the test inventory (Java tests generated so far). Use this before starting a run to check what is already known about the goal, or any time mid-run to look up adjacent flows.',
    worldRecallSchema.shape,
    async (params) => handleWorldRecall(params) as any,
  );

  server.tool(
    'world_remember',
    'Write a learning entry to the world model. Mostly used internally by agentic_finish, but exposed so you can manually capture flows / pitfalls / inventory entries (e.g. when porting in tests authored outside the agentic loop).',
    worldRememberSchema.shape,
    async (params) => handleWorldRemember(params) as any,
  );

  server.tool(
    'world_review',
    'Triage accumulated pitfalls + telemetry for the current app into three buckets: ' +
    '(1) tool-gaps → MCP improvements; (2) knowledge-to-codify → /zena-skillify proposals; ' +
    '(3) app/env JIRA candidates. Invoke after any MCP-heavy skill run to surface what is worth codifying. ' +
    'Also surfaces the driver-capability profile (e.g. VM driver commands known-broken) and per-strategy success rates.',
    worldReviewSchema.shape,
    async (params) => handleWorldReview(params) as any,
  );

  // --- Full Test-Run Pipeline ---

  server.tool(
    'run_full_pipeline',
    'End-to-end test pipeline for physical iOS device or simulator: ' +
    '(1) preflight — verify repos, branch, device, Appium port; ' +
    '(2) checkout — git switch the configured source repos to the given branch; ' +
    '(3) deps — flutter clean + flutter pub upgrade; ' +
    '(4) ios_setup — patch Podfile (platform 14.0 + Runner target block with flutter_install_all_ios_pods) + replace Info.plist with Appium-ready config; ' +
    '(5) build_install — flutter run --release -t appium_launcher.dart (mirrors "Appium Test (Release)" VS Code config), detaches after launch; ' +
    '(6) appium_up — spawn Appium server, wait for ready; ' +
    '(7) run_tests — mvn clean test (testng.xml by default); ' +
    '(8) teardown — kill processes, restore stashes, write HTML+JSON report. ' +
    'Use target="simulator" to run on the simulator configured in APPIUM_UDID env var. ' +
    'Use skipCheckout=true or skipBuild=true to iterate fast on already-prepared state.',
    runFullPipelineSchema.shape,
    async (params) => handleRunFullPipeline(params) as any,
  );

  // --- Physical Tap Inspector (Flutter, debug builds only) ---

  server.tool(
    'start_tap_inspect',
    'Turn ON Flutter "select widget mode" so a PHYSICAL TAP on the device/simulator selects the widget under your finger. ' +
    'Requires a DEBUG build (ext.flutter.inspector.* extensions are debug-only) and a Dart VM Service connection — ' +
    'reuses the active VM connection, or pass vmServiceUrl (the ws:// URL from `flutter run --debug` output). ' +
    'After calling this, tap a widget on the device, then call get_tap_selection to read what you tapped. ' +
    'This is the conversational counterpart to the `npm run inspect:web` browser UI.',
    startTapInspectSchema.shape,
    async (params) => handleStartTapInspect(params),
  );

  server.tool(
    'get_tap_selection',
    'Read the widget the user most recently tapped on the device (after start_tap_inspect). Returns the widget type, ' +
    'key/text/semanticsLabel, Dart source file:line, and ranked ready-to-paste AppActions locator lines ' +
    '(actions.byValueKey("...") etc.) with the recommended one first. Call repeatedly as the user taps different widgets.',
    getTapSelectionSchema.shape,
    async () => handleGetTapSelection(),
  );

  server.tool(
    'stop_tap_inspect',
    'Turn OFF Flutter select widget mode and tear down the tap-inspect session. Call when finished inspecting.',
    stopTapInspectSchema.shape,
    async () => handleStopTapInspect(),
  );

  server.tool(
    'verify_locator',
    'Check whether a Flutter locator actually resolves on the CURRENT screen and how many widgets it matches — ' +
    'the VM-side equivalent of pasting an XPath into a browser\'s Elements panel. Walks the live widget tree and returns ' +
    'matchCount + verdict (UNIQUE = 1 match = safe, NOT UNIQUE = >1, NOT FOUND = 0), highlights the first match on the device, ' +
    'and (best-effort) confirms via the Flutter driver finder when available. Requires a connected VM (call start_tap_inspect or connect first).',
    verifyLocatorSchema.shape,
    async (params) => handleVerifyLocator(params),
  );

  return server;
}

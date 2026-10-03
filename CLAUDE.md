# Appium Flutter MCP — Claude Instructions

> **Automation rulebook**: See `RULES.md` in this repo for the full 15-section set of hard-won rules (locator hierarchy, RichText limits, typeahead resolution, platform-view walls, assertion quality, failure triage, and more). A compact distillation is embedded as the MCP server's `instructions` and surfaces automatically on connect.

## Automation Target — `zenappautomation` (READ FIRST when creating tests)

The automation project for generated/authored tests is **`/Users/ajmal/projects/zenappautomation`**
(`AUTOMATION_PROJECT_PATH`), a Maven reactor whose tests live in the **`zma-tests`** module
(package `zma.*`, base classes `com.zena.automation.*`). This replaced the legacy
`zmauiautomation` project.

**When the user asks to "create a test from the steps performed via MCP" (or any create-test
request), you author the Java test yourself** in the idiomatic `zenappautomation` **`app` DSL**
(`app.flutter().getByKey("...").tap()`, `expect(...).toBeVisible()`), extending `ZenaTest` with an
`@ZenAppLogin` annotation. **Do NOT rely on the MCP's `generate_test` / `export_to_project` /
`agentic_finish` auto-codegen** — it emits the legacy `zmauiautomation` style (`com.zma.*`,
`extends BaseTest`, no login) that will not compile or log in against `zenappautomation`.

- **Full workflow + copy-paste templates:** [`docs/ZENAPPAUTOMATION_TEST_AUTHORING.md`](docs/ZENAPPAUTOMATION_TEST_AUTHORING.md)
- **Canonical framework conventions:** `/Users/ajmal/projects/zenappautomation/CLAUDE.md`

Use the MCP live tools (`get_screen`, `get_widget_tree`, `get_locator`/`flutter_locator`,
`find_elements`, `tap`, `type_text`, `switch_context`) for **discovery and verification**; use the
`Write` tool to author the `.java`; verify with `mvn -pl zma-tests -am test -Dtest=... -Dzena.profile=ios-device`
from the reactor root.

## Full Test-Run Pipeline

When the user says **"run the test suite"**, **"run all tests on device"**, **"run testng on the iPad"**, **"run the full pipeline"**, or anything that implies end-to-end test execution on a physical device or simulator, use `run_full_pipeline`.

### Key parameters

| Parameter | Default | Notes |
|---|---|---|
| `branch` | `ajmal/appium-local-qaready` | Branch for all 3 source repos |
| `target` | `device` | `"device"` = physical iOS; `"simulator"` = simulator (reads `APPIUM_UDID` env) |
| `suiteXmlFile` | `testng.xml` | Use `testng-bw.xml` for WebView tests |
| `skipCheckout` | `false` | Skip git ops — useful when already on the right branch |
| `skipBuild` | `false` | Skip flutter run — useful when app already installed |
| `force` | `false` | Stash dirty working trees instead of refusing |
| `keepAppiumRunning` | `false` | Leave Appium alive after tests for debugging |

### What it does (8 phases)

1. **preflight** — verify repos, branch reachable, device detected, port free
2. **checkout** — `git checkout <branch>` in the Flutter app repo and any shared component packages you configure
3. **deps** — `flutter clean` → `flutter pub upgrade`
4. **ios_setup** — patch `ios/Podfile` (platform → 14.0, replace Runner target block with `flutter_install_all_ios_pods`) + replace `ios/Runner/Info.plist` with Appium-ready config
5. **build_install** — `flutter run --release -t appium_launcher.dart -d <udid>`, detaches (presses 'd') after "Flutter run key commands" appears
6. **appium_up** — spawns `appium --log-level info --port 4723`, waits for "listener started"
7. **run_tests** — `mvn clean test` (or custom suite XML)
8. **teardown** — kills processes, pops stashes, writes `runs/pipeline/<runId>/index.html`

### Example calls

```
run_full_pipeline({ branch: "ajmal/appium-local-qaready", target: "device" })
run_full_pipeline({ branch: "ajmal/appium-local-qaready", target: "simulator" })
run_full_pipeline({ skipCheckout: true, skipBuild: true })  // just re-run tests
run_full_pipeline({ suiteXmlFile: "testng-bw.xml", target: "device" })
```

---

## Locator Discovery Workflow

When the user asks for a locator (e.g., "give me locator for book button", "what's the locator for settings icon"):

### Step 1: Get structured locator data
Call `flutter_locator` with `mode: "structured"`, `verify: true`:
```
flutter_locator({ description: "<user's description>", mode: "structured", verify: true })
```

### Step 2: Analyze the JSON response
The response contains:
- `bestMatch` — the element that best matches the description (type, text, key, position, confidence)
- `candidates` — ordered list of locator strategies with verification results:
  - `by`: locator strategy (key, text, type, semanticsLabel, css, xpath, accessibilityId)
  - `value`: the locator value
  - `verified`: whether `findElements()` found it on device
  - `matchCount`: how many elements match (1 = unique = ideal)
  - `javaCode`: ready-to-paste Java line
  - `priority`: lower = better (key=1, semanticsLabel=2, text=3, type=4)
- `parentKeys` — nearby parent elements with ValueKeys (for descendant axis disambiguation)
- `sourceInfo` — where the key is defined in Dart source code

### Step 3: Pick the best locator
1. Find the highest-priority candidate where `verified: true` AND `matchCount: 1` (unique + working)
2. Return its `javaCode` value — that's the final answer

### Step 4: Handle non-unique locators
If no candidate has `matchCount === 1`:

**Option A — Index:** If a candidate has `matchCount > 1`, use `find_elements` to get all matches, compare positions to identify the correct index:
```
actions.byText("Book")  // index: 2
```

**Option B — Descendant axis (preferred for stability):** Use `parentKeys` from the response to build a scoped locator:
```java
WebElement parent = actions.byValueKey("<parentKey>");
WebElement target = parent.findElement(FlutterBy.text("<value>"));
```
Verify the parent is unique by calling `find_elements(by: "key", value: "<parentKey>")` — it should return count=1.

### Step 5: Format the response

> **For `zenappautomation`:** the idiomatic form in a test is the `app` DSL —
> `app.flutter().getByKey("...")`, `.getByText("...")`, `.getBySemanticsLabel("...")`,
> `.getByType("...")`, non-unique → `.getAllBy...("x").get(idx)`. The `AppActions` form below is
> for **page objects** (`zma/pages/flutter`). See the full mapping table in
> [`docs/ZENAPPAUTOMATION_TEST_AUTHORING.md`](docs/ZENAPPAUTOMATION_TEST_AUTHORING.md#locator-strategy--dsl-call).

Return the SINGLE best Java locator line using AppActions syntax:

**Flutter context:**
- `actions.byValueKey("login_button_submit")` — ValueKey (preferred)
- `actions.bySemanticsLabel("Close dialog")` — semantics label
- `actions.byText("Book Now")` — display text
- `actions.byType("ElevatedButton")` — widget type (least preferred)

**Native context:**
- `actions.nativeFindByAccessibilityId("login_btn")`
- `actions.nativeFindByXPath("//XCUIElementTypeButton[@name='Done']")`

**WebView context:**
- `actions.webFindByCss("button.btn-book")`
- `actions.webFindByXPath("//button[text()='Book']")`

**Descendant pattern (when element is not unique):**
```java
WebElement parent = actions.byValueKey("appointment_card_0");
WebElement target = parent.findElement(FlutterBy.text("Book"));
```

If `sourceInfo` is present, mention where the key is defined:
> Source: LoginKeys.submit (test_keys/zma_test_keys.dart:14)

### Priority Order
Always prefer locators in this order:
1. **ValueKey** — most stable, survives UI text changes
2. **semanticsLabel** — stable accessibility label
3. **text** — readable but breaks on text changes
4. **type + index** — fragile, only when nothing else works
5. **descendant axis** — use when the simple locator matches multiple elements

## Persistent Screen Memory (cross-session navigation)

Screens are remembered across sessions at `~/.appium-flutter-mcp/screen-maps/<appId>/`. Identity is **structural** (ValueKeys, semantics labels, button/tab chrome, widget-type histogram — never dynamic text), so revisiting a screen with different data resolves to the same entry and its navigation edges + locator cache keep accumulating.

**Use it like this:**

1. **Recognize before exploring.** On a new screen, call `get_known_screen` (no args) — if it's known, the response includes cached elements and outgoing navigation edges. Don't re-explore known territory.
2. **Bind names to important screens.** When you land on a screen the user refers to by name (e.g. "Medical Record"), bind it: `get_known_screen({ bindName: "Medical Record" })` — or `agentic_test_step({ screenName: "Medical Record" })` during agentic runs. Agent-bound names are canonical, survive merges, and are never overwritten; old names become aliases.
3. **Navigate by name.** `navigate_to({ screen: "Medical Record" })` BFS-walks recorded edges and executes the taps. Name lookup is fuzzy: canonical name, aliases, Dart route name, and widget class (camelCase-aware) all match.
4. **Maintenance is automatic.** Duplicate/ghost entries are merged on `connect` (and on contact during recording). Manual run: `npx tsx scripts/consolidate-screen-maps.ts [appId]`. Store sanity checks: `APPIUM_FLUTTER_MCP_HOME=$(mktemp -d) npx tsx scripts/verify-screen-map.ts`.

## Interactive Driving Notes

When driving the app step-by-step (exploration or agentic runs):

- **Tap on a visible button/icon** → `tap({ by: "coordinates", x, y })` is usually fine. Coordinates are device pixels — use them straight from the screenshot, which is at device resolution.
- **Type into a text field** → prefer locator-based `type_text({ by: "key"|"text"|"type"|"semanticsLabel", target, text })`. On iOS without an on-screen keyboard, coordinate-based typing falls back to `mobile-keys` and silently drops characters; the locator path uses the Flutter VM's `enterText` and works reliably.
- **Several similar elements** → `get_widget_tree({ format: "compact", interactiveOnly: true })` or `find_elements({ by, value })` to pick the right index.
- **Verification-only step** → `find_elements` or `get_widget_tree` is enough; no need to interact.
- Re-fetch with `get_screen` after any state-changing action.

### When to use which

- Locator-based scripted path (`flutter_locator` + `tap`/`type_text`/`batch_actions`) — when ValueKeys exist, the steps are deterministic, and you want a fast, repeatable run.
- Agentic create-test path (`agentic_create_test` / `agentic_test_step` / `agentic_finish`) — when the user says **"create a test for X"** / **"automate this flow"**. The MCP drives the contract; you explore, record, assert, and on `verdict: "pass"` it codegens a Java test into `zmauiautomation`, mvn-verifies it, and commits a flow record so the next run is faster.

## Agentic Test Creation Workflow

> ⚠️ **For `zenappautomation`, prefer the AI-authored path in
> [`docs/ZENAPPAUTOMATION_TEST_AUTHORING.md`](docs/ZENAPPAUTOMATION_TEST_AUTHORING.md), not this
> section's auto-codegen.** `agentic_finish` on `verdict:"pass"` runs `generate_test` →
> `export_to_project` → `mvn compile`, which emits legacy `zmauiautomation` code (`com.zma.*`,
> `extends BaseTest`, no `@ZenAppLogin`) that will not compile or log in against `zenappautomation`.
> Use the MCP's live discovery tools to explore/verify, then **`Write` the `.java` yourself** in
> the `app` DSL and verify with `mvn`. The workflow below documents the legacy `zmauiautomation`
> pipeline and is retained for reference / that project only.

When the user says **"create a test for ..."**, **"write a test that ..."**, **"automate the X flow"**, or any similar autonomous create-test request, use this workflow. The MCP makes no LLM calls — you are the agent. The orchestrator just hands you a tight per-cycle contract and runs the deterministic phases for you.

### Single entry point

```
agentic_create_test({
  goal: "Create a test for booking a guest appointment",
  projectPath?: "/path/to/your/automation-project",  // optional, defaults to AUTOMATION_PROJECT_PATH
  testClassName?: "BookGuestAppointmentTest",             // optional, inferred from goal
  packageName?: "zma.tests.booking",        // optional
  maxSteps?: 60,
  exportOnSuccess?: true,
  verifyWithMaven?: true,
})
```

The first response contains:
- The agent contract (phase playbook + locator playbook + stop conditions).
- A `## Recalled flows` block (matching prior runs — try the replay sketch first).
- A `## Known pitfalls` block (traps to avoid).
- An "Existing test for this goal" hint if the test inventory already has one (prefer augmenting over duplicating).
- The initial screenshot + element summary.

### Per-cycle loop

After every action you take (tap, type_text, gesture, switch_context, navigate_to, add_assertion, …), call:

```
agentic_test_step({
  status: "ok" | "progress" | "stuck" | "note",
  observation: "<one sentence — what you did, what you saw>",
  phase?: "GROUND" | "PLAN" | "EXPLORE_EXECUTE" | "VERIFY" | "FINISH",  // monotonic
  screenName?: "AppointmentBook"  // optional — bind the current screen to a name for memory
})
```

Phases are monotonic — you cannot regress. Bump them as you make progress: `GROUND` (find your footing) → `PLAN` (replay vs extend vs explore) → `EXPLORE_EXECUTE` (drive the app) → `VERIFY` (`add_assertion` then sanity-check).

The response includes: a fresh screenshot, current screen name, "screen changed since last step?" hint, error scan if the previous action failed, and an updated contract block. **Do not stop calling step until you have a captured assertion and are ready to finish.**

### Stop conditions (server-enforced)

- **Step budget**: default 60 steps. If hit, the response prepends `STOP CONDITION FIRED: step_budget` — call `agentic_finish({ verdict: "abort", summary })` unless you have a pass.
- **No-progress streak**: 3 consecutive steps in `EXPLORE_EXECUTE` with no screen change AND no recorded action. Same — abort with a clear summary.
- **Hard blocker** (auth blocked, app crashed, session dropped): finish with `verdict: "abort"`. The pitfall record captures the screen fingerprint so the next run avoids the trap.

### Finishing

```
agentic_finish({ verdict: "pass" | "fail" | "abort", summary: "<one paragraph>" })
```

On `verdict: "pass"` the orchestrator runs the deterministic pipeline:
1. Stops the recording (auto-started on `agentic_create_test`).
2. Calls `generate_test` internally, reusing existing page objects via `scanProject`.
3. Runs the export step — writes the Java test class and any new page objects into `zmauiautomation` (same engine as `generate_test({export: true})`).
4. Runs `mvn -q -DskipTests compile` to verify the generated code is syntactically valid.
5. Writes a flow record to `~/.appium-flutter-mcp/flows/<appId>/<flowId>.json` (or bumps the success count if it already exists).
6. Writes an entry to `~/.appium-flutter-mcp/test-inventory/<appId>.json`.
7. Writes `runs/agentic/<runId>/{report.json, index.html}`.

On `fail` / `abort`: writes a pitfall to `~/.appium-flutter-mcp/pitfalls/<appId>.json`, leaves the recording intact in `lastRecording` so you can inspect or retry, and still writes the run report.

### Mid-run world-model access

Use `world_recall({ scope: "flows" | "pitfalls" | "inventory" | "all", query, limit? })` any time you want to look up adjacent knowledge. It's also what the orchestrator runs internally at start.

### Hybrid app reminder

Always pick the locator family that matches the current context:
- **Flutter** (default): `flutter_locator` → `tap`/`type_text` with `by: "key"|"semanticsLabel"|"text"|"type"`. Coordinates only as last resort.
- **WebView** (payment, embedded portals, web login form): `switch_context({to: "webview", urlFragment, waitForNew: true})` → `webview_fill_form` for forms or `by: "css"|"xpath"`.
- **Native** (system dialogs, permission prompts): `inspect({target: "native"})` → `by: "accessibilityId"|"xpath"`.

The contract shows the current context — switch before acting when it changes.

### ZMA known webviews

Hybrid apps often expose booking surfaces as WKWebViews. The session is configured with `appium:webviewConnectTimeout` + `appium:webviewConnectRetries` so `mobile: getContexts` enumerates them; the agentic preflight prints the live list with URLs.

Standard URL fragments (match these exactly via `switch_context({to: "webview", urlFragment: ...})` — add `waitForNew: true` for freshly-spawned webviews; these mirror the `BookingWizardPage` / `GuestFormPage` helpers in `zmauiautomation`):

- **Booking Wizard** — opened by the Book button. `urlFragment: "/appointmentbook"`. Search field placeholder: `input[placeholder="Search by Guest name, mobile, email, code"]`. Switch the moment after `tap({by: "text", target: "Book"})`.
- **Guest Form** — `urlFragment: "AppointmentCustomDataV2.aspx"`. Form-ready predicate: `document.querySelectorAll('input').length > 0`. Drive with `webview_fill_form({fields: [...]})` once switched.

After webview interactions finish, return to native UI with `switch_context({to: "native"})`. The MCP keeps the last active webview ID in memory so re-entering is cheap.

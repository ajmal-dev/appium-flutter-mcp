# Appium Flutter MCP — Claude Instructions

This file teaches Claude (or any MCP-aware assistant) how to use the tools in
this server effectively. The MCP itself is locator-agnostic — these notes
encode the conventions that make tests reliable across runs.

## Locator Discovery Workflow

When the user asks for a locator (e.g., "give me locator for book button",
"what's the locator for settings icon"):

### Step 1: Get structured locator data
Call `get_locator` (or `flutter_locator` with `mode: "structured"`, `verify: true`):
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
- `sourceInfo` — where the key is defined in Dart source code (when `FLUTTER_APP_PATH` is configured)

### Step 3: Pick the best locator
1. Find the highest-priority candidate where `verified: true` AND `matchCount: 1` (unique + working)
2. Return its `javaCode` value — that's the final answer

### Step 4: Handle non-unique locators
If no candidate has `matchCount === 1`:

**Option A — Index:** If a candidate has `matchCount > 1`, use `find_elements` to get all matches, compare positions to identify the correct index:
```
byText("Book")  // index: 2
```

**Option B — Descendant axis (preferred for stability):** Use `parentKeys` from the response to build a scoped locator:
```java
WebElement parent = driver.findElement(FlutterBy.valueKey("<parentKey>"));
WebElement target = parent.findElement(FlutterBy.text("<value>"));
```
Verify the parent is unique by calling `find_elements(by: "key", value: "<parentKey>")` — it should return count=1.

### Step 5: Format the response
Return the SINGLE best Java locator line. The examples below assume the
[`appium-flutter-integration-driver`](https://github.com/AppiumTestDistribution/appium-flutter-integration-driver)
`FlutterBy` finder; adapt to whichever Flutter finder helper your test code uses.

**Flutter context:**
- `driver.findElement(FlutterBy.valueKey("login_button_submit"))` — ValueKey (preferred)
- `driver.findElement(FlutterBy.semanticsLabel("Close dialog"))` — semantics label
- `driver.findElement(FlutterBy.text("Book Now"))` — display text
- `driver.findElement(FlutterBy.type("ElevatedButton"))` — widget type (least preferred)

**Native context:**
- `driver.findElement(AppiumBy.accessibilityId("login_btn"))`
- `driver.findElement(AppiumBy.xpath("//XCUIElementTypeButton[@name='Done']"))`

**WebView context:**
- `driver.findElement(By.cssSelector("button.btn-book"))`
- `driver.findElement(By.xpath("//button[text()='Book']"))`

**Descendant pattern (when element is not unique):**
```java
WebElement parent = driver.findElement(FlutterBy.valueKey("appointment_card_0"));
WebElement target = parent.findElement(FlutterBy.text("Book"));
```

If `sourceInfo` is present, mention where the key is defined:
> Source: MyKeys.submit (lib/test_keys/my_test_keys.dart:14)

### Priority Order
Always prefer locators in this order:
1. **ValueKey** — most stable, survives UI text changes
2. **semanticsLabel** — stable accessibility label
3. **text** — readable but breaks on text changes
4. **type + index** — fragile, only when nothing else works
5. **descendant axis** — use when the simple locator matches multiple elements

## CUA Mode (Vision-Led, Locator-Aware Testing)

For tests authored as plain-English markdown, use the CUA workflow. **You are
the agent** — the MCP doesn't make any LLM calls. It parses the test file,
tracks per-step state, captures screenshots, and writes the report. You drive
every interaction yourself.

CUA is **vision-led**, not vision-only. Read the screenshot to understand
what's on the screen, then pick whichever primitive is most reliable for the
action — coordinates, ValueKey/text/type/semanticsLabel locators, `smart_tap`,
or widget-tree-driven discovery. The MD test file is written without
`by:`/`target:` hints, but you are free to use them at execution time.

### Test file location

CUA test markdown can live anywhere on disk. Set `CUA_TESTCASES_DIR` (env var
on the MCP server) to the directory holding your `*.cua.md` files; relative
filenames passed to `cua_run_test` resolve against it first, then `cwd` as a
fallback. Absolute paths are used as-is.

The hint sidecar (`<file>.cua.md.hints.json`) is written next to each test, so
it lives in the same directory. Commit it to whatever git/sync that directory
uses to share learning across machines.

### Workflow

1. `cua_run_test({ file: "checkout.cua.md", caseId?: "TC-001" })` → resolves the file, returns the first test case + initial screenshot + a strategy-hints block (including any `## Hints from previous runs` learned earlier).
2. For each numbered step:
   - Look at the most recent screenshot. Decide what to interact with.
   - Pick the most reliable primitive:
     - **Tap on a visible button/icon** → `tap({ by: "coordinates", x, y })` is usually fine.
     - **Type into a text field** → prefer locator-based `type_text({ by: "key"|"text"|"type"|"semanticsLabel", target, text })`. On iOS without an on-screen keyboard, coordinate-based typing falls back to `mobile-keys` and silently drops characters; the locator path uses the Flutter VM's `enterText` and works reliably.
     - **Several similar elements** → `get_widget_tree({ format: "compact", interactiveOnly: true })` or `find_elements({ by, value })` to pick the right index.
     - **Verification-only step** → `find_elements` or `get_widget_tree` is enough; no need to interact.
   - Re-fetch with `get_screen` after any state-changing action.
   - Call `cua_report_step({ stepNumber, status: "pass"|"fail", observation })` once the step is done.
3. After the last step, call `cua_finish_test({ verdict: "pass"|"fail", summary })`.
   - If the file has more cases, the response is the next case + a fresh screenshot — repeat from step 2.
   - On the last case, the MCP writes `runs/cua/<timestamp>/index.html` + `report.json` and clears the run state.

### Coordinate rule

Coordinates are device pixels. The screenshot you receive is at the device's
resolution; use coordinates straight from the image. The viewport is reported
in the case prompt (e.g. `1170x2532`).

### When to use which

- Locator-based scripted path (`flutter_locator`, `tap` with explicit
  `by`/`target`, `find_elements`) — when ValueKeys exist, the steps are
  deterministic, and you want a fast, repeatable run.
- CUA path (`cua_run_test` / `cua_report_step` / `cua_finish_test`) — when the
  test is authored as a QA ticket rather than as code, or when the screen mix
  needs both visual reasoning and locator hits.

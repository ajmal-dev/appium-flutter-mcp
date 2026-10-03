# Authoring `zenappautomation` Tests from MCP Live Sessions

> **Audience:** the AI agent (Claude) driving the `appium-flutter-mcp` server against a live
> device. This is the bridge between *"steps performed via MCP"* and *"a committed test in
> `zenappautomation`"*.
>
> **Canonical conventions live in `/Users/ajmal/projects/zenappautomation/CLAUDE.md`** — read it
> for the finer points (tap-vs-click semantics, platform-view limits, config precedence). This
> doc is the workflow + templates you need while operating inside the MCP.

---

## 0. The one rule that changes everything

**You (the AI) author the Java test file directly. Do NOT rely on the MCP's automatic code
generation for this project.**

The MCP's `generate_test` / `export_to_project` / `agentic_finish`-on-pass pipeline emits the
**legacy `zmauiautomation` style** — `com.zma.automation.*` imports, `extends BaseTest`,
`actions.tap(actions.byValueKey(...))`, and **no login**. Pointed at `zenappautomation` that code
**will not compile** (wrong packages/base class) and **will not log in** (no `@ZenAppLogin`).

`zenappautomation`'s idiomatic test is the **`app` DSL** (`app.flutter().getByKey("...").tap()`),
which the deterministic codegen cannot produce. So the division of labor is:

| Job | Owner |
|---|---|
| Live locator discovery, widget tree, tap-to-verify, screenshots | **MCP tools** |
| Writing the idiomatic `app`-DSL Java test that compiles + logs in | **You (Write tool)** |
| Compile + run | `mvn` (commands below) |

Config note: `AUTOMATION_PROJECT_PATH` is set to `/Users/ajmal/projects/zenappautomation` (the
reactor root) so MCP mvn-based tools build the engine + run `zma-tests`. It is **not** used to
export generated files here — you place files yourself at the paths below.

---

## 1. Project shape (where things go)

Maven reactor, Java 17, Appium 9.3.0, TestNG 7.10.2, Extent Reports.

```
zenappautomation/                         # ← AUTOMATION_PROJECT_PATH (reactor root)
├── pom.xml                               # aggregator: com.zena.automation:zenappautomation-parent
├── zenappautomation-engine/              # framework JAR — com.zena.automation.*  (DO NOT put tests here)
│   └── src/main/java/com/zena/automation/
│       ├── ZenaTest.java                 # base for ALL tests (extends BaseTest)
│       ├── base/{BaseTest,ZenAppLogin}.java
│       ├── actions/AppActions.java       # unified Flutter/Native/WebView + auto-wait
│       ├── dsl/{App,FlutterContext,NativeContext,WebViewContext,ZenAppAutomation,ZenaElement,...}
│       ├── pages/BasePage.java           # base for page objects
│       └── core/{DriverManager,CapabilityFactory,TestNgPlanLoader}.java
└── zma-tests/                            # ← YOUR TESTS GO HERE — zma.*
    ├── testng.xml                        # package-scan of zma.tests (no manual edits needed)
    └── src/test/
        ├── java/zma/
        │   ├── tests/                    # ← test classes:  zma/tests/<Name>Test.java
        │   ├── pages/flutter/            # ← Flutter page objects (optional)
        │   ├── pages/webview/            # ← WebView page objects (optional)
        │   ├── login/                    # ZmaLoginProvider, LoginHome (app-specific login)
        │   └── support/                  # AppointmentSelector, ZmaScreenRegistry
        └── resources/zenapp-config.yaml  # profiles, users, plans
```

**New test file** → `zma-tests/src/test/java/zma/tests/<Name>Test.java`, package `zma.tests`.
**New page object** → `zma-tests/src/test/java/zma/pages/flutter/<Name>Page.java`, package `zma.pages.flutter`.
No `testng.xml` edit needed — it package-scans `zma.tests`.

---

## 2. Test template (copy this)

```java
package zma.tests;

import com.zena.automation.ZenaTest;
import com.zena.automation.base.ZenAppLogin;
import org.testng.annotations.Test;

import static com.zena.automation.dsl.ZenAppAutomation.expect;

// Login is handled by the framework via this annotation — do NOT hand-roll a @BeforeClass login.
@ZenAppLogin(account = "medspabeta", username = "medspabeta@mailinator.com",
             password = "Soham@2020", environment = "Beta")
@Test(groups = {"gallery"})                       // class-level group → drives -Dzena.plan / -Dzena.includeGroups
public class <Name>Test extends ZenaTest {         // ALWAYS extends ZenaTest (never BaseTest/BasePage)

    @Test(description = "One line: what this verifies", enabled = true)
    public void <verbPhrase>() {
        // Ground: assert the landing screen is up
        expect(app.flutter().getByKey("apb_today_button")).toBeVisible();

        // Act with the app DSL — every locator below comes from MCP discovery (§4)
        app.flutter().getByKey("apb_consumer_open_profile_icon").tap();
        app.flutter().getByText("More (15)").tap();
        app.flutter().getAllByText("Consent  Treatment Forms").get(0).tap();

        // Hybrid: switch to a WebView by URL fragment when the surface is web
        app.switchToWebView("/Appointment/AppointmentCustomDataV2.aspx");
        app.webView().getById("firstName").type("Jane");
        app.switchToNative();                       // return to Flutter when done

        // Verify: assert the observable outcome
        expect(app.flutter().getAllByText("Guest Forms").get(0)).toBeVisible();
    }
}
```

- `app` is inherited from `ZenaTest` — do not construct it.
- `expect(...)` is a static import from `com.zena.automation.dsl.ZenAppAutomation`.
- Method-level `@ZenAppLogin` overrides class-level; env vars `ZENA_USERNAME`/`ZENA_PASSWORD` and
  `zenapp-config.yaml` `users.valid` are lower-precedence fallbacks.

## 3. Page-object template (only if a flow is reused across tests)

Prefer inline DSL for one-off tests. Add a page object when logic (discovery, retries, coordinate
fallbacks) is shared.

```java
package zma.pages.flutter;

import com.zena.automation.pages.BasePage;

public class <Name>Page extends BasePage {         // extends engine BasePage → gets `actions`, `driver`, logger

    public <Name>Page() { super(); }               // super() wires driver + actions from DriverManager

    @Override public boolean isPageLoaded() { return actions.existsByText("Gallery"); }   // fast, no-wait probe
    @Override public String  getPageTitle() { return "Gallery"; }

    // Query methods: no side effects, return boolean/data — use existsByText for speed
    public boolean isSelectButtonDisplayed() { return actions.existsByText("Select"); }

    // Action methods: log, then act via `actions` (auto-wait + stale-retry built in)
    public void tapGalleryTab() {
        logAction("Tapping Gallery tab");
        actions.tapByText("Gallery");               // or actions.tapByKey("..."), actions.tap(actions.byValueKey("..."))
    }
}
```

`AppActions` (in page objects) mirrors the DSL: `byValueKey/byText/byType`, `tap(By)/click(By)`,
`enterText(By,String)`, `getText(By)`, convenience `tapByKey/tapByText`, `existsByText` (fast probe),
`allByType` (collection, no auto-wait). FluentWait auto-waits (10s default, 300ms poll); implicit
wait is forced to 0 so the engine owns timing.

---

## 4. The workflow: MCP steps → committed test

**Follow the [Locator Discovery Workflow] and no-coordinate-tap rule already in the repo `CLAUDE.md`.**

1. **Connect / ground.** Confirm the session is live and the app is on a known screen:
   `get_status` → `get_screen`. If not logged in, the test's `@ZenAppLogin` handles login at run
   time — but for *discovery* you need the app already past login, so drive it there first.
2. **Discover, don't guess.** For each element you'll interact with:
   - `get_widget_tree({ format: "compact", interactiveOnly: true })` to see what's tappable.
   - `get_locator` / `flutter_locator({ mode: "structured", verify: true })` → take the
     highest-priority candidate with `verified:true` **and** `matchCount:1`.
   - `find_elements({ by, value })` to confirm uniqueness before committing to a locator.
3. **Walk the flow live.** `tap` / `type_text` (locator-based — **never coordinates**), re-`get_screen`
   after each state change. For web surfaces: `wait_for_webview` → `switch_context({to:"webview"})`.
   Record, per step: screen, chosen locator (prefer ValueKey), action, and the assertion that proves it worked.
4. **Author the file.** Write `zma-tests/src/test/java/zma/tests/<Name>Test.java` from the template,
   mapping each discovered locator to its DSL call (table below). Add `@ZenAppLogin` + `@Test(groups=...)`,
   and an `expect(...)` assertion for every meaningful step.
5. **Reuse / extend page objects** under `zma/pages/flutter` if the flow is shared.
6. **Verify** (§6). Fix compile errors, re-run until green.
7. **Report** the file path + the exact `mvn` line to run it. Commit only when the user asks.

### Locator strategy → DSL call

Priority (also the repo `CLAUDE.md` rule): **ValueKey > semanticsLabel > text > type+index. Never coordinates.**

| MCP finding (`by`) | Idiomatic DSL (in a test) | Page-object `AppActions` |
|---|---|---|
| `key` (ValueKey) — **preferred** | `app.flutter().getByKey("k")` | `actions.byValueKey("k")` / `actions.tapByKey("k")` |
| `semanticsLabel` | `app.flutter().getBySemanticsLabel("l")` | `actions.bySemanticsLabel("l")` |
| `text` (exact) | `app.flutter().getByText("t")` | `actions.byText("t")` / `actions.tapByText("t")` |
| `text` (partial / RichText) | `app.flutter().getByTextContaining("t")` | `actions.byTextStartingWith("t")` |
| `type` (widget class) | `app.flutter().getByType("ElevatedButton")` | `actions.byType("...")` |
| non-unique (`matchCount>1`) | `app.flutter().getAllByText("x").get(idx)` | `actions.allByType("...").get(idx)` |
| native `accessibilityId` | `app.native_().getByAccessibilityId("id")` | — |
| native `xpath` | `app.native_().getByXPath("//XCUIElementType...")` | — |
| webview `css` | `app.webView().getByCss("...")` | — |
| webview `id` | `app.webView().getById("...")` | — |
| webview `xpath` | `app.webView().getByXPath("...")` | — |

Assertions: `expect(el).toBeVisible() | toBeEnabled() | toHaveText("...") | toBeGone()`.
Actions on a `ZenaElement`: `.tap()` (gesture) · `.click()` (button, checks enabled) · `.type("...")`
· `.shouldBeVisible()`. **tap vs click matters** — see zena `CLAUDE.md`; Flutter gesture handlers
(GestureDetector/InkWell) need `tap()`, buttons take `click()`.

### Hybrid context switching

`app.switchToWebView("/urlfragment")` → interact via `app.webView()` → `app.switchToNative()` when done.
Known ZMA webviews: Booking Wizard `/appointmentbook`, Guest Form `AppointmentCustomDataV2.aspx`.

---

## 5. Login, groups & plans

- **Login:** `@ZenAppLogin(account, username, password, environment)` — class or method level. Current
  dev creds: `account="medspabeta"`, `username="medspabeta@mailinator.com"`, `environment="Beta"`.
  The framework's `ZmaLoginProvider` drives the settings-gear → server-select → IDS-WebView flow.
- **Groups:** put `@Test(groups={"..."})` on the class. Existing groups/plans (from `zenapp-config.yaml`):
  `smoke, booking, calendar, gallery, webview, forms` (+ `wip, slow` excluded from `all`). Pick the
  group that matches your feature so `-Dzena.plan=<group>` picks it up.

## 6. Build & run (always from the reactor root)

```bash
# One-time / after engine changes — build the framework
mvn -pl zenappautomation-engine -am clean compile -DskipTests

# Run one method on the physical iPad
mvn -pl zma-tests -am test -Dtest='<Name>Test#<method>' -Dzena.profile=ios-device

# Run a whole class
mvn -pl zma-tests -am test -Dtest='<Name>Test' -Dzena.profile=ios-device

# Run a plan (group)
mvn -pl zma-tests -am test -Dzena.plan=gallery -Dzena.profile=ios-device

# Simulator / Android profiles
mvn -pl zma-tests -am test -Dtest='<Name>Test' -Dzena.profile=ios-simulator
mvn -pl zma-tests -am test -Dtest='<Name>Test' -Dzena.profile=android
```

Profiles supply capabilities (bundle `com.example.app`, iPad UDID
`00008101-000238222EA3A01E`, Appium `http://127.0.0.1:4723`). Override the DSL wait with
`-Dzena.defaultWait=N`. Reports: `zma-tests/target/extent-reports/`; failure screenshots:
`zma-tests/target/screenshots/`.

---

## 7. Do / Don't

**Do**
- Extend `ZenaTest`. Use the `app` DSL. Prefer ValueKeys discovered + verified via MCP.
- Add `@ZenAppLogin` and a class-level `@Test(groups=...)`.
- Assert with `expect(...)`. Return to native after webview work.
- Verify with `mvn` from the root before reporting done.

**Don't**
- ❌ Rely on MCP `generate_test` / `export_to_project` / `agentic_finish` auto-codegen for this
  project — it emits legacy `com.zma` page-object code that won't compile or log in here.
- ❌ Extend `BaseTest`/`BasePage` in a test, or hand-roll a `@BeforeClass` login.
- ❌ Use `driver.findElement(...)` directly in a test — go through the `app` DSL.
- ❌ Use coordinate taps. Fix the locator (or the ValueKey in Dart) instead.
- ❌ Put test classes in `zenappautomation-engine` — they belong in `zma-tests`.

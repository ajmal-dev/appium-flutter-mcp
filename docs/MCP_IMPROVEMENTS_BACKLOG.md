# appium-flutter-mcp — Improvement Backlog

> **Created:** 2026-07-03
> **Origin:** a long live session driving a Flutter hybrid app on iPad (`com.example.app`)
> end-to-end — book appointment → calendar → gallery → camera capture → tag → upload → preview →
> delete — and then hand-authoring the equivalent test in `zenappautomation`
> (`BookGalleryValidationFlowTest`). Every item below is grounded in friction we actually hit.
>
> **Goal:** when the user runs a similar interaction tomorrow and says *"create a test from what I
> just did"*, the MCP should make that a near-automatic, mostly-locator-based, compiling
> `ZenaTest` — not a 2-hour re-exploration + hand-authoring effort.
>
> **Related:** [`ZENAPPAUTOMATION_TEST_AUTHORING.md`](ZENAPPAUTOMATION_TEST_AUTHORING.md) (the
> AI-authored test workflow this backlog is meant to accelerate).

---

## Environment facts (so we don't re-discover them)

- App is instrumented with **`appium_flutter_server`** (appium-flutter-integration-driver /
  `IntegrationTestWidgetsFlutterBinding`), **not** classic `flutter_driver`. Launcher:
  `integration_test/appium_test.dart` (via `appium_launcher.dart`).
  → The VM exposes only a single `ext.flutter.driver` (integration_test) whose interactive
  commands (`enter_text`, `tap`, `waitFor`, `get_render_tree`…) are **UnimplementedError**.
  Reliable interaction path = appium_flutter_server (`-flutter …` finds + `element.setValue`).
- Single Dart isolate, but **multiple FlutterViews** — the VM inspector tree often reflects a
  *different* view than what's on screen (stale).
- Automation target repo = **`zenappautomation`** (`AUTOMATION_PROJECT_PATH`), tests in the
  `zma-tests` module (`zma.*`, base `com.zena.automation.*`, `app` DSL). Idiomatic tests are NOT
  the legacy `zmauiautomation` page-object/`AppActions` style the current codegen emits.

---

## P0 — Capture the session, then codegen from it (the core gap)

### [ ] 1. Always-on interaction recorder → zenappautomation codegen
**Problem.** The user's actual request — "create a test from the steps performed via MCP" — could
not be served from the session. I re-explored and hand-authored the test from memory.
**Today's evidence.** No structured capture of the taps/types/context-switches/assertions I
performed; `generate_test` emits legacy `zmauiautomation` code that won't compile against
`zenappautomation`.
**Change.**
- Auto-record every `tap` / `type_text` / `switch_context` / gesture / assertion with:
  **context** (flutter/webview/native), **locator actually used** (`by`+`value`, or coordinates +
  the reason no locator existed), **screen name / webview URL**, and any assertion + expected.
- New `export_flow` → a `flow.json` (ordered, replayable steps).
- New **zena-aware generator**: emits `ZenaTest` + `@ZenAppLogin` + `app.flutter()/webView()/expect()`,
  and **scans `zma-tests` page objects** (CalendarListPage, GalleryPage, GuestFormPage) to map
  recorded steps onto existing helpers instead of duplicating (I did this mapping by hand:
  e.g. "navigate to gallery" → `GalleryPage.navigateToGalleryForGuest`).
**Touch-points.** `src/recording/test-generator.ts`, `src/project/scanner.ts` (add a zena page-object
scanner), `src/tools/workflow.ts`, `src/tools/agentic.ts`.
**Acceptance.** After a live flow, `generate_test` produces a `ZenaTest` that (a) compiles via
`mvn -pl zma-tests -am test-compile` and (b) reuses ≥1 existing page object where applicable.
**Effort.** L.

---

## P1 — Reliability fixes that erased most of today's wasted turns

### [ ] 2. Detect the Flutter driver flavor at connect  *(recommended first — small, high value)*
**Problem.** The MCP tried the classic `flutter_driver` VM path first (`ext.flutter.driver.enterText`),
which this app doesn't implement.
**Today's evidence.** ~30 min lost on `VM Service error: Unknown method "ext.flutter.driver.enterText" (-32601)`
before discovering the app uses appium_flutter_server / integration_test.
**Change.** At connect, probe the driver flavor (does `ext.flutter.driver` accept
`{command:'get_health'}` only = integration_test? or the full command set = flutter_driver?). When
it's the appium_flutter_server / integration_test flavor, **skip the VM `enter_text`/`tap` path
entirely** and go straight to `element.setValue` / native. Surface `driverFlavor` in `get_status`.
**Touch-points.** `src/vm/dart-vm-client.ts` (flavor probe), `src/tools/act.ts` (typing/tap path
selection — remove the failing VM probe when flavor is integration_test).
**Acceptance.** No `-32601` attempts on this app; `get_status.driverFlavor == "integration_test"`.
**Effort.** S.

**2026-07-23 evidence (debug-fix session, ZMA iPad sim) — reproduces this exact
failure class with two added wrinkles:**
- `markVMDriverCommandsBroken` (`src/vm/vm-session.ts:57-64`) disables the VM path
  **permanently for the rest of the session** after the FIRST enterText/tap protocol
  failure — not per-call. Once the first real locator-based tap/type_text hits this
  app's health-check-only `ext.flutter.driver`, every subsequent call for the rest of
  the session falls straight through to the Appium `-flutter X` path.
- `find_elements` (`src/tools/observe.ts`, ~line 157) swallows the SAME underlying
  error in a try/catch and silently returns `count:0`, while `tap`/`type_text`
  (`src/tools/act.ts` ~799-814, ~982-996) propagate and report it explicitly — same
  root cause, opposite visibility. Reads as "widget doesn't exist" when it's actually
  the same broken locator channel.
- **Discrepancy to flag**: this session's `-flutter X` calls failed outright with
  "Locator Strategy '-flutter X' is not supported for this session" — Appendix D's
  2026-07-03 evidence describes that SAME fallback working reliably. Possible cause:
  external Appium driver/plugin version drift, or session-instance-specific config —
  not controlled by this repo's own code, but worth a version check before assuming
  item #2 alone fixes it.
- Net effect: live verification of 2 of 3 script fixes was abandoned for code review
  + local `mvn test` reruns — precisely the failure mode item #2 exists to prevent.

### [ ] 3. Session resilience (keepalive + reconnect that re-maps contexts)
**Problem.** Appium session idle-timed-out repeatedly; reconnects rotated webview IDs.
**Today's evidence.** ~6 session drops (`A session is either terminated or not started`); webview
IDs drifted 840.1 → 840.14/.15; I had to manually reconnect + re-enumerate contexts each time.
**Change.** Raise `appium:newCommandTimeout` in session caps; add a keepalive/heartbeat; make
auto-reconnect **also re-attach the Dart VM** and **re-resolve webview contexts by URL** so ID
rotation is invisible to callers.
**Touch-points.** `src/appium/session.ts` (caps + keepalive), `src/context/context-manager.ts`,
the `getBrowserWithReconnect` path.
**Acceptance.** A 10-min idle mid-session does not require a manual `connect`; URL-based
`switch_context` still works after a reconnect.
**Effort.** M.

### [ ] 4. Context list with URLs (+ URL-based switching everywhere)
**Problem.** `get_status` returns only webview IDs, which rotate; no URLs.
**Today's evidence.** I had to `curl mobile:getContexts` to learn which webview was `/calendar`
vs `/appointmentbook`.
**Change.** `get_status` (and/or a `list_contexts` tool) returns each webview's **URL + title**
from `mobile: getContexts` metadata. Prefer URL-fragment switching internally.
**Touch-points.** `src/context/context-manager.ts`, `get_status` in `src/tools/*`.
**Acceptance.** `get_status` shows `WEBVIEW_* → {url, title}`; ID rotation never breaks a
URL-fragment switch.
**Effort.** S.

### [ ] 5. WebView interaction auto-fallbacks (typing events + JS click)
**Problem.** Two manual workarounds were needed in the booking/gallery webviews.
**Today's evidence.**
- Typing set the input value but the Angular/React search didn't fire until I dispatched an
  `input` event via `execute_js`.
- Native `element.click()` failed a visibility check (300px webview logical viewport vs 1180px
  screen); I fell back to a JS `click()`.
**Change.** WebView `type_text` auto-dispatches `input`/`change`/`keyup` after setting value;
WebView `tap` auto-falls back to a JS `element.click()` when the native click throws
"element not currently visible".
**Touch-points.** `src/tools/act.ts` (webview branch).
**Acceptance.** Booking-wizard search + result click + Review/Book work without manual
`execute_js`.
**Effort.** S–M.

---

## P2 — Discovery & assertions (prevent mistakes, make generated tests robust)

### [ ] 6. Source-aware locator/key probe  *(would have prevented a wrong claim today)*
**Problem.** For an on-screen element, the MCP doesn't tell you which transport can reach it, nor
whether a ValueKey exists in the Dart source.
**Today's evidence.** I **incorrectly** told the user the gallery Upload/filter/guideline buttons
had "no ValueKeys" — they do (`GuestProfileWidgetKeys.*` in
`flutter-components/flutter_guest_profile_component/lib/GuestDetails/gallery/gallery_mobile_screen.dart`);
the runtime VM tree was just stale.
**Change.** New `probe_element` tool: for a target/tapped element, report (a) which transport
resolves it — appium_flutter_server / VM inspector / native a11y, (b) the best locator +
ready-to-paste `app` DSL snippet, and (c) using the existing Dart source scanner
(`FLUTTER_APP_PATH`/`FLUTTER_COMPONENTS_PATH`) whether a ValueKey is defined (file:line) or —
if none — the widget location where one should be added.
**Touch-points.** new tool over `src/source/*` + finders; reuse the source scanner from
`source_paths` features.
**Acceptance.** Probing the gallery filter/upload buttons surfaces their `GuestProfileWidgetKeys`
values + source location.
**Effort.** M.

### [ ] 7. Multi-FlutterView-aware widget tree (+ honest staleness)
**Problem.** The VM inspector tree frequently reflected a different view than the screen.
**Today's evidence.** `get_widget_tree` returned the calendar's app-bar keys
(`apb_*`, "4 ValueKeys") while I was on the gallery/camera; gallery keys never appeared via the VM.
**Change.** Query the **topmost/active FlutterView** (or enumerate all views and merge), and flag
when the VM tree doesn't correspond to the current screenshot (so callers fall back to
appium_flutter_server / native instead of trusting stale data).
**Touch-points.** `src/tree/tree-builder.ts`, `src/vm/dart-vm-client.ts` (FlutterView enumeration).
**Acceptance.** On the gallery screen, `get_widget_tree` reflects gallery widgets (or clearly
reports "VM tree stale — using page-source").
**Effort.** M–L.

### [ ] 8. First-class assertion tool + image-loaded (decode) fix
**Problem.** No dedicated assert primitive; couldn't verify an image actually *decoded*.
**Today's evidence.** The user repeatedly asked for programmatic asserts (button displayed, filter
options, image loaded). I proxied with `find_elements`. `get_element_details` returned
`renderDiagnostics: null` **3×**, so "image loaded" (decoded bitmap) was not provable at the pixel
level; only "displayed + non-zero geometry".
**Change.** Add `assert_element` / `assert_screen` (present/displayed/enabled/text/count →
pass|fail with a clean verdict). Fix the render-diagnostics path
(`flutter: getRenderObjectDiagnostics`) so `RenderImage` decoded dimensions are available for a
real "loaded" assertion (or document why it's unavailable on this binding and provide a
screenshot-region fallback).
**Touch-points.** `src/tools/observe.ts` (`get_element_details` render path), new assert tool.
**Acceptance.** `assert_element` returns a boolean verdict; image-loaded can be asserted at decode
level on at least one gallery image.
**Effort.** M.

---

## Suggested order for tomorrow

1. **#2 driver-flavor detection** (S, self-contained, removes the biggest rabbit hole).
2. **#4 context URLs** (S) + **#5 webview auto-fallbacks** (S–M) — quick reliability wins.
3. **#3 session resilience** (M) — stops the reconnect churn.
4. **#6 source-aware key probe** (M) — makes discovery correct + tests key-based.
5. **#1 recorder → zena codegen** (L) — the headline feature; build once #2–#6 make the session
   data trustworthy.
6. **#7 multi-view tree** and **#8 assert + decode** as follow-ups.

**"Definition of done" for the whole effort:** a live flow like today's, followed by
`create a test`, yields a compiling `ZenaTest` in `zma-tests` that is ≥80% locator-based (keys /
text / semanticsLabel), reuses existing page objects, and needs only minor human review — with the
few genuinely locator-less native controls (camera shutter, etc.) clearly marked.

---
---

# DATA APPENDICES (full session capture — do not lose)

Everything below is the raw, concrete data we discovered/used on 2026-07-02→03. It is the
reference material for building #1 (recorder→codegen), #6 (source-aware probe) and the reliability
fixes. Locators/coords are for **iPad 10th-gen, 1180×820**, app env **medspabeta / Beta**, guest
a sample guest account used in that session.

## Appendix A — The exact end-to-end flow we executed (with locators)

| # | Action | Surface / context | Locator used (verbatim) |
|---|---|---|---|
| 1 | assert calendar loaded | flutter | key `apb_today_button` |
| 2 | tap Book | flutter | text `Book` |
| 3 | switch context | → webview | urlFragment `/appointmentbook` |
| 4 | type guest email | webview | css `input[placeholder="Search by Guest name, mobile, email, code"]` |
| 5 | click guest result | webview | css `.appointment-guest-search-results-item` |
| 6 | open service dropdown | webview | css `.appointment-item-service-selected` |
| 7 | type service | webview | css `input[placeholder="Service/Service Code/Day Package"]` = `Botox` |
| 8 | click Botox | webview | css `.service-item` |
| 9 | pick time 12:00pm | webview | xpath `//span[contains(@class,'navigable-timeslot')][normalize-space(.)='12:00pm']` |
| 10 | Review & Book | webview | css `button.review-or-save-btn` |
| 11 | Book (confirm) | webview | xpath `//button[normalize-space(.)='Book']` |
| 12 | assert appt on scheduler | webview | urlFragment `calendar`; event `.sch-event` / `.schGuestName` containing `gallery validation` |
| 13 | click appt → detail | webview/flutter | list card `.sch-event.elapsed-pastel` w/ guest text (needed **JS click** — native click failed visibility) |
| 14 | tap gallery icon | flutter | key `apb_service_gallery_icon` |
| 15 | assert gallery | flutter | text `Gallery`, `No Images for this guest` |
| 16 | assert Upload btn | flutter | semanticsLabel `Upload` (text `Upload` = 0!) |
| 17 | open filter funnel | **native** | **coord (1138,173)** — no locator |
| 18 | validate filter opts | flutter | text: `File association`,`Service files`,`Guest files`,`Provider`,`Services`,`Center`,`File Type`,`Images`,`PDFs`,`Videos`,`Guidelines view`,`Face`,`Reset`,`Apply`,`Filters` |
| 19 | close filter | flutter | type `IconButton` (single, = X) |
| 20 | Upload | flutter | semanticsLabel `Upload` |
| 21 | Take photo | flutter | semanticsLabel `Take photo` (menu also: `Select photos`,`Select files`) |
| 22 | open Add-guidelines | **native** | **coord (1040,413)** — cyan button |
| 23 | select guideline | flutter | type `Image` index 0 (18 thumbs, 62×62); labels `Lateral Left` etc. |
| 24 | Done (modal) | flutter | text `Done` (count=1; camera Done NOT findable) |
| 25 | capture | **native** | **coord (1142,407)** — shutter |
| 26 | tag photo | flutter | text `acne` (chips `acne`,`cheek`) |
| 27 | Next | flutter | text `Next` |
| 28 | Finish (after upload) | flutter | text `Finish` (disabled until upload done; use `click()` auto-wait) |
| 29 | exit camera | **native** | **coord (55,45)** — camera "Done" top-left |
| 30 | assert uploaded | flutter | text `Recently Uploaded`; Image 253×225 @ (82,269) |
| 31 | open preview | flutter | tap the Image (index 3 on gallery grid) |
| 32 | validate preview | flutter | text `File 1/1`; Image 1084×609; icons via keys (App. F) |
| 33 | close preview | flutter | key `guest_image_viewer_button_close` (or IconButton) |
| 34 | Select mode | flutter | text `Select` → `Cancel` |
| 35 | select tile | flutter | tap tile (no `Checkbox` type; coord/tile) |
| 36 | Delete | flutter | text `Delete` |
| 37 | confirm | flutter | text `Yes` (dialog: "…permanent and cannot be undone"; `No`/`Yes`) |
| 38 | assert deleted | flutter | text `No Images for this guest` |

## Appendix B — ZMA locator inventory (by screen)

**Front-desk calendar (Flutter).** ValueKeys: `apb_today_button`, `apb_prev_day_button`,
`apb_next_day_button`, `apb_quick_create_consumer_button`, `apb_consumer_open_profile_icon`,
`apb_service_gallery_icon`, `apb_service_camera_icon`. Search field = disabled Flutter `TextField`
(index 1) that opens an overlay; the top toolbar icons are custom buttons (NOT findable via
appium_flutter_server, NO keys) — chat/grid/paintbrush. Paintbrush opens "Appointment card theme"
(Pastel/Bold, Vertical/Horizontal/List, Done).

**Booking Wizard (WebView `/appointmentbook`, Angular).**
- search: `input[placeholder="Search by Guest name, mobile, email, code"]`; results:
  `.appointment-guest-search-results-item`, `.navigable-search-option`; "Search across centers",
  "+ New Guest".
- service: trigger `.appointment-item-service-selected`; search
  `input[placeholder="Service/Service Code/Day Package"]`; item `.service-item` /
  `.service-item-name`; tabs `.on-arrow-focus-results` ("Services"/"Day Packages");
  chevron `i.zen-chevron-bottom`.
- slots: `span.navigable-timeslot` (text like `12:00pm`); cell `div.slot.past-center-time`
  (`.selected` when chosen); afternoon block `.timeslots-afternoon-slots`.
- footer: `button.review-or-save-btn` (Review & Book) inside `.appointment-create-slot-selection-footer`.
- review screen: buttons `button.btn.btn-primary.btn-confirm` (text `Book`) and
  `…​.bookAndPayment` (`Book and Proceed to Payment`); banner "…on hold until you book".

**Calendar scheduler (WebView `calendar`, Bryntum).**
- events: `.b-sch-event-wrap.b-sch-color-green` (booked=green), `.schEvent.b-sch-event…elapsed-past`
  (grid, often 0-size/virtualized off-screen), `.sch-event.elapsed-pastel` (list card),
  `.schGuestName` (guest name, visible).
- horizontal scrollers (scrollWidth 3416, clientWidth 969): `.b-grid-subgrid.b-grid-subgrid-normal`,
  `.b-grid-headers`, `.b-virtual-scroller`. Time headers `.b-sch-header-text` ("12 PM", …).
- NOTE: `.sch-event` matches ~6 (all cards) — disambiguate by contained guest text.

**Guest Gallery (Flutter — `flutter_guest_profile_component/.../gallery/gallery_mobile_screen.dart`).**
Keys exist (`GuestProfileWidgetKeys.*`) but the **runtime VM tree is stale here**; appium_flutter_server
resolves text/semantics. Upload = semanticsLabel `Upload` (text `Upload`=0). "Recent files" filter
dropdown; funnel filter = no locator (coord). Empty state text `No Images for this guest`; section
`Recently Uploaded`; tiles = large `Image` (253×225); sidebar icons = `Image` 23×23. Preview icon
keys: `guest_image_viewer_button_edit`, `guest_image_viewer_button_download`,
`guest_image_viewer_button_close`. Edit panel keys: `guest_edit_file_button_save`,
`guest_edit_file_button_discard`, tag chips `guest_gallery_tag_chip_<name>`. Tiles:
`guest_gallery_tile_<N>`. Filter-panel option labels (all findable via text): see Appendix A #18.

**Camera (NATIVE overlay — NO Flutter/native-a11y locators; coordinates only).** "Take photo"
opens it; "1/1 Face | Lateral Left" indicator + `Lateral Left`/`Face` text = **0** here; cyan
add-guideline, white shutter, top-left "Done", grid toggle, 1x zoom — all native. See Appendix E.

**Add guidelines modal (Flutter, findable).** "Add guidelines", tabs "Guidelines"/"Sequences";
18 thumbnails `Image` 62×62; sections `Face`/`Arms`/`Legs`; items `Lateral Left`,`Anterior Oblique`,
`Anterior Closer`,`Lateral Right`,`Anterior Closest`, …; `Done`; toast "Lateral Left added successfully".

**Add Tags (Flutter, findable).** "Add Tags", search, chips `acne`/`cheek`, buttons
`Take More Photos`/`Next`.

**Upload progress (Flutter, findable).** "Please wait while your pictures upload", "1 / 1
uploading", `Finish` (disabled until complete).

**Image preview (Flutter, findable).** `File 1/1`; full Image 1084×609; nav arrows = `IconButton`
(≥2); actions via the `guest_image_viewer_button_*` keys.

**Select/Delete (Flutter, findable).** `Select`↔`Cancel`; bottom bar `Delete`,`Add tags`,
`Add to global gallery`,`Compare`,`Print`, "N item(s) selected"; NO `Checkbox` widget type;
confirm dialog "Are you sure you want to delete the selected image(s)? This action is permanent and
cannot be undone." → `No`/`Yes`.

## Appendix C — WebView context map

The booking host and the login host are separate WebViews. IDs **rotate on reconnect**
— match by URL.

| URL fragment | Title | Notes |
|---|---|---|
| `appointmentbook` (`/appointmentbook/`) | (undefined) | Booking Wizard |
| `calendar` (`/calendar?...&date=YYYY-MM-DD`) | **ZMA - Appointment Book** | Bryntum scheduler |
| `AppointmentCustomDataV2.aspx` | — | Guest form (not used today; known) |
| `about:blank` ×4 | — | preloaded/empty webviews |

## Appendix D — Driver / binding facts + exact errors (for #2)

- App binding = **`IntegrationTestWidgetsFlutterBinding`** (appium_flutter_server), stack trace:
  `package:integration_test/src/_callback_io.dart`.
- Single Dart isolate `isolates/3632652450773379` (name "main", 76 extensions). Exposes a **single**
  `ext.flutter.driver` (NOT `ext.flutter.driver.enterText/.tap/...`).
- `ext.flutter.driver {command:'get_health'}` → `{isError:false, response:{status:"ok"}}`.
- **UnimplementedError** for `set_text_entry_emulation`, `enter_text`, `tap`, `get_text`, `waitFor`,
  `get_render_tree` (all via the integration_test binding).
- MCP failure that started the rabbit hole:
  `VM Service error: Unknown method "ext.flutter.driver.enterText". (-32601)`.
- Reliable typing/tapping on this app = appium_flutter_server: `find_elements('-flutter …')` +
  `element.setValue(...)` / native tap (MCP `type_text`/`tap` already fall back to this when the VM
  path fails — but it wastes a probe round-trip; #2 removes it).
- `get_element_details` → `renderDiagnostics: null` (3×) — image decode-level "loaded" unprovable
  (drives #8). `find_elements` returns `enabled:false` for all Flutter `Text` widgets (known quirk;
  use `displayed`).

## Appendix E — Native coordinate reference (iPad 10th-gen, 1180×820)

Only these had **no locator** on this build (candidates for adding ValueKeys, per #6):

| Control | Coord | Screen |
|---|---|---|
| Filter funnel | (1138, 173) | Gallery toolbar |
| Camera "add guideline" (cyan) | (1040, 413) | Camera |
| Camera shutter (capture) | (1142, 407) | Camera |
| Camera "Done" (exit) | (55, 45) | Camera |

Coordinate typing on iOS via `mobile-keys` **drops characters** — never use it; use
locator-based `setValue`.

## Appendix F — zenappautomation DSL + page-object API (for codegen mapping)

**`app` DSL (engine `com.zena.automation.dsl`).** `app.flutter()` → `getByKey/getByText/
getByTextContaining/getByType/getBySemanticsLabel` (→ `ZenaElement`), `getAllByKey/getAllByText/
getAllByType` (→ `ZenaCollection.get(i)`). `app.webView([urlFragment])` → `getByCss/getById/
getByName/getByXPath`. `app.native_()` → `getByAccessibilityId/getByXPath/…`. `app.switchToWebView
([frag])`, `app.switchToNative()`, `app.expect(el)`, `app.driver()`. `ZenaElement`: `tap/click/type/
clear/longPress/scrollIntoView/text/attr/isVisible/within(Duration)/shouldBeVisible/shouldBeGone/…`.
`expect(el)` → `toBeVisible/toBeGone/toBeEnabled/toBeClickable/toHaveText/toContainText/
toHaveAttribute`. Static facade `ZenAppAutomation`: `$/$$/$web/$native/key/text/type/semanticsLabel/
css/id/xpath/expect/switchToWebView/setDefaultWait`.

**Reusable page objects (`zma-tests`).**
- `CalendarListPage` (webview `calendar`): `switchToCalendarListWebView()`,
  `isAppointmentVisible(String)`, `clickAppointmentByGuestName(String)`,
  `clickListViewAppointmentByGuestName(String)`, `getAppointmentGuestName(int)`.
- `GalleryPage` (1031 lines): `isPageLoaded()`, `isUploadButtonDisplayed()`,
  `isFilterDropdownDisplayed()`, `isFilterOptionDisplayed(String)`, `isOpenCameraButtonDisplayed()`,
  `tapImageByIndex(int)`/`tapFirstImage()`, `countGalleryTiles()`/`getGalleryFileCount()`,
  `isImagePreviewLoaded()`/`isImagePreviewFileCountDisplayed()`/`isFileViewerShowingIndex(int)`/
  `isPreviewImageRendered()`, `isDownloadButtonDisplayed()`/`isEditButtonDisplayed()`,
  `tapDownloadButton()`/`isDownloadSuccessBannerVisible()`, `tapRightArrow()`/`tapLeftArrow()`/
  `closeImagePreview()`, `tapEditButton()`/`isEditPanelDisplayed()`/`tapTagInEditPanel(String)`/
  `tapEditSaveButton()`/`dismissEditPanelIfOpen()`/`waitForEditPanelClosed(int)`,
  `tapSelectButton()`/`selectTileByIndex(int)`/`tapCompareButton()`/`isComparePageDisplayed()`,
  `tapAppointmentByGuestName(String)`/`tapGalleryIconFromAppointment()`/`navigateBackToCalendar(int)`/
  `tapCameraIconFromAppointment()`/`navigateToCameraForGuest(String)`/`navigateToGalleryForGuest(String)`.
  File keyword consts: `FILE_GIF="github-tree"`, `FILE_BUTTERFLY="butterfly"`, `FILE_PNG="green-left"`,
  `FILE_PDF="sample_report"`, `FILE_TIFF="scanned_doc"`.
  **Missing (must author): camera capture (shutter/guideline/Done), Add-Tags-post-capture, upload
  Finish, delete-confirm, funnel filter, "Recently Uploaded" filter.**
- `GuestFormPage` (webview `AppointmentCustomDataV2.aspx`): `switchToGuestFormWebView()`.
- `AppointmentSelector`: `selectByGuestName(String[,int])`.

**Test skeleton.** `@ZenAppLogin(account="medspabeta",username="medspabeta@mailinator.com",
password="Soham@2020",environment="Beta")`, `@Test(groups={"medspaBetaSuite","gallery","booking"})`,
`extends ZenaTest`, package `zma.tests`. Run: `mvn -f <root>/pom.xml -pl zma-tests -am test
-Dtest='<Class>' -Dzena.profile=ios-device` (or `-Dzena.includeGroups=medspaBetaSuite`).

## Appendix G — Artifacts & config changed this session

- **Config:** `~/.claude.json` → `mcpServers.appium-flutter-mcp.env.AUTOMATION_PROJECT_PATH`
  changed `…/zmauiautomation` → `…/zenappautomation` (requires MCP restart to take effect).
- **Docs created (this repo):** `docs/ZENAPPAUTOMATION_TEST_AUTHORING.md`,
  `docs/MCP_IMPROVEMENTS_BACKLOG.md` (this file).
- **Test created (compiles, uncommitted):**
  `zenappautomation/zma-tests/src/test/java/zma/tests/BookGalleryValidationFlowTest.java`
  (full flow; native camera/funnel steps via a `tapAt()` W3C helper w/ the Appendix E coords).
- **Claude memory:** `reference_zenappautomation.md` marks zenappautomation as the active target
  (supersedes `reference_zmauiautomation.md`).
- **MCP source note:** `src/vm/dart-vm-client.ts` `initialize()` picks the first `ext.flutter.*`
  isolate — fine here (single isolate) but relevant to #2/#7.

# appium-flutter-mcp — Automation Rulebook

Hard-won rules from live sessions against a Flutter hybrid app on iPad (landscape, iOS).
Every rule encodes a failure that actually happened.
Follow them in order of relevance; when a rule conflicts with a guess, the rule wins.

The compact version of this rulebook is embedded as the MCP server's `instructions` field
(`src/server-instructions.ts`) — it surfaces to every MCP client automatically on connect.

---

## 1. Connection & session

- **Real-device connect requires WDA signing caps**: `appium:xcodeOrgId: 929Q8AE938` and
  `appium:xcodeSigningId: "Apple Development"` — without them WDA build fails with
  `xcodebuild code 65`.
- **Check `vmService.connected` in the connect/get_status response.** If the Dart VM service
  is NOT connected, `find_elements` returns `count: 0` even for widgets that are visibly
  on screen. **A zero-result probe without a live VM service proves nothing.** Reconnect
  with a fresh `ws://` URL from the user before trusting any negative result.
- The app runs with `noReset: true` + `shouldTerminateApp: false`: quitting/recreating the
  Appium session does NOT reset app UI state. Whatever screen the last action left is still
  there. Never assume "new session = home screen".
- **App stuck on the splash screen forever** (spinner never resolves): two known causes.
  (1) `StandAlone = false` in `HomeScreen.dart` — the appium-setup edit was missed.
  (2) Persisted data from a PREVIOUS install (offline-mode flag + keychain session survive
  install-over): `offlineInitialCheck()` takes the offline branch and dies on
  `GetSettings table not exists` / `Failed to fetch fetchOrganizationId` (visible in the
  flutter run log alongside a keychain SSO auto-resume). Hot restart
  (`kill -USR2 <flutter_tools pid>` — find via `pgrep -fl flutter_tools`) clears only
  in-memory state; the persisted case needs
  `xcrun devicectl device uninstall app --device <udid> com.example.app` +
  relaunch, which lands on the login screen. Confirmed live 2026-07-17. Do NOT tap at the
  splash or keep polling — diagnose from the run log.

---

## 2. Coordinate space

- All tap/gesture coordinates are in **device points: 1180 × 820** (landscape iPad).
- Screenshots come back at varying pixel sizes (800 / 2000 / 2360 wide). **Never** read
  pixel positions off a screenshot and use them directly — scale to the 1180×820 space
  first: `device_x = image_x * 1180 / image_width`.

---

## 3. Locator strategy hierarchy (strongest → weakest)

Follow this order strictly — never skip a level while a higher one is still untried.

1. **`key` (ValueKey)** — strongest and most stable. Always works, including inside
   platform-view overlays. If a widget you need has no key, the durable fix is adding one
   in the Flutter source (`ZmaWidgetKeys`); note it in `VALUEKEYS_TO_ADD.md`.
2. **`type` + index** — for icons and image-only buttons that have no text label. Call
   `find_elements(by: "type", value: "RawImage" | "Icon" | "Image")`, inspect each
   element's `position` to identify the correct one by its coordinates, then tap it by
   type + index. This is **strongly preferred over coordinates** — it survives minor layout
   shifts better than absolute pixel positions.
3. **`text` (exact)** — plain `Text` widgets only (not RichText).
4. **`textContaining`** — partial match; bypasses some RichText hit-test walls that exact
   `text` hits.
5. **`semanticsLabel`** — frequently fails on GestureDetectors (not hit-testable via the
   FlutterIntegration driver). Attempt before falling to coordinates.
6. **Coordinates** — **last resort only**. Use ONLY when the element is inside a
   platform-view overlay (§7) AND has no ValueKey AND no stable type+index locator exists.
   Any coordinate tap in a generated test MUST be flagged with a `// FRAGILE: coordinate`
   comment and a corresponding entry in `VALUEKEYS_TO_ADD.md`.

### Icon / image-only button strategy (expanded)

Many toolbar icons, nav images, and theme buttons have no text and no ValueKey.
The rule is: **never go straight to coordinates — use type+index first**.

```
Step 1: find_elements(by: "type", value: "RawImage")   // or "Icon" or "Image"
Step 2: inspect position.x / position.y of each result to identify the right element
Step 3: tap by type + index (e.g. actions.byType("RawImage", 18))
Step 4: if the element is in a platform-view overlay (§7) and type+index fails,
        THEN use coordinates — and file a ValueKey request
```

Real example — painter icon (top-right toolbar, no key):
- `find_elements(type: "RawImage")` → 20 results; index 18 at (1124, 105) = painter icon
- Tap: `actions.byType("RawImage", 18)` — works; no coordinates needed
- Flag: request `ValueKey("apb_card_theme_button")` from Flutter team

**Compound/ancestor/descendant finders crash this FlutterIntegration driver.**
Never combine finders; use a flat type scan + positional index instead.

---

## 4. Text rendering reality — what text finders can and cannot match

This is the single biggest source of wasted runs. Verified behavior:

| Content | Widget | Matchable by text finders? |
|---|---|---|
| Section titles, dialog labels, buttons ("Save", "Personal info") | Text | ✅ yes |
| Medical-history condition tile names | Text | ✅ yes — but see truncation below |
| Social-history values ("Ex-smoker") | Text | ✅ yes |
| Saved allergy names, medication names, therapist note body, vitals values/units | RichText | ❌ no |
| "Family medical history" style sub-headers inside MR cards | non-Text render | ❌ no |

- **Truncation**: tile text is ellipsis-truncated on screen and `getText()` returns the
  *displayed* string (e.g. `"Heart condition or uncont..."`). Match on a substring from the
  **beginning** of the visible text, never the middle or end.
- **Vitals**: value and unit render as separate RichText widgets — `"120 mmHg"` can never
  match. Assert recorded-state labels instead ("View last recorded vitals",
  "Systolic Blood Pressure").
- **When a text assertion fails but the screenshot shows the text on screen**, it is a
  RichText/truncation problem — **switch signal, don't retry harder** (use a ValueKey,
  a structural key, or a different substring from the START of the visible text).

---

## 5. Typeahead / master-data resolution

Typeahead fields (allergies, medications, conditions) resolve what you type to a **master
record with a different display name**:

- `"Penicillin"` → `"Antibiotic allergy"`
- `"Hypertension"` → `"Heart condition or uncontrolled hypertension"`

**Never assert the string you typed.** Determine the resolved name from a live run's
screenshot (or `get_screen` after saving) and assert THAT.

Typeahead suggestion rows are `_ListTile` widgets in a Flutter Overlay — tap by type after
a ~1.5s settle. On Android this is blocked entirely: `appium_flutter_server` applies
`.hitTestable()` to all finders, excluding Overlay widgets.

---

## 6. `tap` vs `click`, and "disabled" in the tree

- `tap` waits for VISIBLE only; `click` waits for VISIBLE + ENABLED.
- Flutter GestureDetectors, banners, and inline list rows report `enabled=false` in
  semantics while being perfectly tappable. `click()` on them = guaranteed 10s timeout.
  **Use `tap` for anything that isn't a real button/input.**
- In `get_widget_tree` output, virtually every GestureDetector/InkWell shows `disabled` —
  that is a semantics artifact, **not** evidence the element can't be tapped.

---

## 7. Platform-view overlays (hard wall)

Appointment detail panel, guest-search result rows, and several right-panel widgets render
inside `platform_view[N]`:

- Not in the iOS native accessibility tree → `native accessibilityId` fails.
- Not hit-testable by text/semantics finders. `getByKey` works **only if** the widget has a
  ValueKey.
- Without a key, a **coordinate tap** is the only way in (the search result row sits at a
  fixed offset under the search box regardless of which guest matched: ~(438,169)).
- Wrap coordinate taps in a retry loop that checks an on-screen success signal (e.g.
  "Overview" appears) rather than trusting one blind tap.
- **Absence from the widget tree does NOT mean absence from the screen** — always check a
  screenshot before concluding a platform-view element is missing.

---

## 8. Text-field entry rules

- **Do NOT `tap` a Flutter TextField before `sendKeys`** — the keyboard breaks the test
  server's ability to re-resolve widget queries on that screen. Use `clearFirst=true` in
  `type_text` to focus the field on its own.
- The **calendar guest-search field** is special: its `.clear()` crashes the driver
  (`RangeError: no indices are valid`) and `Keys.BACK_SPACE` is inserted as a literal glyph.
  Clear it via its built-in **X button** (coordinate tap ~(742,65)), and only when
  `getText()` shows leftover text.
- Focusing the search field opens a "Past Searches" overlay that invalidates
  type+index re-resolution — get the element reference first, then send keys directly.
- Fields without ValueKeys are located by **positional index** in `allByType("TextField")`.
  Gate on a route-transition anchor first (e.g. `waitForElementByText("Personal info", 15)`)
  or the indices will resolve against the previous screen.

---

## 9. Scrolling

- `tapByKey` / finders do **not** auto-scroll. Sections below the fold (Health & Lifestyle,
  Vitals on the MR page) need explicit scrolling first: loop `scrollDown()` until
  `actions.exists(key)` (see `scrollToKey` in `GuestMedicalRecordPage`).
- In MCP, prefer `gesture` with `action: scroll_until_visible` + a key target.
- After saving an entity, content that renders below the fold isn't in the widget tree until
  you scroll to it — **scroll before asserting**.

---

## 10. Widget-tree efficiency

Reading the full tree is expensive. Use the cheapest probe that gives you the answer:

1. **`get_screen`** — visual orientation. Tells you what screen you're on and where things
   are roughly positioned. Always start here on an unknown screen.
2. **`find_elements` (targeted)** — when you know what you're after (a specific key or
   text). Returns count + positions without loading the full tree.
3. **`get_widget_tree format=tree interactiveOnly=true`** — when you need hierarchy for
   structure-based decisions. Pruned — boilerplate removed.
4. **`get_widget_tree format=compact`** — flat index scan across all interactive elements.
   Good for harvesting ValueKeys and discovering what's tappable.
5. **`get_widget_tree format=full`** — raw dump. Only for debugging a specific rendering
   mystery. Never use for routine exploration.

Additional rules:

- The tree is **cached** — pass `refresh: true` only after an action changed the screen.
- `interactiveOnly: false` only when you need static text anchors (section headers) for
  containment — otherwise the output is noisier without helping you tap anything new.
- The tree does **NOT** contain platform-view content — absence from the tree ≠ absence
  from the screen. Check `get_screen` for platform-view widgets.
- Harvest ValueKeys from the tree as you explore; for any tappable widget you needed that
  had no key, note it in `VALUEKEYS_TO_ADD.md` for the Flutter source team.
- Everything showing `disabled` in the tree is a Flutter semantics artifact — ignore it
  when deciding what to tap.

---

## 11. Interactive exploration loop

When the user says "click X, navigate to Y, then explore Z" — follow this loop:

1. **`find_elements` by text or key** for X → if found (count > 0), `tap` by that locator.
2. **Zero results + vmService connected** → look at the screenshot first (is it RichText?
   truncation? icon with no text?). For icons/images: try `find_elements` by type
   `RawImage`, `Icon`, or `Image` and identify by position — tap the correct index.
   Try `textContaining` with a visible prefix. Try the `tap` tool's natural-language
   `description` match. Coordinates are the **last resort** — only when the element is in
   a platform-view overlay with no ValueKey and no stable type+index.
3. **After every action, re-fetch the screen** (`get_screen`) and confirm the expected
   transition before the next step — screenshots are ephemeral.
4. **Record every working locator + the strategy that found it** as you go — these become
   the test's locators verbatim. When a step needed coordinates, flag it as fragile in the
   generated test and note the key that should be added.
5. **For repeat flows** (login, open guest profile, navigate to Medical Record) — use
   `zma_shortcut` or existing Java framework helpers instead of re-driving them step-by-step
   through MCP. MCP is for **discovery and verification**; the Java framework is for
   **execution**.

---

## 12. Assertion quality (bug-catchers, not flaky-passers)

Ask of every assertion: **"would this still pass if the feature were broken?"**

- **Unique data per test on a shared entity.** Tests sharing one guest must each use a
  DISTINCT value; asserting a string an earlier test already persisted is a false-pass.
  (The canonical example: priority-3 and priority-4 MR tests both used the same condition
  name, so p4 passed even when its add did nothing.)
- **Prefer content assertions** (the actual saved value) when the widget is a matchable
  Text. When it's RichText, fall back to a **structural key that only exists post-add on a
  fresh entity** (`mr_allergy_tile_actions_dropdown`, `mr_medication_tile_actions_dropdown`,
  `mr_note_tile_actions_dropdown`).
- **Verify the assertion target from a real screenshot of the passing state before writing
  it.** Guessing the on-screen string (typeahead resolution, truncation, case) burned three
  full runs; one screenshot would have burned zero.
- **Fast negative probes**: `existsByText()` / `exists()` — no wait, for asserting absence.

---

## 13. Test lifecycle & recovery

- Because app state persists across sessions (§1), put **self-heal navigation in
  `@BeforeMethod`**: if home key (`apb_today_button`) absent → close dialogs
  (`popup_close_button`) → tap back/scrim at (44,60) → loop up to 8 times.
  Never throw from recovery.
- **Never put recovery in `@AfterMethod`** — it runs before the framework's failure
  screenshot and destroys the diagnostic evidence.
- Optional fields (date pickers) that aren't reliably drivable: **skip them**. Confirm live
  that the save succeeds without them rather than fighting the picker.
- Dialog defaults: check what the dialog already has selected (e.g. Type defaults to
  "Acute") before scripting taps to select it — tapping an already-selected radio can hang.

---

## 14. Failure triage workflow

1. **Read the failure screenshot first** (`target/screenshots/*_FAILED_*.png`). It usually
   answers the question immediately (text present-but-RichText, wrong screen, dialog open).
2. **Classify infra vs code**: `ECONNREFUSED 127.0.0.1:8100` = WDA crashed mid-run —
   transient, rerun; do not change code for it. Timeout on a finder = locator/rendering
   problem — change the signal per §4.
3. When MCP is connected, reproduce the failing step live (`find_elements`, `get_screen`)
   **before** editing code — but honor §1: a dead VM service makes probes worthless.
4. **One hypothesis per run.** State what the next run will prove before launching it.
5. **Do not fall back to the original script unless the fix is truly impossible** — fall
   back only if you've exhausted all valid signals (wrong screen, dead vmService, hard
   platform-view wall with no key).

---

## 15. ZMA-specific widget keys reference

Keys defined in `ZmaWidgetKeys` in the Flutter source:

| Key | Widget |
|---|---|
| `apb_today_button` | Calendar "Today" button |
| `apb_quick_create_consumer_button` | Quick-create guest FAB |
| `apb_consumer_open_profile_icon` | Open guest profile icon |
| `apb_service_gallery_icon` | Gallery icon in appointment panel |
| `apb_service_camera_icon` | Camera icon in appointment panel |
| `apb_consumer_outdated_form_banner` | Outdated guest form banner |
| `popup_close_button` | Close button on MR add/edit dialogs |
| `mr_allergies_add_button` | Add allergy button |
| `mr_medications_add_button` | Add medication button |
| `mr_therapist_notes_add_button` | Add therapist note button |
| `mr_allergy_tile_actions_dropdown` | Per-tile actions menu (allergy) |
| `mr_medication_tile_actions_dropdown` | Per-tile actions menu (medication) |
| `mr_note_tile_actions_dropdown` | Per-tile actions menu (note) |
| `mr_medical_history_add_button` | Add self/family condition button |
| `mr_add_condition_condition_name_field` | Condition name typeahead field |
| `mr_add_condition_notes_field` | Condition notes field |
| `mr_add_condition_save_add_more_button` | "Save & add more" button |
| `mr_social_history_add_empty_button` | Add Health & Lifestyle button |
| `mr_vitals_record_button` | Record vitals button |
| `mr_vitals_systolic_bp_field` | Systolic BP input |
| `mr_vitals_diastolic_bp_field` | Diastolic BP input |
| `mr_vitals_heart_rate_field` | Heart rate input |
| `mr_vitals_respiratory_rate_field` | Respiratory rate input |
| `mr_vitals_temperature_field` | Temperature input |
| `mr_vitals_weight_field` | Weight input |

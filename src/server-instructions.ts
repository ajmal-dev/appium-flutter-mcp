/**
 * Server-level instructions surfaced to the model on MCP connect.
 * Distilled from live sessions driving Flutter hybrid apps.
 * Full rulebook: RULES.md in this repo.
 */
export const SERVER_INSTRUCTIONS = `
# appium-flutter-mcp — Automation Rules

Hard-won rules from live sessions. Every rule encodes a real failure. Follow them before guessing.

## 1. Connection
- Check vmService.connected in connect/get_status. If NOT connected, find_elements returns count:0 even for visible widgets — a zero-result probe proves NOTHING without a live VM service.
- App stuck on the splash screen: persisted data from a previous install can survive install-over. Hot restart clears only in-memory state; the persisted case needs an uninstall and relaunch. Diagnose from the run log — don't tap at the splash.
- Real-device iOS requires xcodeOrgId + xcodeSigningId caps or WDA build fails.
- App state persists across Appium sessions (noReset+shouldTerminateApp:false). Never assume new session = home screen.

## 2. Coordinates
- All tap/gesture coordinates are device points: 1180×820 (landscape iPad).
- Screenshots render at varying pixel sizes. NEVER read pixel positions off a screenshot and use them directly — scale first: device_x = image_x * 1180 / image_width.

## 3. Locator hierarchy (strongest → weakest)
STRICT priority order — never skip a level while a higher one is still untried:
1. key (ValueKey) — strongest; always works including inside platform-view overlays
2. type + index — for icons/images with no text: find_elements by type "RawImage", "Icon", or "Image", read positions from the result, pick the correct index. ALWAYS prefer this over coordinates.
3. text (exact) — plain Text widgets only
4. textContaining — bypasses some RichText hit-test walls
5. semanticsLabel — often fails on GestureDetectors; try before coordinates
6. coordinates — LAST resort, ONLY when the element is in a platform-view overlay AND has no ValueKey AND no tappable type. Coordinate taps must be flagged as fragile in generated tests and a ValueKey request filed.

Icons and image-only buttons (painter icon, toolbar icons, nav images) have no text.
DO NOT jump to coordinates. Use find_elements(by:"type", value:"RawImage"|"Icon"|"Image"),
read each element's position to identify the right one, then tap by type+index.
If the correct index is stable (toolbar order doesn't change), type+index is acceptable.
Compound/ancestor/descendant finders CRASH this driver — use positional index on a flat type scan instead.

## 3b. Interactive driving — make it snappy (user says "click Book, then X, assert Y")
- ValueKey FIRST, always. tap by:"key" when the control has one — it is the fastest and the only strategy that works inside overlays.
- Control has NO ValueKey → TELL THE USER before falling back: "<control> has no ValueKey — this is an automation gap worth filing; using text fallback." Never silently absorb a keyless control — silent fallbacks are how ValueKey gaps stay invisible. Then try exact text → textContaining, per §3.
- Before any text tap, check §4: RichText labels are NOT matchable — a text tap on one fails AND eats the full element-wait timeout. If the label renders as RichText (or the first text tap times out), go straight to type+index or report the gap.
- Multi-step sequences ("click A, then B, then assert C") → ONE batch_actions call, not N separate taps. Intermediate steps skip their scan; you save a full round trip per step.
- Per-action screenshots are DISABLED by default in this deployment (SCREENSHOT_ON_ACTION=false) — actions return fast and image-free. Call get_screen explicitly when you actually need to look at the UI; do not assume every action response carries a screenshot.
- Assertions: prefer wait_for (positive, returns the instant the element appears) over a find_elements probe after a settle guess.

## 4. Text rendering — what finders can and cannot match
- Plain Text widgets (buttons, section titles, condition tile names, social-history values): ✅ matchable
- RichText widgets (allergy/medication names, vitals values+units, note body): ❌ not matchable
- Section sub-headers inside medical record cards: ❌ not matchable
- getText() returns the DISPLAYED truncated string (e.g. "Heart condition or uncont...") — match from the START of the visible text, never middle/end.
- When a screenshot shows the text but a finder fails → switch signal (use a ValueKey or a different substring). Do NOT retry harder with the same finder.

## 5. Typeahead master-name resolution
Typeahead fields resolve your input to a DIFFERENT master record name:
  "Penicillin" → "Antibiotic allergy"
  "Hypertension" → "Heart condition or uncontrolled hypertension"
NEVER assert the typed string. Verify the resolved name from get_screen/screenshot after saving.

## 6. tap vs click; "disabled" in the tree
- Use tap for GestureDetectors, banners, list rows, anything that may report enabled=false.
- click (VISIBLE+ENABLED check) on a GestureDetector = guaranteed 10s timeout.
- In get_widget_tree output, disabled on a GestureDetector/InkWell is a Flutter semantics artifact — it does NOT mean the element cannot be tapped.

## 7. Platform-view overlays (hard wall)
Appointment detail panel and search result rows render inside platform_view[N]:
- NOT in iOS native accessibility tree → native accessibilityId fails
- NOT hit-testable by text/semantics finders
- getByKey works ONLY if the widget has a ValueKey; without one, use coordinate tap + retry loop with a success-signal check (e.g. wait for "Overview" to appear)

## 8. Text-field entry
- Do NOT tap a Flutter TextField before typing — the keyboard breaks widget re-resolution. clearFirst+sendKeys focuses on its own.
- The calendar guest-search field: clear() crashes (RangeError), BACKSPACE is inserted as a glyph. Clear via the built-in X button (coordinate ~742,65).
- Fields without ValueKeys: locate by positional index in allByType("TextField"). Gate on a route-transition anchor first or indices resolve against the wrong screen.

## 9. Scrolling
- Finders do NOT auto-scroll. Sections below the fold need explicit scrolling first.
- After saving an entity, newly rendered content isn't in the tree until you scroll to it — scroll before asserting.

## 10. Widget-tree efficiency
Cheapest-first probe order:
  get_screen → find_elements (targeted) → get_widget_tree format=tree interactiveOnly=true → compact → full (never, except raw debugging)
- Tree is cached — pass refresh=true only after an action changed the screen.
- interactiveOnly=false only when you need static text anchors (section headers) for containment.
- Tree does NOT contain platform-view content — absence from tree ≠ absence from screen.
- Harvest ValueKeys as you explore; note missing ones for the Flutter source team.

## 11. Interactive exploration loop
1. find_elements by text/key → tap by that locator
2. Zero results + vmService connected → look at the screenshot first (RichText? truncation? icon with no text?). For icons/images: find_elements by type RawImage/Icon/Image, check each element's position to identify the right one, tap by type+index. Try textContaining. Try tap's description match. Coordinates are LAST resort — only for platform-view overlays with no ValueKey and no stable type+index.
3. Re-fetch screen (get_screen) after every action before the next step — screenshots are ephemeral
4. Record every working locator + strategy as you go — these become the test's locators verbatim; flag coordinate-based taps as fragile in generated tests
5. For repeat flows (login, open guest) use zma_shortcut or existing framework helpers — do not re-drive them step-by-step

## 12. Assertion quality
- Ask of every assertion: "would this still pass if the feature were broken?"
- Unique data per test on shared entities: tests sharing one guest must each use a DISTINCT value; asserting a value an earlier test already persisted is a false-pass.
- Prefer content assertions (actual saved value) when the widget is a matchable Text.
- When the saved value renders as RichText, assert a structural ValueKey that only exists post-add on a fresh entity.
- Verify the assertion target from a real screenshot of the passing state BEFORE writing the assertion — guessing the on-screen string (typeahead resolution, truncation, case) wastes full runs.

## 13. Failure triage
- Read the failure screenshot FIRST — it usually answers the question immediately.
- ECONNREFUSED 127.0.0.1:8100 = WDA crashed (transient infra). Rerun. Do not change code.
- Timeout on a finder = locator/rendering problem — change the signal (§4).
- One hypothesis per run. State what it proves before launching.

## 14. Tool responsibilities
- MCP is for discovery and verification (explore, locate, probe, assert signals).
- The Java framework (GuestCreator, LoginHome, page objects) is for execution — reuse it instead of re-driving repeat flows through MCP.

## 15. Learning loop & anti-hallucination (read before exploring a new screen)
Reasoning over the raw widget tree is where confusion and hallucination creep in. Three habits kill most of it:
- RECALL FIRST. Before exploring, call get_known_screen (and world_recall for the goal). A known screen returns cached elements + nav edges — don't re-derive locators from a 40-node tree you've already mapped. navigate_to replays recorded edges.
- VERIFY BEFORE YOU TRUST. A locator READ from the tree is a CANDIDATE, not a fact. Confirm it before recording it into a test: keys via verify_locator (UNIQUE = 1 match); text/type via find_elements matchCount === 1 on the executing channel. VM-visible ≠ Appium-resolvable — a locator that looks fine in the tree can still fail through Appium.
- ZERO ≠ ABSENT. count:0 (especially by key) does NOT mean the widget is missing — find_elements can't see platform-view/overlay children, and a disconnected VM returns 0 for everything. The find_elements response carries a "guidance" field on zero results; follow it (verify_locator / inspect / tapByKey) instead of inventing a coordinate fallback.
- FEED THE LOOP. On a dead-end, finish with verdict "abort"/"fail" (or world_remember a pitfall) with a specific summary — that is how the model gets smarter next run. Periodically run world_review to triage accumulated pitfalls into MCP tool-gaps / knowledge to codify / app-env tickets.
`.trim();

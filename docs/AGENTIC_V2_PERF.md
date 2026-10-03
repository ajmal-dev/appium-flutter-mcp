# Agentic v2 — performance & token-efficiency overhaul

Branch: `feature/agentic-v2-perf`. All numbers below were **measured live** against
the ZMA front-desk app (iPad 10th gen, debug build, VM service connected) on 2026-07-17.

## Why

"Do these test steps" turnarounds were slow and token-hungry. Profiling showed the
cost was almost entirely MCP response overhead, not device time:

| Source of waste | Measured cost | Frequency |
|---|---|---|
| Raw full-res PNG screenshots (2360×1640) | ~5,160 image tokens each | every tap/type/wait + every agentic cycle |
| Full static contract re-sent per agentic cycle (playbook, stop conditions, reporting spec) | ~2,000 tokens | every `agentic_test_step` |
| `get_widget_tree format=tree` (pretty JSON + duplicated flat list, no text labels) | ~7,700 tokens | every tree fetch |
| VM action path calling nonexistent `ext.flutter.driver.tap/waitFor` methods | 1 failed VM round trip + fallback | every tap/type |
| Elements had no text labels (7 anonymous custom buttons) | forced extra screenshots | constantly |

A 60-step agentic run burned **~350k tokens of pure overhead** before this branch.

## What changed

1. **Screenshot compression everywhere** (`util/screenshot.ts` → `LLM_SCREENSHOT_OPTS`,
   applied in `tools/act.ts`, `tools/zma-workflows.ts`, `agent/orchestrator.ts`):
   800px JPEG q75 ≈ 590 tokens vs ~5,160. Measured 405KB → 67KB on real run artifacts.

2. **Screenshot-on-change in the agentic loop** (`agent/orchestrator.ts`): the widget
   tree (~280ms via VM) is now the change detector; the screenshot is captured only
   when the compact element summary changed. `agentic_test_step` gained
   `screenshot: "auto" | "always" | "never"` (default auto).

3. **Lean cycle contract** (`agent/contract.ts` → `renderCycleUpdate`): the full
   playbook renders **once at kickoff**. Cycles return: step header, screen-change
   flag + delta, element list (only when changed), phase playbook (only on phase
   transition), budget/streak warnings (only when near limits). ~2,000 → ~100–400
   tokens per cycle.

4. **Checkpoint reporting**: contract + tool descriptions now instruct the agent to
   call `agentic_test_step` at checkpoints (screen transition / sub-goal / stuck),
   not after every micro-action, and to use `batch_actions` for known sequences
   (intermediate sub-actions also skip the discarded auto-scan now).

5. **`get_widget_tree format=tree` as indented text** (`tree/prune-tree.ts` →
   `renderTreeAsText`, `server.ts`): one node per line
   (`InkWell key:apb_today_button "Today"`), no duplicated flat list, no JSON
   boilerplate. Measured: **7,679 → 477 tokens (16×)** on the appointment book.

6. **Text labels on interactive elements** (`vm/dart-vm-client.ts`,
   `vm/vm-widget-tree.ts`): summary tree now fetched via
   `getRootWidgetSummaryTreeWithPreviews` — **it requires `groupName`, not
   `objectGroup`** (wrong key silently fails with -32000 → this is why labels never
   worked). Descendant `Text` labels are propagated onto unlabeled interactive
   nodes via depth-capped BFS (≤6 levels, so page-level containers don't steal
   faraway text). Result: `Button "Edit"`, `TextButton "Start"`,
   `InkWell "Today" key:apb_today_button` — the agent can act without a screenshot.

7. **VM action path fixed + flavor detection** (`vm/vm-actions.ts`,
   `vm/vm-session.ts`): flutter_driver registers **one** service extension
   (`ext.flutter.driver`) dispatched on a `command` param — the per-command method
   names the old code called (`ext.flutter.driver.tap`) never existed on any build.
   Rewritten to the real protocol (verified live: `get_health` → `{status: ok}`).
   Note: integration_test/appium_flutter_server builds (ZMA) register the same
   extension but only implement a health/data subset — UI commands return -32000.
   First protocol-level failure now marks the VM path broken for the session
   (sticky), so subsequent actions go straight to Appium with zero wasted calls.

## Measured results

| Metric | Before | After |
|---|---|---|
| `get_widget_tree` (tree) | ~7,700 tokens | ~480 tokens |
| Post-action screenshot | ~5,160 tokens | ~590 tokens |
| Agentic cycle (unchanged screen) | ~6,000+ tokens | ~150 tokens (no image) |
| Agentic cycle (changed screen) | ~6,000+ tokens | ~1,000–1,400 tokens |
| Labeled interactive elements | 0/40 | 12/40 (all text-bearing controls) |
| VM round trips wasted per action | 1 failed call every action | 1 total per session |

## Webview layer (added after the Flutter-side overhaul)

Measured live: the ZMA calendar webview DOM is 471KB (313 clickables); raw
`inspect(page_source)` was a ~118k-token single response and the ONLY way to
observe a webview. Changes:

1. `inspect(target:"webview")` defaults to `action:"elements"` — compact
   numbered list with ready-to-tap CSS selectors (`#id` > `[data-event-id]` >
   `[name]` > `tag.class`), element text, CSS-px rects, and the webview's
   device bounds for coordinate translation. `selector` param widens the scan
   (e.g. `.b-sch-event`). `page_source` is stripped + capped at 60KB with an
   explicit truncation notice.
2. Scanner: `[data-event-id]` + `[contenteditable]` added (Bryntum appointment
   cards are plain divs with data-event-id — invisible to the old selector
   set); visible-only cap 100→150 with total/truncated reporting.
3. `tap(by:"css")`: JS-first path (querySelectorAll + synthesized pointer/mouse
   events, one execute() round trip, no WebKit atom waits). Falls back to the
   atom path on no-match; response carries translated device coordinates for a
   trusted-tap retry.
4. Blind `switchToWebView` ranks candidates by `mobile: getContexts` metadata —
   real-URL webviews first, `about:blank` preloads last (ZMA keeps ~4 stale
   blanks alive; switching into one wastes a WebKit handshake and can crash
   iOS sessions).
5. `executeJavaScript` fallback restricted to real-URL webviews and reports
   which context executed the script.
6. Agentic observations inside webviews now use the DOM scan for element
   summaries + change detection (screenshot-skipping now works there too).

**Bryntum end-to-end verification (live, 2026-07-17):** the appointment
calendar webview's full day schedule came back as a ~600-token numbered list
(`inspect(elements, selector: ".list-appointment-block")` — every guest, time
slot, CSS selector, position). `tap({by: "css", target:
"div.list-appointment-block", index: 1})` went through the JS-first path and
switched the Flutter appointment detail panel to the targeted guest (verified
via the labeled widget tree). This replaces the Java framework's blind
coordinate taps + tap-and-verify retry loops (AppointmentSelector) for
Bryntum interaction: 3 calls, ~1.5k tokens, no coordinates.

## Future work (not in this branch)

- `zma_shortcut` hard sleeps (~10–20s per login flow) → condition-based waits.
- Appium session creation is ~45–60s on the real iPad (WDA handshake) — consider
  attaching to an existing session id by default when one is alive.
- Icon-only buttons (nav rail) still unlabeled — their labels live in the
  semantics tree; `getSemanticsTree` merge would cover them.
- `find_elements` per-element `getText/isDisplayed/...` round trips could be
  answered from the VM tree in one shot.
- `wait_for` timeout accounting: a 15s request blocked ~65s live — the
  FlutterIntegration driver's internal 5s-per-find compounds with wdio retries.
  The MCP should enforce its own deadline around the wait loop.

## Live verification (2026-07-17, post-reconnect)

- Cycle on unchanged screen: lean text (~130 tokens), NO image, explicit
  "(screenshot skipped — screen unchanged)". Was ~6,000 tokens.
- Cycle on changed screen: element delta line (40 → 23 elements), fresh labeled
  list, compressed screenshot, phase playbook only on the phase transition.
- Flavor detection: exactly one VM attempt, then
  "VM driver commands unsupported on this build — disabling VM action path for
  this session"; Appium tap completed 410ms later; later actions skip the VM.
- get_widget_tree(tree): labeled indented text through the MCP transport.
- interactiveOnly=false tree exposes static Text anchors ("Services", "Botox",
  guest names) for containment-based locators.

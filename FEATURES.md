# Appium Flutter MCP — Groundbreaking Features

## Feature 1: Page-Source-First Scanner (10-50x faster widget tree)

### Problem
`scanInteractiveWidgets()` iterates 115+ widget types, calling `findElements('-flutter type', typeName)` for each. Per found element: getText + isDisplayed + isEnabled + getSize + getLocation + getAttribute = 6 more calls. Total: **100-200 Appium calls, 5-15 seconds per scan.**

### Solution
Single `getPageSource()` call returns entire widget tree as XML. Parse locally (zero network). Only make targeted Appium calls for Flutter-specific locator enrichment (ValueKey lookup).

### Files
- **New**: `src/tree/page-source-scanner.ts` — XML parser + element classifier
  - Calls `browser.getPageSource()` (1 Appium call, ~200ms)
  - Parses XML: extracts type, text/label/value, bounds, enabled/visible
  - Maps native types → Flutter types (iOS: XCUIElementType*, Android: android.widget.*)
  - Classifies interactive vs layout-only (reuses `INTERACTIVE_WIDGET_TYPES`)
  - Batch resolves Flutter locators for interactive elements only (5-20 calls)
- **Modified**: `src/tree/tree-builder.ts` — Uses `pageSourceScan()` first, falls back to `scanInteractiveWidgets()` if empty

### Performance
| Metric | Before | After |
|--------|--------|-------|
| Appium calls | 100-200 | 1 + 5-20 |
| Scan time | 5-15 seconds | 0.3-2 seconds |
| **Speedup** | — | **5-50x** |

---

## Feature 2: Self-Healing Locators (eliminate flaky tests)

### Problem
When the app updates, widget keys/text change. Tests fail not from real bugs but stale locators. `findElement` throws immediately on failure with no fallback across locator strategies. This is the **#1 cause of test maintenance burden** in mobile automation.

### Solution
When a primary locator fails, cascade through alternative strategies. Log healing events for human review.

### Healing Strategy Cascade
1. **Key variants** — camelCase ↔ snake_case, prefix/suffix removal (confidence: 0.9)
2. **Text strategy** — use key as text, clean up separators (confidence: 0.85)
3. **SemanticsLabel** — try key/text as accessibility label (confidence: 0.85)
4. **Fuzzy text match** — Levenshtein + token similarity against all visible elements (confidence: variable, threshold ≥ 0.7)

### Design Rules
- **Active mode**: Auto-heal when confidence ≥ 0.8
- **Passive mode**: Log healing opportunities but still fail (for review)
- **Off mode**: Disabled entirely
- Below threshold: log but don't heal (prevents masking real bugs)

### Files
- **New**: `src/locator/fuzzy.ts` — Levenshtein distance, token similarity, key variant generator
- **New**: `src/locator/registry.ts` — Healing event log, configuration (mode, thresholds)
- **New**: `src/locator/healer.ts` — Strategy cascade engine
- **New**: `src/tools/healing.ts` — MCP tool handlers
- **Modified**: `src/tools/act.ts` — Integrated healing into `findElementWithContextFallback()` as Step 4 (after context fallback)

### MCP Tools
- **`get_healing_log`** — View healing events from current session (original locator, healed locator, strategy, confidence)
- **`configure_healing`** — Set mode (off/passive/active), confidence thresholds, clear log

---

## Feature 3: Visual AI Test Oracle (auto-assertions from screenshots)

### Problem
Only explicit `add_assertion` calls create verification points. Testers must manually decide what to assert. Visual regressions (layout shifts, missing icons, wrong text) are completely missed.

### Solution
Capture "golden baseline" screenshots at each step during recording. On replay, compare actual vs baseline using structural comparison (fast, local). Detects:
- **Missing elements** — element in baseline not found on current screen
- **Added elements** — new element not in baseline
- **Text changes** — element text differs from baseline
- **Layout shifts** — element moved >50px from baseline position
- **Count changes** — different number of interactive elements

### Files
- **New**: `src/visual/diff.ts` — VisualDiff, StructuralChange, VisualBaseline, VisualReport types
- **New**: `src/visual/baseline.ts` — Save/load golden baselines to `~/.appium-flutter-mcp/baselines/<recordingId>/`
- **New**: `src/visual/comparator.ts` — Structural comparison engine (element count, text, positions)
- **New**: `src/tools/visual.ts` — MCP tool handlers

### Storage
```
~/.appium-flutter-mcp/baselines/
  └── <recordingId>/
      ├── baseline.json      (metadata + element snapshots)
      ├── step_001.jpg        (screenshot)
      ├── step_002.jpg
      └── ...
```

### MCP Tools
- **`save_baseline`** — Save current/last recording as golden baseline
- **`compare_baseline`** — Compare current screen against a specific baseline step
- **`visual_regression_report`** — Run full regression against a saved baseline

---

## Bug Fix: Recording → generate_test

### Problem
`stopRecording()` set `activeRecording = null`, so `generate_test` couldn't find the recording after stopping.

### Solution
Added `lastRecording` variable in `recorder.ts` that preserves the stopped recording. `handleGenerateTest()` in `recording.ts` falls back to `getLastRecording()`.

### Files
- **Modified**: `src/recording/recorder.ts` — Added `lastRecording` + `getLastRecording()`
- **Modified**: `src/tools/recording.ts` — Falls back to `getLastRecording()` in `handleGenerateTest()`

---

## Tool Count Summary

| Category | Tools | New |
|----------|-------|-----|
| Session | connect, disconnect, get_status | — |
| Observation | get_screen, get_widget_tree, find_elements, get_element_details | — |
| Actions | tap, type_text, gesture, wait_for | — |
| Context | switch_context, inspect_webview, inspect_native | — |
| Device | launch_app, terminate_app, device_info | — |
| Recording | start_recording, stop_recording, add_assertion, generate_test, get_recording | — |
| **Self-Healing** | **get_healing_log, configure_healing** | **+2** |
| **Visual Oracle** | **save_baseline, compare_baseline, visual_regression_report** | **+3** |
| **Total** | **25 tools** | **+5 new** |

---

## Build Order & Dependencies

```
Feature 1 (Page-Source Scanner)     ← prerequisite for Feature 2
    ↓
Feature 2 (Self-Healing)           Feature 3 (Visual Oracle)
    ↓                                   ↓
Both independent, built in parallel after Feature 1
```

# Appium Flutter MCP - Fixes & Improvements

Based on a real-world testing session (Apr 7, 2026) with a Flutter hybrid app on iOS.

---

## 1. ~~Add coordinate-based tap support~~ ✅ FIXED
- The `tap` tool now supports `by: "coordinates"` with `x` and `y` params
- Also auto-detects coordinate mode when `x`/`y` are provided without explicit `by`
- **Changed:** `src/tools/act.ts` — tapSchema, handleTap

## 2. ~~Widget detection gaps~~ ✅ FIXED
- Expanded `INTERACTIVE_WIDGET_TYPES` from 24 to 65+ types (standard Flutter plus common app widgets)
- Added fallback semantics-based scan that discovers tappable elements via native accessibility tree labels
- New types include: FilledButton, SearchBar, Chip variants, NavigationBar, Icon, CircleAvatar, and app-specific widgets
- **Changed:** `src/tree/types.ts`, `src/tree/widget-scanner.ts`

## 3. ~~Frequent WDA connection drops~~ ✅ FIXED
- Added `getBrowserWithReconnect()` in session manager with auto-recovery
- Health check via `getWindowRect()` — on failure, attempts re-attach then fresh session
- Stores last connection options for automatic session recreation
- Applied to all action/observation tool handlers (tap, type_text, gesture, get_screen, find_elements)
- **Changed:** `src/appium/session.ts`, `src/tools/act.ts`, `src/tools/observe.ts`

## 4. ~~`enabled: false` on all interactive widgets~~ ✅ FIXED
- `isEnabled()` returns false for all Flutter elements (FlutterIntegration driver bug)
- Added fallback: tries `getAttribute('enabled')` — if returns `"true"` or `null`, treats as enabled
- If both fail, assumes enabled (correct for most widgets)
- Applied in both widget scanner and find_elements tool
- **Changed:** `src/tree/widget-scanner.ts`, `src/tools/observe.ts`

## 5. ~~No index-based element selection~~ ✅ FIXED
- Added `index` parameter (zero-based) to `tap` and `type_text` tools
- `index: 2` targets the 3rd matching element
- Works for all strategies: Flutter (key/text/type), native (xpath/accessibilityId), WebView (css)
- Clear error message when index exceeds number of found elements
- **Changed:** `src/tools/act.ts` — tapSchema, typeTextSchema, findElement()

## 6. ~~Screenshot-to-coordinate mapping~~ ✅ FIXED
- `get_screen` now includes device dimensions in the response text: `Device: 1024x1366px`
- These are the actual coordinates to use with `tap(by: "coordinates", x, y)`
- Widget tree element positions already use the same coordinate space
- **Changed:** `src/tools/observe.ts` — handleGetScreen

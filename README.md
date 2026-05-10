# Appium Flutter MCP

> An [MCP](https://modelcontextprotocol.io) server that lets AI assistants drive **Flutter** (and hybrid Flutter + WebView + Native) apps through Appium — with natural-language locators, source-aware ValueKey discovery, self-healing tests, and vision-led test execution.

[![CI](https://github.com/USER/appium-flutter-mcp/actions/workflows/ci.yml/badge.svg)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](#)

---

## Why

Driving a real Flutter app from an LLM is fiddly — coordinates drift, locators break, and hybrid Flutter+WebView+Native screens need three different APIs. This MCP wraps all that behind tool calls an AI can reason about:

- **Find anything by description** — "the book button" returns a verified, unique locator.
- **Heal locators that change** — when a key disappears, fall back through text → semanticsLabel → fuzzy match.
- **Catch visual regressions** — save a baseline once, compare on every run.
- **Run plain-English tests** — point the AI at a markdown test case and let it drive vision-led, with hint memory that learns across runs.

It's locator-agnostic at the core, so the same tools work whether you're scripting deterministic flows or doing exploratory testing.

## Quick start

### 1. Prerequisites

Common to both platforms:

| | |
| --- | --- |
| Node.js | ≥ 18 |
| Appium | 2.x running locally — `appium` |
| Flutter driver | `appium driver install --source=npm appium-flutter-integration-driver` |
| App | Your Flutter app launched in **debug** or **profile** mode (so the Dart VM Service is exposed) |

Platform-specific:

| | iOS | Android |
| --- | --- | --- |
| Base driver | `appium driver install xcuitest` | `appium driver install uiautomator2` |
| Toolchain | Xcode + WebDriverAgent (auto-built on first session) | Android SDK + platform-tools (`adb`), Java 17+ |
| Device | Real iOS device paired & trusted via Xcode | Physical device with USB Debugging on, **or** an emulator (`emulator @<avd>`) |
| Identifier source | `idevice_id -l` | `adb devices` |

### 2. Install

```bash
git clone https://github.com/USER/appium-flutter-mcp.git
cd appium-flutter-mcp
npm install
npm run build
```

### 3. Configure your MCP client

All connection details live in the `env` block of the MCP server registration — nothing is hardcoded. Pick the example below that matches your target platform, then add it to `~/.claude.json` (Claude Code) or your equivalent MCP client config.

> Tip: register **both** entries side-by-side (with different `name`s like `appium-flutter-mcp-ios` and `appium-flutter-mcp-android`) if you regularly switch platforms. Tools will namespace as `mcp__appium-flutter-mcp-ios__*` vs `mcp__appium-flutter-mcp-android__*` so the AI can target the right device.

#### iOS

Prereqs: `appium driver install xcuitest`, an iOS device paired via Xcode/WebDriverAgent, and your Flutter app launched in debug or profile mode.

Get the UDID:
```bash
idevice_id -l                       # or: xcrun xctrace list devices
```

```jsonc
{
  "mcpServers": {
    "appium-flutter-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/appium-flutter-mcp/dist/index.js"],
      "env": {
        "APPIUM_URL": "http://127.0.0.1:4723",
        "PLATFORM": "ios",

        "APPIUM_UDID": "00008101-000XXXXXXXXXXXXX",   // idevice_id -l
        "APPIUM_BUNDLE_ID": "com.example.yourapp",
        "APPIUM_DEVICE_NAME": "iPhone",
        "APPIUM_PLATFORM_VERSION": "17.0",
        "APPIUM_NO_RESET": "true",

        // Optional — source-aware ValueKey discovery from Dart source
        "FLUTTER_APP_PATH": "/path/to/your/flutter/app",
        "FLUTTER_COMPONENTS_PATH": "/path/to/shared/flutter/components",

        // Optional — directory holding *.cua.md test cases
        "CUA_TESTCASES_DIR": "/path/to/cua/testcases"
      }
    }
  }
}
```

#### Android

Prereqs: Android SDK + platform-tools (ADB), Java 17+, `appium driver install uiautomator2`, a physical device with USB debugging or a running emulator, and your Flutter app launched in debug or profile mode.

Get the device serial:
```bash
adb devices
# → emulator-5554       device
# → R5CT70XXXXXXXXXX    device
```

```jsonc
{
  "mcpServers": {
    "appium-flutter-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/appium-flutter-mcp/dist/index.js"],
      "env": {
        "APPIUM_URL": "http://127.0.0.1:4723",
        "PLATFORM": "android",

        "APPIUM_UDID": "emulator-5554",                       // adb devices
        "APPIUM_APP_PACKAGE": "com.example.yourapp",
        "APPIUM_APP_ACTIVITY": "com.example.yourapp.MainActivity",
        "APPIUM_DEVICE_NAME": "Pixel 7",
        "APPIUM_PLATFORM_VERSION": "14",
        "APPIUM_NO_RESET": "true",

        // Optional — source-aware ValueKey discovery from Dart source
        "FLUTTER_APP_PATH": "/path/to/your/flutter/app",
        "FLUTTER_COMPONENTS_PATH": "/path/to/shared/flutter/components",

        // Optional — directory holding *.cua.md test cases
        "CUA_TESTCASES_DIR": "/path/to/cua/testcases"
      }
    }
  }
}
```

> Don't know the package + activity offhand? With the app running, `adb shell dumpsys window | grep -i mCurrentFocus` prints both. Or check your Flutter project's `android/app/src/main/AndroidManifest.xml`.

#### Side-by-side (both platforms)

```jsonc
{
  "mcpServers": {
    "appium-flutter-mcp-ios":     { /* the iOS block above */ },
    "appium-flutter-mcp-android": { /* the Android block above */ }
  }
}
```

For local dev / direct CLI runs, you can also drop a `.env` file at the project root instead — see [`.env.example`](./.env.example) for the full list of variables.

#### Getting the Dart VM Service URL

When you `connect`, you can pass a `vmServiceUrl` for ~10× faster widget-tree access. Grab it from `flutter run` output:

```
A Dart VM Service on iPhone is available at: http://127.0.0.1:60146/1TsvdAvZn68=/
```

Convert `http://` → `ws://` and append `/ws`:

```
ws://127.0.0.1:60146/1TsvdAvZn68=/ws
```

Pass that to `connect`:

> Connect to my iOS app at `ws://127.0.0.1:60146/1TsvdAvZn68=/ws`

If omitted, the server auto-discovers from running Flutter processes (set `VM_AUTO_DISCOVER=false` to disable).

### 4. First run

Restart your MCP client so it picks up the new server, then ask:

> Connect to my iOS app and take a screenshot.

The model will call `connect`, `get_screen`, and surface the screenshot. From there:

> Find the locator for the "Sign in" button.

> Tap "Sign in", then type my email into the email field.

That's it — you're driving a real device through an LLM.

## Tools at a glance

39 tools, grouped by purpose. See each tool's `description` (in `src/server.ts`) for the full schema.

| Category | Tools |
| --- | --- |
| **Session** | `connect`, `disconnect`, `get_status` |
| **Observe** | `get_screen`, `get_widget_tree`, `find_elements`, `get_element_details`, `get_known_screen`, `flutter_locator`, `get_locator` |
| **Act** | `tap`, `type_text`, `gesture`, `wait_for`, `scroll_until_visible`, `wait_for_page_stable`, `smart_tap`, `batch_actions` |
| **Navigate** | `switch_context`, `inspect_webview`, `inspect_native`, `navigate_to`, `wait_for_webview`, `webview_fill_form` |
| **Device** | `launch_app`, `terminate_app`, `device_info` |
| **Recording** | `start_recording`, `stop_recording`, `add_assertion`, `get_recording` |
| **Self-Healing** | `get_healing_log`, `configure_healing` |
| **Visual** | `save_baseline`, `compare_baseline`, `visual_regression_report` |
| **CUA** (vision-led) | `cua_run_test`, `cua_report_step`, `cua_finish_test` |

### Locator priority

The `flutter_locator` / `get_locator` tools always prefer locators in this order:

1. **ValueKey** — most stable, survives UI text changes
2. **semanticsLabel** — stable accessibility label
3. **text** — readable but breaks on text changes
4. **type + index** — fragile, last resort

For the full agent workflow on locator discovery, see [`CLAUDE.md`](./CLAUDE.md).

## Configuration reference

Every option below is read from the process environment (or a `.env` file at the project root). Defaults shown where applicable.

| Variable | Default | Purpose |
| --- | --- | --- |
| `APPIUM_URL` | `http://127.0.0.1:4723` | Appium server URL |
| `PLATFORM` | `ios` | `ios` or `android` |
| `SESSION_ID` | — | Attach to an existing Appium session instead of creating one |
| `APPIUM_UDID` | — | iOS device UDID / Android serial |
| `APPIUM_BUNDLE_ID` | — | iOS bundle ID |
| `APPIUM_APP_PACKAGE` | — | Android package |
| `APPIUM_APP_ACTIVITY` | — | Android activity |
| `APPIUM_DEVICE_NAME` | — | e.g. "iPhone" |
| `APPIUM_PLATFORM_VERSION` | — | e.g. "17.0" |
| `APPIUM_APP_PATH` | — | Path to `.ipa` / `.apk` to install |
| `APPIUM_NO_RESET` | `true` (iOS) | Don't wipe app state between sessions |
| `APPIUM_FULL_RESET` | `false` | Full reset on session start |
| `APPIUM_SHOULD_TERMINATE_APP` | `false` | Terminate app on disconnect |
| `FLUTTER_APP_PATH` | — | Root of your Flutter app source (enables ValueKey lookup from Dart) |
| `FLUTTER_COMPONENTS_PATH` | — | Directory of shared Flutter component packages |
| `CUA_TESTCASES_DIR` | — | Where `*.cua.md` test files live |
| `VM_SERVICE_URL` | — | Explicit Dart VM Service WebSocket URL |
| `VM_AUTO_DISCOVER` | `true` | Auto-discover VM Service from running Flutter procs |
| `FLUTTER_*` (timeouts) | see `.env.example` | Driver tunables |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

## Architecture

```
┌──────────────────┐   stdio    ┌────────────────────┐   HTTP    ┌────────────┐
│  MCP client      │ ◀────────▶ │  Appium Flutter    │ ◀───────▶ │  Appium    │
│  (Claude Code)   │            │  MCP server (this) │           │  server    │
└──────────────────┘            └────────────────────┘           └─────┬──────┘
                                          ▲                            │
                                          │ optional WebSocket         │
                                          │ (faster widget tree)       ▼
                                  ┌──────────────────┐            ┌─────────┐
                                  │  Dart VM Service │            │  Device │
                                  │  (Flutter app)   │            │         │
                                  └──────────────────┘            └─────────┘
```

The MCP server speaks JSON-RPC over stdio to its client and HTTP to Appium. When the optional `VM_SERVICE_URL` is set (or auto-discovery succeeds), it also opens a WebSocket directly to the Flutter app's Dart VM for faster widget-tree access — falling back to Appium's page source when the VM isn't available.

## Development

```bash
npm run dev          # hot-reload via tsx
npm run typecheck    # tsc --noEmit
npm run build        # compile to dist/
npm run test         # placeholder for now
```

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the contributor guide.

## Troubleshooting

**`Unable to start WebDriverAgent session` / `Timed out attempting to launch app`**
WDA hasn't finished building or the device is locked. Unlock the device, kill any stuck `xcodebuild build-for-testing WebDriverAgent` processes, and try again.

**`No interactive elements found on screen` from `flutter_locator`**
The widget tree may not have loaded yet, or the screen is still animating. Call `wait_for_page_stable` first, or fall back to `find_elements` with an explicit `by`/`value`.

**`connect` hangs**
Try setting `VM_AUTO_DISCOVER=false` in your env block — VM auto-discovery scans running processes and can stall on slow systems. Or pass `vmServiceUrl` explicitly to `connect`.

**Tools work but get_widget_tree is missing text/positions**
You're in VM-hybrid mode and the Dart VM isn't enriching every node. Use `find_elements` directly, or temporarily skip the VM by omitting `VM_SERVICE_URL` and setting `VM_AUTO_DISCOVER=false`.

## Related projects

- [Appium Flutter Integration Driver](https://github.com/AppiumTestDistribution/appium-flutter-integration-driver) — the upstream driver this MCP wraps
- [Model Context Protocol](https://modelcontextprotocol.io) — the protocol spec
- [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript) — for building MCP clients

## License

[MIT](./LICENSE)

# Appium Flutter MCP

MCP server for driving **Flutter hybrid apps** (Flutter + native overlays + WebViews) through the Appium Flutter Integration Driver. Works in **Cursor** and Claude Code.

Sessions also run in `safari` and `native-xcuitest` modes — pass `capabilities` on `connect` (e.g. `appium:automationName: "XCUITest"`); Flutter-tree tools guard off in those modes.

## Install

This package is not on npm, so install from the GitHub repo. Node has to be on the machine already; setup checks the version and installs Appium if it is missing.

```bash
git clone https://github.com/ajmal-dev/appium-flutter-mcp.git
cd appium-flutter-mcp
npm run setup
```

`npm run setup` checks Node 18+, installs this repo’s dependencies, installs Appium and the Flutter driver when they are missing (plus XCUITest or UiAutomator2 for the platform you pick), asks for your device id, and registers `appium-flutter-mcp` in `~/.cursor/mcp.json` for every workspace. Restart Cursor. The server should appear under **Settings → MCP**.

Add Claude Code as well: `npm run setup -- --target=both`

If you already know the values, skip the questions:

```bash
npm run setup -- --yes
```

Then set `APPIUM_UDID` in `.env` and run `npm run setup` once more. Changing `.env` later always needs another `npm run setup`, because Cursor reads the env block inside `mcp.json`, not the repo `.env`.

### Manual Cursor config (if you skip the script)

**Cursor Settings → MCP → Add new global MCP server**, or edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "appium-flutter-mcp": {
      "command": "npx",
      "args": ["tsx", "/ABS/PATH/TO/appium-flutter-mcp/src/index.ts"],
      "env": {
        "APPIUM_URL": "http://127.0.0.1:4723",
        "PLATFORM": "ios",
        "APPIUM_UDID": "YOUR_DEVICE_UDID",
        "APPIUM_BUNDLE_ID": "com.example.app"
      }
    }
  }
}
```

Use the **absolute** path to `src/index.ts`. Env on the MCP block is what Cursor actually passes in (not only the repo `.env`).

### What you still need outside this repo

| Need | Notes |
|---|---|
| Node **≥ 18** | Setup checks `node` and stops if it is older. Install from https://nodejs.org |
| Appium + Flutter driver | If `appium` is missing, setup installs Appium 3 and `appium-flutter-integration-driver`. An existing Appium 2.x install is left in place; the Flutter driver needs `npm i -g appium@3` |
| iOS | Setup installs the XCUITest driver. Xcode and a device or simulator are still yours |
| Android | Setup installs the UiAutomator2 driver. Android SDK / `adb` are still yours |
| App under test | Flutter app launched with the Appium integration server (`appium_launcher` / `appium_flutter_server`) |

Point `APPIUM_BUNDLE_ID` (or the Android package and activity) at the app you want to drive. `npm run setup` does not install that app.

## After Cursor sees the server

Start Appium, launch the Flutter app on device, then in chat call `connect` with platform (`ios` / `android`) and the Dart VM Service URL from the Flutter console (`ws://...`). Check `vmService.connected` in the response.

## Scripts

| Command | What it does |
|---|---|
| `npm run setup` | Check Node, install deps, install Appium if needed, register MCP in Cursor |
| `npm run setup -- --target=claude` | Same for `~/.claude.json` |
| `npm start` | Run the server on stdio (what Cursor launches) |

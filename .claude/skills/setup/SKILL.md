---
name: setup
description: First-time setup of the appium-flutter-mcp server after cloning this repo. Prefer `npm run setup` (registers Cursor ~/.cursor/mcp.json). This skill also checks prerequisites, collects device/repo paths, writes .env, and can register Claude Code (~/.claude.json). Config-only — it does not install Appium/drivers or clone source repos.
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Glob
  - Grep
  - AskUserQuestion
---

# appium-flutter-mcp — first-time setup

Gets a freshly-cloned `appium-flutter-mcp` working end-to-end: dependencies installed, prerequisites verified, and the MCP server registered so **Cursor** (`~/.cursor/mcp.json`) and/or **Claude Code** (`~/.claude.json`) can launch it.

**Preferred path:** from the repo root run `npm run setup` (Cursor) or `npm run setup -- --target=both` (Cursor + Claude). That script does `npm install`, creates `.env` from `.env.example` if missing, and merges the MCP block. Use this skill when you need the interactive device/path collection below.

Run the remaining phases **in order** if not using the script. Everything is idempotent — re-running is safe.

## The one thing that actually makes this work

The MCP is launched as a stdio child process whose **cwd is often not this repo**. `.env` is also loaded from the package root (`src/util/config.ts`), but **the env vars that always take effect are the ones in the MCP client config** (`~/.cursor/mcp.json` or `~/.claude.json` → `mcpServers.appium-flutter-mcp.env`). That block is the real target. Repo `.env` is for `npm start` / overlay.

> Note: the committed `.claude.json` at the repo root is vestigial (not MCP-shaped) — ignore it. Do not edit it.

## Scope — config only

`npm run setup` checks Node 18+, installs Appium globally when `appium` is missing, and installs the Flutter driver plus XCUITest or UiAutomator2. It will NOT:
- install Node or Xcode
- clone your Flutter app or automation project

If a prerequisite is missing, surface it with a fix hint and let the user act. Everything the skill *writes* is `npm install`, the repo `.env`, and the `~/.claude.json` mcpServers block.

---

## Phase 0 — Locate the repo

Confirm you are operating on this repo and capture its absolute path (used in the MCP `args`):

```bash
REPO="$(git -C "$(pwd)" rev-parse --show-toplevel 2>/dev/null)"
echo "Repo: $REPO"
test -f "$REPO/package.json" && grep -q '"name": "qa-mcp-appium"' "$REPO/package.json" \
  && echo "OK: appium-flutter-mcp repo confirmed" \
  || echo "WARN: this doesn't look like the appium-flutter-mcp repo"
```

If it isn't the right repo, stop and tell the user to run `/setup` from inside their clone of `appium-flutter-mcp`.

---

## Phase 1 — Prerequisite checks (report only)

Run these and build a checklist. Do **not** try to fix anything — just report status + a fix hint per failure.

```bash
echo "== Node =="; node --version 2>/dev/null || echo "MISSING node"
echo "== npm ==";  npm --version  2>/dev/null || echo "MISSING npm"
echo "== Appium =="; appium --version 2>/dev/null || echo "MISSING appium (npm i -g appium)"
echo "== Appium drivers =="; appium driver list --installed 2>/dev/null || echo "cannot list drivers"
echo "== Xcode (iOS only) =="; xcodebuild -version 2>/dev/null | head -1 || echo "no xcodebuild"
```

Evaluate:
- **Node** must be **≥ 18** (see `engines` in `package.json`). If the major version is < 18, flag it — `tsx` / the SDK may not run.
- **Appium drivers**: for iOS the user needs the Flutter integration driver + XCUITest. If `appium driver list --installed` doesn't show a flutter driver and `xcuitest`, note the fix:
  - `appium driver install --source=npm appium-flutter-integration-driver`
  - `appium driver install xcuitest`
- **Xcode** is only needed for iOS (physical device or simulator). Skip for Android.

Print a compact PASS/MISSING table. If anything critical is MISSING, tell the user but continue — they can finish config now and install prereqs after.

---

## Phase 2 — Install dependencies

```bash
cd "$REPO" && npm install
```

Report success/failure. `tsx` and `typescript` are devDependencies, so after this `npx tsx src/index.ts` resolves locally. No build step is required (the server runs via `tsx`).

---

## Phase 3 — Detect the device & collect per-machine values

This is the interactive heart of the skill. Auto-detect what you can, then **ask the user** to confirm/fill the rest. Use `AskUserQuestion` for discrete choices (platform, which device) and a plain text prompt for free-form paths (offer the detected default; blank = skip an optional one).

### 3.1 Platform

Ask via `AskUserQuestion`: **iOS** (default) or **Android**. Store as `PLATFORM`.

### 3.2 Device UDID

**iOS** — list real devices and booted simulators:
```bash
echo "== Physical / paired devices & simulators =="
xcrun xctrace list devices 2>/dev/null
echo "== Booted simulators only =="
xcrun simctl list devices booted 2>/dev/null | grep -i booted
# libimobiledevice (physical only), if installed:
idevice_id -l 2>/dev/null
```
Physical devices show a UDID like `00008101-000238222EA3A01E` (dashed) — that's the value for `APPIUM_UDID`. If several devices appear, use `AskUserQuestion` to let the user pick which one; put the chosen UDID in the option label.

**Android** — `adb devices -l`; the serial is the UDID.

If no device is detected, that's fine for config-only — ask the user to type the UDID, or leave it blank and note they must set `APPIUM_UDID` before connecting.

### 3.3 Appium URL & bundle id

- `APPIUM_URL` — default `http://127.0.0.1:4723` (confirm, rarely changed).
- `APPIUM_BUNDLE_ID` — default `com.example.app` (iOS). For Android also collect `APPIUM_APP_PACKAGE` / `APPIUM_APP_ACTIVITY`.

### 3.4 Source-repo paths (all optional — blank to skip)

For each, offer a detected default by probing common locations, then ask. If the user skips, **omit the key** so the server falls back to defaults / disables that source-aware feature.

| Env var | What it points at | Probe hint |
|---|---|---|
| `FLUTTER_APP_PATH` | Flutter app source (source-aware locators/diagnostics) | the directory that contains `pubspec.yaml` and `lib/` |
| `FLUTTER_COMPONENTS_PATH` | shared Flutter component packages | `~/projects/flutter-components` |
| `AUTOMATION_PROJECT_PATH` | the `zenappautomation` reactor root (for export/test tools) | `~/projects/zenappautomation` |
| `CUA_TESTCASES_DIR` | directory of CUA markdown test cases | a folder of `*.cua.md` files |

Probe example:
```bash
for p in "$FLUTTER_APP_PATH" "$FLUTTER_COMPONENTS_PATH" "$AUTOMATION_PROJECT_PATH" "$CUA_TESTCASES_DIR"; do
  [ -d "$p" ] && echo "FOUND $p" || echo "absent $p"
done
```
Only offer a path as a default if it actually exists. Never invent a path the user didn't confirm.

### 3.5 Reset flags (sensible defaults, no need to ask unless the user cares)

`APPIUM_NO_RESET=true`, `APPIUM_FULL_RESET=false`, `APPIUM_SHOULD_TERMINATE_APP=false`.

---

## Phase 4 — Write the repo `.env` (standalone use)

For `npm start` / CLI runs from inside the repo, write `.env` from the collected values (it's gitignored). Start from the template so unset optional vars stay documented:

```bash
[ -f "$REPO/.env" ] && cp "$REPO/.env" "$REPO/.env.bak.$(date +%s)" && echo "backed up existing .env"
cp "$REPO/.env.example" "$REPO/.env"
```
Then edit `.env` to set the collected values (`PLATFORM`, `APPIUM_URL`, `APPIUM_UDID`, `APPIUM_BUNDLE_ID`, the reset flags, and any source paths the user provided). Leave skipped optionals commented as in the template.

> `.env` is a convenience for standalone runs. It is **not** what Claude Code reads — Phase 5 is.

---

## Phase 5 — Register the MCP (Cursor and/or Claude Code)

**Cursor (default):** merge into `~/.cursor/mcp.json` → `mcpServers.appium-flutter-mcp` so it works in any workspace.

**Claude Code:** same shape under `~/.claude.json`.

Fast path (after `.env` exists):

```bash
cd "$REPO" && npm run setup -- --target=both --skip-install
```

If you need to write the JSON by hand:

**Always back up first**, then merge — never overwrite the file (it holds the user's other MCP servers and per-project state).

Build the env object from Phase 3 (omit any key the user skipped), then run this merge. Fill the `ENV` dict with the collected values:

```bash
python3 - "$REPO" <<'PY'
import json, os, sys, time
repo = sys.argv[1]
cfg_path = os.path.expanduser("~/.claude.json")

# ---- collected values: EDIT this dict to match Phase 3; drop keys the user skipped ----
ENV = {
    "APPIUM_URL": "http://127.0.0.1:4723",
    "PLATFORM": "ios",
    "APPIUM_UDID": "<FROM_PHASE_3>",
    "APPIUM_BUNDLE_ID": "com.example.app",
    "APPIUM_NO_RESET": "true",
    "APPIUM_FULL_RESET": "false",
    "APPIUM_SHOULD_TERMINATE_APP": "false",
    # optional — include only if the user provided them:
    # "FLUTTER_APP_PATH": "...",
    # "FLUTTER_COMPONENTS_PATH": "...",
    # "AUTOMATION_PROJECT_PATH": "...",
    # "CUA_TESTCASES_DIR": "...",
}
# -----------------------------------------------------------------------------------------

with open(cfg_path) as f:
    data = json.load(f)

# backup before writing
bak = f"{cfg_path}.bak.{int(time.time())}"
with open(bak, "w") as f:
    json.dump(data, f, indent=2)

data.setdefault("mcpServers", {})
data["mcpServers"]["appium-flutter-mcp"] = {
    "command": "npx",
    "args": ["tsx", os.path.join(repo, "src", "index.ts")],
    "env": ENV,
}

with open(cfg_path, "w") as f:
    json.dump(data, f, indent=2)

print(f"backup:   {bak}")
print("registered mcpServers.appium-flutter-mcp with keys:", ", ".join(ENV))
PY
```

Notes:
- `command`/`args` mirror the working registration: `npx tsx <repo>/src/index.ts`.
- If `~/.claude.json` doesn't exist yet (rare — Claude Code creates it), create a minimal `{"mcpServers": {}}` first, then merge.
- Alternative (equivalent) native path if the user prefers the CLI: `claude mcp add -s user appium-flutter-mcp --env KEY=VAL ... -- npx tsx "$REPO/src/index.ts"`. The python merge above is preferred for predictable env handling and the automatic backup.

---

## Phase 6 — Verify & final report

1. Confirm the block landed:
   ```bash
   python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.claude.json')));print(json.dumps(d['mcpServers']['appium-flutter-mcp'],indent=2))"
   ```
2. **Restart required.** MCP servers load at client startup — tell the user to **fully restart Cursor** and/or Claude Code.
3. After restart, they can sanity-check with the MCP's `get_status` tool (needs an Appium server running + device reachable to fully connect). For Cursor: **Settings → MCP** should list `appium-flutter-mcp`.

Print a summary:
- Node/Appium/driver/device check results (from Phase 1)
- `npm install` result
- Which env vars were set vs skipped
- The `~/.claude.json` backup path
- Reminder to start Appium (`appium --port 4723`) and restart Claude Code before first use

---

## Reference — env vars this MCP reads

Required-ish for a working connection:

| Var | Default | Notes |
|---|---|---|
| `APPIUM_URL` | `http://127.0.0.1:4723` | Appium server endpoint |
| `PLATFORM` | `ios` | `ios` or `android` |
| `APPIUM_UDID` | — | device/simulator id; required to connect to a specific device |
| `APPIUM_BUNDLE_ID` | `com.example.app` | iOS bundle id (Android: `APPIUM_APP_PACKAGE` + `APPIUM_APP_ACTIVITY`) |

Reset behavior: `APPIUM_NO_RESET`, `APPIUM_FULL_RESET`, `APPIUM_SHOULD_TERMINATE_APP`.

Source-aware / optional: `FLUTTER_APP_PATH`, `FLUTTER_COMPONENTS_PATH`, `AUTOMATION_PROJECT_PATH`, `CUA_TESTCASES_DIR`, `TESTCASES_PATH`, `ZMA_CONFIG_PATH`.

Tuning (leave at defaults unless asked): `FLUTTER_SERVER_LAUNCH_TIMEOUT`, `FLUTTER_SYSTEM_PORT`, `FLUTTER_ELEMENT_WAIT_TIMEOUT`, `FLUTTER_SCROLL_MAX_ITERATION`, `FLUTTER_SCROLL_DELTA`, `WEBVIEW_CONNECT_TIMEOUT`, `WEBVIEW_CONNECT_RETRIES`, `TREE_CACHE_TTL_MS`, `SCREENSHOT_ON_ACTION`, `LOG_LEVEL`, `VM_SERVICE_URL`, `VM_AUTO_DISCOVER`.

The authoritative list lives in `src/util/config.ts`.

## Not this skill's job

- **Configuring the Flutter app for Appium** (launcher files, Podfile/Info.plist, StandAlone flag, WebView inspectability) — that's the separate `appium-setup` skill.
- **Running the test pipeline** — that's `run_full_pipeline` (see the repo `CLAUDE.md`).
- Installing Appium/drivers/Node/Xcode or cloning source repos — report only.

## Safety

- Always back up `~/.claude.json` before writing (Phase 5 does this automatically).
- Merge, never overwrite — preserve the user's other `mcpServers` and `projects`.
- Never commit `.env` (gitignored) or any machine-specific absolute paths.

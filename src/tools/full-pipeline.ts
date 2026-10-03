/**
 * run_full_pipeline — end-to-end test pipeline:
 *   1. preflight   — verify repos, branch, device, port
 *   2. checkout    — git switch all 3 source repos to the target branch
 *   3. deps        — flutter pub get
 *   4. build_install — flutter run --release (detach after launch)
 *   5. appium_up   — spawn Appium server
 *   6. run_tests   — mvn clean test
 *   7. teardown    — kill procs, pop stashes, write report
 */

import { z } from 'zod';
import { execSync } from 'child_process';
import {
  existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync,
} from 'fs';
import { join } from 'path';
import { spawnLogged, type SpawnHandle } from '../util/process.js';
import { runMavenSuite } from './debug-loop.js';
import type { TestRunResult } from '../debug/types.js';
import { logger } from '../util/logger.js';
import type { McpToolResponse } from '../types.js';

// ── Defaults derived from env vars ───────────────────────────────────────────

const DEFAULT_FLUTTER_APP_PATH = process.env.FLUTTER_APP_PATH || '';

const DEFAULT_AUTOMATION_PATH = process.env.AUTOMATION_PROJECT_PATH || '';

const DEFAULT_SOURCE_REPOS = [process.env.FLUTTER_APP_PATH, process.env.FLUTTER_COMPONENTS_PATH]
  .filter((p): p is string => !!p);

// ── Schema ───────────────────────────────────────────────────────────────────

export const runFullPipelineSchema = z.object({
  branch: z.string().default('ajmal/appium-local-qaready').describe(
    'Branch to checkout in all source repos (e.g. ajmal/appium-local-qaready)',
  ),
  repos: z.array(z.string()).optional().describe(
    'Override the source repo paths (default: FLUTTER_APP_PATH and FLUTTER_COMPONENTS_PATH)',
  ),
  automationProjectPath: z.string().optional().describe(
    'Path to the automation project (default: AUTOMATION_PROJECT_PATH)',
  ),
  flutterAppPath: z.string().optional().describe(
    'Path to the Flutter app (default: FLUTTER_APP_PATH env)',
  ),
  target: z.enum(['device', 'simulator']).default('device').describe(
    '"device" = physical iOS device (auto-detected via flutter devices). ' +
    '"simulator" = iOS simulator (uses APPIUM_UDID env var or auto-detects first running simulator).',
  ),
  deviceId: z.string().optional().describe(
    'Override UDID for either target. When omitted: physical device is auto-detected; ' +
    'simulator UDID is read from APPIUM_UDID env var first.',
  ),
  suiteXmlFile: z.string().default('testng.xml').describe(
    'TestNG suite XML filename relative to automationProjectPath (default: testng.xml)',
  ),
  appiumPort: z.number().default(4723).describe('Appium server port (default: 4723)'),
  skipCheckout: z.boolean().default(false).describe(
    'Skip repo checkout — useful for re-running tests on already-switched branches',
  ),
  skipBuild: z.boolean().default(false).describe(
    'Skip Flutter build/install — useful when app is already installed on device',
  ),
  force: z.boolean().default(false).describe(
    'Stash dirty working trees instead of refusing. Stashes are restored in teardown.',
  ),
  keepAppiumRunning: z.boolean().default(false).describe(
    'Leave Appium server running after tests (useful for debugging)',
  ),
  timeoutMs: z.number().default(1_800_000).describe(
    'Total pipeline wall-clock budget in ms (default: 30 min)',
  ),
});

// ── Types ─────────────────────────────────────────────────────────────────────

interface PhaseResult {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  durationMs: number;
  message: string;
  logFile: string;
}

interface PipelineState {
  runId: string;
  runsDir: string;
  branch: string;
  deviceId: string;
  flutterHandle: SpawnHandle | null;
  appiumHandle: SpawnHandle | null;
  appiumExternal: boolean;
  stashedRepos: string[];
  phases: PhaseResult[];
  testResults: TestRunResult | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString();
}

function appendLog(logPath: string, msg: string): void {
  appendFileSync(logPath, `[${ts()}] ${msg}\n`);
}

function execLog(cmd: string, cwd: string, logPath: string, timeoutMs = 120_000): string {
  appendLog(logPath, `$ ${cmd}`);
  try {
    const out = execSync(cmd, {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs,
    });
    if (out) appendFileSync(logPath, out);
    return out;
  } catch (e: any) {
    const msg = (e.stdout || '') + (e.stderr ? `\nSTDERR: ${e.stderr}` : '') || String(e);
    appendFileSync(logPath, msg + '\n');
    throw new Error(msg.trim() || String(e));
  }
}

async function runPhase(
  name: string,
  logPath: string,
  state: PipelineState,
  fn: () => Promise<string>,
): Promise<boolean> {
  const start = Date.now();
  appendLog(logPath, `=== Phase: ${name} ===`);
  try {
    const msg = await fn();
    state.phases.push({ name, status: 'pass', durationMs: Date.now() - start, message: msg, logFile: logPath });
    return true;
  } catch (e: any) {
    const msg = String(e.message ?? e);
    appendLog(logPath, `FAILED: ${msg}`);
    state.phases.push({ name, status: 'fail', durationMs: Date.now() - start, message: msg, logFile: logPath });
    return false;
  }
}

// ── Phase implementations ─────────────────────────────────────────────────────

async function phasePreflight(
  params: z.infer<typeof runFullPipelineSchema>,
  repos: string[],
  flutterAppPath: string,
  state: PipelineState,
  logPath: string,
): Promise<void> {
  // 1. Verify each repo path is a git dir
  for (const repo of repos) {
    if (!existsSync(join(repo, '.git'))) {
      throw new Error(`Not a git repository: ${repo}`);
    }
    appendLog(logPath, `✓ repo exists: ${repo}`);
  }

  // 2. Verify appium_launcher.dart
  const launcherPath = join(flutterAppPath, 'appium_launcher.dart');
  if (!existsSync(launcherPath)) {
    throw new Error(`appium_launcher.dart not found at ${launcherPath}`);
  }
  appendLog(logPath, `✓ appium_launcher.dart found`);

  // 3. Verify branch exists in each repo (skip if skipCheckout)
  if (!params.skipCheckout) {
    for (const repo of repos) {
      const remote = execLog(
        `git ls-remote --heads origin ${params.branch}`, repo, logPath,
      ).trim();
      const local = (() => {
        try {
          execLog(`git rev-parse --verify ${params.branch}`, repo, logPath);
          return true;
        } catch { return false; }
      })();
      if (!remote && !local) {
        throw new Error(`Branch '${params.branch}' not found on origin or locally in ${repo}`);
      }
      appendLog(logPath, `✓ branch '${params.branch}' reachable in ${repo}`);
    }
  }

  // 4. Resolve device ID
  if (!params.skipBuild) {
    if (params.deviceId) {
      state.deviceId = params.deviceId;
      appendLog(logPath, `✓ using supplied deviceId: ${state.deviceId} (target: ${params.target})`);
    } else if (params.target === 'simulator') {
      // Prefer APPIUM_UDID from env (the MCP config already has the simulator UUID)
      const envUdid = process.env.APPIUM_UDID;
      if (envUdid) {
        state.deviceId = envUdid;
        const envName = process.env.APPIUM_DEVICE_NAME || 'simulator';
        appendLog(logPath, `✓ simulator UDID from env: ${state.deviceId} (${envName})`);
      } else {
        // Fall back to flutter devices — pick first running iOS simulator
        appendLog(logPath, `$ flutter devices --machine (simulator lookup)`);
        let devicesOut = '';
        try {
          devicesOut = execSync('flutter devices --machine', {
            cwd: flutterAppPath, encoding: 'utf-8', timeout: 30_000,
          });
        } catch (e: any) { devicesOut = (e as any).stdout || ''; }
        appendFileSync(logPath, devicesOut + '\n');
        const devices: Array<{ id: string; targetPlatform?: string; emulator?: boolean; name?: string }> =
          JSON.parse(devicesOut || '[]');
        const sim = devices.find((d) => d.targetPlatform?.startsWith('ios') && d.emulator === true);
        if (!sim) {
          throw new Error(
            'No running iOS simulator found. Open Xcode → Simulator, boot a device, and retry. ' +
            `Detected: ${devices.map((d) => `${d.id}(${d.targetPlatform})`).join(', ') || 'none'}`,
          );
        }
        state.deviceId = sim.id;
        appendLog(logPath, `✓ auto-detected simulator: ${sim.id} (${sim.name ?? ''})`);
      }
    } else {
      // Physical device auto-detection
      appendLog(logPath, `$ flutter devices --machine (physical device lookup)`);
      let devicesOut = '';
      try {
        devicesOut = execSync('flutter devices --machine', {
          cwd: flutterAppPath, encoding: 'utf-8', timeout: 30_000,
        });
      } catch (e: any) { devicesOut = (e as any).stdout || ''; }
      appendFileSync(logPath, devicesOut + '\n');
      const devices: Array<{ id: string; targetPlatform?: string; emulator?: boolean }> =
        JSON.parse(devicesOut || '[]');
      const iosDevice = devices.find(
        (d) => d.targetPlatform?.startsWith('ios') && d.emulator === false,
      );
      if (!iosDevice) {
        throw new Error(
          'No physical iOS device found. Connect a device, unlock it, and trust this computer. ' +
          `Detected: ${devices.map((d) => `${d.id}(${d.targetPlatform})`).join(', ') || 'none'}`,
        );
      }
      state.deviceId = iosDevice.id;
      appendLog(logPath, `✓ auto-detected physical device: ${state.deviceId}`);
    }
  }

  // 5. Check Appium port
  const port = params.appiumPort;
  let portBusy = false;
  try {
    execLog(`lsof -iTCP:${port} -sTCP:LISTEN`, process.cwd(), logPath);
    portBusy = true;
  } catch { /* nothing listening */ }

  if (portBusy) {
    // Port is taken — check if it's a healthy Appium instance we can reuse
    try {
      execLog(`curl -sf http://127.0.0.1:${port}/status`, process.cwd(), logPath);
      state.appiumExternal = true;
      appendLog(logPath, `✓ port ${port} has a running Appium — will reuse`);
    } catch {
      throw new Error(
        `Port ${port} is in use by a non-Appium process. Free the port or pass a different appiumPort.`,
      );
    }
  }
}

async function phaseCheckout(
  branch: string,
  repos: string[],
  force: boolean,
  state: PipelineState,
  logPath: string,
): Promise<void> {
  for (const repo of repos) {
    appendLog(logPath, `\n--- ${repo} ---`);

    // Check dirty
    const dirty = execLog('git status --porcelain', repo, logPath).trim();
    if (dirty) {
      if (!force) {
        throw new Error(
          `Working tree is dirty in ${repo}. Commit or pass force=true to stash.\nDirty files:\n${dirty}`,
        );
      }
      execLog(`git stash push -u -m "mcp-pipeline-${state.runId}"`, repo, logPath);
      state.stashedRepos.push(repo);
      appendLog(logPath, `  stashed dirty tree`);
    }

    execLog('git fetch origin', repo, logPath);

    // Check if local branch exists
    let localExists = false;
    try {
      execLog(`git rev-parse --verify ${branch}`, repo, logPath);
      localExists = true;
    } catch { /* not local yet */ }

    if (localExists) {
      execLog(`git checkout ${branch}`, repo, logPath);
    } else {
      execLog(`git checkout -b ${branch} origin/${branch}`, repo, logPath);
    }

    execLog(`git pull --ff-only origin ${branch}`, repo, logPath);
    appendLog(logPath, `  ✓ on ${branch}`);
  }
}

async function phaseDeps(
  flutterAppPath: string,
  logPath: string,
): Promise<void> {
  appendLog(logPath, `$ flutter clean (${flutterAppPath})`);
  execLog('flutter clean', flutterAppPath, logPath, 120_000);
  appendLog(logPath, '✓ flutter clean done');

  appendLog(logPath, `$ flutter pub upgrade`);
  execLog('flutter pub upgrade', flutterAppPath, logPath, 600_000);
  appendLog(logPath, '✓ flutter pub upgrade done');
}

const RUNNER_TARGET_BLOCK = `target 'Runner' do
use_frameworks! :linkage => :static

flutter_install_all_ios_pods File.dirname(File.realpath(__FILE__))

pod 'FlutterPluginRegistrant', :path => File.join('Flutter', 'FlutterPluginRegistrant'), :inhibit_warnings => true
end

post_install do |installer|
installer.pods_project.targets.each do |target|
flutter_additional_ios_build_settings(target)
end
end`;

const INFO_PLIST_CONTENT = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
   <key>CFBundleDevelopmentRegion</key>
   <string>$(DEVELOPMENT_LANGUAGE)</string>
   <key>CFBundleExecutable</key>
   <string>$(EXECUTABLE_NAME)</string>
   <key>CFBundleIdentifier</key>
   <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
   <key>CFBundleInfoDictionaryVersion</key>
   <string>6.0</string>
   <key>CFBundleName</key>
   <string>$(PRODUCT_NAME)</string>
   <key>CFBundleDisplayName</key>
   <string>$(PRODUCT_NAME)</string>
   <key>CFBundlePackageType</key>
   <string>APPL</string>
   <key>CFBundleShortVersionString</key>
   <string>$(FLUTTER_BUILD_NAME)</string>
   <key>CFBundleSignature</key>
   <string>????</string>
   <key>CFBundleVersion</key>
   <string>$(FLUTTER_BUILD_NUMBER)</string>
   <key>LSRequiresIPhoneOS</key>
   <true/>
   <key>UILaunchStoryboardName</key>
   <string>LaunchScreen</string>
   <key>UIMainStoryboardFile</key>
   <string>Main</string>
   <key>UISupportedInterfaceOrientations</key>
   <array>
       <string>UIInterfaceOrientationPortrait</string>
       <string>UIInterfaceOrientationLandscapeLeft</string>
       <string>UIInterfaceOrientationLandscapeRight</string>
   </array>
   <key>UISupportedInterfaceOrientations~ipad</key>
   <array>
       <string>UIInterfaceOrientationPortrait</string>
       <string>UIInterfaceOrientationPortraitUpsideDown</string>
       <string>UIInterfaceOrientationLandscapeLeft</string>
       <string>UIInterfaceOrientationLandscapeRight</string>
   </array>
   <key>CADisableMinimumFrameDurationOnPhone</key>
   <true/>
   <key>UIApplicationSupportsIndirectInputEvents</key>
   <true/>
   <key>NSCameraUsageDescription</key>
   <string>Please provide access to upload picture</string>
   <key>NSAppTransportSecurity</key>
   <dict>
       <key>NSAllowsArbitraryLoads</key>
       <true/>
   </dict>
   <key>WebKitDebuggingEnabled</key>
   <true/>
   <key>NSPhotoLibraryAddUsageDescription</key>
   <string>Allow location access to get your current location</string>
   <key>NSMicrophoneUsageDescription</key>
   <string>Microphone access is required in order to connect to supported card readers and also for calls</string>
</dict>
</plist>`;

async function phaseIosSetup(
  flutterAppPath: string,
  logPath: string,
): Promise<void> {
  const iosDir = join(flutterAppPath, 'ios');

  // 1. Patch Podfile — update iOS platform + replace Runner target block
  const podfilePath = join(iosDir, 'Podfile');
  if (!existsSync(podfilePath)) {
    throw new Error(`Podfile not found at ${podfilePath}`);
  }
  let podfile = readFileSync(podfilePath, 'utf-8');

  // Replace platform line (e.g. "platform :ios, '13.0'" → '14.0')
  const platformBefore = podfile.match(/^platform :ios, '.+'/m)?.[0] ?? 'not found';
  podfile = podfile.replace(/^platform :ios, '.+'/m, "platform :ios, '14.0'");
  appendLog(logPath, `  platform: ${platformBefore} → platform :ios, '14.0'`);

  // Replace everything from "target 'Runner' do" to end of file
  if (/target 'Runner' do/.test(podfile)) {
    podfile = podfile.replace(/target 'Runner' do[\s\S]*/, RUNNER_TARGET_BLOCK);
    appendLog(logPath, `  replaced Runner target block`);
  } else {
    // Append if block not present
    podfile = `${podfile.trimEnd()}\n\n${RUNNER_TARGET_BLOCK}\n`;
    appendLog(logPath, `  Runner target block appended (was missing)`);
  }

  writeFileSync(podfilePath, podfile, 'utf-8');
  appendLog(logPath, '✓ Podfile patched');

  // 2. Replace Info.plist
  const plistPath = join(iosDir, 'Runner', 'Info.plist');
  if (!existsSync(join(iosDir, 'Runner'))) {
    throw new Error(`ios/Runner/ directory not found under ${flutterAppPath}`);
  }
  writeFileSync(plistPath, INFO_PLIST_CONTENT, 'utf-8');
  appendLog(logPath, '✓ Info.plist replaced');
}

async function phaseBuildInstall(
  flutterAppPath: string,
  deviceId: string,
  logPath: string,
  state: PipelineState,
): Promise<void> {
  appendLog(logPath, `$ flutter run --release -t appium_launcher.dart -d ${deviceId}`);
  appendLog(logPath, '  Waiting for "Flutter run key commands" marker (~5-15 min)…');

  const handle = await spawnLogged(
    'flutter',
    ['run', '--release', '-t', 'appium_launcher.dart', '-d', deviceId],
    flutterAppPath,
    logPath,
    {
      waitForPattern: /Flutter run key commands/,
      timeoutMs: 900_000, // 15 min for release build on first run
    },
  );

  state.flutterHandle = handle;

  // Press 'd' to detach — app stays installed and running, flutter run process exits
  handle.sendInput('d\n');
  appendLog(logPath, '✓ sent detach (d) — app stays on device, flutter run exiting');

  // Give it a moment to detach cleanly
  await new Promise((r) => setTimeout(r, 3_000));
}

async function phaseAppiumUp(
  appiumPort: number,
  logPath: string,
  state: PipelineState,
): Promise<void> {
  if (state.appiumExternal) {
    appendLog(logPath, `✓ reusing external Appium on port ${appiumPort}`);
    return;
  }

  // Find appium binary
  let appiumBin = 'appium';
  try {
    appiumBin = execSync('which appium', { encoding: 'utf-8' }).trim();
  } catch {
    throw new Error('`appium` not found in PATH. Install with: npm install -g appium');
  }

  appendLog(logPath, `$ ${appiumBin} --log-level info --port ${appiumPort}`);
  appendLog(logPath, '  Waiting for "listener started" message…');

  const handle = await spawnLogged(
    appiumBin,
    ['--log-level', 'info', '--port', String(appiumPort)],
    process.cwd(),
    logPath,
    {
      waitForPattern: /listener started/i,
      timeoutMs: 30_000,
    },
  );

  state.appiumHandle = handle;
  appendLog(logPath, `✓ Appium running on port ${appiumPort} (pid ${handle.pid})`);
}

async function phaseRunTests(
  automationProjectPath: string,
  suiteXmlFile: string,
  logPath: string,
  platform?: string,
): Promise<{ results: TestRunResult }> {
  appendLog(logPath, `$ mvn clean test (suite: ${suiteXmlFile}${platform ? `, platform: ${platform}` : ''})`);
  appendLog(logPath, `  project: ${automationProjectPath}`);

  const { output, results } = await runMavenSuite({ projectPath: automationProjectPath, suiteXmlFile, platform });
  writeFileSync(logPath + '.mvn-output.txt', output);
  appendLog(logPath, `Tests: ${results.totalTests} | Passed: ${results.passed} | Failed: ${results.failed} | Skipped: ${results.skipped}`);
  appendLog(logPath, `Duration: ${results.durationMs}ms`);

  if (results.failed > 0) {
    const failNames = results.failureReports.map((r: any) => r.testMethod).join(', ');
    throw new Error(`${results.failed} test(s) failed: ${failNames}`);
  }

  return { results };
}

async function phaseTeardown(
  state: PipelineState,
  keepAppiumRunning: boolean,
  logPath: string,
): Promise<void> {
  // Kill flutter run (if still alive)
  if (state.flutterHandle) {
    try {
      state.flutterHandle.kill();
      appendLog(logPath, `killed flutter run pid ${state.flutterHandle.pid}`);
    } catch { /* already gone */ }
  }

  // Kill Appium (unless external or keepRunning)
  if (state.appiumHandle && !keepAppiumRunning) {
    try {
      state.appiumHandle.kill();
      appendLog(logPath, `killed Appium pid ${state.appiumHandle.pid}`);
    } catch { /* already gone */ }
  } else if (state.appiumHandle && keepAppiumRunning) {
    appendLog(logPath, `Appium left running (pid ${state.appiumHandle.pid}) — keepAppiumRunning=true`);
  }

  // Restore stashes (in reverse order)
  for (const repo of [...state.stashedRepos].reverse()) {
    try {
      execLog('git stash pop', repo, logPath);
      appendLog(logPath, `restored stash in ${repo}`);
    } catch (e) {
      appendLog(logPath, `WARNING: could not restore stash in ${repo}: ${e}`);
    }
  }
}

// ── Report generation ──────────────────────────────────────────────────────────

function buildReport(
  state: PipelineState,
  verdict: 'pass' | 'fail' | 'abort',
  testResults: TestRunResult | null,
  extentReportPath: string | null,
  totalMs: number,
): { json: string; html: string } {
  const report = {
    runId: state.runId,
    branch: state.branch,
    verdict,
    totalDurationMs: totalMs,
    phases: state.phases,
    testSummary: testResults
      ? {
          total: testResults.totalTests,
          passed: testResults.passed,
          failed: testResults.failed,
          skipped: testResults.skipped,
          durationMs: testResults.durationMs,
        }
      : null,
    extentReportPath,
  };

  const statusIcon = (s: string) => s === 'pass' ? '✅' : s === 'fail' ? '❌' : '⏭️';
  const verdictBg = verdict === 'pass' ? '#2e7d32' : verdict === 'fail' ? '#c62828' : '#e65100';

  const phaseRows = state.phases.map((p) => `
    <tr>
      <td>${statusIcon(p.status)} ${p.name}</td>
      <td style="color:${p.status === 'pass' ? '#2e7d32' : '#c62828'}">${p.status.toUpperCase()}</td>
      <td>${(p.durationMs / 1000).toFixed(1)}s</td>
      <td>${escHtml(p.message)}</td>
      <td><a href="${p.logFile}">log</a></td>
    </tr>`).join('');

  const testSummaryHtml = testResults
    ? `<h2>Test Summary</h2>
       <p>
         Total: <b>${testResults.totalTests}</b> &nbsp;
         Passed: <b style="color:#2e7d32">${testResults.passed}</b> &nbsp;
         Failed: <b style="color:#c62828">${testResults.failed}</b> &nbsp;
         Skipped: <b style="color:#888">${testResults.skipped}</b>
       </p>
       ${extentReportPath ? `<p><a href="${extentReportPath}">📊 Open Extent Report</a></p>` : ''}`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Pipeline ${state.runId}</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#222}
  h1 small{font-size:.6em;color:#666}
  .badge{display:inline-block;padding:.3rem .8rem;border-radius:4px;color:#fff;font-weight:bold}
  table{width:100%;border-collapse:collapse;margin:1rem 0}
  th,td{padding:.6rem .8rem;text-align:left;border:1px solid #ddd}
  th{background:#f5f5f5}
  a{color:#1565c0}
</style>
</head>
<body>
<h1>Pipeline <small>${escHtml(state.runId)}</small></h1>
<p>
  Branch: <code>${escHtml(state.branch)}</code> &nbsp;
  Duration: <b>${(totalMs / 1000).toFixed(1)}s</b> &nbsp;
  <span class="badge" style="background:${verdictBg}">${verdict.toUpperCase()}</span>
</p>
<h2>Phases</h2>
<table>
  <thead><tr><th>Phase</th><th>Status</th><th>Duration</th><th>Message</th><th>Log</th></tr></thead>
  <tbody>${phaseRows}</tbody>
</table>
${testSummaryHtml}
</body>
</html>`;

  return { json: JSON.stringify(report, null, 2), html };
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function handleRunFullPipeline(
  params: z.infer<typeof runFullPipelineSchema>,
): Promise<McpToolResponse> {
  const startMs = Date.now();
  const runId = `pipeline-${startMs}`;
  const runsDir = join(process.cwd(), 'runs', 'pipeline', runId);
  mkdirSync(runsDir, { recursive: true });

  const flutterAppPath = params.flutterAppPath || DEFAULT_FLUTTER_APP_PATH;
  const automationProjectPath = params.automationProjectPath || DEFAULT_AUTOMATION_PATH;
  const repos = params.repos || DEFAULT_SOURCE_REPOS;

  const logs = {
    preflight: join(runsDir, 'preflight.log'),
    checkout: join(runsDir, 'checkout.log'),
    pub: join(runsDir, 'pub.log'),
    ios_setup: join(runsDir, 'ios_setup.log'),
    flutter: join(runsDir, 'flutter.log'),
    appium: join(runsDir, 'appium.log'),
    mvn: join(runsDir, 'mvn.log'),
    teardown: join(runsDir, 'teardown.log'),
  };

  const state: PipelineState = {
    runId,
    runsDir,
    branch: params.branch,
    deviceId: params.deviceId || '',
    flutterHandle: null,
    appiumHandle: null,
    appiumExternal: false,
    stashedRepos: [],
    phases: [],
    testResults: null,
  };

  logger.info('run_full_pipeline started', { runId, branch: params.branch });

  let verdict: 'pass' | 'fail' | 'abort' = 'pass';

  // ── Phase 1: preflight ──────────────────────────────────────────────────────
  const preflightOk = await runPhase('preflight', logs.preflight, state, () =>
    phasePreflight(params, repos, flutterAppPath, state, logs.preflight).then(() => 'preflight passed'),
  );
  if (!preflightOk) { verdict = 'abort'; }

  // ── Phase 2: checkout ───────────────────────────────────────────────────────
  if (verdict === 'pass' && !params.skipCheckout) {
    const ok = await runPhase('checkout', logs.checkout, state, () =>
      phaseCheckout(params.branch, repos, params.force, state, logs.checkout).then(
        () => `switched ${repos.length} repos to ${params.branch}`,
      ),
    );
    if (!ok) verdict = 'abort';
  } else if (params.skipCheckout) {
    state.phases.push({ name: 'checkout', status: 'skip', durationMs: 0, message: 'skipCheckout=true', logFile: logs.checkout });
  }

  // ── Phase 3: deps ───────────────────────────────────────────────────────────
  if (verdict === 'pass') {
    const ok = await runPhase('deps', logs.pub, state, () =>
      phaseDeps(flutterAppPath, logs.pub).then(() => 'flutter pub get succeeded'),
    );
    if (!ok) verdict = 'abort';
  }

  // ── Phase 4: ios_setup ────────────────────────────────────────────────────
  // Patch Podfile (platform 14.0 + Runner target block) and replace Info.plist.
  // Skipped when skipBuild=true — setup only matters before a fresh build.
  if (verdict === 'pass' && !params.skipBuild) {
    const ok = await runPhase('ios_setup', logs.ios_setup, state, () =>
      phaseIosSetup(flutterAppPath, logs.ios_setup).then(
        () => 'Podfile patched + Info.plist replaced',
      ),
    );
    if (!ok) verdict = 'abort';
  } else if (params.skipBuild) {
    state.phases.push({ name: 'ios_setup', status: 'skip', durationMs: 0, message: 'skipBuild=true', logFile: logs.ios_setup });
  }

  // ── Phase 5: build_install ──────────────────────────────────────────────────
  if (verdict === 'pass' && !params.skipBuild) {
    const ok = await runPhase('build_install', logs.flutter, state, () =>
      phaseBuildInstall(flutterAppPath, state.deviceId, logs.flutter, state).then(
        () => `app installed on ${state.deviceId}`,
      ),
    );
    if (!ok) verdict = 'abort';
  } else if (params.skipBuild) {
    state.phases.push({ name: 'build_install', status: 'skip', durationMs: 0, message: 'skipBuild=true', logFile: logs.flutter });
  }

  // ── Phase 6: appium_up ─────────────────────────────────────────────────────
  if (verdict === 'pass') {
    const ok = await runPhase('appium_up', logs.appium, state, () =>
      phaseAppiumUp(params.appiumPort, logs.appium, state).then(
        () => state.appiumExternal ? `reused external Appium on :${params.appiumPort}` : `Appium started on :${params.appiumPort}`,
      ),
    );
    if (!ok) verdict = 'abort';
  }

  // ── Phase 7: run_tests ─────────────────────────────────────────────────────
  if (verdict === 'pass') {
    const ok = await runPhase('run_tests', logs.mvn, state, async () => {
      // Pipeline target drives the test platform config: device → ios, simulator → ios-simulator
      const mvnPlatform = params.target === 'simulator' ? 'ios-simulator' : 'ios';
      const { results } = await phaseRunTests(automationProjectPath, params.suiteXmlFile, logs.mvn, mvnPlatform);
      state.testResults = results;
      return `${results.passed}/${results.totalTests} passed`;
    });
    if (!ok) verdict = 'fail'; // tests ran but some failed — not abort
  }

  // ── Phase 8: teardown (always) ─────────────────────────────────────────────
  await runPhase('teardown', logs.teardown, state, () =>
    phaseTeardown(state, params.keepAppiumRunning, logs.teardown).then(() => 'teardown complete'),
  );

  // ── Write report ───────────────────────────────────────────────────────────
  const extentPath = join(automationProjectPath, 'target', 'extent-reports', 'extent-report.html');
  const extentExists = existsSync(extentPath);
  const { json, html } = buildReport(
    state,
    verdict,
    state.testResults,
    extentExists ? extentPath : null,
    Date.now() - startMs,
  );
  writeFileSync(join(runsDir, 'report.json'), json, 'utf-8');
  writeFileSync(join(runsDir, 'index.html'), html, 'utf-8');

  logger.info('run_full_pipeline finished', { runId, verdict, durationMs: Date.now() - startMs });

  const passCount = state.phases.filter((p) => p.status === 'pass').length;
  const failPhase = state.phases.find((p) => p.status === 'fail');
  const tr = state.testResults;

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        runId,
        verdict,
        branch: params.branch,
        durationMs: Date.now() - startMs,
        phases: state.phases.map((p) => ({ name: p.name, status: p.status, message: p.message })),
        testSummary: tr !== null
          ? {
              total: tr.totalTests,
              passed: tr.passed,
              failed: tr.failed,
              skipped: tr.skipped,
            }
          : null,
        failedPhase: failPhase ? { name: failPhase.name, reason: failPhase.message } : null,
        report: join(runsDir, 'index.html'),
        extentReport: extentExists ? extentPath : null,
        logs: runsDir,
        summary: `${verdict.toUpperCase()} — ${passCount}/${state.phases.length} phases passed` +
          (tr !== null ? `. Tests: ${tr.passed}/${tr.totalTests} passed.` : ''),
      }, null, 2),
    }],
  };
}

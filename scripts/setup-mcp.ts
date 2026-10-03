#!/usr/bin/env npx tsx
/**
 * One-shot MCP registration for Cursor (default) and/or Claude Code.
 *
 *   npm run setup
 *   npm run setup -- --target=both
 *   npm run setup -- --target=claude
 *   npm run setup -- --skip-install
 *
 * Writes env into the MCP config (clients do not reliably inherit repo `.env`).
 * Also copies `.env.example` → `.env` if missing.
 */
import { spawnSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type Target = 'cursor' | 'claude' | 'both';

function parseArgs(argv: string[]): { target: Target; skipInstall: boolean; yes: boolean } {
  let target: Target = 'cursor';
  let skipInstall = false;
  let yes = false;
  for (const arg of argv) {
    if (arg === '--skip-install') skipInstall = true;
    else if (arg === '--yes' || arg === '-y') yes = true;
    else if (arg.startsWith('--target=')) {
      const v = arg.slice('--target='.length);
      if (v === 'cursor' || v === 'claude' || v === 'both') target = v;
      else {
        console.error(`Unknown --target=${v} (use cursor | claude | both)`);
        process.exit(1);
      }
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: npm run setup -- [--target=cursor|claude|both] [--skip-install] [--yes]`);
      process.exit(0);
    }
  }
  return { target, skipInstall, yes };
}

function upsertEnv(filePath: string, updates: Record<string, string>): void {
  let text = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  if (text.length > 0 && !text.endsWith('\n')) text += '\n';
  for (const [key, value] of Object.entries(updates)) {
    if (!value) continue;
    const line = `${key}=${value}`;
    const re = new RegExp(`^#?\\s*${key}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, line) : text + `${line}\n`;
  }
  writeFileSync(filePath, text);
}

function detectDeviceIds(): string[] {
  const adb = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const result = spawnSync(adb, ['devices'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0 || !result.stdout) return [];
  const ids: string[] = [];
  for (const line of result.stdout.split('\n').slice(1)) {
    const [serial, state] = line.trim().split(/\s+/);
    if (serial && state === 'device') ids.push(serial);
  }
  return ids;
}

async function ask(question: string, fallback = ''): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const hint = fallback ? ` [${fallback}]` : '';
    const answer = (await rl.question(`${question}${hint}: `)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

function parseDotenv(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const env: Record<string, string> = {};
  for (const raw of readFileSync(filePath, 'utf-8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) env[key] = value;
  }
  return env;
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    console.error(`Could not parse JSON: ${path}`);
    process.exit(1);
  }
}

function backup(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const bak = `${path}.bak.${Math.floor(Date.now() / 1000)}`;
  copyFileSync(path, bak);
  return bak;
}

function resolveNodeBin(): string {
  // Cursor/GUI apps do not inherit nvm PATH; bare `npx` → spawn ENOENT.
  if (process.execPath && existsSync(process.execPath)) return process.execPath;
  return 'node';
}

function mcpServerBlock(env: Record<string, string>) {
  const nodeBin = resolveNodeBin();
  const tsxCli = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const nodeDir = dirname(nodeBin);
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const pathPrefix = process.platform === 'win32'
    ? [nodeDir]
    : [nodeDir, '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const pathEnv = [...pathPrefix, env.PATH, process.env.PATH].filter(Boolean).join(pathSep);
  return {
    command: nodeBin,
    args: [tsxCli, join(repoRoot, 'src', 'index.ts')],
    env: { ...env, PATH: pathEnv },
  };
}

function mergeMcpServers(cfgPath: string, env: Record<string, string>): { backup?: string; created: boolean } {
  const created = !existsSync(cfgPath);
  mkdirSync(dirname(cfgPath), { recursive: true });
  const bak = backup(cfgPath);
  const data = created ? { mcpServers: {} } : readJson(cfgPath);
  const servers = (typeof data.mcpServers === 'object' && data.mcpServers !== null)
    ? data.mcpServers as Record<string, unknown>
    : {};
  servers['appium-flutter-mcp'] = mcpServerBlock(env);
  data.mcpServers = servers;
  writeFileSync(cfgPath, JSON.stringify(data, null, 2) + '\n');
  return { backup: bak, created };
}

function commandName(name: string): string {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function run(name: string, args: string[], inherit = false): { ok: boolean; stdout: string } {
  const result = spawnSync(commandName(name), args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  return { ok: result.status === 0, stdout: (result.stdout || '').trim() };
}

function checkNode(): void {
  const major = Number(process.versions.node.split('.')[0]);
  console.log(`== Node ==\n  ${process.version}`);
  if (!Number.isFinite(major) || major < 18) {
    console.error('Node 18 or newer is required. Install it from https://nodejs.org and run this again.');
    process.exit(1);
  }
}

function ensureAppium(): boolean {
  console.log('== Appium ==');
  const current = run('appium', ['--version']);
  if (current.ok && current.stdout) {
    console.log(`  already installed (${current.stdout.split('\n').pop()})`);
    return true;
  }
  console.log('  not found — installing with npm i -g appium@3');
  if (!run('npm', ['install', '-g', 'appium@3'], true).ok) {
    console.error('  Appium install failed. Run `npm i -g appium` yourself, then re-run npm run setup.');
    return false;
  }
  const installed = run('appium', ['--version']);
  if (installed.ok && installed.stdout) {
    console.log(`  installed (${installed.stdout.split('\n').pop()})`);
    return true;
  }
  console.error('  npm finished, but `appium` is still not on PATH. Open a new terminal or add the npm global bin directory to PATH.');
  return false;
}

function installedDriverNames(): Set<string> {
  const listed = run('appium', ['driver', 'list', '--installed', '--json']);
  const names = new Set<string>();
  try {
    const parsed = JSON.parse(listed.stdout) as Record<string, unknown>;
    for (const key of Object.keys(parsed)) names.add(key.toLowerCase());
  } catch {
    const text = listed.stdout.toLowerCase();
    for (const token of ['xcuitest', 'uiautomator2', 'flutter', 'flutter-integration']) {
      if (text.includes(token)) names.add(token);
    }
  }
  return names;
}

function hasDriver(names: Set<string>, ...needles: string[]): boolean {
  for (const name of names) {
    if (needles.some((needle) => name.includes(needle))) return true;
  }
  return false;
}

function ensureDriver(label: string, present: boolean, args: string[]): void {
  if (present) {
    console.log(`  driver ${label}: already installed`);
    return;
  }
  console.log(`  driver ${label}: installing`);
  if (!run('appium', ['driver', 'install', ...args], true).ok) {
    console.error(`  driver ${label}: install failed`);
  }
}

function ensureDrivers(platform: string): void {
  if (!run('appium', ['--version']).ok) {
    console.log('== Appium drivers ==\n  skipped — Appium is not available');
    return;
  }
  console.log('== Appium drivers ==');
  const versionLine = run('appium', ['--version']).stdout.split('\n').pop() || '';
  const major = Number(versionLine.split('.')[0]);
  if (!Number.isFinite(major) || major < 3) {
    console.error(`  Appium ${versionLine || '2.x'} is installed. The Flutter driver needs Appium 3. Upgrade with: npm i -g appium@3`);
    return;
  }
  const names = installedDriverNames();
  ensureDriver('flutter', hasDriver(names, 'flutter'), ['--source=npm', 'appium-flutter-integration-driver']);
  if (platform === 'android') {
    ensureDriver('uiautomator2', hasDriver(names, 'uiautomator2'), ['uiautomator2']);
    return;
  }
  if (process.platform === 'darwin') {
    ensureDriver('xcuitest', hasDriver(names, 'xcuitest'), ['xcuitest']);
    return;
  }
  console.log('  driver xcuitest: install this on the Mac that runs Appium (`appium driver install xcuitest`)');
}

async function collectDeviceEnv(envPath: string, env: Record<string, string>, yes: boolean): Promise<void> {
  const interactive = input.isTTY && output.isTTY && !yes;
  if (!interactive || env.APPIUM_UDID) return;

  console.log('\n== Device (saved to .env and the MCP config) ==');
  const found = detectDeviceIds();
  if (found.length > 0) console.log(`adb devices: ${found.join(', ')}`);
  else console.log('No adb device listed. For iOS, paste the UDID from Xcode or `xcrun xctrace list devices`.');

  const platform = (await ask('Platform (ios or android)', env.PLATFORM || 'ios')).toLowerCase();
  env.PLATFORM = platform === 'android' ? 'android' : 'ios';
  const udid = await ask('Device UDID or adb serial (Enter to skip)', found[0] || '');
  if (udid) env.APPIUM_UDID = udid;

  if (env.PLATFORM === 'android') {
    env.APPIUM_APP_PACKAGE = await ask('Android package', env.APPIUM_APP_PACKAGE || 'com.example.app');
    env.APPIUM_APP_ACTIVITY = await ask('Android activity', env.APPIUM_APP_ACTIVITY || 'com.example.app.MainActivity');
  } else {
    env.APPIUM_BUNDLE_ID = await ask('iOS bundle id', env.APPIUM_BUNDLE_ID || 'com.example.app');
  }

  upsertEnv(envPath, {
    PLATFORM: env.PLATFORM,
    APPIUM_UDID: env.APPIUM_UDID || '',
    APPIUM_BUNDLE_ID: env.APPIUM_BUNDLE_ID || '',
    APPIUM_APP_PACKAGE: env.APPIUM_APP_PACKAGE || '',
    APPIUM_APP_ACTIVITY: env.APPIUM_APP_ACTIVITY || '',
  });
}

async function main() {
  const { target, skipInstall, yes } = parseArgs(process.argv.slice(2));

  if (!existsSync(join(repoRoot, 'package.json'))) {
    console.error(`No package.json at ${repoRoot} — run this from the repo clone.`);
    process.exit(1);
  }

  checkNode();

  if (!skipInstall) {
    console.log('== npm install ==');
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const r = spawnSync(npmBin, ['install'], {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }

  const envPath = join(repoRoot, '.env');
  const examplePath = join(repoRoot, '.env.example');
  if (!existsSync(envPath) && existsSync(examplePath)) {
    copyFileSync(examplePath, envPath);
    console.log(`Wrote ${envPath} from .env.example`);
  } else if (existsSync(envPath)) {
    console.log(`Using existing ${envPath}`);
  }

  const env = parseDotenv(envPath);
  if (!env.APPIUM_URL) env.APPIUM_URL = 'http://127.0.0.1:4723';
  if (!env.PLATFORM) env.PLATFORM = 'ios';
  await collectDeviceEnv(envPath, env, yes);
  ensureAppium();
  ensureDrivers(env.PLATFORM || 'ios');

  const doCursor = target === 'cursor' || target === 'both';
  const doClaude = target === 'claude' || target === 'both';

  if (doCursor) {
    const cursorPath = join(homedir(), '.cursor', 'mcp.json');
    const { backup: bak, created } = mergeMcpServers(cursorPath, env);
    console.log(`== Cursor ==`);
    console.log(`  ${created ? 'created' : 'updated'} ${cursorPath}`);
    if (bak) console.log(`  backup ${bak}`);
  }

  if (doClaude) {
    const claudePath = join(homedir(), '.claude.json');
    const { backup: bak, created } = mergeMcpServers(claudePath, env);
    console.log(`== Claude Code ==`);
    console.log(`  ${created ? 'created' : 'updated'} ${claudePath}`);
    if (bak) console.log(`  backup ${bak}`);
  }

  const udidNote = env.APPIUM_UDID
    ? ''
    : `\n  Device UDID was not set. Put APPIUM_UDID in ${envPath} and run npm run setup again.\n`;

  console.log(`
Next:
  1. Restart Cursor so it loads the server (Settings → MCP should show appium-flutter-mcp).
  2. Start Appium:  appium --port 4723
  3. In chat: connect to the app (platform + Dart VM URL from flutter run).${udidNote}
Still outside this script: Xcode (iOS) or Android SDK, and a Flutter app launched with the Appium integration server.
`);
}

main();

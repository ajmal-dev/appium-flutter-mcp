import { readFileSync, existsSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// MCP clients (Cursor, Claude Code) often spawn this process with a cwd that
// is not the repo. Load `.env` from the package root first, then cwd as overlay.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: resolve(repoRoot, '.env') });
dotenv.config({ path: resolve(process.cwd(), '.env'), override: false });

export interface AppiumFlutterConfig {
  appiumUrl: string;
  platform: 'ios' | 'android';
  sessionId?: string;
  zmaConfigPath?: string;
  automationProjectPath?: string;
  testcasesPath?: string;

  // Appium capabilities (user-configurable per device)
  udid?: string;
  bundleId?: string;
  appPackage?: string;
  appActivity?: string;
  deviceName?: string;
  platformVersion?: string;
  appPath?: string;
  noReset?: boolean;
  fullReset?: boolean;
  shouldTerminateApp?: boolean;

  // Flutter driver settings
  flutterServerLaunchTimeout: number;
  flutterSystemPort: number;
  flutterElementWaitTimeout: number;
  flutterScrollMaxIteration: number;
  flutterScrollDelta: number;

  // iOS WebView discovery (matches zmauiautomation CapabilityFactory)
  webviewConnectTimeout: number;
  webviewConnectRetries: number;

  // Flutter source paths (for source-aware features)
  flutterAppPath?: string;
  flutterComponentsPath?: string;

  // VM Service settings
  vmServiceUrl?: string;
  vmAutoDiscover: boolean;

  // Bridge settings
  treeCacheTtlMs: number;
  screenshotOnAction: boolean;
  logLevel: string;
}

const defaults: AppiumFlutterConfig = {
  appiumUrl: 'http://127.0.0.1:4723',
  platform: 'ios',
  flutterServerLaunchTimeout: 10000,
  flutterSystemPort: 10001,
  flutterElementWaitTimeout: 5000,
  flutterScrollMaxIteration: 15,
  flutterScrollDelta: 64,
  webviewConnectTimeout: 30000,
  webviewConnectRetries: 5,
  vmAutoDiscover: true,
  treeCacheTtlMs: 5000,
  screenshotOnAction: true,
  logLevel: 'info',
};

export function loadConfig(overrides?: Partial<AppiumFlutterConfig>): AppiumFlutterConfig {
  const config: AppiumFlutterConfig = {
    ...defaults,
    appiumUrl: process.env.APPIUM_URL || defaults.appiumUrl,
    platform: (process.env.PLATFORM as 'ios' | 'android') || defaults.platform,
    sessionId: process.env.SESSION_ID || undefined,
    zmaConfigPath: process.env.ZMA_CONFIG_PATH || undefined,
    automationProjectPath: process.env.AUTOMATION_PROJECT_PATH || undefined,
    testcasesPath: process.env.TESTCASES_PATH || undefined,

    // Appium capabilities from env
    udid: process.env.APPIUM_UDID || undefined,
    bundleId: process.env.APPIUM_BUNDLE_ID || undefined,
    appPackage: process.env.APPIUM_APP_PACKAGE || undefined,
    appActivity: process.env.APPIUM_APP_ACTIVITY || undefined,
    deviceName: process.env.APPIUM_DEVICE_NAME || undefined,
    platformVersion: process.env.APPIUM_PLATFORM_VERSION || undefined,
    appPath: process.env.APPIUM_APP_PATH || undefined,
    noReset: process.env.APPIUM_NO_RESET !== undefined ? process.env.APPIUM_NO_RESET === 'true' : undefined,
    fullReset: process.env.APPIUM_FULL_RESET !== undefined ? process.env.APPIUM_FULL_RESET === 'true' : undefined,
    shouldTerminateApp: process.env.APPIUM_SHOULD_TERMINATE_APP !== undefined ? process.env.APPIUM_SHOULD_TERMINATE_APP === 'true' : undefined,

    flutterAppPath: process.env.FLUTTER_APP_PATH || undefined,
    flutterComponentsPath: process.env.FLUTTER_COMPONENTS_PATH || undefined,

    vmServiceUrl: process.env.VM_SERVICE_URL || undefined,
    vmAutoDiscover: process.env.VM_AUTO_DISCOVER !== 'false',

    flutterServerLaunchTimeout: num(process.env.FLUTTER_SERVER_LAUNCH_TIMEOUT, defaults.flutterServerLaunchTimeout),
    flutterSystemPort: num(process.env.FLUTTER_SYSTEM_PORT, defaults.flutterSystemPort),
    flutterElementWaitTimeout: num(process.env.FLUTTER_ELEMENT_WAIT_TIMEOUT, defaults.flutterElementWaitTimeout),
    flutterScrollMaxIteration: num(process.env.FLUTTER_SCROLL_MAX_ITERATION, defaults.flutterScrollMaxIteration),
    flutterScrollDelta: num(process.env.FLUTTER_SCROLL_DELTA, defaults.flutterScrollDelta),
    webviewConnectTimeout: num(process.env.WEBVIEW_CONNECT_TIMEOUT, defaults.webviewConnectTimeout),
    webviewConnectRetries: num(process.env.WEBVIEW_CONNECT_RETRIES, defaults.webviewConnectRetries),
    treeCacheTtlMs: num(process.env.TREE_CACHE_TTL_MS, defaults.treeCacheTtlMs),
    screenshotOnAction: process.env.SCREENSHOT_ON_ACTION !== 'false',
    logLevel: process.env.LOG_LEVEL || defaults.logLevel,
    ...overrides,
  };

  return config;
}

/** Parse ZMA .properties file (key=value format) */
export function parsePropertiesFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const content = readFileSync(filePath, 'utf-8');
  const props: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      props[trimmed.substring(0, eqIdx).trim()] = trimmed.substring(eqIdx + 1).trim();
    }
  }
  return props;
}

/** Load ZMA platform config and map to Appium capabilities */
export function loadZmaCapabilities(configPath: string, platform: string): Record<string, unknown> {
  const propsFile = join(configPath, `${platform}.properties`);
  const props = parsePropertiesFile(propsFile);
  const caps: Record<string, unknown> = {};

  // Map ZMA properties to Appium capabilities
  if (props['platform.name']) caps['platformName'] = props['platform.name'];
  if (props['platform.version']) caps['appium:platformVersion'] = props['platform.version'];
  if (props['device.name']) caps['appium:deviceName'] = props['device.name'];
  if (props['device.udid']) caps['appium:udid'] = props['device.udid'];
  if (props['app.path']) caps['appium:app'] = props['app.path'];
  if (props['app.bundleId']) caps['appium:bundleId'] = props['app.bundleId'];
  if (props['app.package']) caps['appium:appPackage'] = props['app.package'];
  if (props['app.activity']) caps['appium:appActivity'] = props['app.activity'];

  return caps;
}

/** Resolve lib/ from FLUTTER_APP_PATH (the Flutter package root). */
export function getDartSourceRoot(config: AppiumFlutterConfig): string | undefined {
  if (!config.flutterAppPath) return undefined;
  const lib = join(config.flutterAppPath, 'lib');
  return existsSync(lib) ? lib : config.flutterAppPath;
}

function num(val: string | undefined, fallback: number): number {
  if (!val) return fallback;
  const n = parseInt(val, 10);
  return isNaN(n) ? fallback : n;
}

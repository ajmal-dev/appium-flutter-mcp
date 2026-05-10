import { resolve } from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: resolve(process.cwd(), '.env') });

export interface AppiumFlutterConfig {
  appiumUrl: string;
  platform: 'ios' | 'android';
  sessionId?: string;

  // Appium capabilities (user-configurable per device)
  automationName: string;
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
  automationName: 'FlutterIntegration',
  flutterServerLaunchTimeout: 10000,
  flutterSystemPort: 10001,
  flutterElementWaitTimeout: 5000,
  flutterScrollMaxIteration: 15,
  flutterScrollDelta: 64,
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

    // Appium capabilities from env
    automationName: process.env.APPIUM_AUTOMATION_NAME || defaults.automationName,
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
    treeCacheTtlMs: num(process.env.TREE_CACHE_TTL_MS, defaults.treeCacheTtlMs),
    screenshotOnAction: process.env.SCREENSHOT_ON_ACTION !== 'false',
    logLevel: process.env.LOG_LEVEL || defaults.logLevel,
    ...overrides,
  };

  return config;
}

function num(val: string | undefined, fallback: number): number {
  if (!val) return fallback;
  const n = parseInt(val, 10);
  return isNaN(n) ? fallback : n;
}

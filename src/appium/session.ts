import { remote, attach, type Browser } from 'webdriverio';
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { logger } from '../util/logger.js';
import { type AppiumFlutterConfig, loadZmaCapabilities } from '../util/config.js';

// Honors the same APPIUM_FLUTTER_MCP_HOME override as the world-model /
// screen-map stores. active-session.json is machine-specific — when the
// override points into a git repo, the repo must gitignore it.
const SESSION_FILE_DIR = process.env.APPIUM_FLUTTER_MCP_HOME ?? join(homedir(), '.appium-flutter-mcp');
const SESSION_FILE = join(SESSION_FILE_DIR, 'active-session.json');

export function getActiveSessionFilePath(): string {
  return SESSION_FILE;
}

function writeActiveSession(appiumUrl: string, sessionId: string, platform: string): void {
  try {
    mkdirSync(SESSION_FILE_DIR, { recursive: true });
    writeFileSync(SESSION_FILE, JSON.stringify({ appiumUrl, sessionId, platform, ts: Date.now() }));
  } catch { /* best-effort */ }
}

function clearActiveSession(): void {
  try { if (existsSync(SESSION_FILE)) unlinkSync(SESSION_FILE); } catch { /* best-effort */ }
}

let browser: Browser | null = null;
let currentPlatform: string = 'ios';
let lastConnectOptions: ConnectOptions | null = null;
let lastConfig: AppiumFlutterConfig | null = null;

// Session mode — derived from caps at createSession time. Defaults to 'flutter'
// so every existing code path (no browserName, automationName=FlutterIntegration)
// behaves EXACTLY as before. Only when caps explicitly declare a Safari browser
// or a bare XCUITest automation does the mode diverge.
export type SessionMode = 'flutter' | 'safari' | 'native-xcuitest';
let currentSessionMode: SessionMode = 'flutter';

/**
 * Derives the session mode from a merged capabilities object. This is the
 * single source of truth for "what kind of session is this?".
 *
 * Rules (checked in order):
 *   1. Explicit escape hatch: caps['appium:sessionMode'] wins if provided
 *   2. browserName === 'Safari'                         → 'safari'
 *   3. automationName === 'XCUITest' and no browserName → 'native-xcuitest'
 *   4. anything else (incl. FlutterIntegration)         → 'flutter'
 *
 * A default of 'flutter' guarantees zero behavior change for any caller who
 * doesn't explicitly opt into the new modes.
 */
export function deriveSessionMode(caps: Record<string, unknown>): SessionMode {
  const explicit = caps['appium:sessionMode'] as string | undefined;
  if (explicit === 'flutter' || explicit === 'safari' || explicit === 'native-xcuitest') {
    return explicit;
  }
  const browserName = String(caps['appium:browserName'] ?? caps['browserName'] ?? '').toLowerCase();
  const automationName = String(caps['appium:automationName'] ?? '').toLowerCase();
  if (browserName === 'safari') return 'safari';
  if (automationName === 'xcuitest' && !browserName) return 'native-xcuitest';
  return 'flutter';
}

export function getSessionMode(): SessionMode {
  return currentSessionMode;
}

// Health check throttle — skip redundant getWindowRect() calls
let lastHealthCheckMs: number = 0;
const HEALTH_CHECK_INTERVAL_MS = 10_000; // check at most every 10s

export function getBrowser(): Browser {
  if (!browser) throw new Error('No active Appium session. Call connect first.');
  return browser;
}

/**
 * Fix #3: Get browser with auto-reconnect on WDA connection drop.
 * Wraps getBrowser() with a health check and automatic session recovery.
 */
export async function getBrowserWithReconnect(): Promise<Browser> {
  if (!browser) throw new Error('No active Appium session. Call connect first.');

  // Skip health check if we checked recently (saves 50-150ms per action)
  const now = Date.now();
  if (now - lastHealthCheckMs < HEALTH_CHECK_INTERVAL_MS) {
    return browser;
  }

  try {
    // Lightweight health check — if this fails, connection is dead
    await browser.getWindowRect();
    lastHealthCheckMs = now;
    return browser;
  } catch (error) {
    logger.warn('Session health check failed, attempting reconnect...', { error: String(error) });

    if (!lastConnectOptions || !lastConfig) {
      throw new Error(`Session dropped and cannot auto-reconnect — no previous connection info. Original error: ${String(error)}`);
    }

    // Try to reconnect
    try {
      // If we had a sessionId, try to re-attach first
      if (browser.sessionId) {
        try {
          const url = new URL(lastConfig.appiumUrl);
          browser = await attach({
            sessionId: browser.sessionId,
            protocol: url.protocol.replace(':', '') as 'http' | 'https',
            hostname: url.hostname,
            port: parseInt(url.port) || 4723,
            path: '/',
          });
          // Verify the re-attached session works
          await browser.getWindowRect();
          logger.info('Re-attached to existing session successfully');
          return browser;
        } catch {
          logger.warn('Re-attach failed, creating new session...');
        }
      }

      // Create a fresh session
      browser = null;
      const session = await createSession(lastConfig, lastConnectOptions);
      logger.info('Auto-reconnected with new session', { sessionId: session.sessionId });
      return getBrowser();
    } catch (reconnectError) {
      logger.error('Auto-reconnect failed', { error: String(reconnectError) });
      throw new Error(`Session dropped and auto-reconnect failed: ${String(reconnectError)}`);
    }
  }
}

export function hasBrowser(): boolean {
  return browser !== null;
}

export function getCurrentPlatform(): string {
  return currentPlatform;
}

export interface ConnectOptions {
  platform: 'ios' | 'android';
  sessionId?: string;
  appiumUrl?: string;
  configPath?: string;
  capabilities?: Record<string, unknown>;
  vmServiceUrl?: string;
}

export interface SessionInfo {
  sessionId: string;
  platform: string;
  capabilities: Record<string, unknown>;
}

export async function createSession(
  config: AppiumFlutterConfig,
  options: ConnectOptions,
): Promise<SessionInfo> {
  const appiumUrl = options.appiumUrl || config.appiumUrl;
  const platform = options.platform || config.platform;
  currentPlatform = platform;

  // Store for auto-reconnect (Fix #3)
  lastConnectOptions = options;
  lastConfig = config;

  // If sessionId provided, attach to existing session
  if (options.sessionId) {
    logger.info('Attaching to existing session', { sessionId: options.sessionId, appiumUrl });
    const url = new URL(appiumUrl);
    browser = await attach({
      sessionId: options.sessionId,
      protocol: url.protocol.replace(':', '') as 'http' | 'https',
      hostname: url.hostname,
      port: parseInt(url.port) || 4723,
      path: '/',
    });
    logger.info('Attached to session', { sessionId: options.sessionId });
    writeActiveSession(appiumUrl, options.sessionId, platform);
    return {
      sessionId: options.sessionId,
      platform,
      capabilities: {},
    };
  }

  // Peek at incoming caps to decide whether to inject Flutter defaults.
  // If the caller has already declared a Safari or bare-XCUITest session,
  // seeding FlutterIntegration + flutter:* timings would fight with Appium.
  // For a Flutter caller (no browserName, no XCUITest override), behavior is
  // BYTE-IDENTICAL to the previous code path.
  const incomingCaps = options.capabilities ?? {};
  const previewMode = deriveSessionMode(incomingCaps);

  // Build capabilities
  let caps: Record<string, unknown> = {
    platformName: platform === 'ios' ? 'iOS' : 'Android',
    'appium:newCommandTimeout': 300,
  };
  if (previewMode === 'flutter') {
    // Flutter defaults — untouched, exactly as before this refactor
    caps['appium:automationName'] = 'FlutterIntegration';
    caps['appium:flutterServerLaunchTimeout'] = config.flutterServerLaunchTimeout;
    caps['appium:flutterSystemPort'] = config.flutterSystemPort;
    caps['appium:flutterElementWaitTimeout'] = config.flutterElementWaitTimeout;
    caps['appium:flutterScrollMaxIteration'] = config.flutterScrollMaxIteration;
    caps['appium:flutterScrollDelta'] = config.flutterScrollDelta;
  } else {
    // Safari / native-xcuitest — the caller supplies automationName + any Safari opts
    caps['appium:automationName'] = incomingCaps['appium:automationName'] ?? 'XCUITest';
  }

  // Apply capabilities from config (env vars / MCP JSON config).
  // For Safari mode: skip bundleId/appPackage/appActivity/appPath — Appium rejects
  // Safari sessions that also declare a native bundle to launch. This affects the
  // MCP's default APPIUM_BUNDLE_ID env, which is set to the Flutter app.
  const isBrowserSession = previewMode === 'safari';
  if (config.udid) caps['appium:udid'] = config.udid;
  if (config.bundleId && !isBrowserSession) caps['appium:bundleId'] = config.bundleId;
  if (config.appPackage && !isBrowserSession) caps['appium:appPackage'] = config.appPackage;
  if (config.appActivity && !isBrowserSession) caps['appium:appActivity'] = config.appActivity;
  if (config.deviceName) caps['appium:deviceName'] = config.deviceName;
  if (config.platformVersion) caps['appium:platformVersion'] = config.platformVersion;
  if (config.appPath && !isBrowserSession) caps['appium:app'] = config.appPath;

  // Load ZMA config if path provided (overrides env-based caps)
  const configPath = options.configPath || config.zmaConfigPath;
  if (configPath) {
    const zmaCaps = loadZmaCapabilities(configPath, platform);
    caps = { ...caps, ...zmaCaps };
    logger.info('Loaded ZMA capabilities', { configPath, platform });
  }

  // Merge explicit capabilities (highest priority)
  if (options.capabilities) {
    caps = { ...caps, ...options.capabilities };
  }

  // Auto-detect physical iOS device when a VM URL is provided but no UDID was set.
  // A VM URL means a live Flutter process is already running on a real device — we
  // should never fall through to a simulator in that case.
  if (platform === 'ios' && options.vmServiceUrl && !caps['appium:udid']) {
    const detectedUdid = detectConnectedIosUdid();
    if (detectedUdid) {
      caps['appium:udid'] = detectedUdid;
      logger.info('Auto-detected physical iOS device from vmServiceUrl', { udid: detectedUdid });
    }
  }

  // Platform-specific defaults (env/config values take precedence)
  if (platform === 'ios') {
    caps['appium:wdaLaunchTimeout'] = caps['appium:wdaLaunchTimeout'] || 120000;
    caps['appium:noReset'] = caps['appium:noReset'] ?? config.noReset ?? true;
    caps['appium:fullReset'] = caps['appium:fullReset'] ?? config.fullReset ?? false;
    caps['appium:shouldTerminateApp'] = caps['appium:shouldTerminateApp'] ?? config.shouldTerminateApp ?? false;
    // Hybrid Flutter + WKWebView discovery — matches zmauiautomation
    // CapabilityFactory. Without these the WebKit Remote Debugger never
    // surfaces and getContexts() returns only NATIVE_APP.
    caps['appium:webviewConnectTimeout'] = caps['appium:webviewConnectTimeout'] ?? config.webviewConnectTimeout;
    caps['appium:webviewConnectRetries'] = caps['appium:webviewConnectRetries'] ?? config.webviewConnectRetries;
  } else {
    caps['appium:noReset'] = caps['appium:noReset'] ?? config.noReset ?? false;
    caps['appium:fullReset'] = caps['appium:fullReset'] ?? config.fullReset ?? false;
    caps['appium:autoGrantPermissions'] = caps['appium:autoGrantPermissions'] ?? true;
    caps['appium:autoAcceptAlerts'] = caps['appium:autoAcceptAlerts'] ?? true;
  }

  // Finalize session mode from the FULL merged caps (previewMode used the
  // caller's caps only; after merge, the flutter-defaulted branch settles as
  // 'flutter' and any Safari/native override on the merged caps is honored).
  currentSessionMode = deriveSessionMode(caps);

  const url = new URL(appiumUrl);
  logger.info('Creating new Appium session', { appiumUrl, platform, sessionMode: currentSessionMode });

  browser = await remote({
    protocol: url.protocol.replace(':', '') as 'http' | 'https',
    hostname: url.hostname,
    port: parseInt(url.port) || 4723,
    path: '/',
    capabilities: caps,
    logLevel: 'warn',
  });

  const sessionId = browser.sessionId;
  logger.info('Session created', { sessionId, platform, sessionMode: currentSessionMode });
  writeActiveSession(appiumUrl, sessionId, platform);

  return {
    sessionId,
    platform,
    capabilities: caps,
  };
}

/** Get basic session info for recording context */
export function getSessionInfo(): { platform: string; context: string; sessionId: string } {
  if (!browser) return { platform: 'unknown', context: 'unknown', sessionId: '' };
  return {
    platform: currentPlatform,
    context: 'flutter', // Default — actual context tracked by context-manager
    sessionId: browser.sessionId || '',
  };
}

export async function destroySession(terminateApp: boolean = false): Promise<void> {
  if (!browser) {
    logger.warn('No active session to disconnect');
    return;
  }
  try {
    if (terminateApp) {
      await browser.deleteSession();
      logger.info('Session deleted (app terminated)');
    } else {
      await browser.deleteSession();
      logger.info('Session disconnected');
    }
  } finally {
    browser = null;
    currentSessionMode = 'flutter'; // reset to the default; a fresh connect will re-derive
    clearActiveSession();
  }
}

/**
 * Returns the UDID of the first connected physical iOS device, or undefined if
 * none is found. Uses idevice_id (libimobiledevice) as the fast path; falls
 * back to `flutter devices --machine` if idevice_id is not installed.
 */
function detectConnectedIosUdid(): string | undefined {
  // Fast path: idevice_id (libimobiledevice, installed alongside ios-deploy)
  try {
    const out = execSync('idevice_id -l 2>/dev/null', { timeout: 5000, encoding: 'utf-8' });
    const udids = out.split('\n').map(l => l.trim()).filter(Boolean);
    if (udids.length > 0) return udids[0];
  } catch { /* not installed or no device */ }

  // Fallback: flutter devices --machine
  try {
    const out = execSync('flutter devices --machine 2>/dev/null', { timeout: 15000, encoding: 'utf-8' });
    const devices: Array<{ id: string; targetPlatform?: string; emulator?: boolean }> = JSON.parse(out || '[]');
    const physical = devices.find(d => d.targetPlatform?.startsWith('ios') && d.emulator === false);
    if (physical) return physical.id;
  } catch { /* flutter not on PATH or no device */ }

  return undefined;
}

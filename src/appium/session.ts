import { remote, attach, type Browser } from 'webdriverio';
import { logger } from '../util/logger.js';
import { type AppiumFlutterConfig } from '../util/config.js';

let browser: Browser | null = null;
let currentPlatform: string = 'ios';
let lastConnectOptions: ConnectOptions | null = null;
let lastConfig: AppiumFlutterConfig | null = null;

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
    return {
      sessionId: options.sessionId,
      platform,
      capabilities: {},
    };
  }

  // Build capabilities
  let caps: Record<string, unknown> = {
    platformName: platform === 'ios' ? 'iOS' : 'Android',
    'appium:automationName': 'FlutterIntegration',
    'appium:flutterServerLaunchTimeout': config.flutterServerLaunchTimeout,
    'appium:flutterSystemPort': config.flutterSystemPort,
    'appium:flutterElementWaitTimeout': config.flutterElementWaitTimeout,
    'appium:flutterScrollMaxIteration': config.flutterScrollMaxIteration,
    'appium:flutterScrollDelta': config.flutterScrollDelta,
    'appium:newCommandTimeout': 300,
  };

  // Apply capabilities from config (env vars / MCP JSON config)
  if (config.udid) caps['appium:udid'] = config.udid;
  if (config.bundleId) caps['appium:bundleId'] = config.bundleId;
  if (config.appPackage) caps['appium:appPackage'] = config.appPackage;
  if (config.appActivity) caps['appium:appActivity'] = config.appActivity;
  if (config.deviceName) caps['appium:deviceName'] = config.deviceName;
  if (config.platformVersion) caps['appium:platformVersion'] = config.platformVersion;
  if (config.appPath) caps['appium:app'] = config.appPath;

  // Merge explicit capabilities (highest priority)
  if (options.capabilities) {
    caps = { ...caps, ...options.capabilities };
  }

  // Platform-specific defaults (env/config values take precedence)
  if (platform === 'ios') {
    caps['appium:wdaLaunchTimeout'] = caps['appium:wdaLaunchTimeout'] || 120000;
    caps['appium:noReset'] = caps['appium:noReset'] ?? config.noReset ?? true;
    caps['appium:fullReset'] = caps['appium:fullReset'] ?? config.fullReset ?? false;
    caps['appium:shouldTerminateApp'] = caps['appium:shouldTerminateApp'] ?? config.shouldTerminateApp ?? false;
  } else {
    caps['appium:noReset'] = caps['appium:noReset'] ?? config.noReset ?? false;
    caps['appium:fullReset'] = caps['appium:fullReset'] ?? config.fullReset ?? false;
    caps['appium:autoGrantPermissions'] = caps['appium:autoGrantPermissions'] ?? true;
    caps['appium:autoAcceptAlerts'] = caps['appium:autoAcceptAlerts'] ?? true;
  }

  const url = new URL(appiumUrl);
  logger.info('Creating new Appium session', { appiumUrl, platform });

  browser = await remote({
    protocol: url.protocol.replace(':', '') as 'http' | 'https',
    hostname: url.hostname,
    port: parseInt(url.port) || 4723,
    path: '/',
    capabilities: caps,
    logLevel: 'warn',
  });

  const sessionId = browser.sessionId;
  logger.info('Session created', { sessionId, platform });

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
  }
}

import { z } from 'zod';
import { getBrowser, getCurrentPlatform } from '../appium/session.js';
import { loadConfig } from '../util/config.js';
import { logger } from '../util/logger.js';
import { autoScan } from '../util/auto-scan.js';
import type { McpToolResponse } from '../types.js';

export const launchAppSchema = z.object({
  bundleId: z.string().optional().describe('iOS bundle ID (e.g., com.example.myapp). Falls back to APPIUM_BUNDLE_ID env when omitted.'),
  appPackage: z.string().optional().describe('Android app package. Falls back to APPIUM_APP_PACKAGE env when omitted.'),
  appActivity: z.string().optional().describe('Android app activity'),
});

export const terminateAppSchema = z.object({
  bundleId: z.string().optional().describe('iOS bundle ID. Falls back to APPIUM_BUNDLE_ID env when omitted.'),
  appPackage: z.string().optional().describe('Android app package. Falls back to APPIUM_APP_PACKAGE env when omitted.'),
});

export const deviceInfoSchema = z.object({});

export async function handleLaunchApp(params: z.infer<typeof launchAppSchema>): Promise<McpToolResponse> {
  const browser = getBrowser();
  const platform = getCurrentPlatform();
  const config = loadConfig();

  try {
    let appLabel: string;
    if (platform === 'ios') {
      const bundleId = params.bundleId || config.bundleId;
      if (!bundleId) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message: 'No bundle ID provided. Pass bundleId or set APPIUM_BUNDLE_ID env.' }) }],
        };
      }
      await browser.execute('mobile: activateApp', { bundleId });
      appLabel = bundleId;
    } else {
      const pkg = params.appPackage || config.appPackage;
      if (!pkg) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message: 'No app package provided. Pass appPackage or set APPIUM_APP_PACKAGE env.' }) }],
        };
      }
      await browser.execute('mobile: activateApp', { appId: pkg });
      appLabel = pkg;
    }

    // Auto-scan: return screen state so Claude knows what's on screen immediately
    const content: McpToolResponse['content'] = [
      { type: 'text' as const, text: `Launched app: ${appLabel}` },
    ];
    try {
      await new Promise(r => setTimeout(r, 800)); // settle wait
      const scan = await autoScan(browser);
      content.push(...scan.contentBlocks);
    } catch (error) {
      logger.debug('Post-launch auto-scan failed (non-critical)', { error: String(error) });
    }
    return { content };
  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message: `Launch failed: ${error}` }) }],
    };
  }
}

export async function handleTerminateApp(params: z.infer<typeof terminateAppSchema>): Promise<McpToolResponse> {
  const browser = getBrowser();
  const platform = getCurrentPlatform();
  const config = loadConfig();

  try {
    if (platform === 'ios') {
      const bundleId = params.bundleId || config.bundleId;
      if (!bundleId) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message: 'No bundle ID provided. Pass bundleId or set APPIUM_BUNDLE_ID env.' }) }],
        };
      }
      await browser.execute('mobile: terminateApp', { bundleId });
      return {
        content: [{ type: 'text' as const, text: `Terminated app: ${bundleId}` }],
      };
    } else {
      const pkg = params.appPackage || config.appPackage;
      if (!pkg) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message: 'No app package provided. Pass appPackage or set APPIUM_APP_PACKAGE env.' }) }],
        };
      }
      await browser.execute('mobile: terminateApp', { appId: pkg });
      return {
        content: [{ type: 'text' as const, text: `Terminated app: ${pkg}` }],
      };
    }
  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message: `Terminate failed: ${error}` }) }],
    };
  }
}

export async function handleDeviceInfo(): Promise<McpToolResponse> {
  const browser = getBrowser();
  const platform = getCurrentPlatform();

  try {
    const [windowRect, orientation] = await Promise.allSettled([
      browser.getWindowRect(),
      browser.getOrientation(),
    ]);

    const info: Record<string, unknown> = {
      platform,
      sessionId: browser.sessionId,
    };

    if (windowRect.status === 'fulfilled') {
      info.screen = {
        width: windowRect.value.width,
        height: windowRect.value.height,
      };
    }

    if (orientation.status === 'fulfilled') {
      info.orientation = orientation.value;
    }

    // Try to get device time
    try {
      const time = await browser.execute('mobile: getDeviceTime', {});
      info.deviceTime = time;
    } catch { /* not critical */ }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message: `Device info failed: ${error}` }) }],
    };
  }
}

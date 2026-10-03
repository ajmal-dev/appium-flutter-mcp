import { z } from 'zod';
import { getBrowser, getCurrentPlatform } from '../appium/session.js';
import { loadConfig } from '../util/config.js';
import { logger } from '../util/logger.js';
import { autoScan } from '../util/auto-scan.js';
import { invalidateCache } from '../tree/tree-builder.js';
import type { McpToolResponse } from '../types.js';

export const launchAppSchema = z.object({
  bundleId: z.string().optional().describe('iOS bundle ID (e.g., com.example.app)'),
  appPackage: z.string().optional().describe('Android app package'),
  appActivity: z.string().optional().describe('Android app activity'),
});

export const terminateAppSchema = z.object({
  bundleId: z.string().optional().describe('iOS bundle ID'),
  appPackage: z.string().optional().describe('Android app package'),
});

export const appControlSchema = z.object({
  action: z.enum(['launch', 'terminate']).describe('"launch" activates the app (and auto-scans the screen); "terminate" kills it.'),
  bundleId: z.string().optional().describe('iOS bundle ID. Defaults to APPIUM_BUNDLE_ID.'),
  appPackage: z.string().optional().describe('Android app package'),
  appActivity: z.string().optional().describe('Android app activity (launch only)'),
});

export async function handleAppControl(params: z.infer<typeof appControlSchema>): Promise<McpToolResponse> {
  return params.action === 'launch'
    ? handleLaunchApp(params)
    : handleTerminateApp(params);
}

export async function handleLaunchApp(params: z.infer<typeof launchAppSchema>): Promise<McpToolResponse> {
  const browser = getBrowser();
  const platform = getCurrentPlatform();

  try {
    let appLabel: string;
    if (platform === 'ios') {
      const bundleId = params.bundleId || loadConfig().bundleId;
      if (!bundleId) throw new Error('Set bundleId or APPIUM_BUNDLE_ID before launching the app.');
      await browser.execute('mobile: activateApp', { bundleId });
      appLabel = bundleId;
    } else {
      const pkg = params.appPackage;
      if (pkg) {
        await browser.execute('mobile: activateApp', { appId: pkg });
      }
      appLabel = pkg || 'default';
    }

    // Invalidate BEFORE autoScan — autoScan reads the page-source-scanner cache that
    // invalidateCache() also clears; invalidating after would let the launch response's
    // attached scan describe the previous (terminated) app state instead of the fresh one.
    invalidateCache();

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

  try {
    if (platform === 'ios') {
      const bundleId = params.bundleId || loadConfig().bundleId;
      if (!bundleId) throw new Error('Set bundleId or APPIUM_BUNDLE_ID before terminating the app.');
      await browser.execute('mobile: terminateApp', { bundleId });
      invalidateCache();
      return {
        content: [{ type: 'text' as const, text: `Terminated app: ${bundleId}` }],
      };
    } else {
      const pkg = params.appPackage;
      if (pkg) {
        await browser.execute('mobile: terminateApp', { appId: pkg });
      }
      invalidateCache();
      return {
        content: [{ type: 'text' as const, text: `Terminated app: ${pkg || 'default'}` }],
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

import { z } from 'zod';
import { createSession, destroySession, hasBrowser, getBrowser, getCurrentPlatform } from '../appium/session.js';
import { getContextInfo } from '../context/context-manager.js';
import { loadConfig } from '../util/config.js';
import { autoScan } from '../util/auto-scan.js';
import { setCurrentAppId } from '../context/screen-map-store.js';
import { connectVM, connectVMAutoDiscover, disconnectVM, getVMSessionInfo } from '../vm/vm-session.js';
import { logger } from '../util/logger.js';
import type { McpToolResponse } from '../types.js';

export const connectSchema = z.object({
  platform: z.enum(['ios', 'android']).describe('Target platform'),
  sessionId: z.string().optional().describe('Existing Appium session ID to attach to'),
  appiumUrl: z.string().optional().describe('Appium server URL (default: http://127.0.0.1:4723)'),
  capabilities: z.record(z.unknown()).optional().describe('Additional Appium capabilities'),
  vmServiceUrl: z.string().optional().describe('Dart VM Service WebSocket URL (e.g. ws://127.0.0.1:PORT/ws). If omitted, auto-discovers from running Flutter processes.'),
});

export const disconnectSchema = z.object({
  terminateApp: z.boolean().optional().default(false).describe('Whether to terminate the app on disconnect'),
});

export const getStatusSchema = z.object({});

export async function handleConnect(params: z.infer<typeof connectSchema>): Promise<McpToolResponse> {
  const config = loadConfig({ platform: params.platform });
  const session = await createSession(config, {
    platform: params.platform,
    sessionId: params.sessionId,
    appiumUrl: params.appiumUrl,
    capabilities: params.capabilities,
    vmServiceUrl: params.vmServiceUrl,
  });

  const statusInfo: Record<string, unknown> = {
    status: 'connected',
    sessionId: session.sessionId,
    platform: session.platform,
    message: params.sessionId
      ? `Attached to existing session ${params.sessionId}`
      : `New ${params.platform} session created`,
  };

  // Connect to Dart VM Service (for direct Flutter operations)
  const vmUrl = params.vmServiceUrl || config.vmServiceUrl;
  let vmConnected = false;
  try {
    if (vmUrl) {
      // Explicit URL provided
      const vmResult = await connectVM(vmUrl);
      vmConnected = true;
      statusInfo.vmService = {
        connected: true,
        url: vmUrl,
        isolateId: vmResult.isolateId,
        extensionCount: vmResult.extensions.length,
      };
      logger.info('VM Service connected (explicit URL)', { url: vmUrl });
    } else if (config.vmAutoDiscover) {
      // Auto-discover VM service
      const vmResult = await connectVMAutoDiscover();
      if (vmResult) {
        vmConnected = true;
        statusInfo.vmService = {
          connected: true,
          url: vmResult.url,
          isolateId: vmResult.isolateId,
          extensionCount: vmResult.extensions.length,
        };
        logger.info('VM Service connected (auto-discovered)', { url: vmResult.url });
      } else {
        statusInfo.vmService = { connected: false, reason: 'No Dart VM service found (auto-discovery)' };
      }
    }
  } catch (vmError) {
    statusInfo.vmService = { connected: false, error: String(vmError) };
    logger.debug('VM Service connection failed (non-critical, using Appium only)', { error: String(vmError) });
  }

  if (vmConnected) {
    statusInfo.message += ' + Dart VM Service (hybrid mode — faster Flutter operations)';
  }

  const content: McpToolResponse['content'] = [{
    type: 'text' as const,
    text: JSON.stringify(statusInfo, null, 2),
  }];

  // Initialize screen map store with app ID from capabilities or env config
  try {
    const appId = (params.capabilities?.['appium:bundleId'] as string)
      || (params.capabilities?.['appium:appPackage'] as string)
      || config.bundleId
      || config.appPackage
      || 'unknown-app';
    setCurrentAppId(appId);
  } catch { /* non-critical */ }

  // Auto-scan: return screen state immediately so Claude doesn't need a follow-up get_screen
  try {
    const browser = getBrowser();
    // Brief settle wait for app to stabilize after connect
    await new Promise(r => setTimeout(r, 500));
    const scan = await autoScan(browser);
    content.push(...scan.contentBlocks);
  } catch (error) {
    logger.debug('Post-connect auto-scan failed (non-critical)', { error: String(error) });
  }

  return { content };
}

export async function handleDisconnect(params: z.infer<typeof disconnectSchema>): Promise<McpToolResponse> {
  await disconnectVM();
  await destroySession(params.terminateApp);
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ status: 'disconnected', appTerminated: params.terminateApp }),
    }],
  };
}

export async function handleGetStatus(): Promise<McpToolResponse> {
  if (!hasBrowser()) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ status: 'disconnected', message: 'No active session. Call connect first.' }),
      }],
    };
  }

  const contextInfo = await getContextInfo();

  // Include screen context hints: current screen name + key elements
  let screenHint: Record<string, unknown> | undefined;
  try {
    const { getCurrentScreenId, getCurrentAppId, loadScreenMap } = await import('../context/screen-map-store.js');
    const appId = getCurrentAppId();
    const screenId = getCurrentScreenId();
    if (appId && screenId) {
      const screen = loadScreenMap(appId, screenId);
      if (screen) {
        screenHint = {
          screenName: screen.name,
          screenId: screen.screenId,
          elementCount: screen.elements.length,
          keyElements: screen.elements.slice(0, 8).map(e =>
            `${e.type}${e.text ? ` "${e.text}"` : ''} (${e.locator.by}:${e.locator.value})`
          ),
          navigationEdges: screen.edges.map(e => `${e.action.by}:${e.action.value} → "${e.toScreenName || e.toScreenId}"`),
        };
      }
    }
  } catch { /* screen map not available yet */ }

  const vmInfo = getVMSessionInfo();

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        status: 'connected',
        platform: getCurrentPlatform(),
        context: contextInfo.current,
        availableContexts: contextInfo.available,
        vmService: vmInfo.connected
          ? { connected: true, url: vmInfo.url, isolateId: vmInfo.isolateId }
          : { connected: false },
        ...(screenHint ? { currentScreen: screenHint } : {}),
      }, null, 2),
    }],
  };
}

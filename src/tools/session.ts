import { z } from 'zod';
import { createSession, destroySession, hasBrowser, getBrowser, getCurrentPlatform, getSessionMode } from '../appium/session.js';
import { getContextInfo } from '../context/context-manager.js';
import { loadConfig } from '../util/config.js';
import { autoScan } from '../util/auto-scan.js';
import { setCurrentAppId } from '../context/screen-map-store.js';
import { connectVM, connectVMAutoDiscover, disconnectVM, getVMSessionInfo, setSessionAppIdentity, applyDriverProfileIfKnown } from '../vm/vm-session.js';
import { getDartSourceIndex } from '../source/dart-source-scanner.js';
import { logger } from '../util/logger.js';
import type { McpToolResponse } from '../types.js';

export const connectSchema = z.object({
  platform: z.enum(['ios', 'android']).describe('Target platform'),
  sessionId: z.string().optional().describe('Existing Appium session ID to attach to'),
  appiumUrl: z.string().optional().describe('Appium server URL (default: http://127.0.0.1:4723)'),
  configPath: z.string().optional().describe('Path to ZMA config directory to reuse device/app config'),
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
    configPath: params.configPath,
    capabilities: params.capabilities,
    vmServiceUrl: params.vmServiceUrl,
  });

  const sessionMode = getSessionMode();
  const statusInfo: Record<string, unknown> = {
    status: 'connected',
    sessionId: session.sessionId,
    platform: session.platform,
    sessionMode,
    message: params.sessionId
      ? `Attached to existing session ${params.sessionId}`
      : `New ${params.platform} ${sessionMode} session created`,
  };

  // Non-Flutter modes (Safari, native XCUITest) don't have a Dart VM, don't
  // benefit from Dart source warming, and shouldn't attempt Flutter-tree scans.
  // Bail here with a lean success response — the rest of this handler is
  // Flutter-specific bookkeeping and stays UNCHANGED for Flutter callers.
  if (sessionMode !== 'flutter') {
    statusInfo.notes = sessionMode === 'safari'
      ? 'Safari session: use web_navigate to load a URL, then inspect(target:"webview"), find_elements is not supported (Flutter-only) — use CSS via inspect/webview_fill_form/tap(by:"css").'
      : 'Native XCUITest session: use inspect(target:"native") for the accessibility tree; Flutter-tree tools are disabled.';
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(statusInfo, null, 2),
      }],
    };
  }

  // ── Below this line: Flutter-mode-only path, IDENTICAL to pre-refactor behavior ──

  // Register app identity for driver-profile learning (persist/recall per-app capabilities).
  const appId = (params.capabilities?.['appium:bundleId'] as string)
    || (params.capabilities?.['appium:appPackage'] as string)
    || config.bundleId
    || config.appPackage
    || 'unknown-app';
  setSessionAppIdentity(appId, params.platform);

  // Connect to Dart VM Service (for direct Flutter operations)
  const vmUrl = params.vmServiceUrl || config.vmServiceUrl;
  let vmConnected = false;
  try {
    if (vmUrl) {
      // Explicit URL provided
      const vmResult = await connectVM(vmUrl);
      vmConnected = true;
      // Apply learned driver profile AFTER connectVM (which resets the flavor detection).
      const profileNote = applyDriverProfileIfKnown();
      statusInfo.vmService = {
        connected: true,
        url: vmUrl,
        isolateId: vmResult.isolateId,
        extensionCount: vmResult.extensions.length,
        ...(profileNote ? { driverProfile: profileNote } : {}),
      };
      logger.info('VM Service connected (explicit URL)', { url: vmUrl });
    } else if (config.vmAutoDiscover) {
      // Auto-discover VM service
      const vmResult = await connectVMAutoDiscover();
      if (vmResult) {
        vmConnected = true;
        const profileNote = applyDriverProfileIfKnown();
        statusInfo.vmService = {
          connected: true,
          url: vmResult.url,
          isolateId: vmResult.isolateId,
          extensionCount: vmResult.extensions.length,
          ...(profileNote ? { driverProfile: profileNote } : {}),
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

  // Initialize screen map store with app ID from capabilities (reuse already-resolved appId)
  try {
    setCurrentAppId(appId);
  } catch { /* non-critical */ }

  // Warm the Dart source ValueKey index in the background so the first locator miss
  // doesn't pay the 0.5-2s cold-scan cost mid-run.
  const warmConfig = loadConfig({ platform: params.platform });
  if (warmConfig.flutterAppPath || warmConfig.flutterComponentsPath) {
    getDartSourceIndex(warmConfig.flutterAppPath, warmConfig.flutterComponentsPath)
      .then(idx => {
        if (idx) logger.info('Dart source index warmed', { keys: idx.valueKeys.size, files: idx.fileCount });
      })
      .catch(err => logger.debug('Dart source index warm-up failed (non-critical)', { error: String(err) }));
  }

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

  const sessionMode = getSessionMode();
  const contextInfo = await getContextInfo();

  // Include screen context hints: current screen name + key elements.
  // Flutter-mode-only — the screen-map store is keyed by Flutter widget structure.
  let screenHint: Record<string, unknown> | undefined;
  if (sessionMode === 'flutter') {
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
  }

  const vmInfo = getVMSessionInfo();

  // Device block (absorbed device_info tool): screen size, orientation, session id
  let device: Record<string, unknown> | undefined;
  try {
    const { getBrowser } = await import('../appium/session.js');
    const browser = getBrowser();
    device = { sessionId: browser.sessionId };
    const [windowRect, orientation] = await Promise.allSettled([
      browser.getWindowRect(),
      browser.getOrientation(),
    ]);
    if (windowRect.status === 'fulfilled') {
      device.screen = { width: windowRect.value.width, height: windowRect.value.height };
    }
    if (orientation.status === 'fulfilled') device.orientation = orientation.value;
  } catch { /* device info is best-effort */ }

  // Recording state (absorbed get_recording tool's status role)
  let recording: Record<string, unknown> | undefined;
  try {
    const { getActiveRecording } = await import('../recording/recorder.js');
    const active = getActiveRecording();
    if (active) {
      recording = { active: true, name: active.name, actionCount: active.actions.length };
    }
  } catch { /* recorder not loaded */ }

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        status: 'connected',
        platform: getCurrentPlatform(),
        sessionMode,
        context: contextInfo.current,
        availableContexts: contextInfo.available,
        vmService: vmInfo.connected
          ? {
              connected: true, url: vmInfo.url, isolateId: vmInfo.isolateId,
              // present only when the client self-healed onto a fresh URL
              // after an app relaunch (.dart_vm_url follow)
              ...(vmInfo.reconnectedFrom ? { reconnectedFrom: vmInfo.reconnectedFrom } : {}),
            }
          : { connected: false, ...(sessionMode !== 'flutter' ? { reason: `not applicable in ${sessionMode} mode` } : {}) },
        ...(device ? { device } : {}),
        ...(recording ? { recording } : {}),
        ...(screenHint ? { currentScreen: screenHint } : {}),
      }, null, 2),
    }],
  };
}

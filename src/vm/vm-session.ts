import { DartVMClient } from './dart-vm-client.js';
import { vmLogger as logger } from './vm-logger.js';
import { loadDriverProfile, persistDriverProfile } from '../world/driver-profile.js';

/**
 * VM Session management — singleton pattern matching appium/session.ts
 */

let vmClient: DartVMClient | null = null;
let lastVmUrl: string = '';

// App identity for the current session — set by session.ts at connect time so
// markVMDriverCommandsBroken can persist outcomes keyed by app.
let sessionAppId = '';
let sessionPlatform = '';

export function getVMClient(): DartVMClient | null {
  if (vmClient && vmClient.connected) return vmClient;
  return null;
}

// --- Driver-flavor detection -------------------------------------------------
// The bare `ext.flutter.driver` service extension is registered by BOTH:
//   - flutter_driver's enableFlutterDriverExtension() → full command set
//     (waitFor / tap / enter_text / ... dispatched on a `command` param)
//   - integration_test's IntegrationTestWidgetsFlutterBinding → a health/data
//     SUBSET only. `get_health` succeeds but UI commands fail with -32000.
//     (This is what appium_flutter_server builds like ZMA register — UI driving
//     goes through the Appium integration driver, not the VM.)
// Extension presence alone therefore can't prove the VM action path works.
// Strategy: allow the first attempt, and on a PROTOCOL-level failure (VM
// Service error, not a legit driver error like element-not-found) mark the
// path broken for the rest of the session so every later action goes straight
// to Appium with zero wasted round trips.
let loggedFlavor = false;
let driverCommandsBroken = false;

/** Store the app identity so markVMDriverCommandsBroken can persist per-app outcomes. */
export function setSessionAppIdentity(appId: string, platform: string): void {
  sessionAppId = appId;
  sessionPlatform = platform;
}

/** Reset per VM connection (a different app may support the full command set). */
export function resetDriverFlavorDetection(): void {
  loggedFlavor = false;
  driverCommandsBroken = false;
}

/**
 * After connectVM (which calls resetDriverFlavorDetection), re-apply a learned
 * driver profile for this app. If the profile says VM driver commands are broken,
 * pre-mark the session so the first tool call goes straight to the working path.
 * Returns a human-readable summary for inclusion in the connect response.
 */
export function applyDriverProfileIfKnown(): string | null {
  if (!sessionAppId || !sessionPlatform) return null;
  const profile = loadDriverProfile(sessionAppId, sessionPlatform);
  if (!profile) return null;
  if (profile.vmDriverCommands === 'broken') {
    driverCommandsBroken = true;
    logger.info('Driver profile loaded — VM driver commands pre-marked broken for this app', {
      appId: sessionAppId, platform: sessionPlatform,
      lastConfirmed: profile.lastConfirmed, sessions: profile.sessions,
    });
    return `profile loaded: VM driver commands known broken for ${sessionAppId} on ${sessionPlatform} ` +
      `(last confirmed ${profile.lastConfirmed}, ${profile.sessions} session(s)); ` +
      `using find_elements + setValue path directly`;
  }
  return `profile loaded: VM driver commands previously worked for ${sessionAppId} on ${sessionPlatform}`;
}

export function hasFlutterDriverExtension(): boolean {
  const client = getVMClient();
  if (!client) return false;
  return client.extensions.includes('ext.flutter.driver');
}

/** True when VM-driven UI actions (vmTap/vmEnterText/…) are worth attempting. */
export function vmDriverCommandsUsable(): boolean {
  if (driverCommandsBroken) return false;
  const available = hasFlutterDriverExtension();
  if (!loggedFlavor && available) {
    loggedFlavor = true;
    logger.info('ext.flutter.driver registered — VM action fast path will be attempted once');
  }
  return available;
}

/**
 * Call from action catch-blocks when the failure was protocol-level
 * ("VM Service error" / Unknown method) rather than a legit driver result.
 */
export function markVMDriverCommandsBroken(reason: string): void {
  if (driverCommandsBroken) return;
  driverCommandsBroken = true;
  logger.info('VM driver commands unsupported on this build — disabling VM action path for this session', {
    reason: reason.slice(0, 200),
    note: 'integration_test/appium_flutter_server builds only implement a health subset of ext.flutter.driver',
  });
  // Persist so session N+1 starts already knowing this app's driver flavor.
  if (sessionAppId && sessionPlatform) {
    persistDriverProfile(sessionAppId, sessionPlatform, {
      vmDriverCommands: 'broken',
      evidence: reason,
    });
  }
}

export function hasVMClient(): boolean {
  return vmClient !== null && vmClient.connected;
}

export async function connectVM(url: string): Promise<{
  isolateId: string;
  isolateName: string;
  extensions: string[];
}> {
  // Dispose existing connection
  if (vmClient) {
    try { await vmClient.dispose(); } catch { /* ignore */ }
  }

  vmClient = new DartVMClient();
  lastVmUrl = url;
  resetDriverFlavorDetection();

  // Set up reconnection handler
  vmClient.on('reconnected', () => {
    logger.info('VM client auto-reconnected');
  });

  vmClient.on('disconnected', () => {
    logger.warn('VM client disconnected');
  });

  const result = await vmClient.connect(url);
  return result;
}

export async function connectVMAutoDiscover(): Promise<{
  url: string;
  isolateId: string;
  isolateName: string;
  extensions: string[];
} | null> {
  const urls = await DartVMClient.discoverVMServiceUrls();

  if (urls.length === 0) {
    logger.info('No Dart VM services found for auto-discovery');
    return null;
  }

  logger.info('Discovered Dart VM service URLs', { count: urls.length, urls });

  // Try each discovered URL
  for (const url of urls) {
    try {
      const result = await connectVM(url);
      return { url, ...result };
    } catch (err) {
      logger.debug('VM auto-discovery failed for URL', { url, error: String(err) });
    }
  }

  return null;
}

export async function disconnectVM(): Promise<void> {
  if (vmClient) {
    try {
      await vmClient.dispose();
    } catch (err) {
      logger.debug('VM dispose error', { error: String(err) });
    }
    vmClient = null;
    lastVmUrl = '';
  }
}

export function getVMSessionInfo(): {
  connected: boolean;
  url: string;
  isolateId: string | null;
  extensions: string[];
  reconnectedFrom?: string | null;
} {
  if (!vmClient) {
    return { connected: false, url: '', isolateId: null, extensions: [] };
  }
  return {
    connected: vmClient.connected,
    // currentUrl, not lastVmUrl: the client may have self-healed onto a fresh
    // URL (app relaunch → .dart_vm_url change) since connectVM() was called.
    url: vmClient.currentUrl || lastVmUrl,
    isolateId: vmClient.isolateId,
    extensions: vmClient.extensions,
    reconnectedFrom: vmClient.reconnectedFrom,
  };
}

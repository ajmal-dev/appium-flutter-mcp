import { DartVMClient } from './dart-vm-client.js';
import { vmLogger as logger } from './vm-logger.js';

/**
 * VM Session management — singleton pattern matching appium/session.ts
 */

let vmClient: DartVMClient | null = null;
let lastVmUrl: string = '';

export function getVMClient(): DartVMClient | null {
  if (vmClient && vmClient.connected) return vmClient;
  return null;
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
} {
  if (!vmClient) {
    return { connected: false, url: '', isolateId: null, extensions: [] };
  }
  return {
    connected: vmClient.connected,
    url: lastVmUrl,
    isolateId: vmClient.isolateId,
    extensions: vmClient.extensions,
  };
}

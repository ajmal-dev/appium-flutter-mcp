import { exec } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFile, unlink } from 'fs/promises';
import { randomBytes } from 'crypto';

const execAsync = promisify(exec);

export interface DeviceScreenshot {
  base64: string;
  width: number;
  height: number;
}

export type DevicePlatform = 'ios' | 'android';

/**
 * Capture a screenshot from the device/simulator using platform CLI tools.
 * No Appium connection required — works independently.
 */
export async function captureDeviceScreenshot(
  platform: DevicePlatform,
  deviceId?: string,
): Promise<DeviceScreenshot> {
  if (platform === 'ios') {
    return captureIosScreenshot(deviceId);
  } else {
    return captureAndroidScreenshot(deviceId);
  }
}

async function captureIosScreenshot(deviceId?: string): Promise<DeviceScreenshot> {
  const tmpFile = join(tmpdir(), `appium-flutter-mcp-${randomBytes(4).toString('hex')}.png`);

  const strategies = [
    // 1. idevicescreenshot (real devices via libimobiledevice)
    async () => {
      const cmd = deviceId
        ? `idevicescreenshot -u ${deviceId} "${tmpFile}"`
        : `idevicescreenshot "${tmpFile}"`;
      await execAsync(cmd, { timeout: 15000 });
      const buffer = await readFile(tmpFile);
      return buffer.toString('base64');
    },
    // 2. macOS screen capture of QuickTime/mirrored window (real devices with screen mirroring)
    async () => {
      // Try using cfgutil or Xcode's built-in screenshot for connected devices
      const cmd = `xcrun xctrace screenshot --output "${tmpFile}" 2>/dev/null`;
      await execAsync(cmd, { timeout: 15000 });
      const buffer = await readFile(tmpFile);
      return buffer.toString('base64');
    },
    // 3. xcrun simctl (simulators only)
    async () => {
      const device = deviceId || 'booted';
      await execAsync(
        `xcrun simctl io ${device} screenshot --type=png "${tmpFile}"`,
        { timeout: 10000 },
      );
      const buffer = await readFile(tmpFile);
      return buffer.toString('base64');
    },
  ];

  try {
    for (const strategy of strategies) {
      try {
        const base64 = await strategy();
        const { width, height } = await getIosDeviceDimensions(deviceId || 'booted');
        return { base64, width, height };
      } catch {
        continue;
      }
    }
    throw new Error('iOS screenshot failed. Install libimobiledevice for real devices.');
  } finally {
    try { await unlink(tmpFile); } catch { /* ignore */ }
  }
}

async function getIosDeviceDimensions(deviceId: string): Promise<{ width: number; height: number }> {
  try {
    const { stdout } = await execAsync(
      `xcrun simctl io ${deviceId} enumerate 2>/dev/null | head -5 || true`,
      { timeout: 5000 },
    );
    const match = stdout.match(/(\d+)\s*x\s*(\d+)/);
    if (match) return { width: parseInt(match[1]), height: parseInt(match[2]) };
  } catch { /* fallback */ }

  return { width: 390, height: 844 };
}

async function captureAndroidScreenshot(deviceId?: string): Promise<DeviceScreenshot> {
  const adbPrefix = deviceId ? `adb -s ${deviceId}` : 'adb';

  const { stdout } = await execAsync(
    `${adbPrefix} exec-out screencap -p | base64`,
    { timeout: 10000, maxBuffer: 20 * 1024 * 1024 },
  );

  const base64 = stdout.trim();
  const { width, height } = await getAndroidDeviceDimensions(adbPrefix);

  return { base64, width, height };
}

async function getAndroidDeviceDimensions(adbPrefix: string): Promise<{ width: number; height: number }> {
  try {
    const { stdout } = await execAsync(`${adbPrefix} shell wm size`, { timeout: 5000 });
    const match = stdout.match(/(\d+)x(\d+)/);
    if (match) return { width: parseInt(match[1]), height: parseInt(match[2]) };
  } catch { /* fallback */ }

  return { width: 1080, height: 2400 };
}

/**
 * Detect which platform is available by checking for running devices.
 */
export async function detectPlatform(): Promise<DevicePlatform | null> {
  try {
    const { stdout } = await execAsync(
      'xcrun simctl list devices booted -j 2>/dev/null',
      { timeout: 5000 },
    );
    const data = JSON.parse(stdout);
    for (const runtime of Object.values(data.devices || {}) as any[]) {
      if (Array.isArray(runtime) && runtime.length > 0) return 'ios';
    }
  } catch { /* not iOS */ }

  try {
    const { stdout } = await execAsync('adb devices 2>/dev/null', { timeout: 5000 });
    const lines = stdout.trim().split('\n').slice(1);
    for (const line of lines) {
      if (line.includes('device') && !line.includes('offline')) return 'android';
    }
  } catch { /* not Android */ }

  return null;
}

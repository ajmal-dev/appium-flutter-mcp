import type { Browser } from 'webdriverio';
import { logger } from './logger.js';

export interface ScreenshotResult {
  base64: string;
  mimeType: 'image/png' | 'image/jpeg';
}

/**
 * Capture screenshot and optionally compress for LLM token efficiency.
 * Uses macOS `sips` for JPEG conversion when available, falls back to raw PNG.
 *
 * Pass { raw: true } to skip compression entirely — needed by the CUA agent
 * because it reasons in the image's pixel space and Appium consumes those
 * same pixel coordinates back. Resizing would break the round-trip.
 */
export async function captureScreenshot(
  browser: Browser,
  options?: { maxWidth?: number; quality?: number; raw?: boolean },
): Promise<ScreenshotResult> {
  try {
    const base64 = await browser.takeScreenshot();

    if (options?.raw) {
      return { base64, mimeType: 'image/png' };
    }

    // Try to compress via sips (macOS) for token efficiency
    if (options?.maxWidth || options?.quality) {
      const compressed = await compressScreenshot(base64, options);
      if (compressed) return compressed;
    }

    return { base64, mimeType: 'image/png' };
  } catch (error) {
    logger.error('Failed to capture screenshot', { error: String(error) });
    throw error;
  }
}

async function compressScreenshot(
  base64Png: string,
  options: { maxWidth?: number; quality?: number },
): Promise<ScreenshotResult | null> {
  try {
    const { execSync } = await import('child_process');
    const { writeFileSync, readFileSync, unlinkSync, mkdtempSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');

    const tmpDir = mkdtempSync(join(tmpdir(), 'appium-flutter-mcp-'));
    const inputPath = join(tmpDir, 'screenshot.png');
    const outputPath = join(tmpDir, 'screenshot.jpg');

    // Write PNG to temp file
    writeFileSync(inputPath, Buffer.from(base64Png, 'base64'));

    // Use sips (macOS native) for conversion
    let cmd = `sips -s format jpeg -s formatOptions ${options.quality || 75}`;
    if (options.maxWidth) {
      cmd += ` --resampleWidth ${options.maxWidth}`;
    }
    cmd += ` "${inputPath}" --out "${outputPath}" 2>/dev/null`;

    execSync(cmd, { timeout: 5000 });

    const jpegBuffer = readFileSync(outputPath);
    const jpegBase64 = jpegBuffer.toString('base64');

    // Cleanup
    try { unlinkSync(inputPath); } catch { /* ignore */ }
    try { unlinkSync(outputPath); } catch { /* ignore */ }

    logger.debug('Screenshot compressed', {
      originalSize: Math.round(base64Png.length * 0.75 / 1024) + 'KB',
      compressedSize: Math.round(jpegBuffer.length / 1024) + 'KB',
    });

    return { base64: jpegBase64, mimeType: 'image/jpeg' };
  } catch {
    // sips not available (non-macOS) or failed — return null to use raw PNG
    return null;
  }
}

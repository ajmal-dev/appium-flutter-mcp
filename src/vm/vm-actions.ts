import { DartVMClient } from './dart-vm-client.js';
import { vmLogger as logger } from './vm-logger.js';

/**
 * Flutter Driver actions via direct Dart VM Service Protocol.
 * Uses ext.flutter.driver.* extensions for element interaction.
 */

// --- Finder Types ---

export type FinderType = 'ByValueKey' | 'ByText' | 'ByType' | 'BySemanticsLabel' | 'ByTooltipMessage';

interface FinderSpec {
  finderType: FinderType;
  keyValueString?: string;
  keyValueType?: string;
  text?: string;
  type?: string;
  label?: string;
  isRegExp?: boolean;
}

function buildFinder(by: string, value: string): FinderSpec {
  switch (by) {
    case 'key':
      return { finderType: 'ByValueKey', keyValueString: value, keyValueType: 'String' };
    case 'text':
      return { finderType: 'ByText', text: value };
    case 'type':
      return { finderType: 'ByType', type: value };
    case 'semanticsLabel':
      return { finderType: 'BySemanticsLabel', label: value, isRegExp: false };
    case 'tooltip':
      return { finderType: 'ByTooltipMessage', text: value };
    default:
      throw new Error(`Unsupported VM finder type: ${by}`);
  }
}

// --- Actions ---

export async function vmTap(client: DartVMClient, by: string, value: string, timeout?: number): Promise<void> {
  const finder = buildFinder(by, value);
  const startMs = Date.now();

  // Wait for element first
  await vmWaitFor(client, by, value, timeout || 10);

  await client.callServiceExtension('ext.flutter.driver.tap', {
    ...finder,
    timeout: String((timeout || 10) * 1000000), // microseconds
  });

  logger.info('VM tap', { by, value, elapsedMs: Date.now() - startMs });
}

export async function vmEnterText(client: DartVMClient, text: string): Promise<void> {
  const startMs = Date.now();

  await client.callServiceExtension('ext.flutter.driver.enterText', {
    text,
  });

  logger.info('VM enterText', { textLength: text.length, elapsedMs: Date.now() - startMs });
}

export async function vmScroll(
  client: DartVMClient,
  by: string,
  value: string,
  dx: number,
  dy: number,
  durationMs: number = 300,
  timeout?: number,
): Promise<void> {
  const finder = buildFinder(by, value);

  await client.callServiceExtension('ext.flutter.driver.scroll', {
    ...finder,
    dx: String(dx),
    dy: String(dy),
    duration: String(durationMs * 1000), // microseconds
    frequency: '60',
    timeout: String((timeout || 10) * 1000000),
  });

  logger.info('VM scroll', { by, value, dx, dy });
}

export async function vmWaitFor(client: DartVMClient, by: string, value: string, timeout: number = 10): Promise<void> {
  const finder = buildFinder(by, value);

  await client.callServiceExtension('ext.flutter.driver.waitFor', {
    ...finder,
    timeout: String(timeout * 1000000), // microseconds
  });
}

export async function vmWaitForAbsent(client: DartVMClient, by: string, value: string, timeout: number = 10): Promise<void> {
  const finder = buildFinder(by, value);

  await client.callServiceExtension('ext.flutter.driver.waitForAbsent', {
    ...finder,
    timeout: String(timeout * 1000000),
  });
}

export async function vmGetText(client: DartVMClient, by: string, value: string, timeout?: number): Promise<string> {
  const finder = buildFinder(by, value);

  const result = await client.callServiceExtension('ext.flutter.driver.getText', {
    ...finder,
    timeout: String((timeout || 10) * 1000000),
  }) as { text?: string };

  return (result as any)?.text ?? '';
}

export async function vmScreenshot(client: DartVMClient): Promise<Buffer> {
  const result = await client.callServiceExtension('ext.flutter.driver.screenshot', {}) as { screenshot?: string };
  const base64 = (result as any)?.screenshot;
  if (!base64) throw new Error('VM screenshot returned empty');
  return Buffer.from(base64, 'base64');
}

export async function vmWaitForCondition(
  client: DartVMClient,
  condition: 'NoPendingFrame' | 'FirstFrameRasterized' | 'NoPendingPlatformMessages' | 'CombinedCondition',
  timeout: number = 30,
): Promise<void> {
  await client.callServiceExtension('ext.flutter.driver.waitForCondition', {
    conditionName: condition,
    timeout: String(timeout * 1000000),
  });
}

/**
 * Check if a Flutter locator strategy can be handled by the VM client.
 */
export function isVMCompatibleLocator(by: string): boolean {
  return ['key', 'text', 'type', 'semanticsLabel', 'tooltip'].includes(by);
}

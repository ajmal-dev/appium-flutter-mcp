import { DartVMClient } from './dart-vm-client.js';
import { vmLogger as logger } from './vm-logger.js';

/**
 * Flutter Driver actions via direct Dart VM Service Protocol.
 *
 * PROTOCOL (verified live against the ZMA front-desk app): flutter_driver's
 * `enableFlutterDriverExtension()` registers a SINGLE service extension named
 * `ext.flutter.driver` that dispatches on a `command` param — there are NO
 * per-command methods like `ext.flutter.driver.tap`. (The old code called
 * those and failed with "Unknown method" (-32601) on every action, silently
 * falling back to the much slower Appium path.)
 *
 * Command serialization mirrors flutter_driver's Command.serialize():
 *   { command: 'tap'|'waitFor'|'enter_text'|..., timeout: <ms string>,
 *     ...finder.serialize() }   // finderType, keyValueString, text, etc.
 * The extension replies { isError: bool, response: {...} }.
 */

// --- Finder Types ---

export type FinderType = 'ByValueKey' | 'ByText' | 'ByType' | 'BySemanticsLabel' | 'ByTooltipMessage';

function buildFinder(by: string, value: string): Record<string, string> {
  switch (by) {
    case 'key':
      return { finderType: 'ByValueKey', keyValueString: value, keyValueType: 'String' };
    case 'text':
      return { finderType: 'ByText', text: value };
    case 'type':
      return { finderType: 'ByType', type: value };
    case 'semanticsLabel':
      return { finderType: 'BySemanticsLabel', label: value, isRegExp: 'false' };
    case 'tooltip':
      return { finderType: 'ByTooltipMessage', text: value };
    default:
      throw new Error(`Unsupported VM finder type: ${by}`);
  }
}

/** Invoke one flutter_driver command through the single ext.flutter.driver endpoint. */
async function driverCommand(
  client: DartVMClient,
  command: string,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const result = await client.callServiceExtension('ext.flutter.driver', {
    command,
    ...params,
  }) as { isError?: boolean; response?: unknown };

  if (result && result.isError) {
    throw new Error(`flutter_driver ${command} failed: ${JSON.stringify(result.response ?? result)}`);
  }
  return (result?.response ?? {}) as Record<string, unknown>;
}

const msTimeout = (seconds: number | undefined, fallbackSec: number): string =>
  String(Math.round((seconds ?? fallbackSec) * 1000));

// --- Actions ---

export async function vmTap(client: DartVMClient, by: string, value: string, timeout?: number): Promise<void> {
  const finder = buildFinder(by, value);
  const startMs = Date.now();

  // Wait for element first (same contract as FlutterDriver.tap's implicit wait)
  await vmWaitFor(client, by, value, timeout || 10);

  await driverCommand(client, 'tap', {
    ...finder,
    timeout: msTimeout(timeout, 10),
  });

  logger.info('VM tap', { by, value, elapsedMs: Date.now() - startMs });
}

export async function vmEnterText(client: DartVMClient, text: string): Promise<void> {
  const startMs = Date.now();

  await driverCommand(client, 'enter_text', { text });

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

  await driverCommand(client, 'scroll', {
    ...finder,
    dx: String(dx),
    dy: String(dy),
    duration: String(durationMs * 1000), // Scroll serializes duration in MICROseconds
    frequency: '60',
    timeout: msTimeout(timeout, 10),
  });

  logger.info('VM scroll', { by, value, dx, dy });
}

export async function vmWaitFor(client: DartVMClient, by: string, value: string, timeout: number = 10): Promise<void> {
  const finder = buildFinder(by, value);

  await driverCommand(client, 'waitFor', {
    ...finder,
    timeout: msTimeout(timeout, 10),
  });
}

export async function vmWaitForAbsent(client: DartVMClient, by: string, value: string, timeout: number = 10): Promise<void> {
  const finder = buildFinder(by, value);

  await driverCommand(client, 'waitForAbsent', {
    ...finder,
    timeout: msTimeout(timeout, 10),
  });
}

export async function vmGetText(client: DartVMClient, by: string, value: string, timeout?: number): Promise<string> {
  const finder = buildFinder(by, value);

  const response = await driverCommand(client, 'get_text', {
    ...finder,
    timeout: msTimeout(timeout, 10),
  });

  return typeof response.text === 'string' ? response.text : '';
}

export async function vmScreenshot(client: DartVMClient): Promise<Buffer> {
  // Screenshot is NOT a flutter_driver command — it's the VM's _flutter.screenshot.
  const result = await client.callServiceExtension('_flutter.screenshot', {}) as { screenshot?: string };
  const base64 = (result as any)?.screenshot;
  if (!base64) throw new Error('VM screenshot returned empty');
  return Buffer.from(base64, 'base64');
}

export async function vmWaitForCondition(
  client: DartVMClient,
  condition: 'NoPendingFrame' | 'FirstFrameRasterized' | 'NoPendingPlatformMessages' | 'CombinedCondition',
  timeout: number = 30,
): Promise<void> {
  await driverCommand(client, 'waitForCondition', {
    conditionName: condition,
    timeout: msTimeout(timeout, 30),
  });
}

/**
 * Check if a Flutter locator strategy can be handled by the VM client.
 */
export function isVMCompatibleLocator(by: string): boolean {
  return ['key', 'text', 'type', 'semanticsLabel', 'tooltip'].includes(by);
}

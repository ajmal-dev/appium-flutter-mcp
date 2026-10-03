import { z } from 'zod';
import { getVMClient, connectVM, connectVMAutoDiscover } from '../vm/vm-session.js';
import { SelectModeController, SelectModeUnavailableError } from '../vm/select-mode-controller.js';
import { verifyLocator } from '../vm/verify-locator.js';
import { loadConfig } from '../util/config.js';
import { logger } from '../util/logger.js';
import { getSessionMode } from '../appium/session.js';
import type { McpToolResponse } from '../types.js';

const SELECT_MODE_EXTENSION = 'ext.flutter.inspector.show';

// Module-level singleton — one select-mode session at a time, mirroring the VM
// session singleton.
let controller: SelectModeController | null = null;

export const startTapInspectSchema = z.object({
  vmServiceUrl: z
    .string()
    .optional()
    .describe(
      'Dart VM Service WebSocket URL (e.g. ws://127.0.0.1:PORT/TOKEN=/ws). ' +
        'If omitted, reuses the active VM connection or auto-discovers. Auto-discovery ' +
        'only works when the app was launched with --disable-service-auth-codes.',
    ),
});

export const getTapSelectionSchema = z.object({});

export const stopTapInspectSchema = z.object({});

function text(obj: unknown): McpToolResponse {
  return { content: [{ type: 'text' as const, text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}

export async function handleStartTapInspect(
  params: z.infer<typeof startTapInspectSchema>,
): Promise<McpToolResponse> {
  const sessionMode = getSessionMode();
  if (sessionMode !== 'flutter') {
    return text({
      error: `start_tap_inspect is Flutter-only (current sessionMode = "${sessionMode}"). It uses the Flutter inspector extension over the Dart VM.`,
    });
  }
  // Ensure a connected VM client.
  let client = getVMClient();
  if (!client) {
    try {
      if (params.vmServiceUrl) {
        await connectVM(params.vmServiceUrl);
      } else {
        const r = await connectVMAutoDiscover();
        if (!r) {
          return text({
            error: 'No Dart VM Service connection. Launch the app with `flutter run --debug` ' +
              'and pass vmServiceUrl (the ws:// URL from the run output), or connect first.',
          });
        }
      }
      client = getVMClient();
    } catch (err) {
      return text({ error: `VM connect failed: ${msg(err)}` });
    }
  }
  if (!client) return text({ error: 'VM client unavailable after connect.' });

  if (!client.hasExtension(SELECT_MODE_EXTENSION)) {
    return text({
      error: 'Widget select mode is unavailable — this is a release/profile build. ' +
        'The inspector extensions exist only in DEBUG builds. Relaunch with `flutter run --debug`.',
    });
  }

  const cfg = loadConfig();
  if (!controller) {
    controller = new SelectModeController(client, {
      flutterAppPath: cfg.flutterAppPath,
      flutterComponentsPath: cfg.flutterComponentsPath,
    });
    controller.on('error', (e: Error) => logger.debug('tap-inspect controller error', { error: e.message }));
  }

  try {
    await controller.enable();
  } catch (err) {
    if (err instanceof SelectModeUnavailableError) {
      controller = null;
      return text({ error: err.message });
    }
    return text({ error: `Failed to enable select mode: ${msg(err)}` });
  }

  return text({
    status: 'inspecting',
    message:
      'Select mode is ON. Physically tap a widget on the device, then call get_tap_selection ' +
      'to read what you tapped. Call stop_tap_inspect when done.',
  });
}

export async function handleGetTapSelection(): Promise<McpToolResponse> {
  if (!controller || !controller.active) {
    return text({ error: 'Select mode is not active. Call start_tap_inspect first.' });
  }
  let selection;
  try {
    selection = await controller.getCurrentSelection();
  } catch (err) {
    return text({ error: `Could not read selection: ${msg(err)}` });
  }
  if (!selection) {
    return text({
      status: 'no_selection',
      message: 'Nothing is selected yet. Tap a widget on the device, then call get_tap_selection again.',
    });
  }

  const source = selection.creationLocation
    ? `${selection.creationLocation.file}:${selection.creationLocation.line}` +
      (selection.creationLocation.resolvedPath ? ` (on disk: ${selection.creationLocation.resolvedPath})` : '')
    : undefined;

  // When the tapped leaf is a framework / .pub-cache widget (e.g. a generic ZDS button), the
  // nearest APP-source ancestor — the widget you actually authored — is far more useful for
  // finding where to add a key. Surfaced as `appSource`; `source` stays the raw leaf.
  const appSource = selection.appSource
    ? `${selection.appSource.file}:${selection.appSource.line} (on disk: ${selection.appSource.resolvedPath})`
    : undefined;

  return text({
    type: selection.type,
    key: selection.key,
    text: selection.text,
    semanticsLabel: selection.semanticsLabel,
    source,
    ...(appSource ? { appSource } : {}),
    uniqueLocator: selection.uniqueLocator
      ? { strategy: selection.uniqueLocator.strategy, java: selection.uniqueLocator.java, explanation: selection.uniqueLocator.explanation }
      : null,
    recommendedLocator: selection.javaLines[0] ?? null,
    javaLines: selection.javaLines,
    allLocators: selection.locators,
    position: selection.position,
  });
}

export const verifyLocatorSchema = z.object({
  by: z.enum(['key', 'text', 'type', 'semanticsLabel']).describe('Locator strategy to check'),
  value: z.string().describe('Locator value to search for on the current screen'),
});

export async function handleVerifyLocator(
  params: z.infer<typeof verifyLocatorSchema>,
): Promise<McpToolResponse> {
  const sessionMode = getSessionMode();
  if (sessionMode !== 'flutter') {
    return text({
      error: `verify_locator is Flutter-only (current sessionMode = "${sessionMode}"). It walks the Dart VM widget tree, which doesn't exist in Safari/native sessions.`,
    });
  }
  const client = getVMClient();
  if (!client) {
    return text({
      error: 'No Dart VM Service connection. Call start_tap_inspect (or connect) first.',
    });
  }
  try {
    const r = await verifyLocator(client, params.by, params.value, { highlight: true });
    const verdict = r.matchCount === 0 ? 'NOT FOUND' : r.matchCount === 1 ? 'UNIQUE' : 'NOT UNIQUE';
    return text({
      by: r.by,
      value: r.value,
      matchCount: r.matchCount,
      unique: r.unique,
      verdict,
      highlighted: r.highlighted,
      driverFound: r.driverFound,
      matches: r.matches,
    });
  } catch (err) {
    return text({ error: `Verify failed: ${msg(err)}` });
  }
}

export async function handleStopTapInspect(): Promise<McpToolResponse> {
  if (controller) {
    try { await controller.disable(); } catch { /* ignore */ }
    controller.removeAllListeners();
    controller = null;
  }
  return text({ status: 'stopped' });
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

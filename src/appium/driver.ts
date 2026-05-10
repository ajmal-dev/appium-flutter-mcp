import { getBrowser } from './session.js';
import { logger } from '../util/logger.js';

// --- Flutter Finders ---
// NOTE: WebDriverIO v9's $() treats unknown prefixes as CSS selectors.
// We use findElement/findElements (raw W3C protocol) so the FlutterIntegration
// driver on the Appium server receives the correct custom strategy.

type FindStrategy = 'key' | 'text' | 'textContains' | 'type' | 'semantics label' | 'tooltip';

const FLUTTER_STRATEGY_MAP: Record<FindStrategy, string> = {
  'key': '-flutter key',
  'text': '-flutter text',
  'textContains': '-flutter textContaining',
  'type': '-flutter type',
  'semantics label': '-flutter semantics label',
  'tooltip': '-flutter tooltip',
};

export async function flutterFind(strategy: FindStrategy, selector: string) {
  const browser = getBrowser();
  const using = FLUTTER_STRATEGY_MAP[strategy];
  const rawElement = await browser.findElement(using, selector);
  return browser.$(rawElement);
}

export async function flutterFindAll(strategy: FindStrategy, selector: string) {
  const browser = getBrowser();
  const using = FLUTTER_STRATEGY_MAP[strategy];
  const rawElements = await browser.findElements(using, selector);
  return Promise.all(rawElements.map(el => browser.$(el)));
}

export async function findByValueKey(key: string) {
  return flutterFind('key', key);
}

export async function findByText(text: string) {
  return flutterFind('text', text);
}

export async function findByType(type: string) {
  return flutterFind('type', type);
}

export async function findBySemanticsLabel(label: string) {
  return flutterFind('semantics label', label);
}

export async function findAllByType(type: string) {
  return flutterFindAll('type', type);
}

// --- Flutter Execute Commands ---

export async function executeFlutterCommand(command: string, params?: Record<string, unknown>) {
  const browser = getBrowser();
  return browser.execute(`flutter: ${command}`, params || {});
}

export async function getRenderTree(filters?: { widgetType?: string; text?: string; key?: string }) {
  const browser = getBrowser();
  try {
    const result = await browser.execute('flutter: renderTree', filters || {});
    return result;
  } catch (error) {
    logger.warn('flutter:renderTree failed — may be release build or unsupported', { error: String(error) });
    return null;
  }
}

export async function getWidgetDiagnostics(elementId: string) {
  const browser = getBrowser();
  try {
    return await browser.execute('flutter: getWidgetDiagnostics', { element: elementId });
  } catch (error) {
    logger.warn('getWidgetDiagnostics failed', { elementId, error: String(error) });
    return null;
  }
}

export async function getSemanticsId(elementId: string) {
  const browser = getBrowser();
  try {
    return await browser.execute('flutter: getSemanticsId', { element: elementId });
  } catch (error) {
    logger.debug('getSemanticsId failed', { elementId, error: String(error) });
    return null;
  }
}

// --- Element Operations ---

export async function getElementText(element: WebdriverIO.Element): Promise<string> {
  try {
    return await element.getText();
  } catch {
    return '';
  }
}

export async function getElementRect(element: WebdriverIO.Element): Promise<{ x: number; y: number; width: number; height: number } | null> {
  try {
    const rect = await element.getSize();
    const loc = await element.getLocation();
    return { x: loc.x, y: loc.y, width: rect.width, height: rect.height };
  } catch {
    return null;
  }
}

export async function isElementDisplayed(element: WebdriverIO.Element): Promise<boolean> {
  try {
    return await element.isDisplayed();
  } catch {
    return false;
  }
}

export async function isElementEnabled(element: WebdriverIO.Element): Promise<boolean> {
  try {
    return await element.isEnabled();
  } catch {
    return false;
  }
}

// --- Gestures ---

export async function flutterDoubleClick(elementId: string) {
  return executeFlutterCommand('doubleClick', { origin: { element: elementId } });
}

export async function flutterLongPress(elementId: string) {
  return executeFlutterCommand('longPress', { origin: { element: elementId } });
}

export async function flutterDragAndDrop(sourceId: string, targetId: string) {
  return executeFlutterCommand('dragAndDrop', {
    source: { element: sourceId },
    target: { element: targetId },
  });
}

export async function flutterScrollTillVisible(
  finder: { strategy: string; selector: string },
  options?: { scrollDirection?: string; delta?: number; maxScrolls?: number },
) {
  return executeFlutterCommand('scrollTillVisible', {
    finder,
    scrollDirection: options?.scrollDirection || 'down',
    delta: options?.delta || 100,
    maxScrolls: options?.maxScrolls || 15,
  });
}

// --- Wait ---

export async function flutterWaitForVisible(strategy: string, selector: string, timeout: number = 5000) {
  return executeFlutterCommand('waitForVisible', {
    locator: { strategy, selector },
    timeout,
  });
}

export async function flutterWaitForAbsent(strategy: string, selector: string, timeout: number = 5000) {
  return executeFlutterCommand('waitForAbsent', {
    locator: { strategy, selector },
    timeout,
  });
}

// --- Native Finders (for permission dialogs, native-rendered WebView elements) ---

export async function nativeFindByXPath(xpath: string) {
  const browser = getBrowser();
  return browser.$(xpath);
}

export async function nativeFindByAccessibilityId(id: string) {
  const browser = getBrowser();
  return browser.$(`~${id}`);
}

// --- WebView Finders ---

export async function webFindByCss(selector: string) {
  const browser = getBrowser();
  return browser.$(selector);
}

export async function webFindByXPath(xpath: string) {
  const browser = getBrowser();
  return browser.$(xpath);
}

export async function webExecuteScript(script: string, args?: unknown[]) {
  const browser = getBrowser();
  return browser.execute(script, ...(args || []));
}

import { getBrowser } from '../appium/session.js';
import { logger } from '../util/logger.js';

export interface ElementDiagnostics {
  widgetDiagnostics: unknown;
  renderDiagnostics: unknown;
  attributes: Record<string, string | null>;
}

/**
 * Get full diagnostics for a specific element.
 * This is expensive — used only for the get_element_details tool.
 */
export async function getElementDiagnostics(
  strategy: string,
  selector: string,
): Promise<ElementDiagnostics | null> {
  const browser = getBrowser();

  try {
    const flutterStrategyMap: Record<string, string> = {
      'key': '-flutter key',
      'text': '-flutter text',
      'type': '-flutter type',
      'semantics label': '-flutter semantics label',
    };
    const using = flutterStrategyMap[strategy] || `-flutter ${strategy}`;
    const rawElement = await browser.findElement(using, selector);
    const element = await browser.$(rawElement);
    if (!element) return null;

    const [widgetDiag, renderDiag, text, displayed, enabled] = await Promise.allSettled([
      browser.execute('flutter: getWidgetDiagnostics', {
        element: element.elementId,
        subtreeDepth: 2,
        includeProperties: true,
      }),
      browser.execute('flutter: getRenderObjectDiagnostics', {
        element: element.elementId,
        subtreeDepth: 1,
        includeProperties: true,
      }),
      element.getText(),
      element.isDisplayed(),
      element.isEnabled(),
    ]);

    return {
      widgetDiagnostics: widgetDiag.status === 'fulfilled' ? widgetDiag.value : null,
      renderDiagnostics: renderDiag.status === 'fulfilled' ? renderDiag.value : null,
      attributes: {
        text: text.status === 'fulfilled' ? text.value : null,
        displayed: displayed.status === 'fulfilled' ? String(displayed.value) : null,
        enabled: enabled.status === 'fulfilled' ? String(enabled.value) : null,
      },
    };
  } catch (error) {
    logger.error('Failed to get element diagnostics', { strategy, selector, error: String(error) });
    return null;
  }
}

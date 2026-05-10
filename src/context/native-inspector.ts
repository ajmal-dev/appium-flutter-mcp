import { getBrowser } from '../appium/session.js';
import { getCurrentContext, switchToNative } from './context-manager.js';
import { logger } from '../util/logger.js';

export interface NativeElement {
  type: string;
  text?: string;
  label?: string;
  value?: string;
  enabled?: boolean;
  visible?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
}

export async function getNativePageSource(): Promise<string> {
  const browser = getBrowser();
  const ctx = await getCurrentContext();

  if (ctx !== 'NATIVE_APP') {
    await switchToNative();
  }

  return browser.getPageSource();
}

/**
 * Parse native page source XML into structured JSON elements.
 * Inspired by mobile-mcp's accessibility-first approach.
 * Extracts visible, interactive elements with their properties.
 */
export async function getNativeElementsStructured(): Promise<NativeElement[]> {
  const source = await getNativePageSource();
  return parseNativeXmlToElements(source);
}

function parseNativeXmlToElements(xml: string): NativeElement[] {
  const elements: NativeElement[] = [];

  // Regex-based extraction of element attributes from XML nodes
  // Matches self-closing tags: <XCUIElementTypeButton name="Allow" label="Allow" ... />
  // and Android: <android.widget.Button text="Allow" resource-id="..." ... />
  const tagPattern = /<(\w[\w.]*)\s+([^>]*?)\/>/g;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(xml)) !== null) {
    const tagName = match[1];
    const attrs = match[2];

    // Skip non-interactive/invisible elements
    const visible = getAttr(attrs, 'visible') || getAttr(attrs, 'isVisible');
    if (visible === 'false' || visible === '0') continue;

    // Extract type (simplify iOS type names)
    let type = tagName;
    if (type.startsWith('XCUIElementType')) {
      type = type.replace('XCUIElementType', '');
    }
    if (type.startsWith('android.widget.')) {
      type = type.replace('android.widget.', '');
    }

    // Skip container-only types
    const skipTypes = new Set(['Application', 'Window', 'Other', 'Group', 'Cell']);
    if (skipTypes.has(type)) continue;

    const text = getAttr(attrs, 'text') || getAttr(attrs, 'value') || getAttr(attrs, 'label');
    const name = getAttr(attrs, 'name') || getAttr(attrs, 'resource-id') || getAttr(attrs, 'accessibility-id');
    const enabled = getAttr(attrs, 'enabled') !== 'false' && getAttr(attrs, 'isEnabled') !== '0';

    // Parse bounds/rect
    let rect: NativeElement['rect'] | undefined;
    const bounds = getAttr(attrs, 'bounds');
    if (bounds) {
      // Android format: [left,top][right,bottom]
      const boundsMatch = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
      if (boundsMatch) {
        const [, x1, y1, x2, y2] = boundsMatch.map(Number);
        rect = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
      }
    }
    const x = getAttr(attrs, 'x');
    const y = getAttr(attrs, 'y');
    const w = getAttr(attrs, 'width');
    const h = getAttr(attrs, 'height');
    if (x && y && w && h) {
      rect = { x: Number(x), y: Number(y), width: Number(w), height: Number(h) };
    }

    // Only include elements that have some identifying info
    if (text || name || type === 'Button' || type === 'TextField' || type === 'SecureTextField' ||
        type === 'StaticText' || type === 'Image' || type === 'Switch' ||
        type === 'EditText' || type === 'ImageView' || type === 'CheckBox') {
      elements.push({
        type,
        text: text || undefined,
        label: name || undefined,
        enabled,
        visible: true,
        rect,
      });
    }
  }

  // Also match non-self-closing tags with content
  const openTagPattern = /<(\w[\w.]*)\s+([^>]*?)>([^<]*)<\/\1>/g;
  while ((match = openTagPattern.exec(xml)) !== null) {
    const tagName = match[1];
    const attrs = match[2];
    const content = match[3].trim();

    if (!content) continue;

    let type = tagName;
    if (type.startsWith('XCUIElementType')) type = type.replace('XCUIElementType', '');
    if (type.startsWith('android.widget.')) type = type.replace('android.widget.', '');

    elements.push({
      type,
      text: content,
      label: getAttr(attrs, 'name') || getAttr(attrs, 'resource-id') || undefined,
      visible: true,
    });
  }

  logger.info(`Parsed ${elements.length} native elements from page source`);
  return elements;
}

/**
 * Get native elements as InteractiveElement[] for use by locator tools.
 */
export async function getNativeInteractiveElements(): Promise<import('../tree/types.js').InteractiveElement[]> {
  const nativeElements = await getNativeElementsStructured();
  return nativeElements.map((el, i) => ({
    index: i,
    type: el.type,
    text: el.text || el.label,
    key: undefined,
    enabled: el.enabled !== false,
    displayed: el.visible !== false,
    position: el.rect,
    locator: { by: 'accessibilityId', value: el.label || el.text || el.type },
    context: 'NATIVE_APP',
  }));
}

function getAttr(attrs: string, name: string): string | null {
  const pattern = new RegExp(`${name}="([^"]*?)"`);
  const match = attrs.match(pattern);
  return match ? match[1] : null;
}

import { app, BrowserWindow, ipcMain } from 'electron';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { DartVMClient } from '../vm/dart-vm-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { buildVMWidgetTree, findNodeAtPosition } from '../vm/vm-widget-tree.js';
import type { VMWidgetNode } from '../vm/vm-widget-tree.js';
import { captureDeviceScreenshot, detectPlatform } from '../vm/device-screenshot.js';
import type { DevicePlatform } from '../vm/device-screenshot.js';

// --- HTTP helpers ---
function httpGet(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 15000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function httpPost(url: string, body: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = JSON.stringify(body);
    const req = http.request({
      hostname: urlObj.hostname, port: urlObj.port, path: urlObj.pathname,
      method: 'POST', timeout: 30000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(postData);
    req.end();
  });
}

// --- State ---
let mainWindow: BrowserWindow | null = null;
let vmClient: DartVMClient | null = null;
let currentTree: VMWidgetNode | null = null;
let screenshotInterval: ReturnType<typeof setInterval> | null = null;
let platform: DevicePlatform = 'ios';
let appiumSessionId: string = '';

// Device metrics — on iOS, Appium logical points = Flutter logical pixels (1:1)
let devicePixelRatio: number = 1.0;
let statusBarHeight: number = 0;
let screenWidth: number = 0;
let screenHeight: number = 0;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 900,
    title: 'Flutter Widget Inspector',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; cleanup(); });
}

async function cleanup() {
  if (screenshotInterval) { clearInterval(screenshotInterval); screenshotInterval = null; }
  if (vmClient) { try { await vmClient.dispose(); } catch {} vmClient = null; }
  // Don't delete Appium session — it may be shared
}

// --- Fetch device metrics + render tree positions ---

interface RenderInfo {
  type: string;
  x: number; y: number; width: number; height: number;
  creatorWidget?: string;
}

let renderPositions: RenderInfo[] = [];

async function fetchDeviceMetrics() {
  if (!vmClient?.connected) return;
  try {
    // Parse the text render tree dump to get positions
    const result = await vmClient.callServiceExtension('ext.flutter.debugDumpRenderTree', {}) as any;
    const dump = result?.data || '';
    if (typeof dump === 'string' && dump.length > 0) {
      // Extract device info from header
      const dprMatch = dump.match(/device pixel ratio:\s*([0-9.]+)/);
      if (dprMatch) {
        const physicalRatio = parseFloat(dprMatch[1]);
        // Appium returns logical points on iOS, same as Flutter logical pixels
        devicePixelRatio = 1.0;
        console.log('[Inspector] Device pixel ratio:', physicalRatio, '(using 1:1 for Appium logical)');
      }
      const sizeMatch = dump.match(/constraints:\s*BoxConstraints\(w=([0-9.]+),\s*h=([0-9.]+)\)/);
      if (sizeMatch) {
        screenWidth = parseFloat(sizeMatch[1]);
        screenHeight = parseFloat(sizeMatch[2]);
        console.log('[Inspector] Screen size:', screenWidth, 'x', screenHeight);
      }

      // Parse render objects with sizes and positions
      renderPositions = parseRenderDump(dump);
      console.log('[Inspector] Parsed', renderPositions.length, 'render objects with positions');
    }
  } catch (err) {
    console.log('[Inspector] fetchDeviceMetrics failed:', String(err).slice(0, 100));
  }
}

function parseRenderDump(dump: string): RenderInfo[] {
  const results: RenderInfo[] = [];
  // Split by render object entries (lines starting with various indent + Render*)
  const lines = dump.split('\n');
  let currentType = '';
  let currentSize = { w: 0, h: 0 };
  let currentOffset = { x: 0, y: 0 };
  let creatorWidget = '';

  for (const line of lines) {
    // Match render object header: "RenderFoo#hexid" or "child: RenderFoo#hexid"
    const typeMatch = line.match(/(Render\w+)#[a-f0-9]+/);
    if (typeMatch) {
      // Save previous
      if (currentType && currentSize.w > 0 && currentSize.w < screenWidth * 2) {
        results.push({
          type: currentType, x: currentOffset.x, y: currentOffset.y,
          width: currentSize.w, height: currentSize.h,
          creatorWidget: creatorWidget || undefined,
        });
      }
      currentType = typeMatch[1];
      currentSize = { w: 0, h: 0 };
      currentOffset = { x: 0, y: 0 };
      creatorWidget = '';
    }

    // Match size
    const sizeM = line.match(/size:\s*Size\(([0-9.]+),\s*([0-9.]+)\)/);
    if (sizeM) {
      currentSize = { w: parseFloat(sizeM[1]), h: parseFloat(sizeM[2]) };
    }

    // Match offset in parentData
    const offsetM = line.match(/offset:\s*Offset\(([0-9.]+),\s*([0-9.]+)\)/);
    if (offsetM) {
      currentOffset = { x: parseFloat(offsetM[1]), y: parseFloat(offsetM[2]) };
    }

    // Match creator widget
    const creatorM = line.match(/creator:\s*(\w+)/);
    if (creatorM) {
      creatorWidget = creatorM[1];
    }
  }

  // Save last
  if (currentType && currentSize.w > 0) {
    results.push({
      type: currentType, x: currentOffset.x, y: currentOffset.y,
      width: currentSize.w, height: currentSize.h,
      creatorWidget: creatorWidget || undefined,
    });
  }

  return results;
}

// Find render object closest to screen coordinates
function findRenderAtPosition(x: number, y: number): RenderInfo | null {
  let best: RenderInfo | null = null;
  let bestArea = Infinity;
  for (const r of renderPositions) {
    if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) {
      const area = r.width * r.height;
      if (area < bestArea && area > 10) { // skip tiny elements
        bestArea = area;
        best = r;
      }
    }
  }
  return best;
}

// --- IPC: Connection ---

ipcMain.handle('vm:connect', async (_event, url: string) => {
  console.log('[Inspector] Connecting to VM:', url);
  try {
    if (vmClient) { await vmClient.dispose(); vmClient = null; }
    vmClient = new DartVMClient();
    const result = await vmClient.connect(url);
    console.log('[Inspector] Connected:', result.isolateName, 'extensions:', result.extensions.length);

    // Fetch device metrics for coordinate mapping
    await fetchDeviceMetrics();

    return { success: true, ...result };
  } catch (err) {
    console.error('[Inspector] Connect failed:', err);
    vmClient = null;
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('vm:autoDiscover', async () => {
  try { return { urls: await DartVMClient.discoverVMServiceUrls() }; }
  catch { return { urls: [] }; }
});

ipcMain.handle('vm:disconnect', async () => { await cleanup(); return { success: true }; });

// --- IPC: Widget Tree ---

ipcMain.handle('vm:getWidgetTree', async () => {
  if (!vmClient || !vmClient.connected) return { error: 'Not connected' };
  try {
    const widgetTree = await buildVMWidgetTree(vmClient, platform);
    currentTree = widgetTree.tree as VMWidgetNode;

    // Also deep-enrich the interactive elements with locator info
    const enrichedElements = [];
    for (const el of widgetTree.interactiveElements) {
      // Quick deep extraction for each element to get keys/text
      const node = findNodeInTree(currentTree, el.locator?.value, el.type);
      if (node?.valueId && vmClient.connected) {
        try {
          const locators = await extractDeepLocators(vmClient, node.valueId, el.type);
          const bestKey = locators.find(l => l.by === 'key');
          const bestText = locators.find(l => l.by === 'text');
          enrichedElements.push({
            ...el,
            key: bestKey?.value || el.key,
            text: bestText?.value || el.text,
            locator: bestKey ? { by: 'key', value: bestKey.value } : (bestText ? { by: 'text', value: bestText.value } : el.locator),
          });
          continue;
        } catch {}
      }
      enrichedElements.push(el);
    }

    return {
      elementCount: widgetTree.elementCount,
      interactiveCount: widgetTree.interactiveCount,
      elements: enrichedElements,
    };
  } catch (err) {
    return { error: String(err) };
  }
});

function findNodeInTree(tree: VMWidgetNode, locatorValue: string | undefined, type: string): VMWidgetNode | null {
  if (!tree) return null;
  if (tree.type === type && (tree.key === locatorValue || tree.text === locatorValue)) return tree;
  if (tree.type === type && !locatorValue) return tree;
  if (tree.children) {
    for (const child of tree.children as VMWidgetNode[]) {
      const found = findNodeInTree(child, locatorValue, type);
      if (found) return found;
    }
  }
  return null;
}

// --- IPC: Click-to-Inspect ---

ipcMain.handle('vm:findWidgetAt', async (_event, screenX: number, screenY: number) => {
  console.log('[Inspector] Finding widget at screen coords:', screenX, screenY);

  // Convert screen coordinates (from screenshot/Appium) to Flutter logical coordinates
  // On iOS, Appium window/rect and Flutter both use logical points, so ratio is ~1:1
  const flutterX = screenX / devicePixelRatio;
  const flutterY = screenY / devicePixelRatio;
  console.log('[Inspector] Flutter logical coords:', flutterX, flutterY, '(ratio:', devicePixelRatio, ')');

  // Strategy 1: VM tree position lookup with coordinate mapping
  if (currentTree) {
    const node = findNodeAtPosition(currentTree, flutterX, flutterY);
    if (node) {
      console.log('[Inspector] VM tree hit:', node.type, node.key || node.text || '');
      let locators = node.allLocators;
      if (vmClient?.connected && node.valueId) {
        try {
          const deep = await extractDeepLocators(vmClient, node.valueId, node.type);
          if (deep.length > 0) locators = deep;
        } catch {}
      }
      return {
        type: node.type, key: node.key, text: node.text,
        semanticsLabel: node.semanticsLabel, position: node.position,
        creationLocation: node.creationLocation, valueId: node.valueId,
        locators,
      };
    }
    console.log('[Inspector] VM tree miss at logical coords');
  }

  // Strategy 2: Use parsed render tree text dump positions
  const renderHit = findRenderAtPosition(flutterX, flutterY);
  if (renderHit) {
    console.log('[Inspector] Render tree hit:', renderHit.type, renderHit.creatorWidget || '', 'at', renderHit.x, renderHit.y, renderHit.width, 'x', renderHit.height);
    // Try to find the creator widget in the VM tree and get its locators
    const widgetType = renderHit.creatorWidget || renderHit.type.replace('Render', '');
    let locators: Array<{ by: string; value: string; confidence: number }> = [
      { by: 'type', value: widgetType, confidence: 0.4 },
    ];

    // Walk VM tree to find matching widget and deep-extract locators
    if (currentTree && vmClient?.connected) {
      const matchingNode = findWidgetByTypeNearPosition(currentTree, widgetType, renderHit);
      if (matchingNode?.valueId) {
        try {
          const deep = await extractDeepLocators(vmClient, matchingNode.valueId, widgetType);
          if (deep.length > 0) locators = deep;
        } catch {}
      }
    }

    return {
      type: widgetType,
      position: { x: renderHit.x, y: renderHit.y, width: renderHit.width, height: renderHit.height },
      locators,
    };
  }

  // Strategy 3: Find closest interactive node in VM tree
  if (currentTree) {
    const closest = findClosestNode(currentTree, flutterX, flutterY, 100);
    if (closest) {
      console.log('[Inspector] Closest node:', closest.type);
      let locators = closest.allLocators;
      if (vmClient?.connected && closest.valueId) {
        try {
          const deep = await extractDeepLocators(vmClient, closest.valueId, closest.type);
          if (deep.length > 0) locators = deep;
        } catch {}
      }
      return { type: closest.type, key: closest.key, text: closest.text, position: closest.position, locators };
    }
  }

  return { error: `No widget found at (${Math.round(screenX)}, ${Math.round(screenY)}).` };
});

// Find widget in VM tree that matches type and is near a render position
function findWidgetByTypeNearPosition(tree: VMWidgetNode, widgetType: string, render: RenderInfo): VMWidgetNode | null {
  let best: VMWidgetNode | null = null;
  function walk(node: VMWidgetNode) {
    if (node.type === widgetType || node.type.includes(widgetType) || widgetType.includes(node.type)) {
      best = node; // Take first match — types in VM tree appear in same order as render tree
      return true;
    }
    if (node.children) {
      for (const child of node.children as VMWidgetNode[]) {
        if (walk(child)) return true;
      }
    }
    return false;
  }
  walk(tree);
  return best;
}

// Find closest interactive node within maxDistance
function findClosestNode(tree: VMWidgetNode, x: number, y: number, maxDistance: number): VMWidgetNode | null {
  let best: VMWidgetNode | null = null;
  let bestDist = maxDistance;

  function walk(node: VMWidgetNode) {
    if (node.position && node.interactive) {
      const cx = node.position.x + node.position.width / 2;
      const cy = node.position.y + node.position.height / 2;
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (dist < bestDist) { bestDist = dist; best = node; }
    }
    if (node.children) {
      for (const child of node.children as VMWidgetNode[]) walk(child);
    }
  }
  walk(tree);
  return best;
}

// --- IPC: WebView Inspection ---

ipcMain.handle('webview:inspect', async () => {
  if (!appiumSessionId) return { error: 'No Appium session' };
  try {
    // Get available contexts
    const ctxData = await httpGet(`http://127.0.0.1:4723/session/${appiumSessionId}/contexts`);
    const contexts: string[] = ctxData.value || [];
    const webviewContexts = contexts.filter((c: string) => c.startsWith('WEBVIEW'));

    if (webviewContexts.length === 0) {
      return { contexts, webviews: [], message: 'No WebView contexts found' };
    }

    // Get current context
    const currentCtxData = await httpGet(`http://127.0.0.1:4723/session/${appiumSessionId}/context`);
    const originalContext = currentCtxData.value;

    // Inspect each WebView
    const webviews = [];
    for (const wvCtx of webviewContexts) {
      try {
        // Switch to WebView
        await httpPost(`http://127.0.0.1:4723/session/${appiumSessionId}/context`, { name: wvCtx });
        // Get page source (HTML)
        const sourceData = await httpGet(`http://127.0.0.1:4723/session/${appiumSessionId}/source`);
        // Get current URL
        const urlData = await httpGet(`http://127.0.0.1:4723/session/${appiumSessionId}/url`);
        // Get title
        const titleData = await httpGet(`http://127.0.0.1:4723/session/${appiumSessionId}/title`);

        webviews.push({
          context: wvCtx,
          url: urlData.value || '',
          title: titleData.value || '',
          sourceLength: (sourceData.value || '').length,
          sourcePreview: (sourceData.value || '').slice(0, 500),
        });
      } catch (err) {
        webviews.push({ context: wvCtx, error: String(err).slice(0, 100) });
      }
    }

    // Restore original context
    try {
      await httpPost(`http://127.0.0.1:4723/session/${appiumSessionId}/context`, { name: originalContext });
    } catch {}

    return { contexts, webviews };
  } catch (err) {
    return { error: String(err) };
  }
});

// --- IPC: Native Inspection ---

ipcMain.handle('native:inspect', async () => {
  if (!appiumSessionId) return { error: 'No Appium session' };
  try {
    // Ensure we're in NATIVE_APP context
    const currentCtxData = await httpGet(`http://127.0.0.1:4723/session/${appiumSessionId}/context`);
    const originalContext = currentCtxData.value;

    if (originalContext !== 'NATIVE_APP') {
      await httpPost(`http://127.0.0.1:4723/session/${appiumSessionId}/context`, { name: 'NATIVE_APP' });
    }

    // Get page source XML
    const sourceData = await httpGet(`http://127.0.0.1:4723/session/${appiumSessionId}/source`);
    const xml = sourceData.value || '';

    // Parse into structured elements
    const elements = parseNativeXml(xml);

    // Restore context
    if (originalContext !== 'NATIVE_APP') {
      try {
        await httpPost(`http://127.0.0.1:4723/session/${appiumSessionId}/context`, { name: originalContext });
      } catch {}
    }

    return { elements, rawLength: xml.length };
  } catch (err) {
    return { error: String(err) };
  }
});

function parseNativeXml(xml: string): any[] {
  const elements: any[] = [];
  // Match elements with attributes
  const regex = /<(XCUIElementType\w+|android\.\w+[\w.]*)\s([^>]+?)\/?>|<(XCUIElementType\w+|android\.\w+[\w.]*)\s([^>]+?)>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const tag = match[1] || match[3];
    const attrs = match[2] || match[4];
    if (!attrs) continue;

    const el: any = { type: tag };
    const attrRegex = /(\w+)="([^"]*?)"/g;
    let am;
    while ((am = attrRegex.exec(attrs)) !== null) {
      el[am[1]] = am[2];
    }
    // Only include elements with useful info
    if (el.label || el.name || el.value || el.text) {
      elements.push({
        type: tag.replace('XCUIElementType', ''),
        label: el.label || el.name || el.text || '',
        value: el.value || '',
        enabled: el.enabled !== 'false',
        visible: el.visible !== 'false',
        x: parseInt(el.x || '0'), y: parseInt(el.y || '0'),
        width: parseInt(el.width || '0'), height: parseInt(el.height || '0'),
      });
    }
  }
  return elements;
}

// --- IPC: Screenshots ---

ipcMain.handle('device:screenshot', async () => {
  // Strategy 1: Appium session
  try {
    if (!appiumSessionId) {
      const { exec: execCb } = await import('child_process');
      const { promisify } = await import('util');
      const execP = promisify(execCb);
      let udid = '';
      try {
        const { stdout } = await execP('idevice_id -l 2>/dev/null', { timeout: 5000 });
        udid = stdout.trim().split('\n')[0] || '';
      } catch {}
      if (udid) {
        const created = await httpPost('http://127.0.0.1:4723/session', {
          capabilities: { alwaysMatch: {
            platformName: 'iOS', 'appium:automationName': 'XCUITest',
            'appium:udid': udid, 'appium:noReset': true, 'appium:newCommandTimeout': 600,
          }},
        });
        if (created.value?.sessionId) {
          appiumSessionId = created.value.sessionId;
          console.log('[Inspector] Appium session created:', appiumSessionId);
        }
      }
    }
    if (appiumSessionId) {
      const screenshotData = await httpGet(`http://127.0.0.1:4723/session/${appiumSessionId}/screenshot`);
      if (screenshotData.value?.length > 100) {
        const sizeData = await httpGet(`http://127.0.0.1:4723/session/${appiumSessionId}/window/rect`);
        const width = sizeData.value?.width || 1180;
        const height = sizeData.value?.height || 820;

        // Update coordinate mapping: Appium logical points vs Flutter logical pixels
        if (screenWidth > 0 && width > 0) {
          devicePixelRatio = screenWidth / width;
          if (Math.abs(devicePixelRatio - 1.0) < 0.1) devicePixelRatio = 1.0;
          console.log('[Inspector] Calibrated pixel ratio:', devicePixelRatio);
        }

        return { success: true, base64: screenshotData.value, width, height };
      }
    }
  } catch (err) {
    console.log('[Inspector] Appium screenshot failed:', String(err).slice(0, 100));
    appiumSessionId = '';
  }
  // Strategy 2: Device tools
  try {
    const detected = await detectPlatform();
    if (detected) platform = detected;
    const ss = await captureDeviceScreenshot(platform);
    return { success: true, ...ss };
  } catch (err) {
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('device:setPlatform', async (_e, p: string) => { platform = p as DevicePlatform; return {}; });

ipcMain.handle('screenshot:startStream', async (_e, intervalMs: number) => {
  if (screenshotInterval) clearInterval(screenshotInterval);
  screenshotInterval = setInterval(async () => {
    if (!appiumSessionId || !mainWindow || mainWindow.isDestroyed()) return;
    try {
      const sd = await httpGet(`http://127.0.0.1:4723/session/${appiumSessionId}/screenshot`);
      if (sd.value?.length > 100) {
        mainWindow.webContents.send('screenshot:update', { base64: sd.value, width: 1180, height: 820 });
      }
    } catch { appiumSessionId = ''; }
  }, intervalMs || 2000);
  return { streaming: true };
});

ipcMain.handle('screenshot:stopStream', async () => {
  if (screenshotInterval) { clearInterval(screenshotInterval); screenshotInterval = null; }
  return { streaming: false };
});

// --- Deep Locator Extraction ---

async function extractDeepLocators(
  client: DartVMClient, valueId: string, selectedType: string,
): Promise<Array<{ by: string; value: string; confidence: number }>> {
  const found = { keys: [] as string[], texts: [] as string[], semantics: [] as string[], tooltips: [] as string[] };

  async function deepWalk(vid: string, depth: number) {
    if (depth > 6 || (found.keys.length > 0 && found.texts.length > 0)) return;
    try {
      const details = await client.callServiceExtension(
        'ext.flutter.inspector.getDetailsSubtree',
        { arg: vid, objectGroup: 'inspector-group', subtreeDepth: 2 },
      ) as any;
      const node = details?.result || details;
      if (!node) return;
      extractFromProperties(node, found);
      if (node.children && Array.isArray(node.children)) {
        for (const child of node.children) {
          if (child?.valueId) await deepWalk(child.valueId, depth + 1);
        }
      }
    } catch {}
  }

  await deepWalk(valueId, 0);

  const locators: Array<{ by: string; value: string; confidence: number }> = [];
  for (const key of found.keys) locators.push({ by: 'key', value: key, confidence: 1.0 });
  for (const s of found.semantics) locators.push({ by: 'semanticsLabel', value: s, confidence: 0.9 });
  for (const t of found.texts) locators.push({ by: 'text', value: t, confidence: 0.8 });
  for (const t of found.tooltips) locators.push({ by: 'tooltip', value: t, confidence: 0.75 });
  locators.push({ by: 'type', value: selectedType.split('<')[0], confidence: 0.4 });
  return locators;
}

function extractFromProperties(node: any, found: { keys: string[]; texts: string[]; semantics: string[]; tooltips: string[] }) {
  if (!node.properties || !Array.isArray(node.properties)) return;
  for (const prop of node.properties) {
    const name = prop.name;
    const desc = prop.description;
    if (!desc || desc === 'null' || desc === '<null>') continue;
    if (name === 'key') {
      const m = desc.match(/(?:ValueKey|Key)\S*\(\s*'([^']+)'\s*\)/) || desc.match(/\[<'([^']+)'>\]/);
      if (m) found.keys.push(m[1]);
    }
    if (['data', 'text', 'hintText', 'labelText'].includes(name)) {
      const text = desc.replace(/^"|"$/g, '').trim();
      if (text && text.length < 200) found.texts.push(text);
    }
    if (['semanticLabel', 'semanticsLabel', 'label'].includes(name)) {
      found.semantics.push(desc.replace(/^"|"$/g, '').trim());
    }
    if (name === 'tooltip') found.tooltips.push(desc.replace(/^"|"$/g, '').trim());
  }
  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) extractFromProperties(child, found);
  }
}

// --- App Lifecycle ---
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { cleanup(); app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

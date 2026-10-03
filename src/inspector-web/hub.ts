import { EventEmitter } from 'events';
import { DartVMClient } from '../vm/dart-vm-client.js';
import { SelectModeController } from '../vm/select-mode-controller.js';
import { vmScreenshot } from '../vm/vm-actions.js';
import { captureDeviceScreenshot, detectPlatform } from '../vm/device-screenshot.js';
import { loadConfig } from '../util/config.js';
import { verifyLocator, findMatches } from '../vm/verify-locator.js';
import type { LocatorStrategy } from '../vm/verify-locator.js';
import { verifyCompoundLocator, type VerifyCompoundParams } from '../vm/alternative-locators.js';
import { transformWidgetSummaryTree, type VMWidgetNode } from '../vm/vm-widget-tree.js';
import { parsePath, evaluatePath, PathParseError } from '../vm/path-evaluator.js';
import { pathToJava } from '../vm/path-to-java.js';
import type { ServerMessage, TreeNodePayload } from './ws-protocol.js';
import { listWebViews, loadWebViewDom, highlightWebViewNode, verifyWebSelector, startWebInspect, stopWebInspect } from './webview-bridge.js';

/**
 * Owns a single DartVMClient + SelectModeController and translates their
 * lifecycle into ServerMessage broadcasts. The transport (WebSocket) subscribes
 * to 'broadcast' and forwards to every connected browser.
 *
 * Events: 'broadcast' (ServerMessage)
 */
export class InspectorHub extends EventEmitter {
  private client: DartVMClient | null = null;
  private controller: SelectModeController | null = null;
  private connectedUrl: string | undefined;
  private isolateName: string | undefined;

  // --- snapshot for new browser connections ---

  helloState(): Extract<ServerMessage, { type: 'hello' }> {
    return {
      type: 'hello',
      selectMode: this.controller?.active ?? false,
      vmState: this.client?.state ?? 'disconnected',
      url: this.connectedUrl,
    };
  }

  // --- commands ---

  async discover(): Promise<void> {
    const urls = await DartVMClient.discoverVMServiceUrls();
    this.broadcast({ type: 'discovered', urls });
  }

  async connect(url: string): Promise<void> {
    await this.disconnect();
    const client = new DartVMClient();
    this.client = client;
    this.connectedUrl = url;

    client.on('stateChange', (state) => {
      this.broadcast({ type: 'vmState', state, url: this.connectedUrl, isolateName: this.isolateName });
    });
    client.on('disconnected', () => {
      this.broadcast({ type: 'vmState', state: 'disconnected', url: this.connectedUrl });
    });
    client.on('reconnected', () => {
      this.broadcast({ type: 'vmState', state: 'connected', url: this.connectedUrl, isolateName: this.isolateName });
    });

    this.broadcast({ type: 'vmState', state: 'connecting', url });
    try {
      const info = await client.connect(url);
      this.isolateName = info.isolateName;
      const cfg = loadConfig();
      this.controller = new SelectModeController(client, {
        flutterAppPath: cfg.flutterAppPath,
        flutterComponentsPath: cfg.flutterComponentsPath,
      });
      this.wireController(this.controller);
      this.broadcast({ type: 'vmState', state: 'connected', url, isolateName: info.isolateName });
    } catch (err) {
      this.broadcast({ type: 'vmState', state: 'error', url, error: msg(err) });
      this.broadcast({ type: 'error', message: `Connect failed: ${msg(err)}` });
      await this.disconnect();
    }
  }

  async disconnect(): Promise<void> {
    // Capture-and-null up front so a concurrent connect/disconnect can't null
    // these out across the awaits below (which previously crashed on
    // removeAllListeners of null).
    const controller = this.controller;
    const client = this.client;
    this.controller = null;
    this.client = null;
    this.connectedUrl = undefined;
    this.isolateName = undefined;
    if (controller) {
      try { await controller.disable(); } catch { /* ignore */ }
      controller.removeAllListeners();
    }
    if (client) {
      try { await client.dispose(); } catch { /* ignore */ }
      client.removeAllListeners();
    }
  }

  async setSelectMode(enabled: boolean): Promise<void> {
    if (!this.controller) {
      this.broadcast({ type: 'error', message: 'Not connected to a Flutter app.' });
      return;
    }
    try {
      if (enabled) await this.controller.enable();
      else await this.controller.disable();
      this.broadcast({ type: 'selectModeState', enabled: this.controller.active });
    } catch (err) {
      this.broadcast({ type: 'selectModeState', enabled: this.controller.active });
      this.broadcast({ type: 'error', message: msg(err) });
    }
  }

  async verifyLocator(by: LocatorStrategy, value: string): Promise<void> {
    if (!this.client?.connected) {
      this.broadcast({ type: 'error', message: 'Not connected to a Flutter app.' });
      return;
    }
    if (!value) {
      this.broadcast({ type: 'error', message: 'Enter a locator value to check.' });
      return;
    }
    try {
      const r = await verifyLocator(this.client, by, value, { highlight: true });
      this.broadcast({
        type: 'verifyResult',
        by: r.by,
        value: r.value,
        matchCount: r.matchCount,
        unique: r.unique,
        driverFound: r.driverFound,
        highlighted: r.highlighted,
        selectedIndex: r.selectedIndex,
        indexedJava: r.indexedJava,
      });
    } catch (err) {
      this.broadcast({ type: 'error', message: `Verify failed: ${msg(err)}` });
    }
  }

  async verifyCompound(altIndex: number, params: VerifyCompoundParams): Promise<void> {
    if (!this.client?.connected) {
      this.broadcast({ type: 'error', message: 'Not connected to a Flutter app.' });
      return;
    }
    try {
      const r = await verifyCompoundLocator(this.client, params);
      this.broadcast({
        type: 'compoundVerifyResult',
        altIndex,
        kind: r.kind,
        matchCount: r.matchCount,
        unique: r.unique,
        detail: r.detail,
      });
    } catch (err) {
      this.broadcast({ type: 'error', message: `Compound verify failed: ${msg(err)}` });
    }
  }

  async loadFullTree(): Promise<void> {
    if (!this.client?.connected) {
      this.broadcast({ type: 'error', message: 'Not connected to a Flutter app.' });
      return;
    }
    try {
      const raw = await this.client.getRootWidget(`tree-explorer-${Date.now()}`);
      const root = transformWidgetSummaryTree(raw);
      let count = 0;
      const payload = toTreePayload(root, (): void => { count++; });
      this.broadcast({ type: 'fullTree', root: payload, totalNodes: count });
    } catch (err) {
      this.broadcast({ type: 'error', message: `Load full tree failed: ${msg(err)}` });
    }
  }

  async evaluatePath(query: string, highlight = true): Promise<void> {
    if (!this.client?.connected) {
      this.broadcast({ type: 'error', message: 'Not connected to a Flutter app.' });
      return;
    }
    const trimmed = query.trim();
    if (!trimmed) {
      this.broadcast({ type: 'pathResult', query, matchCount: 0, unique: false, matches: [], java: '', notes: [], error: 'Empty query.' });
      return;
    }
    try {
      const expr = parsePath(trimmed);
      const raw = await this.client.getRootWidget(`tree-explorer-eval-${Date.now()}`);
      const root = transformWidgetSummaryTree(raw);
      const nodes = evaluatePath(root, expr);
      const matches = nodes.slice(0, 50).map(n => ({
        type: n.type,
        key: n.key,
        text: n.text,
        semanticsLabel: (n as { semanticsLabel?: string }).semanticsLabel,
        valueId: (n as { valueId?: string }).valueId,
        position: n.position,
      }));
      const { java, notes } = pathToJava(expr);
      if (highlight && nodes[0]) {
        const vid = (nodes[0] as { valueId?: string }).valueId;
        if (vid) {
          try { await this.client.setSelectionById(vid); } catch { /* best-effort */ }
        }
      }
      this.broadcast({
        type: 'pathResult',
        query,
        matchCount: nodes.length,
        unique: nodes.length === 1,
        matches,
        java,
        notes,
      });
    } catch (err) {
      const message = err instanceof PathParseError ? err.message : msg(err);
      this.broadcast({
        type: 'pathResult',
        query,
        matchCount: 0,
        unique: false,
        matches: [],
        java: '',
        notes: [],
        error: message,
      });
    }
  }

  async highlightValueId(valueId: string): Promise<void> {
    if (!this.client?.connected) {
      this.broadcast({ type: 'error', message: 'Not connected to a Flutter app.' });
      return;
    }
    try {
      await this.client.setSelectionById(valueId);
    } catch (err) {
      this.broadcast({ type: 'error', message: `Highlight failed: ${msg(err)}` });
    }
  }

  async highlightIndex(by: LocatorStrategy, value: string, index: number): Promise<void> {
    if (!this.client?.connected) {
      this.broadcast({ type: 'error', message: 'Not connected to a Flutter app.' });
      return;
    }
    try {
      const matches = await findMatches(this.client, by, value);
      if (matches.length === 0) {
        this.broadcast({ type: 'error', message: `No matches for ${by}="${value}".` });
        return;
      }
      const i = Math.max(0, Math.min(index, matches.length - 1));
      const t = matches[i];
      if (t.valueId) {
        if (this.controller) await this.controller.highlightForValidation(t.valueId);
        else await this.client.setSelectionById(t.valueId);
      }
      this.broadcast({
        type: 'indexHighlight',
        by, value, index: i, matchCount: matches.length,
        targetType: t.type, targetKey: t.key, targetText: t.text,
      });
    } catch (err) {
      this.broadcast({ type: 'error', message: `Highlight failed: ${msg(err)}` });
    }
  }

  // --- WebView tab ---

  async listWebViews(): Promise<void> {
    try {
      const webviews = await listWebViews();
      this.broadcast({ type: 'webViewList', webviews });
    } catch (err) {
      this.broadcast({ type: 'error', message: `List webviews failed: ${msg(err)}` });
    }
  }

  async loadWebViewTree(contextId?: string): Promise<void> {
    try {
      const result = await loadWebViewDom(contextId);
      this.broadcast({ type: 'webviewTree', root: result.root, totalNodes: result.totalNodes, url: result.url, contextId: result.contextId });
    } catch (err) {
      this.broadcast({ type: 'error', message: `Load WebView DOM failed: ${msg(err)}` });
    }
  }

  async highlightWebViewNode(domId: number): Promise<void> {
    try {
      const r = await highlightWebViewNode(domId);
      this.broadcast({ type: 'webHighlightResult', domId, found: r.found, tag: r.tag, id: r.id, rect: r.rect });
    } catch (err) {
      this.broadcast({ type: 'error', message: `WebView highlight failed: ${msg(err)}` });
    }
  }

  async verifyWebSelector(by: 'css' | 'xpath', value: string): Promise<void> {
    try {
      const result = await verifyWebSelector(by, value);
      this.broadcast({ type: 'webVerifyResult', by, value, matchCount: result.matchCount, unique: result.unique });
    } catch (err) {
      this.broadcast({ type: 'error', message: `WebView verify failed: ${msg(err)}` });
    }
  }

  async startWebInspect(): Promise<void> {
    this.broadcast({ type: 'webInspectState', active: true });
    try {
      await startWebInspect((domId, fresh, tag, id, cls, rect) => {
        this.broadcast({ type: 'webInspectState', active: false });
        this.broadcast({ type: 'webviewTree', root: fresh.root, totalNodes: fresh.totalNodes, url: fresh.url, contextId: fresh.contextId });
        this.broadcast({ type: 'webInspectHit', domId, tag, id, cls, rect });
      });
    } catch (err) {
      this.broadcast({ type: 'webInspectState', active: false });
      this.broadcast({ type: 'error', message: `Web inspect failed: ${msg(err)}` });
    }
  }

  stopWebInspect(): void {
    stopWebInspect();
    this.broadcast({ type: 'webInspectState', active: false });
  }

  /** PNG bytes for the optional image pane. VM screenshot first, CLI fallback. */
  async screenshot(): Promise<Buffer> {
    if (this.client?.connected) {
      try { return await vmScreenshot(this.client); } catch { /* fall through */ }
    }
    const platform = (await detectPlatform()) ?? 'ios';
    const shot = await captureDeviceScreenshot(platform);
    return Buffer.from(shot.base64, 'base64');
  }

  // --- internals ---

  private wireController(controller: SelectModeController): void {
    controller.on('selectionChanged', (selection) => {
      this.broadcast({ type: 'selection', selection });
    });
    controller.on('cleared', () => this.broadcast({ type: 'cleared' }));
    controller.on('error', (err: Error) => this.broadcast({ type: 'error', message: err.message }));
    controller.on('unavailable', () => {
      this.broadcast({
        type: 'error',
        message:
          'Select mode unavailable — this looks like a release/profile build. ' +
          'Relaunch the app with `flutter run --debug`.',
      });
    });
  }

  private broadcast(message: ServerMessage): void {
    this.emit('broadcast', message);
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Convert a VMWidgetNode subtree to the wire-friendly TreeNodePayload, capped
 * so we don't ship 9k+ nodes if they'd blow the WS frame. Children beyond the
 * cap are dropped silently; the UI lazily lists them on demand only when the
 * user expands a deep subtree (the count remains accurate via the second arg).
 */
function toTreePayload(n: VMWidgetNode, onNode: () => void): TreeNodePayload {
  onNode();
  const cl = (n as { creationLocation?: { file: string; line: number; column?: number } }).creationLocation;
  const out: TreeNodePayload = {
    type: n.type,
    key: n.key,
    text: n.text,
    semanticsLabel: (n as { semanticsLabel?: string }).semanticsLabel,
    valueId: (n as { valueId?: string }).valueId,
    position: n.position,
    creationLocation: cl ? { file: cl.file, line: cl.line, column: cl.column } : undefined,
  };
  if (Array.isArray(n.children) && n.children.length > 0) {
    out.children = (n.children as VMWidgetNode[]).map(c => toTreePayload(c, onNode));
  }
  return out;
}

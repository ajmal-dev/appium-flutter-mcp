import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { vmLogger as logger } from './vm-logger.js';

// --- Types for Dart VM Service Protocol ---

export interface VMRef {
  type: string;
  name: string;
  isolates: IsolateRef[];
}

export interface IsolateRef {
  type: string;
  id: string;
  name: string;
  number: string;
}

export interface Isolate {
  type: string;
  id: string;
  name: string;
  number: string;
  extensionRPCs?: string[];
  libraries?: Array<{ name: string; uri: string }>;
}

export interface VMEvent {
  kind: string;
  isolate?: IsolateRef;
  extensionKind?: string;
  extensionData?: Record<string, unknown>;
  timestamp?: number;
}

export interface WidgetSummaryNode {
  description: string;
  valueId: string;
  widgetRuntimeType?: string;
  hasChildren: boolean;
  children?: WidgetSummaryNode[];
  creationLocation?: {
    file: string;
    line: number;
    column: number;
  };
  textPreview?: string;
  properties?: Array<{
    name: string;
    description: string;
    value?: string;
    type?: string;
  }>;
}

export interface RenderObjectNode {
  description: string;
  valueId: string;
  children?: RenderObjectNode[];
  properties?: Array<{
    name: string;
    description: string;
    value?: unknown;
  }>;
  size?: { width: number; height: number };
  offset?: { dx: number; dy: number };
}

export interface DetailedNode {
  description: string;
  valueId: string;
  widgetRuntimeType?: string;
  children?: DetailedNode[];
  properties?: Array<{
    name: string;
    description: string;
    value?: string;
    type?: string;
    propertyType?: string;
  }>;
  creationLocation?: {
    file: string;
    line: number;
    column: number;
  };
}

// --- JSON-RPC Types ---

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
  params?: { streamId?: string; event?: VMEvent };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// --- Client ---

export type DartVMClientState = 'disconnected' | 'connecting' | 'connected' | 'error';

export class DartVMClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pendingRequests = new Map<string, PendingRequest>();
  private flutterIsolateId: string | null = null;
  private subscribedStreams = new Set<string>();
  private groupName = 'appium-flutter-mcp-group';
  private _state: DartVMClientState = 'disconnected';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url: string = '';
  private availableExtensions: string[] = [];

  private static readonly REQUEST_TIMEOUT_MS = 15000;
  private static readonly RECONNECT_DELAY_MS = 3000;

  get state(): DartVMClientState {
    return this._state;
  }

  get isolateId(): string | null {
    return this.flutterIsolateId;
  }

  get connected(): boolean {
    return this._state === 'connected' && this.ws?.readyState === WebSocket.OPEN;
  }

  get extensions(): string[] {
    return this.availableExtensions;
  }

  hasExtension(name: string): boolean {
    return this.availableExtensions.includes(name);
  }

  // --- Connection ---

  async connect(url: string): Promise<{ isolateId: string; isolateName: string; extensions: string[] }> {
    this.url = url;
    this._state = 'connecting';
    this.emit('stateChange', this._state);
    logger.info('Connecting to Dart VM Service', { url });

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(url);
      } catch (err) {
        this._state = 'error';
        this.emit('stateChange', this._state);
        reject(new Error(`Invalid WebSocket URL: ${url}`));
        return;
      }

      const connectTimeout = setTimeout(() => {
        this.ws?.close();
        this._state = 'error';
        this.emit('stateChange', this._state);
        reject(new Error('VM Service connection timeout (15s)'));
      }, DartVMClient.REQUEST_TIMEOUT_MS);

      this.ws.on('open', async () => {
        clearTimeout(connectTimeout);
        try {
          const result = await this.initialize();
          this._state = 'connected';
          this.emit('stateChange', this._state);
          logger.info('Connected to Dart VM Service', {
            isolateId: result.isolateId,
            isolateName: result.isolateName,
            extensionCount: result.extensions.length,
          });
          resolve(result);
        } catch (err) {
          this._state = 'error';
          this.emit('stateChange', this._state);
          reject(err);
        }
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('close', () => {
        const wasConnected = this._state === 'connected';
        this._state = 'disconnected';
        this.emit('stateChange', this._state);
        this.cleanupPending('WebSocket closed');
        if (wasConnected) {
          logger.warn('Dart VM Service connection closed');
          this.emit('disconnected');
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        clearTimeout(connectTimeout);
        if (this._state === 'connecting') {
          this._state = 'error';
          this.emit('stateChange', this._state);
          reject(new Error(`VM Service WebSocket error: ${err.message}`));
        }
      });
    });
  }

  private async initialize(): Promise<{ isolateId: string; isolateName: string; extensions: string[] }> {
    const vm = await this.call('getVM') as VMRef;

    for (const isolateRef of vm.isolates) {
      const isolate = await this.call('getIsolate', { isolateId: isolateRef.id }) as Isolate;
      const extensions = isolate.extensionRPCs || [];

      if (extensions.some(ext => ext.startsWith('ext.flutter.'))) {
        this.flutterIsolateId = isolateRef.id;
        this.availableExtensions = extensions;

        await this.streamListen('Extension');

        return {
          isolateId: isolateRef.id,
          isolateName: isolateRef.name,
          extensions,
        };
      }
    }

    throw new Error('No Flutter isolate found. Is the app running in debug mode?');
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this._state === 'disconnected' && this.url) {
        try {
          await this.connect(this.url);
          logger.info('Dart VM Service reconnected');
          this.emit('reconnected');
        } catch {
          // Will schedule another reconnect on close
        }
      }
    }, DartVMClient.RECONNECT_DELAY_MS);
  }

  async dispose(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    for (const streamId of this.subscribedStreams) {
      try {
        await this.call('streamCancel', { streamId });
      } catch { /* ignore */ }
    }
    this.subscribedStreams.clear();

    if (this.flutterIsolateId) {
      try {
        await this.callServiceExtension('ext.flutter.inspector.disposeGroup', {
          objectGroup: this.groupName,
        });
      } catch { /* ignore */ }
    }

    this.cleanupPending('Client disposed');
    this.flutterIsolateId = null;
    this.availableExtensions = [];
    this.url = '';

    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }

    this._state = 'disconnected';
    this.emit('stateChange', this._state);
    logger.info('Dart VM client disposed');
  }

  // --- JSON-RPC ---

  call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('VM Service not connected'));
        return;
      }

      const id = String(++this.requestId);
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params: params || {},
      };

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out (${DartVMClient.REQUEST_TIMEOUT_MS}ms)`));
      }, DartVMClient.REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timer });

      this.ws.send(JSON.stringify(request), (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          reject(new Error(`Send failed: ${err.message}`));
        }
      });
    });
  }

  private handleMessage(raw: string) {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.id !== undefined) {
      const pending = this.pendingRequests.get(String(msg.id));
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(String(msg.id));
        if (msg.error) {
          pending.reject(new Error(`VM Service error: ${msg.error.message} (${msg.error.code})`));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    if (msg.method === 'streamNotify' && msg.params?.event) {
      this.handleStreamEvent(msg.params.event);
    }
  }

  private handleStreamEvent(event: VMEvent) {
    if (event.kind === 'Extension' && event.extensionKind) {
      this.emit('flutter:event', {
        kind: event.extensionKind,
        data: event.extensionData,
        timestamp: event.timestamp,
      });

      switch (event.extensionKind) {
        case 'Flutter.Frame':
          this.emit('flutter:frame', event.extensionData);
          break;
        case 'Flutter.Navigation':
          this.emit('flutter:navigation', event.extensionData);
          break;
        case 'Flutter.ServiceExtensionStateChanged':
          this.emit('flutter:extensionStateChanged', event.extensionData);
          break;
      }
    }

    if (event.kind === 'IsolateExit' && event.isolate?.id === this.flutterIsolateId) {
      logger.warn('Flutter isolate exited');
      this.emit('flutter:isolateExit');
    }
  }

  private cleanupPending(reason: string) {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  // --- Stream Management ---

  async streamListen(streamId: string): Promise<void> {
    if (this.subscribedStreams.has(streamId)) return;
    await this.call('streamListen', { streamId });
    this.subscribedStreams.add(streamId);
  }

  async streamCancel(streamId: string): Promise<void> {
    if (!this.subscribedStreams.has(streamId)) return;
    await this.call('streamCancel', { streamId });
    this.subscribedStreams.delete(streamId);
  }

  // --- Flutter Inspector Extensions ---

  async callServiceExtension(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.flutterIsolateId) {
      throw new Error('No Flutter isolate connected');
    }
    return this.call(method, {
      isolateId: this.flutterIsolateId,
      ...params,
    });
  }

  async getRootWidgetSummaryTree(): Promise<WidgetSummaryNode> {
    const result = await this.callServiceExtension(
      'ext.flutter.inspector.getRootWidgetSummaryTree',
      { objectGroup: this.groupName },
    );
    const node = (result as any)?.result || result;
    return node as WidgetSummaryNode;
  }

  async getRootRenderObject(): Promise<RenderObjectNode> {
    const result = await this.callServiceExtension(
      'ext.flutter.inspector.getRootRenderObject',
      { objectGroup: this.groupName },
    );
    const node = (result as any)?.result || result;
    return node as RenderObjectNode;
  }

  async getDetailsSubtree(valueId: string, subtreeDepth = 2): Promise<DetailedNode> {
    const result = await this.callServiceExtension(
      'ext.flutter.inspector.getDetailsSubtree',
      {
        arg: valueId,
        objectGroup: this.groupName,
        subtreeDepth,
      },
    );
    return result as DetailedNode;
  }

  async setSelectionById(valueId: string): Promise<void> {
    await this.callServiceExtension(
      'ext.flutter.inspector.setSelectionById',
      {
        arg: valueId,
        objectGroup: this.groupName,
      },
    );
  }

  async getSemanticsTree(): Promise<unknown> {
    try {
      return await this.callServiceExtension(
        'ext.flutter.inspector.getSemanticsTree',
        { objectGroup: this.groupName },
      );
    } catch {
      return null;
    }
  }

  async evaluate(expression: string, frameIndex?: number): Promise<unknown> {
    if (!this.flutterIsolateId) throw new Error('No Flutter isolate connected');
    return this.call('evaluate', {
      isolateId: this.flutterIsolateId,
      expression,
      frameIndex: frameIndex ?? 0,
    });
  }

  async invokeExtension(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.callServiceExtension(method, params);
  }

  // --- Utility ---

  static async discoverVMServiceUrls(): Promise<string[]> {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    const urls: string[] = [];

    try {
      const { stdout } = await execAsync(
        'lsof -i TCP -s TCP:LISTEN -P -n 2>/dev/null | grep -i dart || true',
        { timeout: 5000 },
      );

      const portRegex = /:(\d+)\s/g;
      let match: RegExpExecArray | null;
      const ports = new Set<string>();
      while ((match = portRegex.exec(stdout)) !== null) {
        ports.add(match[1]);
      }

      for (const port of ports) {
        urls.push(`ws://127.0.0.1:${port}/ws`);
      }
    } catch { /* ignore discovery failures */ }

    return urls;
  }
}

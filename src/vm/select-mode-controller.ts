import { EventEmitter } from 'events';
import type { DartVMClient, WidgetSummaryNode, DetailedNode } from './dart-vm-client.js';
import type { LocatorCandidate } from './vm-widget-tree.js';
import { extractPositionFromDetails } from './vm-widget-tree.js';
import { extractDeepLocators } from './deep-locators.js';
import { resolveUniqueLocator, resolveNearestAppSource, type ResolvedLocator, type AppSourceLocation } from './resolve-locator.js';
import { resolveAlternativeLocators, type AlternativeLocator } from './alternative-locators.js';
import { attachJava, toJavaLines, formatLocatorJava, type JavaLocator } from './locator-java.js';
import { resolveCreationLocation } from '../source/source-resolver.js';
import { vmLogger as logger } from './vm-logger.js';

const SELECT_MODE_EXTENSION = 'ext.flutter.inspector.show';

export class SelectModeUnavailableError extends Error {
  constructor() {
    super(
      'Flutter widget select mode is unavailable. The inspector service extensions ' +
        '(ext.flutter.inspector.*) only exist in DEBUG builds — launch the app with ' +
        '`flutter run --debug`.',
    );
    this.name = 'SelectModeUnavailableError';
  }
}

export interface SelectionResult {
  type: string;
  key?: string;
  text?: string;
  semanticsLabel?: string;
  tooltip?: string;
  position?: { x: number; y: number; width: number; height: number };
  creationLocation?: { file: string; line: number; column?: number; resolvedPath?: string };
  /**
   * Nearest ANCESTOR whose source is APP code (under the app / components repos), surfaced when
   * the tapped leaf resolves to framework / .pub-cache source (e.g. a ZDS ButtonProps rendered
   * as a generic zen_foundation button). Best-effort — absent when the leaf is already app source
   * or no app-source ancestor was found.
   */
  appSource?: AppSourceLocation;
  valueId: string;
  locators: JavaLocator[];
  javaLines: string[];
  /** A guaranteed-unique locator (own key → scoped → indexed). Best-effort. */
  uniqueLocator?: ResolvedLocator;
  /** Compound / web-XPath-style alternative patterns. Best-effort, may be empty. */
  alternativeLocators?: AlternativeLocator[];
  timestamp: number;
}

export interface SelectModeOptions {
  pollIntervalMs?: number;
  debounceMs?: number;
  objectGroup?: string;
  flutterAppPath?: string;
  flutterComponentsPath?: string;
}

/**
 * Drives Flutter's WidgetInspectorService "select widget mode" over the Dart VM
 * Service. When enabled, a physical tap on the device selects the widget under
 * the finger; this controller polls the current selection, dedupes/debounces it,
 * and emits a fully-resolved {@link SelectionResult} (locators + Java lines).
 *
 * Events:
 *   'selectionChanged' (SelectionResult)
 *   'cleared'          ()      — selection went from something to nothing
 *   'error'            (Error) — non-fatal poll error
 *   'unavailable'      ()      — select mode not supported (release build)
 */
export class SelectModeController extends EventEmitter {
  private readonly client: DartVMClient;
  private readonly pollIntervalMs: number;
  private readonly debounceMs: number;
  private readonly objectGroup: string;
  private readonly flutterAppPath?: string;
  private readonly flutterComponentsPath?: string;

  private _active = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastValueId: string | null = null;
  private pendingNode: WidgetSummaryNode | null = null;
  private pollInFlight = false;
  private needsReenable = false;
  private lastErrorAt = 0;

  private readonly onFlutterEvent = (): void => {
    // Optional latency nudge — a frame/extension event means something may have
    // changed; poll immediately rather than waiting for the next interval tick.
    if (this._active) void this.pollOnce();
  };
  private readonly onDisconnected = (): void => {
    this.needsReenable = this._active;
    this.stopTimers();
  };
  private readonly onReconnected = (): void => {
    if (this.needsReenable) {
      this.needsReenable = false;
      void this.reassert();
    }
  };

  constructor(client: DartVMClient, opts: SelectModeOptions = {}) {
    super();
    this.client = client;
    this.pollIntervalMs = opts.pollIntervalMs ?? 300;
    this.debounceMs = opts.debounceMs ?? 150;
    this.objectGroup = opts.objectGroup ?? 'select-mode-group';
    this.flutterAppPath = opts.flutterAppPath;
    this.flutterComponentsPath = opts.flutterComponentsPath;
  }

  get active(): boolean {
    return this._active;
  }

  async enable(): Promise<void> {
    if (this._active) return;
    if (!this.client.connected) {
      throw new Error('SelectModeController requires a connected DartVMClient');
    }
    if (!this.client.hasExtension(SELECT_MODE_EXTENSION)) {
      this.emit('unavailable');
      throw new SelectModeUnavailableError();
    }

    try {
      await this.client.setSelectMode(true, this.objectGroup);
    } catch (err) {
      this.emit('unavailable');
      throw new SelectModeUnavailableError();
    }

    this._active = true;
    this.client.on('flutter:event', this.onFlutterEvent);
    this.client.on('disconnected', this.onDisconnected);
    this.client.on('reconnected', this.onReconnected);

    this.pollTimer = setInterval(() => void this.pollOnce(), this.pollIntervalMs);
    await this.pollOnce();
  }

  async disable(): Promise<void> {
    if (!this._active) return;
    this._active = false;
    this.needsReenable = false;
    this.stopTimers();
    this.client.off('flutter:event', this.onFlutterEvent);
    this.client.off('disconnected', this.onDisconnected);
    this.client.off('reconnected', this.onReconnected);
    this.lastValueId = null;
    this.pendingNode = null;

    // Best-effort teardown.
    try {
      await this.client.setSelectMode(false, this.objectGroup);
    } catch { /* disconnected — ignore */ }
    try {
      await this.client.callServiceExtension('ext.flutter.inspector.disposeGroup', {
        objectGroup: this.objectGroup,
      });
    } catch { /* ignore */ }
  }

  /**
   * Highlight a specific widget on the device (for index validation) WITHOUT
   * the poll re-emitting a selectionChanged that would replace the panel. We
   * set the selection, then resync lastValueId to the new current id so the
   * next poll sees "no change". A subsequent physical tap resumes normally.
   */
  async highlightForValidation(valueId: string): Promise<void> {
    await this.client.setSelectionById(valueId);
    try {
      const cur = await this.client.getSelectedWidget(this.objectGroup, '');
      if (cur?.valueId) this.lastValueId = cur.valueId;
    } catch { /* ignore */ }
  }

  /**
   * One-shot read of the current selection. Uses a fresh, ephemeral object
   * group so the delta-based inspector getters always return the current
   * selection rather than a "unchanged → null" delta against the poll loop's
   * group.
   */
  async getCurrentSelection(): Promise<SelectionResult | null> {
    const group = `select-mode-oneshot-${Date.now()}`;
    let node: WidgetSummaryNode | null;
    try {
      // Prefer the FULL selection (the actual tapped leaf). The summary tree
      // only holds local-project widgets, so a tap on a package widget (e.g. a
      // Save button from flutter-components) generalizes up to a distant
      // ancestor like MediaQuery. Full is strictly more precise.
      node = await this.client.getSelectedWidget(group, '');
      if (!node) node = await this.client.getSelectedSummaryWidget(group, '');
    } finally {
      try {
        await this.client.callServiceExtension('ext.flutter.inspector.disposeGroup', {
          objectGroup: group,
        });
      } catch { /* ignore */ }
    }
    return node ? this.buildResult(node) : null;
  }

  // --- internals ---

  private stopTimers(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
  }

  private async reassert(): Promise<void> {
    try {
      await this.client.setSelectMode(true, this.objectGroup);
      this.pollTimer = setInterval(() => void this.pollOnce(), this.pollIntervalMs);
      await this.pollOnce();
    } catch (err) {
      this.emitError(err);
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this._active || !this.client.connected) return;
    // Don't stack requests: if the previous poll is still awaiting a response
    // (slow/busy VM), skip this tick rather than piling on more RPCs.
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      await this.pollInner();
    } finally {
      this.pollInFlight = false;
    }
  }

  private async pollInner(): Promise<void> {
    // Delta semantics: passing the last-seen valueId as previousSelectionId
    // makes the inspector return the node only when the selection has CHANGED,
    // and null when it's unchanged. valueIds are stable for the lifetime of a
    // single object group, so this is the protocol-native way to detect taps.
    const prev = this.lastValueId ?? '';
    let node: WidgetSummaryNode | null;
    try {
      // Prefer the full selection (actual tapped leaf) over the summary tree —
      // see getCurrentSelection() for why (package widgets aren't in summary).
      node = await this.client.getSelectedWidget(this.objectGroup, prev);
      if (!node) node = await this.client.getSelectedSummaryWidget(this.objectGroup, prev);
    } catch (err) {
      this.emitError(err);
      return;
    }

    // null = unchanged (or nothing selected). Either way, no-op — we never emit
    // 'cleared' from a poll because null can't be distinguished from "same".
    if (!node || node.valueId === this.lastValueId) return;

    // Changed — debounce so a finger dragging across widgets only emits the
    // final resting selection.
    this.lastValueId = node.valueId;
    this.pendingNode = node;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const pending = this.pendingNode;
      if (!pending || pending.valueId !== this.lastValueId) return;
      void this.buildResult(pending)
        .then((result) => this.emit('selectionChanged', result))
        .catch((err) => this.emitError(err));
    }, this.debounceMs);
  }

  private async buildResult(node: WidgetSummaryNode): Promise<SelectionResult> {
    const type = (node.widgetRuntimeType || node.description || 'Unknown')
      .split(/[<(]/)[0]
      .trim();

    let locators: LocatorCandidate[];
    try {
      locators = await extractDeepLocators(this.client, node.valueId, type, this.objectGroup);
    } catch {
      locators = [{ by: 'type', value: type, confidence: 0.4 }];
    }

    const pick = (by: string): string | undefined => locators.find((l) => l.by === by)?.value;

    let position: SelectionResult['position'];
    try {
      const raw = (await this.client.callServiceExtension(
        'ext.flutter.inspector.getDetailsSubtree',
        { arg: node.valueId, objectGroup: this.objectGroup, subtreeDepth: 1 },
      )) as any;
      const details = (raw?.result ?? raw) as DetailedNode;
      position = extractPositionFromDetails(details) ?? undefined;
    } catch { /* best-effort */ }

    let creationLocation: SelectionResult['creationLocation'];
    if (node.creationLocation) {
      const { file, line, column } = node.creationLocation;
      const resolvedPath =
        resolveCreationLocation(file, this.flutterAppPath, this.flutterComponentsPath) ?? undefined;
      creationLocation = { file, line, column, resolvedPath };
    }

    // If the tapped leaf is NOT app source (framework widget / .pub-cache package — e.g. a ZDS
    // ButtonProps rendered as a generic zen_foundation button), walk up to the nearest app-source
    // ancestor so the caller sees the widget they actually authored, not the generic leaf.
    let appSource: AppSourceLocation | undefined;
    const leafIsAppSource =
      !!creationLocation?.resolvedPath &&
      ((!!this.flutterAppPath && creationLocation.resolvedPath.startsWith(this.flutterAppPath)) ||
        (!!this.flutterComponentsPath &&
          creationLocation.resolvedPath.startsWith(this.flutterComponentsPath)));
    if (!leafIsAppSource) {
      appSource = await resolveNearestAppSource(
        this.client, this.flutterAppPath, this.flutterComponentsPath,
      );
    }

    // Best-effort guaranteed-unique locator (own key → scoped → indexed).
    let uniqueLocator: ResolvedLocator | undefined;
    try {
      uniqueLocator = await resolveUniqueLocator(this.client);
    } catch { /* best-effort */ }

    // Best-effort compound alternatives (parent-containing, contains-text, etc.)
    let alternativeLocators: AlternativeLocator[] | undefined;
    try {
      const alts = await resolveAlternativeLocators(this.client);
      if (alts.length) alternativeLocators = alts;
    } catch { /* best-effort */ }

    // Translate unsupported `byType(framework-widget)` candidates into working
    // substitutes using the widget's own text/semanticsLabel/key. Keeps the
    // strikethrough card visible for context but offers a one-click working line.
    const text = pick('text');
    const semLabel = pick('semanticsLabel');
    const key = pick('key');
    const java = attachJava(locators).map((l) => {
      if (!l.unsupported) return l;
      let sub: { by: 'key' | 'text' | 'semanticsLabel' | 'type'; value: string } | null = null;
      if (key) sub = { by: 'key', value: key };
      else if (text) sub = { by: 'text', value: text };
      else if (semLabel) sub = { by: 'semanticsLabel', value: semLabel };
      if (!sub) return l;
      const javaSub = formatLocatorJava(sub.by, sub.value);
      if (!javaSub) return l;
      return { ...l, translation: { by: sub.by, value: sub.value, java: javaSub } };
    });

    return {
      type,
      key,
      text,
      semanticsLabel: semLabel,
      tooltip: pick('tooltip'),
      position,
      creationLocation,
      appSource,
      valueId: node.valueId,
      locators: java,
      javaLines: toJavaLines(locators),
      uniqueLocator,
      alternativeLocators,
      timestamp: Date.now(),
    };
  }

  private emitError(err: unknown): void {
    const now = Date.now();
    // Throttle non-fatal error spam to once per 5s.
    if (now - this.lastErrorAt < 5000) return;
    this.lastErrorAt = now;
    const error = err instanceof Error ? err : new Error(String(err));
    logger.warn('SelectModeController poll error', { error: error.message });
    this.emit('error', error);
  }
}

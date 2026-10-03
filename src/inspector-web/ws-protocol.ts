import type { SelectionResult } from '../vm/select-mode-controller.js';
import type { DartVMClientState } from '../vm/dart-vm-client.js';
import type { LocatorStrategy } from '../vm/verify-locator.js';
import type { VerifyCompoundParams, AlternativeKind } from '../vm/alternative-locators.js';

// --- client → server ---

export type ClientMessage =
  | { type: 'discover' }
  | { type: 'connect'; url: string }
  | { type: 'disconnect' }
  | { type: 'setSelectMode'; enabled: boolean }
  | { type: 'verifyLocator'; by: LocatorStrategy; value: string }
  | { type: 'highlightIndex'; by: LocatorStrategy; value: string; index: number }
  | { type: 'verifyCompound'; altIndex: number; params: VerifyCompoundParams }
  | { type: 'loadFullTree' }
  | { type: 'evaluatePath'; query: string; highlight?: boolean }
  | { type: 'highlightValueId'; valueId: string }
  | { type: 'listWebViews' }
  | { type: 'loadWebViewTree'; contextId?: string }
  | { type: 'highlightWebViewNode'; domId: number }
  | { type: 'verifyWebSelector'; by: 'css' | 'xpath'; value: string }
  | { type: 'startWebInspect' }
  | { type: 'stopWebInspect' };

// --- server → client ---

export type ServerMessage =
  | { type: 'hello'; selectMode: boolean; vmState: DartVMClientState; url?: string }
  | { type: 'discovered'; urls: string[] }
  | { type: 'vmState'; state: DartVMClientState; url?: string; isolateName?: string; error?: string }
  | { type: 'selectModeState'; enabled: boolean }
  | { type: 'selection'; selection: SelectionResult }
  | { type: 'cleared' }
  | {
      type: 'verifyResult';
      by: LocatorStrategy;
      value: string;
      matchCount: number;
      unique: boolean;
      driverFound?: boolean;
      highlighted: boolean;
      selectedIndex?: number;
      indexedJava?: string;
    }
  | {
      type: 'indexHighlight';
      by: LocatorStrategy;
      value: string;
      index: number;
      matchCount: number;
      targetType?: string;
      targetKey?: string;
      targetText?: string;
    }
  | {
      type: 'compoundVerifyResult';
      altIndex: number;
      kind: AlternativeKind;
      matchCount: number;
      unique: boolean;
      detail: string;
    }
  | {
      type: 'fullTree';
      root: TreeNodePayload;
      totalNodes: number;
    }
  | {
      type: 'pathResult';
      query: string;
      matchCount: number;
      unique: boolean;
      matches: Array<{
        type: string;
        key?: string;
        text?: string;
        semanticsLabel?: string;
        valueId?: string;
        position?: { x: number; y: number; width: number; height: number };
      }>;
      java: string;
      notes: string[];
      error?: string;
    }
  | { type: 'error'; message: string }
  | { type: 'webViewList'; webviews: Array<{ id: string; url: string; title: string }> }
  | { type: 'webviewTree'; root: DomNodePayload; totalNodes: number; url: string; contextId: string }
  | { type: 'webHighlightResult'; domId: number; found: boolean; tag?: string | null; id?: string | null; rect?: { x: number; y: number; w: number; h: number } }
  | { type: 'webVerifyResult'; by: 'css' | 'xpath'; value: string; matchCount: number; unique: boolean }
  | { type: 'webInspectState'; active: boolean }
  | { type: 'webInspectHit'; domId: number; tag: string | null; id: string | null; cls: string[]; rect: { x: number; y: number; w: number; h: number } };

export interface DomNodePayload {
  domId: number;
  tag: string;
  id?: string;
  classes?: string[];
  text?: string;
  attrs?: Record<string, string>;
  rect?: { x: number; y: number; width: number; height: number };
  children?: DomNodePayload[];
}

export interface TreeNodePayload {
  type: string;
  key?: string;
  text?: string;
  semanticsLabel?: string;
  valueId?: string;
  position?: { x: number; y: number; width: number; height: number };
  /** Source-code creation point; stable across object groups — used to map a
   *  tap-mode selection back to the tree-explorer's tree. */
  creationLocation?: { file: string; line: number; column?: number };
  children?: TreeNodePayload[];
}

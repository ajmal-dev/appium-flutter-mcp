export interface WidgetNode {
  type: string;
  key?: string;
  text?: string;
  enabled?: boolean;
  displayed?: boolean;
  position?: { x: number; y: number; width: number; height: number };
  interactive: boolean;
  locator?: { by: string; value: string };
  properties?: Record<string, unknown>;
  children?: WidgetNode[];
}

export interface InteractiveElement {
  index: number;
  type: string;
  key?: string;
  text?: string;
  enabled?: boolean;
  displayed?: boolean;
  position?: { x: number; y: number; width: number; height: number };
  locator: { by: string; value: string };
  context?: string; // "NATIVE_APP", "WEBVIEW_2335.12", etc.
}

export interface ContextSummary {
  contextId: string;
  type: 'flutter' | 'webview' | 'native';
  bounds?: { x: number; y: number; width: number; height: number };
  elementCount: number;
}

export interface WidgetTree {
  timestamp: string;
  context: string;
  platform: string;
  source: 'renderTree' | 'scanner' | 'combined' | 'vm';
  tree: WidgetNode | WidgetNode[] | null;
  interactiveElements: InteractiveElement[];
  elementCount: number;
  interactiveCount: number;
  contexts?: ContextSummary[];
}

// Widget types considered interactive (tappable/typeable)
export const INTERACTIVE_WIDGET_TYPES = [
  // Standard Flutter — buttons
  'ElevatedButton',
  'TextButton',
  'OutlinedButton',
  'IconButton',
  'FloatingActionButton',
  'FilledButton',
  'MenuAnchor',
  'MenuItemButton',
  'SubmenuButton',
  'SegmentedButton',
  'BackButton',
  'CloseButton',
  'DrawerButton',
  'EndDrawerButton',
  // Standard Flutter — input
  'TextField',
  'TextFormField',
  'Switch',
  'Checkbox',
  'Radio',
  'DropdownButton',
  'DropdownMenu',
  'PopupMenuButton',
  'Slider',
  'RangeSlider',
  'ToggleButtons',
  'SearchBar',
  'SearchAnchor',
  'Autocomplete',
  // Standard Flutter — tappable containers
  'InkWell',
  'InkResponse',
  'GestureDetector',
  'Listener',
  'RawGestureDetector',
  'Dismissible',
  // Standard Flutter — navigation
  'ListTile',
  'ExpansionTile',
  'Tab',
  'TabBar',
  'BottomNavigationBar',
  'NavigationBar',
  'NavigationRail',
  'NavigationDrawer',
  'Chip',
  'ActionChip',
  'FilterChip',
  'ChoiceChip',
  'InputChip',
  // Standard Flutter — dialogs & overlays
  'AlertDialog',
  'SimpleDialog',
  'BottomSheet',
  'SnackBar',
  'MaterialBanner',
  'DatePicker',
  'TimePicker',
  // Standard Flutter — images & icons
  'Icon',
  'ImageIcon',
  'CircleAvatar',
  // Common third-party / community widgets
  'AutoSizeTextField',
];

// Layout-only widgets to filter from condensed tree
export const LAYOUT_ONLY_TYPES = new Set([
  'Padding',
  'SizedBox',
  'Align',
  'Center',
  'Expanded',
  'Flexible',
  'Spacer',
  'ConstrainedBox',
  'UnconstrainedBox',
  'LimitedBox',
  'FractionallySizedBox',
  'AspectRatio',
  'FittedBox',
  'Offstage',
  'Opacity',
  'Transform',
  'RepaintBoundary',
  'ColoredBox',
  'DecoratedBox',
  'Positioned',
  'MediaQuery',
  'Builder',
  'LayoutBuilder',
  'ValueListenableBuilder',
  'StreamBuilder',
  'FutureBuilder',
  'AnimatedBuilder',
  'KeyedSubtree',
  'Semantics',
  'MergeSemantics',
  'ExcludeSemantics',
]);

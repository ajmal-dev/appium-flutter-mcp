import { DartVMClient } from '../vm/dart-vm-client.js';

async function main() {
  const c = new DartVMClient();
  await c.connect('ws://127.0.0.1:51401/hQEvlKb0lNg=/ws');

  // List ALL extensions
  console.log('=== All ext.flutter.inspector extensions ===');
  for (const ext of c.extensions) {
    if (ext.includes('inspector')) console.log(' ', ext);
  }

  // Try debugDumpRenderTree
  try {
    const result = await c.callServiceExtension('ext.flutter.debugDumpRenderTree', {}) as any;
    console.log('\n=== debugDumpRenderTree result keys ===');
    console.log(Object.keys(result));
    if (result.data) console.log('data (first 2000):', String(result.data).slice(0, 2000));
    if (result.result) console.log('result type:', typeof result.result, Object.keys(result.result || {}));
    console.log('JSON (first 500):', JSON.stringify(result).slice(0, 500));
  } catch (e) {
    console.log('debugDumpRenderTree failed:', e);
  }

  // Try getRootWidgetSummaryTree with subtreeDepth
  try {
    const result = await c.callServiceExtension('ext.flutter.inspector.getRootWidgetSummaryTree', {
      objectGroup: 'debug-group',
      subtreeDepth: 3,
    }) as any;
    const root = result?.result || result;
    // Check if first child has any useful properties
    function dump(node: any, depth: number) {
      if (depth > 2 || !node) return;
      const type = node.widgetRuntimeType || node.description?.slice(0, 40) || '?';
      const props = (node.properties || []).map((p: any) => p.name).join(', ');
      console.log('  '.repeat(depth) + type + (props ? ` [${props}]` : ''));
      for (const child of (node.children || []).slice(0, 3)) dump(child, depth + 1);
    }
    console.log('\n=== Widget Summary Tree (first few levels) ===');
    dump(root, 0);
  } catch (e) {
    console.log('getRootWidgetSummaryTree failed:', e);
  }

  await c.dispose();
}
main().catch(e => { console.error(e); process.exit(1); });

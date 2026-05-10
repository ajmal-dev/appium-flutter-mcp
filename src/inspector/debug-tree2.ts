import { DartVMClient } from '../vm/dart-vm-client.js';

const url = process.argv[2] || 'ws://127.0.0.1:51401/hQEvlKb0lNg=/ws';

async function main() {
  const c = new DartVMClient();
  await c.connect(url);

  const root = await c.getRootWidgetSummaryTree();
  console.log('Root:', root.widgetRuntimeType || root.description?.slice(0, 50), 'valueId:', root.valueId);

  // Try getDetailsSubtree on an interactive widget
  function findInteractive(node: any): any {
    const type = node.widgetRuntimeType || '';
    if (['InkWell', 'GestureDetector', 'IconButton', 'TextButton', 'FloatingActionButton'].includes(type)) return node;
    for (const child of (node.children || [])) {
      const found = findInteractive(child);
      if (found) return found;
    }
    return null;
  }

  const interactive = findInteractive(root);
  if (interactive) {
    console.log('\nInteractive:', interactive.widgetRuntimeType, 'id:', interactive.valueId);
    const details = await c.getDetailsSubtree(interactive.valueId, 3) as any;
    console.log('Properties:');
    for (const p of (details.properties || [])) {
      console.log(' ', p.name, ':', String(p.description || '').slice(0, 200));
    }
    // Check children for renderObject
    function findRenderProp(node: any, depth: number) {
      if (depth > 4) return;
      for (const p of (node.properties || [])) {
        if (p.name === 'renderObject' || p.name.includes('size') || p.name.includes('offset') || p.name.includes('rect')) {
          console.log(`  [${'  '.repeat(depth)}${node.description?.slice(0, 40)}] ${p.name}: ${String(p.description || '').slice(0, 200)}`);
        }
      }
      for (const child of (node.children || [])) findRenderProp(child, depth + 1);
    }
    findRenderProp(details, 0);
  }

  // List available extensions to see what's supported
  console.log('\nFlutter extensions containing "render" or "object":');
  for (const ext of c.extensions) {
    if (ext.includes('render') || ext.includes('Render') || ext.includes('object') || ext.includes('Object') || ext.includes('hit')) {
      console.log(' ', ext);
    }
  }

  await c.dispose();
}

main().catch(e => { console.error(e); process.exit(1); });

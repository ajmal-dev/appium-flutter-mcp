/**
 * Quick debug script: connect to VM and dump render tree to see position format
 * Run: npx tsx src/inspector/debug-tree.ts ws://127.0.0.1:51401/hQEvlKb0lNg=/ws
 */
import { DartVMClient } from '../vm/dart-vm-client.js';

const url = process.argv[2];
if (!url) { console.error('Usage: npx tsx src/inspector/debug-tree.ts ws://...'); process.exit(1); }

async function main() {
  const client = new DartVMClient();
  await client.connect(url);
  console.log('Connected\n');

  // Get render tree root
  const renderRoot = await client.getRootRenderObject();
  console.log('=== RENDER ROOT ===');
  console.log('description:', renderRoot.description);
  console.log('properties:');
  for (const p of (renderRoot.properties || [])) {
    console.log(`  ${p.name}: ${p.description}`);
  }

  // Walk first few children to find one with size/offset
  function dumpNode(node: any, depth: number, maxDepth: number) {
    if (depth > maxDepth) return;
    const indent = '  '.repeat(depth);
    const hasSize = node.properties?.some((p: any) => p.name === 'size');
    const hasOffset = node.properties?.some((p: any) => p.name === 'offset' || p.name === 'paintOffset');
    if (hasSize || hasOffset || depth < 3) {
      console.log(`${indent}${node.description?.slice(0, 80)}`);
      for (const p of (node.properties || [])) {
        if (['size', 'offset', 'paintOffset', 'constraints'].includes(p.name)) {
          console.log(`${indent}  ${p.name}: ${p.description}`);
        }
      }
    }
    for (const child of (node.children || [])) {
      dumpNode(child, depth + 1, maxDepth);
    }
  }
  console.log('\n=== RENDER TREE (depth 5) ===');
  dumpNode(renderRoot, 0, 5);

  // Also check widget tree for positions
  const widgetRoot = await client.getRootWidgetSummaryTree();
  let posCount = 0;
  function countPositions(node: any) {
    if (node.properties?.some((p: any) => p.name === 'size' || p.name === 'offset')) posCount++;
    for (const child of (node.children || [])) countPositions(child);
  }
  countPositions(widgetRoot);
  console.log('\nWidget tree nodes with position properties:', posCount);

  await client.dispose();
}

main().catch(e => { console.error(e); process.exit(1); });

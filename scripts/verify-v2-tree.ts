/**
 * Standalone verification for the agentic-v2-perf branch changes:
 *  1. WithPreviews summary tree → Text nodes carry textPreview
 *  2. propagateDescendantLabels → interactive elements get text labels
 *  3. renderTreeAsText / formatElementsCompact → payload size comparison
 *
 * Usage: npx tsx scripts/verify-v2-tree.ts ws://127.0.0.1:PORT/TOKEN=/ws
 */
import { DartVMClient } from '../src/vm/dart-vm-client.js';
import { buildVMWidgetTree } from '../src/vm/vm-widget-tree.js';
import { pruneTreeForLocators, renderTreeAsText } from '../src/tree/prune-tree.js';
import { formatElementsCompact, summarizeValueKeys } from '../src/util/element-format.js';
import type { WidgetNode } from '../src/tree/types.js';

const url = process.argv[2];
if (!url) {
  console.error('usage: npx tsx scripts/verify-v2-tree.ts <vm-ws-url>');
  process.exit(1);
}

const approxTokens = (s: string) => Math.round(s.length / 4);

async function main() {
  const client = new DartVMClient();
  await client.connect(url);
  console.log('connected. extensions:', client.extensions.length);
  console.log('flutter_driver ext present:',
    client.extensions.some(e => e.startsWith('ext.flutter.driver')));

  const t0 = Date.now();
  const tree = await buildVMWidgetTree(client, 'ios');
  console.log(`\nbuildVMWidgetTree: ${Date.now() - t0}ms — ${tree.elementCount} nodes, ${tree.interactiveCount} interactive`);

  const labeled = tree.interactiveElements.filter(e => e.text && e.text.trim());
  console.log(`interactive elements WITH text label: ${labeled.length}/${tree.interactiveElements.length}`);

  console.log('\n--- compact list (new) ---');
  const compact = [summarizeValueKeys(tree.interactiveElements), formatElementsCompact(tree.interactiveElements)].filter(Boolean).join('\n');
  console.log(compact);
  console.log(`\ncompact size: ${compact.length} chars ≈ ${approxTokens(compact)} tokens`);

  const root = tree.tree as WidgetNode;
  const pruned = pruneTreeForLocators(root, { interactiveOnly: true });
  if (pruned) {
    const treeText = renderTreeAsText(pruned);
    console.log(`\ntree-as-text size: ${treeText.length} chars ≈ ${approxTokens(treeText)} tokens`);
    // old format for comparison: pretty JSON of {..tree fields, tree: pruned}
    const oldPayload = JSON.stringify({ ...tree, tree: pruned }, null, 2);
    console.log(`OLD format=tree payload: ${oldPayload.length} chars ≈ ${approxTokens(oldPayload)} tokens`);
    const newPayload = ['header', compact.split('\n')[0] ?? '', treeText].join('\n');
    console.log(`NEW format=tree payload: ${newPayload.length} chars ≈ ${approxTokens(newPayload)} tokens`);
    console.log('\n--- tree text preview (first 40 lines) ---');
    console.log(treeText.split('\n').slice(0, 40).join('\n'));
  }

  await client.dispose();
  process.exit(0);
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });

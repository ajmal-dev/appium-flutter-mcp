import { DartVMClient } from '../src/vm/dart-vm-client.js';
import { buildVMWidgetTree } from '../src/vm/vm-widget-tree.js';
import { pruneTreeForLocators } from '../src/tree/prune-tree.js';
import type { WidgetNode } from '../src/tree/types.js';

function countNodes(n: WidgetNode | null): number {
  if (!n) return 0;
  let c = 1;
  if (n.children) for (const ch of n.children) c += countNodes(ch);
  return c;
}

function maxDepthOf(n: WidgetNode | null, d = 0): number {
  if (!n) return d;
  if (!n.children || n.children.length === 0) return d;
  return Math.max(...n.children.map((c) => maxDepthOf(c, d + 1)));
}

function collectLocators(n: WidgetNode | null, out: Set<string>): void {
  if (!n) return;
  if (n.locator) out.add(`${n.locator.by}:${n.locator.value}`);
  if (n.children) for (const ch of n.children) collectLocators(ch, out);
}

function findFirstChainOfLength(n: WidgetNode | null, minLen: number): string[] | null {
  // Find the first root-to-somewhere path with no branching (single-child chain) of at least minLen.
  if (!n) return null;
  const path: string[] = [n.type];
  let cur = n;
  while (cur.children && cur.children.length === 1) {
    cur = cur.children[0];
    path.push(cur.type);
  }
  if (path.length >= minLen) return path;
  if (n.children) {
    for (const ch of n.children) {
      const r = findFirstChainOfLength(ch, minLen);
      if (r) return r;
    }
  }
  return null;
}

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error('usage: tsx scripts/verify-prune-tree.ts <vmServiceWsUrl>');
    process.exit(1);
  }

  const client = new DartVMClient();
  await client.connect(url);

  console.log('=== Fetching raw VM widget tree (same path as buildWidgetTree) ===');
  const widgetTree = await buildVMWidgetTree(client, 'ios');
  const raw = widgetTree.tree as WidgetNode;

  const rawJson = JSON.stringify(raw);
  console.log(`Raw tree: ${countNodes(raw)} nodes, ${rawJson.length} chars, maxDepth=${maxDepthOf(raw)}`);

  const chain = findFirstChainOfLength(raw, 8);
  if (chain) {
    console.log(`\nLongest unbranched chain found near root (${chain.length} levels):`);
    console.log('  ' + chain.join(' -> '));
  }

  console.log('\n=== format:"tree", interactiveOnly:true (default) ===');
  const prunedInteractive = pruneTreeForLocators(raw, { interactiveOnly: true });
  const prunedInteractiveJson = JSON.stringify(prunedInteractive);
  console.log(`Pruned tree: ${countNodes(prunedInteractive)} nodes, ${prunedInteractiveJson.length} chars, maxDepth=${maxDepthOf(prunedInteractive)}`);

  console.log('\n=== format:"tree", interactiveOnly:false ===');
  const prunedAll = pruneTreeForLocators(raw, { interactiveOnly: false });
  const prunedAllJson = JSON.stringify(prunedAll);
  console.log(`Pruned tree: ${countNodes(prunedAll)} nodes, ${prunedAllJson.length} chars, maxDepth=${maxDepthOf(prunedAll)}`);

  console.log('\n=== Cross-check: no interactive element silently dropped ===');
  const flatLocators = new Set<string>();
  for (const el of widgetTree.interactiveElements) {
    flatLocators.add(`${el.locator.by}:${el.locator.value}`);
  }
  const treeLocators = new Set<string>();
  collectLocators(prunedInteractive, treeLocators);
  const missing = [...flatLocators].filter((l) => !treeLocators.has(l));
  console.log(`compact interactiveElements: ${flatLocators.size} unique locators`);
  console.log(`pruned tree (interactiveOnly:true): ${treeLocators.size} unique locators`);
  console.log(`Missing from pruned tree: ${missing.length}`, missing.slice(0, 20));

  console.log('\n=== Reduction summary ===');
  console.log(`full:                    ${rawJson.length} chars`);
  console.log(`tree (interactiveOnly):  ${prunedInteractiveJson.length} chars (${(100 * prunedInteractiveJson.length / rawJson.length).toFixed(1)}% of full)`);
  console.log(`tree (all):              ${prunedAllJson.length} chars (${(100 * prunedAllJson.length / rawJson.length).toFixed(1)}% of full)`);

  await client.dispose();
}

main().catch((e) => { console.error(e); process.exit(1); });

import { DartVMClient } from '../src/vm/dart-vm-client.js';

async function main() {
  const url = process.argv[2];
  const target = process.argv[3] || 'Select';
  if (!url) { console.error('usage'); process.exit(1); }
  const c = new DartVMClient();
  await c.connect(url);

  const r = await (c as any).callServiceExtension('ext.flutter.inspector.getRootWidgetTree', {
    groupName: 'probe', isSummaryTree: 'false', withPreviews: 'true', fullDetails: 'true',
  });
  const t = (r as any)?.result ?? r;

  // Stats + find "Select".
  let total = 0; let withPreview = 0;
  const previews: Array<{ type: string; valueId: string; textPreview: string }> = [];
  const matches: any[] = [];
  const walk = (n: any): void => {
    if (!n || typeof n !== 'object') return;
    total++;
    const ty = n.widgetRuntimeType || (typeof n.description === 'string' ? n.description.split(/[<(]/)[0].trim() : '?');
    if (typeof n.textPreview === 'string' && n.textPreview) {
      withPreview++;
      previews.push({ type: ty, valueId: n.valueId, textPreview: n.textPreview });
      if (n.textPreview === target) matches.push({ type: ty, valueId: n.valueId, textPreview: n.textPreview });
    }
    if (Array.isArray(n.children)) for (const ch of n.children) walk(ch);
  };
  walk(t);
  console.log(`Total nodes: ${total}, with textPreview: ${withPreview}`);
  console.log(`Exact textPreview === "${target}": ${matches.length} match(es)`);
  if (matches.length) console.log('Matches:', matches);
  console.log(`Sample previews (first 15):`, previews.slice(0, 15));
  await c.dispose();
}

main().catch((e) => { console.error(e); process.exit(1); });

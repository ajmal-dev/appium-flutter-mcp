import { DartVMClient } from '../src/vm/dart-vm-client.js';

const url = process.argv[2]!;

async function main() {
  const client = new DartVMClient();
  await client.connect(url);

  const driverExts = client.extensions.filter(e => e.includes('driver'));
  console.log('driver-related extensions:', JSON.stringify(driverExts));
  const inspectorExts = client.extensions.filter(e => e.includes('inspector')).slice(0, 30);
  console.log('inspector extensions:', JSON.stringify(inspectorExts, null, 1));

  // Try WithPreviews directly
  for (const [method, params] of [
    ['ext.flutter.inspector.getRootWidgetSummaryTreeWithPreviews', { objectGroup: 'debug-previews' }],
    ['ext.flutter.inspector.getRootWidgetSummaryTreeWithPreviews', { groupName: 'debug-previews' }],
  ] as const) {
    try {
      const result = await (client as any).callServiceExtension(method, params);
      const json = JSON.stringify((result as any)?.result ?? result);
      const previewCount = (json.match(/textPreview/g) || []).length;
      console.log(`${method} ${Object.keys(params)[0]} → OK, ${json.length} chars, textPreview x${previewCount}`);
      if (previewCount > 0) {
        const m = json.match(/.{0,120}textPreview.{0,120}/);
        console.log('sample:', m?.[0]);
      }
      break;
    } catch (e) {
      console.log(`${method} ${Object.keys(params)[0]} → FAILED: ${String(e).slice(0, 120)}`);
    }
  }

  await client.dispose();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });

import { DartVMClient } from '../vm/dart-vm-client.js';

async function main() {
  const c = new DartVMClient();
  await c.connect('ws://127.0.0.1:51401/hQEvlKb0lNg=/ws');

  // debugDumpRenderTree returns a text dump
  const result = await c.callServiceExtension('ext.flutter.debugDumpRenderTree', {}) as any;
  const dump = result?.result || result;
  // Print first 3000 chars to see the format
  console.log(String(dump).slice(0, 3000));

  await c.dispose();
}
main().catch(e => { console.error(e); process.exit(1); });

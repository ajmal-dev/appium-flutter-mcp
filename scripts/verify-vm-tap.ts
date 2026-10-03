/**
 * Live proof for the corrected flutter_driver protocol (single ext.flutter.driver
 * endpoint with command param). Taps the harmless "Today" button and reads
 * text back. Usage: npx tsx scripts/verify-vm-tap.ts <vm-ws-url>
 */
import { DartVMClient } from '../src/vm/dart-vm-client.js';
import { vmTap, vmWaitFor, vmGetText } from '../src/vm/vm-actions.js';

const url = process.argv[2]!;

async function main() {
  const client = new DartVMClient();
  await client.connect(url);

  let t = Date.now();
  await vmWaitFor(client, 'key', 'apb_today_button', 10);
  console.log(`vmWaitFor(apb_today_button): OK in ${Date.now() - t}ms`);

  t = Date.now();
  const text = await vmGetText(client, 'text', 'Today');
  console.log(`vmGetText(text=Today): "${text}" in ${Date.now() - t}ms`);

  t = Date.now();
  await vmTap(client, 'key', 'apb_today_button', 10);
  console.log(`vmTap(apb_today_button): OK in ${Date.now() - t}ms`);

  await client.dispose();
  process.exit(0);
}
main().catch(e => { console.error('FAILED:', String(e)); process.exit(1); });

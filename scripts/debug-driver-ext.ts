import { DartVMClient } from '../src/vm/dart-vm-client.js';

const url = process.argv[2]!;

async function probe(client: DartVMClient, label: string, params: Record<string, string>) {
  try {
    const r = await (client as any).callServiceExtension('ext.flutter.driver', params);
    console.log(`${label} → OK:`, JSON.stringify(r).slice(0, 300));
  } catch (e) {
    console.log(`${label} → FAILED:`, String(e).slice(0, 300));
  }
}

async function main() {
  const client = new DartVMClient();
  await client.connect(url);

  await probe(client, 'get_health', { command: 'get_health' });
  await probe(client, 'waitFor key', {
    command: 'waitFor', finderType: 'ByValueKey',
    keyValueString: 'apb_today_button', keyValueType: 'String', timeout: '10000',
  });
  await probe(client, 'no command param', {});

  await client.dispose();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });

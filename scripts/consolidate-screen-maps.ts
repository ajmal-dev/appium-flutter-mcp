/**
 * Manually consolidate the persistent screen-map store for an app:
 * drops ghost entries and merges structural duplicates left over from
 * the old text-based fingerprinting. (Also runs automatically on connect.)
 *
 *   npx tsx scripts/consolidate-screen-maps.ts [appId]
 */

import { consolidateScreenMaps, loadAllScreenMaps } from '../src/context/screen-map-store.js';

const appId = process.argv[2] ?? 'com.example.app';
const result = consolidateScreenMaps(appId);
console.log(`Consolidated ${appId}: ${result.before} → ${result.after} screens\n`);

for (const s of loadAllScreenMaps(appId)) {
  const aliases = s.aliases?.length ? ` aka [${s.aliases.join(', ')}]` : '';
  console.log(`- ${s.screenId}  "${s.name}"${aliases}  (${s.elements.length} elements, ${s.edges.length} edges)`);
}

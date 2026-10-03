/**
 * Sanity check for the structural screen-identity store.
 * Run with an isolated store:
 *   APPIUM_FLUTTER_MCP_HOME=$(mktemp -d) npx tsx scripts/verify-screen-map.ts
 */

import {
  recordScreen, identifyScreen, bindScreenName, getScreenByName,
  addNavigationEdge, findNavigationPath, loadAllScreenMaps,
  consolidateScreenMaps, saveScreenMap, generateFingerprint,
  computeStableTokens, screenSimilarity,
  type ScreenMapEntry,
} from '../src/context/screen-map-store.js';
import type { InteractiveElement } from '../src/tree/types.js';

const APP = 'com.test.app';
let failures = 0;

function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function el(type: string, opts: { key?: string; text?: string } = {}): InteractiveElement {
  return {
    index: 0,
    type,
    key: opts.key,
    text: opts.text,
    enabled: true,
    displayed: true,
    locator: opts.key
      ? { by: 'key', value: opts.key }
      : { by: opts.text ? 'text' : 'type', value: opts.text ?? type },
  };
}

// Medical Record screen — visit 1 (4 records, June data)
const medicalV1: InteractiveElement[] = [
  el('IconButton', { key: 'medical_record_add' }),
  el('TextField', { text: 'Search records' }),
  el('TextButton', { text: 'Records' }),
  el('TextButton', { text: 'Allergies' }),
  el('TextButton', { text: 'June 2026' }),          // dynamic chrome text
  el('ListTile', { text: 'Blood Test — 2026-06-01' }),
  el('ListTile', { text: 'X-Ray — 2026-06-04' }),
  el('ListTile', { text: 'MRI — 2026-06-07' }),
  el('ListTile', { text: 'Allergy Panel — 2026-06-09' }),
];

// Same logical screen — visit 2 (different month, more rows, one tab label changed)
const medicalV2: InteractiveElement[] = [
  el('IconButton', { key: 'medical_record_add' }),
  el('TextField', { text: 'Search records' }),
  el('TextButton', { text: 'Records' }),
  el('TextButton', { text: 'Allergies' }),
  el('TextButton', { text: 'July 2026' }),          // dynamic chrome text changed
  el('ListTile', { text: 'Vaccination — 2026-07-02' }),
  el('ListTile', { text: 'Blood Test — 2026-07-05' }),
  el('ListTile', { text: 'Dental — 2026-07-11' }),
  el('ListTile', { text: 'Physio — 2026-07-15' }),
  el('ListTile', { text: 'Eye Exam — 2026-07-20' }),
];

// A genuinely different screen
const loginScreen: InteractiveElement[] = [
  el('TextField', { key: 'login_username' }),
  el('TextField', { key: 'login_password' }),
  el('ElevatedButton', { key: 'login_submit', text: 'Sign In' }),
  el('TextButton', { text: 'Forgot password?' }),
];

// Dashboard (to build a navigation edge)
const dashboard: InteractiveElement[] = [
  el('IconButton', { key: 'nav_menu' }),
  el('TextButton', { text: 'Appointments' }),
  el('TextButton', { text: 'Guests' }),
  el('TextButton', { text: 'Medical' }),
  el('Switch', { text: 'On duty' }),
];

// --- 1. Structural identity across data changes ---
const e1 = recordScreen(APP, medicalV1)!;
const sim = screenSimilarity(computeStableTokens(medicalV1), computeStableTokens(medicalV2));
const e2 = recordScreen(APP, medicalV2)!;
check('same logical screen resolves to same screenId across data changes',
  e1.screenId === e2.screenId, `similarity=${sim.toFixed(2)}, ids ${e1.screenId} vs ${e2.screenId}`);
check('old text-based fingerprints WOULD have fragmented (regression guard)',
  generateFingerprint(medicalV1) !== generateFingerprint(medicalV2));

const e3 = recordScreen(APP, loginScreen)!;
check('different screen gets a different screenId', e3.screenId !== e1.screenId,
  `similarity=${screenSimilarity(computeStableTokens(medicalV1), computeStableTokens(loginScreen)).toFixed(2)}`);

// --- 2. identifyScreen (read-only) ---
const ident = identifyScreen(APP, medicalV1);
check('identifyScreen matches the stored entry', ident?.entry.screenId === e1.screenId,
  `score=${ident?.score.toFixed(2)}`);

// --- 3. Name binding + fuzzy lookup ---
bindScreenName(APP, e1.screenId, 'Medical Record');
check('exact name lookup', getScreenByName(APP, 'medical record')?.screenId === e1.screenId);
check('substring lookup', getScreenByName(APP, 'medical')?.screenId === e1.screenId);
check('token lookup with extra words', getScreenByName(APP, 'the medical records page')?.screenId === e1.screenId);
check('old inferred name preserved as alias',
  (getScreenByName(APP, 'Medical Record')?.aliases ?? []).length > 0);

// camelCase widget-class lookup
const withWidget = getScreenByName(APP, 'Medical Record')!;
withWidget.screenWidget = 'MedicalRecordScreen';
saveScreenMap(withWidget);
check('camelCase widget-class lookup', getScreenByName(APP, 'MedicalRecordScreen')?.screenId === e1.screenId);

// Re-recording must NOT overwrite the agent-bound name
const e4 = recordScreen(APP, medicalV2)!;
check('agent-bound name survives re-recording', e4.name === 'Medical Record', `name="${e4.name}"`);

// --- 4. Edges survive merging of legacy duplicates ---
const dash = recordScreen(APP, dashboard)!;
addNavigationEdge(APP, dash.screenId, { by: 'text', value: 'Medical' }, e1.screenId, 'Medical Record');

// Simulate a legacy fragment: same structure, old-style id, its own edge
const fragment: ScreenMapEntry = {
  screenId: 'legacy01',
  name: 'Records / Allergies / August 2025',
  fingerprint: 'legacy01',
  elements: medicalV1.map(x => ({ ...x })),
  edges: [{ action: { by: 'key', value: 'medical_record_add' }, toScreenId: dash.screenId, toScreenName: 'Dashboard' }],
  lastVerified: new Date(0).toISOString(),
  appId: APP,
};
delete (fragment as Partial<ScreenMapEntry>).stableTokens;
saveScreenMap(fragment);
// Point an edge at the fragment from the dashboard too
addNavigationEdge(APP, dash.screenId, { by: 'text', value: 'Medical (old)' }, 'legacy01', 'Records');

const countBefore = loadAllScreenMaps(APP).length;
const merged = recordScreen(APP, medicalV1)!;
const countAfter = loadAllScreenMaps(APP).length;
check('legacy duplicate merged on contact', countAfter === countBefore - 1 && merged.screenId === e1.screenId,
  `${countBefore} → ${countAfter}`);
check('victim edges absorbed', merged.edges.some(e => e.action.value === 'medical_record_add'));
const dashAfter = loadAllScreenMaps(APP).find(s => s.screenId === dash.screenId)!;
check('edges elsewhere repointed to survivor',
  dashAfter.edges.every(e => e.toScreenId !== 'legacy01')
  && dashAfter.edges.some(e => e.action.value === 'Medical (old)' && e.toScreenId === e1.screenId));
check('victim alias retained', (merged.aliases ?? []).some(a => a.includes('August 2025')));

// --- 5. BFS still works across the consolidated graph ---
const path = findNavigationPath(APP, dash.screenId, e1.screenId);
check('navigation path Dashboard → Medical Record', !!path && path.length === 1,
  path ? path.map(p => p.action.value).join(' → ') : 'no path');

// --- 6. Empty scans never persist ---
check('empty scan returns null', recordScreen(APP, []) === null);

// --- 7. consolidateScreenMaps is safe and idempotent ---
const r1 = consolidateScreenMaps(APP);
const r2 = consolidateScreenMaps(APP);
check('consolidation idempotent', r1.after === r2.after, `after=${r1.after}`);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);

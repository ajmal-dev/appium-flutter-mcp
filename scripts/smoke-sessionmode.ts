/**
 * Direct end-to-end smoke of the new sessionMode + web_navigate work.
 *
 * Invokes the MCP tool handlers as Node functions (not via stdio) so we can
 * confirm the code paths without needing Cursor's MCP client to reconnect.
 *
 * Runs the full non-regression + Safari demo the user would otherwise run
 * through the chat:
 *   1. get_status when disconnected                             (shape check)
 *   2. connect with browserName:Safari                          (mode derivation)
 *   3. get_status when connected                                (new sessionMode field)
 *   4. web_navigate to example.com                              (new tool)
 *   5. find_elements — should return Flutter-only guard         (guard active)
 *   6. get_widget_tree — should return Flutter-only guard       (guard active)
 *   7. inspect(webview, get_url) — should work in Safari        (Safari path works)
 *   8. get_screen — should return screenshot without tree noise (Safari-safe)
 *   9. disconnect
 *
 * On any failure the script prints the failing step and exits non-zero.
 */
import { handleConnect, handleDisconnect, handleGetStatus } from '../src/tools/session.js';
import { handleGetScreen, handleFindElements, handleGetKnownScreen } from '../src/tools/observe.js';
import { handleFlutterLocator } from '../src/tools/locator.js';
import { handleInspect, handleWebNavigate } from '../src/tools/navigate.js';
import { handleVerifyLocator } from '../src/tools/tap-inspect.js';
import { getSessionMode } from '../src/appium/session.js';

const UDID = process.env.APPIUM_UDID ?? '00008101-000238222EA3A01E';

type StepResult = { step: string; ok: boolean; note: string };
const results: StepResult[] = [];

function record(step: string, ok: boolean, note: string) {
  results.push({ step, ok, note });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`\n[${mark}] ${step}\n  ${note}`);
}

function textOf(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
}

async function main() {
  console.log('=== sessionMode + web_navigate smoke ===');
  console.log('UDID:', UDID);

  // Step 1: disconnected get_status
  {
    const r = await handleGetStatus();
    const txt = textOf(r);
    const parsed = JSON.parse(txt);
    const ok = parsed.status === 'disconnected';
    record('1. get_status (disconnected)', ok, `status=${parsed.status} — expected 'disconnected'`);
  }

  // Step 2: connect with Safari caps
  let connectedOk = false;
  try {
    const r = await handleConnect({
      platform: 'ios',
      capabilities: {
        'appium:browserName': 'Safari',
        'appium:automationName': 'XCUITest',
        'appium:udid': UDID,
        'appium:platformVersion': '26.5',
        'appium:xcodeOrgId': '929Q8AE938',
        'appium:xcodeSigningId': 'Apple Development',
        'appium:usePrebuiltWDA': true,
        'appium:derivedDataPath': '~/.appium/wda-build',
        'appium:newCommandTimeout': 300,
      },
    });
    const txt = textOf(r);
    // Only the first block (status JSON) is what we care about
    const firstJson = txt.split('\n\n')[0];
    let parsed: any;
    try { parsed = JSON.parse(firstJson); } catch { parsed = { raw: firstJson }; }
    const ok = parsed.status === 'connected' && parsed.sessionMode === 'safari';
    connectedOk = ok;
    record('2. connect (Safari mode)', ok,
      `status=${parsed.status}, sessionMode=${parsed.sessionMode}, notes=${parsed.notes ?? '<none>'}`);
    console.log('  Also getSessionMode() =', getSessionMode());
  } catch (e) {
    record('2. connect (Safari mode)', false, `EXCEPTION: ${String(e)}`);
  }

  if (!connectedOk) {
    console.log('\nConnect failed — aborting the rest of the smoke.');
    process.exit(1);
  }

  // Step 3: connected get_status — should now include sessionMode
  {
    const r = await handleGetStatus();
    const txt = textOf(r);
    const parsed = JSON.parse(txt);
    const ok = parsed.status === 'connected' && parsed.sessionMode === 'safari';
    record('3. get_status (connected)', ok,
      `status=${parsed.status}, sessionMode=${parsed.sessionMode}, availableContexts=${JSON.stringify(parsed.availableContexts)}, vmService=${JSON.stringify(parsed.vmService)}`);
  }

  // Step 4: web_navigate
  {
    try {
      const r = await handleWebNavigate({ url: 'https://example.com', waitFor: 'load', timeoutMs: 20000 });
      const txt = textOf(r);
      const parsed = JSON.parse(txt);
      const ok = (parsed.status === 'loaded' || parsed.status === 'timeout_but_navigated')
        && typeof parsed.url === 'string' && parsed.url.includes('example.com');
      record('4. web_navigate → example.com', ok,
        `status=${parsed.status}, url=${parsed.url}, title="${parsed.title}", elapsedMs=${parsed.elapsedMs}`);
    } catch (e) {
      record('4. web_navigate → example.com', false, `EXCEPTION: ${String(e)}`);
    }
  }

  // Step 5: find_elements — should return the Flutter-only guard
  {
    const r = await handleFindElements({ by: 'text', value: 'Example Domain', details: false });
    const txt = textOf(r);
    const guarded = /Flutter locator strategies|Flutter-only|sessionMode/.test(txt);
    record('5. find_elements guard fires (Safari mode)', guarded,
      guarded ? 'returned Flutter-only guard as expected' : `did NOT guard — output: ${txt.slice(0, 200)}`);
  }

  // Step 6: get_widget_tree is registered inline in server.ts, but we can smoke
  // the observe-side surrogate guards on get_known_screen instead.
  {
    const r = await handleGetKnownScreen({ listAll: false });
    const txt = textOf(r);
    const guarded = /Flutter-only|sessionMode/.test(txt);
    record('6. get_known_screen guard fires (Safari mode)', guarded,
      guarded ? 'returned Flutter-only guard as expected' : `did NOT guard — output: ${txt.slice(0, 200)}`);
  }

  // Step 7: flutter_locator guard
  {
    const r = await handleFlutterLocator({ description: 'anything', topN: 1, context: 'auto', mode: 'human', verify: false });
    const txt = textOf(r);
    const guarded = /Flutter-only|sessionMode/.test(txt);
    record('7. flutter_locator guard fires (Safari mode)', guarded,
      guarded ? 'returned Flutter-only guard as expected' : `did NOT guard — output: ${txt.slice(0, 200)}`);
  }

  // Step 8: verify_locator guard
  {
    const r = await handleVerifyLocator({ by: 'key', value: 'anything' });
    const txt = textOf(r);
    const guarded = /Flutter-only|sessionMode/.test(txt);
    record('8. verify_locator guard fires (Safari mode)', guarded,
      guarded ? 'returned Flutter-only guard as expected' : `did NOT guard — output: ${txt.slice(0, 200)}`);
  }

  // Step 9: inspect(webview, get_url) — the "does Safari actually drive" test
  {
    try {
      const r = await handleInspect({ target: 'webview', action: 'get_url', format: 'structured' });
      const txt = textOf(r);
      const ok = /example\.com/.test(txt);
      record('9. inspect(webview, get_url) shows example.com', ok, `output starts: ${txt.slice(0, 200)}`);
    } catch (e) {
      record('9. inspect(webview, get_url)', false, `EXCEPTION: ${String(e)}`);
    }
  }

  // Step 10: get_screen (screenshot only, no widget tree)
  {
    try {
      const r = await handleGetScreen({ includeTree: false });
      const hasImage = r.content.some(c => c.type === 'image');
      const noTreeChatter = !r.content.some(c => c.type === 'text' && /Interactive Elements|ValueKeys/.test(c.text ?? ''));
      const ok = hasImage && noTreeChatter;
      record('10. get_screen (Safari, no widget tree)', ok,
        `hasImage=${hasImage}, noTreeChatter=${noTreeChatter}`);
    } catch (e) {
      record('10. get_screen', false, `EXCEPTION: ${String(e)}`);
    }
  }

  // Step 11: disconnect
  {
    try {
      const r = await handleDisconnect({ terminateApp: false });
      const txt = textOf(r);
      const parsed = JSON.parse(txt);
      const ok = parsed.status === 'disconnected';
      record('11. disconnect', ok, `status=${parsed.status}`);
    } catch (e) {
      record('11. disconnect', false, `EXCEPTION: ${String(e)}`);
    }
  }

  console.log('\n=== SUMMARY ===');
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.step}`);
  const passed = results.filter(r => r.ok).length;
  const total = results.length;
  console.log(`\n${passed}/${total} steps passed`);
  process.exit(passed === total ? 0 : 1);
}

main().catch(e => { console.error('SMOKE FAILED:', e); process.exit(1); });

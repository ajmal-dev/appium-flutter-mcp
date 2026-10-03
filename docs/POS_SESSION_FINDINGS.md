# Findings from the live POS package-invoice session (2026-07-17)

Captured while the user manually drove POS → New Invoice → new guest → Botox
package → Package V3 Signup form (fill + dual signature) → IDS authorization →
reopen + assert. These feed the next MCP improvement round.

## High-impact

1. **Manual driving captures NO test.** The user drove the whole flow expecting
   a test to result, but `tap`/`type_text`/`inspect` only record inside an
   `agentic_create_test` run or after `start_recording`. Neither was active, so
   `add_assertion` failed ("No recording in progress") and nothing was captured.
   → Fix: an ambient/always-on capture buffer, OR make `add_assertion` (and a
   new `assert_webview`) auto-start a lightweight recording, OR have the agentic
   run be the default authoring entrypoint. At minimum, `tap`/`type_text` should
   warn once per session when no recording is active during authoring.

2. **`add_assertion` is Flutter-only** (`by: key|text|type`). It cannot express
   a native-modal assertion (IDS authorize dialog) or a webview-value assertion
   (form field == X). Both were needed this session. → Add assertion kinds:
   `assertNativeVisible` (accessibilityId/xpath) and `assertWebviewValue`
   (label/selector → expected).

3. **AMP form element IDs regenerate every render.** First render:
   `#emrny5h4f2c2u-textField`; reopened: `#emrnyslzg4e8b-textField`. Any test
   that captures the generated `emrny…` id breaks on the next run. → Codegen and
   `webview_fill_form`/assertions MUST resolve webview inputs by LABEL→input
   association, never by generated id. A naive recorder that stores the id is a
   guaranteed flake. Document label-based locator as the required webview
   strategy.

## Medium

4. **`webview_fill_form` matched hidden mirror inputs** — every field reported
   `inputType: "input:hidden"` and the visible values didn't get set; the actual
   fill that stuck was a manual `setNative` on visible elements. → The form-fill
   matcher must skip `type=hidden` and prefer the visible associated control.

5. **Non-editable webview fields aren't marked `disabled`.** The AMP "Expiry
   Date" / date-picker inputs accept a programmatic value but don't persist it
   (Date and DOB came back empty after save). The visible-field heuristic
   (`frees[0]/frees[1]`) set the wrong inputs. → Date/DOB in AMP forms are
   picker-backed; setting `.value` doesn't commit. Needs a picker-aware fill or
   a documented limitation.

6. **The IDS authorization modal is native-surfaced, NOT drivable as a webview.**
   `switch_context` into its webview blocked the WebKit debugger and CRASHED the
   Appium session (auto-recovered) — the exact CLAUDE.md limitation. But its
   fields ARE in the native a11y tree (TextField/SecureTextField/Button). →
   The blind-switch loop still tried the undrivable webview and burned ~2min +
   a session crash. `switch_context` should treat repeated context-POST timeouts
   on a given webview as "quarantine this id for the session" (like the VM flavor
   sticky-disable) instead of retrying it every call.

7. **`find_elements(by:type)` crashed the driver** with
   `RenderBox was not laid out: NEEDS-LAYOUT` (GestureDetector) — background
   appointment-book widgets that aren't laid out poison the type scan. Same
   multi-FlutterView root cause noted for the tree. → type finders should catch
   the layout assertion and fall back, not surface it as a hard error.

## Locator gaps (belongs in valuekeys-required.md for the Flutter team)

- POS screens expose ZERO ValueKeys. Everything used text, type+index, or
  coordinates:
  - Left nav POS icon → custom button index 1 (fragile; needs
    `nav_pos_button` or similar)
  - Package "+" add button → `InkWell` index 12 (very fragile — shifts with list
    size). Needs `pos_package_add_button_<id>`.
  - "Fill forms for N package(s)" banner chevron + the "Botox Package →" row →
    coordinate taps only (no type/semantics reachable). Needs
    `pos_package_form_expand` / `pos_package_form_row_<id>`.
- The ValueKey summary printed alongside screenshots showed STALE `apb_*`
  (appointment-book) keys on POS screens — the VM tree still surfaces the
  background FlutterView's keys. Minor, but misleading during authoring.

## Positives confirmed live

- Session auto-recovery from idle timeout worked (~0.5s) multiple times.
- JS-first CSS tap (`#btnHtmlFormSave`) worked cleanly (1 match, no atom wait).
- `inspect(elements)` on the form webview returned 22 elements compactly
  (vs the old raw-HTML dump).
- Batch fill (New Guest: first/last/email + Save) ran as one call, one shot.
- Signatures drawn via synthesized pointer events persisted across save+reopen
  (canvas 4458→6210/6246 bytes, still present on reopen).

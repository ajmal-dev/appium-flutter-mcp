/**
 * Render the per-cycle agent contract.
 *
 * The MCP doesn't make LLM calls — Claude (the caller) is the agent. This
 * module emits the structured prompt the agent reads at the start of the run
 * and after every agentic_test_step. Goal: tight, hybrid-app-aware
 * instructions that keep the agent looping autonomously until the test is
 * generated and verified, or a stop condition fires.
 */

import type { AgenticRunState, AgenticPhase } from './run-state.js';
import type { FlowMatch, FlowStep } from '../world/flow-store.js';
import type { PitfallEntry } from '../world/pitfall-store.js';
import type { InventoryEntry } from '../world/test-inventory.js';
import { HYBRID_LOCATOR_RULES_MD } from './locator-playbook.js';

export interface ContractInputs {
  state: AgenticRunState;
  /** Compact element summary captured alongside the latest screenshot. */
  elementSummary?: string;
  /** Device viewport string like "1170x2532px". */
  deviceDims?: string;
  /** Newly-detected screen name (from the current screen-map entry, if any). */
  currentScreenName?: string;
  /** Where the latest screenshot was saved (relative to the run dir). */
  screenshotFile?: string;
  /** Optional "screen changed?" hint for follow-up cycles. */
  screenChanged?: boolean;
  /** Optional delta line ("+2 TextField, -1 IconButton"). */
  screenDelta?: string;
  /** Pre-existing scan from a recently-failed action. */
  errorScan?: { compact: string; capturedAt: number };
  /** Last finished/inferred event so the contract can echo it back. */
  lastObservation?: string;
  /** true → render the LEAN per-cycle update instead of the full contract.
   *  The full playbook/stop-conditions/reporting spec were already delivered at
   *  kickoff and sit in the agent's context — re-sending them every cycle cost
   *  ~2k tokens/cycle for zero information. */
  cycle?: boolean;
  /** Cycle mode: the phase advanced during this step → include the new phase playbook. */
  phaseChanged?: boolean;
  /** Cycle mode: element summary is byte-identical to the previous cycle. */
  elementsUnchanged?: boolean;
  /** Cycle mode: no screenshot was captured for this cycle. */
  screenshotSkipped?: boolean;
}

export function renderAgentContract(inputs: ContractInputs): string {
  if (inputs.cycle) return renderCycleUpdate(inputs);
  const { state } = inputs;
  const lines: string[] = [];

  lines.push(`# Agentic test creation — goal: ${state.goal}`);
  lines.push(`Run ID: \`${state.runId}\` · App: \`${state.appId}\` · Phase: **${state.phase}** · Step ${state.stepCount}/${state.maxSteps}`);
  if (inputs.deviceDims) lines.push(`Device viewport: ${inputs.deviceDims} (use these device pixels for any coordinate-based action).`);
  if (state.projectPath) lines.push(`Target project: \`${state.projectPath}\` (test will be exported here when finished).`);

  // Preflight — only render at start (stepCount 0) and whenever a warning exists.
  const preflightBlock = renderPreflight(state);
  if (preflightBlock) lines.push('', preflightBlock);

  // Recall block — flows + pitfalls + inventory hit
  const recall = renderRecallBlock(state.recalledFlows, state.recalledPitfalls, state.inventoryHit);
  if (recall) lines.push('', recall);

  // Current screen state
  if (inputs.currentScreenName) {
    lines.push(`\n**Current screen:** ${inputs.currentScreenName}${state.lastScreenFingerprint ? ` (fp ${state.lastScreenFingerprint.slice(0, 8)})` : ''}`);
  }
  if (state.lastContext) {
    lines.push(`**Current context:** ${state.lastContext} — use the matching locator family below.`);
  }
  if (inputs.screenChanged === true) {
    lines.push(`Screen changed since the previous step${inputs.screenDelta ? ` (${inputs.screenDelta})` : ''}.`);
  } else if (inputs.screenChanged === false) {
    lines.push(`Screen UNCHANGED since the previous step. Reconsider the strategy: different locator, scroll/wait, tap by description, or coordinates as a last resort.`);
  }
  if (inputs.errorScan) {
    const ageSec = Math.max(0, Math.round((Date.now() - inputs.errorScan.capturedAt) / 1000));
    lines.push(`\n## Pre-existing scan from your last failed action (${ageSec}s ago)\n${inputs.errorScan.compact}`);
  }

  lines.push('', renderPhasePlaybook(state.phase));
  lines.push('', renderLocatorPlaybook());
  lines.push('', renderStopConditions(state));

  if (inputs.elementSummary && inputs.elementSummary.trim()) {
    lines.push('', '## Current screen elements (compact)', inputs.elementSummary.trim());
  }

  lines.push('', `## Reporting — checkpoints, not micro-steps`);
  lines.push(`Every tap/type/gesture is auto-recorded — you do NOT need a step call per action.`);
  lines.push(`Call agentic_test_step at CHECKPOINTS: after a screen transition, after completing a sub-goal, when advancing phase, or when stuck. For a known multi-action sequence (fill 3 fields + submit), run it as ONE batch_actions call, then report once.`);
  lines.push('```');
  lines.push(`agentic_test_step({`);
  lines.push(`  status: "ok" | "progress" | "stuck" | "note",   // "progress" = you reached a new screen, "stuck" = no_progress streak warning`);
  lines.push(`  observation: "<what you just did and what you saw>",`);
  lines.push(`  phase: "GROUND" | "PLAN" | "EXPLORE_EXECUTE" | "VERIFY" | "FINISH",   // optional — server advances phase if you omit it`);
  lines.push(`  screenName: "<human label>",                      // optional — bind the current screen to a name for memory`);
  lines.push(`  screenshot: "auto" | "always" | "never"           // optional — default "auto": screenshot only when the screen changed`);
  lines.push(`})`);
  lines.push('```');
  lines.push(`Each cycle response is a LEAN delta (step counter, screen-change flag, element list when it changed). This kickoff message is the only place the full playbook appears — keep applying it for the whole run.`);
  lines.push(`When the assertion passes and you're confident the goal was met, call:`);
  lines.push('```');
  lines.push(`agentic_finish({ verdict: "pass" | "fail" | "abort", summary: "<one paragraph>" })`);
  lines.push('```');
  lines.push(`On verdict="pass" the MCP will: stop recording → generate Java test → export to project → run \`mvn -q compile\` → write the flow record. On "fail" or "abort" the MCP writes a pitfall entry and leaves the recording intact for retry.`);

  if (inputs.screenshotFile) {
    lines.push('', `The screenshot below is the current device state. Saved to: ${inputs.screenshotFile}.`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Lean per-cycle update — everything static lives in the kickoff contract.
// ---------------------------------------------------------------------------

function renderCycleUpdate(inputs: ContractInputs): string {
  const { state } = inputs;
  const lines: string[] = [];
  const remaining = state.maxSteps - state.stepCount;

  const screenBit = state.lastScreenName ? ` · Screen: ${state.lastScreenName}` : '';
  const ctxBit = state.lastContext ? ` · Context: ${state.lastContext}` : '';
  lines.push(`## Step ${state.stepCount}/${state.maxSteps} · Phase **${state.phase}**${screenBit}${ctxBit}`);

  if (inputs.screenChanged === true) {
    lines.push(`Screen CHANGED${inputs.screenDelta ? ` (${inputs.screenDelta})` : ''}.`);
  } else if (inputs.screenChanged === false) {
    lines.push('Screen UNCHANGED since the previous step. If your last action should have changed it: different locator, scroll/wait, tap by description, or coordinates as a last resort.');
  }

  if (inputs.errorScan) {
    const ageSec = Math.max(0, Math.round((Date.now() - inputs.errorScan.capturedAt) / 1000));
    lines.push('', `### Scan from your last failed action (${ageSec}s ago)`, inputs.errorScan.compact);
  }

  // Phase playbook only when the phase actually advanced this call — the agent
  // already has the previous phase's playbook in context.
  if (inputs.phaseChanged) {
    lines.push('', renderPhasePlaybook(state.phase));
  }

  if (inputs.elementSummary && inputs.elementSummary.trim()) {
    if (inputs.elementsUnchanged) {
      lines.push('', 'Elements unchanged — reuse the list from the previous cycle.');
    } else {
      lines.push('', '## Current screen elements (compact)', inputs.elementSummary.trim());
    }
  }

  if (remaining <= 3) {
    lines.push('', `⚠️ Step budget: ${remaining} step${remaining === 1 ? '' : 's'} left before auto-abort. Wrap up or call agentic_finish.`);
  }
  if (state.noProgressStreak >= 2) {
    lines.push(`⚠️ No-progress streak ${state.noProgressStreak}/3 — one more step without screen change or recorded action aborts the run.`);
  }

  if (inputs.screenshotSkipped) {
    lines.push('', '(screenshot skipped — screen unchanged; pass screenshot: "always" to force one)');
  } else if (inputs.screenshotFile) {
    lines.push('', `Screenshot below is the current device state (saved: ${inputs.screenshotFile}).`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------

function renderPreflight(state: AgenticRunState): string | null {
  const p = state.preflight;
  if (!p) return null;

  // After the agent has started moving (stepCount > 0), only surface
  // preflight if something is still wrong — successful pre-checks are noise.
  const hasIssue = !p.vmService.ok || !p.app.ok || p.warnings.length > 0;
  if (state.stepCount > 0 && !hasIssue) return null;

  const lines: string[] = ['## Preflight'];
  lines.push(`- Appium session: OK (platform=${p.appiumSession.platform}${p.appiumSession.sessionId ? `, sessionId=${p.appiumSession.sessionId.slice(0, 8)}…` : ''})`);
  if (p.vmService.ok) {
    lines.push(`- Dart VM Service: OK${p.vmService.url ? ` (${p.vmService.url})` : ''}`);
  } else {
    lines.push(`- Dart VM Service: **NOT CONNECTED**${p.vmService.reason ? ` — ${p.vmService.reason}` : ''}`);
  }
  if (p.app.ok) {
    lines.push(`- App: ${p.app.bundleId} foregrounded (${p.app.state})`);
  } else {
    lines.push(`- App: ${p.app.bundleId} **not foregrounded** (${p.app.state ?? p.app.reason ?? 'unknown'})`);
  }
  if (p.webviews.length) {
    lines.push(`- WebViews exposed: ${p.webviews.length}`);
    for (const w of p.webviews) {
      const url = w.url ? ` url=\`${w.url}\`` : '';
      const title = w.title ? ` title=${JSON.stringify(w.title)}` : '';
      lines.push(`    - \`${w.id}\`${url}${title}`);
    }
    lines.push(`  → switch with \`switch_context({to: "webview", urlFragment: "<piece of URL>"})\` — add \`waitForNew: true\` to wait for a NEWLY-spawned webview.`);
  } else {
    lines.push(`- WebViews exposed: none yet`);
  }
  if (p.warnings.length) {
    lines.push('');
    lines.push('### Action required');
    for (const w of p.warnings) lines.push(`- ${w}`);
  }

  return lines.join('\n');
}

function renderRecallBlock(
  flows: FlowMatch[],
  pitfalls: PitfallEntry[],
  inventoryHit?: InventoryEntry,
): string | null {
  const sections: string[] = [];

  if (inventoryHit) {
    sections.push(
      `## Existing test for this goal\n`
      + `\`${inventoryHit.testClassName}\` already exists at \`${inventoryHit.filePath}\` (generated ${inventoryHit.generatedAt.slice(0, 10)}).\n`
      + `If the user wants a re-run with the same intent, prefer **augmenting** the existing test (add new assertions or branches) over creating a duplicate. Mention this in your finish summary.`,
    );
  }

  if (flows.length) {
    const lines: string[] = ['## Recalled flows (from prior runs)'];
    for (const m of flows) {
      const f = m.flow;
      lines.push(`- **${f.id}** — "${f.goal}" (${f.successCount} successes, score ${m.score.toFixed(2)}, matched: ${m.matchedTokens.join(', ')})`);
      const head = previewFlowSteps(f.steps);
      if (head) lines.push(`  Replay sketch: ${head}`);
    }
    lines.push(`If one flow clearly fits the current goal, try the replay sketch first to skip exploration. Verify on the device — recalled flows can be stale.`);
    sections.push(lines.join('\n'));
  }

  if (pitfalls.length) {
    const lines: string[] = ['## Known pitfalls'];
    for (const p of pitfalls) {
      lines.push(`- [${p.failureKind}] ${p.summary}${p.hint ? `  → hint: ${p.hint}` : ''}`);
    }
    lines.push(`Don't repeat these traps. If you suspect you're hitting one, finish with verdict="abort" and a clear summary.`);
    sections.push(lines.join('\n'));
  }

  return sections.length ? sections.join('\n\n') : null;
}

function previewFlowSteps(steps: FlowStep[]): string {
  if (!steps.length) return '';
  const head = steps.slice(0, 6).map(s => {
    const tgt = s.target ? `"${s.target}"` : '';
    const ctx = s.context && s.context !== 'flutter' ? `[${s.context}]` : '';
    return `${s.action}${ctx}${s.by ? ` ${s.by}=${tgt}` : tgt ? ` ${tgt}` : ''}`;
  }).join(' → ');
  return steps.length > 6 ? `${head} → … (${steps.length - 6} more)` : head;
}

// ---------------------------------------------------------------------------

function renderPhasePlaybook(phase: AgenticPhase): string {
  switch (phase) {
    case 'GROUND':
      return [
        '## Phase 1 · GROUND',
        'You\'ve been handed the current device state and any prior knowledge. Job:',
        '1. **Read the Preflight block above.** If the VM Service is not connected, ask the user for the Dart VM `ws://…/ws` URL and re-call `connect` with `vmServiceUrl` — Flutter operations are unreliable without it. If the app is not foregrounded, call `launch_app`.',
        '2. Read the screenshot + element summary.',
        '3. The orchestrator started recording for you the moment this run was created — every tap/type/gesture/switch_context is being captured.',
        '4. Identify the current screen. Use `get_known_screen` to check if it\'s already named; if it is, bind it via `agentic_test_step({screenName: "..."})`.',
        '5. When preflight is green and you have enough context, advance: `agentic_test_step({phase: "PLAN", status: "ok", observation: "..."})`.',
      ].join('\n');
    case 'PLAN':
      return [
        '## Phase 2 · PLAN',
        'Decide the approach based on what was recalled above:',
        '- **Replay**: a recalled flow fits the goal closely → step through its replay sketch, validating each screen transition on the device.',
        '- **Extend**: a recalled flow gets you part-way (e.g. login is known, the new tail is the appointment flow) → replay the known prefix, then explore the rest.',
        '- **Full explore**: no useful recall → drive the app yourself using the locator playbook.',
        'Then advance: `agentic_test_step({phase: "EXPLORE_EXECUTE", status: "ok", observation: "<chosen approach>"})`.',
      ].join('\n');
    case 'EXPLORE_EXECUTE':
      return [
        '## Phase 3 · EXPLORE_EXECUTE',
        'Drive the app toward the goal. Loop:',
        '1. Look at the latest screenshot + element summary.',
        '2. Pick the most reliable primitive for the next action (see locator playbook below). If the context changed (e.g. payment opens a webview), call `switch_context` before acting.',
        '3. Execute actions via `tap` (locator, coordinates, or description) / `type_text` / `gesture` (incl. scroll_until_visible) / `webview_fill_form` / `navigate_to`. Recording captures everything automatically. **Known multi-action sequences (form fills, tap-then-confirm) go in ONE `batch_actions` call** — it is dramatically faster than one tool call per action.',
        '4. At each CHECKPOINT (screen transition / sub-goal / stuck) call `agentic_test_step({status, observation})`. Do NOT call it after every micro-action — actions are recorded regardless; step calls are for steering and progress tracking.',
        '5. When the goal state is on screen, add an assertion: `add_assertion({type: "assertVisible", by: "...", target: "..."})` (or another assertion type). Then advance: `agentic_test_step({phase: "VERIFY", status: "ok", observation: "asserted ..."})`.',
      ].join('\n');
    case 'VERIFY':
      return [
        '## Phase 4 · VERIFY',
        'You\'ve added at least one assertion that captures the success condition. Sanity-check:',
        '1. Is the device actually on the expected screen? Look at the screenshot one more time.',
        '2. Is the assertion useful — i.e. would it catch a regression? If too weak, add a stronger one with `add_assertion`.',
        '3. When confident, finish: `agentic_finish({verdict: "pass", summary: "..."})`. The MCP will stop recording, generate the Java test, export it, run `mvn -q -DskipTests compile`, and write the flow record. If compile fails, the response shows the first `[ERROR]` line — fix it via `apply_fix` / direct edit, or call `test_debug_fix` for the runtime self-heal loop.',
      ].join('\n');
    case 'FINISH':
      return [
        '## Phase 5 · FINISH',
        'The run already completed. Read the report path printed in the previous response and stop calling agentic tools.',
      ].join('\n');
  }
}

function renderLocatorPlaybook(): string {
  return [
    '## Locator playbook (hybrid app — Flutter + Native + WebView)',
    '**Flutter context (default for ZMA):**',
    '- Prefer `flutter_locator({description, mode: "structured", verify: true})` to discover ValueKey > semanticsLabel > text > type.',
    '- Tap → `tap({by: "key"|"text"|"semanticsLabel"|"type", target, index?})`.',
    '- Type → `type_text({by: "key"|"semanticsLabel", target, text, clearFirst?})` — on iOS this uses Flutter\'s VM `enterText`, which is far more reliable than coordinate typing.',
    '- Ambiguous label → `tap({description: "<what you see>"})` (fuzzy-matches visible elements).',
    '- Coordinates are a **last resort** and only when no stable locator exists after checking the widget tree.',
    '',
    '**Native context (system dialogs, OS pickers, permission prompts):**',
    '- Inspect first with `inspect({target: "native", format: "structured"})`.',
    '- Tap/type with `{by: "accessibilityId"|"xpath", target}`.',
    '',
    '**WebView context (payment, embedded portals, login form):**',
    '- Enter with `switch_context({to: "webview", urlFragment, waitForNew: true, contentPredicate?})`.',
    '- Form fills are best done in bulk via `webview_fill_form({fields: [...]})`.',
    '- Otherwise `tap`/`type_text` with `{by: "css"|"xpath", target}`.',
    '',
    'Whenever the screen mix changes (e.g. an action drops you into a webview), `switch_context` before the next action and bind the new screen with `agentic_test_step({screenName: "..."})`.',
    '',
    HYBRID_LOCATOR_RULES_MD,
  ].join('\n');
}

function renderStopConditions(state: AgenticRunState): string {
  return [
    '## Stop conditions',
    `- **Success**: assertion captured, you call \`agentic_finish({verdict: "pass"})\`. The MCP runs codegen → export → \`mvn -q compile\` → writes flow + inventory.`,
    `- **Step budget**: ${state.maxSteps} agent steps. The orchestrator aborts and writes a pitfall.`,
    `- **No-progress streak**: 3 consecutive steps with no screen change AND no recorded action. The orchestrator aborts and writes a pitfall.`,
    `- **Hard blockers**: session drop, app crash, auth-blocked. Finish with \`verdict: "abort"\` and a clear summary so the pitfall captures the cause.`,
  ].join('\n');
}

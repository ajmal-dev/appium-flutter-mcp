/**
 * Agentic test-creation MCP tools.
 *
 * High-level autonomous wrapper around the existing recording / locator / codegen
 * / export / verify primitives. The agent (Claude) drives the loop; the MCP
 * dictates the workflow contract and automates the deterministic phases.
 *
 * Tools:
 *  - agentic_create_test — start a run, return the contract + initial screenshot
 *  - agentic_test_step   — report progress, get the next contract cycle
 *  - agentic_finish      — codegen → export → mvn verify → write flow + inventory
 *  - world_recall        — query the persistent world model
 *  - world_remember      — write a learning entry (mostly used internally)
 */

import { z } from 'zod';
import { hasBrowser, getBrowserWithReconnect } from '../appium/session.js';
import { logger } from '../util/logger.js';
import type { McpToolResponse } from '../types.js';

import {
  startAgenticRun, stepAgenticRun, finishAgenticRun,
  renderContractFor, type StartArgs, type FinishArgs,
} from '../agent/orchestrator.js';
import { getActive as getAgentRun } from '../agent/run-state.js';

import {
  loadAllFlows, loadFlow, recallFlows, saveFlow,
  flowIdFromGoal, tagsFromGoal, type FlowRecord,
} from '../world/flow-store.js';
import { recallPitfalls, recordPitfall } from '../world/pitfall-store.js';
import { loadInventory, findInventoryByGoal, upsertInventoryEntry } from '../world/test-inventory.js';
import { getCurrentAppId } from '../context/screen-map-store.js';

// ---------------------------------------------------------------------------
// agentic_create_test
// ---------------------------------------------------------------------------

export const agenticCreateTestSchema = z.object({
  goal: z.string().min(3).describe('Plain-English description of the test to author, e.g. "Create a test for booking a guest appointment". The orchestrator slugifies this into a flow id and uses the words as recall tags.'),
  projectPath: z.string().optional().describe('Path to the zmauiautomation Java project. Defaults to AUTOMATION_PROJECT_PATH env / config.'),
  testClassName: z.string().optional().describe('Override the generated test class name. Inferred from the goal if omitted.'),
  testMethodName: z.string().optional().describe('Override the generated test method name.'),
  packageName: z.string().optional().describe('Java package for the generated test. Default: com.zma.automation.tests.'),
  maxSteps: z.number().int().positive().max(200).optional().describe('Hard cap on agent loop iterations. Default 60.'),
  exportOnSuccess: z.boolean().optional().describe('Whether to write generated code into the project on pass. Default true.'),
  verifyWithMaven: z.boolean().optional().describe('Whether to run `mvn -q -DskipTests compile` after export. Default true.'),
  runTestAfterExport: z.boolean().optional().describe(
    'After successful export + compile, run the generated test class with `mvn clean test`. ' +
    'If the test fails the result is returned so Claude can use MCP live inspection to debug. Default false.'
  ),
});

export async function handleAgenticCreateTest(params: z.infer<typeof agenticCreateTestSchema>): Promise<McpToolResponse> {
  if (!hasBrowser()) {
    return errorResponse('No active Appium session. Call `connect` (and `app_control({action: "launch"})` if needed) before agentic_create_test.');
  }
  if (getAgentRun()) {
    return errorResponse('An agentic run is already active. Call agentic_finish on the current run before starting a new one.');
  }

  const browser = await getBrowserWithReconnect();
  try {
    const args: StartArgs = {
      goal: params.goal,
      projectPath: params.projectPath,
      testClassName: params.testClassName,
      testMethodName: params.testMethodName,
      packageName: params.packageName,
      maxSteps: params.maxSteps,
      exportOnSuccess: params.exportOnSuccess,
      verifyWithMaven: params.verifyWithMaven,
      runTestAfterExport: params.runTestAfterExport,
    };
    const { initialObservation } = await startAgenticRun(browser, args);
    const text = renderContractFor({ deviceDims: initialObservation.dims });
    return {
      content: [
        { type: 'text' as const, text },
        { type: 'image' as const, data: initialObservation.base64, mimeType: initialObservation.mimeType },
      ],
    };
  } catch (e) {
    logger.error('agentic_create_test failed', { error: String(e) });
    return errorResponse(String(e));
  }
}

// ---------------------------------------------------------------------------
// agentic_test_step
// ---------------------------------------------------------------------------

export const agenticTestStepSchema = z.object({
  observation: z.string().describe('Short factual note: what you did since the last cycle, what you saw, what changed.'),
  status: z.enum(['ok', 'progress', 'stuck', 'note']).optional().describe('"progress" = reached a new screen / completed a sub-goal (resets no-progress streak). "stuck" = signals you are unsure or hit a dead-end (orchestrator may suggest aborting). "note" = no-op marker. Default "ok".'),
  phase: z.enum(['GROUND', 'PLAN', 'EXPLORE_EXECUTE', 'VERIFY', 'FINISH']).optional().describe('Advance the phase. Optional — the server keeps the current phase if omitted. Phases are monotonic; you cannot go backward.'),
  screenName: z.string().optional().describe('Bind a human label to the current screen so future runs can reference it.'),
  screenshot: z.enum(['auto', 'always', 'never']).optional().describe('Screenshot policy for this cycle. Default "auto": capture only when the screen content changed since the previous cycle. "never" = text-only cycle (fastest). "always" = force a fresh capture.'),
});

export async function handleAgenticTestStep(params: z.infer<typeof agenticTestStepSchema>): Promise<McpToolResponse> {
  const state = getAgentRun();
  if (!state) return errorResponse('No active agentic run. Call agentic_create_test first.');

  const browser = await getBrowserWithReconnect();
  try {
    const stepped = await stepAgenticRun(browser, {
      status: params.status,
      observation: params.observation,
      phase: params.phase,
      screenName: params.screenName,
      screenshot: params.screenshot,
    });

    // Lean per-cycle contract — the full playbook was delivered at kickoff.
    const cycleInputs = {
      deviceDims: stepped.observation.dims,
      screenChanged: stepped.screenChanged,
      screenDelta: stepped.screenDelta,
      cycle: true,
      phaseChanged: stepped.phaseChanged,
      elementsUnchanged: stepped.observation.elementsUnchanged,
      screenshotSkipped: stepped.observation.screenshotSkipped,
    };

    // Only attach an image block when a screenshot was actually captured.
    const imageBlocks: McpToolResponse['content'] = stepped.observation.screenshotSkipped
      ? []
      : [{ type: 'image' as const, data: stepped.observation.base64, mimeType: stepped.observation.mimeType }];

    if (stepped.stopFired && stepped.autoStopReason) {
      const reason = stepped.autoStopReason;
      const hint = reason === 'step_budget'
        ? `Reached the ${state.maxSteps}-step budget. If the goal is still not met, call agentic_finish with verdict="abort". Otherwise finish with verdict="pass" only if you genuinely captured a working flow + assertion.`
        : `No-progress streak — 3 consecutive steps with no screen change and no recorded action. If you can't unblock with a different locator / scroll / wait, call agentic_finish with verdict="abort" and a clear summary so the pitfall captures the cause.`;
      const contract = renderContractFor(cycleInputs);
      return {
        content: [
          { type: 'text' as const, text: `STOP CONDITION FIRED: ${reason}\n${hint}\n\n${contract}` },
          ...imageBlocks,
        ],
      };
    }

    const text = renderContractFor(cycleInputs);
    return {
      content: [
        { type: 'text' as const, text },
        ...imageBlocks,
      ],
    };
  } catch (e) {
    logger.error('agentic_test_step failed', { error: String(e) });
    return errorResponse(String(e));
  }
}

// ---------------------------------------------------------------------------
// agentic_finish
// ---------------------------------------------------------------------------

export const agenticFinishSchema = z.object({
  verdict: z.enum(['pass', 'fail', 'abort']).describe('"pass" runs the codegen → export → mvn verify pipeline and writes the flow record. "fail" or "abort" writes a pitfall and skips export.'),
  summary: z.string().describe('One-paragraph summary of what was verified, what went wrong, or why the run was aborted. Persisted into the flow / pitfall record.'),
});

export async function handleAgenticFinish(params: z.infer<typeof agenticFinishSchema>): Promise<McpToolResponse> {
  const state = getAgentRun();
  if (!state) return errorResponse('No active agentic run. Call agentic_create_test first.');

  try {
    const args: FinishArgs = { verdict: params.verdict, summary: params.summary };
    const result = await finishAgenticRun(args);

    const lines: string[] = [];
    lines.push(`Agentic run finished — verdict: ${params.verdict.toUpperCase()}  (stop: ${result.stopReason})`);
    lines.push(`Report: ${result.reportPaths.reportHtml}`);
    lines.push(`        ${result.reportPaths.reportJson}`);
    if (result.recording) {
      lines.push(`Recording: ${result.recording.id} — ${result.recording.actions.length} actions captured.`);
    }
    if (result.generated) {
      lines.push(`Generated test class: ${result.generated.testClass.fileName} → ${result.generated.testClass.filePath}`);
      if (result.generated.pageObjects.length > 0) {
        lines.push(`Page objects: ${result.generated.pageObjects.map(p => p.fileName).join(', ')}`);
      }
    }
    if (result.exportResult) {
      lines.push(`Export: ${result.exportResult.success ? 'OK' : 'FAILED'} — ${result.exportResult.summary || ''}`);
    }
    if (result.compileResult) {
      lines.push(`mvn compile: ${result.compileResult.ok ? 'OK' : 'FAILED'}`);
      if (!result.compileResult.ok) {
        const first = result.compileResult.output.match(/\[ERROR\][^\n]*/)?.[0];
        if (first) lines.push(`  ${first}`);
        lines.push(`  Full output saved alongside the run report. Use \`test_debug_fix\` if you want the self-heal loop to take a pass.`);
      }
    }
    if (result.testRunResult) {
      if (result.testRunResult.ok) {
        lines.push(`mvn test: PASSED ✅ — generated test runs green on device`);
      } else {
        lines.push(`mvn test: FAILED ❌ — use MCP live inspection to diagnose before making code changes`);
        lines.push(`  Failures:`);
        for (const f of result.testRunResult.failures.slice(0, 5)) {
          lines.push(`    ${f}`);
        }
        lines.push(`  Next steps:`);
        lines.push(`    1. Use get_screen / find_elements / inspect({target: "native"}) to observe the live device state`);
        lines.push(`    2. Identify the root cause (wrong locator? timing? wrong screen?)`);
        lines.push(`    3. Fix the generated test or add a ValueKey to the Flutter source`);
        lines.push(`    4. Re-run agentic_create_test or call test_debug_fix`);
      }
    }
    if (result.flow) {
      lines.push(`Flow record: ${result.flow.id} (success #${result.flow.successCount})`);
    }
    if (result.inventory) {
      lines.push(`Inventory: ${result.inventory.testClassName} — compile=${result.inventory.compileStatus}`);
    }
    if (result.pitfall) {
      lines.push(`Pitfall recorded: [${result.pitfall.failureKind}] ${result.pitfall.summary} (occurrences ${result.pitfall.occurrences})`);
    }

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  } catch (e) {
    logger.error('agentic_finish failed', { error: String(e) });
    return errorResponse(String(e));
  }
}

// ---------------------------------------------------------------------------
// world_recall / world_remember
// ---------------------------------------------------------------------------

export const worldRecallSchema = z.object({
  scope: z.enum(['flows', 'pitfalls', 'inventory', 'all']).describe('Which slice of the world model to query.'),
  query: z.string().optional().describe('Free-text query. Tokenised against tags + goals for flows; substring match against summaries for pitfalls; goal-equality for inventory.'),
  appId: z.string().optional().describe('Override app id. Defaults to the current session\'s app.'),
  limit: z.number().int().positive().max(20).optional().describe('Max results per scope. Default 5.'),
});

export async function handleWorldRecall(params: z.infer<typeof worldRecallSchema>): Promise<McpToolResponse> {
  const appId = params.appId || getCurrentAppId() || 'unknown-app';
  const limit = params.limit ?? 5;
  const out: Record<string, unknown> = { appId };

  if (params.scope === 'flows' || params.scope === 'all') {
    out.flows = params.query
      ? recallFlows(appId, params.query, limit).map(m => ({ id: m.flow.id, goal: m.flow.goal, score: m.score, matched: m.matchedTokens, successCount: m.flow.successCount, generatedTestPath: m.flow.generatedTestPath }))
      : loadAllFlows(appId).slice(0, limit).map(f => ({ id: f.id, goal: f.goal, successCount: f.successCount, lastVerifiedAt: f.lastVerifiedAt }));
  }
  if (params.scope === 'pitfalls' || params.scope === 'all') {
    out.pitfalls = recallPitfalls(appId, { goal: params.query, limit });
  }
  if (params.scope === 'inventory' || params.scope === 'all') {
    if (params.query) {
      const hit = findInventoryByGoal(appId, params.query);
      out.inventory = hit ? [hit] : [];
    } else {
      out.inventory = loadInventory(appId).entries.slice(0, limit);
    }
  }
  return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }] };
}

export const worldRememberSchema = z.object({
  scope: z.enum(['flow', 'pitfall', 'inventory']).describe('Which store to write to.'),
  appId: z.string().optional().describe('Override app id. Defaults to the current session\'s app.'),
  payload: z.record(z.unknown()).describe('Entry payload. For "flow": { goal, steps[], tags?, generatedTestPath? }. For "pitfall": { goal, summary, failureKind?, screenFingerprint?, hint? }. For "inventory": full InventoryEntry minus generatedAt.'),
});

export async function handleWorldRemember(params: z.infer<typeof worldRememberSchema>): Promise<McpToolResponse> {
  const appId = params.appId || getCurrentAppId() || 'unknown-app';
  try {
    switch (params.scope) {
      case 'flow': {
        const p = params.payload as Record<string, unknown>;
        const goal = String(p.goal ?? '').trim();
        if (!goal) return errorResponse('flow payload requires "goal"');
        const steps = Array.isArray(p.steps) ? p.steps as FlowRecord['steps'] : [];
        const id = String(p.id ?? flowIdFromGoal(goal));
        const tags = Array.isArray(p.tags) ? (p.tags as string[]) : tagsFromGoal(goal);
        const existing = loadFlow(appId, id);
        const record: FlowRecord = existing
          ? { ...existing, steps, tags, lastVerifiedAt: new Date().toISOString() }
          : {
            schemaVersion: 1, id, goal, tags, appId,
            createdAt: new Date().toISOString(), lastVerifiedAt: new Date().toISOString(),
            successCount: 0, failCount: 0, steps,
            generatedTestPath: typeof p.generatedTestPath === 'string' ? p.generatedTestPath : undefined,
          };
        saveFlow(record);
        return ok({ saved: 'flow', id: record.id });
      }
      case 'pitfall': {
        const p = params.payload as Record<string, unknown>;
        const goal = String(p.goal ?? '').trim();
        const summary = String(p.summary ?? '').trim();
        if (!goal || !summary) return errorResponse('pitfall payload requires "goal" and "summary"');
        const saved = recordPitfall(appId, {
          goal,
          summary,
          failureKind: (p.failureKind as any) ?? 'other',
          screenFingerprint: typeof p.screenFingerprint === 'string' ? p.screenFingerprint : undefined,
          screenName: typeof p.screenName === 'string' ? p.screenName : undefined,
          context: typeof p.context === 'string' ? (p.context as any) : undefined,
          hint: typeof p.hint === 'string' ? p.hint : undefined,
          runReportPath: typeof p.runReportPath === 'string' ? p.runReportPath : undefined,
        });
        return ok({ saved: 'pitfall', occurrences: saved.occurrences });
      }
      case 'inventory': {
        const p = params.payload as Record<string, unknown>;
        const required = ['flowId', 'goal', 'testClassName', 'filePath', 'projectPath'];
        for (const k of required) if (!p[k]) return errorResponse(`inventory payload missing "${k}"`);
        const saved = upsertInventoryEntry(appId, {
          flowId: String(p.flowId),
          goal: String(p.goal),
          testClassName: String(p.testClassName),
          testMethodName: typeof p.testMethodName === 'string' ? p.testMethodName : undefined,
          packageName: typeof p.packageName === 'string' ? p.packageName : undefined,
          filePath: String(p.filePath),
          projectPath: String(p.projectPath),
          generatedAt: new Date().toISOString(),
          lastVerifiedAt: typeof p.lastVerifiedAt === 'string' ? p.lastVerifiedAt : undefined,
          compileStatus: (p.compileStatus as any) ?? 'skipped',
        });
        return ok({ saved: 'inventory', flowId: saved.flowId });
      }
    }
  } catch (e) {
    logger.error('world_remember failed', { error: String(e) });
    return errorResponse(String(e));
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function errorResponse(message: string): McpToolResponse {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: true, message }) }] };
}

function ok(payload: Record<string, unknown>): McpToolResponse {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

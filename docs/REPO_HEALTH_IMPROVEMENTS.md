# Repo Health Improvements

**Evaluated:** 2026-07-06 | **Evaluator version:** 3.18.1 | **Overall score:** 46/100 🔴 Poor

This document tracks the gaps identified in the repo evaluation and the fixes planned for the future.
Items are ordered by impact-to-effort ratio.

---

## Score Summary

| Dimension | Score | Rating |
|-----------|-------|--------|
| 🤖 Agent Readiness | 59/100 | 🔴 Poor |
| 📊 Code Quality | 60/100 | 🟠 Fair (capped) |
| 🔒 Security | 51/100 | 🔴 Poor |
| 🧪 Test Coverage | 0/100 | ⚫ Critical |
| 🚀 Production Readiness | 40/100 | 🔴 Poor (capped) |
| ⚠️ Risk Score | 79 | High |

---

## Quick Wins (< 2h each, score +15–20 overall)

### 1. Add ESLint + Prettier
**Impact:** Removes the Code Quality hard cap (60 → ~67), adds linting gate to PRs.
```bash
npm install --save-dev eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser prettier eslint-config-prettier
```
- Add `eslint.config.mjs` and `.prettierrc`
- Add `"lint": "eslint src/"` and `"format": "prettier --write src/"` to `package.json`

### 2. Add a GitHub Actions CI workflow
**Impact:** Removes the Production Readiness hard cap (40 → ~52), gives a safety net on PRs.
- Create `.github/workflows/ci.yml` — lint + type-check on every PR
- No test run needed yet (see § Test Coverage below)

### 3. `npm audit fix`
**Impact:** Security dependency score 4/15 → ~11/15 (+7 points in Security dimension).
```bash
npm audit fix
```
Targets with available fixes: `@xmldom/xmldom`, `@hono/node-server`, `ws` bump via `webdriverio`.

### 4. Add README.md
**Impact:** Agent Readiness Docs sub-check 7/15 → ~12/15. Also helps new contributors.
- Setup instructions, environment variables list, tool inventory, how to connect to the Flutter app.

### 5. Gitignore `dist-recorder/`
**Impact:** Removes 33k LOC of committed build artifacts, eliminates two false god-file hits.
```bash
echo "/dist-recorder/" >> .gitignore
git rm -r --cached dist-recorder/
```

---

## Medium Effort (days, score +5–8 overall)

### 6. Add unit tests for core logic
**Impact:** Test Coverage 0/100 → ~25–40/100 (largest single dimension gap, 15% weight).
Highest-value targets for first tests:
- `src/tools/locator.ts` — locator ranking/scoring logic (pure functions, easy to unit test)
- `src/vm/widget-tree-parser.ts` — Dart VM XML parsing
- `src/tools/full-pipeline.ts` — phase orchestration state machine

### 7. Reduce `any` usage below 50
**Impact:** Agent Readiness Type Coverage 14/20 → 17/20 (+3). Currently 81 occurrences.
Run `npx tsc --noEmit` and work through the `any` hotspots in `src/tools/act.ts` and
`src/recording/test-generator.ts`.

### 8. Migrate `console.log` to Winston logger
**Impact:** Code Quality Logging 12/20 → 16/20. Currently 34 `console.*` calls in production code.
The Winston logger (`src/util/logger.ts`) already exists — just needs adoption.

---

## Larger Refactors (weeks, score +3–5 overall)

### 9. Split large source files
**Impact:** Agent Readiness Function Size 10/15 → 13/15.
- `src/tools/act.ts` (1,719 LOC) — split by action category
- `src/recording/test-generator.ts` (1,582 LOC) — split by generation phase

### 10. Add `.claude/rules/` and `AGENTS.md`
**Impact:** Agent Readiness Context Files 13/20 → 17/20. Strengthens the discipline axis (Axis B).
- Rules for `src/tools/`, `src/vm/`, `src/recording/` with path-scoped conventions
- `AGENTS.md` with sub-agent contracts

---

## Security Items (ongoing)

### Semgrep findings in production code
4 findings flagged — all intentional but worth reviewing for sandboxing:

| File | Line | Rule | Notes |
|------|------|------|-------|
| `src/tools/debug-loop.ts` | 93 | `child_process` | Spawns `mvn`/`appium` — validate args |
| `src/tools/full-pipeline.ts` | 125 | `child_process` | Pipeline executor — validate args |
| `src/util/process.ts` | 27 | `child_process` | Shared spawn util — central validation here covers all callers |
| `src/recording/test-generator.ts` | 856 | Raw HTML string | Consider `DOMParser` or template sanitisation |

Mitigation: add an allowlist-based argument validator in `src/util/process.ts` that all `child_process`
calls go through. This converts the "unsandboxed" finding to a documented, controlled surface.

### jszip license
`jszip@3.10.1` is dual-licensed `MIT OR GPL-3.0-or-later`. Elect MIT explicitly in your license
notice to avoid any copyleft question.

---

## Expected Score After All Fixes

| Phase | Fixes | Expected Overall |
|-------|-------|-----------------|
| Now (baseline) | — | 46 |
| Quick wins (1–5) | ESLint + CI + audit fix + README + gitignore | ~63 |
| Medium (6–8) | Tests + any reduction + logging | ~72 |
| Full (9–10) | File splits + rules/AGENTS | ~76 |

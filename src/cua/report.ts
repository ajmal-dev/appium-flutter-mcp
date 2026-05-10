import { mkdirSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import type { CuaRunState, CuaCaseRecord } from './run-state.js';

export interface CuaRunReport {
  startedAt: string;
  finishedAt: string;
  reportDir: string;
  testFile: string;
  module?: string;
  cases: CuaCaseRecord[];
  totals: { total: number; passed: number; failed: number; pending: number };
}

export function ensureRunDir(baseDir: string, runId: string): { runDir: string; shotsDir: string } {
  const runDir = join(baseDir, runId);
  const shotsDir = join(runDir, 'screenshots');
  mkdirSync(shotsDir, { recursive: true });
  return { runDir, shotsDir };
}

export function makeScreenshotSaver(shotsDir: string): (caseId: string, index: number, base64: string, mime: string) => string {
  return (caseId, index, base64, mime) => {
    const ext = mime === 'image/jpeg' ? 'jpg' : 'png';
    const safeId = caseId.replace(/[^A-Za-z0-9_-]/g, '_');
    const fileName = `${safeId}_${String(index).padStart(3, '0')}.${ext}`;
    const fullPath = join(shotsDir, fileName);
    writeFileSync(fullPath, Buffer.from(base64, 'base64'));
    return fileName;
  };
}

export function writeReport(state: CuaRunState): { reportPath: string; htmlPath: string; report: CuaRunReport } {
  const totals = {
    total: state.cases.length,
    passed: state.cases.filter(c => c.verdict === 'pass').length,
    failed: state.cases.filter(c => c.verdict === 'fail').length,
    pending: state.cases.filter(c => !c.verdict).length,
  };

  const report: CuaRunReport = {
    startedAt: state.startedAt,
    finishedAt: new Date().toISOString(),
    reportDir: state.runDir,
    testFile: state.testFilePath,
    module: state.testFile.module,
    cases: state.cases,
    totals,
  };

  const reportPath = join(state.runDir, 'report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  const htmlPath = join(state.runDir, 'index.html');
  writeFileSync(htmlPath, renderHtml(report, state.shotsDir, state.runDir));

  return { reportPath, htmlPath, report };
}

function renderHtml(report: CuaRunReport, shotsDir: string, runDir: string): string {
  const shotsRel = relative(runDir, shotsDir).replace(/\\/g, '/') || 'screenshots';
  const verdictBadge = (v: string | undefined) => {
    const label = (v || 'pending').toUpperCase();
    const color = v === 'pass' ? '#1b8e3a' : v === 'fail' ? '#c1342f' : '#7a5b00';
    return `<span style="background:${color};color:#fff;padding:2px 8px;border-radius:4px;font-weight:600;font-size:12px">${label}</span>`;
  };

  const caseSections = report.cases.map(c => {
    const stepRows = c.steps.map(s => {
      const shot = s.screenshotFile
        ? `<a href="${shotsRel}/${s.screenshotFile}" target="_blank"><img src="${shotsRel}/${s.screenshotFile}" style="max-width:120px;max-height:200px;border:1px solid #ccc;border-radius:4px"/></a>`
        : '';
      let changeBadge = '';
      if (s.screenChanged === true) {
        const tip = s.screenDelta ? ` title="${escapeHtml(s.screenDelta)}"` : '';
        changeBadge = `<span${tip} style="background:#e6f4ea;color:#1b8e3a;padding:1px 6px;border-radius:3px;font-size:11px;font-weight:600">SCREEN Δ</span>`;
      } else if (s.screenChanged === false) {
        changeBadge = `<span title="Screen did NOT change between this step's report and the previous one." style="background:#fef0e6;color:#a04a00;padding:1px 6px;border-radius:3px;font-size:11px;font-weight:600">NO Δ</span>`;
      }
      return `
      <tr>
        <td style="text-align:right;padding-right:8px;color:#666">${s.stepNumber}</td>
        <td>${escapeHtml(s.text)}</td>
        <td>${verdictBadge(s.status)} ${changeBadge}</td>
        <td style="color:#444">${escapeHtml(s.observation || '')}</td>
        <td>${shot}</td>
      </tr>`;
    }).join('');

    const duration = (c.startedAt && c.finishedAt)
      ? ((new Date(c.finishedAt).getTime() - new Date(c.startedAt).getTime()) / 1000).toFixed(1) + 's'
      : '—';

    return `
    <section style="margin:24px 0;padding:16px;border:1px solid #ddd;border-radius:8px">
      <h2 style="margin-top:0">${escapeHtml(c.id)} — ${escapeHtml(c.title)} ${verdictBadge(c.verdict)}</h2>
      <p style="color:#444">${escapeHtml(c.summary || '')}</p>
      <p style="color:#666;font-size:13px">Duration: ${duration}</p>
      ${c.goal ? `<p><strong>Goal:</strong> ${escapeHtml(c.goal)}</p>` : ''}
      ${c.expected ? `<p><strong>Expected:</strong> ${escapeHtml(c.expected)}</p>` : ''}

      <h3>Steps</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead><tr style="background:#f5f5f5"><th style="text-align:right;padding:6px">#</th><th style="text-align:left">Step</th><th>Status</th><th style="text-align:left">Observation</th><th>Screen</th></tr></thead>
        <tbody>${stepRows}</tbody>
      </table>
    </section>`;
  }).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>CUA run — ${escapeHtml(report.module || 'unknown')}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 24px; color: #222; }
  h1 { margin-top: 0; }
  table th, table td { border: 1px solid #eee; padding: 6px 8px; vertical-align: top; }
  code { background: #f5f5f5; padding: 1px 4px; border-radius: 3px; }
</style></head>
<body>
  <h1>CUA test run</h1>
  <p>
    <strong>Module:</strong> ${escapeHtml(report.module || '—')} ·
    <strong>File:</strong> <code>${escapeHtml(report.testFile)}</code><br/>
    <strong>Started:</strong> ${escapeHtml(report.startedAt)} ·
    <strong>Finished:</strong> ${escapeHtml(report.finishedAt)}
  </p>
  <p>
    <strong>Total:</strong> ${report.totals.total} ·
    <strong style="color:#1b8e3a">Passed:</strong> ${report.totals.passed} ·
    <strong style="color:#c1342f">Failed:</strong> ${report.totals.failed} ·
    <strong style="color:#7a5b00">Pending:</strong> ${report.totals.pending}
  </p>
  ${caseSections}
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]!));
}

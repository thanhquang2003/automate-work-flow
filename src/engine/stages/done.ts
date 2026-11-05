import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { StageContext, StageOutcome } from '../pipeline.js';
import { ulnlFileName } from './breakdown.js';
import {
  assumptionsPath, integrationBranch, prepareIntegration, projectGitLab, readFlowState, readProjectInfo, sortedTestCases,
  pushIfRemote, testCaseXlsxName, updateFlowState, type AssumptionEntry,
} from './common.js';
import { latestRun } from './test.js';

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/**
 * Writes artifacts/report.md (Vietnamese): P/F/PE counts, per-TC table, bugs, links to the documents,
 * final MR URL (from flow state) and the open assumptions. Returns the path.
 */
export async function writeReport(ctx: StageContext): Promise<string> {
  const { ws, req, repo } = ctx;
  const state = readFlowState(ws);
  const info = readProjectInfo(ws);
  const tcs = sortedTestCases(repo, req.id);
  const status = (id: string): string => latestRun(state, id)?.status ?? '';
  const count = (s: string): number => tcs.filter(tc => status(tc.id) === s).length;
  const untested = tcs.filter(tc => !status(tc.id)).length;
  const art = (name: string): string => (existsSync(join(ws.artifactsDir, name)) ? `[${name}](${name})` : `${name} (chưa có)`);
  const docRel = (p: string): string => relative(ws.root, p).replace(/\\/g, '/');
  const assumptions: AssumptionEntry[] = existsSync(assumptionsPath(ws)) ? JSON.parse(readFileSync(assumptionsPath(ws), 'utf8')) : [];
  const bugs = repo.listBugs(req.id);
  const tasks = repo.listTasks(req.id);

  const lines = [
    `# Báo cáo tổng kết ${req.id} — ${req.title}`,
    '',
    `- Nhánh tích hợp: \`${integrationBranch(req.id)}\``,
    `- Merge request cuối: ${state.finalMrUrl ?? (info?.gitlab ? '(chưa mở được)' : 'không có GitLab — code chỉ nằm trên nhánh cục bộ trong workspace, cần đẩy lên GitLab thủ công')}`,
    `- Số task: ${tasks.length} (hoàn thành ${tasks.filter(t => t.status === 'done').length})`,
    '',
    '## Kết quả kiểm thử',
    '',
    '| Trạng thái | Số lượng |',
    '|---|---|',
    `| P | ${count('P')} |`,
    `| F | ${count('F')} |`,
    `| PE | ${count('PE')} |`,
    ...(untested ? [`| Chưa kiểm thử | ${untested} |`] : []),
    `| Tổng | ${tcs.length} |`,
    '',
    '| Mã TC | Mục đích | Lần 1 | Lần 2 | Số lần chạy | Ghi chú |',
    '|---|---|---|---|---|---|',
    ...tcs.map(tc => `| ${tc.id} | ${cell(tc.purpose)} | ${tc.status1 ?? ''} | ${tc.status2 ?? ''} | ${state.runs[tc.id]?.length ?? 0} | ${cell(tc.comment ?? '')} |`),
    '',
    '## Bug',
    '',
    ...(bugs.length
      ? ['| Mã TC | Số lần sửa | Trạng thái | Issue |', '|---|---|---|---|', ...bugs.map(b => `| ${b.tcId} | ${b.fixAttempts} | ${b.status} | ${state.issueUrls[b.tcId] ?? (b.gitlabIid ? `#${b.gitlabIid}` : '—')} |`)]
      : ['Không có bug.']),
    '',
    '## Tài liệu',
    '',
    `- Test case: ${art(testCaseXlsxName(req.id))} (evidence trong thư mục \`evidence/\`)`,
    `- TKCT: ${art(`TKCT_${req.id}.docx`)}`,
    `- TKDB: ${art(`TKDB_${req.id}.docx`)}`,
    `- ULNL: ${art(ulnlFileName(req.id))}`,
    `- Phân tích, thiết kế, kế hoạch (markdown/JSON trên nhánh): \`${docRel(ws.devflowDir)}/\``,
    '',
    '## Câu hỏi mở và giả định',
    '',
    ...(assumptions.length
      ? assumptions.map(a => `- ${a.id} (${a.priority}): ${a.question} → **Giả định:** ${a.assumption}`)
      : ['Không có giả định nào còn mở.']),
    '',
  ];
  const out = join(ws.artifactsDir, 'report.md');
  mkdirSync(ws.artifactsDir, { recursive: true });
  writeFileSync(out, lines.join('\n'), 'utf8');
  return out;
}

/**
 * DONE: pushes devflow/<REQ> and opens (never merges) the final MR into the default branch when on GitLab;
 * locally only a note. Then writes the report. The engine marks the request done on `next`.
 */
export async function done(ctx: StageContext): Promise<StageOutcome> {
  const { req, ws } = ctx;
  // Defensive: DONE is only reached from TEST with every TC P/PE; never report done with open failures.
  const state = readFlowState(ws);
  const failing = sortedTestCases(ctx.repo, req.id).filter(tc => latestRun(state, tc.id)?.status === 'F' || (!state.runs[tc.id] && (tc.status2 ?? tc.status1) === 'F')).map(tc => tc.id);
  const openBugs = ctx.repo.listBugs(req.id).filter(b => b.status === 'open' || b.status === 'fixing' || b.status === 'fixed').map(b => b.tcId);
  if (failing.length || openBugs.length) {
    return { kind: 'fail', error: `Chưa thể hoàn tất: còn test case F (${failing.join(', ') || 'không'}) hoặc bug chưa đóng (${openBugs.join(', ') || 'không'}). Hãy chạy lại giai đoạn TEST.` };
  }
  const gl = projectGitLab(ctx);
  if (existsSync(join(ws.repoDir, '.git'))) await prepareIntegration(ctx);
  if (gl) {
    const branch = integrationBranch(req.id);
    await pushIfRemote(ctx, branch);
    const found = await gl.client.findOpenMR(gl.pid, branch, gl.defaultBranch);
    const mr = found ?? (await gl.client.createMR(gl.pid, {
      source: branch, target: gl.defaultBranch, title: `[${req.id}] ${req.title}`,
      description: `DevFlow: ${req.id} đã hoàn tất phát triển và kiểm thử. Báo cáo: artifacts/report.md trong workspace.\n\n**Không merge tự động** — cần người duyệt và merge.`,
    }));
    updateFlowState(ws, s => { s.finalMrUrl = mr.web_url; });
    ctx.log(`${found ? 'MR cuối đã mở' : 'Đã mở MR cuối'}: ${mr.web_url} (không merge)`);
  } else {
    ctx.log('Không có GitLab: bỏ qua MR cuối. Code nằm trên nhánh cục bộ devflow/' + req.id + ' trong workspace.', 'warn');
  }
  const report = await writeReport(ctx);
  ctx.log(`Đã ghi báo cáo ${report}`);
  return { kind: 'next' };
}

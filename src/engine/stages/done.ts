import { existsSync } from 'node:fs';
import { safeReadText, safeWriteFile } from '../safe-fs.js';
import { basename, join, relative } from 'node:path';
import type { StageContext, StageOutcome } from '../pipeline.js';
import {
  artifactName, assumptionsPath, integrationBranch, latestArtifact, prepareIntegration, projectGitLab, readFlowState, readProjectInfo,
  sortedTestCases, pushIfRemote, updateFlowState, type ArtifactKind, type AssumptionEntry,
} from './common.js';
import { hasCurrentResult, latestRun } from './test.js';

const CR_KIND_LABEL: Record<string, string> = { add: 'Thêm mới', modify: 'Sửa đổi', remove: 'Bỏ chức năng', nfr: 'Phi chức năng', other: 'Khác' };

/** One line per CR delivered in this iteration (ctx.changes: accepted, applied by the engine once DONE succeeds). */
function iterationChanges(ctx: StageContext): string[] {
  return ctx.changes.map(({ cr, impact }) =>
    `- ${cr.id} — ${cr.title} (${CR_KIND_LABEL[cr.kind] ?? cr.kind}, v${cr.baselineFrom ?? '?'} → v${cr.baselineTo ?? '?'}): ${impact.summary}`);
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/**
 * Writes artifacts/report.md (Vietnamese): P/F/PE counts, per-TC table, bugs, links to the documents,
 * final MR URL (from flow state) and the open assumptions. Returns the path.
 */
export async function writeReport(ctx: StageContext): Promise<string> {
  const { ws, req, repo } = ctx;
  const state = readFlowState(ws);
  const info = readProjectInfo(ws);
  const allTcs = sortedTestCases(repo, req.id);
  // Cancelled test cases stay listed but are excluded from the P/F/PE counts.
  const tcs = allTcs.filter(tc => tc.scopeStatus === 'active');
  const cancelledTcs = allTcs.length - tcs.length;
  const status = (id: string): string => latestRun(state, id)?.status ?? '';
  const count = (s: string): number => tcs.filter(tc => status(tc.id) === s).length;
  const untested = tcs.filter(tc => !status(tc.id)).length;
  const art = (kind: ArtifactKind): string => {
    const p = latestArtifact(ws, kind, ws.key);
    const name = p ? basename(p) : artifactName(kind, ctx.ws.key, ctx.baseline);
    return p ? `[${name}](${name})` : `${name} (chưa có)`;
  };
  const tcNote = (tc: (typeof allTcs)[number]): string =>
    tc.scopeStatus === 'cancelled' ? [`Hủy theo ${tc.changedByCr ?? '?'}`, tc.comment ?? ''].filter(Boolean).join(' — ') : (tc.comment ?? '');
  const docRel = (p: string): string => relative(ws.root, p).replace(/\\/g, '/');
  const assumptions: AssumptionEntry[] = existsSync(assumptionsPath(ws)) ? JSON.parse(safeReadText(assumptionsPath(ws))) : [];
  const bugs = repo.listBugs(req.id);
  const tasks = repo.listTasks(req.id).filter(t => t.scopeStatus === 'active');
  const changes = iterationChanges(ctx);

  const lines = [
    `# Báo cáo tổng kết ${req.id} — ${req.title}`,
    '',
    `- Nhánh tích hợp: \`${integrationBranch(ctx.ws.key)}\``,
    `- Merge request cuối: ${state.finalMrUrl ?? (info?.gitlab ? '(chưa mở được)' : 'không có GitLab — code chỉ nằm trên nhánh cục bộ trong workspace, cần đẩy lên GitLab thủ công')}`,
    `- Số task: ${tasks.length} (hoàn thành ${tasks.filter(t => t.status === 'done').length})`,
    ...(ctx.baseline > 1 ? [`- Phiên bản yêu cầu: v${ctx.baseline} · Vòng lặp ${req.iteration}`] : []),
    '',
    ...(changes.length ? ['## Các thay đổi trong vòng này', '', ...changes, ''] : []),
    '## Kết quả kiểm thử',
    '',
    '| Trạng thái | Số lượng |',
    '|---|---|',
    `| P | ${count('P')} |`,
    `| F | ${count('F')} |`,
    `| PE | ${count('PE')} |`,
    ...(untested ? [`| Chưa kiểm thử | ${untested} |`] : []),
    `| Tổng | ${tcs.length} |`,
    ...(cancelledTcs ? [`| Đã hủy (không tính) | ${cancelledTcs} |`] : []),
    '',
    '| Mã TC | Mục đích | Lần 1 | Lần 2 | Số lần chạy | Ghi chú |',
    '|---|---|---|---|---|---|',
    ...allTcs.map(tc => {
      const off = tc.scopeStatus === 'cancelled';
      return `| ${tc.id} | ${cell(tc.purpose)} | ${off ? '' : (tc.status1 ?? '')} | ${off ? '' : (tc.status2 ?? '')} | ${state.runs[tc.id]?.length ?? 0} | ${cell(tcNote(tc))} |`;
    }),
    '',
    '## Bug',
    '',
    ...(bugs.length
      ? ['| Mã TC | Số lần sửa | Trạng thái | Issue |', '|---|---|---|---|', ...bugs.map(b => `| ${b.tcId} | ${b.fixAttempts} | ${b.status} | ${state.issueUrls[b.tcId] ?? (b.gitlabIid ? `#${b.gitlabIid}` : '—')} |`)]
      : ['Không có bug.']),
    '',
    '## Tài liệu',
    '',
    `- Test case: ${art('TestCase')} (evidence trong thư mục \`evidence/\`)`,
    `- TKCT: ${art('TKCT')}`,
    `- TKDB: ${art('TKDB')}`,
    `- ULNL: ${art('ULNL')}`,
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
  safeWriteFile(out, lines.join('\n'));
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
  const active = sortedTestCases(ctx.repo, req.id).filter(tc => tc.scopeStatus === 'active');
  const activeIds = new Set(active.map(tc => tc.id));
  const failing = active.filter(tc => latestRun(state, tc.id)?.status === 'F' || (!state.runs[tc.id] && (tc.status2 ?? tc.status1) === 'F')).map(tc => tc.id);
  const openBugs = ctx.repo.listBugs(req.id).filter(b => activeIds.has(b.tcId) && (b.status === 'open' || b.status === 'fixing' || b.status === 'fixed')).map(b => b.tcId);
  // After a change request every active TC needs a result at the current baseline (v1: at least one run).
  const missing = active.filter(tc => !failing.includes(tc.id) && !hasCurrentResult(tc, latestRun(state, tc.id), ctx.baseline)
    && !(ctx.baseline === 1 && !state.runs[tc.id] && (tc.status2 ?? tc.status1))).map(tc => tc.id);
  if (failing.length || openBugs.length || missing.length) {
    return {
      kind: 'fail',
      error: `Chưa thể hoàn tất: còn test case F (${failing.join(', ') || 'không'}), bug chưa đóng (${openBugs.join(', ') || 'không'}) hoặc test case chưa có kết quả ở phiên bản v${ctx.baseline} (${missing.join(', ') || 'không'}). Hãy chạy lại giai đoạn TEST.`,
    };
  }
  const gl = projectGitLab(ctx);
  if (existsSync(join(ws.repoDir, '.git'))) await prepareIntegration(ctx);
  if (gl) {
    const branch = integrationBranch(ctx.ws.key);
    await pushIfRemote(ctx, branch);
    const found = await gl.client.findOpenMR(gl.pid, branch, gl.defaultBranch);
    // A new iteration (accepted CRs) on a still-open final MR: summarise it there instead of opening another MR.
    if (found && ctx.changes.length && readFlowState(ws).finalMrNotedBaseline !== ctx.baseline) {
      await gl.client.addMRNote(gl.pid, found.iid, [
        `**DevFlow: ${req.id} — phiên bản yêu cầu v${ctx.baseline}, vòng lặp ${req.iteration}** đã hoàn tất phát triển và kiểm thử lại.`,
        '',
        'Các thay đổi trong vòng này:',
        '',
        ...iterationChanges(ctx),
        '',
        'Báo cáo: artifacts/report.md trong workspace. **Không merge tự động** — cần người duyệt và merge.',
      ].join('\n'));
      updateFlowState(ws, s => { s.finalMrNotedBaseline = ctx.baseline; });
      ctx.log(`Đã cập nhật MR cuối ${found.web_url} với tóm tắt vòng này`);
    }
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

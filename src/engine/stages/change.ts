import { safeMkdirp, safeWriteFile } from '../safe-fs.js';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CR_REENTER_STAGES, ImpactOut, STAGE_LABELS, type ChangeRequestRow, type CrKind, type ImpactOutT, type Question, type RequestStatus, type Stage,
} from '../../domain/types.js';
import { templatePath } from '../../office/templates.js';
import { readUlnlCatalog } from '../../office/ulnl-catalog.js';
import { buildPrompt, type PromptOutput } from '../prompt.js';
import type { StageContext, StageOutcome } from '../pipeline.js';
import { typeTable } from './breakdown.js';
import { OutputError, readJsonOutput, readTextOutput, runClaudeStep } from './claude-json.js';
import {
  answeredQuestions, answersPath, assumptionsPath, changeDir, codebaseMapPath, designFile, ensureOnBranch, integrationBranch,
  latestArtifact, missingHeadings, promptExtras, pushIfRemote,
} from './common.js';
import { attachmentName, readAttachment, uniqueName } from './intake.js';

/** H2 sections of impact.md that the decision screen relies on (see prompts/change-analyst.md). */
const IMPACT_HEADINGS: [number, string][] = [
  [2, 'Tóm tắt'], [2, 'Phạm vi thay đổi'], [2, 'Ảnh hưởng'], [2, 'Nỗ lực dự kiến'], [2, 'Rủi ro'], [2, 'Câu hỏi cho khách hàng'],
];

const KIND_LABEL: Record<CrKind, string> = { add: 'Thêm chức năng', modify: 'Sửa chức năng', remove: 'Bỏ chức năng', nfr: 'Phi chức năng', other: 'Khác' };
const STATUS_NOTE: Partial<Record<RequestStatus, string>> = {
  running: 'đang chạy', awaiting_approval: 'đã xong, đang chờ duyệt', awaiting_customer: 'đang chờ khách hàng trả lời câu hỏi',
  paused: 'tạm dừng', needs_human: 'cần người xử lý', failed: 'lỗi', done: 'đã hoàn thành toàn bộ (đã bàn giao)',
};

const impactExample = (crId: string) => ({
  cr_id: crId,
  summary: 'Thêm đăng nhập bằng OTP qua SMS cho màn hình đăng nhập; cần sửa thiết kế và làm lại 1 task, chạy lại 2 test case.',
  scope: {
    add: [{ name: 'Cấu hình nhà cung cấp SMS', description: 'Màn hình quản trị khai báo tài khoản SMS gateway' }],
    modify: [{ feature_id: 'F-01', change: 'Thêm bước nhập mã OTP sau khi nhập mật khẩu' }],
    remove: [],
  },
  affected: { features: ['F-01'], tasks: ['T-01'], test_cases: ['TC-DANGNHAP-01', 'TC-DANGNHAP-02'] },
  questions: [{
    id: 'Q-07', category: 'Tích hợp', question: 'Công ty đang dùng nhà cung cấp SMS nào?', why: 'Quyết định cách tích hợp gửi OTP',
    type: 'single', options: ['Viettel', 'VNPT', 'Chưa có — cần đề xuất', 'Khác (ghi rõ)'], suggested_answer: 'Viettel', priority: 'must',
  }],
  effort_delta_mh: 12,
  risks: ['Phụ thuộc tài khoản SMS gateway của khách hàng; chậm cấp sẽ chậm kiểm thử'],
  reenter: 'DESIGN',
});

const qNum = (id: string): number | undefined => {
  const m = /^Q-(\d+)$/.exec(id);
  return m ? Number(m[1]) : undefined;
};
const crPrefix = (crId: string): string => `[${crId}] `;
const withPrefix = (crId: string, why: string): string => crPrefix(crId) + why.replace(/^\s*\[CR-\d+\]\s*/, '');

/** Stage (and status) the request was at when the CR batch interrupted it. */
function origin(crs: ChangeRequestRow[]): { stage: Stage; status: RequestStatus | null } | undefined {
  const c = crs.find(x => x.interruptedStage && x.status !== 'applied' && x.baselineFrom === null);
  return c ? { stage: c.interruptedStage!, status: c.interruptedStatus } : undefined;
}

/** Copies a CR's attachments into inputs/changes/<CR>/ (idempotent). Returns the copied paths. */
function copyCrAttachments(ctx: StageContext, crId: string): string[] {
  const atts = ctx.repo.listCrAttachments(ctx.req.id, crId);
  if (!atts.length) return [];
  const dir = join(ctx.ws.inputsDir, 'changes', crId);
  safeMkdirp(dir, ctx.ws.trustRoot);
  const used = new Set<string>();
  const out: string[] = [];
  for (const a of atts) {
    const name = uniqueName(attachmentName(a.filename), used);
    const dest = join(dir, name);
    if (resolve(a.path) !== resolve(dest)) {
      const data = readAttachment(ctx, a.path, `${a.filename} của ${crId}`);
      if (!data) continue;
      safeWriteFile(dest, data, ctx.ws.trustRoot);
    }
    out.push(dest);
  }
  return out;
}

function artifactsText(ctx: StageContext, crIds: Set<string>): string {
  const { ws } = ctx;
  const items: [string, string][] = [
    ['Bản phân tích yêu cầu', join(ws.devflowDir, 'analysis.md')],
    ['Câu trả lời của khách hàng', answersPath(ws)],
    ['Giả định đã chốt', assumptionsPath(ws)],
    ['Danh sách chức năng (BREAKDOWN)', join(ws.devflowDir, 'features.json')],
    ['Thiết kế chi tiết (TKCT)', designFile(ws, 'tkct.md')],
    ['Thiết kế cơ sở dữ liệu (TKDB)', designFile(ws, 'tkdb.md')],
    ['Danh sách task', join(ws.devflowDir, 'tasks.json')],
    ['Danh sách test case', join(ws.devflowDir, 'testcases.json')],
    ['Bản đồ mã nguồn', codebaseMapPath(ws)],
  ];
  const lines = items.map(([label, p]) => `- ${label}: ${existsSync(p) ? `\`${p}\`` : '(chưa có)'}`);
  const tcBook = latestArtifact(ws, 'TestCase', ws.key);
  lines.push(`- Kết quả kiểm thử (file test case mới nhất): ${tcBook ? `\`${tcBook}\`` : '(chưa có)'}`);
  const changes = join(ws.devflowDir, 'changes');
  const older = existsSync(changes) ? readdirSync(changes).filter(n => /^CR-\d+$/.test(n) && !crIds.has(n)).sort() : [];
  lines.push(`- Báo cáo tác động của các CR trước: ${older.length ? older.map(n => `\`${join(changes, n, 'impact.md')}\``).join(', ') : '(không có)'}`);
  lines.push('', 'Mã nguồn dự án nằm trong thư mục làm việc hiện tại — đọc khi cần đánh giá ảnh hưởng kỹ thuật.');
  return lines.join('\n');
}

function scopeText(ctx: StageContext): string {
  const { repo, req } = ctx;
  const status = (s: string, cr: string | null) => (s === 'cancelled' ? ` — ĐÃ HỦY${cr ? ` theo ${cr}` : ''}, không tham chiếu` : '');
  const fs = repo.listFeatures(req.id);
  const ts = repo.listTasks(req.id);
  const tcs = repo.listTestCases(req.id);
  const res = (a: string | null, b: string | null) => [a, b].filter(Boolean).join('/') || 'chưa chạy';
  return [
    '### Chức năng',
    ...(fs.length ? fs.map(f => `- ${f.id} — ${f.code} — ${f.name}${f.kind === 'nonfunction' ? ' (phi chức năng)' : ''}${status(f.scopeStatus, f.changedByCr)}`) : ['(chưa có)']),
    '',
    '### Task',
    ...(ts.length ? ts.map(t => `- ${t.id} (${t.featureId ?? '-'}) — ${t.title} — trạng thái: ${t.status}${status(t.scopeStatus, t.changedByCr)}`) : ['(chưa có)']),
    '',
    '### Test case',
    ...(tcs.length ? tcs.map(t => `- ${t.id} (${t.featureId ?? '-'}) — ${t.purpose} — kết quả: ${res(t.status1, t.status2)}${status(t.scopeStatus, t.changedByCr)}`) : ['(chưa có)']),
  ].join('\n');
}

function existingQuestionsText(ctx: StageContext): string {
  const qs = ctx.repo.listQuestions(ctx.req.id);
  if (!qs.length) return '(chưa có câu hỏi nào)';
  const answers = ctx.repo.latestAnswers(ctx.req.id);
  return qs.map(q => {
    const a = answers.get(q.id)?.trim();
    return `- ${q.id} (${q.priority}): ${q.question} → ${a ? `Đã trả lời: ${a}` : 'CHƯA TRẢ LỜI'}`;
  }).join('\n');
}

interface Refs { /** Any feature row exists (BREAKDOWN has run), cancelled ones included. */ hasFeatures: boolean; features: Set<string>; tasks: Set<string>; tcs: Set<string>; existingQ: Set<string>; answeredQ: Set<string>; maxQ: number }

function checkImpact(path: string, crId: string, i: ImpactOutT, refs: Refs, seenQ: Set<string>): string[] {
  const errs: string[] = [];
  if (i.cr_id !== crId) errs.push(`cr_id là "${i.cr_id}" nhưng file thuộc ${crId}`);
  if (!Number.isFinite(i.effort_delta_mh)) errs.push('effort_delta_mh phải là số');
  if (!refs.hasFeatures) {
    if (i.scope.modify.length || i.scope.remove.length || i.affected.features.length) {
      errs.push('yêu cầu chưa có danh sách chức năng (chưa qua BREAKDOWN): scope.modify, scope.remove và affected.features phải để trống');
    }
    if (i.reenter !== 'ANALYSIS') errs.push(`yêu cầu chưa có danh sách chức năng: reenter phải là "ANALYSIS" (đang là "${i.reenter}")`);
  } else {
    const bad = (ids: string[], what: string) => { for (const id of ids) if (!refs.features.has(id)) errs.push(`${what}: chức năng "${id}" không tồn tại hoặc đã hủy`); };
    bad(i.scope.modify.map(m => m.feature_id), 'scope.modify');
    bad(i.scope.remove, 'scope.remove');
    bad(i.affected.features, 'affected.features');
    for (const m of i.scope.modify) if (i.scope.remove.includes(m.feature_id)) errs.push(`chức năng "${m.feature_id}" không được vừa sửa (modify) vừa bỏ (remove)`);
    for (const id of new Set([...i.scope.modify.map(m => m.feature_id), ...i.scope.remove])) {
      if (!i.affected.features.includes(id)) errs.push(`chức năng "${id}" có trong scope.modify/scope.remove nên phải có trong affected.features`);
    }
  }
  for (const id of i.affected.tasks) if (!refs.tasks.has(id)) errs.push(`affected.tasks: task "${id}" không tồn tại hoặc đã hủy`);
  for (const id of i.affected.test_cases) if (!refs.tcs.has(id)) errs.push(`affected.test_cases: test case "${id}" không tồn tại hoặc đã hủy`);
  if (!(CR_REENTER_STAGES as readonly string[]).includes(i.reenter)) errs.push(`reenter "${i.reenter}" không hợp lệ`);
  else if ((i.scope.add.length || i.scope.remove.length) && i.reenter !== 'ANALYSIS' && i.reenter !== 'BREAKDOWN') {
    errs.push(`CR có thêm/bỏ chức năng (scope.add/scope.remove) nên reenter phải là "ANALYSIS" hoặc "BREAKDOWN" (đang là "${i.reenter}"), vì chỉ BREAKDOWN cập nhật danh sách chức năng và ULNL`);
  }
  for (const q of i.questions) {
    const n = qNum(q.id);
    if (n === undefined || !/^Q-\d{2,}$/.test(q.id)) errs.push(`câu hỏi ${q.id}: id phải có dạng Q-NN`);
    else if (refs.answeredQ.has(q.id)) errs.push(`câu hỏi ${q.id}: id đã thuộc về câu hỏi đã được trả lời — hãy dùng id mới từ Q-${String(refs.maxQ + 1).padStart(2, '0')}`);
    else if (refs.existingQ.has(q.id) || n <= refs.maxQ) errs.push(`câu hỏi ${q.id}: id đã tồn tại — câu hỏi mới phải đánh số từ Q-${String(refs.maxQ + 1).padStart(2, '0')}`);
    if (seenQ.has(q.id)) errs.push(`câu hỏi ${q.id}: id bị trùng (giữa các câu hỏi/CR của lần phân tích này)`);
    seenQ.add(q.id);
    if (!q.question.trim()) errs.push(`câu hỏi ${q.id}: thiếu nội dung câu hỏi`);
    if ((q.type === 'single' || q.type === 'multi') && q.options.length < 2) errs.push(`câu hỏi ${q.id}: câu hỏi ${q.type} cần ít nhất 2 lựa chọn trong options`);
  }
  return errs.map(e => `File ${path}: ${e}`);
}

export async function change(ctx: StageContext): Promise<StageOutcome> {
  const { ws, req, repo } = ctx;
  const all = repo.listChangeRequests(req.id);
  // 'analyzing' leftovers of an interrupted/failed run are taken again (the pipeline also resets them to pending).
  const crs = all.filter(c => c.status === 'pending' || c.status === 'analyzing');
  if (!crs.length) {
    ctx.log('Không có yêu cầu thay đổi nào đang chờ phân tích');
    return { kind: 'next' };
  }
  for (const c of crs) repo.updateChangeRequest(req.id, c.id, { status: 'analyzing' });
  const crIds = new Set(crs.map(c => c.id));
  ctx.log(`Phân tích tác động của ${crs.map(c => c.id).join(', ')}`);

  const hasGit = existsSync(join(ws.repoDir, '.git'));
  const branch = integrationBranch(ctx.ws.key);
  if (hasGit) {
    // A stage interrupted mid-edit (DEVELOP/BUGFIX) may leave a dirty task branch that would block the checkout:
    // stash it (never popped automatically — the CR may change what that work should be; the stash stays recoverable).
    const cur = await ctx.git.currentBranch().catch(() => '');
    if (cur !== branch) {
      const msg = `devflow:${req.id}:interrupted-by:${[...crIds].join(',')}:${cur || '?'}`;
      if (await ctx.git.stashAll(msg)) ctx.log(`Đã cất thay đổi dở dang vào git stash: ${msg}`, 'warn');
    }
    await ensureOnBranch(ctx, branch);
  }

  // Unanswered questions left by an earlier, unfinished analysis of these CRs are stale: drop them before numbering.
  const answeredIds = new Set(answeredQuestions(repo, req.id).map(a => a.id));
  const stale = repo.listQuestions(req.id).filter(q => !answeredIds.has(q.id) && [...crIds].some(id => q.why.startsWith(`[${id}]`))).map(q => q.id);
  if (stale.length) repo.deleteQuestions(req.id, stale);
  const questions = repo.listQuestions(req.id);
  const maxQ = questions.reduce((m, q) => Math.max(m, qNum(q.id) ?? 0), 0);

  const features = repo.listFeatures(req.id).filter(f => f.scopeStatus === 'active');
  const refs: Refs = {
    hasFeatures: repo.listFeatures(req.id).length > 0,
    features: new Set(features.map(f => f.id)),
    tasks: new Set(repo.listTasks(req.id).filter(t => t.scopeStatus === 'active').map(t => t.id)),
    tcs: new Set(repo.listTestCases(req.id).filter(t => t.scopeStatus === 'active').map(t => t.id)),
    existingQ: new Set(questions.map(q => q.id)),
    answeredQ: answeredIds,
    maxQ,
  };

  const files = crs.map(c => ({ cr: c, md: join(changeDir(ws, c.id), 'impact.md'), json: join(changeDir(ws, c.id), 'impact.json') }));
  for (const f of files) mkdirSync(changeDir(ws, f.cr.id), { recursive: true });
  const crBlocks = files.map(({ cr, md, json }) => {
    const atts = copyCrAttachments(ctx, cr.id);
    return [
      `### ${cr.id} — ${cr.title}`,
      '',
      `- Loại: ${KIND_LABEL[cr.kind] ?? cr.kind} (\`${cr.kind}\`)`,
      `- Nguồn: ${cr.source === 'customer' ? 'Khách hàng đề xuất' : 'Nhân viên'}`,
      `- File đính kèm (đọc hết): ${atts.length ? atts.map(p => `\`${p}\``).join(', ') : '(không có)'}`,
      `- Ghi kết quả vào: \`${md}\` và \`${json}\``,
      '',
      'Nội dung (nguyên văn):',
      '',
      cr.description.trim() || '(không ghi)',
    ].join('\n');
  });

  const o = origin(all);
  const currentStage = o
    ? `${STAGE_LABELS[o.stage]} (\`${o.stage}\`)${o.status && STATUS_NOTE[o.status] ? ` — ${STATUS_NOTE[o.status]}` : ''}`
    : '(không xác định)';
  const breakdownNote = refs.hasFeatures
    ? 'Yêu cầu đã có danh sách chức năng: dùng đúng ID chức năng/task/test case ở mục "Phạm vi hiện tại". Chọn `reenter` là giai đoạn sớm nhất có tài liệu/kết quả phải thay đổi; nếu giai đoạn đó muộn hơn giai đoạn yêu cầu đã tới, DevFlow sẽ tự giới hạn về giai đoạn yêu cầu đã tới.'
    : '**Lưu ý: yêu cầu CHƯA có danh sách chức năng (chưa qua bước BREAKDOWN).** Vì vậy `scope.modify`, `scope.remove`, `affected.features`, `affected.tasks`, `affected.test_cases` phải để trống (`[]`); mọi phạm vi mới hoặc khác đi mô tả trong `scope.add` và trong impact.md; `reenter` bắt buộc là `"ANALYSIS"`.';

  const cat = await readUlnlCatalog(templatePath(ctx.cfg, 'ulnl'));
  const outputs: PromptOutput[] = files.flatMap(({ cr, md, json }) => [
    { path: md, description: `Báo cáo tác động của ${cr.id} (markdown, tiếng Việt) theo đúng dàn ý ở trên.` },
    { path: json, description: `Tác động của ${cr.id} dạng máy đọc (cr_id = "${cr.id}").`, example: impactExample(cr.id) },
  ]);
  const prompt = buildPrompt('change-analyst', {
    current_stage: currentStage,
    baseline: String(ctx.baseline ?? req.baselineVersion),
    breakdown_note: breakdownNote,
    cr_list: crBlocks.join('\n\n'),
    artifacts: artifactsText(ctx, crIds),
    scope_state: scopeText(ctx),
    existing_questions: existingQuestionsText(ctx),
    next_question_no: String(maxQ + 1).padStart(2, '0'),
    type_catalog: typeTable(cat),
  }, { ...promptExtras(ctx, outputs), changes: undefined }); // earlier CRs are listed in the artifacts section instead

  const r = await runClaudeStep(ctx, {
    prompt,
    clean: files.flatMap(f => [f.md, f.json]),
    validate: async () => {
      // Report every problem of every CR at once so a single retry can fix them all.
      const errs: string[] = [];
      const seenQ = new Set<string>();
      const out: { cr: ChangeRequestRow; impact: ImpactOutT }[] = [];
      for (const f of files) {
        try {
          const md = await readTextOutput(f.md, 20);
          const missing = missingHeadings(md, IMPACT_HEADINGS);
          if (missing.length) errs.push(`File ${f.md} thiếu mục bắt buộc: ${missing.map(h => `"${h}"`).join(', ')}`);
        } catch (e) { errs.push((e as Error).message); }
        try {
          const impact = await readJsonOutput(f.json, ImpactOut);
          errs.push(...checkImpact(f.json, f.cr.id, impact, refs, seenQ));
          out.push({ cr: f.cr, impact });
        } catch (e) { errs.push((e as Error).message); }
      }
      if (errs.length) throw new OutputError(errs.join('\n'));
      return out;
    },
  });
  if (!r.ok) return { kind: 'fail', error: r.error };

  const newQs: Question[] = r.value.flatMap(({ cr, impact }) => impact.questions.map(q => ({ ...q, why: withPrefix(cr.id, q.why) })));
  if (newQs.length) repo.upsertQuestions(req.id, req.clarifyRound + 1, newQs);
  for (const { cr, impact } of r.value) {
    repo.updateChangeRequest(req.id, cr.id, { impactSummary: impact.summary, reenterStage: impact.reenter });
    ctx.log(`${cr.id}: ${impact.summary} — nỗ lực ${impact.effort_delta_mh >= 0 ? '+' : ''}${impact.effort_delta_mh} MH, quay lại ${impact.reenter}${impact.questions.length ? `, ${impact.questions.length} câu hỏi mới` : ''}`);
  }

  if (hasGit) {
    await ensureOnBranch(ctx, branch);
    const committed = await ctx.git.commitPaths([`${ctx.ws.docsRel}/changes`], `docs(devflow): ${req.id} phân tích tác động ${[...crIds].join(', ')}`);
    const pushed = committed && (await pushIfRemote(ctx, branch));
    ctx.log(committed ? `Đã commit báo cáo tác động lên nhánh ${branch}${pushed ? ' và push lên GitLab' : ''}` : 'Báo cáo tác động không thay đổi, không cần commit');
  }
  return { kind: 'next' };
}


import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearMockHandler } from '../../src/claude/mock.js';
import { clearStages, Workspace } from '../../src/engine/pipeline.js';
import type { Repo } from '../../src/db/repo.js';
import type { ImpactOutT, Question, Stage } from '../../src/domain/types.js';
import { setup, mkReq } from './helpers.js';
import { calls, git, initRepo, mockClaude, outputPaths, register, resetCalls, type Call } from './stage-helpers.js';

const IMPACT_MD = `# CR-01 — Đổi luồng đăng nhập

## Tóm tắt
Thêm đăng nhập bằng OTP.

## Phạm vi thay đổi
Sửa F-01.

## Ảnh hưởng
### Chức năng
- F-01
### Task
- T-01
### Test case
- TC-A-01

## Nỗ lực dự kiến
+8 MH

## Rủi ro
- Phụ thuộc nhà cung cấp SMS.

## Câu hỏi cho khách hàng
Không.
`;

const q = (id: string, priority: 'must' | 'should', extra: Partial<Question> = {}): Question => ({
  id, category: 'Chức năng', question: `Câu hỏi ${id}?`, why: 'vì cần', type: 'single', options: ['Có', 'Không'], suggested_answer: 'Có', priority, ...extra,
});

function impact(crId: string, over: Partial<ImpactOutT> = {}): ImpactOutT {
  return {
    cr_id: crId, summary: `Tóm tắt ${crId}`, scope: { add: [], modify: [{ feature_id: 'F-01', change: 'Thêm OTP' }], remove: [] },
    affected: { features: ['F-01'], tasks: ['T-01'], test_cases: ['TC-A-01'] }, questions: [], effort_delta_mh: 8, risks: ['SMS'],
    reenter: 'DESIGN', ...over,
  };
}

/** Mock change-analyst: writes impact.md/json for every CR output path in the prompt. */
const writeImpacts = (over: (crId: string, call: Call) => Partial<ImpactOutT> = () => ({})) => (_dir: string, call: Call) => {
  for (const p of outputPaths(call.prompt).filter(x => x.endsWith('impact.json'))) {
    const crId = /(CR-\d+)[\\/]impact\.json$/.exec(p)![1]!;
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(join(p, '..', 'impact.md'), IMPACT_MD.replace('CR-01', crId));
    writeFileSync(p, JSON.stringify(impact(crId, over(crId, call))));
  }
};

function seedScope(repo: Repo, reqId: string) {
  const f = (id: string) => ({ id, code: `C${id.slice(2)}`, name: `Chức năng ${id}`, description: '', typeCode: 'CN_WEB1', unitTest: false, note: '', kind: 'function' as const, scopeStatus: 'active' as const, changedByCr: null });
  repo.upsertFeatures(reqId, [f('F-01'), f('F-02')]);
  const t = (id: string, featureId: string) => ({ id, title: `Task ${id}`, featureId, dependsOn: [], status: 'done', reviewRounds: 1, branch: null, mrIid: null, scopeStatus: 'active' as const, changedByCr: null });
  repo.upsertTask(reqId, t('T-01', 'F-01')); repo.upsertTask(reqId, t('T-02', 'F-02'));
  const tc = (id: string, featureId: string) => ({
    id, featureId, purpose: `Kiểm tra ${id}`, data: '', steps: '', expected: '', status1: 'P' as const, status2: null, realResult: 'ok', evidence: [], comment: null,
    scopeStatus: 'active' as const, changedByCr: null, baseline: 1,
  });
  repo.upsertTestCase(reqId, tc('TC-A-01', 'F-01')); repo.upsertTestCase(reqId, tc('TC-B-01', 'F-02'));
}

/** Review-mode request parked at `stage` awaiting approval, with a git repo on its integration branch. */
function prepare(opts: { stage?: Stage; scope?: boolean } = {}) {
  register();
  const env = setup();
  const r = mkReq(env.repo, { runMode: 'review' });
  const ws = Workspace.for(env.cfg, r.id).ensure();
  initRepo(ws.repoDir, `devflow/${r.id}`);
  if (opts.scope !== false) seedScope(env.repo, r.id);
  env.repo.updateRequest(r.id, { stage: opts.stage ?? 'DEVELOP', status: 'awaiting_approval' });
  return { ...env, r, ws };
}

const cr = (title: string) => ({ title, description: `Mô tả ${title}`, kind: 'modify' as const });

beforeEach(() => { resetCalls(); });
afterEach(() => { clearMockHandler(); clearStages(); });

describe('CHANGE stage', () => {
  it('writes impact files and stores summary', async () => {
    const { repo, pipeline, worker, r, ws } = prepare();
    mockClaude({ 'change-analyst': writeImpacts() });
    pipeline.submitChange(r.id, cr('Đăng nhập OTP'));
    await worker.drain();
    expect(calls.map(c => c.role)).toEqual(['change-analyst']);
    const dir = join(ws.devflowDir, 'changes', 'CR-01');
    expect(existsSync(join(dir, 'impact.md'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'impact.json'), 'utf8')).cr_id).toBe('CR-01');
    expect(repo.getChangeRequest(r.id, 'CR-01')).toMatchObject({ status: 'awaiting_decision', impactSummary: 'Tóm tắt CR-01', reenterStage: 'DESIGN' });
    expect(repo.getRequest(r.id)).toMatchObject({ stage: 'CHANGE', status: 'awaiting_approval' });
    expect(git(ws.repoDir, 'log', '-1', '--name-only', '--format=%s')).toMatch(/docs\/devflow\/changes\/CR-01\/impact\.json/);
    expect(git(ws.repoDir, 'status', '--porcelain')).toBe('');
  });

  it('invalid feature reference retried then fails', async () => {
    const { repo, pipeline, worker, r } = prepare();
    mockClaude({ 'change-analyst': writeImpacts(() => ({ scope: { add: [], modify: [{ feature_id: 'F-99', change: 'x' }], remove: [] }, affected: { features: ['F-01'], tasks: ['T-77'], test_cases: [] } })) });
    pipeline.submitChange(r.id, cr('Sai tham chiếu'));
    await worker.drain();
    expect(calls).toHaveLength(3);
    expect(calls[1]!.prompt).toContain('F-99');
    expect(calls[1]!.prompt).toContain('T-77');
    expect(repo.getRequest(r.id)).toMatchObject({ stage: 'CHANGE', status: 'failed' });
    expect(repo.getChangeRequest(r.id, 'CR-01')!.status).toBe('pending');
  });

  it('without features: feature references rejected and reenter must be ANALYSIS', async () => {
    const { repo, pipeline, worker, r } = prepare({ stage: 'CLARIFY', scope: false });
    let n = 0;
    mockClaude({
      'change-analyst': writeImpacts(() => (n++ === 0
        ? { affected: { features: ['F-01'], tasks: [], test_cases: [] }, scope: { add: [], modify: [], remove: [] }, reenter: 'DESIGN' }
        : { affected: { features: [], tasks: [], test_cases: [] }, scope: { add: [{ name: 'OTP', description: 'x' }], modify: [], remove: [] }, reenter: 'ANALYSIS' })),
    });
    pipeline.submitChange(r.id, cr('Sớm'));
    await worker.drain();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.prompt).toMatch(/chưa có danh sách chức năng/i);
    expect(calls[1]!.prompt).toContain('ANALYSIS');
    expect(repo.getChangeRequest(r.id, 'CR-01')).toMatchObject({ status: 'awaiting_decision', reenterStage: 'ANALYSIS' });
  });

  it('new questions upserted with CR prefix', async () => {
    const { repo, pipeline, worker, r } = prepare();
    repo.upsertQuestions(r.id, 1, [q('Q-01', 'must'), q('Q-02', 'should')]);
    repo.saveAnswer(r.id, 'Q-01', 'Có', 'customer');
    repo.updateRequest(r.id, { clarifyRound: 1 });
    let n = 0;
    mockClaude({
      'change-analyst': writeImpacts(() => ({ questions: n++ === 0 ? [q('Q-01', 'must')] : [q('Q-03', 'must', { why: 'Cần biết nhà cung cấp SMS' })] })),
    });
    pipeline.submitChange(r.id, cr('OTP'));
    await worker.drain();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.prompt).toContain('Q-03');
    expect(calls[1]!.prompt).toMatch(/Q-01.*đã được trả lời/);
    const added = repo.listQuestions(r.id).find(x => x.id === 'Q-03')!;
    expect(added).toMatchObject({ round: 2, priority: 'must', why: '[CR-01] Cần biết nhà cung cấp SMS' });
    expect(repo.listQuestions(r.id).find(x => x.id === 'Q-01')!.why).toBe('vì cần');
  });

  it('attachments copied', async () => {
    const { repo, pipeline, worker, r, ws } = prepare();
    mockClaude({ 'change-analyst': writeImpacts() });
    const src = mkdtempSync(join(tmpdir(), 'devflow-cra-'));
    writeFileSync(join(src, 'otp-spec.txt'), 'đặc tả OTP');
    pipeline.submitChange(r.id, cr('OTP'));
    repo.addCrAttachment(r.id, 'CR-01', 'otp-spec.txt', join(src, 'otp-spec.txt'));
    await worker.drain();
    const dest = join(ws.inputsDir, 'changes', 'CR-01', 'otp-spec.txt');
    expect(readFileSync(dest, 'utf8')).toBe('đặc tả OTP');
    expect(calls[0]!.prompt).toContain(dest);
  });

  it('prompt contains current stage and all pending CRs', async () => {
    const { pipeline, worker, r, ws, repo } = prepare();
    mockClaude({ 'change-analyst': writeImpacts() });
    pipeline.submitChange(r.id, cr('Đăng nhập OTP'));
    pipeline.submitChange(r.id, cr('Xuất Excel báo cáo'));
    await worker.drain();
    expect(calls).toHaveLength(1);
    const p = calls[0]!.prompt;
    expect(p.split('\n')[0]).toBe('ROLE: change-analyst');
    expect(p).toContain('DEVELOP');
    expect(p).toContain('Phát triển');
    for (const t of ['CR-01', 'CR-02', 'Đăng nhập OTP', 'Xuất Excel báo cáo', 'Mô tả Xuất Excel báo cáo']) expect(p).toContain(t);
    for (const id of ['F-01', 'T-02', 'TC-B-01']) expect(p).toContain(id);
    expect(p).toContain('CN_WEB1'); // ULNL type table
    expect(outputPaths(p)).toEqual([
      join(ws.devflowDir, 'changes', 'CR-01', 'impact.md'), join(ws.devflowDir, 'changes', 'CR-01', 'impact.json'),
      join(ws.devflowDir, 'changes', 'CR-02', 'impact.md'), join(ws.devflowDir, 'changes', 'CR-02', 'impact.json'),
    ]);
    expect(repo.listChangeRequests(r.id).map(c => c.status)).toEqual(['awaiting_decision', 'awaiting_decision']);
  });

  it('impact.md missing required sections and cr_id mismatch are reported', async () => {
    const { pipeline, worker, r, repo } = prepare();
    let n = 0;
    mockClaude({
      'change-analyst': (dir, call) => {
        writeImpacts(() => (n === 0 ? { cr_id: 'CR-09' } : {}))(dir, call);
        if (n++ === 0) writeFileSync(join(dir, 'changes', 'CR-01', 'impact.md'), '# CR-01\n\n## Tóm tắt\nx\n');
      },
    });
    pipeline.submitChange(r.id, cr('OTP'));
    await worker.drain();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain('CR-09');
    expect(calls[1]!.prompt).toContain('Rủi ro');
    expect(repo.getChangeRequest(r.id, 'CR-01')!.status).toBe('awaiting_decision');
  });
});

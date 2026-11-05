import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { clearMockHandler } from '../../src/claude/mock.js';
import { clearStages, Pipeline, Workspace } from '../../src/engine/pipeline.js';
import { Worker } from '../../src/engine/worker.js';
import { buildPrompt } from '../../src/engine/prompt.js';
import { templatePath } from '../../src/office/templates.js';
import { readUlnlCatalog } from '../../src/office/ulnl-catalog.js';
import { Git } from '../../src/gitlab/git.js';
import type { GitLabClient } from '../../src/gitlab/client.js';
import type { Config } from '../../src/config.js';
import type { Question, Stage } from '../../src/domain/types.js';
import { safeFileName } from '../../src/engine/stages/intake.js';
import { setup, mkReq } from './helpers.js';
import { calls, git, initRepo, mockClaude, register, resetCalls, startAt } from './stage-helpers.js';

const q = (id: string, priority: 'must' | 'should', extra: Partial<Question> = {}): Question => ({
  id, category: 'Chức năng', question: `Câu hỏi ${id}?`, why: 'vì cần', type: 'single', options: ['Có', 'Không'], suggested_answer: 'Có', priority, ...extra,
});

const ANALYSIS_MD = '# Tổng quan yêu cầu\n\nNội dung phân tích.\n\n# Chỗ hổng đã phát hiện\n\nKhông.\n\n# Câu hỏi mở và giả định\n\nKhông.\n';

const writeAnalysis = (qs: Question[]) => (dir: string) => {
  writeFileSync(join(dir, 'analysis.md'), ANALYSIS_MD);
  writeFileSync(join(dir, 'questions.json'), JSON.stringify({ questions: qs }));
};

const FEATURES = {
  features: [
    { id: 'F-01', code: 'DANGNHAP', name: 'Đăng nhập', description: 'Đăng nhập hệ thống', type_code: 'CN_WEB1', unit_test: true, note: 'TKCT: Thiết kế chi tiết > DANGNHAP', kind: 'function' },
    { id: 'F-02', code: 'BAOCAO', name: 'Báo cáo', description: 'Báo cáo doanh thu', type_code: 'BC2', unit_test: false, note: '', kind: 'function' },
    { id: 'NF-01', code: 'PM', name: 'Quản lý dự án', description: 'PM', type_code: 'PM', unit_test: false, note: '', kind: 'nonfunction' },
  ],
};

const TKCT_MD = `# TỔNG QUAN
## Tổng quan dự án
Dự án mẫu.
## Yêu cầu chức năng
- DANGNHAP
## Yêu cầu phi chức năng
Không.
## Yêu cầu hiệu năng
100 người dùng đồng thời.
## Yêu cầu khác
Không.
# THIẾT KẾ TỔNG THỂ
## Mô hình tổng thể
Sơ đồ: Mô hình tổng thể
\`\`\`mermaid
graph TD; A-->B
\`\`\`
## Danh sách kết nối
| Nguồn | Đích |
|---|---|
| Web | API |
# THIẾT KẾ CHI TIẾT
## Thiết kế giao tiếp
REST.
## Cơ sở dữ liệu
Xem TKDB.
## DANGNHAP - Đăng nhập
### Tổng quan
Đăng nhập.
### Đối tượng sử dụng
Người dùng.
### Giao diện
Form.
### Luồng dữ liệu
A.
### Chi tiết
B.
## BAOCAO - Báo cáo
### Tổng quan
Báo cáo.
### Đối tượng sử dụng
Quản lý.
### Giao diện
Bảng.
### Luồng dữ liệu
A.
### Chi tiết
B.
# PHỤ LỤC
## Sơ đồ luồng dữ liệu nghiệp vụ
Không.
## Câu hỏi mở và giả định
- [GIẢ ĐỊNH] Không có.
`;

const TKDB_MD = `# GIỚI THIỆU
## Mục tiêu tài liệu
Mô tả CSDL.
## Định nghĩa thuật ngữ và các từ viết tắt
Không.
## Tài liệu tham khảo
TKCT.
## Mô tả chung
PostgreSQL.
# CƠ SỞ DỮ LIỆU
## Các mô hình quan hệ dữ liệu
Sơ đồ: ERD
### Danh sách bảng
| Bảng | Mô tả |
|---|---|
| USERS | Người dùng |
### Danh sách mã lỗi
Không.
## Bảng USERS
### Mô tả cột
| Cột | Kiểu |
|---|---|
| ID | BIGINT |
### Constraint
PK.
### Index
Không.
### Trigger
Không.
### Partitions
Không.
### Script thay đổi
\`\`\`sql
CREATE TABLE USERS(ID BIGINT PRIMARY KEY);
\`\`\`
## Script rollback
\`\`\`sql
DROP TABLE USERS;
\`\`\`
`;

const writeDesign = (dir: string) => {
  const d = join(dir, 'design');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'tech-stack.md'), '# Lựa chọn công nghệ\n\nNode.js\n');
  writeFileSync(join(d, 'tkct.md'), TKCT_MD);
  writeFileSync(join(d, 'tkdb.md'), TKDB_MD);
  writeFileSync(join(d, 'tong-the.mmd'), 'graph TD; A-->B\n');
};

beforeEach(() => { resetCalls(); });
afterEach(() => { clearMockHandler(); clearStages(); });

describe('buildPrompt', () => {
  it('substitutes vars, appends request context, feedback and required outputs', () => {
    const p = buildPrompt('analyst', { round: '1', max_rounds: '5', next_question_no: '1', existing_questions: '(chưa có)', codebase_map: '(không có)', answers_file: '(chưa có)', assumptions_file: '(chưa có)', devflow_dir: 'X' }, {
      request: { id: 'REQ-001', title: 'Quản lý kho', description: 'mô tả', perfReq: '100 user', nonfuncReq: 'bảo mật', softwareTypes: ['web'], projectKind: 'new' },
      inputs: ['C:/ws/inputs/a.pdf'],
      feedback: 'thiếu actor',
      outputs: [{ path: 'C:/ws/repo/docs/devflow/questions.json', description: 'câu hỏi', example: { questions: [] } }],
    });
    expect(p.split('\n')[0]).toBe('ROLE: analyst');
    expect(p).not.toMatch(/\{\{\w+\}\}/);
    expect(p).toContain('Quản lý kho');
    expect(p).toContain('100 user');
    expect(p).toContain('C:/ws/inputs/a.pdf');
    expect(p).toContain('thiếu actor');
    expect(p).toContain('Đầu ra bắt buộc');
    expect(p).toContain('C:/ws/repo/docs/devflow/questions.json');
    expect(p).toContain('Câu hỏi mở và giả định');
  });

  it('throws on a missing variable', () => {
    expect(() => buildPrompt('analyst', {})).toThrow(/round/);
  });
});

describe('templates and ULNL catalog', () => {
  it('falls back to bundled default templates and reads the type list', async () => {
    const cfg = { dataDir: mkdtempSync(join(tmpdir(), 'devflow-tpl-')) } as Config;
    const p = templatePath(cfg, 'ulnl');
    expect(p.replace(/\\/g, '/')).toMatch(/templates\/default\/ulnl\.xlsx$/);
    expect(templatePath(cfg, 'tkct')).toMatch(/tkct\.docx$/);
    mkdirSync(join(cfg.dataDir, 'templates'), { recursive: true });
    writeFileSync(join(cfg.dataDir, 'templates', 'tkdb.docx'), 'x');
    expect(templatePath(cfg, 'tkdb')).toBe(join(cfg.dataDir, 'templates', 'tkdb.docx'));
    const cat = await readUlnlCatalog(p);
    const web1 = cat.types.find(t => t.code === 'CN_WEB1');
    expect(web1?.name).toMatch(/Web functionality/);
    expect(web1?.explain).toMatch(/Less than 10 components/);
    expect(cat.nonFunctions.map(n => n.code)).toContain('PM');
  });
});

describe('stages part 1', () => {
  it('analysis saves questions round 1 and moves to CLARIFY', async () => {
    register();
    const { repo, pipeline, worker, cfg } = setup();
    const r = mkReq(repo, { projectKind: 'new' });
    mockClaude({ analyst: writeAnalysis([q('Q-01', 'must'), q('Q-02', 'should')]) });
    startAt(pipeline, r.id, 'ANALYSIS');
    await worker.drain();
    expect(calls.map(c => c.role)).toEqual(['analyst']);
    const prompt = calls[0]!.prompt;
    expect(prompt).toContain(r.title);
    expect(prompt).toContain('Đầu ra bắt buộc');
    expect(prompt).toContain(join(Workspace.for(cfg, r.id).devflowDir, 'questions.json'));
    const qs = repo.listQuestions(r.id);
    expect(qs.map(x => [x.id, x.round])).toEqual([['Q-01', 1], ['Q-02', 1]]);
    const req = repo.getRequest(r.id)!;
    expect(req.stage).toBe('CLARIFY');
    expect(req.status).toBe('awaiting_customer');
  });

  it('analysis with no must questions skips to BREAKDOWN', async () => {
    register(['BREAKDOWN']);
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo, { projectKind: 'new' });
    mockClaude({ analyst: writeAnalysis([q('Q-01', 'should')]) });
    startAt(pipeline, r.id, 'ANALYSIS');
    await worker.drain();
    const req = repo.getRequest(r.id)!;
    expect(req.stage).toBe('BREAKDOWN');
    expect(repo.listStageRuns(r.id).map(s => s.stage)).not.toContain('CLARIFY');
  });

  it('invalid questions.json retried then fails', async () => {
    register();
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo, { projectKind: 'new' });
    mockClaude({
      analyst: dir => {
        writeFileSync(join(dir, 'analysis.md'), '# A\n');
        writeFileSync(join(dir, 'questions.json'), JSON.stringify({ questions: [{ id: 'Q-01', question: 'x' }] }));
      },
    });
    startAt(pipeline, r.id, 'ANALYSIS');
    await worker.drain();
    expect(calls).toHaveLength(3);
    expect(calls[1]!.prompt).toMatch(/không hợp lệ/i);
    expect(calls[1]!.prompt).toContain('priority');
    const req = repo.getRequest(r.id)!;
    expect(req.status).toBe('failed');
    expect(repo.latestStageRun(r.id, 'ANALYSIS')!.error).toMatch(/questions\.json/);
  });

  it('clarify exports excel and awaits customer', async () => {
    register();
    const { repo, pipeline, worker, cfg } = setup({ mode: 'server', publicBaseUrl: 'https://df.example' });
    const r = mkReq(repo, { projectKind: 'new' });
    repo.upsertQuestions(r.id, 1, [q('Q-01', 'must'), q('Q-02', 'should')]);
    startAt(pipeline, r.id, 'CLARIFY');
    await worker.drain();
    const ws = Workspace.for(cfg, r.id);
    const file = join(ws.artifactsDir, 'questions', `Questions_${r.id}_round1.xlsx`);
    expect(existsSync(file)).toBe(true);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const texts: string[] = [];
    wb.worksheets[0]!.eachRow(row => texts.push(String(row.getCell(1).value ?? '')));
    expect(texts).toContain('Q-01');
    const links = repo.listSurveyLinks(r.id);
    expect(links).toHaveLength(1);
    expect(links[0]!.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(links[0]!.round).toBe(1);
    expect(Math.abs(links[0]!.expiresAt - (Date.now() + 14 * 86400000))).toBeLessThan(60000);
    expect(repo.listEvents(r.id).some(e => e.message.includes(`https://df.example/s/${links[0]!.token}`))).toBe(true);
    expect(repo.getRequest(r.id)!.status).toBe('awaiting_customer');
    expect(calls).toHaveLength(0);
  });

  it('clarify resume writes answers.json and goes back to ANALYSIS', async () => {
    register(['ANALYSIS']);
    const { repo, pipeline, worker, cfg } = setup();
    const r = mkReq(repo, { projectKind: 'new' });
    repo.upsertQuestions(r.id, 1, [q('Q-01', 'must'), q('Q-02', 'should')]);
    startAt(pipeline, r.id, 'CLARIFY');
    await worker.drain();
    repo.saveAnswer(r.id, 'Q-01', 'Có', 'excel');
    pipeline.resumeAfterCustomer(r.id);
    await worker.drain();
    const req = repo.getRequest(r.id)!;
    expect(req.clarifyRound).toBe(1);
    expect(req.stage).toBe('ANALYSIS');
    const answers = JSON.parse(readFileSync(join(Workspace.for(cfg, r.id).devflowDir, 'answers.json'), 'utf8'));
    expect(answers).toEqual([{ id: 'Q-01', question: 'Câu hỏi Q-01?', answer: 'Có', source: 'excel' }]);
  });

  it('clarify round 5 forces assumptions', async () => {
    register(['BREAKDOWN']);
    const { repo, pipeline, worker, cfg } = setup();
    const r = mkReq(repo, { projectKind: 'new' });
    repo.updateRequest(r.id, { clarifyRound: 4 });
    repo.upsertQuestions(r.id, 5, [q('Q-09', 'must', { suggested_answer: 'Dùng SSO' }), q('Q-10', 'should')]);
    repo.saveAnswer(r.id, 'Q-10', 'Không', 'web');
    startAt(pipeline, r.id, 'CLARIFY');
    await worker.drain();
    expect(existsSync(join(Workspace.for(cfg, r.id).artifactsDir, 'questions', `Questions_${r.id}_round5.xlsx`))).toBe(true);
    pipeline.resumeAfterCustomer(r.id);
    await worker.drain();
    const req = repo.getRequest(r.id)!;
    expect(req.clarifyRound).toBe(5);
    expect(req.stage).toBe('BREAKDOWN');
    const assumptions = JSON.parse(readFileSync(join(Workspace.for(cfg, r.id).devflowDir, 'assumptions.json'), 'utf8'));
    expect(assumptions).toEqual([expect.objectContaining({ id: 'Q-09', assumption: 'Dùng SSO', priority: 'must' })]);
    expect(repo.listEvents(r.id).some(e => /giả định/i.test(e.message))).toBe(true);
  });

  it('breakdown writes ULNL', async () => {
    register(['DESIGN']);
    const { repo, pipeline, worker, cfg } = setup();
    const r = mkReq(repo, { projectKind: 'new', title: 'Hệ thống bán hàng' });
    mockClaude({ 'analyst-breakdown': dir => writeFileSync(join(dir, 'features.json'), JSON.stringify(FEATURES)) });
    startAt(pipeline, r.id, 'BREAKDOWN');
    await worker.drain();
    expect(calls.map(c => c.role)).toEqual(['analyst-breakdown']);
    expect(calls[0]!.prompt).toContain('CN_WEB1');
    expect(calls[0]!.prompt).toMatch(/Less than 10 components/);
    expect(calls[0]!.prompt).toContain('PM');
    const fs = repo.listFeatures(r.id);
    expect(fs.map(f => [f.id, f.kind])).toEqual([['F-01', 'function'], ['F-02', 'function'], ['NF-01', 'nonfunction']]);
    const out = join(Workspace.for(cfg, r.id).artifactsDir, `ULNL_${r.id}.xlsx`);
    expect(existsSync(out)).toBe(true);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);
    const ws = wb.getWorksheet('EFFORT_FUNCTION')!;
    expect(ws.getCell('B9').value).toBe('DANGNHAP');
    expect(ws.getCell('K10').value).toBe('BC2');
    expect(wb.getWorksheet('EFFORT NON-FUNCTION')!.getCell('B10').value).toBe('PM');
    expect(repo.getRequest(r.id)!.stage).toBe('DESIGN');
  });

  it('breakdown rejects unknown type codes and retries', async () => {
    register(['DESIGN']);
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo, { projectKind: 'new' });
    let n = 0;
    mockClaude({
      'analyst-breakdown': dir => {
        const f = structuredClone(FEATURES);
        if (n++ === 0) f.features[0]!.type_code = 'KHONG_CO';
        writeFileSync(join(dir, 'features.json'), JSON.stringify(f));
      },
    });
    startAt(pipeline, r.id, 'BREAKDOWN');
    await worker.drain();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain('KHONG_CO');
    expect(repo.getRequest(r.id)!.stage).toBe('DESIGN');
  });

  it('design renders TKCT and TKDB docx', async () => {
    register(['PLANNING']);
    const { repo, pipeline, worker, cfg } = setup();
    const r = mkReq(repo, { projectKind: 'new' });
    const ws = Workspace.for(cfg, r.id).ensure();
    initRepo(ws.repoDir, `devflow/${r.id}`);
    repo.upsertFeatures(r.id, FEATURES.features.map(f => ({ id: f.id, code: f.code, name: f.name, description: f.description, typeCode: f.type_code, unitTest: f.unit_test, note: f.note, kind: f.kind as 'function' | 'nonfunction' })));
    mockClaude({ architect: writeDesign });
    startAt(pipeline, r.id, 'DESIGN');
    await worker.drain();
    expect(calls.map(c => c.role)).toEqual(['architect']);
    expect(calls[0]!.prompt).toContain('DANGNHAP');
    for (const kind of ['TKCT', 'TKDB']) {
      const out = join(ws.artifactsDir, `${kind}_${r.id}.docx`);
      expect(existsSync(out)).toBe(true);
      const xml = await (await JSZip.loadAsync(readFileSync(out))).file('word/document.xml')!.async('string');
      expect(xml).toContain(kind === 'TKCT' ? 'THIẾT KẾ CHI TIẾT' : 'Script rollback');
    }
    expect(git(ws.repoDir, 'log', '--oneline', '-1')).toMatch(/REQ-001/);
    expect(git(ws.repoDir, 'ls-files')).toContain('docs/devflow/design/tkct.md');
    expect(repo.getRequest(r.id)!.stage).toBe('PLANNING');
  });

  it('design retries when a feature has no detailed design section', async () => {
    register(['PLANNING']);
    const { repo, pipeline, worker, cfg } = setup();
    const r = mkReq(repo, { projectKind: 'new' });
    const ws = Workspace.for(cfg, r.id).ensure();
    initRepo(ws.repoDir, `devflow/${r.id}`);
    repo.upsertFeatures(r.id, [...FEATURES.features, { id: 'F-03', code: 'XUATKHO', name: 'Xuất kho', description: '', type_code: 'CN_WEB1', unit_test: true, note: '', kind: 'function' }].map(f => ({ id: f.id, code: f.code, name: f.name, description: f.description, typeCode: f.type_code, unitTest: f.unit_test, note: f.note, kind: f.kind as 'function' | 'nonfunction' })));
    mockClaude({ architect: writeDesign });
    startAt(pipeline, r.id, 'DESIGN');
    await worker.drain();
    expect(calls).toHaveLength(3);
    expect(calls[1]!.prompt).toContain('XUATKHO');
    expect(repo.getRequest(r.id)!.status).toBe('failed');
  });

  it('codebase scan uses cache', async () => {
    register(['ANALYSIS']);
    const { repo, pipeline, worker, cfg } = setup();
    const r = mkReq(repo, { projectKind: 'existing', gitlabProject: 'grp/app', runMode: 'review' });
    const ws = Workspace.for(cfg, r.id).ensure();
    initRepo(ws.repoDir, `devflow/${r.id}`);
    const sha = git(ws.repoDir, 'rev-parse', 'HEAD');
    const cacheDir = join(cfg.dataDir, 'cache', 'grp_app');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, `${sha}.md`), '# Tổng quan hệ thống\n\nbản cache\n');
    mockClaude({});
    startAt(pipeline, r.id, 'CODEBASE_SCAN');
    await worker.drain();
    expect(calls).toHaveLength(0);
    expect(readFileSync(join(ws.devflowDir, 'codebase-map.md'), 'utf8')).toContain('bản cache');
    const req = repo.getRequest(r.id)!;
    expect([req.stage, req.status]).toEqual(['CODEBASE_SCAN', 'awaiting_approval']);
  });

  it('codebase scan runs explorer and fills the cache on a miss', async () => {
    register(['ANALYSIS']);
    const { repo, pipeline, worker, cfg } = setup();
    const r = mkReq(repo, { projectKind: 'existing', gitlabProject: 'grp/app', runMode: 'review' });
    const ws = Workspace.for(cfg, r.id).ensure();
    initRepo(ws.repoDir, `devflow/${r.id}`);
    const sha = git(ws.repoDir, 'rev-parse', 'HEAD');
    mockClaude({ explorer: dir => writeFileSync(join(dir, 'codebase-map.md'), '# Tổng quan hệ thống\n\nmới quét\n') });
    startAt(pipeline, r.id, 'CODEBASE_SCAN');
    await worker.drain();
    expect(calls.map(c => c.role)).toEqual(['explorer']);
    expect(readFileSync(join(cfg.dataDir, 'cache', 'grp_app', `${sha}.md`), 'utf8')).toContain('mới quét');
  });

  it('intake for a new project without GitLab inits a local repo on devflow/<REQ> and copies attachments', async () => {
    register(['ANALYSIS']);
    const { repo, pipeline, worker, cfg } = setup();
    const r = mkReq(repo, { projectKind: 'new' });
    const src = mkdtempSync(join(tmpdir(), 'devflow-att-'));
    writeFileSync(join(src, 'yeu-cau.txt'), 'nội dung');
    repo.addAttachment(r.id, 'yeu-cau.txt', join(src, 'yeu-cau.txt'), 8);
    pipeline.start(r.id);
    await worker.drain();
    const ws = Workspace.for(cfg, r.id);
    expect(git(ws.repoDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(`devflow/${r.id}`);
    expect(readdirSync(ws.inputsDir)).toEqual(['yeu-cau.txt']);
    expect(repo.listEvents(r.id).some(e => e.level === 'warn' && /GitLab/.test(e.message))).toBe(true);
    expect(repo.getRequest(r.id)!.stage).toBe('ANALYSIS');
  });

  it('intake for an existing project without GitLab fails with a clear message', async () => {
    register();
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo, { projectKind: 'existing', gitlabProject: 'grp/app' });
    pipeline.start(r.id);
    await worker.drain();
    const req = repo.getRequest(r.id)!;
    expect(req.status).toBe('failed');
    expect(repo.latestStageRun(r.id, 'INTAKE')!.error).toMatch(/GitLab/);
  });

  it('intake clones an existing project, works on devflow/<REQ> and design pushes there (never default branch)', async () => {
    register(['PLANNING']);
    // bare remote with one commit on main
    const root = mkdtempSync(join(tmpdir(), 'devflow-remote-'));
    const bare = join(root, 'app.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', bare);
    const seed = join(root, 'seed');
    initRepo(seed, 'main');
    writeFileSync(join(seed, 'README.md'), '# app');
    git(seed, 'add', '-A');
    git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'readme');
    git(seed, 'push', '-q', bare, 'main');
    const created: string[] = [];
    const fakeGitLab = {
      getProject: async () => ({ id: 7, path_with_namespace: 'grp/app', default_branch: 'main', http_url_to_repo: bare }),
      createBranch: async (_pid: number, branch: string, ref: string) => { created.push(`${branch}<-${ref}`); git(bare, 'branch', branch, ref); },
    } as unknown as GitLabClient;
    const s = setup();
    const pipeline = new Pipeline(s.cfg, s.repo, { makeGit: (_r, ws) => new Git(ws.repoDir), makeGitLab: () => fakeGitLab });
    const worker = new Worker(s.cfg, s.repo, pipeline);
    const r = mkReq(s.repo, { projectKind: 'existing', gitlabProject: 'grp/app' });
    s.repo.upsertFeatures(r.id, FEATURES.features.map(f => ({ id: f.id, code: f.code, name: f.name, description: f.description, typeCode: f.type_code, unitTest: f.unit_test, note: f.note, kind: f.kind as 'function' | 'nonfunction' })));
    mockClaude({
      explorer: dir => writeFileSync(join(dir, 'codebase-map.md'), '# Tổng quan hệ thống\n'),
      architect: writeDesign,
    });
    // INTAKE + CODEBASE_SCAN, then jump to DESIGN
    register(['ANALYSIS', 'PLANNING']);
    pipeline.start(r.id);
    await worker.drain();
    expect(created).toEqual([`devflow/${r.id}<-main`]);
    const ws = Workspace.for(s.cfg, r.id);
    expect(git(ws.repoDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(`devflow/${r.id}`);
    pipeline.rerunStage(r.id, 'DESIGN');
    await worker.drain();
    expect(git(bare, 'log', '--oneline', '-1', `devflow/${r.id}`)).toMatch(/REQ-001/);
    expect(git(bare, 'log', '--oneline', '-1', 'main')).toMatch(/readme/);
    expect(JSON.parse(readFileSync(join(ws.root, 'project.json'), 'utf8'))).toMatchObject({ projectId: 7, defaultBranch: 'main', branch: `devflow/${r.id}` });
  });
});

const featureRows = (fs: typeof FEATURES.features) => fs.map(f => ({ id: f.id, code: f.code, name: f.name, description: f.description, typeCode: f.type_code, unitTest: f.unit_test, note: f.note, kind: f.kind as 'function' | 'nonfunction' }));

describe('stages part 1 — review fixes', () => {
  it('round-2 questions reusing an unanswered ID leave exactly one open question (I1)', async () => {
    register();
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo, { projectKind: 'new' });
    repo.upsertQuestions(r.id, 1, [q('Q-01', 'must'), q('Q-02', 'must')]);
    repo.saveAnswer(r.id, 'Q-02', 'Có', 'excel');
    repo.updateRequest(r.id, { clarifyRound: 1 });
    mockClaude({ analyst: writeAnalysis([q('Q-01', 'must', { question: 'Diễn đạt lại Q-01?' })]) });
    startAt(pipeline, r.id, 'ANALYSIS');
    await worker.drain();
    expect(calls[0]!.prompt).toMatch(/đúng ID cũ/);
    const qs = repo.listQuestions(r.id);
    expect(qs.map(x => [x.id, x.round])).toEqual([['Q-02', 1], ['Q-01', 2]]);
    const open = qs.filter(x => !repo.latestAnswers(r.id).get(x.id));
    expect(open.map(x => x.id)).toEqual(['Q-01']);
    expect(open[0]!.question).toBe('Diễn đạt lại Q-01?');
    expect(repo.getRequest(r.id)!.stage).toBe('CLARIFY');
  });

  it('analysis requires the gap and open-question sections (M2)', async () => {
    register();
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo, { projectKind: 'new' });
    let n = 0;
    mockClaude({
      analyst: dir => {
        writeFileSync(join(dir, 'analysis.md'), n++ === 0 ? '# Tổng quan yêu cầu\n\nThiếu mục.\n' : ANALYSIS_MD);
        writeFileSync(join(dir, 'questions.json'), JSON.stringify({ questions: [q('Q-01', 'must')] }));
      },
    });
    startAt(pipeline, r.id, 'ANALYSIS');
    await worker.drain();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain('# Chỗ hổng đã phát hiện');
    expect(calls[1]!.prompt).toContain('# Câu hỏi mở và giả định');
    expect(repo.getRequest(r.id)!.status).toBe('awaiting_customer');
  });

  it('design commits only docs/devflow, not build outputs (I2)', async () => {
    register(['PLANNING']);
    const { repo, pipeline, worker, cfg } = setup();
    const r = mkReq(repo, { projectKind: 'new' });
    const ws = Workspace.for(cfg, r.id).ensure();
    initRepo(ws.repoDir, `devflow/${r.id}`);
    mkdirSync(join(ws.repoDir, 'dist'), { recursive: true });
    writeFileSync(join(ws.repoDir, 'dist', 'bundle.js'), 'built');
    repo.upsertFeatures(r.id, featureRows(FEATURES.features));
    mockClaude({ architect: writeDesign });
    startAt(pipeline, r.id, 'DESIGN');
    await worker.drain();
    const files = git(ws.repoDir, 'ls-files');
    expect(files).toContain('docs/devflow/design/tkct.md');
    expect(files).not.toContain('dist/bundle.js');
    expect(git(ws.repoDir, 'status', '--porcelain')).toContain('dist/');
  });

  it('design checks every template heading and cleans stale outputs (M3)', async () => {
    register(['PLANNING']);
    const { repo, pipeline, worker, cfg } = setup();
    const r = mkReq(repo, { projectKind: 'new' });
    const ws = Workspace.for(cfg, r.id).ensure();
    initRepo(ws.repoDir, `devflow/${r.id}`);
    const designDir = join(ws.devflowDir, 'design');
    mkdirSync(designDir, { recursive: true });
    writeFileSync(join(designDir, 'cu.mmd'), 'graph TD; X-->Y\n');
    repo.upsertFeatures(r.id, featureRows(FEATURES.features));
    let n = 0;
    mockClaude({
      architect: dir => {
        writeDesign(dir);
        if (n++ === 0) {
          writeFileSync(join(dir, 'design', 'tkct.md'), TKCT_MD.replace('## Yêu cầu khác\n', ''));
          writeFileSync(join(dir, 'design', 'tkdb.md'), TKDB_MD.replace('## Định nghĩa thuật ngữ và các từ viết tắt', '## Định nghĩa thuật ngữ'));
        }
      },
    });
    startAt(pipeline, r.id, 'DESIGN');
    await worker.drain();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain('## Yêu cầu khác');
    expect(calls[1]!.prompt).toContain('## Định nghĩa thuật ngữ và các từ viết tắt');
    expect(existsSync(join(designDir, 'cu.mmd'))).toBe(false);
    expect(repo.getRequest(r.id)!.stage).toBe('PLANNING');
  });

  it('intake kind=new on a GitLab project that already has code fails (M4)', async () => {
    register();
    const fakeGitLab = {
      getProject: async () => ({ id: 9, path_with_namespace: 'grp/app', default_branch: 'main', http_url_to_repo: 'x', empty_repo: false }),
    } as unknown as GitLabClient;
    const s = setup();
    const pipeline = new Pipeline(s.cfg, s.repo, { makeGit: (_r, ws) => new Git(ws.repoDir), makeGitLab: () => fakeGitLab });
    const worker = new Worker(s.cfg, s.repo, pipeline);
    const r = mkReq(s.repo, { projectKind: 'new', gitlabProject: 'grp/app' });
    pipeline.start(r.id);
    await worker.drain();
    expect(s.repo.getRequest(r.id)!.status).toBe('failed');
    expect(s.repo.latestStageRun(r.id, 'INTAKE')!.error).toContain("Dự án đã có mã nguồn, hãy chọn loại 'Dự án có sẵn'");
  });

  it('attachment names are sanitised and de-duplicated (M5)', async () => {
    expect(safeFileName('..')).toBe('file');
    expect(safeFileName('.')).toBe('file');
    expect(safeFileName('')).toBe('file');
    expect(safeFileName('a/b\\..\\c.txt')).toBe('c.txt');
    expect(safeFileName('x<y>.txt')).toBe('x_y_.txt');
    register(['ANALYSIS']);
    const { repo, pipeline, worker, cfg } = setup();
    const r = mkReq(repo, { projectKind: 'new' });
    const src = mkdtempSync(join(tmpdir(), 'devflow-att-'));
    for (const [i, name] of ['a.txt', 'b.txt', 'c.txt', 'd'].entries()) writeFileSync(join(src, name), String(i));
    repo.addAttachment(r.id, 'yeu-cau.txt', join(src, 'a.txt'), 1);
    repo.addAttachment(r.id, 'yeu-cau.txt', join(src, 'b.txt'), 1);
    repo.addAttachment(r.id, 'YEU-CAU.txt', join(src, 'c.txt'), 1);
    repo.addAttachment(r.id, '..', join(src, 'd'), 1);
    pipeline.start(r.id);
    await worker.drain();
    const inputs = Workspace.for(cfg, r.id).inputsDir;
    expect(readdirSync(inputs).sort()).toEqual(['YEU-CAU-3.txt', 'file', 'yeu-cau-2.txt', 'yeu-cau.txt']);
    expect(readFileSync(join(inputs, 'yeu-cau-2.txt'), 'utf8')).toBe('1');
  });

  it('clarify exports and waits even when only should questions are open; continue turns them into assumptions (M6)', async () => {
    register(['ANALYSIS']);
    const { repo, pipeline, worker, cfg } = setup();
    const r = mkReq(repo, { projectKind: 'new' });
    repo.upsertQuestions(r.id, 1, [q('Q-01', 'should', { suggested_answer: 'Không' })]);
    startAt(pipeline, r.id, 'CLARIFY');
    await worker.drain();
    const ws = Workspace.for(cfg, r.id);
    expect(existsSync(join(ws.artifactsDir, 'questions', `Questions_${r.id}_round1.xlsx`))).toBe(true);
    expect(repo.getRequest(r.id)!.status).toBe('awaiting_customer');
    pipeline.resumeAfterCustomer(r.id); // staff: "Tiếp tục với giả định", nothing answered
    await worker.drain();
    expect(repo.getRequest(r.id)!.stage).toBe('ANALYSIS');
    expect(repo.getRequest(r.id)!.clarifyRound).toBe(1);
    const assumptions = JSON.parse(readFileSync(join(ws.devflowDir, 'assumptions.json'), 'utf8'));
    expect(assumptions).toEqual([expect.objectContaining({ id: 'Q-01', assumption: 'Không', priority: 'should' })]);
  });
});

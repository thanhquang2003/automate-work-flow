import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Question } from '../../src/domain/types.js';
import { exportQuestions } from '../../src/office/questions-xlsx.js';
import { hashPassword } from '../../src/security/crypto.js';
import { signSession } from '../../src/web/auth.js';
import { buildServer } from '../../src/web/server.js';
import { mkReq, setup } from '../engine/helpers.js';

const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

async function boot(serverMode = false) {
  const s = setup(serverMode ? { mode: 'server', secretKey: 'test-secret', host: '0.0.0.0' } : {});
  const app = await buildServer(s.cfg, { repo: s.repo, pipeline: s.pipeline });
  apps.push(app);
  return { ...s, app };
}

const Q = (id: string, over: Partial<Question> = {}): Question => ({
  id, category: 'Chức năng', question: `Câu hỏi ${id}?`, why: `Lý do ${id}`, type: 'text', options: [], suggested_answer: '', priority: 'must', ...over,
});
const origin = { origin: 'http://localhost:3000', host: 'localhost:3000' };
const form = { 'content-type': 'application/x-www-form-urlencoded', ...origin };
const enc = (o: Record<string, string | string[]>) =>
  Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map(x => `${encodeURIComponent(k)}=${encodeURIComponent(x)}`)).join('&');

async function seedSurvey() {
  const b = await boot(true);
  const r = mkReq(b.repo, { title: 'Hệ thống kho' });
  b.repo.updateRequest(r.id, { status: 'awaiting_customer', stage: 'CLARIFY' });
  b.repo.upsertQuestions(r.id, 1, [
    Q('Q-01'),
    Q('Q-02', { type: 'single', options: ['Có', 'Không'], suggested_answer: 'Có', priority: 'should' }),
    Q('Q-03', { type: 'multi', options: ['A', 'B', 'C'], category: 'Dữ liệu' }),
  ]);
  b.repo.createSurveyLink({ token: 'tok123', requestId: r.id, round: 1, expiresAt: Date.now() + 86_400_000 });
  return { ...b, r };
}

describe('survey + questions tab', () => {
  it('import excel saves answers', async () => {
    const b = await boot();
    const { app, repo } = b;
    const r = mkReq(repo);
    repo.upsertQuestions(r.id, 1, [Q('Q-01'), Q('Q-02')]);
    const buf = await exportQuestions(r.id, 1, repo.listQuestions(r.id), new Map([['Q-01', 'Trả lời 1'], ['Q-99', 'lạ']]));
    const bd = '----x';
    const head = Buffer.from(`--${bd}\r\nContent-Disposition: form-data; name="file"; filename="a.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const payload = Buffer.concat([head, buf, Buffer.from(`\r\n--${bd}--\r\n`)]);
    const res = await app.inject({ method: 'POST', url: `/requests/${r.id}/answers/import`, payload, headers: { 'content-type': `multipart/form-data; boundary=${bd}`, ...origin } });
    expect(res.statusCode).toBe(302);
    expect(repo.latestAnswers(r.id).get('Q-01')).toBe('Trả lời 1');
    expect(repo.latestAnswers(r.id).has('Q-99')).toBe(false);
    expect(repo.listAnswers(r.id)[0]!.source).toBe('excel');
    expect(decodeURIComponent(String(res.headers.location))).toContain('1 câu trả lời');
  });

  it('staff edit saves answer with source staff; tab shows controls', async () => {
    const b = await boot();
    const r = mkReq(b.repo);
    b.repo.updateRequest(r.id, { status: 'awaiting_customer', stage: 'CLARIFY' });
    b.repo.upsertQuestions(r.id, 1, [Q('Q-01')]);
    const res = await b.app.inject({ method: 'POST', url: `/requests/${r.id}/answers`, headers: form, payload: enc({ qid: 'Q-01', answer: 'Nhân viên nhập' }) });
    expect(res.statusCode).toBe(302);
    expect(b.repo.listAnswers(r.id)[0]).toMatchObject({ answer: 'Nhân viên nhập', source: 'staff' });
    const page = await b.app.inject({ method: 'GET', url: `/requests/${r.id}?tab=questions` });
    expect(page.body).toContain('Nhân viên nhập');
    expect(page.body).toContain(`/requests/${r.id}/questions.xlsx`);
    expect(page.body).toContain('Các câu chưa trả lời sẽ được chuyển thành giả định');
    const x = await b.app.inject({ method: 'GET', url: `/requests/${r.id}/questions.xlsx` });
    expect(x.statusCode).toBe(200);
    expect(String(x.headers['content-type'])).toContain('spreadsheetml');
  });

  it('survey link creation (server only) shows full url', async () => {
    const { app, repo, r, cfg } = await seedSurvey();
    const u = repo.createUser({ username: 'a', passwordHash: hashPassword('password1'), role: 'admin' });
    const cookie = `devflow_sid=${signSession(cfg.secretKey, u.id)}`;
    const res = await app.inject({ method: 'POST', url: `/requests/${r.id}/survey-link`, headers: { ...form, cookie } });
    expect(res.statusCode).toBe(302);
    const links = repo.listSurveyLinks(r.id);
    expect(links).toHaveLength(2);
    const page = await app.inject({ method: 'GET', url: `/requests/${r.id}?tab=questions`, headers: { cookie } });
    expect(page.body).toContain(`${cfg.publicBaseUrl}/s/${links[1]!.token}`);
    const local = await boot();
    const lr = mkReq(local.repo);
    const lres = await local.app.inject({ method: 'POST', url: `/requests/${lr.id}/survey-link`, headers: form });
    expect(decodeURIComponent(String(lres.headers.location))).toContain('server');
    expect(local.repo.listSurveyLinks(lr.id)).toHaveLength(0);
  });

  it('survey renders questions', async () => {
    const { app } = await seedSurvey();
    const res = await app.inject({ method: 'GET', url: '/s/tok123' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Hệ thống kho');
    expect(res.body).toContain('Vui lòng trả lời các câu hỏi dưới đây để chúng tôi hiểu đúng yêu cầu của Quý khách');
    expect(res.body).toContain('Câu hỏi Q-01?');
    expect(res.body).toContain('(bắt buộc)');
    expect(res.body).toContain('type="radio"');
    expect(res.body).toContain('type="checkbox"');
    expect(res.body).toContain('Lý do Q-01');
    expect(res.body).toContain('Chức năng');
    expect(res.body).toContain('Dữ liệu');
    expect(res.body).toContain('width=device-width');
    expect(res.body).not.toContain('CLARIFY');
    expect(res.body).not.toContain('DevFlow');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('survey save then submit', async () => {
    const { app, repo, r } = await seedSurvey();
    const post = (o: Record<string, string | string[]>) => app.inject({ method: 'POST', url: '/s/tok123', headers: form, payload: enc(o) });
    const saved = await post({ action: 'save', 'a_Q-01': 'Bản nháp' });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).toContain('Bản nháp');
    expect(repo.latestAnswers(r.id).get('Q-01')).toBe('Bản nháp');
    expect(repo.getSurveyLink('tok123')!.submittedAt).toBeNull();
    // server-side must validation: Q-03 missing
    const bad = await post({ action: 'submit', 'a_Q-01': 'Đủ' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('Vui lòng trả lời');
    expect(repo.getSurveyLink('tok123')!.submittedAt).toBeNull();
    const ok = await post({ action: 'submit', 'a_Q-01': 'Đủ', 'a_Q-02': 'Không', 'a_Q-03': ['A', 'C', 'ZZZ'] });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('Cảm ơn');
    expect(repo.getSurveyLink('tok123')!.submittedAt).not.toBeNull();
    expect(repo.latestAnswers(r.id).get('Q-01')).toBe('Đủ');
    expect(repo.latestAnswers(r.id).get('Q-03')).toBe('A; C');
    expect(repo.listAnswers(r.id).every(a => a.source === 'web')).toBe(true);
    const get = await app.inject({ method: 'GET', url: '/s/tok123' });
    expect(get.body).toContain('Cảm ơn');
    expect(get.body).not.toContain('<form');
  });

  it('rejects expired token', async () => {
    const { app, repo, r } = await seedSurvey();
    repo.createSurveyLink({ token: 'old', requestId: r.id, round: 1, expiresAt: Date.now() - 1000 });
    const res = await app.inject({ method: 'GET', url: '/s/old' });
    expect(res.statusCode).toBe(410);
    expect(res.body).toContain('Liên kết đã hết hạn');
    expect((await app.inject({ method: 'POST', url: '/s/old', headers: form, payload: enc({ action: 'save', 'a_Q-01': 'x' }) })).statusCode).toBe(410);
    expect((await app.inject({ method: 'GET', url: '/s/nope' })).statusCode).toBe(404);
  });

  it('post after submit returns 409', async () => {
    const { app, repo, r } = await seedSurvey();
    const body = enc({ action: 'submit', 'a_Q-01': 'a', 'a_Q-03': 'B' });
    expect((await app.inject({ method: 'POST', url: '/s/tok123', headers: form, payload: body })).statusCode).toBe(200);
    const n = repo.listAnswers(r.id).length;
    const again = await app.inject({ method: 'POST', url: '/s/tok123', headers: form, payload: enc({ action: 'save', 'a_Q-01': 'đổi' }) });
    expect(again.statusCode).toBe(409);
    expect(repo.listAnswers(r.id)).toHaveLength(n);
  });

  it('survey POST: foreign origin 403, rate limit 429', async () => {
    const { app } = await seedSurvey();
    const evil = await app.inject({ method: 'POST', url: '/s/tok123', headers: { ...form, origin: 'http://evil.example' }, payload: enc({ action: 'save' }) });
    expect(evil.statusCode).toBe(403);
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await app.inject({ method: 'POST', url: '/s/tok123', headers: form, payload: enc({ action: 'save' }) })).statusCode;
    expect(last).toBe(429);
  });

  it('local mode survey 404', async () => {
    const { app, repo } = await boot();
    const r = mkReq(repo);
    repo.createSurveyLink({ token: 'tk', requestId: r.id, round: 1, expiresAt: Date.now() + 1000 });
    expect((await app.inject({ method: 'GET', url: '/s/tk' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/s/tk', headers: form, payload: enc({ action: 'save' }) })).statusCode).toBe(404);
  });

  it('continue resumes pipeline', async () => {
    const { app, repo, pipeline } = await boot();
    const r = mkReq(repo);
    repo.updateRequest(r.id, { status: 'awaiting_customer', stage: 'CLARIFY' });
    const resume = vi.spyOn(pipeline, 'resumeAfterCustomer').mockImplementation(() => undefined);
    const res = await app.inject({ method: 'POST', url: `/requests/${r.id}/continue`, headers: form });
    expect(res.statusCode).toBe(302);
    expect(resume).toHaveBeenCalledWith(r.id);
    resume.mockClear();
    repo.updateRequest(r.id, { status: 'running' });
    const bad = await app.inject({ method: 'POST', url: `/requests/${r.id}/continue`, headers: form });
    expect(bad.statusCode).toBe(302);
    expect(String(bad.headers.location)).toContain('err=');
    expect(resume).not.toHaveBeenCalled();
  });

  it('rate limit buckets by client IP only with trustProxy', async () => {
    const s = setup({ mode: 'server', secretKey: 'test-secret', host: '0.0.0.0', trustProxy: true });
    const app = await buildServer(s.cfg, { repo: s.repo, pipeline: s.pipeline });
    apps.push(app);
    const post = (ip: string) => app.inject({ method: 'POST', url: '/s/none', headers: { ...form, 'x-forwarded-for': ip }, payload: enc({ action: 'save' }) });
    for (let i = 0; i < 30; i++) await post('1.1.1.1');
    expect((await post('1.1.1.1')).statusCode).toBe(429);
    expect((await post('2.2.2.2')).statusCode).toBe(404);
    // without trustProxy the header is ignored: same bucket
    const b = await boot(true);
    const post2 = (ip: string) => b.app.inject({ method: 'POST', url: '/s/none', headers: { ...form, 'x-forwarded-for': ip }, payload: enc({ action: 'save' }) });
    for (let i = 0; i < 30; i++) await post2('3.3.3.3');
    expect((await post2('4.4.4.4')).statusCode).toBe(429);
  });

  it('submit auto-resumes in auto mode only when all must answered; review mode does not', async () => {
    for (const mode of ['auto', 'review'] as const) {
      const { app, repo, r, pipeline } = await seedSurvey();
      repo.updateRequest(r.id, { runMode: mode });
      const resume = vi.spyOn(pipeline, 'resumeAfterCustomer').mockImplementation(() => undefined);
      await app.inject({ method: 'POST', url: '/s/tok123', headers: form, payload: enc({ action: 'submit', 'a_Q-01': 'a', 'a_Q-03': 'B' }) });
      expect(resume).toHaveBeenCalledTimes(mode === 'auto' ? 1 : 0);
    }
  });

  it('no auto-resume when a must question stays open (answered elsewhere not counted)', async () => {
    const { app, repo, r, pipeline } = await seedSurvey();
    repo.updateRequest(r.id, { runMode: 'auto' });
    repo.upsertQuestions(r.id, 2, [Q('Q-09')]);
    const resume = vi.spyOn(pipeline, 'resumeAfterCustomer').mockImplementation(() => undefined);
    await app.inject({ method: 'POST', url: '/s/tok123', headers: form, payload: enc({ action: 'submit', 'a_Q-01': 'a', 'a_Q-03': 'B' }) });
    expect(resume).not.toHaveBeenCalled();
  });

  it('multi options containing semicolons prefill and validate exactly', async () => {
    const b = await boot(true);
    const r = mkReq(b.repo);
    b.repo.upsertQuestions(r.id, 1, [Q('Q-01', { type: 'multi', options: ['A; B', 'C', 'D'] })]);
    b.repo.createSurveyLink({ token: 'semi', requestId: r.id, round: 1, expiresAt: Date.now() + 1e6 });
    await b.app.inject({ method: 'POST', url: '/s/semi', headers: form, payload: enc({ action: 'save', 'a_Q-01': ['D', 'A; B', 'bogus'] }) });
    expect(b.repo.latestAnswers(r.id).get('Q-01')).toBe('A; B; D');
    const page = await b.app.inject({ method: 'GET', url: '/s/semi' });
    expect(page.body).toMatch(/value="A; B" checked/);
    expect(page.body).toMatch(/value="D" checked/);
    expect(page.body).not.toMatch(/value="C" checked/);
  });
});

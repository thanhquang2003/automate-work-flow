import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../../config.js';
import type { Repo } from '../../db/repo.js';
import type { RequestRow } from '../../domain/types.js';
import { createSurveyLink, surveyUrl } from '../../engine/survey.js';
import { questionsFileName } from '../../engine/stages/clarify.js';
import { openQuestions } from '../../engine/stages/common.js';
import { exportQuestions, importAnswers } from '../../office/questions-xlsx.js';
import { PermissionError } from '../../projects/service.js';
import { allowedOnRequest, auditWeb, forbidPage } from '../authz.js';
import type { WebDeps } from '../server.js';
import { render, type LayoutData } from '../view.js';

const MAX_ANSWER = 10_000;
const SOURCE_LABELS: Record<string, string> = { excel: 'Excel', web: 'Khảo sát web', staff: 'Nhân viên' };

/** Data for views/partials/questions.eta. */
export function questionsTabData(repo: Repo, cfg: Config, r: RequestRow): Record<string, unknown> {
  const questions = repo.listQuestions(r.id);
  const latest = new Map<string, { answer: string; source: string }>();
  for (const a of repo.listAnswers(r.id)) latest.set(a.questionId, { answer: a.answer, source: a.source });
  const answered = (id: string) => (latest.get(id)?.answer ?? '').trim() !== '';
  const must = questions.filter(q => q.priority === 'must');
  return {
    r, questions, latest, SOURCE_LABELS, mode: cfg.mode,
    surveys: repo.web.listSurveyLinks(r.id).map(s => ({ ...s, url: surveyUrl(cfg, s.token) })),
    progress: { must: must.length, mustAnswered: must.filter(q => answered(q.id)).length, total: questions.length, answered: questions.filter(q => answered(q.id)).length },
    now: Date.now(),
  };
}

export function questionRoutes(app: FastifyInstance, cfg: Config, { repo, pipeline }: WebDeps): void {
  const layout = (req: FastifyRequest, title: string): LayoutData => ({ user: req.user, mode: cfg.mode, title });
  /** Server mode: the acting person (null = nobody). Local mode: undefined (no accounts, no checks). */
  const actorArg = (req: FastifyRequest): number | null | undefined => (cfg.mode === 'server' ? (req.user?.id ?? null) : undefined);
  const back = (reply: FastifyReply, id: string, kind: 'ok' | 'err', msg: string) =>
    reply.redirect(`/requests/${id}?tab=questions&${kind}=${encodeURIComponent(msg.slice(0, 300))}`);
  const notFound = (req: FastifyRequest, reply: FastifyReply) =>
    reply.code(404).type('text/html; charset=utf-8').send(render('error', layout(req, 'Không tìm thấy'), { code: 404, message: 'Không tìm thấy yêu cầu.' }));

  app.get('/requests/:id/questions.xlsx', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = repo.getRequest(id);
    if (!r) return notFound(req, reply);
    if (!allowedOnRequest(cfg, repo, req.user, r, 'read')) return forbidPage(cfg, req, reply);
    const round = r.clarifyRound + 1;
    const open = openQuestions(repo, id);
    const list = open.length ? open : repo.listQuestions(id);
    const buf = await exportQuestions(id, round, list, repo.latestAnswers(id));
    reply.header('Content-Disposition', `attachment; filename="${questionsFileName(id, round, r.baselineVersion)}"`);
    return reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buf);
  });

  app.post('/requests/:id/answers/import', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r0 = repo.getRequest(id);
    if (!r0) return notFound(req, reply);
    if (!allowedOnRequest(cfg, repo, req.user, r0, 'clarify.write')) return forbidPage(cfg, req, reply);
    if (!req.isMultipart()) return back(reply, id, 'err', 'Biểu mẫu phải gửi dạng multipart.');
    const part = await req.file();
    if (!part || !part.filename) return back(reply, id, 'err', 'Vui lòng chọn file Excel (.xlsx).');
    const buf = await part.toBuffer();
    if (!/\.xlsx$/i.test(part.filename)) return back(reply, id, 'err', 'Chỉ hỗ trợ file .xlsx.');
    let parsed;
    try { parsed = await importAnswers(buf); } catch { return back(reply, id, 'err', 'Không đọc được file Excel.'); }
    const known = new Set(repo.listQuestions(id).map(q => q.id));
    let unknown = parsed.unknownRows;
    const rows: { qid: string; answer: string }[] = [];
    for (const a of parsed.answers) {
      if (!known.has(a.id)) { unknown++; continue; }
      rows.push({ qid: a.id, answer: a.answer.slice(0, MAX_ANSWER) });
    }
    let saved: number;
    try { saved = pipeline.saveAnswers(id, rows, 'excel', actorArg(req)); } catch (e) {
      if (e instanceof PermissionError) return forbidPage(cfg, req, reply, e.message);
      throw e;
    }
    let msg = `Đã nhập ${saved} câu trả lời từ Excel.`;
    if (unknown) msg += ` ${unknown} dòng không khớp câu hỏi nào.`;
    if (parsed.duplicateIds.length) msg += ` Trùng mã: ${parsed.duplicateIds.join(', ')} (lấy dòng cuối).`;
    return back(reply, id, 'ok', msg);
  });

  app.post('/requests/:id/answers', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r0 = repo.getRequest(id);
    if (!r0) return notFound(req, reply);
    if (!allowedOnRequest(cfg, repo, req.user, r0, 'clarify.write')) return forbidPage(cfg, req, reply);
    const b = (req.body ?? {}) as Record<string, string | undefined>;
    const qid = (b.qid ?? '').trim();
    if (!repo.listQuestions(id).some(q => q.id === qid)) return back(reply, id, 'err', 'Câu hỏi không tồn tại.');
    try { pipeline.saveAnswers(id, [{ qid, answer: (b.answer ?? '').trim().slice(0, MAX_ANSWER) }], 'staff', actorArg(req)); } catch (e) {
      if (e instanceof PermissionError) return forbidPage(cfg, req, reply, e.message);
      throw e;
    }
    return back(reply, id, 'ok', `Đã lưu câu trả lời ${qid}.`);
  });

  app.post('/requests/:id/survey-link', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = repo.getRequest(id);
    if (!r) return notFound(req, reply);
    if (!allowedOnRequest(cfg, repo, req.user, r, 'clarify.write')) return forbidPage(cfg, req, reply);
    if (cfg.mode !== 'server') return back(reply, id, 'err', 'Link khảo sát chỉ khả dụng ở chế độ server.');
    createSurveyLink(repo, cfg, id, r.clarifyRound + 1);
    auditWeb(repo, req, 'survey.link', { projectId: r.projectId, requestId: id });
    return back(reply, id, 'ok', 'Đã tạo link khảo sát mới.');
  });

  app.post('/requests/:id/continue', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = repo.getRequest(id);
    if (!r) return notFound(req, reply);
    if (!allowedOnRequest(cfg, repo, req.user, r, 'clarify.write')) return forbidPage(cfg, req, reply);
    if (r.status !== 'awaiting_customer') return back(reply, id, 'err', 'Yêu cầu không ở trạng thái chờ khách hàng.');
    try { pipeline.resumeAfterCustomer(...(cfg.mode === 'server' ? [id, req.user?.id ?? null] as const : [id] as const)); } catch (e) {
      if (e instanceof PermissionError) return forbidPage(cfg, req, reply, e.message);
      auditWeb(repo, req, 'request.continue_failed', { projectId: r.projectId, requestId: id, detail: { error: e instanceof Error ? e.message.slice(0, 200) : String(e) } });
      return back(reply, id, 'err', e instanceof Error ? e.message : String(e));
    }
    return reply.redirect(`/requests/${id}`);
  });
}

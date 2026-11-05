import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../../config.js';
import type { QuestionRow, SurveyLinkRow } from '../../domain/types.js';
import { openQuestions } from '../../engine/stages/common.js';
import { sameOrigin } from '../auth.js';
import type { WebDeps } from '../server.js';
import { renderPartial } from '../view.js';

const WINDOW_MS = 10 * 60 * 1000;
const MAX_POSTS = 30;
const MAX_ANSWER = 5000;

type Body = Record<string, string | string[] | undefined>;

/** Splits a stored multi answer (options joined by "; ") against the exact option list, in option order. */
export function splitMulti(val: string, options: string[]): string[] {
  const out: string[] = [];
  let pos = 0;
  for (const o of options) {
    if (val.startsWith(o, pos) && (pos + o.length === val.length || val.startsWith("; ", pos + o.length))) {
      out.push(o);
      pos += o.length + 2;
    }
  }
  return out;
}

export function surveyRoutes(app: FastifyInstance, cfg: Config, { repo, pipeline }: WebDeps): void {
  const hits = new Map<string, number[]>();
  const limited = (ip: string): boolean => {
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter(t => now - t < WINDOW_MS);
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (v.every(t => now - t >= WINDOW_MS)) hits.delete(k);
    return recent.length > MAX_POSTS;
  };

  const page = (reply: FastifyReply, code: number, data: Record<string, unknown>) =>
    reply.code(code).type('text/html; charset=utf-8')
      .header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').header('X-Frame-Options', 'DENY')
      .send(renderPartial('survey', data));
  const msgPage = (reply: FastifyReply, code: number, title: string, message: string) => page(reply, code, { state: 'message', title, message });
  const notFound = (reply: FastifyReply) => msgPage(reply, 404, 'Không tìm thấy', 'Không tìm thấy trang yêu cầu.');

  /** Questions shown to the customer: this link's round and earlier, still unanswered or answered via the web. */
  function visibleQuestions(link: SurveyLinkRow): { questions: QuestionRow[]; values: Map<string, string> } {
    const latest = new Map<string, { answer: string; source: string }>();
    for (const a of repo.listAnswers(link.requestId)) latest.set(a.questionId, { answer: a.answer, source: a.source });
    const values = new Map<string, string>();
    const questions = repo.listQuestions(link.requestId).filter(q => {
      if (q.round > link.round) return false;
      const a = latest.get(q.id);
      if (a && a.answer.trim() && a.source !== 'web') return false;
      values.set(q.id, a?.answer ?? '');
      return true;
    });
    return { questions, values };
  }

  const form = (reply: FastifyReply, link: SurveyLinkRow, code = 200, over: { values?: Map<string, string>; errors?: Map<string, string>; notice?: string; proposal?: string } = {}) => {
    const req = repo.getRequest(link.requestId);
    const v = visibleQuestions(link);
    const groups = new Map<string, QuestionRow[]>();
    for (const q of v.questions) {
      const g = groups.get(q.category) ?? [];
      g.push(q);
      groups.set(q.category, g);
    }
    return page(reply, code, {
      state: 'form', splitMulti, title: req?.title ?? '', groups: [...groups], values: over.values ?? v.values, errors: over.errors ?? new Map(), notice: over.notice ?? '', proposal: over.proposal ?? '', maxProposal: MAX_ANSWER,
    });
  };

  /** Resolves an active link, or sends the matching error/thank-you page and returns undefined. */
  const resolve = (token: string, reply: FastifyReply, post: boolean): SurveyLinkRow | undefined => {
    const link = repo.web.getSurveyLink(token);
    if (!link) { void notFound(reply); return undefined; }
    if (link.submittedAt !== null) {
      if (post) void msgPage(reply, 409, 'Đã gửi', 'Khảo sát này đã được gửi nên không thể chỉnh sửa. Cảm ơn Quý khách.');
      else void page(reply, 200, { state: 'thanks', title: repo.getRequest(link.requestId)?.title ?? '' });
      return undefined;
    }
    if (link.expiresAt < Date.now()) { void msgPage(reply, 410, 'Liên kết đã hết hạn', 'Liên kết đã hết hạn. Vui lòng liên hệ nhân viên để được cấp liên kết mới.'); return undefined; }
    return link;
  };

  /** Auto mode: once every must question is answered, continue the pipeline without staff. */
  const autoResume = (reqId: string): void => {
    const r = repo.getRequest(reqId);
    if (!r || r.status !== 'awaiting_customer' || r.runMode !== 'auto') return;
    if (openQuestions(repo, reqId).some(q => q.priority === 'must')) return;
    try { pipeline.resumeAfterCustomer(reqId); } catch (e) { console.error('auto-resume failed', e); }
  };

  app.get('/s/:token', async (req, reply) => {
    if (cfg.mode !== 'server') return notFound(reply);
    const link = resolve((req.params as { token: string }).token, reply, false);
    return link ? form(reply, link) : reply;
  });

  app.post('/s/:token', async (req: FastifyRequest, reply) => {
    if (cfg.mode !== 'server') return notFound(reply);
    if (limited(req.ip)) return msgPage(reply, 429, 'Quá nhiều yêu cầu', 'Quá nhiều yêu cầu, vui lòng thử lại sau ít phút.');
    if (!sameOrigin(req, false, cfg.publicBaseUrl)) return msgPage(reply, 403, 'Bị từ chối', 'Yêu cầu bị từ chối (sai nguồn gốc).');
    const link = resolve((req.params as { token: string }).token, reply, true);
    if (!link) return reply;

    const b = (req.body ?? {}) as Body;
    const submit = b.action === 'submit';
    const proposal = String(Array.isArray(b.proposal) ? (b.proposal[0] ?? '') : (b.proposal ?? '')).trim().slice(0, MAX_ANSWER);
    const { questions, values: prev } = visibleQuestions(link);
    const values = new Map<string, string>();
    for (const q of questions) {
      const raw = b[`a_${q.id}`];
      const arr = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map(s => String(s).trim()).filter(Boolean);
      const ok = q.type === 'text' || q.options.length === 0 ? arr : arr.filter(x => q.options.includes(x));
      const multi = q.options.length ? q.options.filter(o => ok.includes(o)) : [...new Set(ok)];
      values.set(q.id, (q.type === 'multi' ? multi.join('; ') : (ok[0] ?? '')).slice(0, MAX_ANSWER));
    }
    if (submit) {
      const errors = new Map<string, string>();
      for (const q of questions) if (q.priority === 'must' && !values.get(q.id)) errors.set(q.id, 'Vui lòng trả lời câu hỏi bắt buộc này.');
      if (errors.size) return form(reply, link, 400, { values, errors, proposal, notice: `Vui lòng trả lời ${errors.size} câu hỏi bắt buộc còn thiếu.` });
    }
    repo.tx(() => {
      for (const q of questions) {
        const v = values.get(q.id) ?? '';
        if (v !== (prev.get(q.id) ?? '')) repo.saveAnswer(link.requestId, q.id, v, 'web');
      }
      if (submit) repo.web.markSurveySubmitted(link.token);
    });
    let proposalNote = '';
    const dup = proposal && repo.listChangeRequests(link.requestId).some(c => c.source === 'customer' && c.status === 'proposed' && c.description === proposal);
    if (proposal && dup) proposalNote = ' Đề xuất thay đổi này đã được ghi nhận trước đó.';
    else if (proposal) {
      try {
        pipeline.proposeChange(link.requestId, { title: 'Đề xuất của khách hàng', description: proposal, kind: 'other', source: 'customer' });
        proposalNote = ' Đề xuất thay đổi của Quý khách đã được ghi nhận.';
      } catch (e) { console.error('proposeChange failed', e); proposalNote = ' Không thể ghi nhận đề xuất thay đổi.'; }
    }
    if (submit) autoResume(link.requestId);
    if (submit) return page(reply, 200, { state: 'thanks', title: repo.getRequest(link.requestId)?.title ?? '' });
    return form(reply, link, 200, { notice: `Đã lưu bản nháp. Quý khách có thể quay lại hoàn thành sau.${proposalNote}` });
  });
}

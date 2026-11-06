import { createWriteStream, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../../config.js';
import type { CrKind } from '../../domain/types.js';
import { loadImpact } from '../../engine/changes.js';
import { changeDir } from '../../engine/stages/common.js';
import { safeMkdirp, safeWriteFile } from '../../engine/safe-fs.js';
import { Workspace } from '../../engine/workspace.js';
import { uniqueName } from '../../engine/stages/intake.js';
import { markdownToHtml } from '../markdown-html.js';
import { PermissionError } from '../../projects/service.js';
import type { WebDeps } from '../server.js';
import { render, type LayoutData } from '../view.js';
import { cleanName, readRequestText } from './requests.js';
import { allowedOnRequest, auditWeb, forbidPage, statusOfError, type Need } from '../authz.js';

const KINDS: CrKind[] = ['add', 'modify', 'remove', 'nfr', 'other'];
const MAX_TEXT = 20000;

/** Validation failure raised by this module; its message is safe to show. */
class UserError extends Error {}
/** Plain Errors the pipeline throws for wrong-state calls (see decideChange / expectCr / approve / reject). */
const KNOWN_STATE_ERRORS = [
  /^Yêu cầu [^ ]+ không ở bước chờ quyết định thay đổi/,
  /^Yêu cầu thay đổi [^ ]+ đang ở trạng thái/,
  /^Không tìm thấy yêu cầu thay đổi/,
  /^Giai đoạn CHANGE được duyệt theo từng yêu cầu/,
];

export function changeRoutes(app: FastifyInstance, cfg: Config, { repo, pipeline }: WebDeps): void {
  const layout = (req: FastifyRequest, title: string): LayoutData => ({ user: req.user, mode: cfg.mode, title });
  const html = (reply: FastifyReply, s: string, code = 200) => reply.code(code).type('text/html; charset=utf-8').send(s);
  const errPage = (req: FastifyRequest, reply: FastifyReply, code: number, message: string) =>
    html(reply, render('error', layout(req, code === 404 ? 'Không tìm thấy' : 'Lỗi'), { code, message }), code);

  /** Flash text for expected errors (validation, wrong state, busy); anything else is logged and rethrown (500 page). */
  const msgOf = (e: unknown): string => {
    if (e instanceof Error) {
      if (e.name === 'PipelineBusyError') return 'Bước hiện tại đang chạy, vui lòng thử lại sau khi hoàn tất.';
      if (e instanceof UserError || e.name === 'CrNotAllowedError' || KNOWN_STATE_ERRORS.some(re => re.test(e.message))) return e.message.slice(0, 300);
    }
    console.error('change route failed', e);
    throw e;
  };
  const forbidOrStale = (req: FastifyRequest, reply: FastifyReply, e: Error) =>
    statusOfError(e) === 409 ? errPage(req, reply, 409, e.message) : forbidPage(cfg, req, reply, e.message);
  const back = (reply: FastifyReply, id: string, tab: string, err?: string) =>
    reply.redirect(`/requests/${id}?tab=${tab}${err ? `&err=${encodeURIComponent(err)}` : ''}`);

  // ---- create (multipart: title, description, kind, files[]) ----
  app.post('/requests/:id/changes', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = repo.getRequest(id);
    if (!r) return errPage(req, reply, 404, 'Không tìm thấy yêu cầu.');
    if (!allowedOnRequest(cfg, repo, req.user, r, 'cr.create')) return forbidPage(cfg, req, reply);
    if (r.status === 'cancelled') return errPage(req, reply, 409, 'Yêu cầu đã bị hủy, không thể tạo yêu cầu thay đổi.');
    if (!req.isMultipart()) return errPage(req, reply, 400, 'Biểu mẫu phải gửi dạng multipart.');

    const fields: Record<string, string> = {};
    const tmpDir = join(resolve(cfg.dataDir), 'tmp', randomBytes(8).toString('hex'));
    mkdirSync(tmpDir, { recursive: true });
    const saved: { name: string; tmp: string; size: number }[] = [];
    let tooLarge = false;
    try {
      for await (const part of req.parts()) {
        if (part.type === 'field') {
          fields[part.fieldname] ??= String(part.value);
        } else {
          if (!part.filename) { part.file.resume(); continue; }
          const tmp = join(tmpDir, `${saved.length}`);
          await streamPipeline(part.file, createWriteStream(tmp));
          if (part.file.truncated) { tooLarge = true; continue; }
          saved.push({ name: cleanName(part.filename), tmp, size: statSync(tmp).size });
        }
      }
      const title = (fields.title ?? '').trim();
      const description = (fields.description ?? '').trim().slice(0, MAX_TEXT);
      const kind = (fields.kind ?? '') as CrKind;
      const err = tooLarge ? 'Tệp đính kèm vượt quá 50MB.'
        : !title ? 'Vui lòng nhập tiêu đề thay đổi.'
        : !description ? 'Vui lòng nhập mô tả thay đổi.'
        : !KINDS.includes(kind) ? 'Loại thay đổi không hợp lệ.'
        : '';
      if (err) return back(reply, id, 'changes', err);

      let crId: string;
      try {
        const input = { title: title.slice(0, 300), description, kind, createdBy: req.user?.id ?? null };
        // Server mode passes the acting person so the engine checks the right; local mode keeps the v2 call.
        crId = (cfg.mode === 'server' ? pipeline.submitChange(id, input, req.user?.id ?? null) : pipeline.submitChange(id, input)).id;
      } catch (e) {
        if (e instanceof PermissionError) return forbidPage(cfg, req, reply, e.message);
        return back(reply, id, 'changes', msgOf(e));
      }
      // The CHANGE job runs on a later worker tick, so attaching synchronously here is visible to it.
      // inputs/ is seat-writable: the folder is created and every file written through safe-fs (no symlinked folder
      // on the way, O_NOFOLLOW, descriptor path checked), so a planted `inputs/changes` link cannot redirect the write.
      const ws = Workspace.forRequest(cfg, repo, repo.getRequest(id)!);
      const dir = join(ws.inputsDir, 'changes', crId);
      const used = new Set<string>();
      const failed: string[] = [];
      for (const s of saved) {
        const name = uniqueName(s.name, used);
        try {
          ws.ensure();
          safeMkdirp(dir, ws.trustRoot);
          const dest = join(dir, name);
          safeWriteFile(dest, readFileSync(s.tmp), ws.trustRoot);
          repo.addCrAttachment(id, crId, name, dest);
        } catch (e) {
          console.error(`CR attachment ${name} not saved`, e);
          failed.push(s.name);
        }
      }
      if (failed.length) return back(reply, id, 'changes', `Đã tạo ${crId} nhưng không lưu được tệp: ${failed.join(', ')}`);
      return reply.redirect(`/requests/${id}?tab=changes&ok=${encodeURIComponent(`Đã ghi nhận yêu cầu thay đổi ${crId}`)}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ---- per-CR actions ----
  const crAction = (name: string, need: Need, fn: (id: string, crId: string, body: Record<string, string | undefined>, req: FastifyRequest) => void, tab = 'changes') => {
    app.post(`/requests/:id/changes/:cr/${name}`, async (req, reply) => {
      const { id, cr } = req.params as { id: string; cr: string };
      const r = repo.getRequest(id);
      if (!r) return errPage(req, reply, 404, 'Không tìm thấy yêu cầu.');
      if (!allowedOnRequest(cfg, repo, req.user, r, need)) return forbidPage(cfg, req, reply);
      if (!repo.getChangeRequest(id, cr)) return errPage(req, reply, 404, 'Không tìm thấy yêu cầu thay đổi.');
      try { fn(id, cr, (req.body ?? {}) as Record<string, string | undefined>, req); } catch (e) {
        if (e instanceof Error && (e.name === 'PermissionError' || e.name === 'StaleActionError' || e instanceof PermissionError)) return forbidOrStale(req, reply, e);
        return back(reply, id, tab, msgOf(e));
      }
      if (name !== 'decide') auditWeb(repo, req, `cr.${name}`, { projectId: r.projectId, requestId: id, detail: { crId: cr } });
      return reply.redirect(`/requests/${id}?tab=${tab}`);
    });
  };
  crAction('decide', 'cr.decide', (id, cr, b, req) => {
    const decision = b.decision;
    if (decision !== 'accept' && decision !== 'reject') throw new UserError('Quyết định không hợp lệ.');
    const note = (b.note ?? '').trim().slice(0, 2000);
    if (decision === 'reject' && !note) throw new UserError('Vui lòng nhập lý do khi từ chối thay đổi.');
    const r = repo.getRequest(id)!;
    // Server mode: the form must carry the gate token it was drawn with (refuse stale or missing).
    const expect = b.expect || (cfg.mode === 'server' && r.projectId != null ? 'missing' : undefined);
    if (expect === undefined) pipeline.decideChange(id, cr, decision, note, req.user?.id ?? null);
    else pipeline.decideChange(id, cr, decision, note, req.user?.id ?? null, expect);
  }, 'overview');
  crAction('accept-proposal', 'pm', (id, cr) => { pipeline.acceptProposal(id, cr); });
  crAction('reject-proposal', 'pm', (id, cr, b, req) => {
    const note = (b.note ?? '').trim().slice(0, 2000);
    if (!note) throw new UserError('Vui lòng nhập lý do từ chối đề xuất.');
    pipeline.rejectProposal(id, cr, note, req.user?.id ?? null);
  });

  // ---- impact view ----
  app.get('/requests/:id/changes/:cr/impact', async (req, reply) => {
    const { id, cr: crId } = req.params as { id: string; cr: string };
    const r = repo.getRequest(id);
    const cr = r && repo.getChangeRequest(id, crId);
    if (!r || !cr) return errPage(req, reply, 404, 'Không tìm thấy yêu cầu thay đổi.');
    if (!allowedOnRequest(cfg, repo, req.user, r, 'read')) return forbidPage(cfg, req, reply);
    const ws = Workspace.forRequest(cfg, repo, r);
    const md = readRequestText(ws, join(changeDir(ws, crId), 'impact.md'));
    return html(reply, render('impact', layout(req, `${cr.id} - Tác động`), {
      r, cr, impact: loadImpact(ws, crId), impactHtml: md ? markdownToHtml(md) : '',
    }));
  });
}

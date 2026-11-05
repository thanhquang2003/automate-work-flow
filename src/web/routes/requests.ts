import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZipArchive } from 'archiver';
import type { Config } from '../../config.js';
import type { ProjectKind, RequestRow, RunMode, SoftwareType } from '../../domain/types.js';
import { Workspace } from '../../engine/workspace.js';
import { markdownToHtml } from '../markdown-html.js';
import { questionsTabData } from './questions.js';
import { streamEvents } from '../sse.js';
import type { WebDeps } from '../server.js';
import { render, renderPartial, type LayoutData } from '../view.js';

const SOFTWARE_TYPES: SoftwareType[] = ['web', 'mobile', 'api', 'background'];
const TABS = ['overview', 'analysis', 'questions', 'docs', 'tasks', 'tests', 'bugs'] as const;
type Tab = (typeof TABS)[number];
const INLINE_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.json': 'text/plain; charset=utf-8',
};
const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;

interface FileEntry { rel: string; size: number; mtime: number; image: boolean }

function listFiles(dir: string, base = dir): FileEntry[] {
  if (!existsSync(dir)) return [];
  const out: FileEntry[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...listFiles(p, base));
    else if (d.isFile()) {
      const st = statSync(p);
      const rel = relative(base, p).split(sep).join('/');
      out.push({ rel, size: st.size, mtime: st.mtimeMs, image: IMAGE_RE.test(rel) });
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Resolves a user-supplied relative path under `root`; undefined when it escapes. */
export function safeJoin(root: string, rel: string): string | undefined {
  if (rel.includes('\0')) return undefined;
  const base = resolve(root);
  const p = resolve(base, rel);
  return !p.startsWith(base + sep) ? undefined : p;
}

const cleanName = (n: string): string => {
  const b = basename(n.replace(/\\/g, '/')).replace(/[^\w.\- ()À-ỹ]/g, '_').replace(/^\.+/, '_');
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(b.replace(/\..*$/, '')) ? `${b}_` : b || 'file';
};

export function requestRoutes(app: FastifyInstance, cfg: Config, { repo, pipeline }: WebDeps): void {
  const layout = (req: FastifyRequest, title: string, extra: Partial<LayoutData> = {}): LayoutData => ({ user: req.user, mode: cfg.mode, title, ...extra });
  const html = (reply: FastifyReply, s: string, code = 200) => reply.code(code).type('text/html; charset=utf-8').send(s);
  const notFound = (req: FastifyRequest, reply: FastifyReply) =>
    html(reply, render('error', layout(req, 'Không tìm thấy'), { code: 404, message: 'Không tìm thấy yêu cầu.' }), 404);
  const getReq = (id: string): RequestRow | undefined => repo.getRequest(id);

  // ---- dashboard ----
  app.get('/', async (req, reply) => {
    const q = req.query as { status?: string; q?: string };
    const users = new Map(repo.listUsers().map(u => [u.id, u.username]));
    const needle = (q.q ?? '').trim().toLowerCase();
    const rows = repo.listRequests()
      .filter(r => !q.status || r.status === q.status)
      .filter(r => !needle || r.id.toLowerCase().includes(needle) || r.title.toLowerCase().includes(needle))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(r => ({ ...r, creator: r.createdBy === null ? (cfg.mode === 'local' ? 'local' : '-') : (users.get(r.createdBy) ?? '-') }));
    return html(reply, render('dashboard', layout(req, 'Yêu cầu'), { rows, filterStatus: q.status ?? '', filterQ: q.q ?? '' }));
  });

  // ---- create ----
  app.get('/requests/new', async (req, reply) => html(reply, render('request-new', layout(req, 'Tạo yêu cầu mới'), { form: {}, SOFTWARE_TYPES })));

  app.post('/requests', async (req, reply) => {
    if (!req.isMultipart()) return html(reply, render('error', layout(req, 'Lỗi'), { code: 400, message: 'Biểu mẫu phải gửi dạng multipart.' }), 400);
    const fields: Record<string, string[]> = {};
    const tmpDir = join(resolve(cfg.dataDir), 'tmp', randomBytes(8).toString('hex'));
    mkdirSync(tmpDir, { recursive: true });
    const saved: { name: string; tmp: string; size: number }[] = [];
    let tooLarge = false;
    try {
      for await (const part of req.parts()) {
        if (part.type === 'field') {
          (fields[part.fieldname] ??= []).push(String(part.value));
        } else {
          if (!part.filename) { part.file.resume(); continue; }
          const tmp = join(tmpDir, `${saved.length}`);
          await streamPipeline(part.file, createWriteStream(tmp));
          if (part.file.truncated) { tooLarge = true; continue; }
          saved.push({ name: cleanName(part.filename), tmp, size: statSync(tmp).size });
        }
      }
      const f = (k: string) => (fields[k]?.[0] ?? '').trim();
      const form = {
        title: f('title'), description: f('description'), perf_req: f('perf_req'), nonfunc_req: f('nonfunc_req'),
        project_kind: f('project_kind') || 'new', gitlab_project: f('gitlab_project'), run_mode: f('run_mode') || 'review',
        software_types: (fields.software_types ?? []).filter((t): t is SoftwareType => (SOFTWARE_TYPES as string[]).includes(t)),
      };
      const err = tooLarge ? 'Tệp đính kèm vượt quá 50MB.'
        : !form.title ? 'Vui lòng nhập tiêu đề.'
        : !form.description ? 'Vui lòng nhập mô tả yêu cầu.'
        : !['new', 'existing'].includes(form.project_kind) ? 'Loại dự án không hợp lệ.'
        : !['auto', 'review'].includes(form.run_mode) ? 'Chế độ chạy không hợp lệ.'
        : form.project_kind === 'existing' && !form.gitlab_project ? 'Vui lòng nhập GitLab project của dự án có sẵn.'
        : '';
      if (err) return html(reply, render('request-new', layout(req, 'Tạo yêu cầu mới', { flash: err, flashKind: 'error' }), { form, SOFTWARE_TYPES }), tooLarge ? 413 : 400);

      const row = repo.createRequest({
        title: form.title, description: form.description, perfReq: form.perf_req, nonfuncReq: form.nonfunc_req,
        projectKind: form.project_kind as ProjectKind, gitlabProject: form.gitlab_project || null,
        softwareTypes: form.software_types, runMode: form.run_mode as RunMode, createdBy: req.user?.id ?? null,
      });
      const ws = Workspace.for(cfg, row.id).ensure();
      const used = new Set<string>();
      for (const s of saved) {
        let name = s.name;
        for (let i = 2; used.has(name); i++) name = `${i}_${s.name}`;
        used.add(name);
        const dest = join(ws.inputsDir, name);
        renameSync(s.tmp, dest);
        repo.addAttachment(row.id, name, dest, s.size);
      }
      pipeline.start(row.id);
      return reply.redirect(`/requests/${row.id}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ---- detail ----
  app.get('/requests/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = getReq(id);
    if (!r) return notFound(req, reply);
    const q = req.query as { tab?: string; err?: string; ok?: string };
    const tab: Tab = (TABS as readonly string[]).includes(q.tab ?? '') ? (q.tab as Tab) : 'overview';
    const ws = Workspace.for(cfg, id);
    const data: Record<string, unknown> = { r, tab, TABS, attachments: repo.listAttachments(id), stageRuns: repo.listStageRuns(id) };
    if (tab === 'analysis') {
      const p = join(ws.devflowDir, 'analysis.md');
      data.analysisHtml = existsSync(p) ? markdownToHtml(readFileSync(p, 'utf8')) : '';
    } else if (tab === 'questions') {
      data.questionsHtml = renderPartial('partials/questions', questionsTabData(repo, cfg, r));
    } else if (tab === 'docs') {
      const files = listFiles(ws.artifactsDir);
      data.docs = files.filter(f => !f.rel.startsWith('evidence/'));
      data.evidence = files.filter(f => f.rel.startsWith('evidence/'));
    } else if (tab === 'tasks') {
      data.tasks = repo.listTasks(id);
      data.features = repo.listFeatures(id);
    } else if (tab === 'tests') {
      const have = new Set([...listFiles(ws.artifactsDir).map(f => f.rel), ...listFiles(ws.evidenceDir).map(f => `evidence/${f.rel}`)]);
      data.tests = repo.listTestCases(id).map(t => ({
        ...t,
        evidenceLinks: t.evidence.map(e => ({ name: e, rel: have.has(e) ? e : have.has(`evidence/${e}`) ? `evidence/${e}` : e, image: IMAGE_RE.test(e) })),
      }));
    } else if (tab === 'bugs') {
      data.bugs = repo.listBugs(id);
      data.gitlabBase = cfg.gitlab.url.replace(/\/$/, '');
    }
    const flash = q.err ?? q.ok;
    return html(reply, render('request-detail', layout(req, `${r.id} - ${r.title}`, { flash, flashKind: q.err ? 'error' : 'ok' }), data));
  });

  // ---- actions ----
  const act = (name: string, fn: (r: RequestRow, body: Record<string, string | undefined>) => void) => {
    app.post(`/requests/:id/${name}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      const r = getReq(id);
      if (!r) return notFound(req, reply);
      try {
        fn(r, (req.body ?? {}) as Record<string, string | undefined>);
      } catch (e) {
        const msg = e instanceof Error && e.name === 'PipelineBusyError'
          ? 'Bước hiện tại đang chạy, vui lòng thử lại sau khi hoàn tất.'
          : e instanceof Error ? e.message : String(e);
        return reply.redirect(`/requests/${id}?err=${encodeURIComponent(msg.slice(0, 300))}`);
      }
      return reply.redirect(`/requests/${id}`);
    });
  };
  act('approve', r => pipeline.approve(r.id));
  act('reject', (r, b) => {
    const fb = (b.feedback ?? '').trim();
    if (!fb) throw new Error('Vui lòng nhập nội dung phản hồi khi từ chối.');
    pipeline.reject(r.id, fb);
  });
  act('pause', r => pipeline.pause(r.id));
  act('resume', r => pipeline.resume(r.id));
  act('cancel', r => pipeline.cancel(r.id));
  act('rerun', r => pipeline.rerunStage(r.id, r.stage));

  // ---- SSE ----
  app.get('/requests/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getReq(id)) return notFound(req, reply);
    streamEvents(repo, req, reply, id);
  });

  // ---- files ----
  app.get('/requests/:id/files/*', async (req, reply) => {
    const { id } = req.params as { id: string };
    let rel: string;
    try { rel = decodeURIComponent((req.params as Record<string, string>)['*'] ?? ''); } catch { rel = '..'; }
    if (!getReq(id)) return notFound(req, reply);
    const ws = Workspace.for(cfg, id);
    let file = safeJoin(ws.artifactsDir, rel);
    if (file && !(existsSync(file) && statSync(file).isFile()) && rel.startsWith('evidence/')) file = safeJoin(ws.evidenceDir, rel.slice('evidence/'.length));
    if (!file) return html(reply, render('error', layout(req, 'Bị từ chối'), { code: 403, message: 'Đường dẫn không hợp lệ.' }), 403);
    if (!existsSync(file) || !statSync(file).isFile()) return notFound(req, reply);
    const inline = INLINE_TYPES[extname(file).toLowerCase()];
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    reply.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(basename(file))}`);
    return reply.type(inline ?? 'application/octet-stream').send(createReadStream(file));
  });

  app.get('/requests/:id/bundle.zip', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getReq(id)) return notFound(req, reply);
    const ws = Workspace.for(cfg, id);
    const zip = new ZipArchive({ zlib: { level: 6 } });
    zip.on('error', () => zip.abort());
    if (existsSync(ws.artifactsDir)) zip.directory(ws.artifactsDir, false);
    if (existsSync(ws.evidenceDir) && !existsSync(join(ws.artifactsDir, 'evidence'))) zip.directory(ws.evidenceDir, 'evidence');
    void zip.finalize();
    reply.header('Content-Disposition', `attachment; filename="${id}-ketqua.zip"`);
    return reply.type('application/zip').send(zip);
  });
}

import { closeSync, createWriteStream, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, extname, join, resolve, sep } from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZipArchive } from 'archiver';
import type { Config } from '../../config.js';
import type { BugRow, ProjectKind, RequestRow, RunMode, SoftwareType } from '../../domain/types.js';
import { STAGES } from '../../domain/types.js';
import { loadImpact } from '../../engine/changes.js';
import { changeDir, readFlowState, readProjectInfo } from '../../engine/stages/common.js';
import { FileTooLargeError, SafeFileStream, safeListTree, safeOpenRead, safeReadText, safeStatFile, safeWriteFile, UnsafePathError } from '../../engine/safe-fs.js';
import { Workspace } from '../../engine/workspace.js';
import { attachmentName, uniqueName } from '../../engine/stages/intake.js';
import { StaleActionError } from '../../engine/pipeline.js';
import { PermissionError } from '../../projects/service.js';
import { PROJECT_ROLES, type ProjectRole } from '../../domain/types.js';
import { GATE_APPROVER } from '../../security/permissions.js';
import { actorOf, allowedOnRequest, auditWeb, forbidPage, type Need } from '../authz.js';
import { buildInbox } from '../inbox.js';
import { markdownToHtml } from '../markdown-html.js';
import { questionsTabData } from './questions.js';
import { streamEvents } from '../sse.js';
import type { WebDeps } from '../server.js';
import { render, renderPartial, type LayoutData } from '../view.js';

const SOFTWARE_TYPES: SoftwareType[] = ['web', 'mobile', 'api', 'background'];
const TABS = ['overview', 'analysis', 'questions', 'docs', 'tasks', 'tests', 'bugs', 'changes', 'scope'] as const;
type Tab = (typeof TABS)[number];
const INLINE_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.json': 'text/plain; charset=utf-8',
};
const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;

interface FileEntry { rel: string; size: number; mtime: number; image: boolean }

const httpUrl = (u: unknown): string | undefined => (typeof u === 'string' && /^https?:\/\/[^\s"'<>]+$/i.test(u) ? u : undefined);

/**
 * Bug rows with their GitLab issue link: the issue URL GitLab returned (flow-state), else the project web URL
 * recorded at INTAKE + /-/issues/<iid>. Unreadable state files just mean "no link".
 */
function bugsWithLinks(ws: Workspace, bugs: BugRow[]): (BugRow & { issueUrl?: string })[] {
  let urls: Record<string, unknown> = {};
  let webUrl: string | undefined;
  try { urls = readFlowState(ws).issueUrls ?? {}; } catch { /* corrupt flow-state: no links */ }
  try { webUrl = httpUrl(readProjectInfo(ws)?.webUrl)?.replace(/\/+$/, ''); } catch { /* no project info */ }
  return bugs.map(b => {
    const issueUrl = httpUrl(urls[b.tcId]) ?? (b.gitlabIid && webUrl ? `${webUrl}/-/issues/${b.gitlabIid}` : undefined);
    return issueUrl ? { ...b, issueUrl } : b;
  });
}

/**
 * Regular files under a request folder a seat can write (artifacts/, evidence/). Read through safe-fs: symlinks and
 * special files are left out, a symlinked folder on the way (or the folder itself) gives an empty list.
 */
function listFiles(ws: Workspace, dir: string): FileEntry[] {
  try {
    return safeListTree(dir, ws.trustRoot).map(e => ({ rel: e.rel, size: e.size, mtime: e.mtimeMs, image: IMAGE_RE.test(e.rel) }));
  } catch (e) {
    if (e instanceof UnsafePathError || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return [];
    throw e;
  }
}

/**
 * Text of a file in a seat-writable request folder (analysis.md, impact.md) through safe-fs; '' when it is missing or
 * unsafe (symlink anywhere on the way, FIFO, device...). Never follows a planted link.
 */
/** Largest markdown/JSON file the request pages render (a seat could plant a sparse multi-GB file). */
export const MAX_PAGE_TEXT = 2 * 1024 * 1024;
/** Largest total of artifacts + evidence put into bundle.zip. */
export const MAX_BUNDLE_BYTES = 200 * 1024 * 1024;

export function readRequestText(ws: Workspace, path: string, maxBytes = MAX_PAGE_TEXT): string {
  try {
    return safeReadText(path, ws.trustRoot, { maxBytes });
  } catch (e) {
    if (e instanceof FileTooLargeError) return `> Tệp quá lớn để hiển thị (${(e.size / 1048576).toFixed(1)} MB, tối đa ${(maxBytes / 1048576).toFixed(0)} MB).`;
    if (e instanceof UnsafePathError) { console.warn(`refused to read ${path}: ${e.message}`); return ''; }
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return '';
    throw e;
  }
}

/** Resolves a user-supplied relative path under `root`; undefined when it escapes. */
export function safeJoin(root: string, rel: string): string | undefined {
  if (rel.includes('\0')) return undefined;
  const base = resolve(root);
  const p = resolve(base, rel);
  return !p.startsWith(base + sep) ? undefined : p;
}

/** Name an upload gets in inputs/: the same function the INTAKE/CHANGE stages use (they must agree). */
export const cleanName = attachmentName;

const OPEN_CR = new Set(['proposed', 'pending', 'analyzing', 'awaiting_decision']);

/** Artifacts grouped by `_v<N>` suffix (unsuffixed = v1), newest version first. */
export function groupByVersion(files: FileEntry[]): { version: number; files: FileEntry[] }[] {
  const m = new Map<number, FileEntry[]>();
  for (const f of files) {
    const v = Number(/_v(\d+)\.[^./]+$/.exec(f.rel)?.[1] ?? 1);
    (m.get(v) ?? m.set(v, []).get(v)!).push(f);
  }
  return [...m].sort((a, b) => b[0] - a[0]).map(([version, fs]) => ({ version, files: fs }));
}

export function requestRoutes(app: FastifyInstance, cfg: Config, { repo, pipeline, projects }: WebDeps): void {
  const layout = (req: FastifyRequest, title: string, extra: Partial<LayoutData> = {}): LayoutData => ({ user: req.user, mode: cfg.mode, title, ...extra });
  const html = (reply: FastifyReply, s: string, code = 200) => reply.code(code).type('text/html; charset=utf-8').send(s);
  const notFound = (req: FastifyRequest, reply: FastifyReply) =>
    html(reply, render('error', layout(req, 'Không tìm thấy'), { code: 404, message: 'Không tìm thấy yêu cầu.' }), 404);
  const getReq = (id: string): RequestRow | undefined => repo.getRequest(id);
  const ok = (req: FastifyRequest, r: RequestRow, need: Need): boolean => allowedOnRequest(cfg, repo, req.user, r, need);
  const server = cfg.mode === 'server';
  /** Server mode with Google sign-in: requests belong to projects; the v2 "create without project" form is closed. */
  const projectOnly = server && cfg.google.clientId !== '';

  // ---- dashboard ----
  const dashboard = async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as { status?: string; q?: string };
    const users = new Map(repo.web.listUsers().map(u => [u.id, u.username]));
    const needle = (q.q ?? '').trim().toLowerCase();
    const rows = repo.listRequests()
      .filter(r => ok(req, r, 'read'))
      .filter(r => !q.status || r.status === q.status)
      .filter(r => !needle || r.id.toLowerCase().includes(needle) || r.title.toLowerCase().includes(needle))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(r => ({ ...r, openCrs: repo.listChangeRequests(r.id).filter(c => OPEN_CR.has(c.status)).length, creator: r.createdBy === null ? (cfg.mode === 'local' ? 'local' : '-') : (users.get(r.createdBy) ?? '-') }));
    return html(reply, render('dashboard', layout(req, 'Yêu cầu'), { rows, filterStatus: q.status ?? '', filterQ: q.q ?? '' }));
  };
  // Server mode: home is "Việc của tôi"; the full list is /requests. Local mode keeps the v2 dashboard at /.
  app.get('/', async (req, reply) => {
    if (projectOnly && req.user?.id != null) {
      const u = repo.web.getUser(req.user.id);
      return html(reply, render('inbox', layout(req, 'Việc của tôi'), { inbox: buildInbox(repo, req.user.id), canCreate: !!u?.canBePm && u.departmentId !== null }));
    }
    return dashboard(req, reply);
  });
  app.get('/requests', dashboard);

  // ---- create ----
  app.get('/requests/new', async (req, reply) => projectOnly ? reply.redirect('/projects') : html(reply, render('request-new', layout(req, 'Tạo yêu cầu mới'), { form: {}, SOFTWARE_TYPES })));

  app.post('/requests', async (req, reply) => {
    if (projectOnly) return forbidPage(cfg, req, reply, 'Hãy tạo yêu cầu từ trang của dự án.');
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
        const name = uniqueName(s.name, used);
        const dest = join(ws.inputsDir, name);
        safeWriteFile(dest, readFileSync(s.tmp), ws.trustRoot);
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
    if (!ok(req, r, 'read')) return forbidPage(cfg, req, reply, 'Bạn không phải thành viên của dự án này.');
    const q = req.query as { tab?: string; err?: string; ok?: string };
    const tab: Tab = (TABS as readonly string[]).includes(q.tab ?? '') ? (q.tab as Tab) : 'overview';
    const ws = Workspace.forRequest(cfg, repo, r);
    const data: Record<string, unknown> = { r, tab, TABS, attachments: repo.listAttachments(id), stageRuns: repo.listStageRuns(id) };
    if (tab === 'analysis') {
      const md = readRequestText(ws, join(ws.devflowDir, 'analysis.md'));
      data.analysisHtml = md ? markdownToHtml(md) : '';
    } else if (tab === 'questions') {
      data.questionsHtml = renderPartial('partials/questions', questionsTabData(repo, cfg, r));
    } else if (tab === 'docs') {
      const files = listFiles(ws, ws.artifactsDir);
      data.docs = files.filter(f => !f.rel.startsWith('evidence/'));
      data.docGroups = groupByVersion(data.docs as FileEntry[]);
      data.evidence = files.filter(f => f.rel.startsWith('evidence/'));
    } else if (tab === 'tasks') {
      data.tasks = repo.listTasks(id);
      data.features = repo.listFeatures(id);
    } else if (tab === 'tests') {
      const have = new Set([...listFiles(ws, ws.artifactsDir).map(f => f.rel), ...listFiles(ws, ws.evidenceDir).map(f => `evidence/${f.rel}`)]);
      data.tests = repo.listTestCases(id).map(t => ({
        ...t,
        evidenceLinks: t.evidence.map(e => ({ name: e, rel: have.has(e) ? e : have.has(`evidence/${e}`) ? `evidence/${e}` : e, image: IMAGE_RE.test(e) })),
      }));
    } else if (tab === 'bugs') {
      data.bugs = bugsWithLinks(ws, repo.listBugs(id));
    }
    const crs = repo.listChangeRequests(id);
    data.crs = crs;
    data.canChange = r.status !== 'cancelled';
    data.decisions = [];
    if (r.stage === 'CHANGE' && r.status === 'awaiting_approval') {
      data.decisions = crs.filter(c => c.status === 'awaiting_decision').map(cr => {
        const md = readRequestText(ws, join(changeDir(ws, cr.id), 'impact.md'));
        return { cr, impact: loadImpact(ws, cr.id), impactHtml: md ? markdownToHtml(md) : '' };
      });
    }
    // Stepper: CHANGE is not a normal step; while in CHANGE the position of the interrupted stage is shown.
    const steps = STAGES.filter(s => s !== 'CHANGE');
    const at = r.stage === 'CHANGE' ? (crs.find(c => c.interruptedStage && OPEN_CR.has(c.status))?.interruptedStage ?? null) : r.stage;
    data.steps = steps;
    data.stepIdx = at === null ? -1 : steps.indexOf(at as (typeof steps)[number]);
    if (tab === 'changes') {
      const feats = new Map(repo.listFeatures(id).map(f => [f.id, f]));
      data.crRows = crs.map(c => ({ ...c, attachments: repo.listCrAttachments(id, c.id), hasImpact: safeStatFile(join(changeDir(ws, c.id), 'impact.md'), ws.trustRoot) !== undefined }));
      const pm = /^(remove|modify):(F-[\w-]+)$/.exec((q as { prefill?: string }).prefill ?? '');
      const pf = pm && feats.get(pm[2]!);
      data.prefill = pf
        ? { kind: pm[1], title: `${pm[1] === 'remove' ? 'Bỏ khỏi phạm vi' : 'Sửa'} chức năng ${pf.id} - ${pf.name}`, description: '' }
        : { kind: 'add', title: '', description: '' };
    } else if (tab === 'scope') {
      data.features = repo.listFeatures(id);
    }
    // Rights drive which buttons exist; the POST routes check again.
    const gateStage = { type: 'gate.approve' as const, stage: r.stage };
    data.gateToken = pipeline.gateToken(r);
    data.canApprove = ok(req, r, gateStage) && (!server || r.projectId == null || Object.hasOwn(GATE_APPROVER, r.stage));
    data.canPm = ok(req, r, 'pm');
    data.canDecide = ok(req, r, 'cr.decide');
    data.isProject = r.projectId != null;
    data.planningParts = r.stage === 'PLANNING';
    data.tokenRequired = server && r.projectId != null;
    if (r.projectId != null) {
      const project = repo.getProject(r.projectId)!;
      const actor = actorOf(repo, req.user, r.projectId);
      const name = (id: number) => { const u = repo.web.getUser(id); return u ? (u.displayName || u.email || u.username) : `#${id}`; };
      const members = repo.listProjectMembers(project.id);
      data.project = project;
      data.assigneeBlocks = PROJECT_ROLES.map(role => {
        const list = repo.listRequestAssignees(r.id, role).map(a => ({ id: a.userId, name: name(a.userId) }));
        const inList = new Set(list.map(x => x.id));
        return { role, list, candidates: members.filter(m => m.roles.includes(role) && !inList.has(m.userId)).map(m => ({ id: m.userId, name: name(m.userId) })) };
      });
      data.devs = members.filter(m => m.roles.includes('DEV')).map(m => ({ id: m.userId, name: name(m.userId) }));
      data.userNames = Object.fromEntries(members.map(m => [m.userId, name(m.userId)]));
      data.canEditTasks = data.canPm === true || (!!actor && repo.getRunner(r.id, 'DEV') === actor.userId);
      data.jobs = repo.listJobs(r.id).filter(j => j.status === 'queued' || j.status === 'running' || j.status === 'paused');
    } else {
      data.canEditTasks = false;
    }
    const flash = q.err ?? q.ok;
    return html(reply, render('request-detail', layout(req, `${r.id} - ${r.title}`, { flash, flashKind: q.err ? 'error' : 'ok' }), data));
  });

  // ---- actions ----
  const fail = (req: FastifyRequest, reply: FastifyReply, e: unknown, id: string) => {
    if (e instanceof PermissionError) return forbidPage(cfg, req, reply, e.message);
    if (e instanceof Error && e.name === 'StaleActionError') return html(reply, render('error', layout(req, 'Trang đã cũ'), { code: 409, message: e.message }), 409);
    const msg = e instanceof Error && e.name === 'PipelineBusyError'
      ? 'Bước hiện tại đang chạy, vui lòng thử lại sau khi hoàn tất.'
      : e instanceof Error ? e.message : String(e);
    return reply.redirect(`/requests/${id}?err=${encodeURIComponent(msg.slice(0, 300))}`);
  };
  type Body = Record<string, string | undefined>;
  /** The page must send the gate token in server mode: a missing token is as stale as a wrong one. */
  const tokenOf = (r: RequestRow, b: Body): string | undefined => {
    if (b.expect) return b.expect;
    if (server && r.projectId != null) return 'missing';
    return undefined;
  };
  const act = (name: string, need: (r: RequestRow) => Need, fn: (r: RequestRow, body: Body, userId: number | null) => void | Promise<void>, audit = true) => {
    app.post(`/requests/:id/${name}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      const r = getReq(id);
      if (!r) return notFound(req, reply);
      if (!ok(req, r, need(r))) return forbidPage(cfg, req, reply);
      try {
        await fn(r, (req.body ?? {}) as Body, req.user?.id ?? null);
      } catch (e) {
        return fail(req, reply, e, id);
      }
      if (audit) auditWeb(repo, req, `request.${name}`, { projectId: r.projectId, requestId: r.id });
      return reply.redirect(`/requests/${id}`);
    });
  };
  act('approve', r => ({ type: 'gate.approve', stage: r.stage }), (r, b, uid) => pipeline.approve(r.id, uid, b.part || undefined, tokenOf(r, b)), false);
  act('reject', r => ({ type: 'gate.approve', stage: r.stage }), (r, b, uid) => {
    const fb = (b.feedback ?? '').trim();
    if (!fb) throw new Error('Vui lòng nhập nội dung phản hồi khi từ chối.');
    pipeline.reject(r.id, fb, uid, b.part || undefined, tokenOf(r, b));
  }, false);
  act('pause', () => 'pm', r => pipeline.pause(r.id));
  act('resume', () => 'pm', r => pipeline.resume(r.id));
  act('cancel', () => 'pm', r => pipeline.cancel(r.id));
  act('rerun', () => 'pm', r => pipeline.rerunStage(r.id, r.stage));

  // ---- who is in charge (v3): ordered people per role; the first one runs the role's Claude calls ----
  const roleOf = (v: string | undefined): ProjectRole => {
    if (!(PROJECT_ROLES as readonly string[]).includes(v ?? '')) throw new Error('Vai trò không hợp lệ.');
    return v as ProjectRole;
  };
  act('assignees', () => 'pm', async (r, b, uid) => {
    if (r.projectId == null || !projects || uid === null) throw new Error('Yêu cầu này không thuộc dự án.');
    const role = roleOf(b.role);
    const target = Number(b.user);
    const cur = repo.listRequestAssignees(r.id, role).map(a => a.userId);
    if (!Number.isInteger(target) || target <= 0) throw new Error('Người dùng không hợp lệ.');
    // Stale-click token: the page states who was first (runner) when it was drawn; server mode requires it.
    if (server && b.expect_runner === undefined) throw new StaleActionError();
    const expected = b.expect_runner === undefined ? undefined : b.expect_runner === '' ? null : Number(b.expect_runner);
    if (expected !== undefined && (cur[0] ?? null) !== expected) throw new StaleActionError();
    if (b.op === 'first') {
      // The runner changes: the pipeline moves a running job of that role onto the new seat and awaits the stop.
      await pipeline.setRunner(r.id, role, target, uid, expected);
      return;
    }
    const i = cur.indexOf(target);
    let next = cur;
    if (b.op === 'add') next = i >= 0 ? cur : [...cur, target];
    else if (b.op === 'remove') next = cur.filter(x => x !== target);
    else if (b.op === 'up' && i > 0) next = cur.map((x, k) => (k === i - 1 ? target : k === i ? cur[i - 1]! : x));
    else if (b.op === 'down' && i >= 0 && i < cur.length - 1) next = cur.map((x, k) => (k === i + 1 ? target : k === i ? cur[i + 1]! : x));
    else if (!['add', 'remove', 'up', 'down'].includes(b.op ?? '')) throw new Error('Thao tác không hợp lệ.');
    // Persists, tells the engine and waits for a run stopped because the runner changed.
    await projects.setAssignees(r.id, role, next, uid);
  }, false);

  app.post('/requests/:id/tasks/:task/assign', async (req, reply) => {
    const { id, task } = req.params as { id: string; task: string };
    const r = getReq(id);
    if (!r) return notFound(req, reply);
    const actor = actorOf(repo, req.user, r.projectId);
    // PM or the first DEV of the request; the pipeline checks the same rule again.
    if (server && !(ok(req, r, 'pm') || (actor && repo.getRunner(r.id, 'DEV') === actor.userId))) return forbidPage(cfg, req, reply);
    const b = (req.body ?? {}) as Body;
    const who = b.user ? Number(b.user) : null;
    try {
      await pipeline.assignTask(r.id, task, who !== null && Number.isInteger(who) ? who : null, req.user?.id ?? null);
    } catch (e) { return fail(req, reply, e, id); }
    return reply.redirect(`/requests/${id}?tab=tasks`);
  });

  // ---- SSE ----
  app.get('/requests/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r0 = getReq(id);
    if (!r0) return notFound(req, reply);
    if (!ok(req, r0, 'read')) return forbidPage(cfg, req, reply);
    streamEvents(repo, req, reply, id);
  });

  // ---- files ----
  app.get('/requests/:id/files/*', async (req, reply) => {
    const { id } = req.params as { id: string };
    // Fastify already percent-decoded the wildcard; decoding again would break names containing '%'.
    const rel = (req.params as Record<string, string>)['*'] ?? '';
    if (!getReq(id)) return notFound(req, reply);
    if (!ok(req, getReq(id)!, 'read')) return forbidPage(cfg, req, reply);
    const ws = Workspace.forRequest(cfg, repo, getReq(id)!);
    const denied = () => html(reply, render('error', layout(req, 'Bị từ chối'), { code: 403, message: 'Đường dẫn không hợp lệ.' }), 403);
    // Lexical check first (no ../), then every open goes through safe-fs: no symlink at any component below the
    // request root, O_NOFOLLOW|O_NONBLOCK, regular files only. A seat-planted link or FIFO gets 403, never its target.
    const cands: string[] = [];
    const a = safeJoin(ws.artifactsDir, rel);
    if (a) cands.push(a);
    if (rel.startsWith('evidence/')) { const e = safeJoin(ws.evidenceDir, rel.slice('evidence/'.length)); if (e) cands.push(e); }
    if (!cands.length) return denied();
    let opened: { fd: number; file: string } | undefined;
    let unsafe = false;
    for (const file of cands) {
      try {
        opened = { fd: safeOpenRead(file, ws.trustRoot).fd, file };
        break;
      } catch (e) {
        if (e instanceof UnsafePathError) { unsafe = true; continue; }
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') continue;
        throw e;
      }
    }
    if (!opened) return unsafe ? denied() : notFound(req, reply);
    const { fd, file } = opened;
    try {
      const inline = INLINE_TYPES[extname(file).toLowerCase()];
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      reply.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(basename(file))}`);
      return reply.type(inline ?? 'application/octet-stream').send(new SafeFileStream(file, ws.trustRoot, fd));
    } catch (e) {
      closeSync(fd);
      throw e;
    }
  });

  app.get('/requests/:id/bundle.zip', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getReq(id)) return notFound(req, reply);
    if (!ok(req, getReq(id)!, 'read')) return forbidPage(cfg, req, reply);
    const ws = Workspace.forRequest(cfg, repo, getReq(id)!);
    const zip = new ZipArchive({ zlib: { level: 6 } });
    zip.on('error', () => zip.abort());
    // Built from a safe-fs listing, each entry read through safe-fs (never zip.directory, which follows links) and
    // never past the size it was listed with; the whole bundle has a size cap.
    const arts = listFiles(ws, ws.artifactsDir);
    const entries = arts.map(f => ({ path: join(ws.artifactsDir, ...f.rel.split('/')), name: f.rel, size: f.size }));
    if (!arts.some(f => f.rel.startsWith('evidence/'))) {
      for (const f of listFiles(ws, ws.evidenceDir)) entries.push({ path: join(ws.evidenceDir, ...f.rel.split('/')), name: `evidence/${f.rel}`, size: f.size });
    }
    const total = entries.reduce((n, e) => n + e.size, 0);
    if (total > MAX_BUNDLE_BYTES) {
      zip.abort();
      return html(reply, render('error', layout(req, 'Gói kết quả quá lớn'), { code: 413, message: `Gói kết quả quá lớn (${(total / 1048576).toFixed(0)} MB, tối đa ${MAX_BUNDLE_BYTES / 1048576} MB). Hãy tải từng tệp ở tab Tài liệu.` }), 413);
    }
    for (const e of entries) zip.append(new SafeFileStream(e.path, ws.trustRoot, undefined, e.size), { name: e.name });
    void zip.finalize();
    reply.header('Content-Disposition', `attachment; filename="${id}-ketqua.zip"`);
    return reply.type('application/zip').send(zip);
  });
}

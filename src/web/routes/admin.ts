import { mkdirSync, renameSync, rmSync, createReadStream, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import JSZip from 'jszip';
import type { Config } from '../../config.js';
import type { UserRole } from '../../domain/types.js';
import { templatePath, type TemplateKind } from '../../office/templates.js';
import { encrypt, hashPassword } from '../../security/crypto.js';
import { getSecretKey } from '../../security/secret.js';
import { applySettings, SETTING_KEYS } from '../../settings.js';
import type { WebDeps } from '../server.js';
import { render, type LayoutData } from '../view.js';

export const TEMPLATE_KINDS: { kind: TemplateKind; label: string; ext: 'docx' | 'xlsx'; marker: string }[] = [
  { kind: 'tkct', label: 'Thiết kế chi tiết (TKCT)', ext: 'docx', marker: 'word/document.xml' },
  { kind: 'tkdb', label: 'Thiết kế cơ sở dữ liệu (TKDB)', ext: 'docx', marker: 'word/document.xml' },
  { kind: 'testcase', label: 'Test case', ext: 'xlsx', marker: 'xl/workbook.xml' },
  { kind: 'ulnl', label: 'Ước lượng nguồn lực (ULNL)', ext: 'xlsx', marker: 'xl/workbook.xml' },
];
const USERNAME_RE = /^[\w.@-]{3,64}$/;
const MIN_PASSWORD = 8;

type Form = Record<string, string | undefined>;

export function adminRoutes(app: FastifyInstance, cfg: Config, { repo }: WebDeps): void {
  const server = cfg.mode === 'server';
  const layout = (req: FastifyRequest, title: string, extra: Partial<LayoutData> = {}): LayoutData => ({ user: req.user, mode: cfg.mode, title, ...extra });
  const html = (reply: FastifyReply, s: string, code = 200) => reply.code(code).type('text/html; charset=utf-8').send(s);
  const isAdmin = (req: FastifyRequest): boolean => !server || req.user?.role === 'admin';
  const forbid = (req: FastifyRequest, reply: FastifyReply) =>
    html(reply, render('error', layout(req, 'Bị từ chối'), { code: 403, message: 'Bạn không có quyền truy cập chức năng này.' }), 403);
  const flashOf = (req: FastifyRequest): Partial<LayoutData> => {
    const q = req.query as { ok?: string; err?: string };
    return { flash: q.err ?? q.ok, flashKind: q.err ? 'error' : 'ok' };
  };
  const go = (reply: FastifyReply, path: string, kind: 'ok' | 'err', msg: string) => reply.redirect(`${path}?${kind}=${encodeURIComponent(msg.slice(0, 300))}`);

  // ---- templates ----
  const tplDir = join(cfg.dataDir, 'templates');
  const kindOf = (k: string) => TEMPLATE_KINDS.find(t => t.kind === k);

  app.get('/templates', async (req, reply) => {
    const rows = TEMPLATE_KINDS.map(t => {
      const p = templatePath(cfg, t.kind);
      return { ...t, custom: p.startsWith(tplDir), file: basename(p) };
    });
    return html(reply, render('templates', layout(req, 'Mẫu tài liệu', flashOf(req)), { rows, canEdit: isAdmin(req) }));
  });

  app.get('/templates/:kind/download', async (req, reply) => {
    const t = kindOf((req.params as { kind: string }).kind);
    if (!t) return reply.callNotFound();
    const p = templatePath(cfg, t.kind);
    reply.header('Content-Disposition', `attachment; filename="${t.kind}.${t.ext}"`);
    return reply.type('application/octet-stream').send(createReadStream(p));
  });

  app.post('/templates/:kind', async (req, reply) => {
    const t = kindOf((req.params as { kind: string }).kind);
    if (!t) return reply.callNotFound();
    if (!isAdmin(req)) return forbid(req, reply);
    if (!req.isMultipart()) return go(reply, '/templates', 'err', 'Biểu mẫu phải gửi dạng multipart.');
    const part = await req.file();
    if (!part || !part.filename) return go(reply, '/templates', 'err', 'Vui lòng chọn file mẫu.');
    const buf = await part.toBuffer();
    if (extname(part.filename).toLowerCase() !== `.${t.ext}`) return go(reply, '/templates', 'err', `Mẫu ${t.kind.toUpperCase()} phải là file .${t.ext}.`);
    try {
      const zip = await JSZip.loadAsync(buf);
      if (!zip.file(t.marker)) throw new Error('marker');
    } catch {
      return go(reply, '/templates', 'err', `File không phải tài liệu Office hợp lệ (thiếu ${t.marker}).`);
    }
    mkdirSync(tplDir, { recursive: true });
    const dest = join(tplDir, `${t.kind}.${t.ext}`);
    const tmp = `${dest}.${process.pid}.tmp`;
    writeFileSync(tmp, buf);
    renameSync(tmp, dest);
    repo.web.setTemplate(t.kind, dest);
    return go(reply, '/templates', 'ok', `Đã cập nhật mẫu ${t.kind.toUpperCase()}.`);
  });

  app.post('/templates/:kind/reset', async (req, reply) => {
    const t = kindOf((req.params as { kind: string }).kind);
    if (!t) return reply.callNotFound();
    if (!isAdmin(req)) return forbid(req, reply);
    rmSync(join(tplDir, `${t.kind}.${t.ext}`), { force: true });
    repo.web.deleteTemplate(t.kind);
    return go(reply, '/templates', 'ok', `Đã khôi phục mẫu mặc định cho ${t.kind.toUpperCase()}.`);
  });

  // ---- settings ----
  app.get('/settings', async (req, reply) => {
    if (!isAdmin(req)) return forbid(req, reply);
    const g = (k: string) => repo.web.getSetting(k) ?? '';
    const values = {
      gitlabUrl: g(SETTING_KEYS.gitlabUrl) || cfg.gitlab.url, gitlabDefaultGroup: g(SETTING_KEYS.gitlabDefaultGroup) || cfg.gitlab.defaultGroup,
      maxConcurrentJobs: g(SETTING_KEYS.maxConcurrentJobs) || String(cfg.maxConcurrentJobs),
    };
    return html(reply, render('settings', layout(req, 'Cài đặt', flashOf(req)), { values, tokenSet: g(SETTING_KEYS.gitlabToken) !== '' || cfg.gitlab.token !== '' }));
  });

  app.post('/settings', async (req, reply) => {
    if (!isAdmin(req)) return forbid(req, reply);
    const b = (req.body ?? {}) as Form;
    const t = (k: string) => (b[k] ?? '').trim();
    const jobs = t('max_concurrent_jobs');
    if (jobs !== '' && !(/^\d+$/.test(jobs) && Number(jobs) >= 1 && Number(jobs) <= 32)) return go(reply, '/settings', 'err', 'Số job đồng thời phải là số nguyên từ 1 đến 32.');
    const url = t('gitlab_url');
    if (url && !/^https?:\/\/\S+$/i.test(url)) return go(reply, '/settings', 'err', 'GitLab URL phải bắt đầu bằng http:// hoặc https://.');
    repo.tx(() => {
      repo.web.setSetting(SETTING_KEYS.gitlabUrl, url);
      repo.web.setSetting(SETTING_KEYS.gitlabDefaultGroup, t('gitlab_default_group'));
      repo.web.setSetting(SETTING_KEYS.maxConcurrentJobs, jobs);
      if (b.clear_token) repo.web.setSetting(SETTING_KEYS.gitlabToken, '');
      else if (t('gitlab_token')) repo.web.setSetting(SETTING_KEYS.gitlabToken, encrypt(t('gitlab_token'), getSecretKey(cfg)));
    });
    applySettings(cfg, repo);
    return go(reply, '/settings', 'ok', 'Đã lưu cài đặt.');
  });

  // ---- users (server mode, admin only) ----
  if (server) {
    app.get('/users', async (req, reply) => {
      if (!isAdmin(req)) return forbid(req, reply);
      const users = repo.web.listUsers().map(u => ({ id: u.id, username: u.username, role: u.role, createdAt: u.createdAt, hasToken: u.gitlabTokenEnc !== null }));
      return html(reply, render('users', layout(req, 'Người dùng', flashOf(req)), { users, selfId: req.user?.id ?? null }));
    });

    app.post('/users', async (req, reply) => {
      if (!isAdmin(req)) return forbid(req, reply);
      const b = (req.body ?? {}) as Form;
      const username = (b.username ?? '').trim();
      const password = b.password ?? '';
      const role: UserRole = b.role === 'admin' ? 'admin' : 'member';
      if (!USERNAME_RE.test(username)) return go(reply, '/users', 'err', 'Tên đăng nhập 3-64 ký tự (chữ, số, . _ - @).');
      if (password.length < MIN_PASSWORD) return go(reply, '/users', 'err', `Mật khẩu tối thiểu ${MIN_PASSWORD} ký tự.`);
      if (repo.web.getUserByUsername(username)) return go(reply, '/users', 'err', 'Tên đăng nhập đã tồn tại.');
      repo.web.createUser({ username, passwordHash: hashPassword(password), role });
      return go(reply, '/users', 'ok', `Đã tạo người dùng ${username}.`);
    });

    app.post('/users/:id/password', async (req, reply) => {
      if (!isAdmin(req)) return forbid(req, reply);
      const id = Number((req.params as { id: string }).id);
      const password = ((req.body ?? {}) as Form).password ?? '';
      if (!repo.web.getUser(id)) return go(reply, '/users', 'err', 'Không tìm thấy người dùng.');
      if (password.length < MIN_PASSWORD) return go(reply, '/users', 'err', `Mật khẩu tối thiểu ${MIN_PASSWORD} ký tự.`);
      repo.web.setUserPassword(id, hashPassword(password));
      return go(reply, '/users', 'ok', 'Đã đặt lại mật khẩu.');
    });

    app.post('/users/:id/delete', async (req, reply) => {
      if (!isAdmin(req)) return forbid(req, reply);
      const id = Number((req.params as { id: string }).id);
      const u = repo.web.getUser(id);
      if (!u) return go(reply, '/users', 'err', 'Không tìm thấy người dùng.');
      if (req.user?.id === id) return go(reply, '/users', 'err', 'Không thể tự xóa tài khoản đang đăng nhập.');
      if (u.role === 'admin' && repo.web.listUsers().filter(x => x.role === 'admin').length <= 1) return go(reply, '/users', 'err', 'Không thể xóa quản trị viên cuối cùng.');
      repo.web.deleteUser(id);
      return go(reply, '/users', 'ok', `Đã xóa người dùng ${u.username}.`);
    });
  }

  // ---- /me: own GitLab token ----
  app.get('/me', async (req, reply) => {
    const u = req.user?.id != null ? repo.web.getUser(req.user.id) : undefined;
    return html(reply, render('me', layout(req, 'Tài khoản', flashOf(req)), { tokenSet: !!u?.gitlabTokenEnc, canSet: !!u }));
  });

  app.post('/me', async (req, reply) => {
    const u = req.user?.id != null ? repo.web.getUser(req.user.id) : undefined;
    if (!u) return go(reply, '/me', 'err', 'Chế độ local không có tài khoản riêng; hãy dùng trang Cài đặt.');
    const b = (req.body ?? {}) as Form;
    const tok = (b.gitlab_token ?? '').trim();
    if (b.clear_token) repo.web.setUserGitlabToken(u.id, null);
    else if (tok) repo.web.setUserGitlabToken(u.id, encrypt(tok, getSecretKey(cfg)));
    else return go(reply, '/me', 'err', 'Vui lòng nhập token.');
    return go(reply, '/me', 'ok', 'Đã lưu token GitLab cá nhân.');
  });
}

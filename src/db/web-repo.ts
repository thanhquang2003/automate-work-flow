import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { AuditRow, DepartmentCode, DepartmentRow, SurveyLinkRow, SysRole, UserRole, UserRow } from '../domain/types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const toUser = (r: Row): UserRow => ({
  id: r.id, username: r.username, passwordHash: r.password_hash, role: r.role, gitlabTokenEnc: r.gitlab_token_enc ?? null, createdAt: r.created_at,
  email: r.email ?? null, googleSub: r.google_sub ?? null, displayName: r.display_name ?? '', sysRole: r.sys_role ?? 'member',
  departmentId: r.department_id ?? null, canBePm: !!r.can_be_pm, osUser: r.os_user ?? null, disabled: !!r.disabled,
});
const toDept = (r: Row): DepartmentRow => ({ id: r.id, code: r.code, name: r.name });
const toAudit = (r: Row): AuditRow => ({
  id: r.id, projectId: r.project_id ?? null, requestId: r.request_id ?? null, userId: r.user_id ?? null, action: r.action, detail: r.detail, at: r.at,
});
const toSurvey = (r: Row): SurveyLinkRow => ({
  token: r.token, requestId: r.request_id, round: r.round, expiresAt: r.expires_at, submittedAt: r.submitted_at ?? null,
});

/** Storage used by the web layer rather than the pipeline: survey links, users, settings, templates. */
export class WebRepo {
  constructor(private readonly db: DatabaseSync) {}

  private all(sql: string, ...p: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...p) as Row[]; }
  private one(sql: string, ...p: SQLInputValue[]): Row | undefined { return this.db.prepare(sql).get(...p) as Row | undefined; }
  private run(sql: string, ...p: SQLInputValue[]) { return this.db.prepare(sql).run(...p); }

  // ---- survey links ----
  createSurveyLink(l: { token: string; requestId: string; round: number; expiresAt: number }): void {
    this.run('insert into survey_links(token,request_id,round,expires_at) values(?,?,?,?)', l.token, l.requestId, l.round, l.expiresAt);
  }
  getSurveyLink(token: string): SurveyLinkRow | undefined {
    const r = this.one('select * from survey_links where token=?', token);
    return r && toSurvey(r);
  }
  listSurveyLinks(reqId: string): SurveyLinkRow[] {
    return this.all('select * from survey_links where request_id=? order by round, rowid', reqId).map(toSurvey);
  }
  markSurveySubmitted(token: string, at = Date.now()): void {
    this.run('update survey_links set submitted_at=? where token=?', at, token);
  }

  // ---- users ----
  createUser(u: { username: string; passwordHash: string; role: UserRole }): UserRow {
    // v2/local/break-glass accounts: an 'admin' role maps to sys_role 'admin'.
    const info = this.run('insert into users(username,password_hash,role,sys_role,created_at) values(?,?,?,?,?)',
      u.username, u.passwordHash, u.role, u.role === 'admin' ? 'admin' : 'member', Date.now());
    return this.getUser(Number(info.lastInsertRowid))!;
  }
  getUser(id: number): UserRow | undefined {
    const r = this.one('select * from users where id=?', id);
    return r && toUser(r);
  }
  getUserByUsername(username: string): UserRow | undefined {
    const r = this.one('select * from users where username=?', username);
    return r && toUser(r);
  }
  listUsers(): UserRow[] { return this.all('select * from users order by id').map(toUser); }
  setUserGitlabToken(id: number, enc: string | null): void { this.run('update users set gitlab_token_enc=? where id=?', enc, id); }
  setUserPassword(id: number, passwordHash: string): void { this.run('update users set password_hash=? where id=?', passwordHash, id); }
  getUserByEmail(email: string): UserRow | undefined {
    const r = this.one('select * from users where email=?', email.trim().toLowerCase());
    return r && toUser(r);
  }
  getUserByGoogleSub(sub: string): UserRow | undefined {
    const r = this.one('select * from users where google_sub=?', sub);
    return r && toUser(r);
  }
  /** Google login: find by sub, else by email (links the sub), else create a `member` without department. `created` tells the caller to apply first-login seeding. */
  upsertGoogleUser(g: { email: string; googleSub: string; displayName: string }): { user: UserRow; created: boolean } {
    const email = g.email.trim().toLowerCase();
    const found = this.getUserByGoogleSub(g.googleSub) ?? this.getUserByEmail(email);
    if (found) {
      this.run('update users set email=?, google_sub=?, display_name=? where id=?', email, g.googleSub, g.displayName || found.displayName, found.id);
      return { user: this.getUser(found.id)!, created: false };
    }
    const info = this.run("insert into users(username,password_hash,role,email,google_sub,display_name,sys_role,created_at) values(?,'','member',?,?,?,'member',?)",
      email, email, g.googleSub, g.displayName, Date.now());
    return { user: this.getUser(Number(info.lastInsertRowid))!, created: true };
  }
  setUserSysRole(id: number, sysRole: SysRole): void {
    // keep the v2 `role` column coherent for code paths that still read it
    this.run('update users set sys_role=?, role=? where id=?', sysRole, sysRole === 'admin' ? 'admin' : 'member', id);
  }
  setUserDepartment(id: number, departmentId: number | null): void { this.run('update users set department_id=? where id=?', departmentId, id); }
  setUserCanBePm(id: number, canBePm: boolean): void { this.run('update users set can_be_pm=? where id=?', canBePm ? 1 : 0, id); }
  setUserOsUser(id: number, osUser: string | null): void { this.run('update users set os_user=? where id=?', osUser, id); }
  setUserDisabled(id: number, disabled: boolean): void { this.run('update users set disabled=? where id=?', disabled ? 1 : 0, id); }
  listUsersByDepartment(departmentId: number): UserRow[] {
    return this.all('select * from users where department_id=? order by id', departmentId).map(toUser);
  }
  deleteUser(id: number): void { this.run('delete from users where id=?', id); }

  // ---- settings / templates ----
  getSetting(key: string): string | undefined { return this.one('select value from settings where key=?', key)?.value; }
  setSetting(key: string, value: string): void {
    this.run('insert into settings(key,value) values(?,?) on conflict(key) do update set value=excluded.value', key, value);
  }
  getTemplate(kind: string): string | undefined { return this.one('select path from templates where kind=?', kind)?.path; }
  setTemplate(kind: string, path: string): void {
    this.run('insert into templates(kind,path) values(?,?) on conflict(kind) do update set path=excluded.path', kind, path);
  }
  deleteTemplate(kind: string): void { this.run('delete from templates where kind=?', kind); }
  listTemplates(): { kind: string; path: string }[] {
    return this.all('select kind, path from templates order by kind').map(r => ({ kind: r.kind, path: r.path }));
  }

  // ---- departments ----
  listDepartments(): DepartmentRow[] { return this.all('select * from departments order by id').map(toDept); }
  getDepartment(id: number): DepartmentRow | undefined {
    const r = this.one('select * from departments where id=?', id);
    return r && toDept(r);
  }
  getDepartmentByCode(code: DepartmentCode): DepartmentRow | undefined {
    const r = this.one('select * from departments where code=?', code);
    return r && toDept(r);
  }

  // ---- audit log ----
  addAudit(a: { projectId?: number | null; requestId?: string | null; userId?: number | null; action: string; detail?: string }): void {
    this.run('insert into audit_log(project_id,request_id,user_id,action,detail,at) values(?,?,?,?,?,?)',
      a.projectId ?? null, a.requestId ?? null, a.userId ?? null, a.action, a.detail ?? '', Date.now());
  }
  listAudit(f: { projectId?: number; requestId?: string; limit?: number } = {}): AuditRow[] {
    const where: string[] = [];
    const p: SQLInputValue[] = [];
    if (f.projectId !== undefined) { where.push('project_id=?'); p.push(f.projectId); }
    if (f.requestId !== undefined) { where.push('request_id=?'); p.push(f.requestId); }
    return this.all(`select * from audit_log ${where.length ? 'where ' + where.join(' and ') : ''} order by id desc limit ?`, ...p, f.limit ?? 200).map(toAudit);
  }
}

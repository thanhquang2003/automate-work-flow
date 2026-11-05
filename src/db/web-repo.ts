import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { SurveyLinkRow, UserRole, UserRow } from '../domain/types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const toUser = (r: Row): UserRow => ({
  id: r.id, username: r.username, passwordHash: r.password_hash, role: r.role, gitlabTokenEnc: r.gitlab_token_enc ?? null, createdAt: r.created_at,
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
    const info = this.run('insert into users(username,password_hash,role,created_at) values(?,?,?,?)', u.username, u.passwordHash, u.role, Date.now());
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
}

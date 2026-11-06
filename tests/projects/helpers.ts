import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../../src/config.js';
import { openDb } from '../../src/db/db.js';
import { Repo } from '../../src/db/repo.js';
import { ProjectService, type ProjectSystemOps } from '../../src/projects/service.js';
import type { UserRow } from '../../src/domain/types.js';

export const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function mkUser(repo: Repo, email: string, o: { dept?: 'DEV' | 'SGLOBAL' | null; canBePm?: boolean } = {}): UserRow {
  const { user } = repo.web.upsertGoogleUser({ email, googleSub: `sub-${email}`, displayName: email.split('@')[0]! });
  const dept = o.dept === undefined ? 'DEV' : o.dept;
  if (dept) repo.web.setUserDepartment(user.id, repo.web.getDepartmentByCode(dept)!.id);
  if (o.canBePm) repo.web.setUserCanBePm(user.id, true);
  return repo.web.getUser(user.id)!;
}

export function mkEnv() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'devflow-proj-')));
  const root = join(base, 'roots');
  mkdirSync(root);
  const cfg: Config = { ...loadConfig({ DEVFLOW_MODE: 'local', CLAUDE_MOCK: '1' }), dataDir: join(base, 'data'), projectRoots: [root] };
  const repo = new Repo(openDb(':memory:'));
  const ops = { groups: [] as [number, string][], members: [] as [number, number[]][] };
  const systemOps: ProjectSystemOps = {
    ensureProjectGroup: async (id, path) => { ops.groups.push([id, path]); },
    setMembers: async (id, users) => { ops.members.push([id, users]); },
  };
  const svc = new ProjectService({ cfg, repo, systemOps });
  const pm = mkUser(repo, 'pm@x.com', { canBePm: true });
  return { base, root, cfg, repo, svc, ops, pm, systemOps };
}

export function mkGitRepo(dir: string, branch = 'main'): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', branch);
  writeFileSync(join(dir, 'a.txt'), 'a');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
}

/** Project with all six roles filled (one user each, PM = env.pm). */
export async function fullProject(e: ReturnType<typeof mkEnv>, key = 'ERP') {
  const p = await e.svc.createProject({ mode: 'new', key, name: key, path: join(e.root, key.toLowerCase()), createdBy: e.pm.id });
  const mk = (n: string) => mkUser(e.repo, `${n}@x.com`);
  const [ba, se, dev, rev, tester] = ['ba', 'se', 'dev', 'rev', 'tester'].map(mk) as UserRow[];
  await e.svc.setMembers(p.id, [
    { userId: e.pm.id, roles: ['PM'] }, { userId: ba!.id, roles: ['BA'] }, { userId: se!.id, roles: ['SE'] },
    { userId: dev!.id, roles: ['DEV'] }, { userId: rev!.id, roles: ['REVIEWER'] }, { userId: tester!.id, roles: ['TESTER'] },
  ], e.pm.id);
  return { p, ba: ba!, se: se!, dev: dev!, rev: rev!, tester: tester! };
}

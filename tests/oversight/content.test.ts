import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContentError, isSecretPath, readProjectFile, readRequestLog, redactLog, listRequestLogs } from '../../src/oversight/content.js';
import { fullProject, git, mkEnv } from '../projects/helpers.js';

async function env() {
  const e = mkEnv();
  const f = await fullProject(e);
  const dir = f.p.path;
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = "<script>alert(1)</script>";\n');
  writeFileSync(join(dir, '.env'), 'TOKEN=abc\n');
  writeFileSync(join(dir, '.env.production'), 'TOKEN=abc\n');
  writeFileSync(join(dir, 'server.pem'), 'PEM');
  writeFileSync(join(dir, 'server.KEY'), 'KEY');
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'settings.json'), '{}');
  mkdirSync(join(dir, 'conf', '.ssh'), { recursive: true });
  writeFileSync(join(dir, 'conf', '.ssh', 'id_rsa'), 'x');
  writeFileSync(join(dir, 'bin.dat'), Buffer.from([1, 2, 0, 3, 4]));
  writeFileSync(join(dir, 'big.txt'), 'x'.repeat(1024 * 1024 + 1));
  symlinkSync('/etc/passwd', join(dir, 'link'));
  git(dir, 'add', '-A');
  git(dir, 'update-index', '--add', '--cacheinfo', `160000,${git(dir, 'rev-parse', 'HEAD')},sub`);
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'c');
  git(dir, 'branch', 'devflow/REQ-1');
  git(dir, 'branch', 'feature/other');
  return { ...e, ...f, ctx: { repo: e.repo, userId: f.dev.id } };
}
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof ContentError ? e.code : `other:${(e as Error).message}`; } };

describe('readProjectFile', () => {
  it('lists the tree and reads text through git, escaping is left to the view', async () => {
    const e = await env();
    const root = await readProjectFile(e.p, undefined, '', e.ctx);
    expect(root.kind).toBe('dir');
    const names = root.kind === 'dir' ? root.entries.map(x => x.name) : [];
    expect(names).toContain('src');
    expect(names).toContain('README.md');
    const f = await readProjectFile(e.p, undefined, 'src/a.ts', e.ctx);
    expect(f).toMatchObject({ kind: 'file' });
    expect(f.kind === 'file' && f.text).toContain('<script>');
    const onBranch = await readProjectFile(e.p, 'devflow/REQ-1', 'src/a.ts', e.ctx);
    expect(onBranch.kind).toBe('file');
  });

  it('secret files hidden (.env, *.pem, *.key, .claude/, .git/config)', async () => {
    const e = await env();
    for (const p of ['.env', '.env.production', 'server.pem', 'server.KEY', '.claude/settings.json', '.claude', '.git/config', '.git', 'conf/.ssh/id_rsa', 'conf/.ssh', 'CREDENTIALS.json', '.npmrc', '.netrc', 'x/id_rsa.pub', 'a.p12', 'a.pfx']) {
      expect(await code(readProjectFile(e.p, undefined, p, e.ctx)), p).toBe('forbidden');
    }
    const root = await readProjectFile(e.p, undefined, '', e.ctx);
    const names = root.kind === 'dir' ? root.entries.map(x => x.name) : [];
    for (const n of ['.env', '.env.production', 'server.pem', 'server.KEY', '.claude']) expect(names).not.toContain(n);
    const conf = await readProjectFile(e.p, undefined, 'conf', e.ctx);
    expect(conf.kind === 'dir' && conf.entries.map(x => x.name)).toEqual([]);
    expect(isSecretPath('a/.Env.local')).toBe(true);
    expect(isSecretPath('src/environment.ts')).toBe(false);
  });

  it('symlink and .. rejected', async () => {
    const e = await env();
    for (const p of ['../x', 'src/../../x', '/etc/passwd', 'src//a.ts', './src', 'src/.', 'a\\b', 'src/a.ts\0', ':(top)a.txt']) {
      expect(['bad_path', 'not_found'], p).toContain(await code(readProjectFile(e.p, undefined, p, e.ctx)));
    }
    expect(await code(readProjectFile(e.p, undefined, '../x', e.ctx))).toBe('bad_path');
    expect(await code(readProjectFile(e.p, undefined, 'link/x', e.ctx))).toBe('not_found');
  });

  it('symlink and gitlink entries are listed, never followed', async () => {
    const e = await env();
    const link = await readProjectFile(e.p, undefined, 'link', e.ctx);
    expect(link).toEqual({ kind: 'symlink', target: '/etc/passwd' });
    const sub = await readProjectFile(e.p, undefined, 'sub', e.ctx);
    expect(sub.kind).toBe('gitlink');
    const root = await readProjectFile(e.p, undefined, '', e.ctx);
    const by = Object.fromEntries((root.kind === 'dir' ? root.entries : []).map(x => [x.name, x.kind]));
    expect(by.link).toBe('symlink');
    expect(by.sub).toBe('gitlink');
    expect(by.src).toBe('dir');
  });

  it('binary and oversize files are not rendered', async () => {
    const e = await env();
    expect(await readProjectFile(e.p, undefined, 'bin.dat', e.ctx)).toEqual({ kind: 'binary', size: 5 });
    expect(await readProjectFile(e.p, undefined, 'big.txt', e.ctx)).toEqual({ kind: 'toolarge', size: 1024 * 1024 + 1 });
  });

  it('ref name injection rejected', async () => {
    const e = await env();
    const sha = git(e.p.path, 'rev-parse', 'HEAD');
    for (const r of ['--output=/tmp/x', '-p', 'HEAD', sha, 'main:src/a.ts', 'main..devflow/REQ-1', 'feature/other', 'devflow/../main', '@{-1}', 'refs/heads/main', 'devflow/REQ 1', 'devflow/REQ-1;id', 'devflow/nope']) {
      expect(['bad_ref', 'not_found'], r).toContain(await code(readProjectFile(e.p, r, 'src/a.ts', e.ctx)));
    }
    expect(await code(readProjectFile(e.p, '--output=/tmp/x', 'src/a.ts', e.ctx))).toBe('bad_ref');
  });

  it('content view writes audit_log (also for refused views)', async () => {
    const e = await env();
    await readProjectFile(e.p, undefined, 'src/a.ts', e.ctx);
    await code(readProjectFile(e.p, undefined, '.env', e.ctx));
    const rows = e.repo.web.listAudit({ projectId: e.p.id });
    const ok = rows.find(r => r.action === 'oversight.content');
    expect(ok).toMatchObject({ userId: e.dev.id, projectId: e.p.id });
    expect(JSON.parse(ok!.detail)).toMatchObject({ path: 'src/a.ts' });
    const denied = rows.find(r => r.action === 'oversight.content.denied');
    expect(JSON.parse(denied!.detail)).toMatchObject({ path: '.env' });
  });
});

describe('request logs', () => {
  it('serves only .devflow/requests/<code>/logs, redacted, size capped, symlinks refused', async () => {
    const e = await env();
    const req = await e.svc.createRequest({ projectId: e.p.id, code: 'REQ-9', title: 't', description: 'd', perfReq: '', nonfuncReq: '', softwareTypes: ['web'], runMode: 'review', by: e.pm.id });
    const logs = join(e.p.path, '.devflow', 'requests', 'REQ-9', 'logs');
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, 'ANALYSIS-1.log'), [
      'start', 'Authorization: Bearer abc.def', 'export password=hunter2', 'key sk-abcdefghijklmnopqrstuvwxyz1234 end',
      'tok ghp_abcdefghijklmnopqrstuvwxyz0123456789 end', 'glpat-abcdefghijklmnopqrst', `hash ${'a1'.repeat(24)}`, 'normal line',
    ].join('\n'));
    writeFileSync(join(logs, 'big.log'), `${'y'.repeat(2 * 1024 * 1024)}\nTAIL`);
    symlinkSync('/etc/passwd', join(logs, 'evil.log'));
    const list = await listRequestLogs(e.p, 'REQ-9', e.ctx);
    expect(list.map(x => x.name).sort()).toEqual(['ANALYSIS-1.log', 'big.log']);
    const one = await readRequestLog(e.p, 'REQ-9', 'ANALYSIS-1.log', e.ctx);
    expect(one.text).toContain('normal line');
    expect(one.text).not.toMatch(/Bearer abc|hunter2|sk-abcdef|ghp_abc|glpat-abc|a1a1a1a1/);
    const big = await readRequestLog(e.p, 'REQ-9', 'big.log', e.ctx);
    expect(big.truncated).toBe(true);
    expect(big.text.length).toBeLessThanOrEqual(1024 * 1024 + 100);
    expect(big.text).toContain('TAIL');
    for (const [c, n] of [['REQ-9', 'evil.log'], ['REQ-9', '../x.log'], ['REQ-9', 'a/b.log'], ['../REQ-9', 'ANALYSIS-1.log'], ['NOPE-1', 'ANALYSIS-1.log'], ['REQ-9', 'notlog.txt']] as const) {
      expect(['bad_path', 'not_found', 'forbidden'], `${c}/${n}`).toContain(await code(readRequestLog(e.p, c, n, e.ctx)));
    }
    expect(req.id).toBeTruthy();
    expect(e.repo.web.listAudit({ projectId: e.p.id }).some(r => r.action === 'oversight.log')).toBe(true);
    expect(redactLog('Authorization: x\nok')).toBe('[đã ẩn: dòng có thông tin xác thực]\nok');
  });
});

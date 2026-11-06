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
    for (const p of ['.env', '.env.production', 'server.pem', 'server.KEY', '.claude/settings.json', '.claude', '.git/config', '.git', 'conf/.ssh/id_rsa', 'conf/.ssh', 'CREDENTIALS.json', '.npmrc', '.netrc', 'x/id_rsa.pub', 'a.p12', 'a.pfx', '.env.', '.env ', 'key.pem.bak', 'x.KEY.old', '.git-credentials', '.pypirc', '.htpasswd', '.docker/config.json', '.kube/config', 'secrets.yaml', 'Secrets.JSON', 'config/secrets.yml', 'a/.Git/config.', 'key.pem~', 'a.pem_bak', 'terraform.tfstate', 'terraform.tfstate.backup', '.vault-token', 'prod.tfvars', 'x/prod.auto.tfvars']) {
      expect(await code(readProjectFile(e.p, undefined, p, e.ctx)), p).toBe('forbidden');
    }
    const root = await readProjectFile(e.p, undefined, '', e.ctx);
    const names = root.kind === 'dir' ? root.entries.map(x => x.name) : [];
    for (const n of ['.env', '.env.production', 'server.pem', 'server.KEY', '.claude']) expect(names).not.toContain(n);
    const conf = await readProjectFile(e.p, undefined, 'conf', e.ctx);
    expect(conf.kind === 'dir' && conf.entries.map(x => x.name)).toEqual([]);
    expect(isSecretPath('a/.Env.local')).toBe(true);
    expect(isSecretPath('src/environment.ts')).toBe(false);
    expect(isSecretPath('docs/keyboard.md')).toBe(false);
    expect(isSecretPath('src/a.pemx')).toBe(false);
    expect(isSecretPath('src/secrets-manager.ts')).toBe(false);
  });

  it('symlink and .. rejected', async () => {
    const e = await env();
    for (const p of ['../x', 'src/../../x', '/etc/passwd', 'src//a.ts', './src', 'src/.', 'a\\b', 'src/a.ts\0']) {
      expect(await code(readProjectFile(e.p, undefined, p, e.ctx)), JSON.stringify(p)).toBe('bad_path');
    }
    expect(await code(readProjectFile(e.p, undefined, ':(top)a.txt', e.ctx))).toBe('not_found'); // literal pathspec, simply absent
    expect(await code(readProjectFile(e.p, undefined, 'link/x', e.ctx))).toBe('not_found'); // never resolved through the symlink
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
    for (const r of ['--output=/tmp/x', '-p', 'HEAD', sha, 'main:src/a.ts', 'main..devflow/REQ-1', 'feature/other', 'devflow/../main', 'devflow/..', '@{-1}', 'refs/heads/main', 'devflow/REQ 1', 'devflow/REQ-1;id', 'devflow/REQ-1:src']) {
      expect(await code(readProjectFile(e.p, r, 'src/a.ts', e.ctx)), r).toBe('bad_ref');
    }
    expect(await code(readProjectFile(e.p, 'devflow/nope', 'src/a.ts', e.ctx))).toBe('not_found'); // well-formed but absent
  });

  it('a project folder without its own .git never reads a parent repository', async () => {
    const e = await env();
    const parent = join(e.base, 'parentrepo');
    mkdirSync(join(parent, 'sub'), { recursive: true });
    git(parent, 'init', '-q', '-b', 'main');
    writeFileSync(join(parent, 'sub', 'leak.txt'), 'parent secret');
    git(parent, 'add', '-A');
    git(parent, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x');
    const p = e.repo.createProject({ key: 'NOGIT', name: 'n', path: join(parent, 'sub'), departmentId: e.p.departmentId, createdBy: e.pm.id });
    expect(await code(readProjectFile(p, undefined, 'leak.txt', e.ctx))).toBe('not_found');
    expect(await code(readProjectFile(p, undefined, '', e.ctx))).toBe('not_found');
  });

  it('content view writes audit_log (also for refused views)', async () => {
    const e = await env();
    await readProjectFile(e.p, undefined, 'src/a.ts', e.ctx);
    await readProjectFile(e.p, undefined, '', e.ctx); // index page: not audited
    await readProjectFile(e.p, undefined, 'src/a.ts', { ...e.ctx, audit: false }); // HEAD: not audited
    await code(readProjectFile(e.p, undefined, '.env', e.ctx));
    const rows = e.repo.web.listAudit({ projectId: e.p.id });
    expect(rows.filter(r => r.action === 'oversight.content')).toHaveLength(1);
    expect(rows.filter(r => r.action === 'oversight.content.denied')).toHaveLength(1);
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
    expect(e.repo.web.listAudit({ projectId: e.p.id }).filter(r => r.action === 'oversight.log' && r.detail.includes('"list"'))).toHaveLength(0);
    expect(redactLog('Authorization: x\nok')).toBe('Authorization: [đã ẩn]\nok');
  });
});

describe('redactLog', () => {
  it('masks the value of credential keys and keeps the key name', () => {
    const cases: [string, string, string][] = [
      ['GITLAB_TOKEN=glpat-abc', 'GITLAB_TOKEN=', 'abc'],
      ['export CLAUDE_CODE_OAUTH_TOKEN=abcd1234', 'CLAUDE_CODE_OAUTH_TOKEN=', 'abcd1234'],
      ['access_token=abc123', 'access_token=', 'abc123'],
      ['refresh_token: r3fr3sh', 'refresh_token:', 'r3fr3sh'],
      ['{"token": "t0k3n-x"}', '"token"', 't0k3n-x'],
      ['{"accessToken":"shortval"}', '"accessToken"', 'shortval'],
      ['clone https://oauth2:abcd1234efgh@gitlab.x/r.git', 'https://oauth2:', 'abcd1234efgh'],
      ['pwd=hunter2', 'pwd=', 'hunter2'],
      ['passwd: hunter3', 'passwd:', 'hunter3'],
      ['db password = "my pass"', 'password', 'my pass'],
      ['client_secret=s3cr3t', 'client_secret=', 's3cr3t'],
      ['X-Api-Key: k3y-val', 'X-Api-Key:', 'k3y-val'],
      ['apikey=abc', 'apikey=', 'abc'],
      ['Authorization: Bearer abc.def', 'Authorization:', 'abc.def'],
      ['auth: basic dXNlcjpw', 'auth:', 'dXNlcjpw'],
      ['curl -H "Authorization: Bearer zzz"', 'Authorization:', 'zzz'],
      ['token: Bearer abc123def', 'token:', 'abc123def'],
      ['X-Token: Bearer abc123', 'X-Token:', 'abc123'],
      ['--token abc12', '--token', 'abc12'],
      ['--token=abc12', '--token=', 'abc12'],
      ['run --password hunter2 now', '--password', 'hunter2'],
      ['mysql -u root -p hunter2', '-p', 'hunter2'],
      ['--api-key abc12', '--api-key', 'abc12'],
      ['--secret x9y8z7', '--secret', 'x9y8z7'],
      ['{"token":"a\\"b c d"}', '"token"', 'c d'],
      ['password: correct horse battery', 'password:', 'horse'],
      ['secret = my long phrase here', 'secret =', 'phrase'],
      ['password is hunter2', 'password is', 'hunter2'],
      ['passwd hunter2', 'passwd', 'hunter2'],
      ['apikey abc12', 'apikey', 'abc12'],
      ['api key: abc12', 'api key:', 'abc12'],
      ['Cookie: a=1; sid=zzz999; theme=dark', 'Cookie:', 'zzz999'],
      ['Set-Cookie: sid=zzz999; Path=/; HttpOnly', 'Set-Cookie:', 'zzz999'],
      ['mysql://root:p@ss@host/db', 'mysql://root:', 'p@ss'],
      ['see eyJhbGciOi.eyJzdWIiOiIx.c2ln here', 'see', 'eyJzdWIiOiIx'],
      ['eyJh.eyJz.s', '', 'eyJz'],
    ];
    for (const [input, key, secret] of cases) {
      const out = redactLog(input);
      expect(out, input).not.toContain(secret);
      expect(out, input).toContain(key);
      expect(out, input).toContain('[đã ẩn]');
    }
  });

  it('masks multi-line secrets: value on the next line and PEM blocks', () => {
    expect(redactLog('token:\n  abc12\nnext line')).toBe('token:\n  [đã ẩn]\nnext line');
    expect(redactLog('password: \nhunter2\nok')).not.toContain('hunter2');
    const pem = ['before', '-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA1234', 'abcd', '-----END RSA PRIVATE KEY-----', 'after'].join('\n');
    const out = redactLog(pem);
    expect(out).toBe(['before', '-----BEGIN RSA PRIVATE KEY----- [đã ẩn]', '-----END RSA PRIVATE KEY-----', 'after'].join('\n'));
    expect(redactLog('{"k":"-----BEGIN PRIVATE KEY-----\\nMIIE\\nxx\\n-----END PRIVATE KEY-----\\n"}')).not.toContain('MIIE');
    expect(redactLog('-----BEGIN PRIVATE KEY-----\nMIIE\nlast')).not.toContain('MIIE'); // unterminated: the rest is dropped
  });

  it('keeps ordinary text readable', () => {
    const log = ['tokenizer ran', 'tokens used: 5000', 'author: bob', 'the tokenizer splits words', 'tokens used 1234 of 5000', 'Reading src/auth/login.ts', 'author: Bob', 'secretary meeting at 9', 'build ok'].join('\n');
    expect(redactLog(log)).toBe(log);
    expect(redactLog('line1\npassword=x\nline3')).toBe('line1\npassword=[đã ẩn]\nline3');
  });

  it('is linear on hostile 1 MB lines', () => {
    const MB = 1024 * 1024;
    const lines = [
      'a'.repeat(MB), 'token'.repeat(MB / 5), 'token '.repeat(MB / 6), `token${' '.repeat(MB)}x`, '//a:'.repeat(MB / 4), `//u:${'p'.repeat(MB)}`,
      '--token '.repeat(MB / 8), '-p '.repeat(MB / 3), 'password is '.repeat(MB / 12), 'cookie:'.repeat(MB / 7), 'eyJ'.repeat(MB / 3), `eyJ${'a'.repeat(MB)}`,
      '-----BEGIN PRIVATE KEY----- '.repeat(MB / 28), '//a:'.repeat(MB / 4) + '@', 'token: '.repeat(MB / 8), `password:${' '.repeat(MB)}`, `"token":"${'\\"'.repeat(MB / 2)}`,
      'Bearer '.repeat(MB / 7), `bearer${' '.repeat(MB)}`, 'auth='.repeat(MB / 5), 'a1'.repeat(MB / 2), `${'f'.repeat(MB)}g`, 'password='.repeat(MB / 9),
    ];
    for (const l of lines) {
      const t = Date.now();
      redactLog(l);
      expect(Date.now() - t, l.slice(0, 12)).toBeLessThan(2500);
    }
  });
});

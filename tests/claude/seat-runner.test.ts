import { describe, it, expect, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectSeatError, runClaude } from '../../src/claude/runner.js';
import { LocalSeatRunner, SudoSeatRunner, createSeatRunner, parseAuthStatus } from '../../src/claude/seat-runner.js';
import { loadConfig, type Config } from '../../src/config.js';
import { mkSeatFakes } from './seat-fakes.js';

const fixture = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const hasBash = process.platform !== 'win32';

function setup() {
  const f = mkSeatFakes();
  const cfg = { ...loadConfig({ DEVFLOW_MODE: 'local' }), dfctlPath: f.dfctl, claudeMock: false, rateLimitPauseMin: 30 } as Config;
  const runner = new SudoSeatRunner(cfg, { sudoBin: f.sudo });
  const cwd = join(f.dir, 'proj', '.devflow', 'worktrees', 'R1');
  mkdirSync(cwd, { recursive: true });
  return { f, cfg, runner, cwd };
}

describe('detectSeatError', () => {
  it('classifies login problems', () => {
    expect(detectSeatError('Login expired. Please run /login')).toBe('expired');
    expect(detectSeatError('OAuth token has expired. Please obtain a new token')).toBe('expired');
    expect(detectSeatError('Invalid API key · Please run /login')).toBe('disconnected');
    expect(detectSeatError('Not logged in · Please run /login')).toBe('disconnected');
    expect(detectSeatError('API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}')).toBe('disconnected');
    expect(detectSeatError('Error: ENOENT no such file')).toBeUndefined();
    // Output about the project's own API or auth code is not a seat problem.
    expect(detectSeatError('Tests failed: GET /api/users returned 401 Unauthorized')).toBeUndefined();
    expect(detectSeatError('{"error":"unauthorized","type":"auth"}')).toBeUndefined();
    expect(detectSeatError('Refactored the authentication_error handler; the not logged in redirect works')).toBeUndefined();
    expect(detectSeatError('The session token has expired check in auth.ts was fixed')).toBeUndefined();
    expect(detectSeatError('')).toBeUndefined();
  });
});

describe.skipIf(!hasBash)('SudoSeatRunner', () => {
  it('sudo runner builds dfctl command and passes prompt via stdin', async () => {
    const { f, runner, cwd } = setup();
    const r = await runner.run(7, { cwd, prompt: 'hello seat', addDirs: ['/x/req'], resumeSessionId: 'abc' });
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    const [sudoCall] = f.sudoCalls();
    expect(sudoCall!.slice(0, 7)).toEqual([f.dfctl, 'run-claude', '7', cwd, '--run-id', expect.stringMatching(/^[a-f0-9]{24}$/), '--']);
    const claudeArgs = sudoCall!.slice(7);
    expect(claudeArgs[0]).toBe('-p');
    expect(claudeArgs).toEqual(expect.arrayContaining(['--output-format', 'stream-json', '--permission-mode', 'bypassPermissions', '--add-dir', '/x/req', '--resume', 'abc']));
    expect(claudeArgs.join(' ')).not.toContain('hello seat');
    const parsed = JSON.parse(r.resultText);
    expect(parsed.prompt).toBe('hello seat');
    expect(r.sessionId).toBe('sess-123');
  });

  it('never passes test prefix args (CLAUDE_BIN_ARGS) to dfctl', async () => {
    const { f, cfg, cwd } = setup();
    const runner = new SudoSeatRunner({ ...cfg, claudeBinArgs: ['evil.js'] }, { sudoBin: f.sudo });
    await runner.run(7, { cwd, prompt: 'p' });
    expect(f.sudoCalls()[0]).not.toContain('evil.js');
  });

  it('seat error detection: expired and disconnected', async () => {
    const { f, runner, cwd } = setup();
    f.set('mode', 'expired');
    const a = await runner.run(3, { cwd, prompt: 'p' });
    expect(a.ok).toBe(false);
    expect(a.seatError).toBe('expired');
    expect(a.rateLimitedUntil).toBeUndefined();
    f.set('mode', 'notloggedin');
    const b = await runner.run(3, { cwd, prompt: 'p' });
    expect(b.ok).toBe(false);
    expect(b.seatError).toBe('disconnected');
  });

  it('a failed run whose output mentions a 401 from the project API is not a seat error', async () => {
    const { f, runner, cwd } = setup();
    f.set('mode', 'project-401');
    const r = await runner.run(3, { cwd, prompt: 'p' });
    expect(r.ok).toBe(false);
    expect(r.seatError).toBeUndefined();
  });

  it('a successful run that merely mentions login is not a seat error', async () => {
    const { f, runner, cwd } = setup();
    f.set('mode', 'ok-mentions-login');
    const r = await runner.run(3, { cwd, prompt: 'p' });
    expect(r.ok).toBe(true);
    expect(r.seatError).toBeUndefined();
  });

  it('run aborts when signal fires and reports aborted, not failed', async () => {
    const { f, runner, cwd } = setup();
    f.set('mode', 'hang');
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 400);
    const t = Date.now();
    const r = await runner.run(9, { cwd, prompt: 'p', signal: ac.signal });
    expect(Date.now() - t).toBeLessThan(15_000);
    expect(r.aborted).toBe(true);
    expect(r.seatError).toBeUndefined();
    expect(r.rateLimitedUntil).toBeUndefined();
    const runId = f.calls()[0]![4];
    // The real child runs as another OS user, so the runner asks dfctl to stop it by run id.
    // stop-claude is fire-and-forget: wait for it to be recorded.
    await vi.waitFor(() => expect(f.calls()).toContainEqual(['stop-claude', '9', runId]), { timeout: 10_000 });
  });

  it('an already-aborted signal reports aborted without spawning sudo', async () => {
    const { f, runner, cwd } = setup();
    const ac = new AbortController();
    ac.abort();
    const r = await runner.run(9, { cwd, prompt: 'p', signal: ac.signal });
    expect(r.aborted).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.seatError).toBeUndefined();
    expect(f.sudoCalls()).toEqual([]);
  });

  it('timeout is a failure, not an abort', async () => {
    const { f, runner, cwd } = setup();
    f.set('mode', 'hang');
    const r = await runner.run(9, { cwd, prompt: 'p', timeoutMs: 400 });
    expect(r.ok).toBe(false);
    expect(r.aborted).toBeFalsy();
    expect(r.error).toMatch(/timeout/);
  });

  it('rejects a bad user id or relative cwd without calling sudo', async () => {
    const { f, runner, cwd } = setup();
    for (const id of [0, -1, 1.5, Number.NaN] as number[]) await expect(runner.run(id, { cwd, prompt: 'p' })).rejects.toThrow(/user id/i);
    await expect(runner.run(null, { cwd, prompt: 'p' })).rejects.toThrow(/user id/i);
    await expect(runner.run(1, { cwd: 'rel/dir', prompt: 'p' })).rejects.toThrow(/absolute/i);
    expect(f.sudoCalls()).toEqual([]);
  });

  it('status parses connected/expired through dfctl claude-auth status', async () => {
    const { f, runner } = setup();
    f.set('status-out', JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'a@x.com', orgName: 'Acme', orgId: 'o-1' }));
    expect(await runner.status(4)).toEqual({ state: 'connected', email: 'a@x.com', org: 'Acme' });
    expect(f.calls().at(-1)).toEqual(['claude-auth', '4', 'status']);
    f.set('status-out', JSON.stringify({ loggedIn: false }));
    f.set('status-rc', '1');
    expect((await runner.status(4)).state).toBe('disconnected');
    f.set('status-out', 'Login expired. Please run claude auth login');
    expect((await runner.status(4)).state).toBe('expired');
  });

  it('logout calls dfctl claude-auth logout', async () => {
    const { f, runner } = setup();
    await runner.logout(5);
    expect(f.calls().at(-1)).toEqual(['claude-auth', '5', 'logout']);
  });
});

describe('parseAuthStatus', () => {
  it('JSON and text forms; never copies raw output into the status', () => {
    expect(parseAuthStatus('{"loggedIn":true,"email":"b@y.vn","orgName":"Org"}', 0)).toEqual({ state: 'connected', email: 'b@y.vn', org: 'Org' });
    expect(parseAuthStatus('{"loggedIn":false}', 1).state).toBe('disconnected');
    expect(parseAuthStatus('Not logged in. Run claude auth login', 1).state).toBe('disconnected');
    expect(parseAuthStatus('Your login has expired', 1).state).toBe('expired');
    expect(parseAuthStatus('Logged in as c@z.com\nOrganization: Team Z', 0)).toMatchObject({ state: 'connected' });
    expect(parseAuthStatus('weird output token=sk-ant-xyz', 3)).toEqual({ state: 'unknown' });
    expect(parseAuthStatus('', null)).toEqual({ state: 'unknown' });
    const s = parseAuthStatus('{"loggedIn":true,"email":"b@y.vn","accessToken":"sk-ant-secret"}', 0);
    expect(JSON.stringify(s)).not.toContain('sk-ant');
  });
});

describe('LocalSeatRunner', () => {
  it('runs the v2 runner and ignores the user id', async () => {
    const cfg = { claudeBin: process.execPath, claudeBinArgs: [fixture, 'ok'], claudeMock: false, rateLimitPauseMin: 30 } as unknown as Config;
    const r = await new LocalSeatRunner(cfg).run(null, { cwd: process.cwd(), prompt: 'hi' });
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.resultText).prompt).toBe('hi');
    expect((await new LocalSeatRunner(cfg).status(1)).state).toBe('unknown');
  });

  it('v2 runClaude reports aborted on abort', async () => {
    const cfg = { claudeBin: process.execPath, claudeBinArgs: [fixture, 'hang'], claudeMock: false, rateLimitPauseMin: 30 } as unknown as Config;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const r = await runClaude(cfg, { cwd: process.cwd(), prompt: 'hi', signal: ac.signal });
    expect(r.aborted).toBe(true);
    expect(r.error).toMatch(/abort/);
  });

  it('createSeatRunner picks by mode', () => {
    const local = loadConfig({ DEVFLOW_MODE: 'local' });
    expect(createSeatRunner(local)).toBeInstanceOf(LocalSeatRunner);
    expect(createSeatRunner({ ...local, mode: 'server' })).toBeInstanceOf(SudoSeatRunner);
  });
});

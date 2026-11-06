import { describe, it, expect, vi, afterEach } from 'vitest';
import { extractLoginUrl, validateLoginCode } from '../../src/claude/seat-login.js';
import { SudoSeatRunner, LocalSeatRunner } from '../../src/claude/seat-runner.js';
import { loadConfig, type Config } from '../../src/config.js';
import { mkSeatFakes } from './seat-fakes.js';

const hasBash = process.platform !== 'win32';

function setup(loginTimeoutMs?: number) {
  const f = mkSeatFakes();
  const cfg = { ...loadConfig({ DEVFLOW_MODE: 'local' }), dfctlPath: f.dfctl } as Config;
  const runner = new SudoSeatRunner(cfg, { sudoBin: f.sudo, ...(loginTimeoutMs ? { loginTimeoutMs } : {}) });
  return { f, runner };
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

afterEach(() => vi.restoreAllMocks());

describe('extractLoginUrl', () => {
  it('takes the first allowed https URL, ignoring ANSI/OSC noise', () => {
    const raw = '\x1b[1mhi\x1b[0m\r\n\x1b]8;;https://claude.ai/oauth/authorize?a=1&b=2\x07https://claude.ai/oauth/authorize?a=1&b=2\x1b]8;;\x07\r\n';
    expect(extractLoginUrl(raw)).toBe('https://claude.ai/oauth/authorize?a=1&b=2');
    expect(extractLoginUrl('go to https://console.anthropic.com/oauth?x=1 now')).toBe('https://console.anthropic.com/oauth?x=1');
    expect(extractLoginUrl('no url yet')).toBeUndefined();
    expect(extractLoginUrl('http://claude.ai/insecure')).toBeUndefined();
    expect(extractLoginUrl('https://evil.example.com/x')).toBeUndefined();
    expect(extractLoginUrl('https://claude.ai.evil.com/x')).toBeUndefined();
    expect(extractLoginUrl('https://user@claude.ai/x')).toBeUndefined();
  });
});

describe('validateLoginCode', () => {
  it('accepts a pasted code, trims it, rejects control characters and oversize input', () => {
    expect(validateLoginCode('  abc123#XYZ-_.~  ')).toBe('abc123#XYZ-_.~');
    for (const bad of ['', '   ', 'a\nb', 'a\rb', 'a\x03b', 'a b', 'x'.repeat(2049)]) expect(() => validateLoginCode(bad)).toThrow();
  });
});

describe.skipIf(!hasBash)('seat login session', () => {
  it('login session extracts url and forwards code without logging', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m => vi.spyOn(console, m).mockImplementation(() => {}));
    const { f, runner } = setup();
    const code = 'SECRET-code_42#abc';
    const s = runner.login(6);
    const url = await new Promise<string>(res => s.once('url', res));
    expect(url).toBe('https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz');
    expect(s.url).toBe(url);
    s.sendCode(code);
    const r = await s.result;
    expect(r).toEqual({ success: true });
    expect(f.read('received')).toBe(code);
    const call = f.calls()[0]!;
    expect(call.slice(0, 4)).toEqual(['claude-auth', '6', 'login', '--run-id']);
    // The code never reaches argv, console, or anything the session keeps.
    expect(f.read('calls') + f.read('sudo-calls')).not.toContain(code);
    for (const sp of spies) for (const c of sp.mock.calls) expect(JSON.stringify(c)).not.toContain(code);
    const own = Object.entries(s).map(([, v]) => { try { return JSON.stringify(v) ?? ''; } catch { return ''; } }).join(' ');
    expect(own).not.toContain(code);
    expect(() => s.sendCode('again')).toThrow(/kết thúc|ended/i);
  });

  it('login failure is reported without echoing output', async () => {
    const { f, runner } = setup();
    f.set('login-mode', 'fail');
    const s = runner.login(6);
    await new Promise(res => s.once('url', res));
    s.sendCode('bad-code');
    const r = await s.result;
    expect(r.success).toBe(false);
    expect(r.reason).toBe('failed');
    expect(JSON.stringify(r)).not.toContain('bad-code');
  });

  it('login timeout kills process', async () => {
    const { f, runner } = setup(600);
    f.set('login-mode', 'hang');
    const s = runner.login(8);
    const done = new Promise(res => s.once('done', res));
    const r = await s.result;
    expect(r).toEqual({ success: false, reason: 'timeout' });
    await done;
    const pid = Number(f.read('login-pid'));
    expect(pid).toBeGreaterThan(0);
    await new Promise(res => setTimeout(res, 200));
    expect(alive(pid)).toBe(false);
    const runId = f.calls()[0]![4];
    await vi.waitFor(() => expect(f.calls()).toContainEqual(['stop-claude', '8', runId]), { timeout: 10_000 });
  });

  it('a URL outside the allow-list is never emitted', async () => {
    const { f, runner } = setup(800);
    f.set('login-mode', 'evil');
    const s = runner.login(8);
    const urls: string[] = [];
    s.on('url', u => urls.push(u));
    await s.result;
    expect(urls).toEqual([]);
    expect(s.url).toBeUndefined();
  });

  it('cancel stops the login', async () => {
    const { f, runner } = setup();
    f.set('login-mode', 'hang');
    const s = runner.login(8);
    await new Promise(res => s.once('url', res));
    s.cancel();
    expect(await s.result).toEqual({ success: false, reason: 'cancelled' });
  });
});

describe('LocalSeatRunner login', () => {
  it('is not available in local mode', () => {
    expect(() => new LocalSeatRunner(loadConfig({ DEVFLOW_MODE: 'local' })).login(1)).toThrow(/local/i);
  });
});

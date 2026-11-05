import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClaude, detectRateLimit, validateShellArgs, needsShell, claudeEnv } from '../../src/claude/runner.js';
import { setMockHandler, clearMockHandler } from '../../src/claude/mock.js';
import type { Config } from '../../src/config.js';

const fixture = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
function cfg(mode: string, over: Partial<Config> = {}): Config {
  return { claudeBin: process.execPath, claudeBinArgs: [fixture, mode], claudeMock: false, rateLimitPauseMin: 30, ...over } as Config;
}
afterEach(() => clearMockHandler());

describe('runClaude', () => {
  it('parses stream-json result and session id', async () => {
    const events: string[] = [];
    const r = await runClaude(cfg('ok'), { cwd: process.cwd(), prompt: 'hi', addDirs: ['/x'], resumeSessionId: 'abc', onEvent: l => events.push(l) });
    expect(r.ok).toBe(true);
    expect(r.sessionId).toBe('sess-123');
    const parsed = JSON.parse(r.resultText);
    expect(parsed.prompt).toBe('hi');
    expect(parsed.args).toContain('stream-json');
    expect(parsed.args).toContain('--add-dir');
    expect(parsed.args).toContain('abc');
    expect(events.some(e => e.includes('hello there'))).toBe(true);
  });
  it('passes long prompts via stdin', async () => {
    const big = 'x'.repeat(9000);
    const r = await runClaude(cfg('ok'), { cwd: process.cwd(), prompt: big });
    const parsed = JSON.parse(r.resultText);
    expect(parsed.prompt.trim()).toBe(big);
    expect(parsed.args).not.toContain(big);
  });
  it('writes raw lines to logFile', async () => {
    const f = join(mkdtempSync(join(tmpdir(), 'df-')), 'log.jsonl');
    await runClaude(cfg('ok'), { cwd: process.cwd(), prompt: 'hi', logFile: f });
    expect(readFileSync(f, 'utf8')).toContain('sess-123');
  });
  it('flags rate limit from result text', async () => {
    const r = await runClaude(cfg('ratelimit'), { cwd: process.cwd(), prompt: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.rateLimitedUntil).toBeInstanceOf(Date);
  });
  it('flags rate limit from stderr', async () => {
    const r = await runClaude(cfg('stderr-limit'), { cwd: process.cwd(), prompt: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.rateLimitedUntil).toBeInstanceOf(Date);
  });
  it('timeout kills process -> ok:false', async () => {
    const t = Date.now();
    const r = await runClaude(cfg('hang'), { cwd: process.cwd(), prompt: 'hi', timeoutMs: 500 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timeout/i);
    expect(Date.now() - t).toBeLessThan(10000);
  });
  it('abort signal stops the run', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const r = await runClaude(cfg('hang'), { cwd: process.cwd(), prompt: 'hi', signal: ac.signal });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/abort/i);
  });
  it('mock handler used when claudeMock', async () => {
    setMockHandler(o => ({ ok: true, resultText: 'mocked:' + o.prompt }));
    const r = await runClaude(cfg('ok', { claudeMock: true }), { cwd: '.', prompt: 'p' });
    expect(r.resultText).toBe('mocked:p');
  });
  it('throws when claudeMock without handler', async () => {
    await expect(runClaude(cfg('ok', { claudeMock: true }), { cwd: '.', prompt: 'p' })).rejects.toThrow(/mock/i);
  });
});

describe('runner robustness', () => {
  it('ignores stderr rate-limit text on a successful result', async () => {
    const r = await runClaude(cfg('ok-stderr-limit'), { cwd: process.cwd(), prompt: 'hi' });
    expect(r.ok).toBe(true);
    expect(r.rateLimitedUntil).toBeUndefined();
  });
  it('joins lines split across chunks', async () => {
    const r = await runClaude(cfg('partial'), { cwd: process.cwd(), prompt: 'hi' });
    expect(r.ok).toBe(true);
    expect(r.resultText).toBe('joined');
  });
  it('missing result -> ok:false with error', async () => {
    const r = await runClaude(cfg('noresult'), { cwd: process.cwd(), prompt: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/without a result/);
    expect(r.sessionId).toBe('s-n');
  });
  it('detects rate limit in non-JSON stdout', async () => {
    const r = await runClaude(cfg('plain-limit'), { cwd: process.cwd(), prompt: 'hi' });
    expect(r.rateLimitedUntil).toBeInstanceOf(Date);
  });
  it('onEvent errors do not break the run', async () => {
    const r = await runClaude(cfg('ok'), { cwd: process.cwd(), prompt: 'hi', onEvent: () => { throw new Error('boom'); } });
    expect(r.ok).toBe(true);
  });
  it('validateShellArgs rejects shell metacharacters', () => {
    expect(() => validateShellArgs(['C:\\my dir\\x', 'abc-1.2'])).not.toThrow();
    for (const bad of ['a&calc', 'a"b', 'a|b', '%PATH%', 'a^b', 'a\nb']) expect(() => validateShellArgs([bad])).toThrow(/unsafe/i);
  });
  it('validateShellArgs accepts Vietnamese and Program Files (x86) paths; quotes still rejected', () => {
    expect(() => validateShellArgs(['D:\\Dữ liệu\\Dự án mới\\workspaces\\REQ-001', 'C:\\Program Files (x86)\\claude\\claude.cmd'])).not.toThrow();
    for (const bad of ['D:\\Dữ liệu\\"x', "a'b\"c", 'Dự&án', 'a<b', 'a>b', 'a!b']) expect(() => validateShellArgs([bad])).toThrow(/unsafe/i);
  });
  it('needsShell: bare name or .cmd/.bat on Windows only', () => {
    expect(needsShell('claude', 'win32')).toBe(true);
    expect(needsShell('C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd', 'win32')).toBe(true);
    expect(needsShell('C:\\tools\\CLAUDE.BAT', 'win32')).toBe(true);
    expect(needsShell('claude.CMD', 'win32')).toBe(true);
    expect(needsShell('C:\\tools\\claude.exe', 'win32')).toBe(false);
    expect(needsShell('C:\\tools\\claude', 'win32')).toBe(false);
    expect(needsShell('claude', 'linux')).toBe(false);
    expect(needsShell('/x/claude.cmd', 'linux')).toBe(false);
  });
  it.runIf(process.platform === 'win32')('runs a .cmd shim in a Vietnamese folder through cmd.exe', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'df-')), 'Thư mục Claude');
    mkdirSync(dir, { recursive: true });
    const shim = join(dir, 'claude.cmd');
    writeFileSync(shim, `@"${process.execPath}" "${fixture}" ok %*\r\n`);
    try {
      const r = await runClaude(cfg('ok', { claudeBin: shim, claudeBinArgs: [] }), { cwd: process.cwd(), prompt: 'xin chào', addDirs: [dir] });
      expect(r.error).toBeUndefined();
      expect(r.ok).toBe(true);
      const parsed = JSON.parse(r.resultText);
      expect(parsed.prompt.trim()).toBe('xin chào'); // shell mode → prompt via stdin
      expect(parsed.args).toContain(dir);
    } finally { rmSync(join(dir, '..'), { recursive: true, force: true }); }
  });
  it('Claude does not inherit DevFlow secrets, GitLab credentials or git auth config', async () => {
    const keys = ['SECRET_KEY', 'GITLAB_TOKEN', 'GITLAB_URL', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'CLAUDE_MOCK', 'CLAUDE_BIN_ARGS'];
    const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    for (const k of keys) process.env[k] = `leak-${k}`;
    try {
      const r = await runClaude(cfg('env'), { cwd: process.cwd(), prompt: 'hi' });
      expect(r.ok).toBe(true);
      const env = JSON.parse(r.resultText) as Record<string, string>;
      for (const k of keys) expect(env[k], k).toBeUndefined();
      expect(r.resultText).not.toContain('leak-');
      expect(Object.keys(env).some(k => k.toUpperCase() === 'PATH')).toBe(true);
    } finally {
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
    expect(claudeEnv({ PATH: '/bin', gitlab_token: 'x', Secret_Key: 'y', GITLAB_DEFAULT_GROUP: 'g', HOME: '/h' })).toEqual({ PATH: '/bin', HOME: '/h' });
  });
});

describe('detectRateLimit', () => {
  const now = new Date(2026, 10, 4, 10, 0, 0);
  it('parses reset time 3pm', () => {
    const d = detectRateLimit('Usage limit reached. Your limit resets 3pm', now, 30)!;
    expect(d.getHours()).toBe(15);
    expect(d.getDate()).toBe(4);
  });
  it('rolls to next day when time passed', () => {
    const d = detectRateLimit('rate limit, resets at 9am', now, 30)!;
    expect(d.getHours()).toBe(9);
    expect(d.getDate()).toBe(5);
  });
  it('parses minutes', () => {
    const d = detectRateLimit('5-hour limit reached, resets at 11:30pm', now, 30)!;
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(30);
  });
  it('defaults to now + pause', () => {
    const d = detectRateLimit('usage limit reached', now, 30)!;
    expect(d.getTime()).toBe(now.getTime() + 30 * 60000);
  });
  it('undefined when no limit', () => {
    expect(detectRateLimit('all fine', now, 30)).toBeUndefined();
  });
});

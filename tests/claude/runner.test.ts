import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClaude, detectRateLimit, validateShellArgs } from '../../src/claude/runner.js';
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

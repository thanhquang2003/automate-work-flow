import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('local defaults', () => {
    const c = loadConfig({});
    expect(c.mode).toBe('local');
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(3700);
    expect(c.claudeBin).toBe('claude');
    expect(c.claudeBinArgs).toEqual([]);
    expect(c.maxConcurrentJobs).toBe(1);
    expect(c.surveyTtlDays).toBe(14);
    expect(c.rateLimitPauseMin).toBe(30);
    expect(c.claudeMock).toBe(false);
  });

  it('server mode requires SECRET_KEY', () => {
    expect(() => loadConfig({ DEVFLOW_MODE: 'server' })).toThrow(/SECRET_KEY/);
    const c = loadConfig({ DEVFLOW_MODE: 'server', SECRET_KEY: 'k' });
    expect(c.host).toBe('0.0.0.0');
    expect(c.maxConcurrentJobs).toBe(2);
  });

  it('parses overrides', () => {
    const c = loadConfig({ CLAUDE_MOCK: '1', CLAUDE_BIN_ARGS: '["a.js","--x"]', PORT: '4000', GITLAB_URL: 'http://g' });
    expect(c.claudeMock).toBe(true);
    expect(c.claudeBinArgs).toEqual(['a.js', '--x']);
    expect(c.port).toBe(4000);
    expect(c.gitlab.url).toBe('http://g');
  });
});

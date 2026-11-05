import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadDotEnv, parseDeptEmails } from '../src/config.js';

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

  it('server mode requires SECRET_KEY and PUBLIC_BASE_URL', () => {
    const G = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec' };
    expect(() => loadConfig({ DEVFLOW_MODE: 'server', PUBLIC_BASE_URL: 'https://df.example.com', ...G })).toThrow(/SECRET_KEY/);
    expect(() => loadConfig({ DEVFLOW_MODE: 'server', SECRET_KEY: 'k', ...G })).toThrow(/PUBLIC_BASE_URL/);
    expect(() => loadConfig({ DEVFLOW_MODE: 'server', SECRET_KEY: 'k', PUBLIC_BASE_URL: '  ', ...G })).toThrow(/PUBLIC_BASE_URL/);
    const c = loadConfig({ DEVFLOW_MODE: 'server', SECRET_KEY: 'k', PUBLIC_BASE_URL: 'https://df.example.com', ...G });
    expect(c.host).toBe('0.0.0.0');
    expect(c.maxConcurrentJobs).toBe(4);
    expect(c.publicBaseUrl).toBe('https://df.example.com');
    expect(loadConfig({}).publicBaseUrl).toBe('http://localhost:3700'); // local mode keeps the default
  });

  it('STAGE_TIMEOUT_MIN defaults to 120 minutes; 0 disables; negative rejected', () => {
    expect(loadConfig({}).stageTimeoutMin).toBe(120);
    expect(loadConfig({ STAGE_TIMEOUT_MIN: '45' }).stageTimeoutMin).toBe(45);
    expect(loadConfig({ STAGE_TIMEOUT_MIN: '0' }).stageTimeoutMin).toBe(0);
    expect(() => loadConfig({ STAGE_TIMEOUT_MIN: '-1' })).toThrow(/STAGE_TIMEOUT_MIN/);
  });

  it('parses overrides', () => {
    const c = loadConfig({ CLAUDE_MOCK: '1', CLAUDE_BIN_ARGS: '["a.js","--x"]', PORT: '4000', GITLAB_URL: 'http://g' });
    expect(c.claudeMock).toBe(true);
    expect(c.claudeBinArgs).toEqual(['a.js', '--x']);
    expect(c.port).toBe(4000);
    expect(c.gitlab.url).toBe('http://g');
  });
});

describe('v3 config', () => {
  it('parseDeptEmails valid and unknown department', () => {
    expect(parseDeptEmails('DEV:a@x,b@x;SGLOBAL:c@x')).toEqual({ DEV: ['a@x', 'b@x'], SGLOBAL: ['c@x'] });
    expect(parseDeptEmails('')).toEqual({ DEV: [], SGLOBAL: [] });
    expect(() => parseDeptEmails('HR:a@x')).toThrow(/Unknown department/);
  });

  it('config parses all new env vars', () => {
    const c = loadConfig({
      GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec', PUBLIC_BASE_URL: 'https://df.example.com',
      ALLOWED_EMAIL_DOMAINS: 'Example.com, corp.example.com', ADMIN_EMAILS: 'Ad@example.com', CTO_EMAILS: 'cto@example.com',
      HEAD_EMAILS: 'DEV:h@example.com', DEPUTY_EMAILS: 'SGLOBAL:d@example.com;DEV:e@example.com',
      PROJECT_ROOTS: '/srv/a, /srv/b', SEAT_CONCURRENCY: '2', DFCTL_PATH: '/usr/local/sbin/dfctl', BREAKGLASS_ADMIN: 'root',
    });
    expect(c.google).toEqual({ clientId: 'id', clientSecret: 'sec' });
    expect(c.allowedEmailDomains).toEqual(['example.com', 'corp.example.com']);
    expect(c.adminEmails).toEqual(['ad@example.com']);
    expect(c.ctoEmails).toEqual(['cto@example.com']);
    expect(c.headEmails).toEqual({ DEV: ['h@example.com'], SGLOBAL: [] });
    expect(c.deputyEmails).toEqual({ DEV: ['e@example.com'], SGLOBAL: ['d@example.com'] });
    expect(c.projectRoots).toEqual(['/srv/a', '/srv/b']);
    expect(c.seatConcurrency).toBe(2);
    expect(c.dfctlPath).toBe('/usr/local/sbin/dfctl');
    expect(c.breakglassAdmin).toBe('root');
    expect(loadConfig({}).seatConcurrency).toBe(1);
  });

  it('server mode requires google settings', () => {
    const e = { DEVFLOW_MODE: 'server', SECRET_KEY: 'k', PUBLIC_BASE_URL: 'https://df.example.com' };
    expect(() => loadConfig(e)).toThrow(/GOOGLE_CLIENT_ID/);
    expect(() => loadConfig({ ...e, GOOGLE_CLIENT_ID: 'id' })).toThrow(/GOOGLE_CLIENT_SECRET/);
    expect(loadConfig({ ...e, GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's' }).mode).toBe('server');
  });
});

describe('loadDotEnv', () => {
  it('reads .env without overriding variables that are already set; missing file is fine', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devflow-env-'));
    const file = join(dir, '.env');
    writeFileSync(file, '# ghi chú\nPORT=3999\nDEVFLOW_MODE=server\nSECRET_KEY="abc def"\n');
    const env: Record<string, string | undefined> = { DEVFLOW_MODE: 'local' };
    loadDotEnv(file, env);
    expect(env).toEqual({ DEVFLOW_MODE: 'local', PORT: '3999', SECRET_KEY: 'abc def' });
    expect(() => loadDotEnv(join(dir, 'none.env'), {})).not.toThrow();
  });
});

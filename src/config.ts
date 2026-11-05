export interface Config {
  mode: 'local' | 'server';
  host: string;
  port: number;
  dataDir: string;
  secretKey: string;
  claudeBin: string;
  /** Prefix args passed before claude's own args (used by tests, e.g. ["fake-claude.js"]). */
  claudeBinArgs: string[];
  claudeMock: boolean;
  maxConcurrentJobs: number;
  surveyTtlDays: number;
  publicBaseUrl: string;
  gitlab: { url: string; token: string; defaultGroup: string };
  rateLimitPauseMin: number;
  /** Per-file upload cap in bytes (default 50MB); overridable for tests. */
  maxUploadBytes?: number;
}

type Env = Record<string, string | undefined>;

function int(v: string | undefined, def: number): number {
  if (v === undefined || v.trim() === '') return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Invalid number: ${v}`);
  return n;
}

function parseArgs(v: string | undefined): string[] {
  if (!v || v.trim() === '') return [];
  const t = v.trim();
  if (t.startsWith('[')) {
    const arr: unknown = JSON.parse(t);
    if (!Array.isArray(arr) || !arr.every(x => typeof x === 'string')) throw new Error('CLAUDE_BIN_ARGS must be a JSON string array');
    return arr;
  }
  return t.split(/\s+/);
}

export function loadConfig(env: Env = process.env): Config {
  const modeRaw = (env.DEVFLOW_MODE || 'local').toLowerCase();
  if (modeRaw !== 'local' && modeRaw !== 'server') throw new Error(`DEVFLOW_MODE must be local|server, got ${modeRaw}`);
  const mode = modeRaw;
  const secretKey = env.SECRET_KEY ?? '';
  if (mode === 'server' && !secretKey) throw new Error('SECRET_KEY is required in server mode');
  const port = int(env.PORT, 3700);
  return {
    mode,
    host: env.HOST || (mode === 'server' ? '0.0.0.0' : '127.0.0.1'),
    port,
    dataDir: env.DATA_DIR || './data',
    secretKey,
    claudeBin: env.CLAUDE_BIN || 'claude',
    claudeBinArgs: parseArgs(env.CLAUDE_BIN_ARGS),
    claudeMock: env.CLAUDE_MOCK === '1' || env.CLAUDE_MOCK === 'true',
    maxConcurrentJobs: int(env.MAX_CONCURRENT_JOBS, mode === 'server' ? 2 : 1),
    surveyTtlDays: int(env.SURVEY_TTL_DAYS, 14),
    publicBaseUrl: env.PUBLIC_BASE_URL || `http://localhost:${port}`,
    gitlab: { url: env.GITLAB_URL ?? '', token: env.GITLAB_TOKEN ?? '', defaultGroup: env.GITLAB_DEFAULT_GROUP ?? '' },
    rateLimitPauseMin: int(env.RATE_LIMIT_PAUSE_MIN, 30),
  };
}

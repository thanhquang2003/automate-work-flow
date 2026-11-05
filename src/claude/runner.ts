import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import type { Config } from '../config.js';
import { runMock } from './mock.js';

export interface RunOpts {
  cwd: string;
  prompt: string;
  addDirs?: string[];
  resumeSessionId?: string;
  onEvent?: (line: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Raw stdout stream lines are appended here. */
  logFile?: string;
}
export interface RunResult {
  ok: boolean;
  sessionId?: string;
  resultText: string;
  rateLimitedUntil?: Date;
  error?: string;
}

const LIMIT_RE = /(usage limit|rate limit|limit reached|5-hour limit)/i;
const RESET_RE = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;
const PROMPT_ARGV_MAX = 8000;

export function detectRateLimit(text: string, now: Date, defaultPauseMin: number): Date | undefined {
  if (!LIMIT_RE.test(text)) return undefined;
  const m = RESET_RE.exec(text);
  if (m) {
    let h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    const ap = m[3]?.toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h <= 23 && min <= 59) {
      const d = new Date(now);
      d.setHours(h, min, 0, 0);
      if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
      return d;
    }
  }
  return new Date(now.getTime() + defaultPauseMin * 60000);
}

// Letters/digits of any script (e.g. Vietnamese folder names), Windows path characters and a few safe marks.
// Quotes, %, ^, &, |, <, >, ! and control characters never reach cmd.exe.
const SAFE_SHELL_ARG = /^[\p{L}\p{N}_ .:\\/@=+()-]+$/u;

/** In cmd.exe shell mode, reject args that could be interpreted by the shell. Throws on violation. */
export function validateShellArgs(parts: string[]): void {
  for (const a of parts) {
    if (!SAFE_SHELL_ARG.test(a)) throw new Error(`Unsafe argument for shell execution: ${JSON.stringify(a)}`);
  }
}

/**
 * True when the Claude command must be started through cmd.exe: on Windows, a bare command name (the npm shim
 * `claude` resolves to claude.cmd via PATHEXT) or an explicit .cmd/.bat file.
 */
export function needsShell(bin: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false;
  if (/\.(cmd|bat)$/i.test(bin)) return true;
  return !/[\\/]/.test(bin) && !/\.[A-Za-z0-9]+$/.test(bin);
}

/** Never passed to Claude: DevFlow secrets, GitLab credentials, git auth headers (GIT_CONFIG_*), test hooks. */
const HIDDEN_ENV = /^(SECRET_KEY|GITLAB_.*|GIT_CONFIG_.*|CLAUDE_MOCK|CLAUDE_BIN_ARGS)$/i;

/** `env` minus HIDDEN_ENV (Claude runs with bypassPermissions and can read its own environment). */
export function claudeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!HIDDEN_ENV.test(k)) out[k] = v;
  return out;
}

const MAX_BUF = 10 * 1024 * 1024;

function quoteCmd(a: string): string {
  if (a !== '' && !/[\s"&|<>^%()]/.test(a)) return a;
  return '"' + a.replace(/"/g, '\\"') + '"';
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => { /* ignore */ });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  }
}

function summarize(ev: any): string | undefined {
  const parts = ev?.message?.content;
  if (!Array.isArray(parts)) return undefined;
  const out: string[] = [];
  for (const p of parts) {
    if (p?.type === 'text' && typeof p.text === 'string') out.push(p.text);
    else if (p?.type === 'tool_use') out.push(`[tool: ${p.name}]`);
  }
  const s = out.join(' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 200) : undefined;
}

export async function runClaude(cfg: Config, opts: RunOpts): Promise<RunResult> {
  if (cfg.claudeMock) return runMock(opts);

  const rest = ['--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions'];
  for (const d of opts.addDirs ?? []) rest.push('--add-dir', d);
  if (opts.resumeSessionId) rest.push('--resume', opts.resumeSessionId);

  // On Windows the claude shim is a .cmd file and needs a shell. Quoting a prompt through cmd.exe is
  // unreliable, so in shell mode (and for long prompts) the prompt goes via stdin.
  const shell = needsShell(cfg.claudeBin);
  const viaStdin = shell || opts.prompt.length > PROMPT_ARGV_MAX;
  if (shell) {
    try { validateShellArgs([cfg.claudeBin, ...cfg.claudeBinArgs, ...(opts.addDirs ?? []), ...(opts.resumeSessionId ? [opts.resumeSessionId] : [])]); }
    catch (e) { return { ok: false, resultText: '', error: (e as Error).message }; }
  }
  const args = [...cfg.claudeBinArgs, '-p', ...(viaStdin ? [] : [opts.prompt]), ...rest];

  return new Promise<RunResult>(resolve => {
    let child: ChildProcess;
    const env = claudeEnv();
    try {
      child = shell
        ? spawn([cfg.claudeBin, ...args].map(quoteCmd).join(' '), { cwd: opts.cwd, env, shell: true, stdio: 'pipe', windowsHide: true })
        : spawn(cfg.claudeBin, args, { cwd: opts.cwd, env, stdio: 'pipe', windowsHide: true, detached: process.platform !== 'win32' });
    } catch (e) {
      return resolve({ ok: false, resultText: '', error: `spawn failed: ${(e as Error).message}` });
    }

    let sessionId: string | undefined;
    let resultText = '';
    let isError: boolean | undefined;
    let sawResult = false;
    let stderr = '';
    let buf = '';
    let plain = '';
    let forced: string | undefined;
    let settled = false;

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      if (opts.logFile) { try { appendFileSync(opts.logFile, line + '\n'); } catch { /* ignore */ } }
      let ev: any;
      try { ev = JSON.parse(line); } catch { if (plain.length < 20000) plain += line + '\n'; return; }
      if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.session_id === 'string') sessionId = ev.session_id;
      else if (ev.type === 'assistant') {
        const s = summarize(ev);
        if (s) { try { opts.onEvent?.(s); } catch { /* listener errors must not break the run */ } }
      } else if (ev.type === 'result') {
        sawResult = true;
        resultText = typeof ev.result === 'string' ? ev.result : '';
        isError = !!ev.is_error;
        if (typeof ev.session_id === 'string' && !sessionId) sessionId = ev.session_id;
      }
    };

    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      buf += d;
      if (buf.length > MAX_BUF && buf.indexOf('\n') < 0) { buf = ''; if (plain.length < 20000) plain += '[devflow: oversized line dropped]\n'; return; }
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (d: string) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    child.stdin!.on('error', () => { /* child may exit early */ });
    if (viaStdin) child.stdin!.end(opts.prompt); else child.stdin!.end();

    const fail = (reason: string) => { forced = reason; killTree(child); };
    const timer = opts.timeoutMs ? setTimeout(() => fail(`timeout after ${opts.timeoutMs}ms`), opts.timeoutMs) : undefined;
    const onAbort = () => fail('aborted');
    if (opts.signal) {
      if (opts.signal.aborted) onAbort(); else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (code: number | null, spawnErr?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (buf.trim()) handleLine(buf);
      const failedRun = !sawResult || !!isError;
      const limited = forced || !failedRun ? undefined
        : detectRateLimit(`${resultText}\n${plain}\n${stderr}`, new Date(), cfg.rateLimitPauseMin);
      let ok = sawResult && !isError && !forced;
      let error: string | undefined;
      if (limited) { ok = false; error = 'rate limited'; }
      else if (forced) error = forced;
      else if (spawnErr) error = `spawn failed: ${spawnErr.message}`;
      else if (!sawResult) error = `claude exited (code ${code}) without a result${stderr ? ': ' + stderr.trim().slice(-500) : ''}`;
      else if (isError) error = resultText || 'claude reported an error';
      resolve({ ok, sessionId, resultText, ...(limited ? { rateLimitedUntil: limited } : {}), ...(error ? { error } : {}) });
    };
    child.on('error', e => finish(null, e));
    child.on('close', code => finish(code));
  });
}

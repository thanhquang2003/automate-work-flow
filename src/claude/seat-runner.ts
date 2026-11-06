import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { Config } from '../config.js';
import { claudeEnv, claudeRunArgs, runClaude, runClaudeCommand, type RunOpts, type RunResult } from './runner.js';
import { LOGIN_TIMEOUT_MS, ProcessLoginSession, type LoginSession } from './seat-login.js';

/**
 * Where a Claude run executes (spec v3 §5.2, §6b.2). Local mode: the machine's own Claude login (v2).
 * Server mode: the responsible person's seat, i.e. the original `claude` binary as OS user `dfu-<id>`
 * through `sudo -n dfctl`. DevFlow never sees seat credentials; it only reads status lines.
 */
export type SeatState = 'connected' | 'expired' | 'disconnected' | 'unknown';
export interface SeatStatus {
  state: SeatState;
  /** Account e-mail / organisation as reported by `claude auth status` (never credentials). */
  email?: string;
  org?: string;
}

export interface SeatRunner {
  readonly kind: 'local' | 'sudo';
  /**
   * Runs Claude for `userId` (null only in local mode). `opts.signal` stops the run: the result then has
   * `aborted: true` (not a failure, no seatError). A failed login gives `seatError`.
   */
  run(userId: number | null, opts: RunOpts): Promise<RunResult>;
  /** Starts `claude auth login` for the seat. Not available in local mode. */
  login(userId: number): LoginSession;
  status(userId: number): Promise<SeatStatus>;
  logout(userId: number): Promise<void>;
  /**
   * Root-side sweep of a project's git dirs (dfctl sweep-project). Must be awaited before DevFlow runs git
   * on a project after a seat run that did not end normally (aborted/timeout) and before git on a worktree.
   * Throws SeatSweepError when the sweep fails. No-op in local mode.
   */
  sweepProject(projectId: number, worktree?: string): Promise<void>;
}

export function newRunId(): string { return randomBytes(12).toString('hex'); }

/** dfctl exit status when the project's git dirs failed the root-side sweep (ops/dfctl SWEEP_FAILED). */
export const DFCTL_SWEEP_FAILED = 86;

/**
 * The project's git dirs failed dfctl's sweep (symlink/hard link/foreign entry/replaced pack left after a
 * seat run). A hard error: DevFlow must not run git on that project until an admin has looked at it.
 */
export class SeatSweepError extends Error {}

function assertUserId(userId: unknown): asserts userId is number {
  if (typeof userId !== 'number' || !Number.isInteger(userId) || userId < 1 || userId > 999_999_999) {
    throw new Error(`Invalid seat user id: ${String(userId)}`);
  }
}

const str = (v: unknown, max = 200): string | undefined =>
  typeof v === 'string' && v.trim() && v.length <= max && !/[\x00-\x1f]/.test(v) ? v.trim() : undefined;

/**
 * Interprets `claude auth status` output. Only whitelisted fields (email, organisation name) are copied;
 * raw output never ends up in the status.
 */
export function parseAuthStatus(out: string, exitCode: number | null): SeatStatus {
  const text = (out ?? '').trim();
  const brace = text.indexOf('{');
  if (brace >= 0) {
    try {
      const j = JSON.parse(text.slice(brace)) as Record<string, unknown>;
      if (typeof j.loggedIn === 'boolean') {
        if (!j.loggedIn) return { state: /expired/i.test(String(j.reason ?? '')) ? 'expired' : 'disconnected' };
        const email = str(j.email) ?? str((j.account as Record<string, unknown> | undefined)?.email);
        const org = str(j.orgName) ?? str(j.organizationName) ?? str((j.organization as Record<string, unknown> | undefined)?.name);
        return { state: 'connected', ...(email ? { email } : {}), ...(org ? { org } : {}) };
      }
    } catch { /* not JSON: fall through to text */ }
  }
  if (/expired/i.test(text)) return { state: 'expired' };
  if (/(not logged in|logged out|no credentials|please (?:run|log) ?in|run `?claude (?:auth )?login)/i.test(text)) return { state: 'disconnected' };
  if (exitCode === 0 && /(logged in|login method|signed in)/i.test(text)) return { state: 'connected' };
  return { state: 'unknown' };
}

/** v2 behaviour: the Claude logged in on this machine; seat management is not available. */
export class LocalSeatRunner implements SeatRunner {
  readonly kind = 'local' as const;
  constructor(private cfg: Config) {}
  run(_userId: number | null, opts: RunOpts): Promise<RunResult> { return runClaude(this.cfg, opts); }
  login(): LoginSession { throw new Error('Seat login is not available in local mode (Claude of this machine is used).'); }
  async status(): Promise<SeatStatus> { return { state: 'unknown' }; }
  async logout(): Promise<void> { throw new Error('Seat logout is not available in local mode.'); }
  async sweepProject(): Promise<void> { /* local mode: no seats, nothing to sweep */ }
}

export interface SudoSeatRunnerOptions {
  /** sudo binary (tests use a fake that checks for -n). */
  sudoBin?: string;
  loginTimeoutMs?: number;
  /** Limit for status/logout calls. */
  execTimeoutMs?: number;
}

/** Server mode: every call goes through `sudo -n <dfctl> ...`. */
export class SudoSeatRunner implements SeatRunner {
  readonly kind = 'sudo' as const;
  private readonly sudo: string;

  constructor(private cfg: Pick<Config, 'dfctlPath' | 'rateLimitPauseMin'>, private o: SudoSeatRunnerOptions = {}) {
    this.sudo = o.sudoBin ?? 'sudo';
  }

  private dfctl(...args: string[]): string[] { return ['-n', this.cfg.dfctlPath, ...args]; }

  /** Best-effort stop of a dfctl-tracked run (DevFlow cannot signal processes of other users). */
  private stop(userId: number, runId: string): void {
    execFile(this.sudo, this.dfctl('stop-claude', String(userId), runId), { timeout: 30_000, env: claudeEnv() }, () => { /* ignore */ });
  }

  async run(userId: number | null, opts: RunOpts): Promise<RunResult> {
    assertUserId(userId);
    if (!isAbsolute(opts.cwd)) throw new Error('Seat run cwd must be an absolute path');
    // Already aborted: do not start sudo at all (dfctl could not be asked to stop a run it has not tracked yet).
    if (opts.signal?.aborted) return { ok: false, aborted: true, resultText: '', error: 'aborted' };
    const runId = newRunId();
    // Prompt always via stdin; CLAUDE_BIN_ARGS (a test hook) never reaches the seat binary.
    const args = this.dfctl('run-claude', String(userId), opts.cwd, '--run-id', runId, '--', '-p', ...claudeRunArgs(opts));
    const res = await runClaudeCommand(this.cfg, opts, {
      bin: this.sudo, args, cwd: '/', promptViaStdin: true, onKill: () => this.stop(userId, runId),
    });
    if (res.exitCode === DFCTL_SWEEP_FAILED) {
      throw new SeatSweepError(`dfctl: the project's git dirs failed the sweep after the run in ${opts.cwd}; DevFlow must not use this project until an admin checks it`);
    }
    return res;
  }

  login(userId: number): LoginSession {
    assertUserId(userId);
    const runId = newRunId();
    return new ProcessLoginSession({
      bin: this.sudo,
      args: this.dfctl('claude-auth', String(userId), 'login', '--run-id', runId),
      env: claudeEnv(),
      timeoutMs: this.o.loginTimeoutMs ?? LOGIN_TIMEOUT_MS,
      onKill: () => this.stop(userId, runId),
    });
  }

  private exec(args: string[], timeoutMs?: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise(resolve => {
      execFile(this.sudo, args, { timeout: timeoutMs ?? this.o.execTimeoutMs ?? 90_000, env: claudeEnv(), maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : null) : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
    });
  }

  async sweepProject(projectId: number, worktree?: string): Promise<void> {
    if (!Number.isInteger(projectId) || projectId < 1) throw new Error(`Invalid project id: ${String(projectId)}`);
    if (worktree !== undefined && !isAbsolute(worktree)) throw new Error('Worktree path must be absolute');
    const r = await this.exec(this.dfctl('sweep-project', String(projectId), ...(worktree ? [worktree] : [])), 15 * 60_000);
    if (r.code !== 0) {
      throw new SeatSweepError(`dfctl sweep-project ${projectId} failed (exit ${r.code}): ${r.stderr.trim().slice(-300)}`);
    }
  }

  async status(userId: number): Promise<SeatStatus> {
    assertUserId(userId);
    const r = await this.exec(this.dfctl('claude-auth', String(userId), 'status'));
    return parseAuthStatus(r.stdout, r.code);
  }

  async logout(userId: number): Promise<void> {
    assertUserId(userId);
    const r = await this.exec(this.dfctl('claude-auth', String(userId), 'logout'));
    if (r.code !== 0) throw new Error(`claude auth logout failed (exit ${r.code})`);
  }
}

export function createSeatRunner(cfg: Config): SeatRunner {
  return cfg.mode === 'server' ? new SudoSeatRunner(cfg) : new LocalSeatRunner(cfg);
}

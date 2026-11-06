import { execFile, spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { Config } from '../config.js';
import { claudeEnv } from '../claude/runner.js';

/** Where install-server.sh puts the privileged helper (sudoers allows exactly this path). */
export const DEFAULT_DFCTL_PATH = '/usr/local/lib/devflow/dfctl';

/**
 * OS side of v3 (spec §5.2, §6b.1-2): seat accounts `dfu-<userId>`, project groups `dfp-<projectId>`.
 * Structurally satisfies `ProjectSystemOps` (projects/service.ts) and `SystemOpsLike` (web/server.ts).
 * Every call is idempotent, so a failed call can simply be repeated (see projects/reconcile.ts).
 */
export interface SystemOps {
  provisionUser(userId: number): Promise<void>;
  ensureProjectGroup(projectId: number, path: string): Promise<void>;
  /** The complete set of users that may access the project folder after the call. */
  setMembers(projectId: number, userIds: number[]): Promise<void>;
}

export class SystemOpsError extends Error {}

/** Local mode and tests: no OS accounts or groups. */
export class NoopSystemOps implements SystemOps {
  async provisionUser(): Promise<void> { /* nothing */ }
  async ensureProjectGroup(): Promise<void> { /* nothing */ }
  async setMembers(): Promise<void> { /* nothing */ }
}

function id(v: unknown, what: string): string {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 999_999_999) throw new SystemOpsError(`Invalid ${what}: ${String(v)}`);
  return String(v);
}

export interface SudoSystemOpsOptions {
  dfctlPath: string;
  /** sudo binary (tests use a fake). */
  sudoBin?: string;
  timeoutMs?: number;
}

/** Server mode: `sudo -n <dfctl> <subcommand> ...` (arguments validated here and again in dfctl). */
export class SudoSystemOps implements SystemOps {
  constructor(private o: SudoSystemOpsOptions) {}

  private run(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(this.o.sudoBin ?? 'sudo', ['-n', this.o.dfctlPath, ...args], { timeout: this.o.timeoutMs ?? 300_000, env: claudeEnv(), maxBuffer: 256 * 1024 },
        (err, _stdout, stderr) => {
          if (!err) return resolve();
          const why = String(stderr ?? '').trim().slice(-500) || err.message;
          reject(new SystemOpsError(`dfctl ${args[0]} failed: ${why}`));
        });
    });
  }

  async provisionUser(userId: number): Promise<void> {
    await this.run(['provision-user', id(userId, 'user id')]);
  }

  async ensureProjectGroup(projectId: number, path: string): Promise<void> {
    const p = id(projectId, 'project id');
    if (typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new SystemOpsError('Project path must be absolute without control characters');
    await this.run(['ensure-project-group', p, path]);
  }

  async setMembers(projectId: number, userIds: number[]): Promise<void> {
    const p = id(projectId, 'project id');
    const users = [...new Set(userIds.map(u => id(u, 'user id')))].sort((a, b) => Number(a) - Number(b));
    await this.run(['set-members', p, ...users]);
  }
}

/**
 * Server mode must not start without a usable dfctl (spec §6b.7): Linux, absolute path, executable,
 * owned by root and not writable by group/others (otherwise the service user could rewrite it), and
 * `sudo -n <dfctl> --self-test` succeeding (sudoers rule in place, no password prompt).
 */
export type PrereqExec = (bin: string, args: string[]) => { status: number | null; stderr?: string };

const defaultPrereqExec: PrereqExec = (bin, args) => {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 120_000, env: claudeEnv() });
  return { status: r.status, stderr: String(r.stderr ?? '') + (r.error ? r.error.message : '') };
};

export function checkServerPrereqs(
  cfg: Pick<Config, 'mode' | 'dfctlPath'>,
  o: { platform?: NodeJS.Platform; requireRootOwned?: boolean; sudoBin?: string; exec?: PrereqExec } = {},
): void {
  if (cfg.mode !== 'server') return;
  const platform = o.platform ?? process.platform;
  if (platform !== 'linux') throw new Error(`Chế độ server chỉ chạy trên Linux (đang là ${platform}).`);
  const p = cfg.dfctlPath;
  if (!p || !isAbsolute(p)) throw new Error(`DFCTL_PATH phải là đường dẫn tuyệt đối (absolute), đang là "${p}".`);
  let st;
  try { st = statSync(p); } catch {
    throw new Error(`Không tìm thấy dfctl tại ${p}. Chạy scripts/install-server.sh (bằng root) trước khi bật chế độ server.`);
  }
  if (!st.isFile()) throw new Error(`dfctl tại ${p} không phải tệp.`);
  try { accessSync(p, constants.X_OK); } catch { throw new Error(`dfctl tại ${p} không có quyền thực thi (not executable).`); }
  if ((st.mode & 0o022) !== 0) throw new Error(`dfctl tại ${p} cho phép nhóm/người khác ghi (writable); cần chmod 0755.`);
  if ((o.requireRootOwned ?? true) && st.uid !== 0) throw new Error(`dfctl tại ${p} phải thuộc sở hữu root.`);
  // The sudoers rule must let this user run dfctl without a password; the self-test also proves dfctl works.
  const sudo = o.sudoBin ?? 'sudo';
  const r = (o.exec ?? defaultPrereqExec)(sudo, ['-n', p, '--self-test']);
  if (r.status !== 0) {
    const why = (r.stderr ?? '').trim().split('\n').slice(-3).join(' ').slice(0, 300);
    throw new Error(`Không chạy được "sudo -n ${p} --self-test" (exit ${r.status}): ${why || 'không rõ lỗi'}. Kiểm tra quy tắc sudoers cho dfctl (chạy lại scripts/install-server.sh).`);
  }
}

import type { Config } from './config.js';
import type { Repo } from './db/repo.js';
import type { RequestRow } from './domain/types.js';
import { GitLabClient } from './gitlab/client.js';
import { decrypt } from './security/crypto.js';
import { getSecretKey } from './security/secret.js';

const warned = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[devflow] ${msg}`);
}

export const SETTING_KEYS = {
  gitlabUrl: 'gitlab.url', gitlabToken: 'gitlab.token', gitlabDefaultGroup: 'gitlab.defaultGroup',
  maxConcurrentJobs: 'maxConcurrentJobs', claudeBin: 'claudeBin',
} as const;

/** Config with settings stored in the DB layered over the env-derived `cfg` (empty DB values are ignored). Does not mutate `cfg`. */
export function effectiveConfig(cfg: Config, repo: Repo): Config {
  const s = (k: string): string => (repo.getSetting(k) ?? '').trim();
  let token = cfg.gitlab.token;
  const enc = s(SETTING_KEYS.gitlabToken);
  if (enc) {
    try { token = decrypt(enc, getSecretKey(cfg)); } catch { warnOnce('gitlab.token', 'Không giải mã được token GitLab đã lưu trong cài đặt (khóa thay đổi?); dùng token từ biến môi trường.'); }
  }
  const maxJobs = Number.parseInt(s(SETTING_KEYS.maxConcurrentJobs), 10);
  return {
    ...cfg,
    claudeBin: s(SETTING_KEYS.claudeBin) || cfg.claudeBin,
    maxConcurrentJobs: Number.isFinite(maxJobs) && maxJobs >= 1 ? maxJobs : cfg.maxConcurrentJobs,
    gitlab: {
      url: s(SETTING_KEYS.gitlabUrl) || cfg.gitlab.url,
      token,
      defaultGroup: s(SETTING_KEYS.gitlabDefaultGroup) || cfg.gitlab.defaultGroup,
    },
  };
}

const bases = new WeakMap<Config, Config>();

/**
 * Applies DB settings onto the live `cfg` object (shared by Pipeline/Worker) so they take effect for new jobs.
 * The env-derived values are captured once per cfg object so cleared settings fall back to env.
 */
export function applySettings(cfg: Config, repo: Repo): void {
  let base = bases.get(cfg);
  if (!base) { base = { ...cfg, gitlab: { ...cfg.gitlab } }; bases.set(cfg, base); }
  Object.assign(cfg, effectiveConfig(base, repo));
}

/** GitLab client for a request: the creator's own token (from /me) wins over the shared token. */
export function gitlabFor(cfg: Config, repo: Repo, req: RequestRow): GitLabClient | undefined {
  const eff = effectiveConfig(bases.get(cfg) ?? cfg, repo);
  let token = eff.gitlab.token;
  if (req.createdBy !== null) {
    const enc = repo.getUser(req.createdBy)?.gitlabTokenEnc;
    if (enc) {
      try { token = decrypt(enc, getSecretKey(cfg)); } catch { warnOnce(`user.${req.createdBy}`, `Không giải mã được token GitLab cá nhân của người dùng #${req.createdBy}; dùng token chung.`); }
    }
  }
  return eff.gitlab.url && token ? new GitLabClient(eff.gitlab.url, token) : undefined;
}

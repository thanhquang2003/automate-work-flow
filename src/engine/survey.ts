import { randomBytes } from 'node:crypto';
import type { Config } from '../config.js';
import type { Repo } from '../db/repo.js';

const DAY_MS = 86_400_000;

export const surveyUrl = (cfg: Config, token: string): string => `${cfg.publicBaseUrl.replace(/\/+$/, '')}/s/${token}`;

/** Creates a survey link (32 random bytes, base64url) and returns it with its full public URL. */
export function createSurveyLink(repo: Repo, cfg: Config, reqId: string, round: number): { token: string; url: string; expiresAt: number } {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + cfg.surveyTtlDays * DAY_MS;
  repo.createSurveyLink({ token, requestId: reqId, round, expiresAt });
  return { token, expiresAt, url: surveyUrl(cfg, token) };
}

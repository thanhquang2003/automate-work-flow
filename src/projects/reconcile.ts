import type { Repo } from '../db/repo.js';
import { enabledMemberIds, type ProjectSystemOps } from './service.js';

export interface ReconcileResult {
  ok: number[];
  failed: { projectId: number; error: string }[];
}

/**
 * Brings the OS side in line with the database for every non-archived project: its Linux group exists and
 * holds exactly the current members. Idempotent; run at server start so that a failed `ensureProjectGroup`
 * or `setMembers` during createProject/setMembers heals on the next start. A project whose group could not
 * be ensured is skipped for membership (reported in `failed`); other projects continue.
 */
export async function reconcileProjects(repo: Repo, systemOps: ProjectSystemOps): Promise<ReconcileResult> {
  const out: ReconcileResult = { ok: [], failed: [] };
  for (const p of repo.listProjects()) {
    if (p.archived) continue;
    try {
      await systemOps.ensureProjectGroup(p.id, p.path);
      await systemOps.setMembers(p.id, enabledMemberIds(repo, p.id));
      out.ok.push(p.id);
    } catch (e) {
      out.failed.push({ projectId: p.id, error: (e as Error).message });
    }
  }
  return out;
}

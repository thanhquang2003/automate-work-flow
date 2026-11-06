import type { Config } from '../config.js';
import type { Repo } from '../db/repo.js';
import type { Pipeline } from '../engine/pipeline.js';
import type { GitLabClient } from '../gitlab/client.js';
import { ProjectService, type ProjectSystemOps } from './service.js';

/**
 * Builds the ProjectService and joins it with the Pipeline both ways: the service calls the engine before a member
 * leaves (their jobs stop and move first) and the pipeline's removeMember writes memberships through the service
 * (so the OS group changes too). Without this both sides silently do nothing.
 */
export function wireProjects(o: {
  cfg: Config; repo: Repo; pipeline: Pipeline; systemOps?: ProjectSystemOps; gitlabFor?: (userId: number) => GitLabClient | undefined;
}): ProjectService {
  const svc = new ProjectService({ cfg: o.cfg, repo: o.repo, ...(o.systemOps ? { systemOps: o.systemOps } : {}), ...(o.gitlabFor ? { gitlabFor: o.gitlabFor } : {}), engine: o.pipeline });
  o.pipeline.attachMembers(svc);
  return svc;
}

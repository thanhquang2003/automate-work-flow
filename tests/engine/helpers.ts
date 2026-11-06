import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../../src/config.js';
import { openDb } from '../../src/db/db.js';
import { Repo } from '../../src/db/repo.js';
import { Pipeline } from '../../src/engine/pipeline.js';
import { Worker } from '../../src/engine/worker.js';
import type { NewRequest } from '../../src/domain/types.js';
import { Git } from '../../src/gitlab/git.js';

export function setup(over: Partial<Config> = {}, nowFn?: () => number) {
  const cfg: Config = { ...loadConfig({ DEVFLOW_MODE: 'local', CLAUDE_MOCK: '1' }), dataDir: mkdtempSync(join(tmpdir(), 'devflow-eng-')), ...over };
  const repo = new Repo(openDb(':memory:'));
  const pipeline = new Pipeline(cfg, repo, { makeGit: (_r, ws) => new Git(ws.repoDir), allowLocalSeatsInServerMode: true, ...(nowFn ? { now: nowFn } : {}) });
  const worker = new Worker(cfg, repo, pipeline);
  return { cfg, repo, pipeline, worker };
}

export const mkReq = (repo: Repo, o: Partial<NewRequest> = {}) => repo.createRequest({
  title: 't', description: 'd', perfReq: '', nonfuncReq: '', projectKind: 'existing', gitlabProject: null,
  softwareTypes: ['web'], runMode: 'auto', createdBy: null, ...o,
});

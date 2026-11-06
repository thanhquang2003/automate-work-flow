import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createSeatRunner } from './claude/seat-runner.js';
import { loadConfig, loadDotEnv } from './config.js';
import { openDb } from './db/db.js';
import { Repo } from './db/repo.js';
import { Pipeline } from './engine/pipeline.js';
import { registerAllStages } from './engine/stages/index.js';
import { Worker } from './engine/worker.js';
import { reconcileProjects } from './projects/reconcile.js';
import { applySettings, gitlabFor } from './settings.js';
import { NoopSystemOps, SudoSystemOps, checkServerPrereqs, type SystemOps } from './system/ops.js';
import { buildServer } from './web/server.js';

async function main(): Promise<void> {
  loadDotEnv();
  const cfg = loadConfig();
  // Server mode needs the root-owned dfctl helper (Linux only); refuse to start without it.
  checkServerPrereqs(cfg);
  cfg.dataDir = resolve(cfg.dataDir);
  mkdirSync(cfg.dataDir, { recursive: true });
  const repo = new Repo(openDb(join(cfg.dataDir, 'devflow.db')));
  // Settings stored in the DB (Cài đặt page) override env; applied onto the shared cfg for new jobs.
  applySettings(cfg, repo);
  const pipeline = new Pipeline(cfg, repo, { makeGitLab: req => gitlabFor(cfg, repo, req) });
  registerAllStages();
  const systemOps: SystemOps = cfg.mode === 'server' ? new SudoSystemOps({ dfctlPath: cfg.dfctlPath }) : new NoopSystemOps();
  const seatRunner = createSeatRunner(cfg);
  if (cfg.mode === 'server') {
    // Heal Linux groups/members left behind by a failed ensureProjectGroup/setMembers (idempotent).
    const rec = await reconcileProjects(repo, systemOps);
    for (const f of rec.failed) console.error(`Không đồng bộ được nhóm Linux của dự án #${f.projectId}: ${f.error}`);
  }
  const worker = new Worker(cfg, repo, pipeline);
  worker.start();
  const app = await buildServer(cfg, { repo, pipeline, systemOps, seatRunner });
  await app.listen({ host: cfg.host, port: cfg.port });
  console.log(`DevFlow (${cfg.mode}) đang chạy tại http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}`);

  let stopping = false;
  const shutdown = (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`Nhận ${sig}, đang tắt...`);
    worker.stop();
    const force = setTimeout(() => process.exit(0), 5000);
    force.unref();
    app.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(e => { console.error(e); process.exit(1); });

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { openDb } from './db/db.js';
import { Repo } from './db/repo.js';
import { Pipeline } from './engine/pipeline.js';
import { registerAllStages } from './engine/stages/index.js';
import { Worker } from './engine/worker.js';
import { applySettings, gitlabFor } from './settings.js';
import { buildServer } from './web/server.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  cfg.dataDir = resolve(cfg.dataDir);
  mkdirSync(cfg.dataDir, { recursive: true });
  const repo = new Repo(openDb(join(cfg.dataDir, 'devflow.db')));
  // Settings stored in the DB (Cài đặt page) override env; applied onto the shared cfg for new jobs.
  applySettings(cfg, repo);
  const pipeline = new Pipeline(cfg, repo, { makeGitLab: req => gitlabFor(cfg, repo, req) });
  registerAllStages();
  const worker = new Worker(cfg, repo, pipeline);
  worker.start();
  const app = await buildServer(cfg, { repo, pipeline });
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

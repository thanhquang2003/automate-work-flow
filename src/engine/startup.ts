import type { Config } from '../config.js';
import type { Pipeline } from './pipeline.js';
import type { Worker } from './worker.js';

/**
 * Starts the job worker. Server mode first sweeps every project (dfctl, root side) so that no requeued job runs
 * DevFlow git on a worktree a seat touched before a crash; a project whose sweep fails stays blocked (I1).
 */
export async function startEngine(cfg: Config, pipeline: Pipeline, worker: Worker): Promise<void> {
  if (cfg.mode === 'server') {
    const res = await pipeline.startupSweep();
    for (const b of res.blocked) {
      console.error(`Kiểm tra an toàn khi khởi động (dfctl sweep) thất bại cho dự án #${b.projectId} — dự án bị dừng cho đến khi admin kiểm tra: ${b.error}`);
    }
    console.log(`Startup sweep: ${res.swept.length} dự án OK, ${res.blocked.length} dự án bị dừng.`);
  }
  worker.start();
}

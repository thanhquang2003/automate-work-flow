import type { Config } from '../config.js';
import type { Pipeline } from './pipeline.js';
import type { Worker } from './worker.js';

/**
 * Starts the job worker. Server mode gates every project and sweeps it (dfctl, root side) so that no requeued job
 * runs DevFlow git on a worktree a seat touched before a crash; the worker starts at once and each project's jobs
 * run as soon as its own sweep is done; a project whose sweep fails stays blocked (I1/I1b). Resolves when every
 * sweep has finished.
 */
export async function startEngine(cfg: Config, pipeline: Pipeline, worker: Worker): Promise<void> {
  if (cfg.mode === 'server') {
    const sweep = pipeline.startupSweep(); // gates are set synchronously, before the worker can claim a job
    worker.start();
    const res = await sweep;
    for (const b of res.blocked) {
      console.error(`Kiểm tra an toàn khi khởi động (dfctl sweep) thất bại cho dự án #${b.projectId} — dự án bị dừng cho đến khi admin kiểm tra: ${b.error}`);
    }
    console.log(`Startup sweep: ${res.swept.length} dự án OK, ${res.blocked.length} dự án bị dừng.`);
    return;
  }
  worker.start();
}

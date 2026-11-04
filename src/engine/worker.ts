import type { Config } from '../config.js';
import type { Repo } from '../db/repo.js';
import type { Pipeline } from './pipeline.js';

export class Worker {
  private running = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private cfg: Config, private repo: Repo, private pipeline: Pipeline) {}

  /** Recover jobs left running by a crash, then poll every second. */
  start(): void {
    this.repo.resetRunningJobs();
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Claim due jobs up to the concurrency limit and start them. Returns once they are launched (see idle()). */
  async tick(): Promise<void> {
    while (this.running.size < Math.max(1, this.cfg.maxConcurrentJobs)) {
      const job = this.repo.claimNextJob(this.pipeline.now());
      if (!job) break;
      const p: Promise<void> = this.pipeline.runJob(job)
        .catch(e => { this.repo.failJob(job.id, e instanceof Error ? e.message : String(e)); })
        .finally(() => { this.running.delete(p); });
      this.running.add(p);
    }
  }

  /** Resolves when no jobs are running. */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }

  /** Tick and wait until no more due jobs remain (test/maintenance helper). */
  async drain(): Promise<void> {
    for (;;) {
      await this.tick();
      if (!this.running.size) return;
      await this.idle();
    }
  }
}

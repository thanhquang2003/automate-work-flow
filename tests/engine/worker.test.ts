import { describe, it, expect, beforeEach } from 'vitest';
import { clearStages, registerStage } from '../../src/engine/pipeline.js';
import { setup, mkReq } from './helpers.js';

beforeEach(() => clearStages());

describe('worker', () => {
  it('concurrency limit respected', async () => {
    let running = 0, peak = 0;
    registerStage('INTAKE', async () => {
      running++; peak = Math.max(peak, running);
      await new Promise(r => setTimeout(r, 30));
      running--;
      return { kind: 'await_customer' };
    }, { gate: false });
    const { repo, pipeline, worker } = setup({ maxConcurrentJobs: 2 });
    for (let i = 0; i < 5; i++) pipeline.start(mkReq(repo).id);
    await worker.drain();
    expect(peak).toBe(2);
    expect(repo.listJobs().every(j => j.status === 'done')).toBe(true);
  });

  it('start resets running jobs', () => {
    const { repo, pipeline, worker } = setup();
    pipeline.start(mkReq(repo).id);
    repo.claimNextJob(Date.now());
    worker.start(); worker.stop();
    expect(repo.listJobs()[0].status).toBe('queued');
  });

  it('missing handler fails the stage', async () => {
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo);
    pipeline.start(r.id); // INTAKE has a default no-op, CODEBASE_SCAN has none
    await worker.drain();
    expect(repo.getRequest(r.id)!.status).toBe('failed');
  });
});

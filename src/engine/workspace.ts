import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Config } from '../config.js';

export class Workspace {
  readonly repoDir: string;
  readonly inputsDir: string;
  readonly artifactsDir: string;
  readonly evidenceDir: string;
  readonly logsDir: string;
  readonly devflowDir: string;

  private constructor(readonly root: string) {
    this.repoDir = join(root, 'repo');
    this.inputsDir = join(root, 'inputs');
    this.artifactsDir = join(root, 'artifacts');
    this.evidenceDir = join(root, 'evidence');
    this.logsDir = join(root, 'logs');
    this.devflowDir = join(this.repoDir, 'docs', 'devflow');
  }

  static for(cfg: Config, reqId: string): Workspace {
    if (!/^[\w.-]+$/.test(reqId) || reqId.includes('..')) throw new Error(`Invalid request id: ${reqId}`);
    return new Workspace(resolve(cfg.dataDir, 'workspaces', reqId));
  }

  ensure(): this {
    for (const d of [this.root, this.repoDir, this.inputsDir, this.artifactsDir, this.evidenceDir, this.logsDir]) mkdirSync(d, { recursive: true });
    return this;
  }
}

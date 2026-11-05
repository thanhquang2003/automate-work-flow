import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setMockHandler } from '../../src/claude/mock.js';
import type { RunOpts, RunResult } from '../../src/claude/runner.js';
import { clearStages, registerStage, type Pipeline } from '../../src/engine/pipeline.js';
import { registerAllStages } from '../../src/engine/stages/index.js';
import type { Stage } from '../../src/domain/types.js';

/** Shared harness for stage tests: mock Claude by role, real git repos, stage registration. */

export const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

export type Call = { role: string; prompt: string; opts: RunOpts };

/** Every mock Claude call of the current test (reset with resetCalls in beforeEach). */
export const calls: Call[] = [];
export function resetCalls(): void { calls.length = 0; }

export function roleOf(prompt: string): string {
  return /^ROLE: (\S+)/.exec(prompt)?.[1] ?? '?';
}

/** Absolute output paths listed in the prompt's "Đầu ra bắt buộc" section (lines "- `path` — …"). */
export function outputPaths(prompt: string): string[] {
  const i = prompt.indexOf('## Đầu ra bắt buộc');
  if (i < 0) return [];
  return [...prompt.slice(i).matchAll(/^- `([^`]+)` — /gm)].map(m => m[1]!);
}

/** Install a mock Claude: `fx[role]` writes fixture files (dir = docs/devflow under cwd = repo dir). */
export function mockClaude(fx: Record<string, (dir: string, call: Call) => void | RunResult>): void {
  setMockHandler((opts: RunOpts): RunResult => {
    const role = roleOf(opts.prompt);
    const call = { role, prompt: opts.prompt, opts };
    calls.push(call);
    const dir = join(opts.cwd, 'docs', 'devflow');
    mkdirSync(dir, { recursive: true });
    const r = fx[role]?.(dir, call);
    return r ?? { ok: true, resultText: 'ok' };
  });
}

/** Registers the real handlers and stubs the given stages so a test can stop the flow there. */
export function register(stubs: Stage[] = []): void {
  clearStages();
  registerAllStages();
  for (const s of stubs) registerStage(s, async () => ({ kind: 'needs_human', reason: `stub ${s}` }), { gate: false });
}

export function startAt(pipeline: Pipeline, reqId: string, stage: Stage): void {
  pipeline.rerunStage(reqId, stage);
}

export function initRepo(dir: string, branch: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', branch);
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
}

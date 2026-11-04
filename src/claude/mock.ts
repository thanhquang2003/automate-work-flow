import type { RunOpts, RunResult } from './runner.js';

export type MockHandler = (opts: RunOpts) => Promise<RunResult> | RunResult;

let handler: MockHandler | undefined;

export function setMockHandler(fn: MockHandler): void { handler = fn; }
export function clearMockHandler(): void { handler = undefined; }

export async function runMock(opts: RunOpts): Promise<RunResult> {
  if (!handler) throw new Error('CLAUDE_MOCK is enabled but no mock handler is set (call setMockHandler first)');
  return handler(opts);
}

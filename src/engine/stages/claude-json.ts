import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { UnsafePathError, safeReadText } from '../safe-fs.js';
import { z } from 'zod';
import type { ProjectRole } from '../../domain/types.js';
import type { StageContext } from '../pipeline.js';

/** Thrown by output validators; the message is fed back to Claude on retry. */
export class OutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutputError';
  }
}

export const MAX_SCHEMA_RETRIES = 2;

/** Reads a file Claude wrote, refusing symlinks (a seat could otherwise make DevFlow read any file it can). */
function readOutput(path: string): string {
  try {
    return safeReadText(path);
  } catch (e) {
    if (e instanceof UnsafePathError) throw new OutputError(`File ${path} không hợp lệ (symlink hoặc không phải file thường): ${e.message}`);
    if (!existsSync(path)) throw new OutputError(`Không tìm thấy file ${path}`);
    throw e;
  }
}

/** Reads and parses a JSON file Claude was asked to write, validating it with a zod schema. */
export async function readJsonOutput<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
  let raw = readOutput(path);
  raw = raw.replace(/^\uFEFF/, '').trim();
  // Tolerate a markdown fence around the JSON.
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(raw);
  if (fence) raw = fence[1]!;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new OutputError(`File ${path} không phải JSON hợp lệ: ${(e as Error).message}`);
  }
  const r = schema.safeParse(data);
  if (!r.success) throw new OutputError(`File ${path} sai cấu trúc:\n${z.prettifyError(r.error)}`);
  return r.data;
}

/** Reads a markdown/text output; it must exist and have at least `minChars` non-blank characters. */
export async function readTextOutput(path: string, minChars = 1): Promise<string> {
  const text = readOutput(path).replace(/^\uFEFF/, '');
  if (text.trim().length < minChars) throw new OutputError(`File ${path} rỗng hoặc quá ngắn`);
  return text;
}

export type StepResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ClaudeStepOpts<T> {
  prompt: string;
  /** Reads and checks the files Claude wrote; throw (preferably OutputError) to trigger a retry. */
  validate: () => Promise<T>;
  /** Stale output files removed before the first run so an old file is never mistaken for a new one. */
  clean?: string[];
  maxRetries?: number;
  /** Run on the current runner of this role (review seat, PLANNING test cases) instead of the job's seat. */
  seatRole?: ProjectRole;
}

/**
 * Runs Claude, then validates its output files. On invalid output Claude is re-invoked with the error
 * (resuming the same session when possible), at most `maxRetries` times (default 2); then gives up.
 * RateLimitError from ctx.claude propagates (the pipeline pauses the job).
 */
export async function runClaudeStep<T>(ctx: StageContext, o: ClaudeStepOpts<T>): Promise<StepResult<T>> {
  const maxRetries = o.maxRetries ?? MAX_SCHEMA_RETRIES;
  for (const f of o.clean ?? []) await rm(f, { force: true });
  let prompt = o.prompt;
  let resumeSessionId: string | undefined;
  let lastError = '';
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (ctx.signal.aborted) return { ok: false, error: 'Đã hủy' };
    const extra = resumeSessionId ? { resumeSessionId } : {};
    const res = o.seatRole ? await ctx.claudeAs(ctx.seatFor(o.seatRole), prompt, extra, o.seatRole) : await ctx.claude(prompt, extra);
    try {
      return { ok: true, value: await o.validate() };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastError = res.ok || !res.error ? msg : `${msg}\n(Claude báo lỗi: ${res.error})`;
      if (attempt === maxRetries) break;
      ctx.log(`Đầu ra của Claude không hợp lệ (lần ${attempt + 1}), chạy lại: ${msg.split('\n')[0]}`, 'warn');
      const fix = [
        '## Đầu ra lần trước không hợp lệ',
        '',
        'DevFlow kiểm tra đầu ra và phát hiện lỗi sau:',
        '',
        '```',
        lastError,
        '```',
        '',
        'Hãy sửa đúng lỗi này và ghi lại đầy đủ các file đầu ra bắt buộc (đúng đường dẫn, đúng định dạng). Không thay đổi nội dung đã đúng.',
      ].join('\n');
      if (res.sessionId) {
        // Keep the ROLE line first so role-based dispatch (logs, E2E mock) still works on the resumed turn.
        const roleLine = /^ROLE: .*$/m.exec(o.prompt)?.[0];
        resumeSessionId = res.sessionId;
        prompt = roleLine ? `${roleLine}\n\n${fix}\n` : `${fix}\n`;
      } else {
        prompt = `${o.prompt}\n${fix}\n`;
      }
    }
  }
  return { ok: false, error: `Đầu ra của Claude vẫn không hợp lệ sau ${maxRetries + 1} lần chạy: ${lastError}` };
}

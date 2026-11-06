import { safeReadFile, safeWriteFile } from '../safe-fs.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildPrompt } from '../prompt.js';
import type { StageContext, StageOutcome } from '../pipeline.js';
import { OutputError, readTextOutput, runClaudeStep } from './claude-json.js';
import { codebaseMapPath, promptExtras } from './common.js';

const MIN_MAP_CHARS = 20;

/** DATA_DIR/cache/<project>/<sha>.md — the map is reused for any request on the same commit. */
function cacheFile(ctx: StageContext, sha: string): string | undefined {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) return undefined;
  const key = (ctx.req.gitlabProject || ctx.req.id).replace(/[^\w.-]+/g, '_');
  return join(ctx.cfg.dataDir, 'cache', key, `${sha}.md`);
}

export async function codebaseScan(ctx: StageContext): Promise<StageOutcome> {
  const out = codebaseMapPath(ctx.ws);
  const sha = await ctx.git.headSha().catch(() => '');
  const cache = cacheFile(ctx, sha);

  // A reviewer rejection means the cached map was not good enough: rescan.
  if (cache && existsSync(cache) && !ctx.feedback) {
    safeWriteFile(out, readFileSync(cache));
    ctx.log(`Dùng lại bản đồ mã nguồn đã quét cho commit ${sha.slice(0, 8)}`);
    return { kind: 'next' };
  }

  const prompt = buildPrompt('explorer', {}, promptExtras(ctx, [
    { path: out, description: 'Bản đồ mã nguồn theo đúng dàn ý ở trên (markdown, tiếng Việt).' },
  ]));
  const r = await runClaudeStep(ctx, {
    prompt,
    clean: ctx.feedback ? [] : [out],
    validate: async () => {
      const md = await readTextOutput(out, MIN_MAP_CHARS);
      if (!/^#\s/m.test(md)) throw new OutputError(`File ${out} không có tiêu đề markdown nào — hãy viết theo dàn ý bắt buộc.`);
      return md;
    },
  });
  if (!r.ok) return { kind: 'fail', error: r.error };
  if (cache) {
    mkdirSync(dirname(cache), { recursive: true });
    writeFileSync(cache, safeReadFile(out));
  }
  ctx.log('Đã tạo bản đồ mã nguồn docs/devflow/codebase-map.md');
  return { kind: 'next' };
}

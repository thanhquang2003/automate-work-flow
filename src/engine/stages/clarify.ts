import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportQuestions } from '../../office/questions-xlsx.js';
import type { StageContext, StageOutcome } from '../pipeline.js';
import { MAX_CLARIFY_ROUNDS, openQuestions, writeAnswers, writeAssumptions } from './common.js';

const DAY_MS = 86_400_000;

export function questionsFileName(reqId: string, round: number): string {
  return `Questions_${reqId}_round${round}.xlsx`;
}

/** First run: export the open questions (Excel, + survey link in server mode) and wait for the customer. */
async function ask(ctx: StageContext): Promise<StageOutcome> {
  const { req, repo, ws, cfg } = ctx;
  const round = req.clarifyRound + 1;
  const open = openQuestions(repo, req.id);
  if (!open.some(q => q.priority === 'must')) {
    const assumed = writeAssumptions(ctx);
    ctx.log(`Không còn câu hỏi bắt buộc nào chưa trả lời${assumed.length ? `; ${assumed.length} câu còn lại được ghi thành giả định` : ''}. Chuyển sang bóc tách chức năng.`);
    return { kind: 'goto', stage: 'BREAKDOWN' };
  }
  const dir = join(ws.artifactsDir, 'questions');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, questionsFileName(req.id, round));
  writeFileSync(file, await exportQuestions(req.id, round, open, repo.latestAnswers(req.id)));
  ctx.log(`Đã xuất ${open.length} câu hỏi vòng ${round} ra ${file}. Gửi file cho khách hàng rồi tải lên file đã trả lời.`);

  if (cfg.mode === 'server') {
    const token = randomBytes(32).toString('base64url');
    repo.createSurveyLink({ token, requestId: req.id, round, expiresAt: Date.now() + cfg.surveyTtlDays * DAY_MS });
    ctx.log(`Link khảo sát cho khách hàng (hết hạn sau ${cfg.surveyTtlDays} ngày): ${cfg.publicBaseUrl.replace(/\/+$/, '')}/s/${token}`);
  }
  return { kind: 'await_customer' };
}

/** After the customer answered (resumeAfterCustomer): record answers, then re-analyse or force assumptions. */
function collect(ctx: StageContext): StageOutcome {
  const { req, repo } = ctx;
  const answers = writeAnswers(ctx);
  const round = req.clarifyRound + 1;
  repo.updateRequest(req.id, { clarifyRound: round });
  ctx.log(`Đã nhận câu trả lời vòng ${round}: tổng cộng ${answers.length} câu đã trả lời (answers.json)`);
  if (round >= MAX_CLARIFY_ROUNDS) {
    const assumed = writeAssumptions(ctx);
    ctx.log(`Đã hết ${MAX_CLARIFY_ROUNDS} vòng hỏi: ${assumed.length} câu chưa trả lời được chuyển thành giả định (assumptions.json), cần khách hàng xác nhận sau`, 'warn');
    return { kind: 'goto', stage: 'BREAKDOWN' };
  }
  return { kind: 'goto', stage: 'ANALYSIS' };
}

export async function clarify(ctx: StageContext): Promise<StageOutcome> {
  return ctx.resume ? collect(ctx) : ask(ctx);
}

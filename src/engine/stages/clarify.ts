import { safeMkdirp, safeWriteFile } from '../safe-fs.js';
import { join } from 'node:path';
import { exportQuestions } from '../../office/questions-xlsx.js';
import type { StageContext, StageOutcome } from '../pipeline.js';
import { createSurveyLink } from '../survey.js';
import { MAX_CLARIFY_ROUNDS, openQuestions, writeAnswers, writeAssumptions } from './common.js';

/** Questions workbook of a round; after a change request (baseline > 1, rounds restart at 1) the baseline is included. */
export function questionsFileName(reqId: string, round: number, baseline = 1): string {
  return `Questions_${reqId}${baseline > 1 ? `_v${baseline}` : ''}_round${round}.xlsx`;
}

/** First run: export the open questions (Excel, + survey link in server mode) and wait for the customer. */
async function ask(ctx: StageContext): Promise<StageOutcome> {
  const { req, repo, ws, cfg } = ctx;
  const round = req.clarifyRound + 1;
  // The customer always receives the full list of open questions (must + should).
  const open = openQuestions(repo, req.id);
  if (!open.length) {
    ctx.log('Không còn câu hỏi nào chưa trả lời. Chuyển sang bóc tách chức năng.');
    return { kind: 'goto', stage: 'BREAKDOWN' };
  }
  // Still-open questions numbered under an earlier baseline (a CR reset the round counter; CR questions too)
  // move to this round, so the survey link of this round (which shows rounds <= its own) lists every one of them.
  const stale = open.filter(q => q.round > round);
  if (stale.length) repo.upsertQuestions(req.id, round, stale);
  const dir = join(ws.artifactsDir, 'questions');
  safeMkdirp(dir, ws.trustRoot);
  const file = join(dir, questionsFileName(req.id, round, req.baselineVersion));
  safeWriteFile(file, await exportQuestions(req.id, round, open, repo.latestAnswers(req.id)));
  ctx.log(`Đã xuất ${open.length} câu hỏi vòng ${round} ra ${file}. Gửi file cho khách hàng rồi tải lên file đã trả lời.`);

  if (cfg.mode === 'server') {
    const link = createSurveyLink(repo, cfg, req.id, round);
    ctx.log(`Link khảo sát cho khách hàng (hết hạn sau ${cfg.surveyTtlDays} ngày): ${link.url}`);
  }
  return { kind: 'await_customer' };
}

/**
 * After the customer answered, or staff pressed "Tiếp tục với giả định" (resumeAfterCustomer): record answers,
 * then re-analyse, or force assumptions at the last round. Only "must" questions block: when none is open,
 * the unanswered "should" questions are written as assumptions for the Analyst.
 * clarify_round is bumped last so a crash before it re-runs this step identically (files are rewritten).
 */
function collect(ctx: StageContext): StageOutcome {
  const { req, repo } = ctx;
  const round = req.clarifyRound + 1;
  const answers = writeAnswers(ctx);
  ctx.log(`Đã nhận câu trả lời vòng ${round}: tổng cộng ${answers.length} câu đã trả lời (answers.json)`);
  const open = openQuestions(repo, req.id);
  const last = round >= MAX_CLARIFY_ROUNDS;
  let outcome: StageOutcome = { kind: 'goto', stage: 'ANALYSIS' };
  if (last) {
    const assumed = writeAssumptions(ctx);
    ctx.log(`Đã hết ${MAX_CLARIFY_ROUNDS} vòng hỏi: ${assumed.length} câu chưa trả lời được chuyển thành giả định (assumptions.json), cần khách hàng xác nhận sau`, 'warn');
    outcome = { kind: 'goto', stage: 'BREAKDOWN' };
  } else if (open.length && !open.some(q => q.priority === 'must')) {
    const assumed = writeAssumptions(ctx);
    ctx.log(`${assumed.length} câu hỏi không bắt buộc chưa trả lời được ghi thành giả định (assumptions.json)`);
  }
  repo.updateRequest(req.id, { clarifyRound: round });
  return outcome;
}

export async function clarify(ctx: StageContext): Promise<StageOutcome> {
  return ctx.resume ? collect(ctx) : ask(ctx);
}

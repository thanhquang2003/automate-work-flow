import { join } from 'node:path';
import { QuestionsOut, type Question } from '../../domain/types.js';
import { buildPrompt } from '../prompt.js';
import type { StageContext, StageOutcome } from '../pipeline.js';
import { OutputError, readJsonOutput, readTextOutput, runClaudeStep } from './claude-json.js';
import { MAX_CLARIFY_ROUNDS, answeredQuestions, contextFileVars, missingHeadings, openQuestions, promptExtras, writeAssumptions } from './common.js';

/** H1 sections of analysis.md that DevFlow relies on (see prompts/analyst.md). */
const ANALYSIS_HEADINGS: [number, string][] = [[1, 'Chỗ hổng đã phát hiện'], [1, 'Câu hỏi mở và giả định']];

const QUESTIONS_EXAMPLE = {
  questions: [{
    id: 'Q-01',
    category: 'Chức năng',
    question: 'Ai được phép duyệt đơn hàng?',
    why: 'Quyết định phân quyền và luồng duyệt; nếu sai phải làm lại màn hình duyệt.',
    type: 'single',
    options: ['Trưởng phòng kinh doanh', 'Kế toán', 'Cả hai, theo thứ tự', 'Khác (ghi rõ)'],
    suggested_answer: 'Trưởng phòng kinh doanh',
    priority: 'must',
  }],
};

function existingQuestionsText(ctx: StageContext): string {
  const qs = ctx.repo.listQuestions(ctx.req.id);
  if (!qs.length) return '(chưa có câu hỏi nào — đây là vòng đầu)';
  const answers = ctx.repo.latestAnswers(ctx.req.id);
  return qs.map(q => {
    const a = answers.get(q.id)?.trim();
    return `- ${q.id} (vòng ${q.round}, ${q.priority}): ${q.question} → ${a ? `Đã trả lời: ${a}` : 'CHƯA TRẢ LỜI'}`;
  }).join('\n');
}

function nextQuestionNo(ctx: StageContext): string {
  let max = 0;
  for (const q of ctx.repo.listQuestions(ctx.req.id)) {
    const m = /^Q-(\d+)$/.exec(q.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return String(max + 1).padStart(2, '0');
}

function checkQuestions(path: string, qs: Question[], answered: Set<string>): void {
  const errs: string[] = [];
  const seen = new Set<string>();
  for (const q of qs) {
    if (!/^Q-\d{2,}$/.test(q.id)) errs.push(`${q.id}: id phải có dạng Q-NN`);
    if (seen.has(q.id)) errs.push(`${q.id}: id bị trùng`);
    if (answered.has(q.id)) errs.push(`${q.id}: id đã thuộc về câu hỏi đã được trả lời — hãy dùng id mới`);
    seen.add(q.id);
    if (!q.question.trim()) errs.push(`${q.id}: thiếu nội dung câu hỏi`);
    if ((q.type === 'single' || q.type === 'multi') && q.options.length < 2) errs.push(`${q.id}: câu hỏi ${q.type} cần ít nhất 2 lựa chọn trong options`);
  }
  if (errs.length) throw new OutputError(`File ${path} có lỗi:\n- ${errs.join('\n- ')}`);
}

export async function analysis(ctx: StageContext): Promise<StageOutcome> {
  const { ws, req, repo } = ctx;
  const round = req.clarifyRound + 1;
  const analysisFile = join(ws.devflowDir, 'analysis.md');
  const questionsFile = join(ws.devflowDir, 'questions.json');
  const answered = new Set(answeredQuestions(repo, req.id).map(a => a.id));

  const prompt = buildPrompt('analyst', {
    ...contextFileVars(ctx),
    round: String(round),
    max_rounds: String(MAX_CLARIFY_ROUNDS),
    existing_questions: existingQuestionsText(ctx),
    next_question_no: nextQuestionNo(ctx),
  }, promptExtras(ctx, [
    { path: analysisFile, description: 'Bản phân tích yêu cầu theo đúng dàn ý ở trên (markdown, tiếng Việt). Từ vòng 2: cập nhật file hiện có.' },
    { path: questionsFile, description: `Câu hỏi MỚI của vòng ${round} cho khách hàng (không lặp lại câu đã trả lời). Không còn gì để hỏi thì ghi {"questions": []}.`, example: QUESTIONS_EXAMPLE },
  ]));

  const r = await runClaudeStep(ctx, {
    prompt,
    clean: [questionsFile],
    validate: async () => {
      // Report every problem at once so a single retry can fix them all.
      const errs: string[] = [];
      try {
        const md = await readTextOutput(analysisFile, 10);
        const missing = missingHeadings(md, ANALYSIS_HEADINGS);
        if (missing.length) errs.push(`File ${analysisFile} thiếu tiêu đề bắt buộc: ${missing.map(h => `"${h}"`).join(', ')}`);
      } catch (e) { errs.push((e as Error).message); }
      let questions: Question[] = [];
      try {
        questions = (await readJsonOutput(questionsFile, QuestionsOut)).questions;
        checkQuestions(questionsFile, questions, answered);
      } catch (e) { errs.push((e as Error).message); }
      if (errs.length) throw new OutputError(errs.join('\n'));
      return questions;
    },
  });
  if (!r.ok) return { kind: 'fail', error: r.error };

  repo.upsertQuestions(req.id, round, r.value);
  const open = openQuestions(repo, req.id);
  const openMust = open.filter(q => q.priority === 'must');
  ctx.log(`Phân tích vòng ${round}: ${r.value.length} câu hỏi mới; chưa trả lời: ${openMust.length} câu bắt buộc (must), ${open.length - openMust.length} câu nên hỏi (should)`);
  if (openMust.length) return { kind: 'next' };

  // Nothing blocking: unanswered "should" questions become explicit assumptions.
  const assumed = writeAssumptions(ctx);
  if (assumed.length) ctx.log(`${assumed.length} câu hỏi chưa trả lời được ghi thành giả định (assumptions.json)`);
  // Review mode keeps the ANALYSIS gate; after approval CLARIFY sees no open "must" question and skips to BREAKDOWN.
  if (req.runMode === 'review') return { kind: 'next' };
  return { kind: 'goto', stage: 'BREAKDOWN' };
}

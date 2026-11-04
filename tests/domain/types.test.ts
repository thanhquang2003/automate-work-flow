import { describe, it, expect } from 'vitest';
import { ReviewOut, QuestionsOut, QUESTION_CATEGORIES } from '../../src/domain/types.js';

describe('schemas', () => {
  it('ReviewOut matches Task 9 contract', () => {
    const ok = ReviewOut.parse({ approved: false, comments: [{ file: 'a.ts', line: 3, severity: 'major', body: 'x' }, { file: 'b.ts', severity: 'minor', body: 'y' }] });
    expect(ok.approved).toBe(false);
    expect(() => ReviewOut.parse({ verdict: 'approve', comments: [] })).toThrow();
  });
  it('question category accepts any string', () => {
    const q = { id: 'Q-01', category: 'Bảo mật', question: '?', why: 'w', type: 'text', priority: 'must' };
    expect(QuestionsOut.parse({ questions: [q] }).questions[0].category).toBe('Bảo mật');
    expect(QUESTION_CATEGORIES).toContain('Khác');
  });
});

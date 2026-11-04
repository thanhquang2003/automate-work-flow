import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../src/office/markdown.js';

describe('parseMarkdown', () => {
  it('parses headings/lists/tables/code', () => {
    const md = [
      '# Tiêu đề 1',
      '',
      'Đoạn **đậm** và *nghiêng* và `mã`.',
      '',
      '- một',
      '- hai',
      '',
      '1. a',
      '2. b',
      '',
      '| Cột A | Cột B |',
      '|---|---|',
      '| x | **y** |',
      '',
      '```sql',
      'SELECT 1;',
      '```',
      '',
      '## Con',
    ].join('\n');
    const b = parseMarkdown(md);
    expect(b[0]).toEqual({ type: 'heading', level: 1, text: 'Tiêu đề 1' });
    expect(b[1]).toEqual({
      type: 'para',
      inlines: [
        { t: 'text', text: 'Đoạn ' },
        { t: 'bold', text: 'đậm' },
        { t: 'text', text: ' và ' },
        { t: 'italic', text: 'nghiêng' },
        { t: 'text', text: ' và ' },
        { t: 'code', text: 'mã' },
        { t: 'text', text: '.' },
      ],
    });
    expect(b[2]).toMatchObject({ type: 'list', ordered: false });
    expect((b[2] as any).items).toHaveLength(2);
    expect(b[3]).toMatchObject({ type: 'list', ordered: true });
    expect(b[4]).toMatchObject({ type: 'table' });
    const t = b[4] as any;
    expect(t.rows).toHaveLength(2);
    expect(t.rows[1][1]).toEqual([{ t: 'bold', text: 'y' }]);
    expect(b[5]).toEqual({ type: 'code', text: 'SELECT 1;', lang: 'sql' });
    expect(b[6]).toEqual({ type: 'heading', level: 2, text: 'Con' });
  });

  it('treats blockquote as paragraph, ignores hr, keeps mermaid lang', () => {
    const b = parseMarkdown('> trích dẫn\n\n---\n\n```mermaid\ngraph TD\n```\n');
    expect(b).toEqual([
      { type: 'para', inlines: [{ t: 'text', text: 'trích dẫn' }] },
      { type: 'code', text: 'graph TD', lang: 'mermaid' },
    ]);
  });
});

import { parseMarkdown, type Inline } from '../office/markdown.js';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const inl = (xs: Inline[]) => xs.map(x => {
  const t = esc(x.text);
  return x.t === 'bold' ? `<strong>${t}</strong>` : x.t === 'italic' ? `<em>${t}</em>` : x.t === 'code' ? `<code>${t}</code>` : t;
}).join('');

/** Markdown → HTML. Every text node is escaped; raw HTML in the source is never passed through. */
export function markdownToHtml(md: string): string {
  return parseMarkdown(md).map(b => {
    switch (b.type) {
      case 'heading': { const l = Math.min(6, b.level + 1); return `<h${l}>${esc(b.text)}</h${l}>`; }
      case 'para': return `<p>${inl(b.inlines)}</p>`;
      case 'list': { const tag = b.ordered ? 'ol' : 'ul'; return `<${tag}>${b.items.map(i => `<li>${inl(i)}</li>`).join('')}</${tag}>`; }
      case 'table': {
        const [head, ...rows] = b.rows;
        const tr = (r: Inline[][], c: string) => `<tr>${r.map(x => `<${c}>${inl(x)}</${c}>`).join('')}</tr>`;
        return `<table><thead>${head ? tr(head, 'th') : ''}</thead><tbody>${rows.map(r => tr(r, 'td')).join('')}</tbody></table>`;
      }
      case 'code': return `<pre><code>${esc(b.text)}</code></pre>`;
    }
  }).join('\n');
}

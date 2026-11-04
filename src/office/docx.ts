import JSZip from 'jszip';
import { readFile, writeFile } from 'node:fs/promises';
import { parseMarkdown, type Block, type Inline } from './markdown.js';

const esc = (s: string) =>
  s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

interface Styles {
  byName: Map<string, string>; // lower-case style name -> styleId
  table?: string;
}

function readStyles(xml: string): Styles {
  const byName = new Map<string, string>();
  let table: string | undefined;
  for (const m of xml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const id = m[1]!.match(/w:styleId="([^"]+)"/)?.[1];
    const name = m[2]!.match(/<w:name w:val="([^"]+)"/)?.[1];
    const type = m[1]!.match(/w:type="([^"]+)"/)?.[1];
    if (!id || !name) continue;
    const key = name.toLowerCase();
    if (!byName.has(key)) byName.set(key, id);
    if (type === 'table' && !table && id !== 'TableNormal' && key !== 'normal table') table = id;
  }
  return { byName, ...(table ? { table } : {}) };
}

/** Split the children of <w:body> into top-level XML chunks. */
function splitTopLevel(inner: string): string[] {
  const out: string[] = [];
  const re = /<(\/?)([\w:.-]+)(?:\s[^>]*?)?(\/?)>/g;
  let depth = 0;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) {
    const closing = m[1] === '/';
    const selfClosing = m[3] === '/';
    if (closing) depth--;
    else if (!selfClosing) depth++;
    if (depth === 0) {
      out.push(inner.slice(start, re.lastIndex));
      start = re.lastIndex;
    }
  }
  return out;
}

function run(text: string, opts: { b?: boolean; i?: boolean; code?: boolean; sz?: number } = {}): string {
  let rpr = '';
  if (opts.code) rpr += '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>';
  if (opts.b) rpr += '<w:b/>';
  if (opts.i) rpr += '<w:i/>';
  if (opts.code) rpr += '<w:sz w:val="18"/><w:szCs w:val="18"/>';
  else if (opts.sz) rpr += `<w:sz w:val="${opts.sz}"/>`;
  return `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function inlineRuns(inlines: Inline[], forceBold = false): string {
  return inlines
    .map((x) => run(x.text, { b: forceBold || x.t === 'bold', i: x.t === 'italic', code: x.t === 'code' }))
    .join('');
}

const para = (runs: string, style?: string, extraPPr = '') =>
  `<w:p>${style || extraPPr ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extraPPr}</w:pPr>` : ''}${runs}</w:p>`;

const BORDERS =
  '<w:tblBorders>' +
  ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`)
    .join('') +
  '</w:tblBorders>';

function renderTable(rows: Inline[][][], styles: Styles): string {
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const pr =
    `<w:tblPr>${styles.table ? `<w:tblStyle w:val="${styles.table}"/>` : ''}<w:tblW w:w="5000" w:type="pct"/>` +
    `${styles.table ? '' : BORDERS}</w:tblPr>`;
  const grid = `<w:tblGrid>${'<w:gridCol/>'.repeat(cols)}</w:tblGrid>`;
  const trs = rows
    .map((r, ri) => {
      const cells = Array.from({ length: cols }, (_, ci) => r[ci] ?? []);
      return (
        `<w:tr>${ri === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}` +
        cells.map((c) => `<w:tc><w:tcPr/>${para(inlineRuns(c, ri === 0))}</w:tc>`).join('') +
        '</w:tr>'
      );
    })
    .join('');
  return `<w:tbl>${pr}${grid}${trs}</w:tbl>`;
}

function renderBlock(b: Block, styles: Styles): string {
  const sid = (name: string) => styles.byName.get(name);
  switch (b.type) {
    case 'heading': {
      const lvl = Math.min(Math.max(b.level, 1), 4);
      const id = sid(`heading ${lvl}`);
      return id ? para(run(b.text), id) : para(run(b.text, { b: true, sz: 32 - lvl * 2 }));
    }
    case 'para':
      return para(inlineRuns(b.inlines));
    case 'list': {
      const id = sid(b.ordered ? 'list number' : 'list bullet');
      return b.items
        .map((it, n) => {
          if (id) return para(inlineRuns(it), id);
          const prefix = b.ordered ? `${n + 1}. ` : '• ';
          return para(run(prefix) + inlineRuns(it), undefined, '<w:ind w:left="720" w:hanging="360"/>');
        })
        .join('');
    }
    case 'table':
      return renderTable(b.rows, styles) + para('');
    case 'code': {
      const spacing = '<w:spacing w:before="0" w:after="0"/>';
      const caption = b.lang === 'mermaid' ? para(run('Sơ đồ (mermaid)', { i: true })) : '';
      return caption + b.text.split('\n').map((l) => para(run(l, { code: true }), undefined, spacing)).join('');
    }
  }
}

export async function renderDocx(templatePath: string, markdown: string, outPath: string): Promise<void> {
  const zip = await JSZip.loadAsync(await readFile(templatePath));
  const docFile = zip.file('word/document.xml');
  const stylesFile = zip.file('word/styles.xml');
  if (!docFile) throw new Error('Template không hợp lệ: thiếu word/document.xml');
  const doc = await docFile.async('string');
  const styles = readStyles(stylesFile ? await stylesFile.async('string') : '');

  const open = doc.indexOf('<w:body>');
  const bodyEnd = doc.lastIndexOf('</w:body>');
  if (open < 0 || bodyEnd < 0) throw new Error('Template không hợp lệ: thiếu w:body');
  const bodyStart = open + '<w:body>'.length;
  const children = splitTopLevel(doc.slice(bodyStart, bodyEnd));

  let sect = '';
  if (children.length && children[children.length - 1]!.trimStart().startsWith('<w:sectPr')) sect = children.pop()!;

  const h1 = styles.byName.get('heading 1');
  const isH1 = (c: string) => !!h1 && /^\s*<w:p[\s>]/.test(c) && c.includes(`<w:pStyle w:val="${h1}"/>`);
  let idx = children.findIndex(isH1);
  if (idx < 0) idx = children.length;
  const kept = children.slice(0, idx).join('');

  const generated = parseMarkdown(markdown)
    .map((b) => renderBlock(b, styles))
    .join('');

  zip.file('word/document.xml', doc.slice(0, bodyStart) + kept + generated + sect + doc.slice(bodyEnd));
  await writeFile(outPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

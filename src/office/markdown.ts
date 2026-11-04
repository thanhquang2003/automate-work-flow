/** Minimal markdown subset parser used for rendering Claude-written documents into Word templates. */

export type Inline = { t: 'text' | 'bold' | 'italic' | 'code'; text: string };

export type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'para'; inlines: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'table'; rows: Inline[][][] }
  | { type: 'code'; text: string; lang?: string };

export function parseInlines(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', text: buf });
    buf = '';
  };
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^`([^`]+)`/))) {
      flush();
      out.push({ t: 'code', text: m[1]! });
    } else if ((m = rest.match(/^\*\*([^*]+?)\*\*/)) || (m = rest.match(/^__([^_]+?)__/))) {
      flush();
      out.push({ t: 'bold', text: m[1]! });
    } else if ((m = rest.match(/^\*([^*\s][^*]*?)\*/))) {
      flush();
      out.push({ t: 'italic', text: m[1]! });
    } else {
      buf += s[i];
      i++;
      continue;
    }
    i += m[0].length;
  }
  flush();
  return out;
}

const splitRow = (line: string): string[] => {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
};
const isSeparator = (line: string) =>
  /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line) && line.includes('-');
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;

export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ type: 'para', inlines: parseInlines(para.join(' ')) });
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i]!;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^\s*(```|~~~)\s*([^\s`]*)[^`]*$/))) {
      flushPara();
      const fence = m[1]!;
      const lang = m[2] || undefined;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence)) body.push(lines[i++]!);
      i++; // closing fence
      const b: Block = { type: 'code', text: body.join('\n') };
      if (lang) b.lang = lang;
      blocks.push(b);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      i++;
      continue;
    }
    if ((m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) {
      flushPara();
      blocks.push({ type: 'heading', level: m[1]!.length, text: m[2]! });
      i++;
      continue;
    }
    if (line.trim().startsWith('|') && i + 1 < lines.length && isSeparator(lines[i + 1]!)) {
      flushPara();
      const rows: Inline[][][] = [splitRow(line).map(parseInlines)];
      i += 2;
      while (i < lines.length && lines[i]!.trim().startsWith('|')) rows.push(splitRow(lines[i++]!).map(parseInlines));
      blocks.push({ type: 'table', rows });
      continue;
    }
    const bm = line.match(BULLET);
    const om = line.match(ORDERED);
    if (bm || om) {
      flushPara();
      const ordered = !!om && !bm;
      const re = ordered ? ORDERED : BULLET;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const lm = lines[i]!.match(re);
        if (!lm) break;
        items.push(parseInlines(lm[1]!));
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    if ((m = line.match(/^\s*>\s?(.*)$/))) {
      flushPara();
      blocks.push({ type: 'para', inlines: parseInlines(m[1]!) });
      i++;
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flushPara();
  return blocks;
}

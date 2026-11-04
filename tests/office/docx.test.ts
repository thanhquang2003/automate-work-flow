import JSZip from 'jszip';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderDocx } from '../../src/office/docx.js';

const TKCT = 'templates/default/tkct.docx';
const TKDB = 'templates/default/tkdb.docx';
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'devflow-docx-'));
});

async function open(p: string) {
  const zip = await JSZip.loadAsync(await readFile(p));
  return { zip, xml: await zip.file('word/document.xml')!.async('string') };
}
const text = (xml: string) => [...xml.matchAll(/<w:t[ >][^<]*|<w:t>[^<]*/g)].map((m) => m[0]).join('');

describe('renderDocx', () => {
  it('replaces body after first Heading1 and keeps sectPr', async () => {
    const out = join(dir, 'a.docx');
    const tpl = await open(TKCT);
    await renderDocx(TKCT, '# Chương mới\n\nNội dung mới.', out);
    const { xml } = await open(out);
    expect(xml).toContain('TÀI LIỆU THIẾT KẾ CHI TIẾT'); // cover kept
    expect(xml).toContain('MỤC LỤC');
    expect(xml).toContain('Chương mới');
    expect(xml).not.toContain('w:val="Heading2"'); // old body gone
    expect(xml.length).toBeLessThan(tpl.xml.length);
    expect(xml.match(/<w:sectPr[\s>]/g)!.length).toBeGreaterThanOrEqual(1);
    expect(xml.trimEnd().endsWith('</w:sectPr></w:body></w:document>')).toBe(true);
  });

  it('escapes xml and keeps unicode', async () => {
    const out = join(dir, 'b.docx');
    await renderDocx(TKCT, '# T\n\nKiểm tra <a> & "b"', out);
    const { xml } = await open(out);
    expect(xml).toContain('Kiểm tra &lt;a&gt; &amp;');
    expect(xml).not.toContain('<a>');
  });

  it('uses template heading style ids', async () => {
    const out = join(dir, 'c.docx');
    await renderDocx(TKCT, '# A\n\n## B\n\n### C\n\n#### D\n\ntext', out);
    const { xml } = await open(out);
    const gen = xml.slice(xml.indexOf('>A<') - 400);
    for (const id of ['Heading1', 'Heading2', 'Heading3', 'Heading4']) expect(gen).toContain(`<w:pStyle w:val="${id}"/>`);
  });

  it('renders tables, code, lists and mermaid', async () => {
    const out = join(dir, 'd.docx');
    await renderDocx(
      TKCT,
      '# A\n\n- x\n- y\n\n1. p\n2. q\n\n| H1 | H2 |\n|--|--|\n| a | b |\n\n```mermaid\ngraph TD\n```\n',
      out,
    );
    const { xml } = await open(out);
    const gen = xml.slice(xml.indexOf('>A<'));
    expect(gen).toContain('<w:tbl>');
    expect(gen).toContain('Courier New');
    expect(gen).toContain('Sơ đồ (mermaid)');
    expect(gen).toContain('• </w:t></w:r><w:r><w:t xml:space="preserve">x'); // tkct has no List Bullet style -> prefix
    expect(gen).toContain('1. </w:t></w:r><w:r><w:t xml:space="preserve">p');
    expect(gen).toMatch(/<w:b\/>[\s\S]*?H1/);
  });

  it('tkdb template renders', async () => {
    const out = join(dir, 'e.docx');
    await renderDocx(TKDB, '# Bảng\n\n- một\n- hai\n\n1. a\n\n| C | D |\n|--|--|\n| 1 | 2 |', out);
    const { xml, zip } = await open(out);
    expect(xml).toContain('TRANG KÝ');
    expect(xml).toContain('MỤC LỤC');
    expect(xml).toContain('<w:pStyle w:val="ListBullet"/>');
    expect(xml).toContain('<w:pStyle w:val="ListNumber"/>');
    expect(text(xml)).toContain('Bảng');
    expect(zip.file('word/styles.xml')).toBeTruthy();
    expect(xml.trimEnd().endsWith('</w:sectPr></w:body></w:document>')).toBe(true);
  });
});

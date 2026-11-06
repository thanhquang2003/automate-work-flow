import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { attachmentName, copyAttachments, uniqueName } from '../../src/engine/stages/intake.js';
import { Workspace } from '../../src/engine/workspace.js';
import { mkReq, setup } from './helpers.js';

/**
 * C1d (re-review): the web layer and the INTAKE/CHANGE stages computed attachment names with different functions,
 * so the stage "copied" inputs/<stored name> into inputs/<other name> with a raw read that followed a seat-planted
 * symlink. Both sides now use one idempotent function, and the copy reads through safe-fs.
 */
describe('attachment names (C1d)', () => {
  const raw = ['notes.txt.', 'a b .txt  ', '../../evil name.txt', 'con.txt', 'con.txt.', '..', '.', '...', ' .hidden', 'x<>:"|?*.md', 'Báo cáo (v2).docx', 'A.TXT', 'a.txt', 'lpt1', '', 'tab\there.txt'];

  it('is idempotent and safe', () => {
    for (const r of raw) {
      const n = attachmentName(r);
      expect(attachmentName(n), JSON.stringify(r)).toBe(n);
      expect(n, JSON.stringify(r)).toMatch(/^[\w.\- ()À-ỹ]+$/);
      expect(n).not.toMatch(/^\.|[. ]$/);
      expect(['.', '..', '']).not.toContain(n);
      // Windows reserved stems keep the v2 form: the whole name gets a trailing "_" (CON.txt -> CON.txt_).
      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(n.replace(/\..*$/, ''))) expect(n.endsWith('_'), n).toBe(true);
    }
  });

  it('the stage recomputes exactly the names the web stored (same dedupe)', () => {
    const usedWeb = new Set<string>();
    const stored = raw.map(r => uniqueName(attachmentName(r), usedWeb));
    const usedStage = new Set<string>();
    expect(stored.map(s => uniqueName(attachmentName(s), usedStage))).toEqual(stored);
  });

  it('copyAttachments never follows a symlink planted at the stored path', () => {
    const s = setup();
    const r = mkReq(s.repo);
    const ws = Workspace.for(s.cfg, r.id).ensure();
    const out = mkdtempSync(join(tmpdir(), 'df-att-'));
    writeFileSync(join(out, 'secret'), 'SECRET_KEY=abc');
    // An attachment row whose stored path differs from the computed destination (legacy / foreign path).
    mkdirSync(join(ws.root, 'old'), { recursive: true });
    symlinkSync(join(out, 'secret'), join(ws.root, 'old', 'notes.txt'));
    s.repo.addAttachment(r.id, 'notes.txt', join(ws.root, 'old', 'notes.txt'), 14);
    const logs: string[] = [];
    const ctx = { repo: s.repo, req: s.repo.getRequest(r.id)!, ws, log: (m: string) => { logs.push(m); } } as never;
    expect(copyAttachments(ctx)).toBe(0);
    expect(readdirSync(ws.inputsDir)).toEqual([]);
    expect(logs.join('\n')).toContain('notes.txt');
  });
});

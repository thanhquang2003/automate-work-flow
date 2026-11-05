import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import type { TestResultSchema } from '../domain/types.js';

export type TestResult = z.infer<typeof TestResultSchema>;

export const MISSING_EVIDENCE = 'thiếu evidence';
export const MISSING_PE_REASON = 'thiếu lý do PE';

/** TC ids become directory names: only plain, non-traversing names are accepted. */
export const safeTcId = (id: string): boolean => /^[\w.-]+$/.test(id) && !id.includes('..');

/** Files under a directory, relative to it with forward slashes (recursive, sorted). Empty when missing. */
export function evidenceFiles(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const out: string[] = [];
  const walk = (d: string, prefix: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p, `${prefix}${name}/`);
      else out.push(`${prefix}${name}`);
    }
  };
  walk(dir, '');
  return out;
}

/** True when `<evidenceDir>/<tcId>/` holds at least one file. */
export function hasEvidence(evidenceDir: string, tcId: string): boolean {
  return safeTcId(tcId) && evidenceFiles(join(evidenceDir, tcId)).length > 0;
}

const withNote = (comment: string, note: string): string => (comment.trim() ? `${comment.trim()} (${note})` : note);

/**
 * Enforces the evidence rules (spec §9): P without at least one file under `<evidenceDir>/<TC-ID>/` becomes F
 * ("thiếu evidence"); PE without a reason in the comment becomes F ("thiếu lý do PE"). Returns new objects.
 */
export function validateResults(results: TestResult[], evidenceDir: string): TestResult[] {
  return results.map(r => {
    if (r.status === 'P' && !hasEvidence(evidenceDir, r.tc_id)) return { ...r, status: 'F', comment: withNote(r.comment, MISSING_EVIDENCE) };
    if (r.status === 'PE' && !r.comment.trim()) return { ...r, status: 'F', comment: MISSING_PE_REASON };
    return { ...r };
  });
}

/**
 * Copies `<evidenceDir>/<tcId>/` to `<artifactsDir>/evidence/<tcId>/` (replacing the previous copy) and returns the
 * paths relative to artifactsDir (`evidence/<TC-ID>/<file>`), as referenced from the test case workbook.
 */
export function copyEvidence(evidenceDir: string, artifactsDir: string, tcId: string): string[] {
  if (!safeTcId(tcId)) return [];
  const src = join(evidenceDir, tcId);
  const dest = join(artifactsDir, 'evidence', tcId);
  rmSync(dest, { recursive: true, force: true });
  const files = evidenceFiles(src);
  if (!files.length) return [];
  cpSync(src, dest, { recursive: true });
  return files.map(f => `evidence/${tcId}/${f}`);
}

import { join } from 'node:path';
import type { Repo } from '../db/repo.js';
import type { ProjectRow } from '../domain/types.js';
import { safeListFiles, safeReadTail, UnsafePathError } from '../engine/safe-fs.js';
import { Git } from '../gitlab/git.js';

/**
 * Read-only views of project content for the oversight roles. Source is read with git plumbing only (no checkout,
 * nothing a seat planted in a working tree is followed); logs come from the request log folder through safe-fs.
 * Every call, allowed or refused, writes an audit_log row.
 */
export type ContentErrorCode = 'bad_path' | 'bad_ref' | 'not_found' | 'forbidden';
export class ContentError extends Error {
  constructor(readonly code: ContentErrorCode, message: string) {
    super(message);
    this.name = 'ContentError';
  }
}

export const MAX_CONTENT_BYTES = 1024 * 1024;
const MAX_LINK_TARGET = 4096;

export interface ContentCtx { repo: Repo; userId: number | null }
export interface DirEntry { name: string; path: string; kind: 'dir' | 'file' | 'symlink' | 'gitlink'; size: number | null }
export type ContentResult =
  | { kind: 'dir'; entries: DirEntry[] }
  | { kind: 'file'; text: string; size: number }
  | { kind: 'binary'; size: number }
  | { kind: 'toolarge'; size: number }
  | { kind: 'symlink'; target: string }
  | { kind: 'gitlink' };

// ---- secret paths ----

const SECRET_NAME = [
  /^\.env/, /\.pem$/, /\.key$/, /\.p12$/, /\.pfx$/, /\.jks$/, /\.keystore$/, /^id_(rsa|dsa|ecdsa|ed25519)/, /^credentials/,
  /^\.npmrc$/, /^\.netrc$/, /^\.pgpass$/, /^\.claude$/, /^\.git$/, /^\.ssh$/, /^\.aws$/, /^\.gnupg$/,
];
/** True when any component of `path` names a secret (matched case-insensitively): such paths are never shown. */
export function isSecretPath(path: string): boolean {
  return path.split('/').some(c => c !== '' && SECRET_NAME.some(re => re.test(c.toLowerCase())));
}

/** Validated path components; '' (the root) gives []. A trailing slash is allowed. */
export function pathComponents(path: string): string[] {
  if (path.length > 1024) throw new ContentError('bad_path', 'Đường dẫn quá dài.');
  const p = path.endsWith('/') ? path.slice(0, -1) : path;
  if (p === '') return [];
  const parts = p.split('/');
  for (const c of parts) {
    // eslint-disable-next-line no-control-regex
    if (c === '' || c === '.' || c === '..' || c.length > 255 || /[\\\u0000-\u001f\u007f]/.test(c)) throw new ContentError('bad_path', 'Đường dẫn không hợp lệ.');
  }
  return parts;
}

const REF_RE = /^devflow\/[A-Za-z0-9._-]{1,60}$/;
/** Only the project's default branch and `devflow/<name>` branches can be viewed. */
export function isAllowedRef(project: ProjectRow, ref: string): boolean {
  return ref === project.defaultBranch || (REF_RE.test(ref) && !ref.includes('..'));
}

const audit = (ctx: ContentCtx, project: ProjectRow, action: string, detail: Record<string, unknown>): void => {
  ctx.repo.web.addAudit({ projectId: project.id, userId: ctx.userId, action, detail: JSON.stringify(detail) });
};
const clip = (s: string, n = 300): string => (s.length > n ? s.slice(0, n) : s);

async function readInner(project: ProjectRow, refName: string, path: string): Promise<ContentResult> {
  if (!isAllowedRef(project, refName)) throw new ContentError('bad_ref', 'Nhánh không được phép xem.');
  const comps = pathComponents(path);
  if (isSecretPath(path)) throw new ContentError('forbidden', 'Tệp này chứa thông tin bí mật nên không được hiển thị.');
  const rel = comps.join('/');
  const git = new Git(project.path);
  const commit = await git.branchCommit(refName);
  if (!commit) throw new ContentError('not_found', 'Không tìm thấy nhánh.');
  const entry = await git.treeEntry(commit, rel);
  if (!entry) throw new ContentError('not_found', 'Không tìm thấy đường dẫn.');
  if (entry.mode === '160000' || entry.type === 'commit') return { kind: 'gitlink' };
  if (entry.mode === '120000') {
    if ((entry.size ?? 0) > MAX_LINK_TARGET) return { kind: 'symlink', target: '(quá dài)' };
    return { kind: 'symlink', target: await git.blobText(entry.sha) };
  }
  if (entry.type === 'tree') {
    const entries: DirEntry[] = (await git.listTree(commit, rel))
      .filter(e => !isSecretPath(e.name))
      .map(e => ({
        name: e.name, path: e.path, size: e.size,
        kind: e.mode === '160000' || e.type === 'commit' ? 'gitlink' : e.mode === '120000' ? 'symlink' : e.type === 'tree' ? 'dir' : 'file',
      }));
    entries.sort((a, b) => (a.kind === 'dir' ? 0 : 1) - (b.kind === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
    return { kind: 'dir', entries };
  }
  const size = entry.size ?? 0;
  if (size > MAX_CONTENT_BYTES) return { kind: 'toolarge', size };
  const text = await git.blobText(entry.sha);
  if (text.slice(0, 8000).includes('\0')) return { kind: 'binary', size };
  return { kind: 'file', text, size };
}

/** Tree or content of `path` on `ref` (default branch when empty) of the project, read through git. */
export async function readProjectFile(project: ProjectRow, ref: string | undefined, path: string, ctx: ContentCtx): Promise<ContentResult> {
  const refName = ref || project.defaultBranch;
  try {
    const r = await readInner(project, refName, path);
    audit(ctx, project, 'oversight.content', { ref: clip(refName), path: clip(path), kind: r.kind });
    return r;
  } catch (e) {
    audit(ctx, project, 'oversight.content.denied', { ref: clip(refName), path: clip(path), reason: e instanceof ContentError ? e.code : 'error' });
    throw e;
  }
}

// ---- request logs ----

const CODE_RE = /^[A-Za-z0-9._-]{1,40}$/;
const LOG_RE = /^[A-Za-z0-9._-]{1,120}\.log$/;

/**
 * Credential-looking lines are replaced as a whole, other secrets (known token prefixes, long hex or base64 runs)
 * are masked inside the line.
 */
export function redactLog(text: string): string {
  const line = /authorization\s*:|bearer\s+\S|passw(?:or)?d|secret|api[_-]?key|\btoken\s*[=:]|private key|cookie\s*:/i;
  const inline: RegExp[] = [
    /\bsk-[A-Za-z0-9_-]{10,}/g, /\bgh[pousr]_[A-Za-z0-9]{10,}/g, /\bglpat-[A-Za-z0-9_-]{10,}/g, /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
    /\b[0-9a-fA-F]{32,}\b/g, /[A-Za-z0-9+/_=-]{40,}/g,
  ];
  return text.split('\n').map(l => {
    if (line.test(l)) return '[đã ẩn: dòng có thông tin xác thực]';
    return inline.reduce((s, re) => s.replace(re, '[đã ẩn]'), l);
  }).join('\n');
}

function logDir(project: ProjectRow, code: string, ctx: ContentCtx): string {
  if (!CODE_RE.test(code) || code.includes('..')) throw new ContentError('bad_path', 'Mã yêu cầu không hợp lệ.');
  if (!ctx.repo.listRequestsByProject(project.id).some(r => r.code === code)) throw new ContentError('not_found', 'Không tìm thấy yêu cầu.');
  return join(project.path, '.devflow', 'requests', code, 'logs');
}
const mapFs = (e: unknown): never => {
  if (e instanceof ContentError) throw e;
  if (e instanceof UnsafePathError) throw new ContentError('bad_path', 'Đường dẫn không an toàn.');
  if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new ContentError('not_found', 'Không tìm thấy tệp.');
  throw e;
};

export async function listRequestLogs(project: ProjectRow, code: string, ctx: ContentCtx): Promise<{ name: string; size: number; mtimeMs: number }[]> {
  try {
    const dir = logDir(project, code, ctx);
    const files = safeListFiles(dir, project.path).filter(f => LOG_RE.test(f.name) && !f.name.includes('..'));
    audit(ctx, project, 'oversight.log', { code, list: true });
    return files;
  } catch (e) {
    audit(ctx, project, 'oversight.log.denied', { code: clip(code), list: true });
    return mapFs(e);
  }
}

/** One log file of a request: plain text, last MAX_CONTENT_BYTES at most, credential lines redacted. */
export async function readRequestLog(project: ProjectRow, code: string, name: string, ctx: ContentCtx): Promise<{ text: string; size: number; truncated: boolean }> {
  try {
    const dir = logDir(project, code, ctx);
    if (!LOG_RE.test(name) || name.includes('..')) throw new ContentError('bad_path', 'Tên tệp log không hợp lệ.');
    const r = safeReadTail(join(dir, name), MAX_CONTENT_BYTES, project.path);
    let text = r.data.toString('utf8');
    if (r.truncated) text = text.slice(text.indexOf('\n') + 1);
    audit(ctx, project, 'oversight.log', { code, file: name, size: r.size });
    return { text: redactLog(text), size: r.size, truncated: r.truncated };
  } catch (e) {
    audit(ctx, project, 'oversight.log.denied', { code: clip(code), file: clip(name) });
    return mapFs(e);
  }
}

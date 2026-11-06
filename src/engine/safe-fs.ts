import {
  closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, readSync, realpathSync,
  unlinkSync, writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Symlink-safe file access for DevFlow writes/reads under folders that Claude seats can write
 * (`<project>/.devflow/requests/<code>/`, worktrees, `docs/devflow/<code>`). A seat could plant a symlink (or a hard
 * link) there so that DevFlow, running as the service account, overwrites or reads an arbitrary file. Every path is
 * checked component by component below a trusted root (lstat, no symlinks), the final file is opened with
 * O_NOFOLLOW, must be a regular file (written ones with a single link), and on Linux the opened descriptor's real
 * path must still lie under the root (closes the swap-a-folder-for-a-link race between check and open).
 */
export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const roots = new Set<string>();

/** Registers a folder DevFlow owns (a project folder or a legacy workspace); paths under it are checked from there. */
export function addTrustedRoot(dir: string): void {
  if (isAbsolute(dir)) roots.add(resolve(dir));
}

function rootFor(path: string, root?: string): string | undefined {
  if (root) return resolve(root);
  let best: string | undefined;
  for (const r of roots) {
    if ((path === r || path.startsWith(r + sep)) && (!best || r.length > best.length)) best = r;
  }
  return best;
}

/** Components strictly between `root` and `path` (excluding `path` itself). */
function between(root: string, path: string): string[] {
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new UnsafePathError(`${path} is not inside ${root}`);
  const parts = rel.split(sep);
  const out: string[] = [];
  let cur = root;
  for (const p of parts.slice(0, -1)) { cur = join(cur, p); out.push(cur); }
  return out;
}

/** Checks (and with `create`, makes) every folder between the root and `path`; none may be a symlink. */
function checkParents(path: string, root: string | undefined, create: boolean): void {
  if (!root) {
    if (create) mkdirSync(dirname(path), { recursive: true });
    return;
  }
  const rst = lstatSync(root, { throwIfNoEntry: false });
  if (!rst) {
    if (!create) return;
    mkdirSync(root, { recursive: true });
  } else if (rst.isSymbolicLink()) {
    // The trusted root itself may be reached through a symlinked prefix (e.g. /tmp on macOS) but must not be one.
    throw new UnsafePathError(`${root} is a symlink`);
  }
  for (const d of between(root, path)) {
    const st = lstatSync(d, { throwIfNoEntry: false });
    if (!st) {
      if (!create) return;
      mkdirSync(d);
      continue;
    }
    if (st.isSymbolicLink()) throw new UnsafePathError(`${d} is a symlink; refusing to use ${path}`);
    if (!st.isDirectory()) throw new UnsafePathError(`${d} is not a directory; refusing to use ${path}`);
  }
}

/** On Linux: the opened descriptor must really be `path` under the (real) root. */
function checkFd(fd: number, path: string, root: string | undefined): void {
  if (!root || process.platform !== 'linux') return;
  let real: string;
  try { real = readlinkSync(`/proc/self/fd/${fd}`); } catch { return; }
  let realRoot: string;
  try { realRoot = realpathSync(root); } catch { throw new UnsafePathError(`${root} vanished`); }
  const want = join(realRoot, relative(root, path));
  if (real !== want) throw new UnsafePathError(`${path} resolved to ${real}; refusing`);
}

function openChecked(path: string, flags: number, root: string | undefined, write: boolean): number {
  let fd: number;
  try {
    fd = openSync(path, flags | NOFOLLOW, 0o664);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') throw new UnsafePathError(`${path} is a symlink; refusing`);
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new UnsafePathError(`${path} is not a regular file; refusing`);
    if (write && st.nlink > 1) throw new UnsafePathError(`${path} has ${st.nlink} hard links; refusing to write it`);
    checkFd(fd, path, root);
    return fd;
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

/** Writes (replaces) a file. Missing folders are created; symlinks and hard links are refused. */
export function safeWriteFile(path: string, data: string | Uint8Array, root?: string): void {
  const p = resolve(path);
  const r = rootFor(p, root);
  checkParents(p, r, true);
  const fd = openChecked(p, constants.O_WRONLY | constants.O_CREAT, r, true);
  try {
    ftruncateSync(fd, 0);
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off, off);
  } finally {
    closeSync(fd);
  }
}

/** Opens a file for appending (log files); the caller closes the descriptor. */
export function safeOpenAppend(path: string, root?: string): number {
  const p = resolve(path);
  const r = rootFor(p, root);
  checkParents(p, r, true);
  return openChecked(p, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, r, true);
}

/** Reads a whole file; refuses symlinks anywhere below the root and non-regular files. */
export function safeReadFile(path: string, root?: string): Buffer {
  const p = resolve(path);
  const r = rootFor(p, root);
  checkParents(p, r, false);
  const fd = openChecked(p, constants.O_RDONLY, r, false);
  try {
    const size = fstatSync(fd).size;
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const b = Buffer.alloc(Math.max(65536, size - total));
      const n = readSync(fd, b, 0, b.length, null);
      if (n <= 0) break;
      chunks.push(b.subarray(0, n));
      total += n;
    }
    return Buffer.concat(chunks, total);
  } finally {
    closeSync(fd);
  }
}

export const safeReadText = (path: string, root?: string): string => safeReadFile(path, root).toString('utf8');

/** True when `path` is an existing regular file (a symlink counts as missing). */
export function safeIsFile(path: string): boolean {
  const st = lstatSync(path, { throwIfNoEntry: false });
  return !!st && st.isFile();
}

/**
 * Before a library (docx/xlsx writer) writes `path` itself: parents are checked/created and a symlink or hard link
 * planted at `path` is removed (unlink removes the link, never its target).
 */
export function prepareWrite(path: string, root?: string): void {
  const p = resolve(path);
  const r = rootFor(p, root);
  checkParents(p, r, true);
  const st = lstatSync(p, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isSymbolicLink() || (st.isFile() && st.nlink > 1)) unlinkSync(p);
  else if (!st.isFile()) throw new UnsafePathError(`${p} is not a regular file; refusing to write it`);
}

/**
 * Copies the regular files of `src` (recursively) to `dst`. Symlinks and special files are skipped, never followed.
 * Returns the copied paths relative to `dst` (forward slashes).
 */
export function safeCopyTree(src: string, dst: string, srcRoot?: string, dstRoot?: string): string[] {
  const out: string[] = [];
  const s0 = resolve(src);
  const st = lstatSync(s0, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) return out;
  const walk = (rel: string): void => {
    const dir = rel ? join(s0, rel) : s0;
    for (const name of readdirSync(dir).sort()) {
      const r = rel ? join(rel, name) : name;
      const e = lstatSync(join(s0, r), { throwIfNoEntry: false });
      if (!e || e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) {
        safeWriteFile(join(dst, r), safeReadFile(join(s0, r), srcRoot), dstRoot);
        out.push(r.split(sep).join('/'));
      }
    }
  };
  walk('');
  return out;
}

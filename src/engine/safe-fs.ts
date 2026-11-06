import { Readable } from 'node:stream';
import {
  close as fsClose, read as fsRead, closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync, readSync, realpathSync,
  rmSync, unlinkSync, writeSync,
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
const NONBLOCK = constants.O_NONBLOCK ?? 0;

function kindOf(st: { isSymbolicLink(): boolean; isDirectory(): boolean; isFIFO(): boolean; isSocket(): boolean }): string {
  return st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'directory' : st.isFIFO() ? 'FIFO' : st.isSocket() ? 'socket' : 'device or special file';
}
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
  // The final component must be a regular file (or missing when creating): a FIFO, device, directory or link is
  // refused before open. O_NONBLOCK makes a FIFO swapped in after this check fail or return at once instead of
  // blocking the event loop forever; it has no effect on regular files, which the fstat below insists on.
  const pre = lstatSync(path, { throwIfNoEntry: false });
  if (pre && !pre.isFile()) throw new UnsafePathError(`${path} is not a regular file (${kindOf(pre)}); refusing`);
  let fd: number;
  try {
    fd = openSync(path, flags | NOFOLLOW | NONBLOCK, 0o664);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') throw new UnsafePathError(`${path} is a symlink; refusing`);
    if (code === 'ENXIO' || code === 'EISDIR' || code === 'EAGAIN') throw new UnsafePathError(`${path} is not a regular file (${code}); refusing`);
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

/**
 * Writes (replaces) a file. Missing folders are created; a symlink, hard-linked file or special file at `path` is
 * refused (UnsafePathError). Every folder below the root is checked with lstat, the file is opened with O_NOFOLLOW
 * (O_EXCL when it did not exist) and WITHOUT O_TRUNC, and only after the descriptor's real path was checked under the
 * root is it truncated and written: a link or folder swapped in at any point is refused before any byte changes.
 * (Not temp-file + rename: worktrees are shared with concurrent `git add -A` runs that would pick temp names up.)
 */
export function safeWriteFile(path: string, data: string | Uint8Array, root?: string): void {
  const p = resolve(path);
  const r = rootFor(p, root);
  checkParents(p, r, true);
  const existed = lstatSync(p, { throwIfNoEntry: false }) !== undefined;
  let fd: number;
  try {
    fd = openChecked(p, constants.O_WRONLY | constants.O_CREAT | (existed ? 0 : constants.O_EXCL), r, true);
  } catch (e) {
    // A file this call created in a folder swapped for a link after the checks: remove it again (it is empty).
    if (!existed && e instanceof UnsafePathError && /resolved to/.test(e.message)) { try { unlinkSync(p); } catch { /* gone */ } }
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new UnsafePathError(`${p} appeared while writing it; refusing`);
    throw e;
  }
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

/** A file is larger than the caller allows reading whole; nothing was allocated for it. */
export class FileTooLargeError extends UnsafePathError {
  constructor(readonly path: string, readonly size: number, readonly maxBytes: number) {
    super(`${path} is ${size} bytes, over the ${maxBytes}-byte limit; refusing to read it`);
    this.name = 'FileTooLargeError';
  }
}

/** Default cap for whole-file reads (a seat can make a sparse multi-GB file in a folder it writes). */
export const DEFAULT_MAX_READ = 64 * 1024 * 1024;

export interface ReadOpts { maxBytes?: number }

/**
 * Reads a whole file; refuses symlinks anywhere below the root, non-regular files and files over `maxBytes`
 * (default DEFAULT_MAX_READ): the size is checked on the opened descriptor before anything is allocated, and a file
 * growing while being read is refused too.
 */
export function safeReadFile(path: string, root?: string, o: ReadOpts = {}): Buffer {
  const max = o.maxBytes ?? DEFAULT_MAX_READ;
  const p = resolve(path);
  const r = rootFor(p, root);
  checkParents(p, r, false);
  const fd = openChecked(p, constants.O_RDONLY, r, false);
  try {
    const size = fstatSync(fd).size;
    if (size > max) throw new FileTooLargeError(p, size, max);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const b = Buffer.alloc(Math.min(Math.max(65536, size - total), max + 1 - total));
      if (b.length === 0) throw new FileTooLargeError(p, total, max);
      const n = readSync(fd, b, 0, b.length, null);
      if (n <= 0) break;
      chunks.push(b.subarray(0, n));
      total += n;
      if (total > max) throw new FileTooLargeError(p, total, max);
    }
    return Buffer.concat(chunks, total);
  } finally {
    closeSync(fd);
  }
}

export const safeReadText = (path: string, root?: string, o: ReadOpts = {}): string => safeReadFile(path, root, o).toString('utf8');

/** lstat of `path` when it is a regular file reached without any symlinked folder below the root; else undefined. */
export function safeStatFile(path: string, root?: string): { size: number; mtimeMs: number } | undefined {
  const p = resolve(path);
  try { checkParents(p, rootFor(p, root), false); } catch (e) { if (e instanceof UnsafePathError) return undefined; throw e; }
  const st = lstatSync(p, { throwIfNoEntry: false });
  return st && st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : undefined;
}

/**
 * Last `maxBytes` of a regular file (read-only views of logs a seat may have grown very large). Same checks as
 * safeReadFile; `size` is the whole file's size, `truncated` tells the caller the head was left out.
 */
export function safeReadTail(path: string, maxBytes: number, root?: string): { data: Buffer; size: number; truncated: boolean } {
  const p = resolve(path);
  const r = rootFor(p, root);
  checkParents(p, r, false);
  const fd = openChecked(p, constants.O_RDONLY, r, false);
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const b = Buffer.alloc(Math.min(size, maxBytes));
    let got = 0;
    while (got < b.length) {
      const n = readSync(fd, b, got, b.length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    return { data: b.subarray(0, got), size, truncated: start > 0 };
  } finally {
    closeSync(fd);
  }
}

/** Regular files directly inside `dir` (symlinks and special entries are left out, never followed). Missing dir: []. */
export function safeListFiles(dir: string, root?: string): { name: string; size: number; mtimeMs: number }[] {
  const d = resolve(dir);
  const r = rootFor(d, root);
  checkParents(join(d, 'x'), r, false);
  const st = lstatSync(d, { throwIfNoEntry: false });
  if (!st) return [];
  if (!st.isDirectory()) throw new UnsafePathError(`${d} is not a directory; refusing`);
  const out: { name: string; size: number; mtimeMs: number }[] = [];
  for (const name of readdirSync(d)) {
    const e = lstatSync(join(d, name), { throwIfNoEntry: false });
    if (e?.isFile()) out.push({ name, size: e.size, mtimeMs: e.mtimeMs });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface TreeEntry { rel: string; size: number; mtimeMs: number }

/**
 * Regular files under `dir`, recursively (relative paths with forward slashes, sorted). Symlinks (to files or folders)
 * and special files are left out and never followed; `dir` and every folder above it up to the root must be real
 * folders. Missing dir: [].
 */
export function safeListTree(dir: string, root?: string): TreeEntry[] {
  const d = resolve(dir);
  const r = rootFor(d, root);
  checkParents(join(d, 'x'), r, false);
  const st = lstatSync(d, { throwIfNoEntry: false });
  if (!st) return [];
  if (!st.isDirectory()) throw new UnsafePathError(`${d} is not a directory; refusing`);
  const out: TreeEntry[] = [];
  const add = (rel: string, e: { size: number; mtimeMs: number }): void => { out.push({ rel: rel.split(sep).join('/'), size: e.size, mtimeMs: e.mtimeMs }); };
  if (process.platform === 'linux') {
    // Walk through directory descriptors (/proc/self/fd/N): every folder is opened with O_NOFOLLOW|O_DIRECTORY and
    // listed through its descriptor, so a folder swapped for a symlink after the lstat is never entered.
    const DIRFLAGS = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW | NONBLOCK;
    const walkFd = (fd: number, rel: string): void => {
      const base = `/proc/self/fd/${fd}`;
      for (const name of readdirSync(base)) {
        const childRel = rel ? join(rel, name) : name;
        const e = lstatSync(`${base}/${name}`, { throwIfNoEntry: false });
        if (!e) continue;
        if (e.isFile()) { add(childRel, e); continue; }
        if (!e.isDirectory()) continue;
        let cfd: number;
        try { cfd = openSync(`${base}/${name}`, DIRFLAGS); } catch { continue; } // became a link (ELOOP) or vanished
        try {
          const cst = fstatSync(cfd);
          if (cst.isDirectory() && cst.ino === e.ino && cst.dev === e.dev) walkFd(cfd, childRel);
        } finally { closeSync(cfd); }
      }
    };
    let fd: number;
    try { fd = openSync(d, DIRFLAGS); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ELOOP' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') throw new UnsafePathError(`${d} is not a directory; refusing`);
      throw e;
    }
    try {
      const fst = fstatSync(fd);
      if (!fst.isDirectory() || fst.ino !== st.ino || fst.dev !== st.dev) throw new UnsafePathError(`${d} changed while listing; refusing`);
      checkFd(fd, d, r);
      walkFd(fd, '');
    } finally { closeSync(fd); }
  } else {
    const walk = (rel: string): void => {
      const cur = rel ? join(d, rel) : d;
      for (const name of readdirSync(cur)) {
        const childRel = rel ? join(rel, name) : name;
        const e = lstatSync(join(d, childRel), { throwIfNoEntry: false });
        if (!e) continue;
        if (e.isDirectory()) walk(childRel);
        else if (e.isFile()) add(childRel, e);
      }
    };
    walk('');
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * Opens a regular file for reading with the same checks as safeReadFile (no symlink at any component, O_NOFOLLOW |
 * O_NONBLOCK, fstat must say regular file, /proc/self/fd check on Linux). The caller owns the descriptor.
 */
export function safeOpenRead(path: string, root?: string): { fd: number; size: number } {
  const p = resolve(path);
  const r = rootFor(p, root);
  checkParents(p, r, false);
  const fd = openChecked(p, constants.O_RDONLY, r, false);
  return { fd, size: fstatSync(fd).size };
}

/**
 * A readable stream over a regular file opened through safeOpenRead. Pass an already opened `fd` (so the caller can
 * answer 403/404 before sending headers), or let the stream open the file lazily on its first read (zip entries: no
 * descriptor is held before the archiver gets to the entry). A lazily opened file that turns out unsafe or missing
 * yields an empty stream with `skipped` set instead of an error, so one planted entry does not break a whole archive.
 */
export class SafeFileStream extends Readable {
  private pos = 0;
  skipped = false;
  /** `limit`: never read past this many bytes (a zip entry stops at the size it was listed with). */
  constructor(private readonly path: string, private readonly root: string | undefined, private fd?: number, private readonly limit = Number.POSITIVE_INFINITY) {
    super({ highWaterMark: 64 * 1024 });
  }

  override _read(n: number): void {
    if (this.fd === undefined) {
      try {
        this.fd = safeOpenRead(this.path, this.root).fd;
      } catch (e) {
        if (e instanceof UnsafePathError || (e as NodeJS.ErrnoException).code === 'ENOENT') {
          this.skipped = true;
          this.push(null);
          return;
        }
        this.destroy(e as Error);
        return;
      }
    }
    const want = Math.min(Math.max(n, 16 * 1024), this.limit - this.pos);
    if (want <= 0) { this.push(null); return; }
    const b = Buffer.allocUnsafe(want);
    fsRead(this.fd, b, 0, b.length, this.pos, (err, bytes) => {
      if (err) { this.destroy(err); return; }
      if (bytes === 0) { this.push(null); return; }
      this.pos += bytes;
      this.push(b.subarray(0, bytes));
    });
  }

  override _destroy(err: Error | null, cb: (e?: Error | null) => void): void {
    const fd = this.fd;
    this.fd = undefined;
    if (fd === undefined) { cb(err); return; }
    fsClose(fd, () => cb(err));
  }
}

/**
 * Creates `dir` (and missing folders above it) below the root; every existing component must be a real folder, never a
 * symlink, so a planted link cannot redirect the creation elsewhere.
 */
export function safeMkdirp(dir: string, root?: string): void {
  const d = resolve(dir);
  const r = rootFor(d, root);
  if (r && d === r) {
    const st = lstatSync(d, { throwIfNoEntry: false });
    if (!st) mkdirSync(d, { recursive: true });
    else if (!st.isDirectory()) throw new UnsafePathError(`${d} is not a directory; refusing`);
    return;
  }
  checkParents(d, r, true);
  const st = lstatSync(d, { throwIfNoEntry: false });
  if (!st) mkdirSync(d);
  else if (st.isSymbolicLink()) throw new UnsafePathError(`${d} is a symlink; refusing`);
  else if (!st.isDirectory()) throw new UnsafePathError(`${d} is not a directory; refusing`);
}

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

/**
 * Deletes `path` below a trusted root: parents are checked with lstat (no symlinked folder on the way); a regular
 * file or a symlink (the link itself, never its target) is unlinked; a directory only with `recursive` (rm does not
 * follow links inside it); anything else is refused. A missing path is fine.
 */
export function safeRemove(path: string, root?: string, o: { recursive?: boolean } = {}): void {
  const p = resolve(path);
  const r = rootFor(p, root);
  checkParents(p, r, false); // throws on a symlinked / non-directory parent
  const st = lstatSync(p, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isFile() || st.isSymbolicLink()) { unlinkSync(p); return; }
  if (st.isDirectory()) {
    if (!o.recursive) throw new UnsafePathError(`${p} is a directory; refusing to delete it`);
    rmSync(p, { recursive: true, force: true });
    return;
  }
  throw new UnsafePathError(`${p} is not a regular file (${kindOf(st)}); refusing to delete it`);
}

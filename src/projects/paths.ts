import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export class PathError extends Error {}

/** Real path of the deepest existing ancestor plus the not-yet-existing tail. Dangling symlinks are rejected. */
function realWithTail(p: string): string {
  let cur = p;
  const tail: string[] = [];
  for (;;) {
    let exists = true;
    try { lstatSync(cur); } catch { exists = false; }
    if (exists) {
      let real: string;
      try { real = realpathSync(cur); } catch { throw new PathError(`Đường dẫn không hợp lệ (liên kết hỏng): ${cur}`); }
      return tail.length ? join(real, ...tail.reverse()) : real;
    }
    const parent = resolve(cur, '..');
    if (parent === cur) throw new PathError(`Đường dẫn không hợp lệ: ${p}`);
    tail.push(cur.slice(parent.length).replace(/^[\\/]+/, ''));
    cur = parent;
  }
}

/**
 * Resolves a project path to its real location and checks it lies strictly inside one of the PROJECT_ROOTS.
 * Rejects relative paths, `..` segments, NUL, symlinks that leave the roots and the root itself.
 * The path may not exist yet (new/clone); nothing is created.
 */
export function resolveProjectPath(input: string, roots: string[]): string {
  if (typeof input !== 'string' || !input.trim()) throw new PathError('Chưa nhập đường dẫn dự án.');
  if (input.includes('\0')) throw new PathError('Đường dẫn chứa ký tự không hợp lệ.');
  if (!isAbsolute(input)) throw new PathError('Đường dẫn dự án phải là đường dẫn tuyệt đối.');
  if (input.split(/[\\/]+/).includes('..')) throw new PathError('Đường dẫn không được chứa "..".');
  if (!roots.length) throw new PathError('Chưa cấu hình PROJECT_ROOTS: không thể tạo dự án.');
  const real = realWithTail(resolve(input));
  for (const r of roots) {
    let rr: string;
    try { rr = realpathSync(r); } catch { continue; }
    const rel = relative(rr, real);
    if (rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return real;
  }
  throw new PathError(`Đường dẫn nằm ngoài các thư mục dự án cho phép (PROJECT_ROOTS): ${input}`);
}

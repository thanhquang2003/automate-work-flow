import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Config } from '../config.js';

/**
 * Secret used to encrypt stored tokens: SECRET_KEY when set; otherwise (local mode) a key file
 * `DATA_DIR/secret.key` holding 32 random bytes (hex), generated on first use.
 */
export function getSecretKey(cfg: Pick<Config, 'secretKey' | 'dataDir'>): string {
  if (cfg.secretKey) return cfg.secretKey;
  const file = join(cfg.dataDir, 'secret.key');
  const read = (): string | undefined => {
    if (!existsSync(file)) return undefined;
    const v = readFileSync(file, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/.test(v)) throw new Error(`Khóa bí mật ${file} rỗng hoặc không hợp lệ. Không tự tạo lại vì sẽ làm mất các token đã mã hóa; hãy khôi phục file hoặc xóa nó thủ công.`);
    return v;
  };
  const have = read();
  if (have) return have;
  const key = randomBytes(32).toString('hex');
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(file, key + '\n', { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return read() ?? key;
    throw e;
  }
  try { chmodSync(file, 0o600); } catch { /* best effort (Windows) */ }
  return key;
}

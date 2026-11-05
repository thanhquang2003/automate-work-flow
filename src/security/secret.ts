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
  if (existsSync(file)) {
    const v = readFileSync(file, 'utf8').trim();
    if (v) return v;
  }
  const key = randomBytes(32).toString('hex');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, key + '\n', { mode: 0o600, flag: 'w' });
  try { chmodSync(file, 0o600); } catch { /* best effort (Windows) */ }
  return key;
}

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.js';

export type TemplateKind = 'tkct' | 'tkdb' | 'testcase' | 'ulnl';

const EXT: Record<TemplateKind, 'docx' | 'xlsx'> = { tkct: 'docx', tkdb: 'docx', testcase: 'xlsx', ulnl: 'xlsx' };

/** Bundled default templates, resolved from the app root (src/office or dist/office → ../../templates/default). */
export const DEFAULT_TEMPLATES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../templates/default');

/** User template in `${dataDir}/templates/<kind>.<ext>` when present, else the bundled default. */
export function templatePath(cfg: Config, kind: TemplateKind): string {
  const file = `${kind}.${EXT[kind]}`;
  const custom = join(cfg.dataDir, 'templates', file);
  return existsSync(custom) ? custom : join(DEFAULT_TEMPLATES_DIR, file);
}

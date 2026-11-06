// Usage: BREAKGLASS_PASSWORD=... npm run admin:set-password -- <username>   (or omit the env var to be prompted)
// Creates/updates the break-glass local admin. Refuses any username other than BREAKGLASS_ADMIN.
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/db.js';
import { Repo } from '../src/db/repo.js';
import { hashPassword } from '../src/security/crypto.js';

const username = process.argv[2];
const cfg = loadConfig();
if (!cfg.breakglassAdmin || username !== cfg.breakglassAdmin) {
  console.error('refused: username must equal BREAKGLASS_ADMIN (set it in the environment first)');
  process.exit(2);
}
let password = process.env.BREAKGLASS_PASSWORD ?? '';
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question('New password (min 12 chars, input is visible): ');
  rl.close();
}
if (password.length < 12) {
  console.error('password must be at least 12 characters');
  process.exit(2);
}
const repo = new Repo(openDb(`${cfg.dataDir}/devflow.db`));
const hash = hashPassword(password);
const u = repo.web.getUserByUsername(username);
if (u) {
  repo.web.setUserPassword(u.id, hash);
  repo.web.setUserSysRole(u.id, 'admin');
} else {
  repo.web.createUser({ username, passwordHash: hash, role: 'admin' });
}
console.log(`break-glass admin '${username}' ready`);

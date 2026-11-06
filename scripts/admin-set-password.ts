// Usage: npm run admin:set-password -- <username> <password>
// Creates/updates the break-glass local admin (used only when BREAKGLASS_ADMIN=<username> is set).
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/db.js';
import { Repo } from '../src/db/repo.js';
import { hashPassword } from '../src/security/crypto.js';

const [username, password] = process.argv.slice(2);
if (!username || !password || password.length < 12) {
  console.error('usage: admin:set-password <username> <password (min 12 chars)>');
  process.exit(2);
}
const cfg = loadConfig();
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

// Fake `claude auth login` as seen through dfctl + script (pty): ANSI noise, a URL, a code prompt.
// argv[2] = fixture dir. Mode from <dir>/login-mode: ok | hang | evil | fail.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
let mode = 'ok';
try { mode = readFileSync(join(dir, 'login-mode'), 'utf8').trim(); } catch { /* default */ }
writeFileSync(join(dir, 'login-pid'), String(process.pid));
const w = s => process.stdout.write(s);
const url = mode === 'evil' ? 'https://evil.example.com/oauth?x=1' : 'https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz';

w('\x1b[?25l\x1b[1mWelcome to Claude Code\x1b[0m\r\n');
w(`Browser didn't open? Use the url below to sign in:\r\n\r\n\x1b]8;;${url}\x07${url}\x1b]8;;\x07\r\n\r\n`);
w('Paste code here if prompted > ');

if (mode === 'hang' || mode === 'evil') {
  setInterval(() => {}, 1000);
} else {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => {
    buf += d;
    const i = buf.search(/[\r\n]/);
    if (i < 0) return;
    const code = buf.slice(0, i);
    writeFileSync(join(dir, 'received'), code);
    w(code + '\r\n'); // a pty echoes what was typed
    if (mode === 'fail') { w('OAuth error: invalid code\r\n'); process.exit(1); }
    w('Login successful.\r\n');
    process.exit(0);
  });
}

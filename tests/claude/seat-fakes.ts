import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE_CLAUDE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const FAKE_LOGIN = fileURLToPath(new URL('./fake-login.mjs', import.meta.url));
const SEP = '\x1f';

/**
 * A fake `sudo` (insists on -n, logs, then execs the rest) and a fake dfctl that records every call and
 * behaves like the real one from the caller's side: run-claude execs fake-claude (mode from <dir>/mode),
 * claude-auth login execs fake-login, status prints <dir>/status-out and exits <dir>/status-rc.
 */
export function mkSeatFakes() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'df-seat-')));
  const sudo = join(dir, 'sudo');
  const dfctl = join(dir, 'dfctl');
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  writeFileSync(sudo, `#!/bin/bash
[ "$1" = "-n" ] || { echo "fake sudo: expected -n" >&2; exit 99; }
shift
(IFS=$'${SEP}'; printf '%s\\n' "$*") >> ${q(join(dir, 'sudo-calls'))}
exec "$@"
`);
  writeFileSync(dfctl, `#!/bin/bash
D=${q(dir)}
(IFS=$'${SEP}'; printf '%s\\n' "$*") >> "$D/calls"
case "$1" in
  run-claude) shift 6; m=ok; [ -f "$D/mode" ] && m=$(cat "$D/mode"); exec ${q(process.execPath)} ${q(FAKE_CLAUDE)} "$m" "$@" ;;
  claude-auth)
    case "$3" in
      status) cat "$D/status-out" 2>/dev/null; rc=0; [ -f "$D/status-rc" ] && rc=$(cat "$D/status-rc"); exit "$rc" ;;
      logout) exit 0 ;;
      login) exec ${q(process.execPath)} ${q(FAKE_LOGIN)} "$D" ;;
    esac ;;
  stop-claude) exit 0 ;;
  *) [ -f "$D/fail" ] && { echo "dfctl: boom" >&2; exit 1; }; exit 0 ;;
esac
`);
  chmodSync(sudo, 0o755);
  chmodSync(dfctl, 0o755);
  const read = (f: string) => existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '';
  return {
    dir, sudo, dfctl,
    set: (f: string, v: string) => writeFileSync(join(dir, f), v),
    read,
    /** dfctl calls, each as its argv. */
    calls: () => read('calls').split('\n').filter(Boolean).map(l => l.split(SEP)),
    sudoCalls: () => read('sudo-calls').split('\n').filter(Boolean).map(l => l.split(SEP)),
  };
}

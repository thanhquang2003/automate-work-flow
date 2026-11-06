import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { killTree } from './runner.js';

/**
 * One `claude auth login` running for a seat (spec v3 §5.2). Claude Code prints a login URL that the user
 * opens in their own browser (Anthropic's flow); if the browser shows a code, the user pastes it and it is
 * written verbatim to the process stdin. DevFlow never logs, stores or echoes the code or the process
 * output; it only extracts the URL, and the result is the process exit status.
 *
 * Events: `url` (string, once, only for an allow-listed https URL), `done` (LoginResult, once).
 */
export interface LoginResult {
  success: boolean;
  reason?: 'timeout' | 'cancelled' | 'failed' | 'spawn';
}

export interface LoginSession extends EventEmitter {
  /** The login URL once printed (undefined before that, or if none was allowed). */
  readonly url: string | undefined;
  /** Resolves once with the outcome. */
  readonly result: Promise<LoginResult>;
  /** Passes a pasted code to the login process. Throws on an invalid code or after the session ended. */
  sendCode(code: string): void;
  /** Stops the login; result becomes `{success:false, reason:'cancelled'}`. */
  cancel(): void;
}

export const LOGIN_TIMEOUT_MS = 10 * 60_000;

/** Hosts a Claude login URL may point at. Anything else is never shown to the user. */
const ALLOWED_HOST = /(^|\.)(claude\.ai|claude\.com|anthropic\.com)$/i;
const MAX_SCAN = 64 * 1024;

// OSC (ESC ] ... BEL | ESC \), CSI and other two-byte escapes.
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const OSC8_RE = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ESC2_RE = /\x1b[@-Z\\-_]/g;
const URL_RE = /https:\/\/[^\s"'<>\x00-\x1f\x7f]+/g;

function allowedUrl(candidate: string): string | undefined {
  const raw = candidate.replace(/[),.;\]]+$/, '');
  let u: URL;
  try { u = new URL(raw); } catch { return undefined; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return undefined;
  if (!ALLOWED_HOST.test(u.hostname)) return undefined;
  return raw;
}

/** First allow-listed https URL in raw terminal output (OSC 8 hyperlink targets first, then visible text). */
export function extractLoginUrl(raw: string): string | undefined {
  for (const m of raw.matchAll(OSC8_RE)) {
    const ok = m[1] ? allowedUrl(m[1]) : undefined;
    if (ok) return ok;
  }
  const text = raw.replace(OSC_RE, '').replace(CSI_RE, '').replace(ESC2_RE, '').replace(/\r/g, '');
  for (const m of text.matchAll(URL_RE)) {
    const ok = allowedUrl(m[0]);
    if (ok) return ok;
  }
  return undefined;
}

/** A pasted login code: one token of printable characters, no whitespace or control characters. */
export function validateLoginCode(code: string): string {
  const c = typeof code === 'string' ? code.trim() : '';
  if (!c) throw new Error('Chưa nhập mã đăng nhập.');
  if (c.length > 2048) throw new Error('Mã đăng nhập quá dài.');
  if (!/^[\x21-\x7e]+$/.test(c)) throw new Error('Mã đăng nhập chứa ký tự không hợp lệ.');
  return c;
}

export interface LoginProcessSpec {
  bin: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Extra stop action (e.g. `dfctl stop-claude`), called on timeout/cancel before killing the local child. */
  onKill?: () => void;
}

export class ProcessLoginSession extends EventEmitter implements LoginSession {
  #url: string | undefined;
  #child: ChildProcess | undefined;
  #scan = '';
  #ended = false;
  #stopReason: LoginResult['reason'] | undefined;
  #timer: NodeJS.Timeout | undefined;
  #resolve!: (r: LoginResult) => void;
  readonly result: Promise<LoginResult>;

  constructor(spec: LoginProcessSpec) {
    super();
    this.result = new Promise<LoginResult>(res => { this.#resolve = res; });
    // `done`/`url` listeners are optional; an 'error' event is never emitted.
    try {
      this.#child = spawn(spec.bin, spec.args, {
        cwd: '/', env: spec.env ?? {}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
      });
    } catch {
      queueMicrotask(() => this.#finish({ success: false, reason: 'spawn' }));
      return;
    }
    const child = this.#child;
    const onData = (d: Buffer) => {
      if (this.#url !== undefined || this.#scan.length > MAX_SCAN) return;
      this.#scan += d.toString('utf8');
      const url = extractLoginUrl(this.#scan);
      if (url) {
        this.#url = url;
        this.#scan = ''; // nothing of the output is kept once the URL is known
        this.emit('url', url);
      }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.stdin!.on('error', () => { /* process may be gone */ });
    child.on('error', () => this.#finish({ success: false, reason: 'spawn' }));
    child.on('close', code => {
      if (this.#stopReason) this.#finish({ success: false, reason: this.#stopReason });
      else this.#finish(code === 0 ? { success: true } : { success: false, reason: 'failed' });
    });
    this.#onKill = spec.onKill;
    this.#timer = setTimeout(() => this.#stop('timeout'), spec.timeoutMs ?? LOGIN_TIMEOUT_MS);
    this.#timer.unref();
  }

  #onKill: (() => void) | undefined;

  get url(): string | undefined { return this.#url; }

  sendCode(code: string): void {
    if (this.#ended || this.#stopReason || !this.#child?.stdin?.writable) throw new Error('Phiên đăng nhập đã kết thúc (session ended).');
    const c = validateLoginCode(code);
    // Enter in a pty; written once, never kept or logged.
    this.#child.stdin.write(`${c}\r`);
  }

  cancel(): void { this.#stop('cancelled'); }

  #stop(reason: 'timeout' | 'cancelled'): void {
    if (this.#ended || this.#stopReason) return;
    this.#stopReason = reason;
    try { this.#onKill?.(); } catch { /* best effort */ }
    if (this.#child) killTree(this.#child);
    // If the child cannot be signalled (it belongs to root/another user), do not wait forever.
    const t = setTimeout(() => this.#finish({ success: false, reason }), 15_000);
    t.unref();
  }

  #finish(r: LoginResult): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#scan = '';
    if (this.#timer) clearTimeout(this.#timer);
    try { this.#child?.stdin?.destroy(); } catch { /* ignore */ }
    this.#resolve(r);
    this.emit('done', r);
  }
}

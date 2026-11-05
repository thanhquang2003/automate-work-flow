import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const SRC = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');

/** Runs public/app.js against a tiny fake DOM; returns hooks to fire SSE events and focus changes. */
function load(rendered: { status: string; stage: string }) {
  const listeners: Record<string, ((ev: unknown) => void)[]> = {};
  const esListeners: Record<string, (ev: { data: string }) => void> = {};
  const log = { dataset: { events: '/requests/REQ-001/events', ...rendered }, scrollTop: 0, clientHeight: 0, scrollHeight: 0, childNodes: [], appendChild: () => {} };
  const doc = {
    activeElement: { tagName: 'BODY' } as { tagName: string; isContentEditable?: boolean },
    getElementById: (id: string) => (id === 'log' ? log : null),
    addEventListener: (n: string, f: (ev: unknown) => void) => { (listeners[n] ??= []).push(f); },
    createElement: () => ({}),
  };
  const reload = vi.fn();
  const timers: (() => void)[] = [];
  class FakeES { constructor(public url: string) {} addEventListener(n: string, f: (ev: { data: string }) => void) { esListeners[n] = f; } close() {} }
  const window = { EventSource: FakeES, confirm: () => true };
  runInNewContext(SRC, { window, document: doc, EventSource: FakeES, location: { reload }, setTimeout: (f: () => void) => { timers.push(f); }, JSON, String, Date });
  const flush = () => { while (timers.length) timers.shift()!(); };
  return {
    doc, reload, flush,
    status: (status: string, stage: string) => { esListeners.status!({ data: JSON.stringify({ status, stage }) }); flush(); },
    blur: () => { for (const f of listeners.focusout ?? []) f({}); flush(); },
  };
}

describe('public/app.js live status', () => {
  it('ignores a status event equal to what the page rendered', () => {
    const p = load({ status: 'running', stage: 'ANALYSIS' });
    p.status('running', 'ANALYSIS');
    expect(p.reload).not.toHaveBeenCalled();
    p.status('awaiting_approval', 'ANALYSIS');
    expect(p.reload).toHaveBeenCalledTimes(1);
  });

  it('defers the reload while a textarea has focus, then reloads on blur', () => {
    const p = load({ status: 'awaiting_approval', stage: 'DESIGN' });
    p.doc.activeElement = { tagName: 'TEXTAREA' };
    p.status('running', 'DESIGN');
    expect(p.reload).not.toHaveBeenCalled();
    p.doc.activeElement = { tagName: 'INPUT' }; // focus moved to another field: still typing
    p.blur();
    expect(p.reload).not.toHaveBeenCalled();
    p.doc.activeElement = { tagName: 'BODY' };
    p.blur();
    expect(p.reload).toHaveBeenCalledTimes(1);
  });
});

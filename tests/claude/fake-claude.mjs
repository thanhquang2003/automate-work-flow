// Fake claude CLI. argv[2] = mode. Prompt is read from stdin when not in argv.
const mode = process.argv[2];
const args = process.argv.slice(3);
let stdin = '';
if (!process.stdin.isTTY) { for await (const c of process.stdin) stdin += c; }
const pi = args.indexOf('-p');
const prompt = pi >= 0 && args[pi + 1] && !args[pi + 1].startsWith('--') ? args[pi + 1] : stdin;
const out = (o) => console.log(JSON.stringify(o));
if (mode === 'hang') { out({ type: 'system', subtype: 'init', session_id: 's-h' }); setInterval(() => {}, 1000); }
else if (mode === 'ratelimit') {
  out({ type: 'system', subtype: 'init', session_id: 's-r' });
  out({ type: 'result', is_error: true, result: 'Claude usage limit reached. Your limit will reset at 3pm' });
  process.exit(1);
} else if (mode === 'stderr-limit') { console.error('rate limit exceeded'); process.exit(1); }
else {
  out({ type: 'system', subtype: 'init', session_id: 'sess-123' });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello there' }] } });
  console.log('not json');
  out({ type: 'result', is_error: false, result: JSON.stringify({ prompt, args }) });
}

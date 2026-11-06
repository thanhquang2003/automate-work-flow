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
} else if (mode === 'ok-stderr-limit') { console.error('rate limit warning'); out({ type: 'result', is_error: false, result: 'fine' }); }
else if (mode === 'partial') {
  const line = JSON.stringify({ type: 'result', is_error: false, result: 'joined' });
  process.stdout.write(line.slice(0, 10)); await new Promise(r => setTimeout(r, 100)); process.stdout.write(line.slice(10) + '\n');
}
else if (mode === 'noresult') { out({ type: 'system', subtype: 'init', session_id: 's-n' }); process.exit(3); }
else if (mode === 'plain-limit') { console.log('Claude usage limit reached'); process.exit(1); }
else if (mode === 'env') { out({ type: 'result', is_error: false, result: JSON.stringify(process.env) }); }
else if (mode === 'stderr-limit') { console.error('rate limit exceeded'); process.exit(1); }
else if (mode === 'expired') {
  out({ type: 'system', subtype: 'init', session_id: 's-e' });
  out({ type: 'result', is_error: true, result: 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. Please obtain a new token or refresh your existing token."}}' });
  process.exit(1);
}
else if (mode === 'notloggedin') { console.log('Invalid API key · Please run /login'); process.exit(1); }
else if (mode === 'ok-mentions-login') {
  out({ type: 'result', is_error: false, result: 'Fixed the "Login expired" banner and the not logged in redirect.' });
}
else {
  out({ type: 'system', subtype: 'init', session_id: 'sess-123' });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello there' }] } });
  console.log('not json');
  out({ type: 'result', is_error: false, result: JSON.stringify({ prompt, args }) });
}

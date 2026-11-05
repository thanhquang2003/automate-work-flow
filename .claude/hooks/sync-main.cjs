#!/usr/bin/env node
'use strict';
// PostToolUse hook: fast-forward the main worktree after a PR merge or push to main.
// Runs only when the Bash command was a merge or push-to-main operation.

const cp = require('child_process');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  let command = '';
  let isError = false;
  try {
    const d = JSON.parse(raw);
    const ti = (d.tool_input && typeof d.tool_input === 'object') ? d.tool_input : {};
    command = typeof ti.command === 'string' ? ti.command : '';
    const tr = (d.tool_response && typeof d.tool_response === 'object') ? d.tool_response : {};
    isError = tr.isError === true;
  } catch (_) {
    process.exit(0);
  }

  // Skip if the command failed
  if (isError) process.exit(0);

  // Only sync after merge or push-to-main commands
  const cmdLower = command.toLowerCase();
  const shouldSync = (
    cmdLower.includes('gh pr merge') ||
    (cmdLower.includes('gh api') && cmdLower.includes('merge')) ||
    (cmdLower.includes('git push') && cmdLower.includes('main')) ||
    cmdLower.includes('head:main')
  );
  if (!shouldSync) process.exit(0);

  // Find the main worktree path
  const wtResult = cp.spawnSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  if (wtResult.error || wtResult.status !== 0) process.exit(0);

  let mainWt = '';
  let currentWt = '';
  for (const line of wtResult.stdout.split('\n')) {
    if (line.startsWith('worktree ')) currentWt = line.slice(9).trim();
    if (line === 'branch refs/heads/main' && currentWt) {
      mainWt = currentWt;
      break;
    }
  }

  if (!mainWt) process.exit(0);

  // Fast-forward main worktree
  cp.spawnSync('git', ['-C', mainWt, 'fetch', 'origin', '-q'], { encoding: 'utf8' });
  cp.spawnSync('git', ['-C', mainWt, 'merge', '--ff-only', 'origin/main'], { encoding: 'utf8' });

  process.exit(0);
});

process.stdin.resume();

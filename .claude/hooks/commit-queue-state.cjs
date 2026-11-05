#!/usr/bin/env node
'use strict';
// PostToolUse hook: commit and push the relevant state file to main
// after any "lah add task|feature|defect" command succeeds.

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

  // Only act on successful lah add task/feature/defect commands
  if (!/lah add (task|feature|defect)/i.test(command)) process.exit(0);
  if (isError) process.exit(0);

  // Find the main worktree path
  const wtResult = cp.spawnSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  let mainWt = '';
  if (!wtResult.error && wtResult.status === 0) {
    let currentWt = '';
    for (const line of wtResult.stdout.split('\n')) {
      if (line.startsWith('worktree ')) currentWt = line.slice(9).trim();
      if (line === 'branch refs/heads/main' && currentWt) {
        mainWt = currentWt;
        break;
      }
    }
  }

  // Fall back to repo root if main worktree not found
  if (!mainWt) {
    const rootResult = cp.spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    if (!rootResult.error && rootResult.status === 0) mainWt = rootResult.stdout.trim();
  }
  if (!mainWt) process.exit(0);

  // Skip if already running in the main worktree — lah add already wrote there directly
  const currentRootResult = cp.spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const currentRoot = (!currentRootResult.error && currentRootResult.status === 0)
    ? currentRootResult.stdout.trim() : '';
  if (currentRoot && currentRoot === mainWt) process.exit(0);

  // Pull latest main so we never add on top of a stale state file
  cp.spawnSync('git', ['-C', mainWt, 'pull', 'origin', 'main', '--ff-only', '--quiet'], { encoding: 'utf8' });

  // Re-run the same lah add command in the main worktree context
  const addResult = cp.spawnSync(command, [], {
    cwd: mainWt,
    shell: true,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (addResult.status !== 0) process.exit(0);

  // Extract item type from command
  const typeMatch = command.match(/lah add (\w+)/i);
  const type = typeMatch ? typeMatch[1].toLowerCase() : 'item';

  // Extract title/name from command flags
  const titleMatch =
    command.match(/--title\s+"([^"]+)"/) ||
    command.match(/--title\s+'([^']+)'/) ||
    command.match(/--name\s+"([^"]+)"/) ||
    command.match(/--name\s+'([^']+)'/);
  const title = titleMatch ? titleMatch[1] : `new ${type}`;

  // Select the correct state file based on item type
  const stateFile =
    type === 'defect' ? 'state/defect_list.json' :
    type === 'feature' ? 'state/feature_list.json' :
    'state/task_list.json';

  // Stage only if changed
  const diffResult = cp.spawnSync('git', ['-C', mainWt, 'diff', '--quiet', stateFile], { encoding: 'utf8' });
  if (diffResult.status === 0) process.exit(0); // No changes

  cp.spawnSync('git', ['-C', mainWt, 'add', stateFile], { encoding: 'utf8' });
  cp.spawnSync('git', ['-C', mainWt, 'commit', '-m', `chore(state): add ${type} — ${title}`], { encoding: 'utf8' });
  cp.spawnSync('git', ['-C', mainWt, 'push', 'origin', 'main'], { encoding: 'utf8' });

  process.exit(0);
});

process.stdin.resume();

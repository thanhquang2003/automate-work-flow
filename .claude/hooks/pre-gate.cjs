#!/usr/bin/env node
'use strict';
// CoreWorkflow — universal safety gate
// Registered for ALL PreToolUse events: Bash, PowerShell, MCP tools, and any future tool.
// Blocks every destructive operation (file, folder, database record/row/column/schema,
// git history, cloud resources) and requires explicit user approval.
//
// Exits 2 to block (Claude Code shows the message and asks user to approve/deny).
// Exits 0 to allow.
//
// Disable for a controlled session: GATE_DISABLED=true claude ...

const env = process.env;

// ── Operator escape hatch ──────────────────────────────────────────────────────
const gd = env.GATE_DISABLED;
if (gd === '1' || gd === 'true' || gd === 'on' || gd === 'yes' || gd === 'enabled') process.exit(0);
const eg = env.ECC_GATEGUARD;
if (eg === '0' || eg === 'false' || eg === 'off' || eg === 'no' || eg === 'disabled') process.exit(0);

// ── Read stdin ─────────────────────────────────────────────────────────────────
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  let toolName = '';
  let command = '';
  let toolInputJson = '{}';

  try {
    const d = JSON.parse(raw);
    const ti = (d.tool_input && typeof d.tool_input === 'object') ? d.tool_input : {};
    toolName = d.tool_name || '';
    command = typeof ti.command === 'string' ? ti.command : '';
    toolInputJson = JSON.stringify(ti);
  } catch (_) {
    process.stderr.write('\n╔══════════════════════════════════════════════════════════╗\n');
    process.stderr.write('║  BLOCKED — SAFETY GATE: PARSE FAILURE                    ║\n');
    process.stderr.write('╚══════════════════════════════════════════════════════════╝\n');
    process.stderr.write('  Cannot parse hook JSON.\n');
    process.stderr.write('  Blocking as a safety measure. Ensure node is on PATH.\n\n');
    process.exit(2);
  }

  // ── block() ─────────────────────────────────────────────────────────────────
  function block(rule, reason) {
    process.stderr.write('\n');
    process.stderr.write('╔══════════════════════════════════════════════════════════╗\n');
    process.stderr.write('║  BLOCKED — APPROVAL REQUIRED                             ║\n');
    process.stderr.write('╚══════════════════════════════════════════════════════════╝\n');
    process.stderr.write('  Tool   : ' + toolName + '\n');
    process.stderr.write('  Rule   : ' + rule + '\n');
    process.stderr.write('  Reason : ' + reason + '\n');
    if (command) {
      process.stderr.write('  Command: ' + command + '\n');
    } else {
      process.stderr.write('  Input  : ' + toolInputJson + '\n');
    }
    process.stderr.write('\n');
    process.stderr.write('  >> AI: stop and ask the user "Approve or reject?"\n');
    process.stderr.write('  >> If approved : re-run the same command with  # gate:approved  appended.\n');
    process.stderr.write('  >> If rejected : do not run the command.\n\n');
    process.exit(2);
  }

  // ── Per-command approval marker ───────────────────────────────────────────
  if (command && /#\s*gate:approved/i.test(command)) process.exit(0);

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 1 — ALL TOOLS: destructive tool-name check
  // ═══════════════════════════════════════════════════════════════════════════
  const toolLower = toolName.toLowerCase();
  if (/(_|__)(?:delete|remove|drop|destroy|purge|trash|wipe|truncate|erase|clear)(_|$)/.test(toolLower))
    block('Destructive MCP operation', "Tool '" + toolName + "' name signals a destructive operation — requires user approval.");

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 2 — BASH & POWERSHELL: command pattern analysis
  // ═══════════════════════════════════════════════════════════════════════════
  if (command) {
    const C = command.toLowerCase().replace(/[ \t]+/g, ' ');

    // Strip quoted strings to avoid false positives from commit messages / echo args.
    const stripQuotes = s => s.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');

    // Expand $(...) and backtick subshells so nested destructive commands are caught.
    const expandSubshells = s => {
      let out = s;
      for (let i = 0; i < 4; i++) {
        const prev = out;
        out = out.replace(/\$\(([^)]*)\)/g, ';$1;').replace(/`([^`]*)`/g, ';$1;');
        if (out === prev) break;
      }
      return out;
    };

    let C_SQ = stripQuotes(C);
    let C_EX = expandSubshells(C);

    // ── WSL inner command extraction ────────────────────────────────────────
    const wslMatch = C.match(/.*wsl\b[^"']*-c\s*"([^"]*)"/) || C.match(/.*wsl\b[^"']*-c\s*'([^']*)'/);
    if (wslMatch) {
      const wslC = wslMatch[1].toLowerCase().replace(/[ \t]+/g, ' ');
      C_EX = C_EX + ' ; ' + expandSubshells(wslC);
      C_SQ = C_SQ + ' ; ' + stripQuotes(wslC);
    }

    // ── Git: destructive / irreversible ─────────────────────────────────────
    if (/git\s+push\s+.*(?:--force|-f)\b/.test(C_EX))
      block('No force push', 'Force-pushing overwrites remote history irreversibly.');
    if (/git\s+push\s+\w+\s+\+[a-z]/.test(C_EX))
      block('No +refspec force push', 'git push origin +<branch> forces a non-fast-forward update.');
    if (/git\s+push\s+\w+\s+(?:main|master)\s*$/.test(C_EX))
      block('No direct push to main/master', 'Direct push to main or master — open a PR instead.');
    if (/git\s+reset\s+--hard/.test(C_EX))
      block('No hard reset', 'git reset --hard permanently discards committed work.');
    if (/git\s+clean\s+.*-[a-z]*f/.test(C_EX))
      block('No git clean -f', 'Permanently deletes all untracked files.');
    if (/git\s+(?:checkout|restore)\s+--\s*\./.test(C_EX))
      block('No discard all changes', 'Discards all uncommitted changes irreversibly.');
    if (/git\s+switch\s+.*(?:--force|--discard-changes|-[a-z]*[fC])/.test(C_EX))
      block('No git switch --force', 'Discards uncommitted working-tree changes.');
    // C_EX is already lowercased; -D becomes -d, so match lowercase d here.
    if (/git\s+branch\s+-[a-z]*d\b/.test(C_EX))
      block('No force branch delete', 'Force-deleting a branch is irreversible.');
    if (/git\s+commit\s+.*--amend/.test(C_EX))
      block('No git commit --amend', 'Amending rewrites published history.');
    // Check git rm before the generic rm pattern so it gets a precise rule name.
    if (/\bgit\s+rm\b/.test(C_EX))
      block('No git rm', 'Removing tracked files requires user approval.');
    if (/\bgit\s+merge\b.*\s(?:origin\/)?(?:main|master)\b/.test(C_EX))
      block('No merge-to-sync', 'Use git rebase origin/main to sync with main — git merge creates unwanted merge commits in history.');

    // ── File / directory deletion — Unix ────────────────────────────────────
    // Check find -exec rm before the generic rm pattern.
    if (/\bfind\b.*-exec\s+(?:rm|rmdir|unlink)\b/.test(C_EX))
      block('No find -exec rm', 'Mass deletion via find -exec requires user approval.');
    if (/(^|[;|&\s])\s*(?:\/?(?:[a-z]*\/)*)?rm(?:\.[a-z]+)?\s/.test(C_EX))
      block('No rm', 'File/directory deletion requires user approval.');
    if (/\brmdir\b/.test(C_EX))
      block('No rmdir', 'Directory removal requires user approval.');
    if (/\bunlink\b/.test(C_EX))
      block('No unlink', 'Permanent file removal requires user approval.');
    if (/\b(?:shred|wipe|srm)\b/.test(C_EX))
      block('No secure delete', 'Secure-delete tools require user approval.');

    // ── File / directory deletion — Windows / PowerShell ────────────────────
    if (/\bremove-item\b/.test(C_EX))
      block('No Remove-Item', 'File/directory removal requires user approval.');
    if (/(^|[;|&\s])\s*ri\s/.test(C_EX))
      block('No ri (Remove-Item alias)', 'ri is a PowerShell alias for Remove-Item.');
    if (/(^|[;|&\s])\s*rd\s/.test(C_EX))
      block('No rd (Remove-Item alias)', 'rd is a PowerShell alias for Remove-Item.');
    if (/(^|[;|&\s])\s*erase\s/.test(C_EX))
      block('No erase (Remove-Item alias)', 'erase is a PowerShell alias for Remove-Item.');
    if (/\bdel[\s/]/.test(C_EX))
      block('No del', 'File deletion requires user approval.');

    // ── Database: records, rows, columns, schema ─────────────────────────────
    // Use quote-stripped form (C_SQ) to avoid SQL inside commit messages triggering.
    if (/\bdelete\s+from\b/.test(C_SQ))
      block('No SQL DELETE', 'Deleting database rows/records requires user approval.');
    if (/\bdrop\s+(?:database|table|index|view|procedure|function|trigger|schema|sequence)\b/.test(C_SQ))
      block('No SQL DROP', 'Dropping database objects requires user approval.');
    if (/\btruncate\s+table\b/.test(C_SQ))
      block('No SQL TRUNCATE', 'Truncating a table (deletes all rows) requires user approval.');
    if (/\balter\s+table\b.*\bdrop\s+(?:column|constraint)\b/.test(C_SQ))
      block('No ALTER TABLE DROP COLUMN/CONSTRAINT', 'Dropping a column or constraint deletes data and requires user approval.');
    if (/dotnet\s+ef\s+database\s+(?:drop|update\s+0\b)/.test(C_SQ))
      block('No EF database drop/reset', 'Dropping or reverting all EF migrations requires user approval.');
    if (/dotnet\s+ef\s+migrations\s+remove/.test(C_SQ))
      block('No EF migrations remove', 'Removing a migration deletes schema history — requires user approval.');
    if (/dotnet\s+ef\s+database\s+update\s+\w/.test(C_SQ))
      block('No EF database update to target', 'Rolling back to a specific migration may delete schema/data.');
    if (/dotnet\s+user-secrets\s+(?:clear|remove)\b/.test(C_SQ))
      block('No user-secrets clear/remove', 'Clearing secrets requires user approval.');
    if (/\b(?:flushall|flushdb)\b/.test(C_SQ))
      block('No Redis FLUSH', 'Flushing all Redis keys requires user approval.');

    // ── System-level ─────────────────────────────────────────────────────────
    if (/\bnpm\s+(?:i|install)\s+(?:-g|--global)\b/.test(C_EX))
      block('No npm global install', 'Global npm installs modify the system outside this project.');
    if (/\bwsl\s+--unregister\b/.test(C_EX))
      block('No WSL unregister', 'Unregistering a WSL distro permanently deletes it and all its data.');
    if (/\bdd\s+if=/.test(C_EX))
      block('No dd', 'dd can overwrite raw disk devices — requires user approval.');
    if (/\b(?:diskpart|format\s+[a-z]:)/.test(C_EX))
      block('No disk operations', 'Disk formatting/partitioning is never allowed without explicit approval.');
  }

  // ── All clear ─────────────────────────────────────────────────────────────
  process.exit(0);
});

process.stdin.resume();

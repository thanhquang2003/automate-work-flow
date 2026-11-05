#!/usr/bin/env node
'use strict';
// Git pre-commit hook: validate state files before commit.
// 1. Blocks state-file-only commits on non-main branches (Rule 31).
// 2. Blocks commits where done/resolved items have no PR URL in evidence.
//
// Install via: lah init  (or lah upgrade for existing projects)

const { spawnSync } = require('child_process');

// ── Find git root (handles worktrees) ─────────────────────────────────────────
function gitRoot() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' });
  return (r.status === 0 && r.stdout.trim()) ? r.stdout.trim() : process.cwd();
}

const root = gitRoot();

const DONE_STATUSES = new Set(['done', 'resolved', 'completed']);
// Accepts GitHub PR URLs: https://github.com/owner/repo/pull/123
const PR_URL_RE = /https:\/\/github\.com\/[^\s/"]+\/[^\s/"]+\/pull\/\d+/;

function getAllStagedFiles() {
  const r = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}

function getCurrentBranch() {
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

// ── Check 1: state-file-only commits must be on main (Rule 31) ────────────────
const allStaged = getAllStagedFiles();
const stateOnly = allStaged.length > 0 && allStaged.every(f => f.startsWith('state/') && f.endsWith('.json'));
if (stateOnly) {
  const branch = getCurrentBranch();
  // Allow: main, empty (git error), 'HEAD' (detached or unborn — fresh repo/CI)
  const isNonMainBranch = branch && branch !== 'HEAD' && branch !== 'main';
  if (isNonMainBranch) {
    process.stderr.write('\n');
    process.stderr.write('╔══════════════════════════════════════════════════════════╗\n');
    process.stderr.write('║  COMMIT BLOCKED — State-file commit on wrong branch      ║\n');
    process.stderr.write('╚══════════════════════════════════════════════════════════╝\n');
    process.stderr.write(`\n  Branch: "${branch}"\n`);
    process.stderr.write('  State-file-only commits must go directly to main (Rule 31).\n');
    process.stderr.write('\n  Switch to the main worktree and commit there:\n');
    process.stderr.write('    git stash\n');
    process.stderr.write('    git -C <main-worktree-path> stash pop\n');
    process.stderr.write('    git add state/ && git commit && git push origin main\n\n');
    process.exit(1);
  }
}

function getStagedStateFiles() {
  const r = spawnSync(
    'git', ['diff', '--cached', '--name-only', '--', 'state/'],
    { cwd: root, encoding: 'utf-8' }
  );
  if (r.status !== 0) return [];
  return r.stdout.split('\n').filter(f => f.endsWith('.json') && f.startsWith('state/'));
}

function getStagedContent(file) {
  const r = spawnSync('git', ['show', ':' + file], { cwd: root, encoding: 'utf-8' });
  return r.status === 0 ? r.stdout : null;
}

function getHeadContent(file) {
  const r = spawnSync('git', ['show', 'HEAD:' + file], { cwd: root, encoding: 'utf-8' });
  return r.status === 0 ? r.stdout : null;
}

const stagedFiles = getStagedStateFiles();
if (stagedFiles.length === 0) process.exit(0);

const violations = [];

for (const file of stagedFiles) {
  const stagedContent = getStagedContent(file);
  if (!stagedContent) continue;

  let staged;
  try { staged = JSON.parse(stagedContent.replace(/^﻿/, "")); } catch { continue; }

  // Build id → status map from HEAD so we only flag newly-done items.
  const headStatusById = {};
  const headContent = getHeadContent(file);
  if (headContent) {
    let head;
    try { head = JSON.parse(headContent.replace(/^﻿/, "")); } catch { head = null; }
    if (head) {
      const headItems = head.defects || head.features || head.tasks || [];
      for (const item of headItems) {
        if (item.id) headStatusById[item.id] = item.status;
      }
    }
  }

  const items = staged.defects || staged.features || staged.tasks || [];
  for (const item of items) {
    if (!DONE_STATUSES.has(item.status)) continue;
    // Skip items that were already done/resolved before this commit.
    if (DONE_STATUSES.has(headStatusById[item.id])) continue;
    if (!item.evidence || !PR_URL_RE.test(item.evidence)) {
      violations.push(
        `  ${file}: ${item.id || '?'} — status="${item.status}" but evidence has no PR URL`
      );
    }
  }
}

if (violations.length === 0) process.exit(0);

process.stderr.write('\n');
process.stderr.write('╔══════════════════════════════════════════════════════════╗\n');
process.stderr.write('║  COMMIT BLOCKED — State validation failed                ║\n');
process.stderr.write('╚══════════════════════════════════════════════════════════╝\n');
process.stderr.write('\n  Items marked done/resolved must have evidence with a PR URL:\n\n');
for (const v of violations) {
  process.stderr.write(v + '\n');
}
process.stderr.write('\n  To fix: create a PR first, then add the URL to the evidence field.\n');
process.stderr.write('  Example evidence: "Fix implemented. PR: https://github.com/org/repo/pull/42"\n\n');
process.exit(1);

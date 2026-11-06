import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { reconcileProjects } from '../../src/projects/reconcile.js';
import type { ProjectSystemOps } from '../../src/projects/service.js';
import { fullProject, mkEnv } from './helpers.js';

describe('reconcileProjects', () => {
  it('ensures group and members of every non-archived project; retry after a failure succeeds', async () => {
    const e = mkEnv();
    const { p, ba, se, dev, rev, tester } = await fullProject(e, 'ERP');
    const other = await e.svc.createProject({ mode: 'new', key: 'CRM', name: 'CRM', path: join(e.root, 'crm'), createdBy: e.pm.id });
    const old = await e.svc.createProject({ mode: 'new', key: 'OLD', name: 'OLD', path: join(e.root, 'old'), createdBy: e.pm.id });
    e.repo.setProjectArchived(old.id, true);

    let failNext = true;
    const calls: string[] = [];
    const ops: ProjectSystemOps = {
      ensureProjectGroup: async (id, path) => {
        if (id === p.id && failNext) { failNext = false; throw new Error('groupadd failed'); }
        calls.push(`group ${id} ${path}`);
      },
      setMembers: async (id, users) => { calls.push(`members ${id} ${[...users].sort((a, b) => a - b).join(',')}`); },
    };

    const first = await reconcileProjects(e.repo, ops);
    expect(first.failed).toEqual([{ projectId: p.id, error: 'groupadd failed' }]);
    expect(first.ok).toEqual([other.id]);
    // A project whose group could not be ensured does not get its member set changed.
    expect(calls.some(c => c.startsWith(`members ${p.id} `))).toBe(false);

    calls.length = 0;
    const second = await reconcileProjects(e.repo, ops);
    expect(second.failed).toEqual([]);
    expect(second.ok.sort()).toEqual([p.id, other.id].sort());
    const ids = [e.pm.id, ba.id, se.id, dev.id, rev.id, tester.id].sort((a, b) => a - b).join(',');
    expect(calls).toContain(`group ${p.id} ${p.path}`);
    expect(calls).toContain(`members ${p.id} ${ids}`);
    expect(calls).toContain(`members ${other.id} ${e.pm.id}`);
    expect(calls.some(c => c.includes(` ${old.id} `) || c.endsWith(` ${old.id}`))).toBe(false);

    // Idempotent: running again issues the same calls.
    const before = [...calls];
    calls.length = 0;
    await reconcileProjects(e.repo, ops);
    expect(calls.sort()).toEqual(before.sort());
  });
});

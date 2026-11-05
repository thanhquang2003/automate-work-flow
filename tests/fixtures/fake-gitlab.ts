import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { GitLabClient } from '../../src/gitlab/client.js';
import { git } from '../engine/stage-helpers.js';

export interface FakeMR { source: string; target: string; title: string; description: string; state: string; notes: string[] }
export interface FakeIssue { title: string; description: string; labels: string[]; state: string; notes: string[]; addLabels: string[] }

export function fakeGitLab(bare: string, project = { id: 7, path: 'grp/app', defaultBranch: 'main' }) {
  const branches: string[] = [];
  const mrs = new Map<number, FakeMR>();
  const issues = new Map<number, FakeIssue>();
  const uploads: string[] = [];
  let mrN = 0;
  let issueN = 0;
  const fail = { createIssue: 0 };
  const client = {
    getProject: async (_p: number | string) => ({ id: project.id, path_with_namespace: project.path, default_branch: project.defaultBranch, http_url_to_repo: bare, web_url: `http://gl/${project.path}` }),
    createBranch: async (_pid: number, branch: string, ref: string) => { branches.push(branch); git(bare, 'branch', branch, ref); },
    createMR: async (_pid: number, o: { source: string; target: string; title: string; description: string }) => {
      const iid = ++mrN;
      mrs.set(iid, { ...o, state: 'opened', notes: [] });
      return { iid, web_url: `http://gl/grp/app/-/merge_requests/${iid}` };
    },
    findOpenMR: async (_pid: number, source: string, target: string) => {
      for (const [iid, m] of mrs) if (m.state === 'opened' && m.source === source && m.target === target) return { iid, web_url: `http://gl/grp/app/-/merge_requests/${iid}` };
      return undefined;
    },
    addMRNote: async (_pid: number, iid: number, body: string) => { mrs.get(iid)!.notes.push(body); },
    mergeMR: async (_pid: number, iid: number) => {
      const m = mrs.get(iid)!;
      if (m.state !== 'opened') throw new Error('not open');
      const tmp = mkdtempSync(join(tmpdir(), 'devflow-merge-'));
      git(tmp, 'clone', '-q', bare, '.');
      git(tmp, 'checkout', '-q', m.target);
      git(tmp, '-c', 'user.name=gl', '-c', 'user.email=gl@gl', 'merge', '-q', '--no-ff', `origin/${m.source}`, '-m', `Merge ${m.source}`);
      git(tmp, 'push', '-q', 'origin', m.target);
      m.state = 'merged';
    },
    getMR: async (_pid: number, iid: number) => { const m = mrs.get(iid)!; return { iid, state: m.state, web_url: `http://gl/grp/app/-/merge_requests/${iid}` }; },
    createIssue: async (_pid: number, o: { title: string; description: string; labels: string[] }) => {
      if (fail.createIssue > 0) { fail.createIssue--; throw new Error("GitLab 502"); }
      const iid = ++issueN;
      issues.set(iid, { ...o, state: 'opened', notes: [], addLabels: [] });
      return { iid, web_url: `http://gl/grp/app/-/issues/${iid}` };
    },
    addIssueNote: async (_pid: number, iid: number, body: string) => { issues.get(iid)!.notes.push(body); },
    updateIssue: async (_pid: number, iid: number, o: { state_event?: string; add_labels?: string }) => {
      const is = issues.get(iid)!;
      if (o.state_event === 'close') is.state = 'closed';
      if (o.state_event === 'reopen') is.state = 'opened';
      if (o.add_labels) is.addLabels.push(o.add_labels);
    },
    uploadFile: async (_pid: number, p: string) => { uploads.push(p); return { markdown: `![${basename(p)}](/uploads/abc/${basename(p)})` }; },
  };
  return { client: client as unknown as GitLabClient, bare, branches, mrs, issues, uploads, fail, seedIssue: (iid: number) => { issues.set(iid, { title: 'x', description: '', labels: [], state: 'opened', notes: [], addLabels: [] }); issueN = Math.max(issueN, iid); } };
}

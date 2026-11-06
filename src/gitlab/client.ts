import { basename } from 'node:path';

export class GitLabError extends Error {
  constructor(public status: number, public body: string, message?: string) {
    super(message ?? `GitLab API error ${status}: ${body.slice(0, 300)}`);
    this.name = 'GitLabError';
  }
}

export interface GlProject { id: number; path_with_namespace: string; default_branch: string; http_url_to_repo: string }
export interface GlRef { iid: number; web_url: string }
type Id = number | string;

export class GitLabClient {
  private base: string;
  /** `token` is the resolved credential for this request; git clone/push must use the same one. */
  constructor(baseUrl: string, readonly token: string, private fetchImpl: typeof fetch = fetch) {
    this.base = baseUrl.replace(/\/+$/, '') + '/api/v4';
  }

  private enc(id: Id): string { return encodeURIComponent(String(id)); }

  private async req(method: string, path: string, body?: unknown | FormData): Promise<any> {
    const headers: Record<string, string> = { 'PRIVATE-TOKEN': this.token };
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await this.fetchImpl(this.base + path, { method, headers, body: payload, signal: AbortSignal.timeout(60000) });
    const text = await res.text();
    if (!res.ok) throw new GitLabError(res.status, text);
    if (!text) return undefined;
    try { return JSON.parse(text); } catch { return text; }
  }

  getProject(idOrPath: Id): Promise<GlProject> {
    return this.req('GET', `/projects/${this.enc(idOrPath)}`);
  }

  createProject(name: string, namespaceId?: number): Promise<GlProject> {
    return this.req('POST', '/projects', { name, ...(namespaceId !== undefined ? { namespace_id: namespaceId } : {}) });
  }

  async findGroupId(path: string): Promise<number | undefined> {
    try {
      const g = await this.req('GET', `/groups/${this.enc(path)}`);
      return g?.id;
    } catch (e) {
      if (e instanceof GitLabError && e.status === 404) return undefined;
      throw e;
    }
  }

  async createBranch(pid: Id, branch: string, ref: string): Promise<void> {
    try {
      await this.req('POST', `/projects/${this.enc(pid)}/repository/branches?branch=${encodeURIComponent(branch)}&ref=${encodeURIComponent(ref)}`);
    } catch (e) {
      if (e instanceof GitLabError && e.status === 400 && /already exists/i.test(e.body)) return;
      throw e;
    }
  }

  createMR(pid: Id, o: { source: string; target: string; title: string; description: string }): Promise<GlRef> {
    return this.req('POST', `/projects/${this.enc(pid)}/merge_requests`, {
      source_branch: o.source, target_branch: o.target, title: o.title, description: o.description, remove_source_branch: false,
    });
  }

  async findOpenMR(pid: Id, source: string, target: string): Promise<GlRef | undefined> {
    const q = `state=opened&source_branch=${encodeURIComponent(source)}&target_branch=${encodeURIComponent(target)}`;
    const list = await this.req('GET', `/projects/${this.enc(pid)}/merge_requests?${q}`);
    return Array.isArray(list) && list.length ? list[0] : undefined;
  }

  getMR(pid: Id, iid: number): Promise<GlRef & { state: string }> {
    return this.req('GET', `/projects/${this.enc(pid)}/merge_requests/${iid}`);
  }

  async addMRNote(pid: Id, iid: number, body: string): Promise<void> {
    await this.req('POST', `/projects/${this.enc(pid)}/merge_requests/${iid}/notes`, { body });
  }

  async mergeMR(pid: Id, iid: number): Promise<void> {
    await this.req('PUT', `/projects/${this.enc(pid)}/merge_requests/${iid}/merge`, {});
  }

  createIssue(pid: Id, o: { title: string; description: string; labels: string[] }): Promise<GlRef> {
    return this.req('POST', `/projects/${this.enc(pid)}/issues`, { title: o.title, description: o.description, labels: o.labels.join(',') });
  }

  async addIssueNote(pid: Id, iid: number, body: string): Promise<void> {
    await this.req('POST', `/projects/${this.enc(pid)}/issues/${iid}/notes`, { body });
  }

  async updateIssue(pid: Id, iid: number, o: { state_event?: 'close' | 'reopen'; add_labels?: string }): Promise<void> {
    await this.req('PUT', `/projects/${this.enc(pid)}/issues/${iid}`, o);
  }

  /**
   * Uploads file content to the project. The caller reads it (through safe-fs: evidence lives in folders a seat can
   * write); this client never opens a path itself.
   */
  async uploadFile(pid: Id, file: { name: string; data: Uint8Array }): Promise<{ markdown: string }> {
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(file.data)]), basename(file.name));
    return this.req('POST', `/projects/${this.enc(pid)}/uploads`, fd);
  }
}

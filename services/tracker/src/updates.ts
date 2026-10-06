import type { Config } from './config.ts';

export interface AppRelease {
  version: string;
  name: string;
  notes: string;
  url: string;
  publishedAt: string | null;
  /** Installer files attached to the release (the reader picks the one it needs). */
  assets: { id: number; name: string; size: number; downloadUrl: string }[];
}

/**
 * Finds the newest release of the desktop reader on Gitea, so readers can offer to
 * update. The repository may be private, so an optional read-only token from .env
 * (GITEA_TOKEN) is sent along; the reader downloads the installer through the tracker.
 */
export class UpdateChecker {
  private cached: { at: number; release: AppRelease | null; error: string | null } | null = null;

  constructor(private config: Config, private fetchImpl: typeof fetch = fetch) {}

  get configured() { return !!(this.config.giteaUrl && this.config.giteaRepo); }

  private headers(accept = 'application/json'): Record<string, string> {
    return { Accept: accept, 'User-Agent': this.config.userAgent, ...(this.config.giteaToken ? { Authorization: `token ${this.config.giteaToken}` } : {}) };
  }

  async latest(force = false): Promise<{ release: AppRelease | null; error: string | null }> {
    if (!this.configured) return { release: null, error: null };
    if (!force && this.cached && Date.now() - this.cached.at < 3600_000) return this.cached;
    let release: AppRelease | null = null, error: string | null = null;
    try {
      const r = await this.fetchImpl(`${this.config.giteaUrl}/api/v1/repos/${this.config.giteaRepo}/releases/latest`, { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
      if (r.status === 401 || r.status === 403) error = 'Gitea rejected GITEA_TOKEN (it needs read access to the repository).';
      else if (r.status === 404) error = 'No release found (or the repository is private and GITEA_TOKEN is missing).';
      else if (!r.ok) error = `Gitea returned HTTP ${r.status}`;
      else {
        const j = (await r.json()) as { tag_name: string; name?: string; body?: string; html_url: string; published_at?: string; assets?: { id: number; name: string; size: number; browser_download_url: string }[] };
        release = {
          version: j.tag_name.replace(/^v/i, ''), name: j.name || j.tag_name, notes: j.body ?? '', url: j.html_url,
          publishedAt: j.published_at ?? null,
          // Gitea only lists a release asset once its upload has finished.
          assets: (j.assets ?? []).map((a) => ({ id: a.id, name: a.name, size: a.size, downloadUrl: a.browser_download_url })),
        };
      }
    } catch (e) { error = `Couldn't reach Gitea: ${(e as Error).message}`; }
    // Keep a previous good answer if Gitea is briefly unreachable.
    this.cached = { at: Date.now(), release: release ?? this.cached?.release ?? null, error };
    // A release with no installer yet is usually still being uploaded: ask again next time.
    if (release && !release.assets.length) this.cached.at = 0;
    return this.cached;
  }

  /** Download one release file (streamed). */
  async download(name: string): Promise<Response | null> {
    const { release } = await this.latest();
    const asset = release?.assets.find((a) => a.name === name);
    if (!asset) return null;
    const r = await this.fetchImpl(asset.downloadUrl, { headers: this.headers('application/octet-stream'), redirect: 'follow' });
    return r.ok && r.body ? r : null;
  }
}

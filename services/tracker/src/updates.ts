import type { Config } from './config.ts';

export interface AppRelease {
  version: string;
  name: string;
  notes: string;
  url: string;
  publishedAt: string | null;
  /** Installer files attached to the release (the reader picks the one it needs). */
  assets: { id: number; name: string; size: number }[];
}

/**
 * Finds the newest release of the desktop reader on GitHub, so readers can offer to
 * update. The repository may be private, so this runs here with a read-only token from
 * .env (GITHUB_TOKEN) and the reader downloads the installer through the tracker.
 */
export class UpdateChecker {
  private cached: { at: number; release: AppRelease | null; error: string | null } | null = null;

  constructor(private config: Config, private fetchImpl: typeof fetch = fetch) {}

  get configured() { return !!(this.config.githubToken && this.config.githubRepo); }

  private headers(accept = 'application/vnd.github+json'): Record<string, string> {
    return { Accept: accept, Authorization: `Bearer ${this.config.githubToken}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': this.config.userAgent };
  }

  async latest(force = false): Promise<{ release: AppRelease | null; error: string | null }> {
    if (!this.configured) return { release: null, error: null };
    if (!force && this.cached && Date.now() - this.cached.at < 3600_000) return this.cached;
    let release: AppRelease | null = null, error: string | null = null;
    try {
      const r = await this.fetchImpl(`${this.config.githubApi}/repos/${this.config.githubRepo}/releases/latest`, { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
      if (r.status === 401 || r.status === 403) error = 'GitHub rejected GITHUB_TOKEN (it needs read access to the repository contents).';
      else if (r.status === 404) error = 'No release found (or GITHUB_TOKEN cannot see the repository).';
      else if (!r.ok) error = `GitHub returned HTTP ${r.status}`;
      else {
        const j = (await r.json()) as { tag_name: string; name?: string; body?: string; html_url: string; published_at?: string; assets?: { id: number; name: string; size: number }[] };
        release = {
          version: j.tag_name.replace(/^v/i, ''), name: j.name || j.tag_name, notes: j.body ?? '', url: j.html_url,
          publishedAt: j.published_at ?? null, assets: (j.assets ?? []).map((a) => ({ id: a.id, name: a.name, size: a.size })),
        };
      }
    } catch (e) { error = `Couldn't reach GitHub: ${(e as Error).message}`; }
    // Keep a previous good answer if GitHub is briefly unreachable.
    this.cached = { at: Date.now(), release: release ?? this.cached?.release ?? null, error };
    return this.cached;
  }

  /** Download one release file (streamed). GitHub redirects to its file storage; the token isn't forwarded there. */
  async download(name: string): Promise<Response | null> {
    const { release } = await this.latest();
    const asset = release?.assets.find((a) => a.name === name);
    if (!asset) return null;
    const r = await this.fetchImpl(`${this.config.githubApi}/repos/${this.config.githubRepo}/releases/assets/${asset.id}`, { headers: this.headers('application/octet-stream'), redirect: 'follow' });
    return r.ok && r.body ? r : null;
  }
}

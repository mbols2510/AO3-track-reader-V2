/**
 * List filters, in the original string format:
 *   "Tag <name>" | "Author <username>" | "Work <id>[ <label>]" | "Series <id>[ <label>]"
 */
export class ListFilterSet {
  private tags = new Map<string, string>();
  private authors = new Map<string, string>();
  private works = new Map<number, string>();
  private series = new Map<number, string>();

  constructor(filters: Iterable<string> = []) {
    for (const f of filters) this.add(f);
  }

  /** Returns the normalised key, or null if the string isn't a valid filter. */
  static normalise(data: string): string | null {
    if (!data?.trim()) return null;
    const i = data.indexOf(' ');
    if (i < 0) return null;
    const kind = data.slice(0, i);
    const rest = data.slice(i + 1);
    if (!rest.trim()) return null;
    switch (kind) {
      case 'Tag':
      case 'Author':
        return `${kind} ${rest}`;
      case 'Work':
      case 'Series': {
        const j = rest.indexOf(' ');
        const idStr = j < 0 ? rest : rest.slice(0, j);
        if (!/^\d+$/.test(idStr)) return null;
        const label = j < 0 ? '' : rest.slice(j + 1);
        return `${kind} ${Number(idStr)} ${label}`.trimEnd();
      }
      default:
        return null;
    }
  }

  add(data: string): string | null {
    const key = ListFilterSet.normalise(data);
    if (!key) return null;
    const [kind, ...restParts] = key.split(' ');
    const rest = restParts.join(' ');
    if (kind === 'Tag') this.tags.set(rest.toLowerCase(), key);
    else if (kind === 'Author') this.authors.set(rest.toLowerCase(), key);
    else if (kind === 'Work') this.works.set(Number(restParts[0]), key);
    else if (kind === 'Series') this.series.set(Number(restParts[0]), key);
    return key;
  }

  remove(data: string): boolean {
    const key = ListFilterSet.normalise(data);
    if (!key) return false;
    const [kind, ...restParts] = key.split(' ');
    const rest = restParts.join(' ');
    if (kind === 'Tag') return this.tags.delete(rest.toLowerCase());
    if (kind === 'Author') return this.authors.delete(rest.toLowerCase());
    if (kind === 'Work') return this.works.delete(Number(restParts[0]));
    if (kind === 'Series') return this.series.delete(Number(restParts[0]));
    return false;
  }

  /** The filter that hides this work, or null. */
  match(workid: number, authors: string[], tags: string[], series: number[]): string | null {
    const w = this.works.get(workid);
    if (w) return w;
    for (const s of series) {
      const f = this.series.get(s);
      if (f) return f;
    }
    for (const a of authors) {
      const f = this.authors.get(a.toLowerCase());
      if (f) return f;
    }
    for (const t of tags) {
      const f = this.tags.get(t.toLowerCase());
      if (f) return f;
    }
    return null;
  }

  all(): string[] {
    return [...this.tags.values(), ...this.authors.values(), ...this.works.values(), ...this.series.values()];
  }
}

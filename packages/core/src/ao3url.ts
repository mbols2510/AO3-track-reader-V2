/**
 * AO3 URL helpers. Reading-list keys MUST stay byte-identical to what the
 * original apps produced ("http://archiveofourown.org/works/123"), otherwise
 * migrated reading lists would duplicate every entry.
 */

const escTagStrings = ['*s*', '*a*', '*d*', '*q*', '*h*'];
const unescTagStrings = ['/', '&', '.', '?', '#'];

export function escapeTag(tag: string): string {
  return tag.replace(/[/&.?#]/g, (m) => escTagStrings[unescTagStrings.indexOf(m)] ?? '');
}

export function unescapeTag(tag: string): string {
  return tag.replace(/\*[sadqh]\*/g, (m) => unescTagStrings[escTagStrings.indexOf(m)] ?? '');
}

export const AO3_HOSTS = new Set(['archiveofourown.org', 'www.archiveofourown.org', 'ao3.org', 'www.ao3.org']);
export const AO3_ORIGIN = 'https://archiveofourown.org';

export const regexWork = /^(?:\/collections\/[^/?#]+)?\/works\/(\d+)(?:\/chapters\/(\d+))?\/?$/;
export const regexSeries = /^\/series\/(\d+)\/?$/;
export const regexTag = /^\/tags\/([^/?#]+)(?:\/(works|bookmarks))?\/?$/;
export const regexUser = /^\/users\/([^/?#]+)(?:\/.*)?$/;

export function isAo3Url(url: string | URL): boolean {
  try {
    const u = typeof url === 'string' ? new URL(url) : url;
    return AO3_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Canonical reading-list key for a URL, or null if it isn't an AO3 URL.
 * Matches Ao3Track.Data.readingListlUri from the original extension.
 */
export function readingListKey(input: string | URL): string | null {
  let url: URL;
  try {
    url = new URL(typeof input === 'string' ? input : input.href);
  } catch {
    return null;
  }
  if (!AO3_HOSTS.has(url.hostname)) return null;

  // Drop the page= query parameter (reading list entries are page-independent).
  url.search = url.search.replace(/(&?page=\d+&?)/, (m) => (m.startsWith('&') && m.endsWith('&') ? '&' : ''));
  if (url.search === '?') url.search = '';
  url.hash = '';

  const m = url.pathname.match(regexWork);
  const path = m ? `/works/${m[1]}` : url.pathname;
  // Rebuilt as a string: the WHATWG URL API refuses http<->https protocol swaps
  // on some runtimes, and the legacy key format uses plain http.
  return `http://archiveofourown.org${path}${url.search}`;
}

export function workIdFromUrl(input: string | URL): number | null {
  try {
    const u = typeof input === 'string' ? new URL(input, AO3_ORIGIN) : input;
    if (!AO3_HOSTS.has(u.hostname)) return null;
    const m = u.pathname.match(regexWork);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export function seriesIdFromUrl(input: string | URL): number | null {
  try {
    const u = typeof input === 'string' ? new URL(input, AO3_ORIGIN) : input;
    if (!AO3_HOSTS.has(u.hostname)) return null;
    const m = u.pathname.match(regexSeries);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export const workKey = (workid: number) => `http://archiveofourown.org/works/${workid}`;

/** Browsable https URL for a reading-list key. */
export function browseUrl(key: string): string {
  return key.replace(/^http:\/\/archiveofourown\.org/, AO3_ORIGIN);
}

/** List-filter string ("Tag X", "Author X", "Work 1 name", "Series 2 name") for a link. */
export function filterFromUrl(input: string, label?: string): string | null {
  let u: URL;
  try {
    u = new URL(input, AO3_ORIGIN);
  } catch {
    return null;
  }
  if (!AO3_HOSTS.has(u.hostname)) return null;
  const extra = label?.trim() ? ` ${label.trim()}` : '';
  let m: RegExpMatchArray | null;
  if ((m = u.pathname.match(regexWork))) return `Work ${m[1]}${extra}`;
  if ((m = u.pathname.match(regexSeries))) return `Series ${m[1]}${extra}`;
  if ((m = u.pathname.match(regexUser))) return `Author ${decodeURIComponent(m[1])}`;
  if ((m = u.pathname.match(regexTag))) return `Tag ${unescapeTag(decodeURIComponent(m[1]))}`;
  return null;
}

/**
 * Human-readable name for a reading-list entry that isn't a work or series:
 * tag listings, filtered listings, searches, user pages and collections.
 *
 * AO3's "Sort and Filter" on a tag or fandom page redirects to
 * /works?...&tag_id=<name>, so the name lives in the query string there.
 */
export function listingTitle(input: string): string {
  let u: URL;
  try {
    u = new URL(input, AO3_ORIGIN);
  } catch {
    return input;
  }
  const q = u.searchParams;
  const p = decodeURIComponent(u.pathname).replace(/\/+$/, '') || '/';
  const tag = (s: string) => unescapeTag(s).trim();
  let m: RegExpMatchArray | null;

  if ((m = u.pathname.match(regexTag))) {
    const name = tag(decodeURIComponent(m[1]));
    return m[2] === 'bookmarks' ? `${name} (bookmarks)` : name;
  }
  if ((m = p.match(/^\/users\/([^/]+)\/pseuds\/([^/]+)(?:\/(works|bookmarks|series))?$/))) {
    const who = m[2] === m[1] ? m[1] : `${m[2]} (${m[1]})`;
    return m[3] === 'bookmarks' ? `Bookmarks by ${who}` : m[3] === 'series' ? `Series by ${who}` : `Works by ${who}`;
  }
  if ((m = p.match(/^\/users\/([^/]+)(?:\/(works|bookmarks|series|gifts|profile))?$/))) {
    const kind = { bookmarks: 'Bookmarks by', series: 'Series by', gifts: 'Gifts for', profile: 'Profile of' }[m[2] ?? ''] ?? 'Works by';
    return `${kind} ${m[1]}`;
  }
  if ((m = p.match(/^\/collections\/([^/]+)(?:\/(works|bookmarks))?$/))) {
    return `Collection: ${m[1]}${m[2] === 'bookmarks' ? ' (bookmarks)' : ''}`;
  }
  if (p === '/works' || p === '/bookmarks') {
    const t = q.get('tag_id') ?? q.get('fandom_id');
    const bm = p === '/bookmarks' ? ' (bookmarks)' : '';
    if (t && !/^\d+$/.test(t)) return tag(t) + bm;
    const user = q.get('user_id');
    if (user) return `${p === '/bookmarks' ? 'Bookmarks' : 'Works'} by ${user}`;
    const coll = q.get('collection_id');
    if (coll) return `Collection: ${coll}${bm}`;
  }
  if (p === '/works/search' || p === '/bookmarks/search' || p === '/people/search' || p === '/tags/search') {
    const fields: [string, string][] = [
      ['work_search[query]', ''], ['work_search[title]', 'title: '], ['work_search[creators]', 'by '],
      ['work_search[fandom_names]', ''], ['work_search[relationship_names]', ''], ['work_search[character_names]', ''],
      ['work_search[freeform_names]', ''], ['bookmark_search[bookmarkable_query]', ''], ['bookmark_search[bookmark_query]', ''],
      ['people_search[query]', ''], ['tag_search[name]', ''],
    ];
    const parts = fields.map(([k, pre]) => (q.get(k)?.trim() ? `${pre}${q.get(k)!.trim()}` : '')).filter(Boolean);
    const what = p.startsWith('/bookmarks') ? 'Bookmark search' : p.startsWith('/people') ? 'People search' : p.startsWith('/tags') ? 'Tag search' : 'Search';
    return parts.length ? `${what}: ${parts.join(', ')}` : what;
  }
  if (p === '/works') return 'All works';
  if (p === '/') return 'AO3 home';
  return p;
}

const SORT_NAMES: Record<string, string> = {
  revised_at: 'date updated', created_at: 'date posted', authors_to_sort_on: 'author', title_to_sort_on: 'title',
  word_count: 'word count', hits: 'hits', kudos_count: 'kudos', comments_count: 'comments', bookmarks_count: 'bookmarks',
};

/** Short description of the filters applied to a listing URL ("English · complete only · excluding X"). */
export function listingFilters(input: string): string {
  let q: URLSearchParams, isSearch: boolean;
  try {
    const u = new URL(input, AO3_ORIGIN);
    q = u.searchParams;
    isSearch = /\/search\/?$/.test(u.pathname);
  } catch {
    return '';
  }
  const g = (k: string) => (q.get(`work_search[${k}]`) ?? '').trim();
  const out: string[] = [];
  const inc = g('other_tag_names');
  if (inc) out.push(`with ${inc.split(',').map((s) => s.trim()).filter(Boolean).join(', ')}`);
  const exc = g('excluded_tag_names');
  if (exc) out.push(`excluding ${exc.split(',').map((s) => s.trim()).filter(Boolean).join(', ')}`);
  const ids = q.getAll('include_work_search[fandom_ids][]').length + q.getAll('include_work_search[rating_ids][]').length
    + q.getAll('include_work_search[relationship_ids][]').length + q.getAll('include_work_search[character_ids][]').length
    + q.getAll('include_work_search[freeform_ids][]').length + q.getAll('include_work_search[category_ids][]').length
    + q.getAll('include_work_search[archive_warning_ids][]').length;
  const exIds = [...q.keys()].filter((k) => k.startsWith('exclude_work_search[')).length;
  if (ids) out.push(`${ids} included tag${ids === 1 ? '' : 's'}`);
  if (exIds) out.push(`${exIds} excluded tag${exIds === 1 ? '' : 's'}`);
  if (g('complete') === 'T') out.push('complete only');
  if (g('complete') === 'F') out.push('in progress only');
  if (g('crossover') === 'F') out.push('no crossovers');
  if (g('crossover') === 'T') out.push('crossovers only');
  const lang = g('language_id');
  if (lang) out.push(lang === 'en' ? 'English' : `language: ${lang}`);
  const wf = g('words_from'), wt = g('words_to');
  if (wf || wt) out.push(wf && wt ? `${wf}–${wt} words` : wf ? `${wf}+ words` : `under ${wt} words`);
  if (g('query') && !isSearch) out.push(`matching “${g('query')}”`);
  const sort = g('sort_column');
  if (sort && sort !== 'revised_at') out.push(`sorted by ${SORT_NAMES[sort] ?? sort.replace(/_/g, ' ')}`);
  return out.join(' · ');
}

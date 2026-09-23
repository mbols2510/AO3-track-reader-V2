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

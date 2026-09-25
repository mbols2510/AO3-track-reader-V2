// Readable names for reading-list entries that aren't works or series (tag listings,
// filtered listings, searches, user pages, collections). Browser copy of listingTitle()
// in packages/core/src/ao3url.ts; tests/core.test.ts checks the two agree.
const ESC = { '*s*': '/', '*a*': '&', '*d*': '.', '*q*': '?', '*h*': '#' };
const unescapeTag = (t) => t.replace(/\*[sadqh]\*/g, (m) => ESC[m] ?? '');

export function listingTitle(input) {
  let u;
  try { u = new URL(input, 'https://archiveofourown.org'); } catch { return input; }
  const q = u.searchParams;
  const p = decodeURIComponent(u.pathname).replace(/\/+$/, '') || '/';
  const tag = (s) => unescapeTag(s).trim();
  let m;
  if ((m = u.pathname.match(/^\/tags\/([^/?#]+)(?:\/(works|bookmarks))?\/?$/))) {
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
  if ((m = p.match(/^\/collections\/([^/]+)(?:\/(works|bookmarks))?$/))) return `Collection: ${m[1]}${m[2] === 'bookmarks' ? ' (bookmarks)' : ''}`;
  if (p === '/works' || p === '/bookmarks') {
    const t = q.get('tag_id') ?? q.get('fandom_id');
    const bm = p === '/bookmarks' ? ' (bookmarks)' : '';
    if (t && !/^\d+$/.test(t)) return tag(t) + bm;
    const user = q.get('user_id');
    if (user) return `${p === '/bookmarks' ? 'Bookmarks' : 'Works'} by ${user}`;
    const coll = q.get('collection_id');
    if (coll) return `Collection: ${coll}${bm}`;
  }
  if (['/works/search', '/bookmarks/search', '/people/search', '/tags/search'].includes(p)) {
    const fields = [
      ['work_search[query]', ''], ['work_search[title]', 'title: '], ['work_search[creators]', 'by '],
      ['work_search[fandom_names]', ''], ['work_search[relationship_names]', ''], ['work_search[character_names]', ''],
      ['work_search[freeform_names]', ''], ['bookmark_search[bookmarkable_query]', ''], ['bookmark_search[bookmark_query]', ''],
      ['people_search[query]', ''], ['tag_search[name]', ''],
    ];
    const parts = fields.map(([k, pre]) => (q.get(k)?.trim() ? `${pre}${q.get(k).trim()}` : '')).filter(Boolean);
    const what = p.startsWith('/bookmarks') ? 'Bookmark search' : p.startsWith('/people') ? 'People search' : p.startsWith('/tags') ? 'Tag search' : 'Search';
    return parts.length ? `${what}: ${parts.join(', ')}` : what;
  }
  if (p === '/works') return 'All works';
  if (p === '/') return 'AO3 home';
  return p;
}

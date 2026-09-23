import * as cheerio from 'cheerio';
import type { WorkMeta, SeriesMeta } from './types.ts';
import { regexSeries, regexUser } from './ao3url.ts';
import type { Ao3Client } from './ao3client.ts';
import type { Priority } from './ratelimit.ts';

type Cheerio = cheerio.CheerioAPI;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sel = cheerio.Cheerio<any>;

const num = (s: string | undefined | null): number | null => {
  if (!s) return null;
  const n = Number(s.replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const texts = ($: Cheerio, el: Sel): string[] =>
  el.toArray().map((e) => $(e).text().trim()).filter(Boolean);

function parseChapters(text: string): { published: number | null; total: number | null } {
  const m = text.replace(/\s/g, '').match(/^(\d+)\/(\d+|\?)/);
  if (!m) return { published: null, total: null };
  return { published: Number(m[1]), total: m[2] === '?' ? null : Number(m[2]) };
}

function authorsFrom($: Cheerio, el: Sel): string[] {
  const out: string[] = [];
  el.find('a[rel=author]').each((_, a) => {
    const href = $(a).attr('href') ?? '';
    const m = href.match(regexUser);
    const name = m ? decodeURIComponent(m[1]) : $(a).text().trim();
    if (name && !out.includes(name)) out.push(name);
  });
  if (!out.length && /Anonymous/.test(el.find('.heading').first().text())) out.push('Anonymous');
  return out;
}

function parseBlurb($: Cheerio, li: Sel, now: number): WorkMeta | null {
  const id = (li.attr('id') ?? '').match(/^work_(\d+)$/);
  if (!id) return null;
  const heading = li.find('.header h4.heading').first();
  const req = li.find('ul.required-tags');
  const reqTitle = (cls: string) =>
    req.find(`span.${cls}`).toArray().flatMap((s) => ($(s).attr('title') ?? '').split(/\s*,\s*/)).filter(Boolean);
  const ch = parseChapters(li.find('dl.stats dd.chapters').first().text());
  const tagsIn = (cls: string) => texts($, li.find(`ul.tags li.${cls} a.tag`));
  const series = li.find('ul.series li').toArray().map((s) => {
    const a = $(s).find('a[href^="/series/"]').first();
    const sid = (a.attr('href') ?? '').match(regexSeries);
    return sid ? { id: Number(sid[1]), title: a.text().trim(), part: num($(s).find('strong').first().text()) } : null;
  }).filter((x): x is NonNullable<typeof x> => x !== null);

  return {
    workid: Number(id[1]),
    title: heading.find('a').first().text().trim(),
    authors: authorsFrom($, heading),
    fandoms: texts($, li.find('.header h5.fandoms a.tag')),
    rating: reqTitle('rating')[0] ?? null,
    warnings: tagsIn('warnings'),
    categories: reqTitle('category'),
    relationships: tagsIn('relationships'),
    characters: tagsIn('characters'),
    freeforms: tagsIn('freeforms'),
    summary: li.find('blockquote.summary').first().text().trim().replace(/\n{3,}/g, '\n\n'),
    language: li.find('dl.stats dd.language').first().text().trim() || null,
    words: num(li.find('dl.stats dd.words').first().text()),
    chaptersPublished: ch.published,
    chaptersTotal: ch.total,
    complete: ch.total !== null && ch.published === ch.total,
    updated: li.find('.header p.datetime').first().text().trim() || null,
    series,
    kudos: num(li.find('dl.stats dd.kudos').first().text()),
    hits: num(li.find('dl.stats dd.hits').first().text()),
    fetchedAt: now,
  };
}

/** Parse every work blurb on a listing / search / series page. */
export function parseWorkBlurbs(html: string, now = Date.now()): WorkMeta[] {
  const $ = cheerio.load(html);
  return $('li.work.blurb[id], li.blurb.work[id]').toArray()
    .map((li) => parseBlurb($, $(li), now))
    .filter((w): w is WorkMeta => w !== null);
}

/** Parse a work page (/works/ID) — used when a work doesn't show up in search. */
export function parseWorkPage(html: string, workid: number, now = Date.now()): WorkMeta | null {
  const $ = cheerio.load(html);
  const meta = $('dl.work.meta').first();
  const title = $('#workskin .preface h2.title').first().text().trim();
  if (!meta.length || !title) return null;
  const tagsIn = (cls: string) => texts($, meta.find(`dd.${cls}.tags a.tag`));
  const ch = parseChapters(meta.find('dl.stats dd.chapters').first().text());
  const series = meta.find('dd.series span.position').toArray().map((s) => {
    const a = $(s).find('a[href^="/series/"]').first();
    const sid = (a.attr('href') ?? '').match(regexSeries);
    const part = $(s).text().match(/Part\s+(\d+)/);
    return sid ? { id: Number(sid[1]), title: a.text().trim(), part: part ? Number(part[1]) : null } : null;
  }).filter((x): x is NonNullable<typeof x> => x !== null);
  const updated = meta.find('dl.stats dd.status').first().text().trim() || meta.find('dl.stats dd.published').first().text().trim();
  return {
    workid,
    title,
    authors: authorsFrom($, $('#workskin .preface h3.byline')),
    fandoms: tagsIn('fandom'),
    rating: tagsIn('rating')[0] ?? null,
    warnings: tagsIn('warning'),
    categories: tagsIn('category'),
    relationships: tagsIn('relationship'),
    characters: tagsIn('character'),
    freeforms: tagsIn('freeform'),
    summary: $('#workskin .preface .summary blockquote').first().text().trim(),
    language: meta.find('dd.language').first().text().trim() || null,
    words: num(meta.find('dl.stats dd.words').first().text()),
    chaptersPublished: ch.published,
    chaptersTotal: ch.total,
    complete: ch.total !== null && ch.published === ch.total,
    updated: updated || null,
    series,
    kudos: num(meta.find('dl.stats dd.kudos').first().text()),
    hits: num(meta.find('dl.stats dd.hits').first().text()),
    fetchedAt: now,
  };
}

/** Parse a series page (/series/ID). Also returns the blurbs it contains. */
export function parseSeriesPage(html: string, seriesid: number, now = Date.now()): { series: SeriesMeta | null; works: WorkMeta[] } {
  const $ = cheerio.load(html);
  const title = $('#main h2.heading').first().text().trim();
  const works = parseWorkBlurbs(html, now);
  if (!title) return { series: null, works };
  const meta = $('dl.series.meta');
  const pick = (label: RegExp) => {
    let out = '';
    meta.find('dt').each((_, dt) => {
      if (label.test($(dt).text())) out = $(dt).next('dd').text().trim();
    });
    return out;
  };
  const complete = pick(/Complete/i);
  return {
    series: {
      seriesid,
      title,
      authors: authorsFrom($, meta),
      workIds: works.map((w) => w.workid),
      complete: complete ? /yes/i.test(complete) : null,
      updated: pick(/Updated/i) || pick(/Begun/i) || null,
      fetchedAt: now,
    },
    works,
  };
}

export const WORKS_PER_SEARCH = 20;

/** Search URL that returns blurbs for up to 20 works in one request. */
export function searchUrlForIds(ids: number[]): string {
  const q = ids.length === 1 ? `id:${ids[0]}` : `id:(${ids.join(' OR ')})`;
  const p = new URLSearchParams({ 'work_search[query]': q, 'work_search[sort_column]': 'revised_at', commit: 'Search' });
  return `/works/search?${p.toString()}`;
}

/**
 * Look up metadata for many works using as few AO3 requests as possible:
 * one batched search per 20 works, then a per-work page fetch only for works
 * search didn't return (restricted, hidden, or search index lag).
 */
export async function lookupWorks(
  client: Ao3Client,
  ids: number[],
  opts: { priority?: Priority; pageFallback?: boolean; onResult?: (w: WorkMeta) => void } = {},
): Promise<{ found: Map<number, WorkMeta>; missing: number[] }> {
  const priority = opts.priority ?? 'low';
  const found = new Map<number, WorkMeta>();
  const unique = [...new Set(ids)].filter((n) => Number.isInteger(n) && n > 0);
  for (let i = 0; i < unique.length; i += WORKS_PER_SEARCH) {
    const chunk = unique.slice(i, i + WORKS_PER_SEARCH);
    const html = await client.getHtml(searchUrlForIds(chunk), priority);
    for (const w of parseWorkBlurbs(html)) {
      if (chunk.includes(w.workid)) {
        found.set(w.workid, w);
        opts.onResult?.(w);
      }
    }
  }
  const missing: number[] = [];
  for (const id of unique) {
    if (found.has(id)) continue;
    if (opts.pageFallback === false) { missing.push(id); continue; }
    try {
      const html = await client.getHtml(`/works/${id}?view_adult=true`, priority);
      const w = parseWorkPage(html, id);
      if (w) { found.set(id, w); opts.onResult?.(w); } else missing.push(id);
    } catch (e) {
      if ((e as Error).name === 'RateLimitedError') throw e;
      missing.push(id);
    }
  }
  return { found, missing };
}

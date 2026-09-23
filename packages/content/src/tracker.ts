/**
 * Location tracking and blurb decoration for archiveofourown.org pages.
 * Port of the original tracker.ts without jQuery.
 */
import { LOC_PARA_BOTTOM, LOC_PARA_FRAC_MULTIPLIER, LOC_PARA_MULTIPLIER, chaptersFinished, escapeTag, regexWork, regexTag, regexUser, regexSeries, type WorkChapter } from '@ao3track/core';
import type { Bridge, PageTitle } from './bridge.ts';

interface ChapterData { num: number; id: number }

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => Array.from(root.querySelectorAll<T>(sel));

function findLink(selectors: string[], textMatch: RegExp[]): string | null {
  for (const sel of selectors) {
    const el = $<HTMLAnchorElement | HTMLLinkElement>(sel);
    if (el?.href) return el.href;
  }
  // The original used jQuery :contains() for these
  for (const a of $$<HTMLAnchorElement>('.series a, .navigation a')) {
    if (textMatch.some((r) => r.test(a.textContent ?? ''))) return a.href;
  }
  return null;
}

export function startTracker(bridge: Bridge) {
  const S = bridge.settings;

  // ---- next / previous page (used by keyboard + swipe in the reader) ----
  bridge.setNextPage(findLink(['head link[rel=next]', '.chapter.next > a', '.pagination > .next > a:not(#comments_placeholder *)', '.series > a.next'], [/\u00BB/, /^\s*Next/]));
  bridge.setPrevPage(findLink(['head link[rel=prev]', '.chapter.previous > a', '.pagination > .previous > a:not(#comments_placeholder *)', '.series > a.previous'], [/\u00AB/, /^\s*Prev/]));

  const feedbackActions = $('#feedback > .actions');
  const chapterData = new WeakMap<Element, ChapterData>();
  let chapterText: HTMLElement[] = [];

  // ---- #ao3tjump[:number:chapterid[:location]] deep links ----
  let jumpNow: WorkChapter | boolean = false;
  const jump = location.hash.split(':');
  if (jump[0] === '#ao3tjump') {
    if (jump.length === 1) jumpNow = true;
    else if (jump.length === 3 || jump.length === 4) {
      const j = { number: Number(jump[1]), chapterid: Number(jump[2]), location: jump.length === 4 ? Number(jump[3]) : null, seq: null };
      jumpNow = Number.isNaN(j.number) || Number.isNaN(j.chapterid) || (j.location !== null && Number.isNaN(j.location)) ? false : j;
    }
    if (jumpNow !== false) history.replaceState(history.state, document.title, location.href.slice(0, location.href.indexOf('#')));
  }

  const workMatch = location.pathname.match(regexWork);
  let workid = 0;
  const works: number[] = [];
  let workEls: HTMLElement[] = [];

  const paragraphs = (el: HTMLElement) => Array.from(el.children).filter((c) => !c.matches('h3.landmark.heading')) as HTMLElement[];

  function scrollToLocation(wid: number, wc: WorkChapter, dojump: boolean) {
    let had = false;
    const centre = window.innerHeight / 2;
    for (let index = 0; index < chapterText.length; index++) {
      const elem = chapterText[index];
      const data = chapterData.get(elem);
      if (!data || data.id !== wc.chapterid) continue;
      had = true;
      const rect = elem.getBoundingClientRect();
      if (index === 0 && wc.location === 0) {
        window.scrollTo({ top: rect.top + scrollY - centre, behavior: 'smooth' });
        break;
      }
      if (index === chapterText.length - 1 && wc.location === null) {
        if (feedbackActions && chapterText.length === 1) feedbackActions.scrollIntoView({ block: 'end', behavior: 'smooth' });
        else window.scrollTo({ top: rect.bottom + scrollY - centre, behavior: 'smooth' });
        break;
      }
      const kids = paragraphs(elem);
      const para = wc.location === null ? Infinity : Math.floor(wc.location / LOC_PARA_MULTIPLIER);
      if (para >= kids.length) {
        window.scrollTo({ top: rect.bottom + scrollY - centre, behavior: 'smooth' });
        break;
      }
      const offset = (wc.location ?? 0) % LOC_PARA_MULTIPLIER;
      const p = kids[para].getBoundingClientRect();
      const y = offset >= LOC_PARA_BOTTOM ? p.bottom : p.top + (p.height * offset) / LOC_PARA_FRAC_MULTIPLIER;
      window.scrollTo({ top: y + scrollY - centre, behavior: 'smooth' });
      break;
    }
    if (had) bridge.setCurrentLocation({ workid: wid, ...wc });
    else if (dojump && wid) location.replace(`/works/${wid}${wc.chapterid ? `/chapters/${wc.chapterid}` : ''}#ao3tjump`);
  }

  let lastScrollY: number | null = null;
  function readLocation(): WorkChapter | null {
    if (scrollY === lastScrollY || !chapterText.length) return null;
    lastScrollY = scrollY;
    const centre = window.innerHeight / 2;
    if (feedbackActions && feedbackActions.getBoundingClientRect().top < window.innerHeight) {
      const d = chapterData.get(chapterText[chapterText.length - 1])!;
      return { number: d.num, chapterid: d.id, location: null, seq: null };
    }
    if (chapterText[0].getBoundingClientRect().top > centre) {
      const d = chapterData.get(chapterText[0])!;
      return { number: d.num, chapterid: d.id, location: 0, seq: null };
    }
    let result: WorkChapter | null = null;
    for (const elem of chapterText) {
      const rect = elem.getBoundingClientRect();
      if (rect.top > centre) break;
      const d = chapterData.get(elem);
      if (!d) continue;
      let loc: number | null = 0;
      if (rect.bottom <= centre) loc = null;
      else {
        const kids = paragraphs(elem);
        for (let i = 0; i < kids.length; i++) {
          const p = kids[i].getBoundingClientRect();
          if (p.top > centre) break;
          loc = p.bottom <= centre
            ? i * LOC_PARA_MULTIPLIER + LOC_PARA_BOTTOM
            : i * LOC_PARA_MULTIPLIER + Math.floor(((centre - p.top) * LOC_PARA_FRAC_MULTIPLIER) / Math.max(p.height, 1));
        }
      }
      result = { number: d.num, chapterid: d.id, location: loc, seq: null };
    }
    return result;
  }

  const further = (a: WorkChapter | null, b: WorkChapter) =>
    !a || b.number > a.number || (b.number === a.number && a.location !== null && (b.location === null || b.location > a.location));

  let lastLoc: WorkChapter | null = null;
  let lastSaved: WorkChapter | null = null;

  if (workMatch) {
    workid = Number(workMatch[1]);
    const chapters = $$('#chapters .chapter[id]');
    if (chapters.length) {
      for (const c of chapters) {
        const text = Array.from(c.children).find((e) => e.classList.contains('userstuff')) as HTMLElement | undefined;
        if (!text) continue;
        const num = c.id.match(/^chapter-(\d+)$/);
        const href = $<HTMLAnchorElement>('.chapter > .title > a', c)?.getAttribute('href') ?? '';
        const cid = href.match(/\/chapters\/(\d+)/);
        if (num && cid) {
          chapterData.set(text, { num: Number(num[1]), id: Number(cid[1]) });
          chapterText.push(text);
        }
      }
    } else {
      chapterText = Array.from($('#chapters')?.children ?? []).filter((e) => e.classList.contains('userstuff')) as HTMLElement[];
      for (const t of chapterText) chapterData.set(t, { num: 1, id: 0 });
    }

    lastLoc = readLocation();
    if (lastLoc) {
      bridge.setCurrentLocation({ workid, ...lastLoc });
      bridge.setWorkChapters({ [workid]: (lastSaved = lastLoc) });
    }

    // Track position as the reader scrolls (throttled to animation frames).
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const loc = readLocation();
        if (!loc) return;
        bridge.setCurrentLocation({ workid, ...loc });
        if (further(lastLoc, loc)) {
          lastLoc = loc;
          // Finishing a chapter is saved immediately; progress within one is batched below.
          if (loc.location === null) {
            bridge.enableLastLocationJump(workid, loc);
            bridge.setWorkChapters({ [workid]: (lastSaved = loc) });
          }
        }
      });
    };
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', () => { lastScrollY = null; onScroll(); }, { passive: true });

    setInterval(() => {
      if (lastLoc && further(lastSaved, lastLoc)) {
        bridge.enableLastLocationJump(workid, lastLoc);
        bridge.setWorkChapters({ [workid]: (lastSaved = lastLoc) });
      }
    }, 5000);
    const flush = () => { if (lastLoc && further(lastSaved, lastLoc)) bridge.setWorkChapters({ [workid]: (lastSaved = lastLoc) }); };
    addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());

    works.push(workid);
    const meta = $('.chapters-show .work .work.meta, .works-show .work.meta');
    workEls = meta ? [meta] : [];
  } else {
    decorateListing();
  }

  // ---- listing pages: filters, tag options ----
  function decorateListing() {
    for (const work of $$('.work.blurb[id]')) {
      const m = work.id.match(/^work_(\d+)$/);
      if (!m) continue;
      const wid = Number(m[1]);
      works.push(wid);
      workEls.push(work);

      const authors: string[] = [];
      for (const a of $$<HTMLAnchorElement>('.heading a[rel=author]', work)) {
        const u = a.pathname.match(regexUser);
        if (u) { const n = decodeURIComponent(u[1]); if (!authors.includes(n)) authors.push(n); }
      }
      const tags: string[] = [];
      for (const a of $$<HTMLAnchorElement>('a.tag', work)) {
        const t = a.pathname.match(regexTag);
        if (t) { const n = decodeURIComponent(t[1]); if (!tags.includes(n)) tags.push(n); }
      }

      // Required tags become real tags (optional), and rating filtering.
      let insertAfter = $$('.tags > li.warnings', work).pop() ?? null;
      let filteredByRating = false;
      for (const span of $$('.required-tags a > span', work)) {
        if (!span.title) continue;
        for (const tag of span.title.split(/\s*,\s*/)) {
          if (!tags.includes(tag)) tags.push(tag);
          let show = false;
          if (span.classList.contains('warnings')) continue;
          if (span.classList.contains('rating')) {
            if (S.listFiltering.onlyGeneralTeen && tag !== 'Teen And Up Audiences' && tag !== 'General Audiences') filteredByRating = true;
            show = S.tags.showRatingTags;
          } else if (span.classList.contains('category')) show = S.tags.showCatTags;
          else if (span.classList.contains('iswip')) show = S.tags.showWIPTags;
          if (show && insertAfter) {
            const li = document.createElement('li');
            const a = Object.assign(document.createElement('a'), { href: `/tags/${escapeTag(tag)}/works`, className: 'tag', textContent: tag });
            li.append(a);
            insertAfter.after(li);
            insertAfter = li;
          }
        }
      }
      if (filteredByRating) { hideWork(work, 'Rating'); continue; }

      const series: number[] = [];
      for (const a of $$<HTMLAnchorElement>('.series a', work)) {
        const s = a.pathname.match(regexSeries);
        if (s && !series.includes(Number(s[1]))) series.push(Number(s[1]));
      }
      void bridge.shouldFilterWork(wid, authors, tags, series).then((f) => {
        if (f) hideWork(work, f);
        work.classList.add('ao3t-processed');
      }).catch(() => work.classList.add('ao3t-processed'));
    }
  }

  function hideWork(work: HTMLElement, why: string) {
    if (S.listFiltering.hideFilteredWorks) {
      work.classList.add('ao3t-filtered', 'ao3t-filtered-hide-full', 'ao3t-processed');
      return;
    }
    const msg = document.createElement('div');
    msg.className = 'ao3t-filtered-message';
    const toggle = Object.assign(document.createElement('button'), { type: 'button', className: 'ao3t-filtered-toggle', textContent: 'Show work' });
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      const hidden = work.classList.toggle('ao3t-filtered-hide');
      toggle.textContent = hidden ? 'Show work' : 'Hide work';
    });
    const label = document.createElement('span');
    label.textContent = `Hidden by filter: ${why}`;
    msg.append(label, toggle);
    work.classList.add('ao3t-filtered', 'ao3t-filtered-hide', 'ao3t-processed');
    work.prepend(msg);
  }

  // ---- progress badges on blurbs and the work header ----
  function extendSummary(work: HTMLElement, wid: number, wc: WorkChapter, inList: boolean) {
    const dd = $('.stats dd.chapters', work);
    if (!dd || dd.querySelector('.ao3t-read')) return;
    const m = (dd.textContent ?? '').replace(/\s/g, '').match(/^(\d+)\/(\d+|\?)/);
    const finished = chaptersFinished(wc);
    const path = `/works/${wid}${wc.chapterid ? `/chapters/${wc.chapterid}` : ''}#ao3tjump`;
    const read = Object.assign(document.createElement('a'), { href: path, className: 'ao3t-read', textContent: String(finished), title: 'Chapters you have read — click to continue' });
    dd.prepend(read, '/');
    if (!m) return;
    const heading = $('.header h4.heading', work) ?? $('h2.title', document) as HTMLElement | null;
    if (!heading) return;
    const published = Number(m[1]);
    const total = m[2] === '?' ? null : Number(m[2]);
    const badges = document.createElement('span');
    badges.className = 'ao3t-badges';
    if (published > finished) {
      const unread = published - finished;
      const b = Object.assign(document.createElement('a'), { href: path, className: 'ao3t-badge ao3t-unread', textContent: `${unread} unread` });
      b.title = `Ao3Track: ${unread} unread chapter${unread === 1 ? '' : 's'}`;
      badges.append(b);
    } else if (total === finished) {
      badges.append(Object.assign(document.createElement('span'), { className: 'ao3t-badge ao3t-done', textContent: 'Read', title: 'Ao3Track: you have read every chapter' }));
    }
    if (inList) badges.append(Object.assign(document.createElement('span'), { className: 'ao3t-badge ao3t-inlist', textContent: 'Reading list', title: 'Ao3Track: in your reading list' }));
    if (badges.childNodes.length) heading.append(' ', badges);
  }

  if (typeof jumpNow === 'object') scrollToLocation(workid, jumpNow, false);

  bridge.onJumpRequest?.(() => {
    void bridge.getWorkDetails([workid]).then((d) => {
      const loc = d[workid]?.savedLoc;
      if (loc) scrollToLocation(workid, loc, true);
    });
  });

  if (works.length) {
    void bridge.getWorkDetails(works).then((details) => {
      works.forEach((wid, i) => {
        const d = details[wid];
        if (!d) return;
        const wc = d.savedLoc ?? { number: 1, chapterid: 0, location: 0, seq: 0 };
        if (wid === workid && d.savedLoc) {
          bridge.enableLastLocationJump(workid, wc);
          if (jumpNow === true) scrollToLocation(workid, wc, false);
        }
        if (workEls[i] && (d.savedLoc || d.inReadingList)) extendSummary(workEls[i], wid, wc, !!d.inReadingList);
      });
    });
  }

  // ---- series links that are in the reading list ----
  const seriesLinks = $$<HTMLAnchorElement>('.series a[href^="/series/"]');
  if (seriesLinks.length) {
    void bridge.areUrlsInReadingList(seriesLinks.map((a) => a.href)).then((r) => {
      for (const a of seriesLinks) if (r[a.href]) a.prepend(Object.assign(document.createElement('span'), { className: 'ao3t-badge ao3t-inlist ao3t-mini', textContent: '📚', title: 'Ao3Track: in your reading list' }));
    });
  }

  // ---- add a sort-direction selector to the work filter form ----
  for (const form of $$<HTMLFormElement>('form#work-filters')) {
    if ($('[name="work_search[sort_direction]"]', form)) continue;
    const col = $<HTMLSelectElement>('select[name="work_search[sort_column]"]', form);
    const dd = col?.closest('dd');
    if (!dd) continue;
    const cur = new URLSearchParams(location.search).get('work_search[sort_direction]') ?? '';
    const select = Object.assign(document.createElement('select'), { id: 'work_search_sort_direction', name: 'work_search[sort_direction]' });
    for (const [v, t] of [['', ''], ['asc', 'Ascending'], ['desc', 'Descending']]) select.add(new Option(t, v, false, v === cur));
    const dt = document.createElement('dt');
    dt.append(Object.assign(document.createElement('label'), { htmlFor: select.id, textContent: 'Sort Direction' }));
    const newDd = document.createElement('dd');
    newDd.append(select);
    dd.after(dt, newDd);
  }

  bridge.setPageTitle?.(pageTitle());
  return { scrollToLocation, workid };
}

function pageTitle(): PageTitle {
  const h = document.querySelector('h2.heading')?.textContent?.trim();
  if (!h) {
    return { title: document.title.replace(/ \| Archive of Our Own$| \[Archive of Our Own\]$/, '') };
  }
  const t: PageTitle = { title: h };
  const num = document.querySelector('#chapters h3.title > a');
  if (num) {
    t.chapter = num.textContent?.trim();
    let name = '';
    for (let n = num.nextSibling; n; n = n.nextSibling) if (n.nodeType === Node.TEXT_NODE) name += n.textContent ?? '';
    name = name.trim().replace(/^:\s*/, '');
    if (name && name !== t.chapter) t.chaptername = name;
  }
  const authors = Array.from(document.querySelectorAll('h3.heading a[rel=author]'), (a) => a.textContent!.trim()).filter(Boolean);
  if (authors.length) t.authors = authors;
  const fandoms = Array.from(document.querySelectorAll('.meta dd.fandom.tags a.tag'), (a) => a.textContent!.trim()).filter(Boolean);
  if (fandoms.length) t.fandoms = fandoms;
  t.primarytag = document.querySelector('.meta dd.relationship.tags a.tag')?.textContent?.trim() || null;
  return t;
}

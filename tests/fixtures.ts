/** Minimal but structurally faithful AO3 markup (blurb + work page). */
export function blurb(id: number, o: { title?: string; ch?: string; author?: string; series?: number; fandom?: string } = {}) {
  const [pub, tot] = (o.ch ?? '3/10').split('/');
  return `
<li id="work_${id}" class="work blurb group work-${id} user-1" role="article">
  <div class="header module">
    <h4 class="heading">
      <a href="/works/${id}">${o.title ?? `Work ${id}`}</a>
      by <a rel="author" href="/users/${o.author ?? 'writer'}/pseuds/${o.author ?? 'writer'}">${o.author ?? 'writer'}</a>
    </h4>
    <h5 class="fandoms heading"><span class="landmark">Fandoms:</span> <a class="tag" href="/tags/${encodeURIComponent(o.fandom ?? 'Good Omens')}/works">${o.fandom ?? 'Good Omens'}</a></h5>
    <ul class="required-tags">
      <li><a class="help symbol question modal"><span class="rating-teen rating" title="Teen And Up Audiences"><span class="text">Teen And Up Audiences</span></span></a></li>
      <li><a class="help symbol question modal"><span class="warning-no warnings" title="No Archive Warnings Apply"><span class="text">No Archive Warnings Apply</span></span></a></li>
      <li><a class="help symbol question modal"><span class="category-slash category" title="M/M"><span class="text">M/M</span></span></a></li>
      <li><a class="help symbol question modal"><span class="complete-no iswip" title="Work in Progress"><span class="text">Work in Progress</span></span></a></li>
    </ul>
    <p class="datetime">05 Mar 2026</p>
  </div>
  <ul class="tags commas">
    <li class="warnings"><strong><a class="tag" href="/tags/No%20Archive%20Warnings%20Apply/works">No Archive Warnings Apply</a></strong></li>
    <li class="relationships"><a class="tag" href="/tags/x/works">Aziraphale/Crowley</a></li>
    <li class="characters"><a class="tag" href="/tags/y/works">Crowley</a></li>
    <li class="freeforms"><a class="tag" href="/tags/z/works">Slow Burn</a></li>
  </ul>
  <blockquote class="userstuff summary"><p>A summary.</p></blockquote>
  ${o.series ? `<ul class="series"><li>Part <strong>2</strong> of <a href="/series/${o.series}">The Series</a></li></ul>` : ''}
  <dl class="stats">
    <dt class="language">Language:</dt><dd class="language" lang="en">English</dd>
    <dt class="words">Words:</dt><dd class="words">12,345</dd>
    <dt class="chapters">Chapters:</dt><dd class="chapters"><a href="/works/${id}/chapters/9">${pub}</a>/${tot}</dd>
    <dt class="kudos">Kudos:</dt><dd class="kudos"><a href="/works/${id}/kudos">1,024</a></dd>
    <dt class="hits">Hits:</dt><dd class="hits">20,000</dd>
  </dl>
</li>`;
}

export const searchPage = (items: string[]) =>
  `<!DOCTYPE html><html><body><div id="main"><ol class="work index group">${items.join('\n')}</ol></div></body></html>`;

export const workPage = (id: number) => `<!DOCTYPE html><html><body><div id="main">
<dl class="work meta group">
  <dt class="rating tags">Rating:</dt><dd class="rating tags"><ul class="commas"><li><a class="tag">Explicit</a></li></ul></dd>
  <dt class="fandom tags">Fandom:</dt><dd class="fandom tags"><ul class="commas"><li><a class="tag">Hidden Fandom</a></li></ul></dd>
  <dt class="language">Language:</dt><dd class="language">English</dd>
  <dt class="stats">Stats:</dt><dd class="stats"><dl class="stats">
    <dt class="status">Updated:</dt><dd class="status">2026-08-01</dd>
    <dt class="words">Words:</dt><dd class="words">5,000</dd>
    <dt class="chapters">Chapters:</dt><dd class="chapters">2/?</dd>
  </dl></dd>
</dl>
<div id="workskin"><div class="preface group"><h2 class="title heading">Restricted One</h2>
<h3 class="byline heading"><a rel="author" href="/users/secret/pseuds/secret">secret</a></h3>
<div class="summary module"><blockquote class="userstuff"><p>Hi.</p></blockquote></div></div></div>
</div></body></html>`;

export const RETRY_LATER = '<html><body>Retry later</body></html>';

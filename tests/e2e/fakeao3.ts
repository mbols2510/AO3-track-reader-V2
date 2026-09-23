import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { blurb, searchPage } from '../fixtures.ts';

const paras = (n: number) => Array.from({ length: n }, (_, i) => `<p>Paragraph ${i} — ${'Lorem ipsum dolor sit amet. '.repeat(12)} It was 72 degrees Fahrenheit.</p>`).join('\n');

export const workPageHtml = (id: number, chapter: number, chapterId: number) => `<!DOCTYPE html><html><head><title>Work ${id} - Chapter ${chapter} | Archive of Our Own</title>
<link rel="next" href="/works/${id}/chapters/${chapterId + 1}"></head><body><div id="outer"><div id="inner"><div id="main" class="chapters-show">
<div class="work"><dl class="work meta group"><dd class="fandom tags"><a class="tag" href="/tags/Good%20Omens/works">Good Omens</a></dd>
<dl class="stats"><dt class="chapters">Chapters:</dt><dd class="chapters">3/5</dd></dl></dl></div>
<div id="workskin"><div class="preface group"><h2 class="title heading">Work ${id}</h2><h3 class="byline heading"><a rel="author" href="/users/writer/pseuds/writer">writer</a></h3></div>
<div id="chapters"><div class="chapter" id="chapter-${chapter}"><div class="chapter preface group"><h3 class="title"><a href="/works/${id}/chapters/${chapterId}">Chapter ${chapter}</a>: The Middle</h3></div>
<div class="userstuff module" role="article"><h3 class="landmark heading">Chapter Text</h3>${paras(120)}</div></div></div></div>
<div id="feedback"><div class="actions"><ul><li><a href="#">Kudos</a></li></ul></div></div>
</div></div></div></body></html>`;

export function startFakeAo3(): Promise<{ server: Server; port: number; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://archiveofourown.org');
    hits.push(u.pathname + u.search);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (u.pathname === '/works/429') { res.statusCode = 429; res.setHeader('Retry-After', '120'); return res.end('<html><body>Retry later</body></html>'); }
    let m = u.pathname.match(/^\/works\/(\d+)\/chapters\/(\d+)$/);
    if (m) return res.end(workPageHtml(Number(m[1]), 2, Number(m[2])));
    if (u.pathname === '/works' || u.pathname === '/works/search') {
      const q = u.searchParams.get('work_search[query]');
      const ids = q ? [...q.matchAll(/\d+/g)].map((x) => Number(x[0])) : [123, 456, 789];
      return res.end(searchPage(ids.map((i) => blurb(i, { ch: '3/5', author: i === 456 ? 'blocked' : 'writer' }))));
    }
    m = u.pathname.match(/^\/series\/(\d+)$/);
    if (m) return res.end(`<html><body><div id="main"><h2 class="heading">Series ${m[1]}</h2><dl class="series meta group"><dt>Complete:</dt><dd>No</dd></dl><ul class="series work index group">${blurb(123, { ch: '3/5' })}</ul></div></body></html>`);
    res.statusCode = 404;
    res.end('<html><body>Not found</body></html>');
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: (server.address() as AddressInfo).port, hits })));
}

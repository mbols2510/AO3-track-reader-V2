# Changelog

## 2.1.0 — 2026-09-25

### Enhancements
- **Reading list grouped by fandom, like the original app** ([#3](https://github.com/mbols2510/AO3-track-reader-V2/issues/3)). Works sit under their fandom, series under the fandom most of their works belong to, and tag listings join the matching fandom's group when there is one; other listings and searches get their own group. Each group header shows how many entries and unread chapters it holds. Click a header to fold it away (remembered between sessions), use *Collapse all / Expand all*, or pick *No grouping* for the old flat list. Searching the list shows every match, even in folded groups.
- **Text size setting chooses what it affects.** Settings → Appearance now has *Whole page* (new default) and *Story text only* (the 2.0 behaviour).
- Ctrl + mouse wheel now changes the reader's text size and is remembered, instead of being a separate, forgotten zoom.
- Listing cards show the filters in use (for example "complete only · English · excluding Major Character Death") and the full link on hover.
- The TrackSync web dashboard shows readable names for listings and searches instead of raw links.

### Fixes
- **Text size now enlarges the whole AO3 page** ([#1](https://github.com/mbols2510/AO3-track-reader-V2/issues/1)): the work title, tags, summary, notes, headers and menus grow along with the story text, as in the original app. It stays applied across pages and reloads.
- **Reading-list entries for fandom listings get a proper name** ([#2](https://github.com/mbols2510/AO3-track-reader-V2/issues/2)). After *Sort and Filter*, AO3 moves the fandom into the link's query (`/works?…&tag_id=Original+Work`), so those entries showed as a URL. They now show "Original Work". Searches ("Search: dragons"), user pages ("Works by …", "Bookmarks by …") and collections are named too.
- Release files carry the right version: the extension zip was hard-coded as `2.0.0` (so the v2.0.1 release shipped 2.0.0-named files), and the tracker image copied that fixed name. Both now follow the package version.
- The TrackSync server reports its real version (it said 2.0.0 regardless).

### Upgrading
Run the new MSI; it replaces 2.0.x in place and keeps your data. For the servers: `git pull`, then `docker compose up -d --build`. Reload the browser extension from the new zip.

## 2.0.1
- Docker: support `PUID`/`PGID` so bind-mounted data folders are writable.
- CI: attach the MSI, MSIX and extension to GitHub releases; fix the Windows SDK lookup for MSIX.

## 2.0.0
- First release of the TypeScript rewrite of Ao3-Tracker.

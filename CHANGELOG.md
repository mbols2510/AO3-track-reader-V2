# Changelog

## 2.2.0 — 2026-09-27

### Enhancements
- **Server images follow "latest"** ([#4](https://github.com/mbols2510/AO3-track-reader-V2/issues/4)). Every release now also publishes the Docker images as `latest` (and as `2.2.0`), and `docker-compose.yml` downloads them instead of building locally. Which version runs is set by `AO3TRACK_VERSION` in `.env` (`latest` by default, or pin one such as `2.2.0`), so you no longer edit the compose file. Update with `docker compose pull && docker compose up -d`. To build from source instead, add `-f docker-compose.build.yml`.
- **The reader tells you about new versions** ([#5](https://github.com/mbols2510/AO3-track-reader-V2/issues/5)). Shortly after it starts (and via *Settings → Check for updates*) the reader asks your tracker whether a newer version exists. If so it offers *Install now*, *Later* or *Skip this version*; *Install now* downloads the installer through your tracker and runs it, and your data is kept. Because the repository is private, the tracker needs a read-only GitHub token in `.env` (`GITHUB_TOKEN`, see Upgrading).
- **The tracker container does the reading-list checks** ([#7](https://github.com/mbols2510/AO3-track-reader-V2/issues/7)). With a tracker set, the reader no longer checks AO3 when it starts or on its own schedule. It shows what the tracker found, and the tracker keeps checking every 6 hours even while the reader is closed. Press ⟳ in the reading list to have the tracker check right away. Works added on another device show *Not checked yet* until then.
- **Delete reading positions in the dashboard** ([#8](https://github.com/mbols2510/AO3-track-reader-V2/issues/8)). The TrackSync dashboard has a new *Works tracked* list with every work you have a saved position for (title, chapter, last read), a filter, and *Delete* per work or for a selection. Deleted positions also disappear from the reader and extension at their next sync; if you read the work again later, it's tracked again.
- **Readable, renamable fandom groups** ([#9](https://github.com/mbols2510/AO3-track-reader-V2/issues/9)). Fandoms AO3 names "original | English", such as "魔道祖师 - 墨香铜臭 | Módào Zǔshī - Mòxiāng Tóngxiù", now show and sort by their English name. Right-click any group header for *Rename group…* or *Reset name*. Names are kept on that PC and included in the reader's backup file.

### Fixes
- **Fewer rate-limit errors, and no banner for them** ([#6](https://github.com/mbols2510/AO3-track-reader-V2/issues/6)). After AO3 says "slow down", nothing retries for at least 5 minutes (doubling if it happens again). Before, the app obeyed AO3's "try again in 60 seconds" exactly, which tended to trip the limit again. The normal pace is also halved, to about 5 requests a minute. The banner now only appears when AO3 blocks the page you're reading; background pauses show as a quiet line in the reading list ("Updates paused by AO3 until 10:48").
- Opening the dashboard no longer makes the tracker look works up on AO3; it shows what's already known.
- The dashboard's result messages were missing their closing tags, which could nest the following content inside them.
- The TrackSync server takes its reported version from its package, so it can't fall behind again.

### Upgrading
- **Servers:** `git pull`, then once sign Docker in to GitHub's image registry: `docker login ghcr.io -u mbols2510`, with a *classic* token that has only **read:packages** as the password. Then `docker compose pull && docker compose up -d` (add your usual `-f` files). Your data volumes are kept.
- **Check `.env`:** if it still says `RATE_BURST=3` and `RATE_REFILL_SECONDS=6` (copied from the old template), those override the new gentler pace. Change them to `2` and `12`, or delete both lines.
- **Update checker:** add `GITHUB_TOKEN=` to `.env` with a fine-grained token for this repository only, permission **Contents: Read-only**, then `docker compose up -d`.
- **Reader:** run `ArchiveTrackReader-2.2.0-x64.msi`; it replaces 2.1 in place. From now on the reader offers updates itself.
- **Extension:** reload it from `ao3track-extension-2.2.0.zip`.

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

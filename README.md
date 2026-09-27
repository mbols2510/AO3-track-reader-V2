# Ao3Track 2

A revival of [Ao3-Tracker](https://github.com/wench/Ao3-Tracker) (archived 2019): remembers exactly where you stopped reading on the Archive of Our Own, shows how many chapters are unread, keeps a reading list, hides works you don't want to see, and syncs all of it between your devices — now through servers **you** run.

| Piece | What it is | Replaces |
|---|---|---|
| **TrackSync** (`services/tracksync`, Docker) | Accounts, sync API and a web dashboard. Speaks the original wire protocol. | The ASP.NET `Ao3tracksync` service on wenchy.net |
| **Tracker** (`services/tracker`, Docker) | Rate-limited, caching gateway to AO3. Refreshes everyone's reading list on a schedule. | New — the original apps each scraped AO3 themselves |
| **Archive Track Reader** (`apps/reader`, Windows MSI) | Desktop reader (Electron) with a reading-list sidebar. | The Xamarin UWP / Store app |
| **Browser extension** (`apps/extension`) | Manifest V3 for Chrome, Edge and Firefox. | The 2017 MV2 extension |

Everything is TypeScript on current runtimes: Node 24, Fastify 5, Electron 44, TypeScript 7, SQLite via `node:sqlite`.

## Quick start

**Full walkthrough, including remote access with your own domain: [docs/SETUP.md](docs/SETUP.md).** Installers are on the [Releases](https://github.com/mbols2510/AO3-track-reader-V2/releases) page.

### 1. Run the servers

```sh
cp .env.example .env          # then set INTERNAL_TOKEN (openssl rand -hex 32)
docker login ghcr.io -u mbols2510   # once; password = a classic token with read:packages
docker compose up -d
```

This downloads the ready-made images (`AO3TRACK_VERSION=latest` in `.env`, or pin a version). Update later with `docker compose pull && docker compose up -d`. To build from source instead: `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`.

Open the dashboard at **http://localhost:8080** and create your account. The tracker's status is at http://localhost:8081/api/status.

By default both ports are only reachable from the same PC. To use them from other devices, set `BIND_ADDRESS=0.0.0.0` and `TRACKSYNC_PUBLIC_URL=http://<your-pc>:8080` in `.env` (and put it behind HTTPS if it's reachable from outside your home network). Once your accounts exist, set `ALLOW_REGISTRATION=false`.

### Remote access (your own domain)

Point `sync.<domain>` and `tracker.<domain>` at your home IP, forward ports 80 and 443 to this machine, fill in the remote-access section of `.env` (including `TRACKER_API_KEY`), then:

```sh
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
```

Caddy obtains HTTPS certificates automatically. Can't forward ports (CGNAT, some ISPs)? Use `docker-compose.tunnel.yml` with a Cloudflare Tunnel instead. In the reader, use `https://sync.<domain>` and `https://tracker.<domain>` plus the tracker API key.

### 2. Bring your data over from the original service

In the dashboard, use **Bring your data over**: enter the username and password you used with the original Archive Track Reader. It copies reading positions, the reading list and list filters. Nothing on the original service is changed, and it's safe to run more than once — anything already present is kept, and a position only ever moves forward.

If the original service is offline, you can import the old Windows app's local database instead (dashboard → **Import the old app's database**). It lives at:

```
%LOCALAPPDATA%\Packages\<Archive Track Reader package>\LocalState\Ao3TrackSQLite.db3
```

The desktop reader can also migrate directly (Settings → *Bring over data from the original app*), which is handy if you'd rather not run the server at all.

### 3. Install the desktop reader

Run `ArchiveTrackReader-2.2.2-x64.msi` from the [latest release](https://github.com/mbols2510/AO3-track-reader-V2/releases/latest). On first launch the settings pane opens: enter `http://localhost:8080` and your account. Optionally set the tracker (`http://localhost:8081`): it then checks your reading list on its own schedule, even while the reader is closed, and the reader just shows the results (⟳ checks right away).

**About "updating" the Store app:** the old app from the Microsoft Store can't be upgraded in place — its package identity belongs to the original publisher's Store certificate, and Windows only lets that publisher update it. The new reader installs alongside it, with its own Start Menu entry. Migrate your data (step 2), check everything's there, then uninstall the old app from *Settings → Apps*. Future versions of the new reader *do* upgrade in place: the MSI has a fixed upgrade code, so installing 2.2 replaces 2.1. With `GITHUB_TOKEN` set on the tracker, the reader offers updates itself.

The MSI isn't code-signed, so SmartScreen will show "Windows protected your PC" → *More info* → *Run anyway*. The GitHub Actions workflow can sign builds if you add a certificate.

### 4. Install the browser extension (optional)

Download it from your tracker: **http://localhost:8081/downloads/ao3track-extension-2.2.2.zip**, unzip it, then:

- **Chrome / Edge:** `chrome://extensions` → enable *Developer mode* → *Load unpacked* → pick the folder.
- **Firefox:** `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → pick `manifest.json`. (Permanent installation in Firefox requires signing it through addons.mozilla.org.)

Open the extension's options, enter your server and sign in. If you were using the 2017 extension, its saved positions are picked up automatically.

## Using it

- **Reading position** is saved as you scroll, down to the paragraph. Press **Ctrl+J** (reader) or **Continue reading** (extension) to jump back to where you stopped, on any device.
- **Works lists** show `N unread`, `Read` and `Reading list` badges, plus how many chapters you've read in the chapter count.
- **Reading list** (reader sidebar, **Ctrl+B**): works, series and tag/search pages. Shows unread chapters, progress, and whether a work is complete. Grouped by fandom like the original app (fold groups away, or switch to *No grouping*); fandoms named "原名 | English name" on AO3 show their English name, and right-clicking a group lets you rename it; filtered fandom listings and searches show readable names. Star entries to pin them. Add with **Ctrl+D** or the ☆ button; right-click any AO3 link for more.
- **Hide works** by tag, author, work or series: right-click a link → *Hide works…*. Also: *Only show General / Teen works*.
- **Unit conversion**: click a measurement ("72 degrees Fahrenheit") in a story to convert it.
- Other shortcuts: **Ctrl+Shift+←/→** previous/next chapter, **Ctrl+=/−/0** text size (whole page by default, or story text only — see Settings → Appearance), **Alt+←/→** back/forward, **Ctrl+L** address bar (type a search, a link, or just a work number).

## How AO3's rate limiting is respected

AO3 limits requests per IP address per minute and answers with HTTP 429 "Retry later" when you go over. The limit isn't published, so Ao3Track is deliberately conservative:

- **All background requests go through one limiter**: one request at a time, a burst of 2, then about one every 12 seconds (≈5/minute), and never closer than 2 seconds apart. Things you asked for jump the queue; they never raise the rate.
- **On a 429 everything pauses** for at least 5 minutes, doubling on repeated 429s up to an hour (longer if AO3's `Retry-After` asks for it; AO3 often says 60 seconds, but going back that soon tends to trip it again).
- **Batching:** the status of up to 20 works is fetched with a single search request (`id:(1 OR 2 OR …)`), so refreshing a 200-work reading list costs about 10 requests, spread over a couple of minutes.
- **Caching:** metadata is reused for 6 hours. The desktop reader also learns from pages you're already reading: every works list and work page you open updates the cache for free.
- **One IP, one budget:** if you browse AO3 yourself and hit "Retry later", the reader shows a banner and pauses its own background lookups too. When a tracker is configured, the reader leaves background lookups entirely to it: it only reads the tracker's results, and asks AO3 for fresh data only when you press ⟳.

All limits are adjustable in `.env`. Please don't turn them up much: AO3 is run by volunteers.

## Configuration

TrackSync: `PORT` (8080), `DB_PATH`, `ALLOW_REGISTRATION`, `PUBLIC_URL`, `TRACKER_URL`, `INTERNAL_TOKEN`, `LEGACY_API_URL`, `TRUST_PROXY`, `CORS_ORIGINS`.

Tracker: `PORT` (8081), `DB_PATH`, `TRACKSYNC_URL`, `INTERNAL_TOKEN`, `RATE_BURST`, `RATE_REFILL_SECONDS`, `RATE_MIN_INTERVAL_SECONDS`, `RATE_PAUSE_MINUTES`, `CACHE_TTL_HOURS`, `REFRESH_INTERVAL_HOURS`, `USER_AGENT`, `AO3_COOKIE`, `DOWNLOADS_DIR`, `GITHUB_TOKEN`, `GITHUB_REPO`.

Compose: `AO3TRACK_VERSION` (`latest`), `AO3TRACK_IMAGES` (`ghcr.io/mbols2510`).

Admin CLI inside the TrackSync container:

```sh
docker compose exec tracksync node cli.js users
docker compose exec tracksync node cli.js reset-password <user> <new-password>
docker compose exec tracksync node cli.js migrate <user> <old-user> <old-password>
docker compose exec tracksync node cli.js export <user> > backup.json
```

The dashboard's *Works tracked* list shows every saved reading position; deleting one there also removes it from the reader and extension at their next sync.

Backups: the data lives in the `tracksync-data` volume (`/data/tracksync.db`, SQLite). The dashboard also has *Download backup* / *Restore from backup* (JSON; restoring merges and never deletes).

## Differences from the original

- Passwords are hashed with scrypt; each device gets its own revocable token (changing your password signs every device out). Old apps still work against TrackSync, since the protocol is unchanged.
- Migrated items get fresh timestamps so they reach devices that had already synced — otherwise the protocol would skip them, or treat reading-list entries as deleted.
- Dropped: the Tumblr link cleaner (Tumblr no longer wraps links that way), the Android and iOS apps (Xamarin is end-of-life), and the in-app speech feature.
- New: tracker service, reading-list sidebar with progress and filters, favourites, dark mode, backup/restore, admin CLI.

## Development

```sh
npm ci
npx tsc -p tsconfig.json --noEmit           # type-check everything
npm test                                    # unit + integration tests (no network needed)
node --experimental-transform-types tests/e2e/extension.e2e.ts    # real Chrome
xvfb-run node --experimental-transform-types tests/e2e/reader.e2e.ts  # real Electron
cd apps/reader && npm start                 # run the desktop reader
cd apps/reader && node build.mjs && node package-win.mjs && node make-msi.mjs   # MSI (needs wixl on Linux)
```

The e2e tests drive the real extension and desktop app against a fake AO3, a real TrackSync, and a stand-in for the original cloud service. CI (`.github/workflows/build.yml`) runs the tests, builds multi-arch Docker images, the MSI and extension, and an MSIX on a Windows runner (signed if you add `WINDOWS_PFX_BASE64` / `WINDOWS_PFX_PASSWORD` secrets).

## License

Apache 2.0, like the original. Ao3Track is an unofficial tool and is not affiliated with the Archive of Our Own or the Organization for Transformative Works.

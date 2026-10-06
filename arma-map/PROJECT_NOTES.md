# Project notes (for an LLM or a new developer)

A quick map of how the site works and where each piece lives. [README.md](README.md) is the user-facing manual
(features, how the numbers are worked out, hosting, data files). This file is about the **code**.

## What it is

**Arma Reforger Maps**: a browser tactical map for Arma Reforger squads (maps: Everon, Kolguyev, Arland). Players join
a **room** by name + room code and share markings live. The site has:

- a field map with markings, line of sight, a mortar solver, a shot calculator, routes, sound and more
- four stand-alone workbench pages: **Mortar**, **Shot planner**, **Base planning** and **Line of sight**
- a WebGL **3D view** of the same terrain and markings
- an **admin** page

No build step and no dependencies: a single Python 3.9+ server (`server.py`, standard library only) plus plain
browser JS (IIFEs, `'use strict'`, no modules or bundler), with Leaflet vendored in `static/vendor/leaflet/`.

## Repos and folders

| Where | What |
|---|---|
| Git root | `AGENTS.md` (shared agent instructions), `README.md`, `.claude/launch.json` (dev server: `python arma-map/server.py --port 8765`). The sole landing page lives in `arma-map/static/landing/`. |
| `arma-map/` | **The site.** Everything below is relative to it. |
| `reforger-map-tools` (separate project) | Exports/bakes game data with `rmt.py`; includes ballistics tests and a GUI. It is not included in this repository. |

## Run and test

```bash
python arma-map/server.py --port 8765
```

- Then open `/` (field map), `/mortar`, `/shot`, `/base.html`, `/3d/` or `/admin`. `Start Everon Map.cmd` does the
  same on Windows.
- Tests (run from the application directory, or prefix paths with `arma-map/` from the repository root):
  - `python test_server.py` (server: rooms, validation, kept rooms, wind/clock)
  - `node test_client.cjs` (loads whole shared scripts in a `vm` sandbox and tests their public interfaces)
  - Browser smoke checks: [BROWSER_TESTS.md](BROWSER_TESTS.md); `python -B test_browser_server.py` runs an isolated server with upload-failure controls
- Syntax check a script with `node --check static/<file>.js`.
- Production pulls updates directly from GitHub and runs `server.py`; no deployment archive is built.
- The browser caches scripts: after an edit, use `location.reload()`, not same-URL navigation.

## Coordinates (the same in every file)

- Game X runs east and Z runs north, in metres (0..`world`, 12800 for Everon and Kolguyev, 4096 for Arland).
- Leaflet uses a custom CRS: 1 unit = 1 m, with `OFFSET = 50` and `SCALE = 12.501`. Each page has
  `toLL([x,z]) -> LatLng` and `toXZ(latlng)`.
- Grid references are 100 m (`"060 070"`) or 10 m (8 digits).
- Bearings are degrees from north. Wind is `{s: m/s, d: degrees it blows FROM}`.

## Server: `server.py`

A `ThreadingHTTPServer` with one `Handler`. Main pieces:

- **`Hub`**: the rooms.
  - It holds players (`Player`: id, token, name, colour, room, items) and players who left a kept room (`Away`).
  - Each room's info dict holds `briefing`, `clock`, `wind`, `keep` and `map`.
  - It broadcasts events to each player's `EventQueue` (SSE).
  - Methods: `join`, `upsert`, `delete`, `set_air_status`, `clear_fire`, `move_mortar_target`, `set_briefing`,
    `set_clock`, `set_wind`, `set_keep`, `leave`, `reap` (drops connections silent longer than `GRACE_SECONDS`),
    `save`/`load` (kept rooms go to `rooms.json` for `KEEP_HOURS`).
- **`validate_item`**: checks every marking. Allowed types are in `ITEM_TYPES`. There are size limits
  (`MAX_ITEM_BYTES`, ...), a weapon whitelist (`MORTAR_WEAPONS`, `ROCKET_LAUNCHERS`, `SCOPED_GUNS`) and `_is_wind`.
  **A new marking type or field must be allowed here**, or the server rejects it.
- **API**: everything else is a static file, gzip-cached in `compressed_cache/`.

  | Endpoint | Body or response |
  |---|---|
  | `GET /api/maps` (also served as `/3d/maps.json`) | the map list |
  | `POST /api/events` | `{id, token}` in JSON body; SSE stream: `snapshot`, `join`, `leave`, `item`, `delete`, `briefing`, `clock`, `wind`, `bye`. GET returns 405. |
  | `POST /api/join` | `{name, room, map, observer?: boolean}` → `{id, token, color, ...}`; observers can only stream and leave |
  | `POST /api/item`, `/api/delete` | add or replace a marking; delete one |
  | `POST /api/air-status`, `/api/mortar-target`, `/api/clear-fire` | change someone else's marking in the allowed ways |
  | `POST /api/briefing`, `/api/clock`, `/api/wind`, `/api/keep`, `/api/leave` | room settings and leaving |
  | `/api/admin/*` | Bearer token; `Admin`, `Bans` (`bans.json`), audit log |
- **Maps**: `load_maps()` lists every `static/data/maps/<id>/map.json`. `public_maps()` adds `tiles`, `poi`
  (`/data/<id>.json` when it exists), `hasPlants` and `hasRelief`. Tiles are at `/maptiles/<id>/z/x/y.jpg`: local
  tiles first, else fetched from `upstream` and cached in `tile_cache/`.
- **Protection**: `RateLimiter` (`RATE_LIMITS`), per-IP and per-room player caps, security headers, and
  `--behind-proxy` / `--trusted-proxies` / `--admin-allow` / `--admin-password`. Only loopback proxy peers are
  trusted by default. A correct admin password bypasses the global failure pause, but not address lockouts.
- **Nothing about players is stored** except kept rooms and bans.

## Browser pages (`static/`)

Page scripts are IIFEs. Mortar physics, shot physics, plan transfer and the base item factory are shared scripts;
helpers such as `esc`, `toLL`, grid parsing and glyph icons are still copied into each page.

| Page | Script(s) | What it does |
|---|---|---|
| `index.html` (field map, `/` and `/map`) | `app.js` (~6500 lines), `app.css`, `shot-core.js`, `sky.js`, `los-worker.js`, `workspace.js`, `3d/mortar.js`, `plan-sync.js` | Everything; see the next section |
| `mortar.html` | `mortar.js`, `mortar.css`, `3d/mortar.js` (global `Mortar`), `3d/room.js`, `workspace.js/css`, `plan-sync.js` | Gun + wind + target queue with ring, elevation, azimuth and time of flight; corrections; a reference map with place names and Conflict bases; room sharing (your gun becomes a `mortar` marking; it shows the room's mortars and fire requests) |
| `shot.html` | `shot.js`, `shot.css`, `shot-core.js`, `3d/room.js`, `plan-sync.js` | The shot calculator on its own page: shooter and target markers (draggable), weapon, wind, solution; in a room it's a marking under your name |
| `base.html` | `base.js`, `base.css`, `3d/los.js`, `los-worker.js`, `3d/room.js`, `base-items.js`, `plan-sync.js` | Pick a Conflict base, lay out defences and see dead ground; available from the shared operations bar |
| `los.html` (`/los`) | `los.js`, `los.css`, `los-analysis.js`, `los-worker.js` | Local multi-base LOS comparison, custom observers, check points and ownership stripes; no room writes |
| `3d/index.html` | `3d/main.js` (WebGL renderer, camera, minimap, HUD), `3d/worker.js` (mesh builder), `3d/marks.js` (markings in 3D), `3d/mortar.js`, `3d/los.js` (wraps `/los-worker.js`), `3d/room.js` | Fly or walk the terrain with the room's markings. Read-only observer sessions use separate capacity and do not claim player names |
| `admin.html` | `admin.js` | Rooms and players, kick, ban, close a room |

- **`construction.js`**: shared catalog of 26 vanilla construction roles, used by the base builder, tactical map
  and 3D markings. `CONSTRUCTION_CATALOG.md` maps every game registry family to its representative. New construction
  kinds must also be allowed in `server.py`; the client/server regression checks exercise actual builder payloads.
- **`workspace.js` / `workspace.css`**: the shared top bar (Tactical map / Mortar / Shot planner / Base planning / Line of sight), a
  status chip and layout toggles on every page with `<body data-workspace="...">`.
- **`3d/room.js`**: a reusable room client, `Room(api, {onChange, onStatus, onSettings})`. It exposes
  `join`, `listen`, `leave`, `players`, `me`, `setWind`, `setClock`, `wind`, `clock` and `gameNow()`. Base, mortar, shot and 3D use it;
  `app.js` has its own room code.
- **`room-events.js`**: `RoomEvents` provides reconnecting SSE over fetch POST for both room clients. It parses
  split UTF-8 and event frames, closes expired sessions, bounds buffered events and aborts on navigation/leave.
- **`static/landing/`**: the packaged copy of the existing public landing page, with an external redirect script.
  `deploy/Caddyfile` rewrites only `/` to that page and applies the app's headers plus hostname-only HSTS to every
  HTTPS response. This Caddyfile must be applied separately on the host.

## `app.js` layout (field map)

The banner comments name the sections. Use function names to navigate; line numbers move when features are extracted.

| Section | Entry points and shared code |
|---|---|
| Map and terrain | `toLL`, `toXZ`, `buildReference`, `groundFine`, `impactHeight` |
| Players and markings | `renderItem`, `drawItem`, `onEvent`, `saveItem` |
| Toolbar and shortcuts | `setTool`, `toggleMenu`, `pickerOptions` |
| Mortar | `Mortar.field` adapter, `solveFor`, `renderMortar`, `refreshMortarPanel` |
| Defend and visibility | construction catalog, `los-worker.js`, `renderHullDown` |
| Shots and routes | `ShotCore`, `needShotData`, route checks |
| Support and hazards | fire requests, helicopters, audible ranges, FIA caches |
| Export/import | `PlanSync.read`, `PlanSync.importItems` |
| Room settings and session | `joinRoom`, `setRoomWind`, `setClock`, SSE events |
| Browser backup | `writeKept`, `restoreMine`, `PlanSync.backup`, `PlanSync.restore` |
| Boot | `loadMaps`, map references, road and terrain grids |

- `state` is the central object: `state.me`, `state.players` (`Map` of name → `{items: Map}`), tool state and
  settings.
- The rocket and bullet data (`rockets.json`, `bullets.json`) loads lazily through `needShotData()`.
- Relief base tiles use the `relief-tiles` class and `relief-tone.svg` highlight curve. The filter applies only to
  that tile layer, preserving darker terrain, satellite colors and planning overlay colors. Baked tiles remain generated data.

## Shared engines and factories

- **LOS workbench**: `los-analysis.js` samples detailed worker results and combines each base's observers
  independently. Pending/failed cells remain unknown unless an existing clear view proves visibility. `los.js`
  keeps only current-plan worker results, cancels stale requests, resets workers on map changes and renders a
  bounded viewport raster. Session-storage plans are per map and separate from shared room backups. Base planning
  also allows 5/9/17 samples for its enemy views and no-defence fallback. `test_los_analysis.cjs` covers verdict
  precedence, incomplete/error results, observer identity and map edges, and runs with the client suite.

- **Mortar ballistics** live in **`3d/mortar.js` (`Mortar`)**, used by the field map, mortar page and 3D view.
  - `Mortar.field(env)` adapts the field map's point-array terrain callbacks, roof targeting, and range outlines.
  - `Mortar.invalidateTerrain()` clears solutions and reach outlines when terrain loads or changes.
  - `test_client.cjs` checks adapter behavior, elevation limits and fixed compatibility fixtures. Firing tables: `data/mortar-tables.json`.
- **`plan-sync.js` (`PlanSync`)** handles plan parsing/import, bounded restore retries and pending backups for all four planning pages.
  - `backup.begin(session, items)` retains saved items until `acknowledge(session, liveItems)` sees them on the server.
  - Backups are scoped to the session; current server items win over a saved copy, and acknowledged deletions stay deleted.
  - Explicit deletion tombstones exclude items from both restore and backup merging. Submitted edits are retained
    before their stream echo. `writer()` sequences upserts/deletes per session and item, including restore uploads.
- **`base-items.js` (`BaseItems`)** contains the base builder's item factory and classifier. The page supplies its state and geometry helpers;
  tests exercise the same factory without extracting source snippets.
- **`shot-core.js`**: `window.ShotCore(env)` is the rocket, rifle, MG and vehicle-gun calculator, used by `app.js`
  and `shot.js`.
  - Rockets use flights the game measured (`data/rockets.json` format 2; wind runs `by: 'distance'`, expanded on
    load).
  - Rocket range is capped at the self-destruct distance (`rocketRangeAt`).
  - Bullets use fitted quadratic drag (`data/bullets.json`).
  - The data comes from reforger-map-tools `rockettest.py`, `rocketfit.py` and `bullettest.py`. `rocketfit.py` has
    a Python copy of the site solver, and `test_sitesolver.py` checks it.
- **`los-worker.js`**: the Measured line of sight (rays over 0.5 m object tiles plus tree profiles). The field map,
  the base page and `3d/los.js` all use it.
  - `model: 'mesh'` selects `maps/<id>/foliage-mesh/` profiles and plant tiles; object/terrain tiles stay shared.
    `selectConfig` switches foliage caches before each queued request, retaining both datasets for comparisons.
    Plant identities are computed when loading tiles, and ray marches reuse the current terrain tile.
    The detailed solver visits plant candidates only on entering a different 4 m lookup bucket and reuses
    known tile coordinates for terrain interpolation. It skips target reclassification once an output cell
    is clear, while continuing all terrain/plant obstruction updates for farther targets. It also stops a ray once
    its solid horizon is strictly above the highest target slope still possible on it (per-tile 5 m terrain-maximum
    blocks, bounded per 5 m chunk of the ray), marking the remaining untouched cells hidden; cells stay identical.
    `benchmark_los.cjs` checks identical output cells against a Git baseline; see `LOS_SPEED.md/json`.
  - `/api/maps` exposes `hasMeshFoliage` from the packaged files. Measured remains the desktop default.
    Tactical map coarse Mesh previews and Light's default preset use the new light foliage grid.
    Light's secondary selector retains original photo foliage; its local storage key is `everon-map-light-model`.
    `compare_los.cjs` runs actual-worker queries and checks photo/mesh/photo switches without network or rooms.
- **`light-los.js`**: shared coarse LOS solver used by `app.js`, `test_light.cjs` and `calibrate_light.cjs`.
  Mesh and original photo presets share 10 m terrain/object grids and 5 m ray steps. Mesh foliage follows
  Foliage strength, including cache invalidation; original photos retains its previous fixed rates.
  The calibration runner uses actual local data on all three maps and coarsens detailed Mesh to the same
  best-visible 10 m cell rule. It fits on training/development scenes and rejects fits that lose held-out macro F1.
  See `LIGHT_CALIBRATION.md/json` for results, timing and limits. Generated grids are consumed unchanged.
- **`sky.js`**: sun and moon for the game clock.

## Rooms, sync and browser storage

- Room-shared settings are **wind** (`/api/wind`) and the **game clock** (`/api/clock`, `{rate, ...}`). The map, the
  mortar page and the shot planner all read and write the same values, and the newest one wins. Outside a room each
  page keeps its own.
- The site sets **no cookies**. sessionStorage holds `everon-session` (name, room and map for tab auto-rejoin),
  shot marking IDs and mortar splash timers. localStorage holds:
  - `everon-kept:<map>:<room>:<name>` (your own markings, so a rejoin restores them)
  - page state: `everon-mortar-page`, `shotPlanner`, `everon-base-page`
  - small UI preferences (`everon-map-*`, `operations-*`, `baseMap`)
- **Saved plans expire after 5 minutes** (`KEEP_MS` / `KEEP_MINUTES`). Their `at` timestamp is refreshed every 60 s
  while the page is open. Page state also records `owner` (`room|name`) and `ownerSig`, so a saved plan never
  publishes an unedited plan into a different room or under a different name. Edited/local workbench plans may
  intentionally transfer; room wind changes alone do not establish a user edit.
- The server allows 128 total rooms, 64 kept rooms, and 60 connected players plus saved owners per room. Existing saved owners can rejoin at capacity.
  Up to 20 read-only observers have separate room capacity without name collisions; they count toward global/per-address limits.
  Saved room loading applies the same limits and marking budgets and rejects files over 24 MB before parsing.
- Failed restores remain in the browser backup within its five-minute retention window; the page warns and a rejoin retries.
- A marking is `{id, type, ...}` with positions as `[x, z]` in metres, owned by its player. It disappears when the
  player leaves, unless the room is kept.

## Data (`static/data/`)

| File | Contents |
|---|---|
| `maps/<id>/` | `map.json`, `places.json` (towns, landmarks, pois), `roads.json`, `tiles/`, `relief/`, `los/` (500 m tiles, gz), `light/` (10 m grids incl. `height.bin.gz`), `plants/`, `foliage.json`, `foliage/`, `trees/` |
| `<map>.json` (`poi`) | `conflict` (`{name, kind, control, xz}`), `mob`, `supplies`, `vehicles`, `refuel`, `repair`, `fia`, `caves` |
| `mortar-tables.json`, `rockets.json`, `bullets.json` | Ballistics (see above) |

Map data is **generated** by reforger-map-tools (`rmt.py fieldmap <world>`). Don't hand-edit it; regenerate it. A new
map needs no code change: drop in its folder.

## Conventions

- Comment style: plain-English explanations of *why*, at about the density of the surrounding code. Match the
  existing naming (short helpers such as `$`, `esc`, `toLL`, `glyph`).
- When a feature changes, update `README.md` and relevant architecture/testing notes. External data-generation
  tools are a separate project; coordinate changes there explicitly.
- Verify UI changes in the browser preview. Run both test files after server or solver changes.

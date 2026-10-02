# Arma Reforger Maps

A shared tactical map of Arma Reforger (Everon, Kolguyev, Arland) for planning with your squad in the browser, with
a 3D view of the same maps and markings. Map data, terrain, line of sight, mortar ballistics and sound ranges are all
measured from the game itself.

- [Using the map](#using-the-map)
- [The 3D view](#the-3d-view)
- [How the numbers are worked out](#how-the-numbers-are-worked-out)
- [Hosting it on a website](#hosting-it-on-a-website)
- [Admin view](#admin-view)
- [Data and files](#data-and-files)

## Using the map

### Joining

Open the site, pick a username and a **room code**. Everyone who uses the same code sees the same markings, live.
**New code** makes a random one. **Invite** (next to your name, top left) copies a link that fills the code in. The
first person into a room picks its map; anyone who joins later gets that map.

Nothing is stored for you: your markings disappear when you close the tab (or within ~16 s if your browser drops).
Use **Export plan** / **Import plan** (My markings) to keep a plan between sessions.

### Layout

- **Left sidebar**: you and your room, search (places, bases, caches, everyone's markings), **My markings**, **FIA caches
  this game** and **Map layers**. Sections open and close from their headings. **Ctrl+K** finds any tool, layer or action.
- **Toolbar** (top): Select plus six menus.
- **Right column**: the **Mortar** panel at the top (only once you've placed or followed a mortar). At the bottom,
  from the top down: zoom buttons, **game clock**, **3D view**, **Squad** (Players, Contacts, Briefing).
- **Bottom**: grid reference under the cursor. Right-click anywhere for that spot's grid.

### Toolbar

**Select** (Q): click anything for details; drag your own markings to move them. Press a menu's letter, then a tool's
number (e.g. **E then 1** = contact report). Esc returns to Select. Middle-drag pans with any tool. Tool options appear
under the toolbar (number keys pick them). Drawn tools take a click per point: Backspace undoes, Enter / double-click /
right-click finishes.

| Menu | Key | Tools |
|---|---|---|
| Friendly | F | 1 My position · 2 Infantry · 3 Armour · 4 Advance arrow · 5 Rally point · 6 Objective · 7 Radio backpack · 8 AA gun · 9 Mortar |
| Enemy | E | 1 Contact report · 2 Infantry · 3 Armour · 4 Sniper · 5 Roadblock / ambush · 6 Enemy in area · 7 Approach arrow · 8 Patrol route · 9 Enemy line of sight · 0 AA gun |
| Plan | P | 1 Marker · 2 Route · 3 Ambush · 4 Range line · 5 Elevation profile · 6 Hull-down finder · 7 Overwatch finder · 8 Route planner · 9 Landing zone check · 0 Who can hear it |
| Support | S | 1 Fire support request · 2 Gun run (CAS) · 3 Medevac · 4 Pickup / insertion · 5 Resupply drop |
| Defend | D | 1 TRP · 2 Sectors of fire · 3 MG nest · 4 Bunker · 5 Sandbags · 6 Barbed wire · 7 Checkpoint · 8 Roadblock |
| Hazards | H | 1 AT minefield · 2 AP minefield · 3 Blocked or mined road · 4 Bridge out |

### Friendly

- **My position**: one per player. Pick Infantry or Armour and an optional **range card** (400 m, 800 m, 1.5 km) that
  shades what you can see. Range cards combine: cyan is seen by at least one, dark ground inside their reach is hidden
  from all of them.
- **Infantry / Armour**: unit symbols that time out (never, 5, 15, 30 min). Armour can carry a range card from its
  sights (2 m up).
- **Advance arrow, Rally point, Objective, AA gun**: plain markings.
- **Radio backpack**: optional 50 m spawn circle; turns red ("spawn blocked") when a marked enemy is inside.
- **Mortar**: see [Mortar](#mortar).

### Enemy

- **Contact report**: what, how many, doing what, heading, kit. Pulses for a minute, times out (15 min by default), and
  is stamped with the game time. **It moved** leaves a dotted track. The Squad panel's Contacts tab lists live contacts
  with distance and bearing from you.
- **Infantry, Armour, Sniper, Roadblock / ambush**: one click. All count as enemy positions for route exposure,
  route planning and radio spawn blocking.
- **Enemy in area**: hold the mouse button and circle the area.
- **Approach arrow, Patrol route**: drawn point by point.
- **Enemy line of sight**: soldier (eyes 1 m) or vehicle (2 m) and a reach; red is seen, yellow through trees.
- **AA gun**: click, aim, click. Covers 160° to 1.5 km; red is where it sees a helicopter at the chosen height (30, 100,
  200 m).

### Plan

- **Marker**: label, note, colour and type (point, objective, rally, danger).
- **Route**: time on foot and by vehicle, climb, height profile, legs, and where marked enemies can see it.
- **Ambush**: linear or L-shaped; click both ends of the kill zone, then your side. Drag its handles to adjust.
- **Range line / Elevation profile**: distance and bearing, plus a side-on view of ground, trees and buildings with the
  sight line. Profile lets you pick eye heights (prone, crouched, standing, vehicle).
- **Hull-down finder**: pick enemy, your vehicle (BTR-70, BRDM-2, LAV-25) and reach, click the enemy. Green: turret
  seen, hull hidden. Yellow: through trees. Blue: hidden ground within 30 m of green, to wait in. The popup lists the
  closest spots. Hull heights are estimates (`HULL` in `static/app.js`).
- **Overwatch finder**: click an objective; tinted ground can see a standing soldier on it.
- **Route planner**: Foot, Vehicle or Air; click start and end.
  - Foot: quickest jog (3.33 m/s, slowed by slopes) that stays out of enemy sight and keeps clear of marked enemies and
    minefields. Optional swimming.
  - Vehicle: quickest drive on the road network (estimated speeds in `ROAD_KMH`), optionally cross-country.
  - Air: snaps to landing zones and keeps a wide berth of enemies and AA.
  - Save as a route; saved routes re-plan when enemy markings change.
- **Landing zone check**: hover for a live verdict, click to mark an LZ. Checks slope, obstacles on and around the
  touchdown spot, uneven ground and clear approach directions, using the game's 1 m terrain and 0.5 m objects. Suggests
  the nearest good spot within 150 m.
- **Who can hear it**: pick a weapon (rifle / light MG, suppressed rifle, 7.62 MG, pistol) and background noise, click
  where the shooting is. A purple circle shows how far the muzzle blast carries. See [Sound](#sound).

### Support

- **Fire support request**: Area (circle it) or Point, and HE, Smoke or Illumination. Shows the target, kill and danger
  zones, friendlies inside them, and a firing solution from every mortar. Mortar crews clear it with **Mission
  complete**.
- **Gun run (CAS)**: sent at once as "CAS 1"; add details later with Edit. Point or area. Warns about friendlies within
  100 m.
- **Medevac, Pickup, Resupply**: short form, then anyone can mark it Acknowledged, En route or Complete. Medevac and
  pickup show the landing zone check for their spot.

### Defend

- **TRP**: numbered; shows distance and bearing from the nearest range card and whether each card can see it.
- **Sectors of fire**: 3, 4, 6 or 8 sectors; name who covers each and raise the position. Shows dead ground and enemies
  per sector.
- **MG nest**: arc 30-120° and height; shows line of sight while you aim.
- **Bunker, Checkpoint, Sandbags, Barbed wire, Roadblock**: plain markings.

### Hazards

AT minefield (10 m kill radius), AP minefield, blocked or mined road, bridge out.

### Mortar

Place a mortar (F then 9; M252 or 2B14, any shell) and the Mortar panel opens. Rings show each charge's reach.
Click to add targets (up to 30); each gets ring, elevation and azimuth in mils, and flight time, plus where 90% of
rounds land and the kill (+20 m) and danger (+35 m) zones for HE. Move the mouse for a live solution. Drag a target to
correct fire.

- **Wind**: enter it as the in-game map shows it (m/s, direction it comes from). It's saved on the mortar.
- **Noise and sound ranges**: Noise (Still, Breeze, Windy, Storm) sets how far firing and impacts are heard; **Show
  sound ranges** draws them.
- **Fire requests**: every request on the map is solved for your mortar and listed in the panel (+ adds it as a
  target).
- **Mortar teams**: click a teammate's mortar and pick **Use its solutions** so everyone reads the same numbers.

### Map layers

- **Places**: towns (34), landmarks (135), caves & hideouts (11, approximate).
- **Conflict**: bases, capture points and radio towers. Click one for its cap zone (50 m), build zone (100 m) and radio
  range. Also: radio network links, radio masts and HQ start positions.
- **Terrain**: forest, roads, foot paths, hill shading, contour lines (10-50 m; the cursor readout then shows height).
- **Planning overlays**: line-of-sight shading and helicopter landing (good, marginal, no-go).
- **Resources**: supply stashes, infinite supply points (Everon), vehicle spawns, refuel and repair points.
- **Line of sight**: Measured (0.5 m, the default on computers) or Light (10 m, the default on phones). **Foliage
  strength** tunes how much leaves block in Measured.

### Other

- **Game clock**: enter your in-game watch time and speed; the room shares it. Shows light level, sun and moon, and
  sunrise, sunset and first/last light. Set the date and latitude under "Date and latitude" to match your server.
- **Briefing**: one shared text per room (Squad → Briefing), with a template.
- **FIA caches this game**: type or paste grids (6 or 8 digit, or X/Z metres); each snaps to the nearest of the 25
  known spots and pulses pink for everyone. Or click a spot under "Show all possible cache spots".

## The 3D view

**3D view** (right column, or Ctrl+K → "Open in 3D") opens the map you're on in 3D in a new tab, already in your
room: everyone's markings are drawn on the terrain, with the same line of sight, mortar zones and sound ranges as on
the map. It only shows; draw on the map. It is also at `/3d/` directly (the landing page links to it), where you can
join a room by name and code. **2D map** (top left) goes back to the map in the same room.

- **Moving**: click the view to look around (Esc lets go). W A S D move, Space / C up and down, Shift faster, the
  wheel sets the flying speed. F switches between walking and flying, M opens the big map, H hides the help.
- **What it draws**: the game's own 1 m terrain and 0.5 m buildings, walls and rocks, every tree and bush as a shaped
  crown, roads and paths, and place names. Settings on the right: detail, how far out objects are drawn, the sun,
  and which layers show. **Measured tree shapes** draws each plant as its measured outline instead.
- It needs WebGL 2 (current Chrome, Edge or Firefox) and is best on a computer.
- In the room it appears as `<your name> 3D`, so others can see who is watching in 3D.

## How the numbers are worked out

### Line of sight

Terrain, buildings, walls, rocks, trees and bushes were measured in Arma Reforger Tools with the engine's own rays,
by `reforger-map-tools` (its `export` and `bake`).

- **The object data**: checked against 20,000 of the game's own sight lines (its `sightlines` job and `rmt.py check`),
  it agrees 95% of the time (terrain alone: 68%). Those rays ignore leaves, so foliage is measured separately.
- **Measured**: every plant blocks by how much of its outline the game actually draws, photographed in the game from 8
  sides at ranges up to 300 m (`reforger-map-tools`' `foliage` job). It probably overstates foliage a little; lower
  Foliage strength if trees block less in game.
- **Light**: every tree averaged into 10 m squares at seven heights. Agrees with the detailed model on 91% of ground.

Grass, clutter and see-through fences don't block.

### Mortar

Each shell is flown under gravity and drag in the wind, from the muzzle (1.3 m up) to the target's height. Speeds,
charge multipliers and drag come from the game's prefabs.

- **Matches the game's physics:** it reproduces the game's wind tables to ~0.1% and its own shell simulation to 0.05
  mil.
- **Checked with live fire:** over 700 real shells fired in game, it predicts the landing within a median 0.3 m of
  each round's real launch.
- **Firing tables only pick the rings:** the in-game tables are 1-20 mil off, so they're only used to decide which
  rings reach.
- **Spread:** comes from the game's launch-speed variation (±1.07 m/s) and barrel dispersion.

### Sound

A shot is heard while its loudest 50 ms of muzzle blast is above the background noise in some third-octave band.

- **Loudness at the gun:** from the game's amplitude configs; the shot is assumed to be that loud 2 m away.
- **Fall-off:** 6 dB per doubling of distance, plus air absorption.
- **Noise floor:** the game's wind and ambience recordings (−40 LUFS at full wind). The four noise levels are
  estimates.
- **Heard ranges in a breeze** (−50 LUFS): rifle 555 m, suppressed 310 m, 7.62 MG 695 m, mortar firing 330 m, HE
  impact 475 m.
- **Not counted:** hills, trees, buildings and the bullet's supersonic crack. The game's AI hears shots to 500 m
  (suppressed 100 m), the same order.

Scripts are in `reforger-map-tools/audible`; the data is in `everon_los/everon-data/sound`.

## Hosting it on a website

The site is one Python program (`server.py`, Python 3.9+, standard library only) that serves the field map (at `/`,
and at `/map`), its 3D view (at `/3d/`), the map data both read (`/data/`) and the live updates (Server-Sent Events).
Starting it starts both views. Run it behind an HTTPS reverse proxy.

### Run it

```bash
python server.py --behind-proxy
```

It listens on `127.0.0.1:8765` (change with `--host` / `--port`). For a quick local test, run `python server.py` (or
double-click **Start Everon Map.cmd**) and open http://localhost:8765/ (the 3D view is http://localhost:8765/3d/).

| Option | Environment variable | Purpose |
|---|---|---|
| `--behind-proxy` | | Read players' real addresses from `X-Forwarded-For` (only trusted from this machine or a private network). Needed for bans and limits to work behind a proxy. |
| `--admin-password` | `EVERON_ADMIN_PASSWORD` | Admin password, 12+ characters. If unset, a random one is printed at each start. Prefer the variable: command lines are visible to other users. |
| `--admin-allow` | `EVERON_ADMIN_ALLOW` | Addresses or networks allowed to open the admin view, comma-separated. Elsewhere it answers "Not found". |
| `--host`, `--port` | | Where to listen (default `127.0.0.1:8765`). |

### Reverse proxy

Serve over **HTTPS**: session tokens travel with every request. The pages call absolute paths (`/api/…`, `/tiles/…`,
`/maptiles/…`, `/data/…`, `/los-worker.js`, `/admin`, and the 3D view at `/3d/…`), so give the site its own domain
or subdomain, or forward all of those (with the field map's own files) to it, the 3D view included. Disable response
buffering so live updates arrive at once. Caddy example:

```
maps.example.com {
    reverse_proxy 127.0.0.1:8765 {
        flush_interval -1
    }
}
```

### Run it as a service (Linux)

```ini
# /etc/systemd/system/everon-map.service
[Service]
User=everon
WorkingDirectory=/opt/everon-map
EnvironmentFile=/etc/everon-map.env
ExecStart=/usr/bin/python3 server.py --behind-proxy
Restart=always

[Install]
WantedBy=multi-user.target
```

To update: pull the repo, copy it over the live folder and restart the service. Keep `bans.json` and `tile_cache/` (both
are untracked on purpose).

### Built-in protection

- **Rate limits** per address on requests and joins (map data, which the 3D view streams as you move, gets the
  same allowance as map tiles).
- **Player caps:** 12 players per address, 60 per room, 1000 in total.
- **Marking caps:** 500 markings and 2 MB per player.
- **Connection caps:** 600 open connections, and a 60 s timeout on stalled requests.
- **Checks on everything shared:** every marking is validated by the server, and pages get a strict
  Content-Security-Policy.
- **Room codes are the only privacy**, so use **New code** rather than a guessable word.

The map data comes from Bohemia Interactive's game; check their content rules before hosting publicly.

## Admin view

Open `/admin` and sign in. It lists every room and its players (address, connection state, markings, briefing),
refreshing every 4 s.

- **Kick**: removes a player and their markings; they can rejoin.
- **Ban 24 h / Ban**: blocks the address (IPv6: its /64). Bans are kept in `bans.json` and survive restarts.
- **Close room**: removes everyone, their markings and the briefing. Removed players see why on the join screen.

Security:
- **Lockouts:** 5 wrong passwords lock an address out for 5 minutes. 30 from all addresses within 15 minutes pause
  sign-in for everyone.
- **Sessions:** they live in page memory only (no cookies), are tied to your address, and end after 30 minutes idle or
  12 hours. At most 10 exist at once.
- **Audit log:** sign-ins, failures, kicks, bans and closed rooms go to the server log. An unknown sign-in means the
  password is out, so change it.

## Data and files

| Path | What |
|---|---|
| `server.py` | Web server, rooms, live updates, admin, Everon tile cache |
| `static/` | The field map (`index.html`, `app.js`, `app.css`), the line-of-sight worker (`los-worker.js`, used by both views) and the admin page |
| `static/3d/` | The 3D view: its page and scripts, and `maps.json` (the maps it offers: size, grid, camera start) |
| `static/data/everon.json` | Everon's bases, supplies, vehicle spawns, caves and FIA cache spots (from the game) |
| `static/data/mortar-tables.json` | The in-game firing tables (used only to decide which rings reach) |
| `static/data/maps/<map>/` | Per map, read by both views: `tiles/` (Kolguyev, Arland), `roads.json`, `places.json`, `los/` (500 m tiles), `light/` (10 m grids), `plants/`, `foliage.json`, `foliage/foliage_profiles.json`, and `trees/` (the 3D view's shaped trees) |

This folder holds only what runs the site. Everything that makes its map data lives in `reforger-map-tools`: it
exports a map from the game, bakes it (`rmt.py bake`), scores the line of sight (`rmt.py check`) and installs the
result for both views (`rmt.py fieldmap <world>`: `static/data/maps/<map>/`, the 3D trees and `static/3d/maps.json`).

- **Everon tiles**: still fetched from an outside tile server and cached in `tile_cache/` (`TILE_UPSTREAM` in
  `server.py`). Kolguyev and Arland tiles are baked in.
- **Positions**: town and landmark names come from the game's map descriptors (`places.json`); caves are approximate.
- **Kolguyev and Arland**: they have no bases, supplies or caches yet.
- **Adding a map**: maps are listed in `MAPS` in both `static/app.js` and `server.py`.

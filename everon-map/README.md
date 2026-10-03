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
| Plan | P | 1 Marker · 2 Route · 3 Ambush · 4 Range line · 5 Elevation profile · 6 Hull-down finder · 7 Overwatch finder · 8 Route planner · 9 Landing zone check · 0 Who can hear it · Rocket launcher shot |
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
- **Rocket launcher shot**: click where you fire from, then the target. Pick the launcher (RPG-7 with PG-7VM, PG-7VL
  or PG-7VR, M72A3 LAW, RPG-22, RPG-75), the RPG-7's sight (iron or PGO-7 scope), your stance and the target, and
  type the wind as the in-game map shows it. The popup gives the sight mark to set, how far above or below the target
  to hold it, the compass bearing to aim on (off the target into or with the wind) and the flight time. On the map, a
  yellow aim line runs from you on that bearing to a crosshair at the aim point, labelled with the bearing, sight mark
  and hold. The popup also draws the **sight picture**: the target (vehicle, standing or prone soldier) at its true
  angular size for the distance, and the sight laid where it has to sit (the front sight's tip, the M72's cross-hair,
  or the PGO-7's reticle with the range line to use), so a hold like "25 m above" shows how far that is against the
  vehicle. With wind, a dashed ring marks where the mark would go in still air and a blue arrow runs to where it goes
  now, with the wind's crosswind and head or tail parts in the corner. The popup also says how far the wind moves the
  hold (sideways and up or down). The PGO-7 reticle is drawn from the game's own; the iron sights are sketches. Any range line gets the same
  with its **Rocket launcher shot** button. See [Rockets](#rockets).
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
  zones (for the shell the mortar in range would fire; see [Mortar](#mortar)), friendlies inside them, and a firing solution from every mortar. Mortar crews clear it with **Mission
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

Place a mortar (F then 9; M252 or 2B14, any shell) and the Mortar panel opens. An outline per charge ring shows how
far it reaches in each direction: further downhill and downwind, shorter uphill and upwind (each is labelled with its
shortest and longest, e.g. "R4 2.92–3.08 km"). Each ring has its own colour (ring 0 yellow, 1 orange, 2 pink, 3 violet,
4 blue) on a dark outline so it shows over any terrain, with a faint fill; the shortest distance any ring fires is the
red disc. The markings follow the **Ring** setting: with a ring set you see just that ring's whole reach, and on Auto
you see the rings Auto would use, as bands (for the M252 HE: ring 0 out to about 410 m, ring 3 to 2.3 km, ring 4 to
3.0 km), each labelled "R3 to 2.28–2.32 km". A band ends where Auto hands over to the next ring, or where its ring
runs out over the ground and wind if that's nearer. A target past the outline says how far the mortar reaches that way.
Click to add targets (up to 30); each gets ring, elevation and azimuth in mils, and flight time, plus where 90% of
rounds land and the shell's kill and danger zones around that. Move the mouse for a live solution. Drag a target to
correct fire.

- **Kill and danger zones** were measured in the game: real shells dropped among the game's riflemen on open ground,
  about 9,000 of them (reforger-map-tools `blasttest.py`). The kill zone reaches as far as a round on the edge of the
  spread downs (kills, or knocks out) half of those standing. The danger zone reaches as far as 1 in 10 is still
  wounded; past it nobody was touched. Lying down shrinks the kill distance. The angle a round comes down at and the
  side of the burst make no difference.

  | Shell | Kill (standing) | Kill (prone) | Danger |
  |---|---|---|---|
  | HE M821 (M252) | 18 m | 13 m | 27 m |
  | HE O-832DU (2B14) | 11 m | 10 m | 16 m |
  | Practice M879 | none | 3 m | 5 m |
  | Smoke M819 | none | 3 m | 5 m |
  | Smoke D-832DU | none | 3 m | 5 m |

  Illumination rounds carry no explosive: a time fuze releases a flare, so they have no zones.

- **Ring**: Auto, or a fixed charge (0-4) saved on the mortar. A fixed ring shows only its own outline and says
  which rings could reach a target it can't. Auto keeps the charge changes down: ring 3 for nearly everything (M252
  HE from about 410 m to 2.3 km, 2B14 HE from 300 m), ring 0 or 1 close in, where ring 3 lands 2-3x wider and flies
  about 30 s, and ring 4 past ring 3's reach. It switches where a lower ring lands at least a third tighter, worked out per shell on flat
  ground in still air so it only changes with distance. A band under 150 m is folded into its neighbour. If the ring
  it picks can't make it up a hill or into the wind, the nearest ring that can is used.
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
- **Resources**: supply stashes, infinite supply points, vehicle spawns, refuel and repair points (Everon only), and
  fuel stations (every map, from the game's map symbols). A layer a map has no data for is not listed.
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
- **Reach comes from the model too:** the tube fires no flatter than 45° (800 mil; the game's mortar prefabs allow
  45-85°), so a ring reaches wherever its 45° shot, in the wind, still passes over the ground on its way down. Each
  100 m the target sits below the mortar adds about 75-85 m of reach (100 m above costs 75-150 m), and 5 m/s of
  tailwind adds about 1.5% (headwind takes it off). The in-game firing tables, which are for flat ground in still air,
  are 1-20 mil off and stop a little short anyway; they only set each ring's shortest distance now.
- **Spread** was measured by firing through the game's real mortars: 400 rounds, every charge ring of both, each
  round's speed and direction recorded as it left the barrel (reforger-map-tools `firetest.py barrel`). Rounds fired
  with the same numbers differ in two ways:
  - **Launch speed** varies ±1.07 m/s (one standard deviation) on the shell's base speed, times the ring's
    multiplier. On average it comes out 0.13 m/s fast, and the aim allows for that.
  - **The barrel** throws each round a little off its direction. It's never more than 10.4 mil, usually much less,
    and it differs by mortar: M252 about 3.1 mil up/down and 4.2 mil sideways; 2B14 3.9 and 2.9.

  Flown by the model from those launches, the rounds land where the game puts them (to 0.25 m). The ellipse held
  87-93% of the measured rounds at every ring and range. Example, M252 ring 3 at 1.3 km: ±76 m long/short, ±39 m
  sideways.

### Rockets

The game flies its rockets natively, so they aren't modelled: they were flown in the game (reforger-map-tools
`rockettest.py`), high over open sea, every frame recorded, and the site reads those flights (`static/data/rockets.json`).

- **Flights:** each rocket at 11 elevations from 12° down to 20° up, in still air three times over (launches repeat
  to about ±2 m in range, ±3 m for the PG-22). In between, flights are blended in their own launch frame (along the
  launch line, drop below it), which keeps the error under a metre.
- **Wind:** flown again in 5 and 10 m/s crosswinds and 10 m/s head and tail winds; the effect grows in step with the
  wind speed, so the site scales it. Motor rockets (PG-7VM, PG-7VL) turn **into** a crosswind while they burn and end
  up upwind (10 m/s across moves a PG-7VM about 14 m upwind by 300-400 m); the others drift with it (an RPG-75 about
  11 m downwind at 3 s). The PG-7VR goes upwind and then back downwind. A headwind costs range, a tailwind adds it.
- **Sights:** the launchers' sight marks (from their prefabs) are the bore's angle above the line of sight; the
  PGO-7's lines were measured off its reticle texture, from the cross at the top, which is the bore. The shot is
  solved from the flights, then the angle it needs is matched to the nearest mark, with a hold for the rest. Against
  the flights the marks are close for the RPG-22, RPG-75 and the M72 (its rocket leaves 0.5° above the bore), and for
  the RPG-7 iron sight with PG-7VM to 300 m; past that it falls short (at 500 m it needs 3.5°, the mark gives 2.8°:
  about 6 m low). On the PGO-7 the PG-7VL's lines aim about 0.4° high.
- **Heights:** the shot goes from your stance's height to the target's (vehicle hull 1 m, standing 1.6 m) over the map's
  ground heights.
- **Checked in the game:** 144 random shots (80 m to 85% of each rocket's reach, 30 m below to 30 m above, eight
  random winds of 6-11.5 m/s) solved by the site and fired with its numbers (`rockettest.py check`). Misses at the
  target were 0.5-1.1 m rms in height and under 0.7 m sideways, most of it launch-to-launch variation; the M72A3 was
  1.6 m rms, worst 6 m (528 m out, near the end of its flight).
- **Not counted:** the launcher's own aim wobble, and anything in the way (check the line of sight under it).

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

For a production update, build the serving files before deployment:

```bash
python build_release.py --output dist/everon-map.tar.gz
```

The archive contains `server.py` and the static assets, with large text files already gzipped. It excludes Git
history, tests, development tools, bans, and tile caches. Extract it into the live folder and restart the service.
Keep the live `bans.json` and `tile_cache/`. Build and bake map data outside the 1 GB serving container.

Run production from a separate directory containing the extracted release, rather than from a Git checkout. Upload
the archive instead of cloning or copying the repository onto the serving machine. Extraction does not remove an
existing `.git` directory: if the current service runs from a checkout, point it at a separate release directory,
preserving its live bans and tile cache. Keep Git history on the development/build machine. The builder excludes
`.git` directories and worktree pointer files even if they have been accidentally copied inside the static assets.

The server streams files in 64 KiB chunks. When running directly from a checkout, it lazily compresses text into
`compressed_cache/`, with only one compression running at a time. It keeps small cache metadata in RAM rather than
entire compressed files. This disposable directory can be cleared while the server is stopped; production archives
already include compressed text, so they normally do not need it.

For a 1 GB host with approximately 350 MB whole-server idle usage, start with 200–300 simultaneous map sessions
and measure a burst of joins and asset downloads. Ordinary use may fit 300–500 sessions, but CPU, bandwidth and
the 600-connection cap can bind before RAM. Initial room snapshots share their data and only two are sent at a
time. Slow streams are disconnected when their update backlog reaches 256 KiB and reconnect to resync. Whole-host
startup memory also includes deployment jobs and filesystem cache; local Python startup measurements do not establish
the cause of a host's 800 MB peak.

### Built-in protection

- **Rate limits** per address on requests and joins (map data, which the 3D view streams as you move, gets the
  same allowance as map tiles).
- **Player caps:** 12 players per address, 60 per room, 1000 in total.
- **Marking caps:** 500 markings and 500 KB per player, 2 MB per room and 16 MB across the server, measured as
  serialized JSON. Parsed objects use more RAM. When a limit is reached, new edits are rejected with a message;
  existing markings are retained. Import stops on the first failed save and reports the number actually saved.
- **Connection caps:** 600 open connections, and a 60 s timeout on stalled requests.
- **Stream caps:** two event streams per session; a backlog is limited to 1,000 events and 256 KiB, excluding
  the shared initial snapshot. A reconnect gets a new room snapshot.
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
| `static/data/rockets.json` | Measured rocket flights, wind effects and the launchers' sight marks (reforger-map-tools `rockettest.py score`) |
| `static/data/maps/<map>/` | Per map, read by both views: `tiles/` (Kolguyev, Arland), `roads.json`, `places.json`, `los/` (500 m tiles), `light/` (10 m grids), `plants/`, `foliage.json`, `foliage/foliage_profiles.json`, and `trees/` (the 3D view's shaped trees) |

This folder holds only what runs the site. Everything that makes its map data lives in `reforger-map-tools`: it
exports a map from the game, bakes it (`rmt.py bake`), scores the line of sight (`rmt.py check`) and installs the
result for both views (`rmt.py fieldmap <world>`: `static/data/maps/<map>/`, the 3D trees and `static/3d/maps.json`).

- **Everon tiles**: still fetched from an outside tile server and cached in `tile_cache/` (`TILE_UPSTREAM` in
  `server.py`). Kolguyev and Arland tiles are baked in.
- **Positions**: town and landmark names come from the game's map descriptors (`places.json`); caves are approximate.
- **Kolguyev and Arland**: they have no bases, supplies, vehicle spawns or caches yet, so those layers and the FIA
  section are hidden there. They need exporting from the game's Conflict scenarios (not done by reforger-map-tools yet).
- **Adding a map**: maps are listed in `MAPS` in both `static/app.js` and `server.py`.

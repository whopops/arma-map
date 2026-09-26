# Everon Field Map (ChatGPT Sites version)

A shared tactical map of Everon (Arma Reforger) for planning with your squad.

This is the same map as the original version (`everon-map/` on the `main` branch), rebuilt to run on
**ChatGPT Sites**. Everything the original does still works: live shared rooms, all the tools, briefings and the
admin view. Only the server part changed. ChatGPT Sites can't run Python, so the Python server (`server.py`) is
rewritten in JavaScript for the platform ChatGPT Sites uses (Cloudflare Workers, with a D1 database).

## Putting it on ChatGPT Sites

1. **Get the folder to ChatGPT.** Upload this whole `everon-map-sites` folder (zipped) in a ChatGPT chat with Sites,
   or point it at this GitHub branch (`claude/kind-sagan-5dzxnu`) if your ChatGPT can read GitHub. Leave out
   `node_modules` and `.wrangler` if they exist; they're only for testing on a PC.
2. **Paste the message below** so ChatGPT publishes the site as it is instead of rebuilding it.
3. **Set the admin password.** In the site's settings, add a secret named `EVERON_ADMIN_PASSWORD` with a long random
   password (at least 12 characters). Without it the map works but the admin view stays switched off.
4. **Publish** with "Anyone on the internet" access if friends outside your ChatGPT workspace need to join.

### Message to paste into ChatGPT

> Publish this project as a ChatGPT Site without rewriting it. It is already a Cloudflare Worker project built for
> the Sites runtime:
>
> - `src/worker.js` is the Worker entry point (an ES module with a default `fetch` handler). `src/validate.js` and
>   `src/net.js` are its helper modules.
> - `public/` holds the static files. They are served through the Worker's `ASSETS` binding: every request must reach
>   the Worker first (`run_worker_first: true` in `wrangler.jsonc`), because the Worker locks down the admin page and
>   adds security headers.
> - It needs a D1 database bound as `DB`. The Worker creates its own tables on first use (`schema.sql` has the same
>   statements if you prefer to run them).
> - An R2 bucket bound as `TILES` is optional. It keeps map tiles fetched from reforger.recoil.org that aren't in
>   `public/tiles/`. Without it the site still works.
> - Settings: a secret `EVERON_ADMIN_PASSWORD` (12+ characters) turns on the admin view at `/admin`. An optional
>   `EVERON_ADMIN_ALLOW` (comma-separated IPs or CIDR networks) limits who can reach it.
> - There are no WebSockets, Server-Sent Events or background jobs. Browsers poll `GET /api/events` about once a second
>   from `public/live-worker.js`.
>
> Please keep the code, file layout and API as they are. Only change configuration if the Sites runtime needs it. If
> `public/tiles/` (about 5,900 small JPEGs, 166 MB) is over a file limit, remove that folder: the Worker then fetches
> tiles from upstream instead.

## What's different from the original

| | Original (`server.py`) | This version |
|---|---|---|
| Runs on | Your PC, with Python | ChatGPT Sites (Cloudflare Workers) |
| Live updates | One open connection per player (Server-Sent Events) | Each browser checks in about once a second |
| Players, markings, briefings | Server memory | The site's D1 database, deleted when players leave, as before |
| Bans | `bans.json` | The site's database |
| Map tiles | Downloaded on demand, cached in `tile_cache/` | The same cached tiles ship in `public/tiles/`; missing ones are fetched and kept in R2 if it's set up |
| Admin password | `--admin-password` or `EVERON_ADMIN_PASSWORD`, else a random one printed at start | The `EVERON_ADMIN_PASSWORD` secret (12+ characters); no secret means no admin view |
| Admin allow-list | `--admin-allow` / `EVERON_ADMIN_ALLOW` | The `EVERON_ADMIN_ALLOW` setting |
| Players' addresses | Socket address, or `X-Forwarded-For` with `--behind-proxy` | From the platform (`CF-Connecting-IP`), which browsers can't fake; `--behind-proxy` isn't needed |
| Admin audit log | The server window | The site's logs |
| HTTPS | Up to you (reverse proxy) | Provided by ChatGPT Sites |

A few things work slightly differently:

- **Updates take up to a second** to reach other players, where the original was instant. The check-ins run in a
  background worker (`public/live-worker.js`), so a tab in the background keeps its place on the map.
- **Request rate limits are counted per running copy of the site.** The platform can run several copies at once, so a
  determined spammer gets a little more through. The limits that matter are kept in the database and hold across
  copies: players per address, per room and in total, markings per player, admin lockouts and bans.
- The original's limits on open connections and stalled requests are handled by the platform.
- The forest-estimate builder (`tools/build_forest.py`) stays in the original version. It needs Python and only has to
  run once; the output (`public/data/everon-forest.bin`) is already included.

## Testing it on a PC (optional)

Needs [Node.js](https://nodejs.org/) 20 or newer. In this folder:

```
npm install
echo EVERON_ADMIN_PASSWORD="local-test-password-123" > .dev.vars
npm run dev
```

Then open http://localhost:8787/ (and http://localhost:8787/admin). This runs the same Worker with a local database.
With it running, `npm test` in a second window checks joining, sharing, every moderation action, the limits and
the admin sign-in against it (`SLOW=1 npm test` also waits out the 15-second disconnect timeout).

## Admin view

Open `/admin` on your site to see every active room, who is in it (IP address, connected or away, when they joined,
how many markings they have) and whether the room has a briefing. It refreshes every 4 seconds.

- **Kick** removes a player and their markings; they can rejoin straight away.
- **Ban 24 h** / **Ban** block the player's IP address for 24 hours or until you lift it. Everyone connected from that
  address is removed (in any room) and can't join again. Bans are listed under "Banned addresses" with a "Lift ban"
  button, and are kept in the site's database. People on the same network share an address, so a ban hits all of
  them. An IPv6 player is banned by their whole `/64` (the block one home or phone gets), since they can switch to any
  address inside it.
- **Close room** removes everyone in a room, with their markings and the briefing.
- Removed players see why on the join screen ("You were removed…", "The admin closed this room", or how long a ban has
  left).

### Keeping the admin view safe

- **Password**: the `EVERON_ADMIN_PASSWORD` secret, at least 12 characters, or the admin view stays off. Only hashes
  are compared, and the password never reaches the browser.
- **Limit where it can be used** (recommended): set `EVERON_ADMIN_ALLOW` to your home IP, or to several addresses and
  networks separated by commas (e.g. `203.0.113.7, 2001:db8::/48`). From anywhere else `/admin` and its API answer
  "Not found", even to the right password.
- **Guessing gets nowhere**: 5 wrong passwords lock that address (or IPv6 /64) out for 5 minutes, and 30 wrong
  passwords from all addresses together within 15 minutes pause sign-in for everyone until the 15 minutes are up. An
  admin already signed in carries on.
- **Sessions**: signing in gives the page a token kept only in that page's memory (nothing in cookies or storage). It
  only works from the address that signed in, ends after 30 minutes with the page closed or 12 hours in all, and ends
  at once when you sign out or close the tab. At most 10 sessions exist at a time. Only a hash of each token is stored.
- **Audit log**: sign-ins, sign-outs, wrong passwords, lockouts, kicks, bans, lifted bans and closed rooms are written
  to the site's logs with the time and the admin's address. A "signed in" line you don't recognise means the password
  is out: change the secret.
- There's no way to sign in with cookies, so another website can't make your browser act as the admin, and the admin
  page can't be shown inside another site.

### Protection built in

- Per-address rate limits on requests and joins, at most 12 players per address, 60 per room and 1000 in all, and
  500 markings and 2 MB per player.
- Pages are sent with a strict Content-Security-Policy (only the site's own scripts run; no framing by other sites),
  and every marking is checked by the server before it's shared.
- The room code is the only thing that keeps a room private: anyone who has it can join and see everything. Use the
  **New code** button (12 million possible codes) rather than something guessable like "alpha".

## Files

- `src/worker.js`: the server: rooms, players, markings, briefings, admin view, bans, tiles and static files
- `src/validate.js`: the checks every marking passes before it's shared (the same rules as the original)
- `src/net.js`: IP address handling for bans, limits and the admin allow-list
- `public/`: the map itself (unchanged from the original apart from `live-worker.js` and how `app.js` receives updates)
- `public/tiles/`: the map tiles the original had cached
- `schema.sql`: the database tables (created automatically; for reference)
- `wrangler.jsonc`, `package.json`: Cloudflare Workers settings and the local testing tools
- `test/smoke.mjs`: the end-to-end test

## Map

- Everon satellite map with a 1 km / 100 m grid and grid labels
- Live cursor readout: 6- and 8-digit grid plus exact X/Z metres
- Right-click anywhere for that spot's grid reference

**Reference layers** (Map layers section; toggle each one)
- Towns: all 34 named settlements
- Landmarks: 136 hills, ridges, valleys, bays, lakes, islands, ruins and points of interest
- Caves & hideouts: 11 community-reported caves, bunkers and camp spots (approximate 100 m squares)
- Conflict: 39 bases, capture and control points and radio towers, colour-coded by type, plus 25 HQ start positions
- Click any Conflict point for switches that draw its **cap zone** (50 m, yellow), **build zone** (100 m, dashed blue)
  and **radio range** (2 km for bases, 3 km for radio towers, dotted purple). The popup also lists every point linked to
  it by radio. Only you see these circles, and they hide with the Conflict layer.
- **Radio network** layer: lines between every pair of Conflict points that can reach each other by radio. Solid white
  means both are in range of each other; dashed cyan means only the radio tower's longer 3 km range reaches. In Conflict
  you can only capture points connected to your radio network, so this shows how you can advance.
- **Forest (estimate)** layer: where the trees are, worked out from the satellite imagery (dark or dark-and-textured
  10 m squares on land), outlined in green with a light hatch. About 23% of the land. Tree shadows on grass can count as
  forest and single trees or thin hedgerows are usually missed, so check it against the map. Line of sight treats it
  as 8 m tall trees. It can be rebuilt with `tools/build_forest.py` in the original version (needs Python, Pillow and numpy).
- **Helicopter landing** layer: shades the map green (good), amber (marginal) and red (no-go) for landing, from the
  slope and tree cover around each 10 m spot. It also shows whenever the Landing zone check tool is active.
- **Hill shading** layer: lights the terrain from the north-west so ridges, valleys and dead ground stand out.
- **Contour lines** layer: elevation lines drawn from the terrain heightmap (every 50 m zoomed out, 20 m mid-zoom, 10 m
  zoomed in, with every fifth line brighter). While it's on, the grid readout also shows the ground height under the cursor.
- Supplies (185, with amount and foot/vehicle access), vehicle spawns (172), refuel (19), repair (8), FIA hidden caches (25)

## Toolbar

**Select** (Q) is the normal mode: click anything for details, and drag your own markings to move them. The other tools
sit in six colour-coded menus. Press a menu's letter to open it, then the number next to a tool
(for example **E then 1** is a contact report). Esc goes back to Select, and **Ctrl+K** finds any tool by name.
Dragging with the **middle mouse button** pans the map whatever tool is active.

| Menu | Key | Tools (number in the menu) |
|---|---|---|
| **Friendly** (blue) | F | 1 My position · 2 Infantry · 3 Armour · 4 Advance arrow · 5 Rally point · 6 Objective · 7 Radio backpack · 8 AA gun · 9 Mortar |
| **Enemy** (red) | E | 1 Contact report · 2 Infantry · 3 Armour · 4 Sniper · 5 Enemy roadblock / ambush · 6 Enemy in area · 7 Approach arrow · 8 Patrol route · 9 Enemy line of sight · 0 AA gun |
| **Plan** (green) | P | 1 Marker · 2 Route · 3 Ambush · 4 Range line · 5 Overwatch finder · 6 Route planner · 7 Landing zone check |
| **Support** (orange) | S | 1 Fire support request · 2 Gun run (CAS) · 3 Medevac · 4 Pickup / insertion · 5 Resupply drop |
| **Defend** (khaki) | D | 1 Target reference point (TRP) · 2 Sectors of fire · 3 MG nest · 4 Bunker · 5 Sandbags · 6 Barbed wire · 7 Checkpoint · 8 Roadblock |
| **Hazards** (amber) | H | 1 AT minefield · 2 AP minefield · 3 Blocked or mined road · 4 Bridge out |

Some tools show options under the toolbar; pick them with the mouse or the number keys while the tool is active.
Drawn tools (routes, arrows, sandbags, wire) take a click per point: Backspace undoes a point, and Enter,
Esc, double-click or right-click finishes.

**Friendly**
- My position: one per player, in blue with a white border and your name under it; clicking again moves it. It carries a
  range card (rings and line of sight): pick its reach in the options (Off, 400 m, 800 m or 1.5 km); changing it
  updates your marker straight away. Pick Infantry or Armour in the options too: armour shows the armour symbol and
  its range card sees from a vehicle's sights (2 m up, trees within 15 m ignored). Players with a position show a
  symbol in the Players list; click them to jump to it. Players whose position has a range card also get an eye
  button there: click it to hide or show that player's line of sight on your map only, so you can check who sees what.
- Infantry: a NATO-style symbol (a blue rectangle with an X; the enemy's are red diamonds). The options set when new
  ones time out: never, 5, 15 or 30 minutes. They fade after a third of that time and disappear for everyone at the
  end; edit one to change its timeout (counted from then).
- Armour: the armour symbol (a blue rectangle with an oval). Its options set its line of sight: Off for just the
  symbol, or a reach (400 m, 800 m or 1.5 km) to show what the vehicle sees from its sights 2 m up, in blue with range
  rings (trees within 15 m ignored). With line of sight it works like your position's range card: its seen and hidden
  ground joins the squad's combined shading, and TRPs measure distance and bearing from it.
- Advance arrow: a solid blue arrow; the arrowhead goes on the last point.
- Rally point and Objective: a flag or star in your colour, named in the editor ("Rally point 1", "Objective 1").
- Radio backpack: marks where a radio backpack is set up to spawn on. Players can only spawn on it while no enemy is
  within 50 m, so it can show that 50 m circle: pick Show or Hide in the options before placing, or use the button in
  its popup. If a marked enemy (a unit, contact, sniper or enemy-in-area shape) is inside the circle, the backpack, its
  circle and its label turn red ("spawn blocked") and the popup says who and how far away.
- AA gun: a blue AA marker for a friendly anti-air gun (no line of sight).
- Mortar (F then 9): click to place your mortar (M252 US or 2B14 Soviet, any shell type); the Mortar section opens. Dashed circles
  show each ring's maximum reach and a red circle the minimum range. Move the mouse for a live firing solution and click
  to add targets (up to 30). Each target shows the recommended ring (the lowest that reaches, with the tightest spread),
  elevation in mils corrected for the height difference, azimuth in degrees and mils (6400 for M252, 6000 for 2B14) and
  flight time; its details list every ring that can reach it.
  Each target also shows where the rounds will land, the same way as a fire support pin: with an HE shell, a shaded
  red kill zone the size of the ring's spread and a dashed danger zone 20 m further out; with smoke, illumination or
  practice rounds, just the spread. The circles show while you aim too. A target's popup and its entry in the Mortar
  section give the kill and danger zone sizes and warn about any friendlies inside the danger zone.

**Enemy**
- Contact report: click where you saw the enemy and fill in the optional report: how many, what they're doing, heading
  (drawn as an arrow) and what they're carrying. It pulses for the first minute and times out like unit markers
  (15 minutes unless you pick another time), with its age shown next to it.
- Infantry, Armour and Sniper: one click drops the symbol. Infantry and Armour time out like friendly units.
- Enemy roadblock / ambush: a red diamond where the enemy has set up a roadblock or ambush. It counts as an enemy
  position everywhere: route exposure (watching 800 m round like enemy soldiers), the route planner's keep-out
  distances, and it blocks a radio backpack within 50 m.
- Enemy in area: hold the mouse button (or your finger) and circle where the enemy is; let go and the shape closes itself.
  It's shaded red, and its popup shows the size and perimeter. Left-drag draws instead of panning while this tool is
  active; pan with the middle mouse button and zoom with the wheel.
- Approach arrow (dashed red) and Patrol route (orange, with chevrons showing the direction of travel).
- Enemy line of sight: pick Soldier or Vehicle and a reach in the options, then click where the enemy is watching
  from. Ground a crouched soldier (eyes 1 m up) or a vehicle's sights (2 m up) can see from there is shaded red, and
  yellow where only trees are in the way; keep out of both.
- AA gun (E then 0): click where the gun is, move the mouse to aim and click. It covers 160° out to 1.5 km. Red shows
  where it can see a helicopter flying at the height picked in the options (30, 100 or 200 m above the ground; 100 m
  unless you change it), yellow only through trees; unshaded ground inside the arc is hidden by terrain or more than
  50 m of trees. It stands for the stock game's mounted heavy machine guns (M2 Browning, DShKM): they can aim from
  -10° to +70° (the DShKM tripod's limit in earlier Arma games; not confirmed for Reforger), and a gun inside a wood
  can't see up through the canopy over it.

**Plan**
- Marker: a point with a label, a note, a colour and a type: point, objective, rally point or danger (an amber "!"
  for anything else to watch out for).
- Route: its popup has a route check: time on foot (a jog, slowed by slopes) and by vehicle (40 km/h), the
  height climbed and descended, a height profile, the steepest stretch and each leg's distance and bearing. It also
  shows where marked enemies can see the route: red on the map where they see it clearly, yellow only through trees,
  listed by distance along the route with who sees it. It flags enemy-in-area shapes the route goes through and minefields,
  blocked roads, bridges out and dangers within 30 m. Enemy line-of-sight markings use their own reach; other enemy
  markings (infantry, contacts, enemy markers) are assumed to watch all round from a crouch out to 800 m, a sniper to
  1.2 km and armour from 2 m up to 1.5 km. Contacts and units that have timed out stop counting.
- Ambush: pick Linear or L-shaped, click both ends of the kill zone along the road, then the side your squad waits on.
  It draws the kill zone, the support (MG) group, the assault group, fire arrows and a lookout on each flank. Drag the
  middle handle to move your ambush or the end handles to stretch or turn it; "Flip side" in its popup swaps the side.
- Range line: click a start point, then a target; the line is labelled with distance and bearing for everyone.
- Overwatch finder: pick how far out to look (400 m, 800 m or 1.5 km) and click an objective. Ground from which a
  crouched observer can see a standing soldier on the objective is tinted in your colour (yellow if only through
  trees); ground that can't see it is left unshaded. The popup gives the share of ground with a clear view, the
  closest clear spot at least 150 m out and the highest one, with their grids and height above the objective.
- Route planner: pick Foot or Air in the options, then click a start and an end.
  - Foot (any distance; long routes take a few seconds to plan): the quickest way at a jog. Arma Reforger's run is about 3.33 m/s on the flat (100 m in 30 s, timed in game); slopes slow it
    (every 10% of uphill grade costs 15% more time; downhill is full speed up to 30%, then slows the same way;
    measured along the direction of travel, so going round a hillside counts as flat), and slopes over 60° can't be
    crossed. The uphill cost is an estimate: time a 100 m climb in game to tune it. It keeps out of sight of marked enemies (seen ground
    costs ten times as much, seen through trees two and a half times), keeps 300 m from marked soldiers, contacts and
    snipers, 500 m from armour and AA guns and 100 m from enemy-in-area shapes (it only goes closer if there's no
    other way), and stays off the sea and 15-25 m from minefields. The popup compares it with going straight across.
    "Save as route" shares it; a saved foot route re-plans itself on its owner's page whenever enemy markings are added,
    moved or time out. The slope curve and jog speed are estimates; the 10 m heightmap smooths out short cliffs and banks.
  - Air: pick the helicopter's height (30, 100 or 200 m) and click a start and an end; both snap to a
    nearby landing zone, medevac or pickup. It plans across the whole island and keeps a wide berth of marked enemies:
    300 m from AA guns plus everywhere they can see the helicopter, 1 km from armour and enemy vehicles, 600 m from
    soldiers and contacts, 500 m from enemy-in-area shapes. The popup gives distance, flight time at 180 km/h, how long
    the AA could see it and how close it passes each enemy, compared with flying straight. "Save as flight route" shares
    it as a dashed sky-blue arrow.

- Landing zone check: move over the map for a live verdict under the toolbar, and click to mark an LZ. It is Good,
  Marginal or No-go from the slope of a 40 m circle (over 12° marginal, over 17° no-go), trees on or near it, and which
  of eight directions a helicopter can come in from on a 10° descent over trees and high ground (drawn as ticks).
  If it isn't good, its popup suggests the nearest good spot within 150 m and can move it there. Buildings, fences,
  power lines and wrecks aren't in the data.
  The Helicopter landing shading shows the whole map's good, marginal and no-go ground while this tool is active.

**Support**
- Fire support request: pick Area or Point, and HE, Smoke or Illumination, in the options (keys 1-5).
  - Area: hold the mouse button and circle where you want the fire; let go and it closes itself, like Enemy in area.
  - Point: click to drop a pin where you want the rounds to land. An HE pin gets a shaded red kill zone the size of the
    mortar's spread (rounds land within it: the range table's average dispersion for the ring it would use, e.g. about
    24 m on ring 2 with the M252's M821) and a dashed danger zone 20 m further out, since each round kills within
    about 20 m of where it lands. Smoke and illumination pins show only the spread. The circles are sized for your
    mortar if it can reach, otherwise the nearest mortar that can; with no mortar in range only a 20 m circle is drawn.
  The popup shows the aim point (a 10 m grid), the size, how long ago it was asked for, any friendly positions, units,
  radios or weapons inside the danger zone (for HE), and a firing solution from every mortar on the map using that
  mortar's shell of the requested type. If you have a mortar, "Add as a target on my mortar" adds the aim point to it.
  Once your mortar is down, every request is solved for it automatically: the Mortar section lists them (ring, elevation,
  azimuth, shell and flight time; + adds one to your targets), each request's label on the map carries your solution,
  and a message pops up with the solution when someone else asks for fire.
- Gun run (CAS), Medevac, Pickup / insertion and Resupply drop: click where it's needed (a gun run can also be an
  area: pick Area in the options and circle the target, like a fire support request). A gun run is sent at once as
  "CAS 1", "CAS 2"… with no form, since there's rarely time; add the target and attack direction later with Edit.
  The others open a short form first (casualties, urgency, whether the pickup zone is secure and how it's marked;
  task and seats; what's needed). Everyone gets a message when a request is made. Anyone in the room can mark it Acknowledged,
  En route or Complete from its popup, and the person who asked is told. Medevac and pickup requests show the landing
  zone check for their spot; a gun run warns about friendlies within 100 m of the target (danger close).

**Defend**
- Target reference point (TRP): "TRP 1", "TRP 2" and so on, numbered across the squad and named in the editor
  (e.g. "TRP 1 – barn"). Its label shows the distance and bearing from the nearest range card (a player's position with a range card, or
  friendly armour with line of sight); its popup lists them from every one and whether each can see it. Their popups list every
  TRP the same way. Several range cards combine: cyan ground is seen by at least one, and **dark ground inside their
  reach is hidden from all of them**, which is where an enemy can creep up.
- Sectors of fire: pick 3, 4, 6 or 8 sectors, click the centre of your position, then move to set the size and
  rotation and click. The editor opens so you can name who covers each lettered sector.
- MG nest: click to place, move the mouse to aim, click again. The width of the field of fire (30°, 60°, 90° or 120°)
  and how high the nest is raised (e.g. on a roof or tower) are in the options. The wedge shows line of sight live while
  you aim: ground the gun can see is tinted in your colour and dead ground is darkened, with the share it can see.
- Bunker, Checkpoint: one click drops the symbol. Sandbags (a khaki line of bags), Barbed wire (a tan line with cross
  marks) and Roadblock (a grey line of tank traps) are drawn point by point.

**Hazards**
- AT minefield (red, with a 10 m kill radius) and AP minefield (amber).
- Blocked or mined road, Bridge out: one click drops the symbol.

All line of sight uses the terrain heightmap plus the Forest estimate, with trees 8 m tall. What counts is how far a
sight line runs through the woods (below the treetops): up to 50 m of trees and the ground is shaded **yellow**
("through trees", since you can often still see through a thin belt); more than 50 m hides it completely, like
the land does. Trees within 35 m of a soldier (15 m of a vehicle) don't count, so someone inside or at the edge of
a wood can see out; AA guns get no such allowance. TRP tables say Yes, Trees or No. Buildings aren't included. The mortar calculator uses the bare terrain and is
not affected. "Line-of-sight shading" under Map layers turns the shading on or off.

## Sidebar

One scrolling column of sections. Click a section's heading to open or close it; which ones are closed is remembered
in your browser. Mortar and FIA caches start closed; the Mortar section opens by itself when you pick the mortar tool.

- **Players**: who's in the room (click a player with a position to jump to it) and the switch for showing other
  players' markings.
- **Briefing**: the shared briefing. A dot on its heading means it changed while the section was closed.
- **My markings**: everything you've put on the map, grouped in toolbar order (each group has its menu's colour),
  plus Export plan and Import plan.
- **Mortar**: weapon and shell, your mortar's position and a firing solution for every target. An orange number on
  its heading counts the fire requests waiting.
- **FIA caches this game**: the caches marked this game, and switches for showing them and every possible spot.
- **Map layers**: places, conflict bases, terrain, planning overlays (line-of-sight shading and helicopter landing
  ground) and resources.
- The search box finds towns, landmarks, bases, caches, caves and everyone's markings (accents ignored).

## Multiplayer
- Everyone enters a username and a **room code** each visit; nothing is remembered in the browser. Only people who use the
  same room code see each other and each other's markings, so several squads can share one site. "New code" makes up
  a random one, and "Copy invite link" in the sidebar gives a link that fills the code in (it sits after the `#` in the
  address, so it isn't sent to the server). A room disappears when its last player leaves.
- **Briefing**: one shared text per room that anyone can write or edit, e.g. the plan, radio channels, rally points and
  who does what. "Insert template" adds a standard layout; lines starting with a heading such as `MISSION:` are
  highlighted. Everyone sees saves straight away, and you're warned if someone else saves while you're editing.
- Your markings are stored under your username and appear live for everyone in the room
- "Show other players' markings" toggles everyone else's layer on or off
- Closing your tab removes your markings; if a browser crashes or disconnects they expire within about 15-20 seconds
- The player list shows who's online and how many markings each has

## FIA caches this game
- Type the coordinates you were given in the "FIA caches this game" section. It accepts a 6-digit grid (`089 028`),
  an 8-digit grid (`0890 0281`) or X/Z metres (`8908 2811`).
- The entry snaps to the nearest of the 25 known cache spots and shows up for everyone as a pulsing pink marker.
  If the nearest spot is over 400 m away, you get a warning to double-check the coordinates.
- You can also turn on "Show all possible cache spots" in that section, click any spot and choose "Mark as this game's cache".
- The same cache can't be marked twice. Like other markings, your marks disappear when you close the tab.

## Saving a plan
- Export your markings to a JSON plan file and import it later, which is the only way to keep a plan between sessions

## Data sources

- POIs (bases, supplies, vehicles, refuel, repair, FIA caches, HQ starts) are extracted from the game
  via [reforger.recoil.org](https://reforger.recoil.org/everon/) / [EnfusionMapMaker](https://github.com/nickludlam/EnfusionMapMaker)
- Place names come from [iZurvive](https://www.izurvive.com/reforger_everon/), fitted to game coordinates (typically within ~100 m)
- Caves and hideouts come from a community Game Master camp-location guide, so they're approximate
- Terrain heights: Everon heightmap (10 m grid) from [mortards.net](https://mortards.net/), checked against the game's
  radio-tower positions to within 1.5 m
- Mortar firing tables: in-game M252 / 2B14 tables from
  [147888sf/ArmA-Reforger-mortar-calculator](https://github.com/147888sf/ArmA-Reforger-mortar-calculator)
- Map tiles come from reforger.recoil.org. The ones the original had cached ship with the site in `public/tiles/`,
  and missing ones are fetched from there (and kept in R2 if it's set up), so the site relies on their server as
  little as possible.

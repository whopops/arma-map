hosted on https://7xr.nl/

this is 100% pure vibecode but everything seems to work pretty good idc what anyone does with this if anything i just wanted it. you should be able to add what ever modded stuff you want with the reforger-map-tools repo. i would just point an LLM at this if you want to change anything its got notes and stuff for them to pickup pretty quick.

im not fixing the folder in a folder.

# arma-map

**Arma Reforger Maps**: a shared, browser-based tactical map for Arma Reforger squads. It covers Everon, Kolguyev and
Arland, with game-measured line of sight, mortar solutions, sound ranges, route planning and live markings shared by
room code, and a 3D view of the same maps and markings.

Everything lives in [`arma-map/`](arma-map/). Its [README](arma-map/README.md) covers using the map, how the
numbers are worked out, hosting it on a website, and the admin view. This repo holds only what runs the site; the
tooling that exports and bakes the map data lives in `reforger-map-tools`.

Quick local test (Python 3.9+, no other dependencies):

```bash
python arma-map/server.py
```

Then open http://localhost:8765/ for the map, or http://localhost:8765/3d/ for the 3D view (one server runs both).

Run checks from the repository root:

```bash
python -B arma-map/test_server.py
node arma-map/test_client.cjs
```

See [agent instructions](AGENTS.md), [project notes](arma-map/PROJECT_NOTES.md),
and [browser checks](arma-map/BROWSER_TESTS.md).

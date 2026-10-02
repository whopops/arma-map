# arma-map

**Arma Reforger Maps**: a shared, browser-based tactical map for Arma Reforger squads. It covers Everon, Kolguyev and
Arland, with game-measured line of sight, mortar solutions, sound ranges, route planning and live markings shared by
room code, and a 3D view of the same maps and markings.

Everything lives in [`everon-map/`](everon-map/). Its [README](everon-map/README.md) covers using the map, how the
numbers are worked out, hosting it on a website, and the admin view. This repo holds only what runs the site; the
tooling that exports and bakes the map data lives in `reforger-map-tools`.

Quick local test (Python 3.9+, no other dependencies):

```bash
python everon-map/server.py
```

Then open http://localhost:8765/ for the map, or http://localhost:8765/3d/ for the 3D view (one server runs both).

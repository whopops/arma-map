# arma-map

**Arma Reforger Maps**: a shared, browser-based tactical map for Arma Reforger squads. It covers Everon, Kolguyev and
Arland, with game-measured line of sight, mortar solutions, sound ranges, route planning and live markings shared by
room code.

Everything lives in [`everon-map/`](everon-map/). Its [README](everon-map/README.md) covers using the map, how the
numbers are worked out, hosting it on a website, and the admin view.

Quick local test (Python 3.9+, no other dependencies):

```bash
python everon-map/server.py
```

Then open http://localhost:8765/.

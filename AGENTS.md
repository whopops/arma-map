# Agent instructions

- Application: `arma-map/`. Read [project notes](arma-map/PROJECT_NOTES.md) for architecture and
  [README](arma-map/README.md) for behavior. Plain browser JS and a Python 3.9+ standard-library server; no build step.
- Run from the repo root: `python arma-map/server.py --port 8765`. Files resolve relative to `server.py`.
- Check relevant changes with `python -B arma-map/test_server.py`, `node arma-map/test_client.cjs`, and
  `node --check` for changed scripts. Follow [browser checks](arma-map/BROWSER_TESTS.md) for UI changes using
  `python -B arma-map/test_browser_server.py`; use disposable localhost rooms, not other users' live rooms.
- Preserve shared engines: `static/3d/mortar.js`, `static/shot-core.js`, `static/plan-sync.js`,
  `static/room-events.js`, and the construction catalog/factory. New marking fields must pass server validation.
- Retain session-scoped backups, deletion tombstones and per-item write ordering. 3D sessions are read-only observers.
  Room codes/names are the intended access model; do not add owner recovery credentials unless requested.
- Baked map/ballistics data comes from the separate `reforger-map-tools` project. Do not hand-edit generated data
  or modify that external project as part of an application change.
- Keep docs consistent with behavior. `static/landing/index.html` is the sole landing-page source; its scripts
  must work under the strict CSP.
- Never commit credentials, runtime rooms/bans, logs or caches. Production pulls directly from GitHub; do not
  create deployment archives/backups or deploy unless requested. Update server and static files together on deployment.

# Browser smoke checks

Run `python -B test_browser_server.py`, then open `http://127.0.0.1:8767/__test__/` and the tactical map in
separate tabs. This server uses temporary room and ban state and binds only to localhost. Its control page and
test fixtures are outside `static/` and are not served by the production server. Reload pages after editing scripts.
Commands here assume the application directory `arma-map/`; from the repository root prefix script paths with
`arma-map/`. The control page also exposes `/__test__/rooms` for inspecting disposable room state.

## Failed restoration and recovery

1. Join the tactical map as `RestoreTest` in `restore-smoke`. Leave **Keep** off.
2. Import `test_fixtures/restore-plan.json`. Wait until **My markings** shows both **Backup first** and **Backup second**.
3. On the control page click **Fail uploads (503)** and wait for **Marking uploads fail with 503**.
4. Reload the tactical map. After the bounded upload retries (up to 20 attempts, one second between temporary
   failures), it should show a warning that the browser backup is kept. The room has no markings,
   because uploads failed; this must not erase the backup.
5. Switch through Shot planner, Base planning and Mortar with the operations bar. Each should show the same
   incomplete-restore warning. Reload one of these pages while failures remain enabled.
6. Click **Allow uploads** on the control page and wait for **Marking uploads succeed**. Return to the tactical map.
   Both original markings must return with their labels and coordinates intact.
7. Delete one of these test markings, reload, and verify that it stays deleted. Join under a different name and
   verify that the old owner's markings are not restored as yours.

## Mortar integration

1. With uploads enabled, import `test_fixtures/browser-plan.json` into a fresh room.
2. Verify the mortar and target appear, with range outlines, readable ring labels and a firing solution for the 500 m target.
3. Switch between Auto and a fixed ring, change wind, and verify the solution updates without console errors.
4. Reload, then open Mortar through the operations bar. The same gun and target should be adopted. Terrain loads
   can slightly change a solution; the field map can aim at a building roof while the workbench aims at ground.

## Base and shot integration

1. Join Base planning, choose Saint-Philippe, select Bunker and place one inside the build zone.
2. Verify its label and position in the plan list, then reload and verify it is still present and shared.
3. Open Shot planner, wait for the map to load, enter shooter and target grids and leave each input to commit it.
   Verify the firing solution and shared shot appear, then reload and verify the plan survives.
4. Check the browser console for new errors or warnings caused by the changed scripts.

## Delayed uploads and room transitions

1. Click **Delay uploads (5s)** on the control page. Create a field-map marker and immediately reload before its
   echo appears. Allow uploads; the marking must return from the browser backup.
2. Place a Bunker in Base planning and delete it immediately, then repeat while a move is uploading. After the
   delayed requests finish, neither the room nor the local plan may contain it.
3. Change a mortar or shot twice while its first upload is pending. Each planner must keep one marking ID.
   Clear the shot while an upload is pending; it must also disappear from the tactical map and stay gone on reload.
4. In a kept room with two clients, leave as `Bob` and rejoin as `bob`. The other tactical-map client must see the
   original drawings under the new spelling without reloading.
5. Start a restore with several missing markings and delayed uploads. Delete a marking already present on the
   server before the restore reaches it; repeat with its restore upload in flight. It must stay deleted after reload.
6. Leave an unedited mortar in room A, then join room B with different wind. The workbench must adopt B's wind
   and clear the old gun locally without publishing it into B. A deliberate edit after leaving A may transfer.
   Repeat the edited transfer with Shot planner, changing only sight or shooter/target height.
7. Navigate away from a joined tactical map and go Back. If the browser restores it from its back-forward cache,
   drawing must work again without a 401. Rejoin may take a moment while the previous leave is processed.
8. Open two 3D tabs under the same name as a regular player. Both must see updates without replacing that player
   or consuming its room-player slot. `/__test__/rooms` shows owners, observers and marking IDs for these checks.

## Measured LOS regression fixtures

For the alternative foliage dataset, run `node arma-map/compare_los.cjs` from the repository root. It compares
matching photo/mesh profile slices and identical worker queries on all three maps, then switches back to ensure
the photo result is unchanged and cached files are reused. Optional argument: path for a JSON report.

In a disposable localhost room, place an elevation profile and a friendly range card. In Map settings switch
Measured → Mesh → Light → Mesh; wait for detailed work to finish and verify the radio state, shading, profile
verdicts and coverage update without console errors. Reload to check persistence. Change Foliage strength in
both detailed modes. In Base planning select a base, switch the foliage selector and verify dead ground redraws.
Open 3D with the same room and verify Measured/Mesh overlays while retaining read-only observer behavior.

In Light, check that **Light model** offers **Mesh grid** (default) and **Original photos**. Switch between them
on the same range card and verify coverage redraws. Mesh grid exposes Foliage strength; Original photos hides it.
Change strength, reload to check both selections persist, then select full Mesh to check worker results still arrive.
Repeat on Arland to cover its different grid dimensions. Check the console for load/dimension errors.
Run `node arma-map/calibrate_light.cjs arma-map/LIGHT_CALIBRATION.json` for the offline 54-query calibration
and held-out comparison (this can take several minutes). `test_client.cjs` includes synthetic Light checks.

`node test_client.cjs` includes `test_regressions.cjs`: a 100-tile query retains its eye tile through computation,
cache trimming runs afterward, a failed tile can be retried, and a copied boundary crown is counted once per ray.
Requests exceeding the active tile budget fail explicitly. A fake worker verifies recovery after a transient
query error; low-charge ring fixtures check an ascending hillside intersection.

The automated server/client suites cover storage limits, malformed saves, restored-owner rejoining, upload
failures, rate-limit exhaustion, session changes, delayed SSE acknowledgements, imports and mortar compatibility.
These browser checks verify the page wiring and rendered behavior that the isolated function tests cannot cover.

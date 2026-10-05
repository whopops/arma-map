# Photo and mesh foliage comparison

Mesh is packaged from `reforger-map-tools/out/foliage-mesh-option`, game library build **24903726**
(2026-10-05), for Everon, Arland and Kolguyev. Generated files were copied intact into each map's
`foliage-mesh/` directory. Existing photo data, terrain and object tiles were preserved.

Use **Map settings → Line of sight → Mesh** to compare the same plan with **Measured** and **Light**.
Measured and Mesh use individual plants and the same detailed solver, eye heights, target heights, terrain,
object geometry, foliage strength and 2.5 m output cells. Base planning and 3D offer the same foliage choice.

## Measured comparison

Run from the repository root:

```text
node arma-map/compare_los.cjs arma-map/LOS_COMPARISON.json
```

The script reads local data and runs the actual worker. It matches prefab IDs, distance bands and slice heights;
checks unchanged plant-kind ordering; runs four identical 200 m / 90° queries per map (eye 1.6 m, target 1 m);
and repeats each photo query after selecting Mesh. Switching back must reproduce every output cell exactly
without fetching files again. Full results, coordinates and timings are in [LOS_COMPARISON.json](LOS_COMPARISON.json).

| Map | Plant kinds | Matched slices | Mean absolute cover difference | Cover correlation | Mean mesh minus photo cover | Changed LOS cells, sampled queries |
|---|---:|---:|---:|---:|---:|---:|
| Everon | 70 | 15,941 | 3.86 percentage points | 0.926 | +1.14 percentage points | 0–5.02% |
| Arland | 67 | 14,083 | 3.25 percentage points | 0.957 | +0.39 percentage points | 0–2.05% |
| Kolguyev | 114 | 23,672 | 4.14 percentage points | 0.933 | +0.85 percentage points | 0.08–1.94% |

Mesh is slightly denser on average at matching slices. Changes vary by vegetation and location: in the sampled
Everon plant location the clear area fell from 19% to 17%, and the area seen through foliage from 8% to 6%.
Terrain/buildings dominate some sampled views, so zero difference in those queries says little about foliage.
These queries cover map starts, two nearby positions and one known plant location per map; they are deterministic
smoke comparisons, not a representative island-wide benchmark or an engine ground-truth accuracy test.

The two detailed modes have comparable compute costs in these local runs (roughly 0.3–0.5 seconds for most
200 m sectors). JSON timings include local decompression/loading separately; browser download speed, CPU,
full-circle queries, longer range and the number of markings can substantially change latency. Mesh loads use
already-cached shared object tiles, so load timings are not cold-download comparisons.

## Integration and performance

- Both foliage datasets remain cached separately; terrain/object tiles are shared. Selecting a dataset changes
  the worker configuration for each request, rather than keeping the first request's foliage forever.
- Plant identities are computed once per loaded tile, retaining deduplication of boundary copies. Ray steps reuse
  the current terrain tile instead of constructing and looking up its name at every half metre.
- Tactical map result keys include dataset and strength. Base and 3D keys include dataset. Stale queued tactical
  requests are cancelled when switching. Route/flight summaries and marking-list percentages refresh with results.
- The original Light option retains photo foliage. Mesh's responsive preview uses the supplied mesh light grid,
  sharing existing terrain, buildings and clutter. The UI identifies the preview while detailed work is pending.

The mesh light grid also contains an upstream aggregation correction: blocked plant cross-section is spread
over a cell instead of the old slab extinction approximation. Its thinner coarse foliage is therefore not solely
evidence that meshes have fewer leaves. This change is confined to Mesh previews; it does not change Light.

No new engine checks were run. The supplier documents comparisons with still-air photographs and limitations
from wind, LOD, video settings and lens. Prefer in-game checks of the particular position when choosing between
the two detailed estimates. Existing quoted object-geometry accuracy is independent of foliage accuracy.

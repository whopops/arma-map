# Light against detailed Mesh

Light now defaults to the supplied **mesh foliage grid**, keeping 10 m output cells and 5 m ray steps.
The **Light model** selector retains **Original photos** for direct comparison. Mesh Light follows
Foliage strength; original Light keeps its previous fixed rates. Detailed Measured and Mesh are unchanged.

We retained the existing coarse rates after calibration: low foliage 0.62, crowns 0.55, clutter 0.7,
clear transmission threshold 0.7 and hidden threshold 0.23. Changing the dataset improved the held-out
three-class balance; the coefficient fit did not improve reliably enough to use.

## Method

Run from the repository root:

```text
node arma-map/calibrate_light.cjs arma-map/LIGHT_CALIBRATION.json
```

The runner loads the actual browser coarse solver and detailed worker, with local packaged grids/profiles.
It tests Everon, Arland and Kolguyev (mesh library build 24903726), using nine deterministic locations per map:
town edges, forest and open terrain in each of three geographic splits. Locations are separated by at least
500 m; their sectors may overlap at the longer range. Each location has two 90-degree queries: 200 m with
0.6 m eye / 1 m target, and 600 m with 2 m eye / 1.6 m target. Foliage strength is 1.

There are 54 queries: 36 training/development queries for fitting and 18 held-out queries. A sweep of 433
parameter combinations selected its winner using mean per-query macro F1 on training/development locations.
The held-out check rejected that winner because its aggregate macro F1 was worse than simply using the
mesh grid with the existing rates. The shipped configuration was then run individually, outside the batched
sweep. Batched sweeps share negligible-sample filtering, so their predictions can differ slightly from an
individual run; the saved production metrics and timings use the individual path.

The reference is **detailed Mesh, not in-game ground truth**. Its 2.5 m cells are coarsened to the same
best-visible 10 m cell rule the UI uses. Only cells covered by both outputs count. Class order in the JSON
confusion matrices is hidden, clear, through foliage. Macro F1 weights these three classes equally;
cell agreement is dominated by hidden terrain at longer ranges.

## Held-out results

18 queries, 29,556 common covered cells:

| Metric against detailed Mesh | Original photos | Mesh grid, retained rates | Rejected fitted rates |
| --- | ---: | ---: | ---: |
| Cell agreement | 78.23% | 78.26% | 76.80% |
| Aggregate three-class macro F1 | 0.558 | **0.595** | 0.554 |
| Mean per-query macro F1 | 0.535 | **0.561** | 0.560 |
| Hidden F1 | **0.909** | 0.899 | 0.894 |
| Clear F1 | 0.424 | **0.536** | 0.478 |
| Through-foliage F1 | 0.341 | **0.350** | 0.289 |

Mesh-grid macro F1 improves on each map's held-out aggregate: Everon 0.369 → 0.409, Arland 0.613 → 0.633,
Kolguyev 0.624 → 0.667. This is a class-balance improvement, not a general increase in cell agreement or
every class at every site. Training/development agreement decreases from 87.18% to 85.92%, with macro F1
changing from 0.558 to 0.560. Narrow plant gaps, trunks and buildings cannot be reconstructed from 10 m grids;
use detailed Mesh for the finer result.

## Compute time

Means over all 54 queries, after required data loading, in Node on this workstation:

| 90-degree sector | Original-photo Light | Mesh-grid Light | Detailed Mesh |
| --- | ---: | ---: | ---: |
| 200 m | 6.5 ms | 6.4 ms | 372 ms |
| 600 m | 57.6 ms | 59.0 ms | 3,265 ms |

Mesh Light has essentially the same compute cost as original Light and is about 55–58 times faster than
detailed Mesh in these fixtures. Timings exclude file loading, worker messaging and map rendering; browser,
device, range and sector width affect the result. This is a limited deterministic comparison, not a claim of
engine accuracy or a speed guarantee. Coordinates, confusion matrices, rejected trial and timings are saved
in [LIGHT_CALIBRATION.json](LIGHT_CALIBRATION.json).

## Verification

`test_client.cjs` includes coarse foliage strength, opaque shadows, elevation limits, batched/single prediction
checks and map-edge coverage. Browser checks used disposable localhost rooms: switching Light presets changed
the same range card's coverage, strength updated mesh Light, selections persisted after reload, detailed Mesh
still completed, and Arland loaded its different grid dimensions without console errors.

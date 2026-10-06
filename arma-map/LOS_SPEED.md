# Detailed LOS speed

Measured and Mesh share these optimizations (first pass, baseline `4952e3c6`):

- Process a 4 m square's nearby-plant list on the ray's first eligible step there. Repeated 0.5 m steps in
  that square would only find plants already counted. Reset this state at terrain/plant tile boundaries.
- Reuse the known tile coordinates when interpolating terrain height.
- Stop classifying additional target samples in an already-clear output cell, since clear is its highest
  possible result. Keep processing terrain and plants there so farther targets still receive their obstruction.

The 0.5 m march, terrain/object resolution, plant slices, thresholds and 2.5 m output cells remain unchanged.

## Comparison

The actual old and new workers ran on the same loaded local data, alternating execution order. Town and forest
fixtures cover Everon, Arland and Kolguyev, 200 m and 600 m 90-degree sectors, and both photo and mesh profiles.
All output cells and result geometry/percentages were identical for all 24 comparisons.

| Sector range | Queries | Baseline mean | Optimized mean | Compute time reduction |
| --- | ---: | ---: | ---: | ---: |
| 200 m | 12 | 368 ms | 322 ms | 12.7% |
| 600 m | 12 | 3,410 ms | 3,162 ms | 7.3% |

These are workstation Node timings from one comparison pass, excluding loading, worker messages and rendering.
Individual scenes varied, including some slower samples. They establish a modest improvement in this run,
not a guaranteed browser/device speedup. The first lookup-only pass improved only about 1–3%; the table includes
all three changes. For much larger gains, worker parallelism or reduced sampling would need separate evaluation.

## Solid-horizon early-out

Measured and Mesh also share an exact early-out. Each loaded terrain tile keeps the highest terrain post in every
5 m block; bilinear ground inside a block cannot exceed those posts, and ocean/absent tiles count as 0 as in
`groundAt`. Before marching a ray, the worker bounds each 5 m chunk of it (10 samples) by the highest target slope
`(blockMax + targetH - eye) / r` its samples could have, using the chunk's nearest distance (its farthest when that
height is below the eye), and keeps the maximum from the far end. At the first sample of each chunk, if that bound is
strictly below the solid horizon (`maxSolid` from ground, buildings and walls/rocks), every remaining target would be
hidden: the ray marks its remaining untouched cells hidden and stops. A target exactly on the horizon is not hidden,
so the comparison is strict. Plants first met after that point would only thin targets that are already hidden.
Building tops are kept out of the bound, and a tile that should exist but is not loaded disables the early-out so the
march still fails as before.

Before implementing, an instrumented copy of the worker measured the ceiling in hindsight (steps after which the
horizon stayed above every later target slope). It reproduced the proposed figures: on the Everon training forest
17% of steps (200 m) and 29% (600 m), on the training town 60% and 82%. Holdout scenes ranged from 0% (Everon forest
600 m, Kolguyev town 200 m) to 89% (Kolguyev forest 200 m). Plant integration was 10–44% of compute time, not half;
the 0.5 m march dominated, which is what the early-out removes.

Median of 5 alternating runs per query, same holdout scenes and loaded data, one workstation, compute only
(no loading, messages or rendering), baseline `cd94cdee`:

| Sector range | Queries | Baseline mean | Early-out mean | Speedup |
| --- | ---: | ---: | ---: | ---: |
| 200 m | 12 | 326 ms | 234 ms | 1.39× |
| 600 m | 12 | 3,103 ms | 1,877 ms | 1.65× |

Towns gain most (Everon town 2.6–3.0×, Arland town 1.8–2.6×) and Measured and Mesh behave alike. Scenes whose solid
horizon never closes pay for the bound without benefit: Everon forest 600 m was 5–9% slower and Kolguyev town 200 m
3–6% slower across repeated passes; Arland forest 200 m was within noise. Single runs on this machine varied by up to
about ±15%. All output cells, geometry and percentages were identical in every comparison. The one-pass benchmark
record is [LOS_SPEED.json](LOS_SPEED.json) (200 m 314 → 221 ms, 600 m 2,842 → 1,706 ms).

`test_regressions.cjs` compares the worker with a copy whose early-out is forced off on an uphill fixture (targets
clear a near wall's horizon by 0.3 m, so a bound that is 0.5 m too low fails), a tall near wall with plants before
and past it (the past one is skipped, the near one still thins the line), map-edge clipping, 0/30/45/360 degree arcs,
strength 0.5/1, elevation limits and a tile boundary.

## Rejected

- Splitting rays across threads. Rays only meet in `cells` (rank-max), but without SharedArrayBuffer every
  sub-worker would need its own fetched and decompressed copy of the terrain/object tiles (about 2.5 MB each, up to
  90 cached) and plant tiles, multiplying memory and first-load work, and nested workers would add a second internal
  protocol. Not implemented.
- Trimming leading/trailing plant slices in `addProfile`: slices outside the plant's width already skip the cover
  and log work, so only the loop remains. Not implemented. Reusing `-ln(1 - cover)` at strength 1 was not measured.
- 1 m steps or fewer rays: faster but change cells.

Repeat with the baseline commit recorded in [LOS_SPEED.json](LOS_SPEED.json):

```text
node arma-map/benchmark_los.cjs <baseline-commit> arma-map/LOS_SPEED.json
```

The benchmark aborts if any output cell differs. Client regressions separately compare the guarded solver
with an unskipped reference on synthetic near-eye, boundary, foliage-strength, full-circle and far-obstruction
fixtures, and with an early-out-free reference on the horizon fixtures. The Comparison table, for the earlier
bucket/clear-cell changes, was measured against baseline `4952e3c6`.

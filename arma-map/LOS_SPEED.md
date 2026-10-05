# Detailed LOS speed

Measured and Mesh share these optimizations:

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

Repeat using the baseline commit recorded in [LOS_SPEED.json](LOS_SPEED.json):

```text
node arma-map/benchmark_los.cjs <baseline-commit> arma-map/LOS_SPEED.json
```

The benchmark aborts if any output cell differs. Client regressions separately compare the guarded solver
with an unskipped reference on synthetic near-eye, boundary, foliage-strength, full-circle and far-obstruction
fixtures. Server/client suites and worker syntax checks passed.

# Foliage see-through measurements

How much of the view each kind of tree and bush blocks, measured from what the game draws (physics rays ignore
leaves). `tools/foliage_model.py` turns these, with `everon_plants.csv.gz`, into `static/data/foliage.json` and
`static/data/maps/<map>/plants/` for the line-of-sight worker. Re-run it after re-measuring or re-exporting plants. The
map's **Measured** line-of-sight mode uses the later, distance-based profiles in `static/data/maps/<map>/foliage/`.

## Files

| File | What |
|---|---|
| `foliage_profiles.json` | Per prefab: kind, shots, height (m), and per 0.5 m slice (`y` = slice bottom) the average `cover` and `k` |
| `foliage_shots.csv` | The same per shot and slice, plus `width_m` (plant width in that slice) |
| `everon_plants.csv.gz` | Every standing tree and bush on Everon (762,777): kind, position, scale, half-width, top (`tools/export_plants.py`) |
| `plants.csv` | Every kind (70: 52 trees, 18 bushes), its count and mean scale; stumps, logs and debris left out |

## How they were made (2026-09-28)

1. **Plant list.** With Everon open, "1. Save plant list" (`workbench/.../EveronFoliageMeasureTool.c`) wrote
   `plants.csv`.
2. **Photographs.** In the empty world `EmptyEden.ent`, "3. Measure all plants" placed each kind alone in open sky.
   It photographed each from 16 sides, with and without the plant: 1,120 pairs.
3. **Measurement.** `measure_foliage.py` compared the pairs, with none skipped. On average, leaves block 63% of the
   view inside a tree's outline and 57% inside a bush's.

Measuring plants where they grow failed: other objects kept getting in the way.

## Reading the numbers

- `cover` is the share blocked *within the plant's own width* in that slice. A bare trunk reads ~0.95 (solid but
  narrow). For a map cell, combine it with `width_m`, or use `k` (per metre crossed: cover = 1 − e^(−k × width)).
- Heights are at scale 1. Everon's plants are scaled about 0.76-1.08, so scale per instance.

| Plant | Kind | Height | Cover 0-2 m |
|---|---|---|---|
| b_corylus_avellana_1l (hazel, most common) | bush | 4.0 m | 0.75 |
| b_salix_cinerea_1w (willow) | bush | 3.0 m | 0.84 |
| b_rubus_idaeus_1s (raspberry) | bush | 1.2 m | 0.56 (0-1.5 m) |
| b_phragmites_australis_1 (reeds) | bush | 3.2 m | 0.60 |
| t_picea_abies_1s (small spruce) | tree | 4.5 m | 0.62 |
| t_betula_pendula_1s (birch) | tree | 6.9 m | 0.43 (root flare at 0-0.5 m: 0.79) |
| t_picea_abies_3f_high (tall spruce) | tree | 32.6 m | 0.91 (trunk only) |
| t_pinus_sylvestris_3s (Scots pine) | tree | 20.0 m | 0.95 (trunk only) |

## Caveats

- **Sea in the background**: for low bushes and reeds, a few pixels of moving sea can count as plant, so the lowest
  slice may read slightly high.
- **Uneven angles**: sides 0 and 1 of `t_picea_abies_1s` and `b_corylus_avellana_1l` come from a test run (180° apart,
  not 22.5°).
- **Counts run high**: `plants.csv` counts a plant on a 500 m square's edge twice. They're only used for ranking.
- **Bare trunk**: `t_betula_pendula_stem_01` is probably a trunk, not a full tree.
- **Wind**: leaves moving between the two pictures can only nudge cover up slightly at the edges.

The screenshots (~1.6 GB) aren't in the repo. They're in
`Documents\My Games\ArmaReforgerWorkbench\profile\everon_los\foliage\` on the PC that made them.

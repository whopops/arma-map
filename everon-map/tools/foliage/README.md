# Foliage see-through measurements

How much of the view Everon's trees and bushes block, measured from what the game draws rather than from the
physics shapes the line-of-sight export uses. For a later per-cell opacity line-of-sight model; the map's line-of-sight
code doesn't use these yet.

Files:

- `foliage_profiles.json`: per prefab: kind, number of shots, height (m), and per 0.5 m slice (`y` = slice bottom
  above the plant's base) the average `cover` and `k` over its shots.
- `foliage_shots.csv`: the same per shot and slice, plus `width_m`, the plant's width in that slice as seen in that
  shot.
- `plants.csv`: every kind of standing tree and bush on Everon (stumps, fallen trunks, branches and `Debris/` left
  out), how many there are and their average scale.

## How they were made (2026-09-28)

`workbench/EveronLOSExport/.../EveronFoliageMeasureTool.c`, then `measure_foliage.py`:

1. With Everon open, "1. Save plant list" wrote `plants.csv`: 70 kinds, 52 trees and 18 bushes.
2. In the empty world `EmptyEden.ent`, "3. Measure all plants" placed one of each kind on its own, about 258 m up in
   open sky. It photographed the plant from 16 sides, turning the plant each time with the camera fixed, and took each
   shot twice: with the plant and with it hidden. That made 1,120 pairs.
3. `measure_foliage.py` over all pairs gave 0 shots skipped. The average share of the view blocked inside a plant's
   outline was 63% for trees and 57% for bushes.

The first attempt photographed plants where they grow on the island and failed. Physics rays don't see leaves, so
fences, walls, reed beds and other plants kept getting between the camera and the plant. The empty-world version has
nothing in the way and shoots every kind the same way.

## How to read the numbers

- `cover` is the share of the view blocked *within the plant's own width in that slice*, not within a fixed cell.
  A bare trunk slice reads about 0.95, because the trunk is solid; it's just narrow. To get the opacity of a map cell,
  combine `cover` or `k` with `width_m` (or use `k`, which is per metre of plant crossed: cover = 1 - e^(-k * width)).
- Heights are metres above the plant's base at scale 1. Plants on Everon are scaled about 0.76-1.08
  (`plants.csv`, `mean_scale`), so scale the heights for each instance.

Typical cover at 0-2 m (mean of the 0, 0.5, 1 and 1.5 m slices):

| Plant | Kind | Height | Cover 0-2 m |
|---|---|---|---|
| b_corylus_avellana_1l (hazel, most common) | bush | 4.0 m | 0.75 |
| b_salix_cinerea_1w (willow) | bush | 3.0 m | 0.84 |
| b_rubus_idaeus_1s (raspberry) | bush | 1.2 m | 0.56 (0-1.5 m) |
| b_phragmites_australis_1 (reeds) | bush | 3.2 m | 0.60 |
| t_picea_abies_1s (small spruce) | tree | 4.5 m | 0.62 |
| t_betula_pendula_1s (birch) | tree | 6.9 m | 0.43 (0-0.5 m is the root flare, 0.79) |
| t_picea_abies_3f_high (tall spruce) | tree | 32.6 m | 0.91 (trunk only) |
| t_pinus_sylvestris_3s (Scots pine) | tree | 20.0 m | 0.95 (trunk only) |

## Things to watch

- Low bushes and reeds: the camera looks down slightly at short plants, so the bottom of the frame can show the sea
  far below. Its waves change between the two pictures and a few pixels of it count as plant (visible as red specks in
  `debug/` for the reeds). Only a small effect, and mostly below the plant's base, but the lowest slice of short plants
  may read a little high.
- `t_picea_abies_1s` and `b_corylus_avellana_1l`, sides 0 and 1, come from the test run, where side 1 was the plant
  turned 180° instead of 22.5°. It's still a valid view, just not evenly spaced.
- `plants.csv` counts are a little high: a plant on the edge between two 500 m query squares is counted twice. They're
  only used to rank kinds.
- `t_betula_pendula_stem_01` is probably a bare birch trunk, not a full tree.
- Wind: leaves can move slightly between the two pictures. Where a leaf is in either picture it counts as plant, so
  this can only nudge cover up a little at the plant's edges.

Screenshots aren't in the repo (about 1.6 GB). They're in
`Documents\My Games\ArmaReforgerWorkbench\profile\everon_los\foliage\` on the PC that made them.

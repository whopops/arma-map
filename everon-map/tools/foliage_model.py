"""Make the data the map's "Visual" line of sight uses: every plant on Everon, and how see-through each kind is.

Input:  tools/foliage/foliage_shots.csv, plants.csv   the measurements (see tools/foliage/README.md)
        tools/foliage/everon_plants.csv.gz              every standing tree and bush (tools/export_plants.py)
        static/data/los/                                the line-of-sight tiles, for the ground under each plant
Output: static/data/foliage.json      per kind of plant (rows of plants.csv): its drawn height h (m, at scale 1) and,
                                      for each tenth of that height from the base up, the plant's half-width hw (m)
                                      and how strongly it blocks sight inside that width, k (per metre crossed;
                                      what's left visible is e^(-sum of k x metres)). Plus the list of plant tiles.
        static/data/plants/X_Z.bin.gz  per 500 m tile, every plant that reaches into it, little-endian:
                                      n Uint32, then x Uint16[n] and z Uint16[n] (centre, in cm from 16 m south-west
                                      of the tile's corner), base Uint16[n] (ground under it, cm), kind Uint8[n],
                                      scale Uint8[n] (hundredths)

Each plant is taken as round: in each tenth of its height, a sight line passing within hw of its centre crosses
leaves at rate k. From a shot's 0.5 m slices: the plant's width w and the share of it that blocks the view (cover),
averaged over its 16 sides, give k = -ln(1 - cover) / w. A bare trunk is narrow and nearly solid; a crown is wide and
thinner. A plant's size scales both: hw x scale, height x scale, k / scale.

Run:  python tools/foliage_model.py
"""

import collections
import csv
import gzip
import json
import math
import os
import statistics
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, 'static', 'data')
BINS = 10               # tenths of the plant's height
SLICE = 0.5             # metres, the measurement's slices
TILE, MARGIN = 500, 16  # metres; plants reaching into a tile from up to MARGIN outside are listed with it
TN = 501


def profiles():
    """Per kind of plant (plants.csv order): h, hw[BINS], k[BINS]."""
    shots = collections.defaultdict(list)
    with open(os.path.join(HERE, 'foliage', 'foliage_shots.csv'), encoding='utf8') as f:
        for r in csv.DictReader(f):
            shots[r['id']].append(r)
    with open(os.path.join(HERE, 'foliage', 'plants.csv'), encoding='utf8') as f:
        prefabs = [r['prefab'] for r in csv.DictReader(f)]
    by_prefab = collections.defaultdict(list)
    for s in shots.values():
        by_prefab[s[0]['prefab']].append(s)
    out = []
    for prefab in prefabs:
        tops, slices = [], collections.defaultdict(list)  # slice bottom -> (blocked width, width) per shot
        for s in by_prefab[prefab]:
            tops.append(max([float(x['slice_m']) + SLICE for x in s if float(x['cover']) > 0.02] or [SLICE]))
            for x in s:
                w = float(x['width_m'])
                slices[float(x['slice_m'])].append((float(x['cover']) * w, w))
        h = statistics.median(tops)
        hw, ks = [], []
        for j in range(BINS):
            lo, hi = j * h / BINS, (j + 1) * h / BINS
            ys = [y for y in slices if lo <= y + SLICE / 2 < hi] or [math.floor((lo + hi) / 2 / SLICE) * SLICE]
            pairs = [p for y in ys for p in slices.get(y, [])]
            w = float(np.mean([p[1] for p in pairs])) if pairs else 0
            blocked = float(np.mean([p[0] for p in pairs])) if pairs else 0
            if w < 0.05:
                hw.append(0)
                ks.append(0)
                continue
            cover = min(0.99, blocked / w)
            hw.append(round(w / 2, 3))
            ks.append(round(-math.log(1 - cover) / w, 4))
        out.append({'h': round(h, 2), 'hw': hw, 'k': ks})
    return out


def ground(tiles, x, z):
    """Ground height (m) under a point, from the line-of-sight tiles' terrain (sea at 0)."""
    tx, tz = int(x // TILE), int(z // TILE)
    t = tiles.get((tx, tz))
    if t is None:
        return 0.0
    lx, lz = min(max(x - tx * TILE, 0), TILE - 1e-6), min(max(z - tz * TILE, 0), TILE - 1e-6)
    c, r = int(lx), int(lz)
    fx, fz = lx - c, lz - r
    a, b, d, e = t[r, c], t[r, c + 1], t[r + 1, c], t[r + 1, c + 1]
    return ((a + (b - a) * fx) * (1 - fz) + (d + (e - d) * fx) * fz) / 100


def main():
    prof = profiles()
    with open(os.path.join(DATA, 'los', 'index.json'), encoding='utf8') as f:
        names = json.load(f)['tiles']
    tiles = {}
    for n in names:
        tx, tz = map(int, n.split('_'))
        raw = gzip.open(os.path.join(DATA, 'los', n + '.bin.gz')).read(TN * TN * 2)
        tiles[(tx, tz)] = np.frombuffer(raw, '<u2').reshape(TN, TN).astype(np.float64)

    with gzip.open(os.path.join(HERE, 'foliage', 'everon_plants.csv.gz'), 'rt', encoding='utf8') as f:
        rows = list(csv.DictReader(f))
    kind = np.array([int(r['kind']) for r in rows])
    x = np.array([float(r['x']) for r in rows])
    z = np.array([float(r['z']) for r in rows])
    scale = np.clip(np.array([float(r['scale']) for r in rows]), 0.01, 2.55)
    base = np.array([max(0.0, ground(tiles, a, b)) for a, b in zip(x, z)])
    reach = np.array([max(p['hw']) for p in prof])[kind] * scale
    print(f'{len(rows)} plants, {len(prof)} kinds')

    folder = os.path.join(DATA, 'plants')
    os.makedirs(folder, exist_ok=True)
    for fn in os.listdir(folder):
        os.remove(os.path.join(folder, fn))
    made, total = [], 0
    for (tx, tz) in sorted(tiles, key=lambda t: (t[1], t[0])):
        x0, z0 = tx * TILE, tz * TILE
        sel = np.nonzero((x + reach > x0) & (x - reach < x0 + TILE) & (z + reach > z0) & (z - reach < z0 + TILE))[0]
        if not len(sel):
            continue
        n = len(sel)
        raw = (np.uint32(n).tobytes()
               + np.round((x[sel] - x0 + MARGIN) * 100).astype('<u2').tobytes()
               + np.round((z[sel] - z0 + MARGIN) * 100).astype('<u2').tobytes()
               + np.round(base[sel] * 100).astype('<u2').tobytes()
               + kind[sel].astype(np.uint8).tobytes()
               + np.round(scale[sel] * 100).astype(np.uint8).tobytes())
        with gzip.open(os.path.join(folder, f'{tx}_{tz}.bin.gz'), 'wb', compresslevel=9) as f:
            f.write(raw)
        made.append(f'{tx}_{tz}')
        total += n
    size = sum(os.path.getsize(os.path.join(folder, f)) for f in os.listdir(folder))
    print(f'{len(made)} plant tiles, {total} entries, {size / 1e6:.1f} MB')

    out = {'note': 'made by tools/foliage_model.py; see there', 'bins': BINS, 'margin': MARGIN, 'tiles': made, 'plants': prof}
    with open(os.path.join(DATA, 'foliage.json'), 'w', encoding='utf8') as f:
        json.dump(out, f, separators=(',', ':'))
    for i in (0, 1, 2):
        p = prof[i]
        print(i, p['h'], 'hw', p['hw'], 'k', p['k'])


if __name__ == '__main__':
    sys.exit(main())

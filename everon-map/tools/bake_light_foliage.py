"""Bake the Light line of sight's 10 m foliage and clutter layers from the measured plants and the 0.5 m tiles.

Input:  static/data/foliage.json, static/data/plants/  every plant and its kind's measured shape and see-through
                                                       (tools/foliage_model.py)
        static/data/los/                               the 0.5 m tiles, for walls, rocks and buildings
Output: static/data/light/everon-foliage.bin.gz  Uint8[BANDS][1280*1280]: per 10 m cell and height band above the
                                                 ground, the cell's average foliage k (how strongly leaves block
                                                 sight, per metre; 0-255 = 0-K_MAX)
        static/data/light/everon-clutter.bin.gz  Uint8[BANDS][1280*1280]: per cell and band, the share of the cell
                                                 filled by solid things (buildings, walls, rocks, poles), 0-255 = 0-100%
Rows run south to north, columns west to east, like the other light files.

Each plant is spread over the cells its outline covers (taken as a square of the same area), in each tenth of its
height at its own half-width and k (see tools/foliage_model.py), and averaged over each band's height. So a cell's k is
what a sight line crossing it at that height meets on average, the same leaves the Visual model sees one by one.

Run:  python tools/bake_light_foliage.py
"""

import gzip
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(HERE), 'static', 'data')
BANDS = [0, 1, 2, 4, 7, 12, 20, 45]  # band edges, metres above the ground
K_MAX = 0.5                          # k stored in 1/255ths of this (per metre)
HN, HCELL, TILE, S_N, Q = 1280, 10, 500, 1000, 0.25
NB = len(BANDS) - 1


def plants_layer():
    with open(os.path.join(DATA, 'foliage.json'), encoding='utf8') as f:
        fol = json.load(f)
    prof, margin, bins = fol['plants'], fol['margin'], fol['bins']
    xs, zs, kinds, scales = [], [], [], []
    for name in fol['tiles']:
        tx, tz = map(int, name.split('_'))
        raw = gzip.open(os.path.join(DATA, 'plants', name + '.bin.gz')).read()
        n = int(np.frombuffer(raw, '<u4', 1)[0])
        x = np.frombuffer(raw, '<u2', n, 4) / 100 - margin + tx * TILE
        z = np.frombuffer(raw, '<u2', n, 4 + 2 * n) / 100 - margin + tz * TILE
        kind = np.frombuffer(raw, np.uint8, n, 4 + 6 * n)
        scale = np.frombuffer(raw, np.uint8, n, 4 + 7 * n) / 100
        own = (np.floor(x / TILE) == tx) & (np.floor(z / TILE) == tz)  # each plant once, from its own tile
        xs.append(x[own]); zs.append(z[own]); kinds.append(kind[own]); scales.append(scale[own])
    x, z, kind, scale = map(np.concatenate, (xs, zs, kinds, scales))
    print(f'{len(x)} plants')
    k_grid = np.zeros((NB, HN, HN), np.float64)
    for kd, p in enumerate(prof):
        sel = kind == kd
        if not sel.any():
            continue
        px, pz, s = x[sel], z[sel], scale[sel]
        h = p['h'] * s
        for j in range(bins):
            if not p['k'][j] or not p['hw'][j]:
                continue
            half = p['hw'][j] * s * np.sqrt(np.pi) / 2        # half-side of a square as big as the disc
            k = p['k'][j] / s
            y0, y1 = h * j / bins, h * (j + 1) / bins
            band_share = [np.clip(np.minimum(y1, BANDS[b + 1]) - np.maximum(y0, BANDS[b]), 0, None) / (BANDS[b + 1] - BANDS[b])
                          for b in range(NB)]
            cx0 = np.floor((px - half) / HCELL).astype(int)
            cz0 = np.floor((pz - half) / HCELL).astype(int)
            for dz in range(3):
                for dx in range(3):
                    cx, cz = cx0 + dx, cz0 + dz
                    ox = np.clip(np.minimum(px + half, (cx + 1) * HCELL) - np.maximum(px - half, cx * HCELL), 0, None)
                    oz = np.clip(np.minimum(pz + half, (cz + 1) * HCELL) - np.maximum(pz - half, cz * HCELL), 0, None)
                    area = ox * oz / (HCELL * HCELL)
                    ok = (area > 0) & (cx >= 0) & (cx < HN) & (cz >= 0) & (cz < HN)
                    if not ok.any():
                        continue
                    for b in range(NB):
                        w = (k * area * band_share[b])[ok]
                        if w.any():
                            np.add.at(k_grid[b], (cz[ok], cx[ok]), w)
    return k_grid


def clutter_layer():
    with open(os.path.join(DATA, 'los', 'index.json'), encoding='utf8') as f:
        names = json.load(f)['tiles']
    grid = np.zeros((NB, HN, HN), np.float32)
    per = TILE // HCELL
    blk = S_N // per
    for name in names:
        tx, tz = map(int, name.split('_'))
        raw = gzip.open(os.path.join(DATA, 'los', name + '.bin.gz')).read()
        o = 501 * 501 * 2
        top = np.frombuffer(raw, np.uint8, S_N * S_N, o).reshape(S_N, S_N).astype(np.float32) * Q
        kind = np.frombuffer(raw, np.uint8, S_N * S_N, o + 2 * S_N * S_N).reshape(S_N, S_N)
        solid = (kind == 1) | (kind == 2)
        top = np.where(solid, top, 0)
        for b in range(NB):
            fill = np.clip((top - BANDS[b]) / (BANDS[b + 1] - BANDS[b]), 0, 1)
            cells = fill.reshape(per, blk, per, blk).mean(axis=(1, 3))
            rows, cols = min(per, HN - tz * per), min(per, HN - tx * per)  # the island's edge tiles run past 12.8 km
            grid[b, tz * per:tz * per + rows, tx * per:tx * per + cols] = cells[:rows, :cols]
    return grid


def write(name, arr):
    with open(os.path.join(DATA, 'light', name + '.gz'), 'wb') as f:
        f.write(gzip.compress(np.ascontiguousarray(arr).tobytes(), 9, mtime=0))


def main():
    k = plants_layer()
    nz = k[k > 0]
    print('foliage k per band (mean over wooded cells, 99.9th percentile):',
          [f'{k[b][k[b] > 0].mean():.3f}' if (k[b] > 0).any() else '-' for b in range(NB)], f'{np.percentile(nz, 99.9):.3f}')
    print(f'cells above K_MAX: {(k > K_MAX).sum()} of {(k > 0).sum()}')
    write('everon-foliage.bin', np.clip(np.round(k / K_MAX * 255), 0, 255).astype(np.uint8))
    c = clutter_layer()
    print('clutter share per band (mean where any):', [f'{c[b][c[b] > 0].mean():.3f}' if (c[b] > 0).any() else '-' for b in range(NB)])
    write('everon-clutter.bin', np.round(c * 255).astype(np.uint8))
    for n in ('everon-foliage.bin', 'everon-clutter.bin'):
        print(n, f'{os.path.getsize(os.path.join(DATA, "light", n + ".gz")) / 1e6:.2f} MB')


if __name__ == '__main__':
    sys.exit(main())

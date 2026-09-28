"""Bake the Workbench line-of-sight export into tiles the map loads.

Input (from the Everon LOS Export tool in Workbench, see tools/workbench):
  objects/o_X_Z.csv   every object: class, prefab, position, rotation, world bounding box
  terrain/t_X_Z.csv   terrain height every 1 m, in centimetres (501 x 501 per 500 m tile)
  surface/s_X_Z.csv   every 0.5 m spot an object covers: top, underside, kind and bullet-stop height

Output: static/data/los/X_Z.bin.gz per 500 m tile, plus index.json. Each tile, little-endian:
  terrain  Uint16[501*501]   ground height in centimetres, sea floor clamped to the water line (0)
  top      Uint8[1000*1000]  top of whatever stands on each 0.5 m spot, in 0.25 m above the ground
  bottom   Uint8[1000*1000]  where it starts (canopy underside; 0 for solid things), same units
  kind     Uint8[1000*1000]  0 nothing, 1 building, 2 solid (walls, rocks, poles, props), 3 tree,
                             4 see-through fence (marked, doesn't block sight), 5 bush or low plant
                             (blocks sight like a tree, but a helicopter can land over it)
  cover    Uint8[1000*1000]  top of what stops bullets, same units (0 = nothing)
Rows run south to north, columns west to east, both for terrain and the 0.5 m planes.

Light version (the old 10 m system, fed with the new data), in static/data/light/, each gzipped (.bin.gz):
  everon-height.bin   Int16[1280*1280]  ground height in decimetres at each 10 m cell's centre (sea at 0)
  everon-forest.bin   1 bit per cell    wooded: at least 35% of the cell under trees or bushes 3 m or taller
  everon-canopy.bin   Uint8[1280*1280] x 4  four planes, one after another:
                        top    - canopy top in metres (75th percentile of the trees' tops; 0 = no trees)
                        base   - where the crowns start, in metres (median underside)
                        low    - share of the cell blocked at head height (1.7 m) by trunks, bushes, low
                                 branches and solid clutter, 0-255 = 0-100%
                        crown  - share of the cell under crowns seen from above, 0-255 = 0-100%
  everon-buildings.bin Uint8[1280*1280] building height in metres where buildings cover 40%+ of the cell
  everon-lz.bin       Uint8[1280*1280]  helicopter landing at each 10 m cell's centre: 0 water, 1 good, 2 marginal,
                                         3 no-go (same rules as the map's landing zone check; see LZ_* below)
Rows run south to north from row 0, like the old files, so the old code reads the first two as they are.

Thin walls are often missed between the 0.5 m rays, so solid walls from the object list are drawn in as
continuous lines at their real height. See-through fences (poles, nets, railings) are taken back out. Power poles,
lamp posts and masts (anything tall and thin that isn't a plant) are stamped in too. The engine calls bushes and
trees alike, so foliage inside a listed tree's crown stays a tree and the rest becomes a bush.

Run:  python tools/bake_los.py [--src "<export folder>"] [--out static/data/los]
"""

import argparse
import csv
import gzip
import json
import os
import re
import sys
import time

import numpy as np

TILE = 500          # metres
T_N = 501           # terrain samples per side (1 m, edges shared)
S_N = 1000          # surface cells per side (0.5 m)
CELL = 0.5
Q = 0.25            # height units for top / bottom / cover (metres)

# Wall and fence families (the folder after Prefabs/Structures/Walls/), sorted by whether they block sight.
SOLID = re.compile(r'/Walls/(Stone|Brick|Concrete|Metal|HouseRuins|Cultural|BuildingParts/Industrial)/|/Walls/Wooden/WoodenWall_')
SEE_THROUGH = re.compile(r'/Walls/(Pole|Net|Pipe|Cemeteries)/|/Walls/Wooden/(WoodenRural_|WoodenFenceOld_)|/Walls/BuildingParts/Doors/')


def read_numbers(path):
    """A CSV of numbers (after its header line) as one flat float array."""
    with open(path, encoding='utf8') as f:
        head = f.readline()
        body = f.read()
    if not body.strip():
        return head, np.zeros(0)
    return head, np.array(body.replace('\n', ',').strip(',').split(','), dtype=np.float64)


def load_walls(src):
    """Every wall and fence piece: (kind, minx, minz, maxx, maxz, top_y, yaw), kind 1 solid / 2 see-through."""
    walls = []
    for fn in os.listdir(os.path.join(src, 'objects')):
        with open(os.path.join(src, 'objects', fn), encoding='utf8', errors='replace') as f:
            for r in csv.DictReader(f):
                p = r['prefab']
                if '/Walls/' not in p:
                    continue
                kind = 1 if SOLID.search(p) else 2 if SEE_THROUGH.search(p) else 0
                if not kind:
                    continue
                walls.append((kind, float(r['minx']), float(r['minz']), float(r['maxx']), float(r['maxz']),
                              float(r['maxy']), float(r['yaw'])))
    return np.array(walls, dtype=np.float64).reshape(-1, 7)


def wall_segment(w, top, kind, x0, z0):
    """The wall's centre line in this tile's cell coordinates (floats), picked from its bounding box.
    A thin piece runs along the box's long side; a diagonal one runs along whichever diagonal the scan
    saw more of it on."""
    _, minx, minz, maxx, maxz, _, _ = w
    cx0, cz0 = (minx - x0) / CELL, (minz - z0) / CELL
    cx1, cz1 = (maxx - x0) / CELL, (maxz - z0) / CELL
    wx, wz = maxx - minx, maxz - minz
    if wz < 0.8:
        zc = (cz0 + cz1) / 2
        return (cx0, zc, cx1, zc)
    if wx < 0.8:
        xc = (cx0 + cx1) / 2
        return (xc, cz0, xc, cz1)
    a = (cx0, cz0, cx1, cz1)
    b = (cx0, cz1, cx1, cz0)

    def hits(seg):
        xs, zs = line_cells(seg)
        return int(np.count_nonzero(kind[zs, xs] == 2)) if len(xs) else 0

    return a if hits(a) >= hits(b) else b


def line_cells(seg, n_max=S_N):
    """Cells (x, z) a segment passes through, sampled every quarter cell, inside the tile."""
    x0, z0, x1, z1 = seg
    n = int(max(abs(x1 - x0), abs(z1 - z0)) * 4) + 1
    t = np.linspace(0, 1, n)
    xs = np.floor(x0 + (x1 - x0) * t).astype(np.int64)
    zs = np.floor(z0 + (z1 - z0) * t).astype(np.int64)
    ok = (xs >= 0) & (xs < n_max) & (zs >= 0) & (zs < n_max)
    return xs[ok], zs[ok]


def load_objects(src):
    """Tree crowns (x, z, radius) and tall thin things - poles, lamps, masts - (x, z, top y), from the object list."""
    trees, poles = [], []
    for fn in os.listdir(os.path.join(src, 'objects')):
        with open(os.path.join(src, 'objects', fn), encoding='utf8', errors='replace') as f:
            for r in csv.DictReader(f):
                p = r['prefab']
                w = max(float(r['maxx']) - float(r['minx']), float(r['maxz']) - float(r['minz']))
                h = float(r['maxy']) - float(r['miny'])
                if '/Vegetation/Tree/' in p:
                    # the crown: the box's narrower side, as trees lean and the box includes the whole spread
                    rad = min(float(r['maxx']) - float(r['minx']), float(r['maxz']) - float(r['minz'])) / 2
                    trees.append((float(r['x']), float(r['z']), max(rad, 0.75)))
                elif '/Vegetation/' not in p and r['class'] not in ('RoadEntity', 'DecalEntity', 'LightEntity') and h >= 3 and w <= 1.5:
                    poles.append((float(r['x']), float(r['z']), float(r['maxy'])))
    return np.array(trees, np.float64).reshape(-1, 3), np.array(poles, np.float64).reshape(-1, 3)


def bake_tile(src, tx, tz, walls, trees=None, poles=None):
    x0, z0 = tx * TILE, tz * TILE

    # terrain: centimetres, sea floor clamped to the water line
    head, t = read_numbers(os.path.join(src, 'terrain', f't_{tx}_{tz}.csv'))
    if t.size != T_N * T_N:
        raise ValueError(f'terrain {tx},{tz}: {t.size} values')
    terrain = np.clip(t, 0, 65535).astype(np.uint16).reshape(T_N, T_N)

    top = np.zeros((S_N, S_N), np.uint8)
    bottom = np.zeros((S_N, S_N), np.uint8)
    kind = np.zeros((S_N, S_N), np.uint8)
    cover = np.zeros((S_N, S_N), np.uint8)

    # the ray scan: c, r, top dm, bottom dm, kind, cover dm
    _, s = read_numbers(os.path.join(src, 'surface', f's_{tx}_{tz}.csv'))
    if s.size:
        s = s.reshape(-1, 6).astype(np.int64)
        c, r = s[:, 0], s[:, 1]
        q = lambda dm: np.clip(np.round(dm / (Q * 10)), 0, 255).astype(np.uint8)
        t_q, b_q = q(s[:, 2]), q(s[:, 3])
        top[r, c] = t_q
        bottom[r, c] = np.minimum(b_q, t_q)  # a thin bush's underside can land a hair above its top
        kind[r, c] = s[:, 4]
        cover[r, c] = q(s[:, 5])

        # Below the sea the scan measured from the sea floor, but the map's ground is the water line: re-measure
        # from the water, and drop what stays under it (rocks and pier footings on the sea floor).
        floor = t.reshape(T_N, T_N)[:S_N // 2, :S_N // 2].repeat(2, 0).repeat(2, 1) / 100.0  # metres, per 0.5 m cell
        wet = (floor < 0) & (kind > 0)
        if wet.any():
            lift = lambda a: np.clip(np.round((floor[wet] + a[wet].astype(np.float64) * Q) / Q), 0, 255).astype(np.uint8)
            new_top, new_bottom, new_cover = lift(top), lift(bottom), lift(cover)
            gone = new_top * Q < 0.2
            top[wet], bottom[wet], cover[wet] = new_top, new_bottom, new_cover
            wz, wx = np.nonzero(wet)
            kind[wz[gone], wx[gone]] = 0
            top[wz[gone], wx[gone]] = 0
            bottom[wz[gone], wx[gone]] = 0
            cover[wz[gone], wx[gone]] = 0

    # walls overlapping this tile (from any tile)
    m = walls
    sel = (m[:, 3] >= x0) & (m[:, 1] <= x0 + TILE) & (m[:, 4] >= z0) & (m[:, 2] <= z0 + TILE)
    drawn = removed = 0
    for w in m[sel]:
        seg = wall_segment(w, None, kind, x0, z0)
        xs, zs = line_cells(seg)
        if not len(xs):
            continue
        # height above the ground under each cell (terrain is 1 m, cells 0.5 m)
        ground = terrain[np.minimum(zs // 2, T_N - 1), np.minimum(xs // 2, T_N - 1)] / 100.0
        h = np.clip(np.round((w[5] - ground) / Q), 0, 255).astype(np.uint8)
        if w[0] == 1:
            # solid: a continuous wall at its real height, never over a building
            free = kind[zs, xs] != 1
            xs, zs, h = xs[free], zs[free], h[free]
            kind[zs, xs] = 2
            top[zs, xs] = np.maximum(top[zs, xs], h)
            bottom[zs, xs] = 0
            drawn += len(xs)
        else:
            # see-through: whatever the rays hit on the fence line (up to the fence's own height) stops blocking
            for dx, dz in ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)):
                xx, zz = np.clip(xs + dx, 0, S_N - 1), np.clip(zs + dz, 0, S_N - 1)
                hit = (kind[zz, xx] == 2) & (top[zz, xx] <= h.astype(np.int16) + 2)
                kind[zz[hit], xx[hit]] = 4
                removed += int(np.count_nonzero(hit))
    # trees and bushes: vegetation outside every listed tree's crown is a bush
    if trees is not None:
        is_tree = np.zeros((S_N, S_N), bool)
        sel = (trees[:, 0] + trees[:, 2] >= x0) & (trees[:, 0] - trees[:, 2] <= x0 + TILE) & \
              (trees[:, 1] + trees[:, 2] >= z0) & (trees[:, 1] - trees[:, 2] <= z0 + TILE)
        for x, z, rad in trees[sel]:
            c0, c1 = int(max(0, (x - rad - x0) / CELL)), int(min(S_N - 1, (x + rad - x0) / CELL))
            r0, r1 = int(max(0, (z - rad - z0) / CELL)), int(min(S_N - 1, (z + rad - z0) / CELL))
            if c1 < c0 or r1 < r0:
                continue
            zz, xx = np.mgrid[r0:r1 + 1, c0:c1 + 1]
            inside = (x0 + (xx + 0.5) * CELL - x) ** 2 + (z0 + (zz + 0.5) * CELL - z) ** 2 <= rad * rad
            is_tree[zz[inside], xx[inside]] = True
        kind[(kind == 3) & ~is_tree] = 5
    # poles, lamps and masts: one solid 0.5 m spot at their full height
    if poles is not None:
        sel = (poles[:, 0] >= x0) & (poles[:, 0] < x0 + TILE) & (poles[:, 1] >= z0) & (poles[:, 1] < z0 + TILE)
        for x, z, ytop in poles[sel]:
            c, r = int((x - x0) / CELL), int((z - z0) / CELL)
            if kind[r, c] == 1:
                continue
            g = terrain[min(r // 2, T_N - 1), min(c // 2, T_N - 1)] / 100.0
            h = int(np.clip(round((ytop - max(g, 0)) / Q), 0, 255))
            if h * Q >= 3:
                kind[r, c] = 2
                top[r, c] = max(top[r, c], h)
                bottom[r, c] = 0
    return terrain, top, bottom, kind, cover, drawn, removed


LIGHT_N = 1280
LIGHT_CELL = 10
LB = int(LIGHT_CELL / CELL)  # surface cells per light cell side (20)
LT = TILE // LIGHT_CELL      # light cells per tile side (50)


def light_cells(terrain, top, bottom, kind):
    """This tile's 50 x 50 light cells: height (dm), forest flag, canopy top / underside (m), building height (m)."""
    idx = np.arange(LT) * LIGHT_CELL + LIGHT_CELL // 2           # terrain sample at each cell's centre (1 m grid)
    height = np.round(terrain[np.ix_(idx, idx)] / 10.0).astype(np.int16)  # cm -> dm

    def blocks(a):
        return a.reshape(LT, LB, LT, LB).transpose(0, 2, 1, 3).reshape(LT, LT, LB * LB)

    k, t, b = blocks(kind), blocks(top).astype(np.float32) * Q, blocks(bottom).astype(np.float32) * Q
    veg = ((k == 3) | (k == 5)) & (t >= 3)
    crown = veg.mean(axis=2)
    forest = crown >= 0.35
    # what blocks a level sight line at head height: trunks, bushes and low branches, plus rocks and clutter
    low = ((((k == 3) | (k == 5)) & (b <= 1.7) & (t >= 1.7)) | ((k == 2) & (t >= 1.7))).mean(axis=2)
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', RuntimeWarning)
        ctop = np.nanpercentile(np.where(veg, t, np.nan), 75, axis=2)
        cbot = np.nanmedian(np.where(veg, b, np.nan), axis=2)
    has = crown >= 0.1
    ctop = np.where(has, np.nan_to_num(ctop), 0)
    cbot = np.where(has, np.nan_to_num(cbot), 0)
    bld = k == 1
    bfrac = bld.mean(axis=2)
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', RuntimeWarning)
        bh = np.nanmedian(np.where(bld, t, np.nan), axis=2)
    bh = np.where(bfrac >= 0.4, np.nan_to_num(bh), 0)
    u8 = lambda a: np.clip(np.round(a), 0, 255).astype(np.uint8)
    return height, forest, u8(ctop), u8(cbot), u8(low * 255), u8(crown * 255), u8(bh)


# Helicopter landing rules (static/app.js uses the same ones for its landing zone check). Sized for the game's
# helicopters: the UH-1H's rotor reaches about 7.3 m from its mast and the Mi-8's about 10.7 m, its tail rotor ~13 m.
LZ_TOUCH = 6       # m: touchdown circle - anything 1 m+ on it is no-go (lower bushes and crops sit under the belly)
LZ_SLOPE_R = 8     # m: the best-fit slope over this circle is the landing slope
LZ_R = 15          # m: rotor circle (the Mi-8's tail plus a margin) - anything 2 m+ in it is no-go, and ground rising
                   #    1.5 m above the landing plane is no-go (0.75 m marginal)
LZ_NEAR = 40       # m: trees or buildings 6 m+ out to here make it marginal (a steeper way in)
LZ_OK_DEG, LZ_MAX_DEG = 17, 22
LZ_SPOT_H, LZ_ROTOR_H, LZ_NEAR_H = 1.0, 2.0, 6.0
LZ_BUMP_OK, LZ_BUMP_MAX = 0.75, 1.5


def bake_lz(out):
    """everon-lz.bin: the landing verdict at every 10 m cell's centre, from the baked full tiles."""
    from functools import lru_cache

    @lru_cache(maxsize=12)
    def load(tx, tz):
        path = os.path.join(out, f'{tx}_{tz}.bin.gz')
        if not os.path.exists(path):
            return None
        raw = gzip.decompress(open(path, 'rb').read())
        ter = np.frombuffer(raw, '<u2', T_N * T_N).reshape(T_N, T_N).astype(np.float32) / 100
        o = T_N * T_N * 2
        top = np.frombuffer(raw, np.uint8, S_N * S_N, o).reshape(S_N, S_N)
        kind = np.frombuffer(raw, np.uint8, S_N * S_N, o + 2 * S_N * S_N).reshape(S_N, S_N)
        # obstacle height at 1 m (the tallest thing in each 2 x 2 of 0.5 m cells): buildings, walls, rocks, poles,
        # trees and fences; bushes and low plants don't harm a helicopter
        h = np.where((kind > 0) & (kind != 5), top.astype(np.float32) * Q, 0).reshape(TILE, 2, TILE, 2).max(axis=(1, 3))
        return ter, h

    M = LZ_NEAR  # margin in metres (1 m grid)
    ys, xs = np.mgrid[-M:M + 1, -M:M + 1]
    rr = np.hypot(xs, ys)
    touch, rotor, near = rr <= LZ_TOUCH, (rr > LZ_TOUCH) & (rr <= LZ_R), (rr > LZ_R) & (rr <= LZ_NEAR)
    disc_r = rr <= LZ_R
    sdisc = rr <= LZ_SLOPE_R
    # least-squares plane over a centred disc: slope along x = sum(x z) / sum(x^2)
    tx_w, tz_w = (xs * sdisc).astype(np.float32), (ys * sdisc).astype(np.float32)
    sxx = float((xs ** 2 * sdisc).sum())
    rx_w, rz_w = (xs * disc_r).astype(np.float32), (ys * disc_r).astype(np.float32)
    rxx, rn = float((xs ** 2 * disc_r).sum()), float(disc_r.sum())
    grid = np.zeros((26 * 50, 26 * 50), np.uint8)
    names = json.load(open(os.path.join(out, 'index.json')))['tiles']
    for name in names:
        tx, tz = map(int, name.split('_'))
        W = TILE + 2 * M + 1
        ter = np.zeros((W, W), np.float32)
        obs = np.zeros((W, W), np.float32)
        for dz in (-1, 0, 1):
            for dx in (-1, 0, 1):
                t = load(tx + dx, tz + dz)
                if t is None:
                    continue
                # where this neighbour's 1 m samples land in the window (window x = local x + M)
                x0, z0 = dx * TILE + M, dz * TILE + M
                a0, b0 = max(0, -x0), max(0, -z0)
                a1, b1 = min(TILE, W - x0), min(TILE, W - z0)
                if a1 <= a0 or b1 <= b0:
                    continue
                ter[z0 + b0:z0 + b1, x0 + a0:x0 + a1] = t[0][b0:b1, a0:a1]
                obs[z0 + b0:z0 + b1, x0 + a0:x0 + a1] = t[1][b0:b1, a0:a1]
        cz = np.arange(LIGHT_CELL // 2, TILE, LIGHT_CELL) + M  # 10 m cell centres in window coordinates
        view = lambda a: np.lib.stride_tricks.sliding_window_view(a, (2 * M + 1, 2 * M + 1))[cz - M][:, cz - M]
        T, O = view(ter), view(obs)                         # (50, 50, 81, 81)
        h0 = T[:, :, M, M]
        zc = T - T[:, :, M:M + 1, M:M + 1]
        ax = (zc * tx_w).sum((2, 3)) / sxx; az = (zc * tz_w).sum((2, 3)) / sxx
        slope = np.degrees(np.arctan(np.hypot(ax, az)))
        # uneven ground: highest rise above the rotor-circle plane
        bx = (zc * rx_w).sum((2, 3)) / rxx; bz = (zc * rz_w).sum((2, 3)) / rxx
        c0 = (zc * disc_r).sum((2, 3)) / rn
        plane = c0[:, :, None, None] + bx[:, :, None, None] * xs + bz[:, :, None, None] * ys
        bump = np.where(disc_r, zc - plane, -9).max((2, 3))
        o_touch = np.where(touch, O, 0).max((2, 3))
        o_rotor = np.where(rotor, O, 0).max((2, 3))
        o_near = np.where(near, O, 0).max((2, 3))
        nogo = (o_touch >= LZ_SPOT_H) | (o_rotor >= LZ_ROTOR_H) | (slope > LZ_MAX_DEG) | (bump > LZ_BUMP_MAX)
        marg = (o_near >= LZ_NEAR_H) | (slope > LZ_OK_DEG) | (bump > LZ_BUMP_OK)
        v = np.where(h0 < 0.5, 0, np.where(nogo, 3, np.where(marg, 2, 1))).astype(np.uint8)
        grid[tz * 50:(tz + 1) * 50, tx * 50:(tx + 1) * 50] = v
    light = os.path.join(os.path.dirname(out), 'light')
    write_light(light, 'everon-lz.bin', grid[:LIGHT_N, :LIGHT_N])
    land = grid[:LIGHT_N, :LIGHT_N] > 0
    print(f'Landing grid: good {np.mean(grid[:LIGHT_N, :LIGHT_N][land] == 1):.0%}, marginal {np.mean(grid[:LIGHT_N, :LIGHT_N][land] == 2):.0%}, '
          f'no-go {np.mean(grid[:LIGHT_N, :LIGHT_N][land] == 3):.0%} of land cells')


def write_light(folder, name, arr):
    """One light file, gzipped (about a seventh of the download); the page unpacks it."""
    with open(os.path.join(folder, name + '.gz'), 'wb') as f:
        f.write(gzip.compress(np.ascontiguousarray(arr).tobytes(), 9, mtime=0))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--src', default=os.path.expanduser('~/Documents/My Games/ArmaReforgerWorkbench/profile/everon_los'))
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'static', 'data', 'los'))
    ap.add_argument('--tiles', default='', help='only these tiles, e.g. "9_13,10_13" (for testing)')
    ap.add_argument('--lz-only', action='store_true', help='only redo the landing grid from the tiles already baked')
    args = ap.parse_args()
    out = os.path.normpath(args.out)
    os.makedirs(out, exist_ok=True)
    if args.lz_only:
        bake_lz(out)
        return

    t0 = time.time()
    print('Reading walls and fences from the object list...', flush=True)
    walls = load_walls(args.src)
    print(f'  {int((walls[:, 0] == 1).sum()):,} solid pieces, {int((walls[:, 0] == 2).sum()):,} see-through ({time.time() - t0:.0f} s)', flush=True)
    trees, poles = load_objects(args.src)
    print(f'  {len(trees):,} trees, {len(poles):,} poles, lamps and masts ({time.time() - t0:.0f} s)', flush=True)

    names = sorted({re.search(r't_(\d+)_(\d+)', f).group(0)[2:] for f in os.listdir(os.path.join(args.src, 'terrain'))},
                   key=lambda n: tuple(map(int, n.split('_')))[::-1])
    if args.tiles:
        names = [n for n in names if n in set(args.tiles.split(','))]
    tiles, total_bytes, stats = [], 0, dict(drawn=0, removed=0, blocked=0)
    big = 26 * LT  # light grids for the whole tile range, cropped to 1280 at the end
    L_height = np.zeros((big, big), np.int16)
    L_forest = np.zeros((big, big), bool)
    L_ctop = np.zeros((big, big), np.uint8)
    L_cbot = np.zeros((big, big), np.uint8)
    L_low = np.zeros((big, big), np.uint8)
    L_crown = np.zeros((big, big), np.uint8)
    L_bld = np.zeros((big, big), np.uint8)
    for i, name in enumerate(names):
        tx, tz = map(int, name.split('_'))
        terrain, top, bottom, kind, cover, drawn, removed = bake_tile(args.src, tx, tz, walls, trees, poles)
        stats['drawn'] += drawn
        stats['removed'] += removed
        stats['blocked'] += int(np.count_nonzero((kind > 0) & (kind != 4)))
        h, fo, ct, cb, lo, cr, bh = light_cells(terrain, top, bottom, kind)
        sl = (slice(tz * LT, (tz + 1) * LT), slice(tx * LT, (tx + 1) * LT))
        L_height[sl], L_forest[sl], L_ctop[sl], L_cbot[sl], L_low[sl], L_crown[sl], L_bld[sl] = h, fo, ct, cb, lo, cr, bh
        if not terrain.any() and not kind.any():
            continue  # open sea: nothing to load
        raw = terrain.astype('<u2').tobytes() + top.tobytes() + bottom.tobytes() + kind.tobytes() + cover.tobytes()
        path = os.path.join(out, f'{name}.bin.gz')
        with open(path, 'wb') as f:
            f.write(gzip.compress(raw, 6))
        total_bytes += os.path.getsize(path)
        tiles.append(name)
        if (i + 1) % 25 == 0 or i + 1 == len(names):
            print(f'  {i + 1}/{len(names)} tiles, {len(tiles)} written, {total_bytes / 1e6:.0f} MB ({time.time() - t0:.0f} s)', flush=True)

    light = os.path.join(os.path.dirname(out), 'light')
    os.makedirs(light, exist_ok=True)
    n = LIGHT_N
    write_light(light, 'everon-height.bin', L_height[:n, :n].astype('<i2'))
    write_light(light, 'everon-forest.bin', np.packbits(L_forest[:n, :n].reshape(-1)))  # MSB first, like the old file
    write_light(light, 'everon-canopy.bin', np.concatenate([a[:n, :n].reshape(-1) for a in (L_ctop, L_cbot, L_low, L_crown)]))
    write_light(light, 'everon-buildings.bin', L_bld[:n, :n])
    print(f'Light version in {light}: forest cells {int(L_forest[:n, :n].sum()):,}, '
          f'building cells {int((L_bld[:n, :n] > 0).sum()):,}, median canopy top '
          f'{float(np.median(L_ctop[:n, :n][L_forest[:n, :n]])) if L_forest.any() else 0:.0f} m')

    # version: tile URLs carry it, so browsers fetch a re-bake afresh
    index = {
        'version': int(time.time()), 'tile': TILE, 'terrain': {'n': T_N, 'step': 1, 'unit': 0.01},
        'surface': {'n': S_N, 'step': CELL, 'unit': Q},
        'kinds': {'0': 'nothing', '1': 'building', '2': 'solid', '3': 'tree', '4': 'see-through fence', '5': 'bush'},
        'layout': ['terrain Uint16', 'top Uint8', 'bottom Uint8', 'kind Uint8', 'cover Uint8'],
        'tiles': tiles,
    }
    with open(os.path.join(out, 'index.json'), 'w') as f:
        json.dump(index, f)
    print(f'Done: {len(tiles)} tiles, {total_bytes / 1e6:.0f} MB in {out}')
    if not args.tiles:
        bake_lz(out)
    print(f'  wall cells drawn in: {stats["drawn"]:,}; fence cells made see-through: {stats["removed"]:,}; '
          f'blocking cells: {stats["blocked"]:,} ({time.time() - t0:.0f} s)')


if __name__ == '__main__':
    sys.exit(main())

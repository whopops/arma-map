"""Check static/data/roads.json against the printed map it was traced from, and list anything that looks wrong.

  breaks     a road that stops where the printed road carries on (a gap that wasn't closed)
  missing    printed road with no traced line within MISS_M (at least MISS_LEN_M long)
  stray      traced road with no printed road under it for STRAY_LEN_M or more
  paths      foot path dashes with no traced path near them (runs of three or more)
  kinks      sharp bends inside a line (the smoothing should have taken these out)
  doubles    two junctions within 3 m of each other that aren't joined
It also prints how the network hangs together (connected pieces).

Run:  python tools/check_roads.py [--roads static/data/roads.json] [--sheet out_folder]
      --sheet also writes a picture of each problem spot (the traced network over the printed map).
"""

import argparse
import json
import math
import os
import sys
from collections import Counter

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
from skimage import morphology, measure

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract_roads as ex  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MISS_M, MISS_LEN_M = 6, 25
STRAY_LEN_M = 25
KINK_DEG = 60


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--roads', default=os.path.join(ROOT, 'static', 'data', 'roads.json'))
    ap.add_argument('--src', default=os.path.join(HERE, 'roads', 'Everon-1989.jpg'))
    ap.add_argument('--sheet', help='folder for pictures of the problem spots')
    args = ap.parse_args()
    R = json.load(open(args.roads, encoding='utf8'))
    nodes, edges = R['nodes'], R['edges']
    s = ex.CAL['s']
    im = Image.open(args.src).convert('RGB')
    c0, r0 = (int(v) for v in ex.world_to_px(0, ex.WORLD))
    c1, r1 = (int(v) for v in ex.world_to_px(ex.WORLD, 0))
    rgb = np.asarray(im.crop((c0, r0, c1, r1)))
    H, W = rgb.shape[:2]

    def px(x, z):
        c, r = ex.world_to_px(x, z)
        return c - c0, r - r0

    def world(col, row):
        return ex.px_to_world(col + c0, row + r0)

    # the printed roads, as extract_roads sees them (colour, no hill-name lettering, no specks)
    road = np.zeros((H, W), bool)
    for a in range(0, H, 2048):
        band = rgb[a:a + 2048].astype(np.int16)
        lab = ex.classify(rgb[a:a + 2048])
        brown = ndi.binary_dilation((band[..., 0] - band[..., 2] > 60) & (band[..., 1] < 140) & (band[..., 0] < 215), iterations=3)
        road[a:a + 2048] = (lab != 255) & ~brown
    road = morphology.remove_small_objects(road, max_size=int((ex.MIN_BLOB_M * s) ** 2 * 0.12))

    # the traced network, drawn MISS_M wide
    traced = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(traced)
    for a, b, k, p in edges:
        if k < 3:
            d.line([px(*q) for q in p], fill=255, width=int(2 * MISS_M * s))
    traced = np.asarray(traced) > 0
    problems = []

    # missing: printed road centre lines away from any traced road
    sk = morphology.skeletonize(road)
    miss = sk & ~traced
    lab, n = ndi.label(miss, structure=np.ones((3, 3)))
    sizes = np.bincount(lab.ravel())
    objs = ndi.find_objects(lab)
    for i, sl in enumerate(objs, 1):
        if sl is None or sizes[i] < MISS_LEN_M * s:
            continue
        rr, cc = np.nonzero(lab[sl] == i)
        m = len(rr) // 2
        problems.append(('missing', world(cc[m] + sl[1].start, rr[m] + sl[0].start), round(sizes[i] / s)))
    del sk, miss, lab

    # stray: traced road over plain map, with no printed road (or a label, icon or line drawn over one) near it
    plain = np.zeros((H, W), bool)
    for a in range(0, H, 2048):
        plain[a:a + 2048] = ex.open_ground(rgb[a:a + 2048])
    near = ndi.binary_dilation(road | ~plain, iterations=int(3 * s))
    del plain
    for a, b, k, p in edges:
        if k >= 3:
            continue
        run, start = 0.0, None
        pts = np.array(p)
        for (x0, z0), (x1, z1) in zip(pts[:-1], pts[1:]):
            L = math.hypot(x1 - x0, z1 - z0)
            for t in np.arange(0, L, 2.0):
                x, z = x0 + (x1 - x0) * t / L, z0 + (z1 - z0) * t / L
                cc, rr = px(x, z)
                ok = not (0 <= int(rr) < H and 0 <= int(cc) < W) or near[int(rr), int(cc)]
                if ok:
                    if run >= STRAY_LEN_M:
                        problems.append(('stray', start, round(run)))
                    run, start = 0.0, None
                else:
                    run += 2.0
                    start = start or (round(x), round(z))
        if run >= STRAY_LEN_M:
            problems.append(('stray', start, round(run)))
    del near

    # breaks: a road end with printed road carrying on straight ahead of it
    deg = Counter()
    for a, b, k, p in edges:
        deg[a] += 1
        deg[b] += 1
    for a, b, k, p in edges:
        if k >= 3:
            continue
        for nd, pts in ((a, p), (b, p[::-1])):
            if deg[nd] != 1:
                continue
            e = np.array(pts[0], float)
            back = np.array(pts[min(len(pts) - 1, 1)], float)
            for q in pts[1:]:
                if math.hypot(q[0] - e[0], q[1] - e[1]) > 10:
                    back = np.array(q, float)
                    break
            u = e - back
            u /= (np.hypot(*u) or 1)
            gap, found = False, None
            for t in np.arange(3, 45, 1.0):
                x, z = e + u * t
                cc, rr = px(x, z)
                if not (0 <= int(rr) < H and 0 <= int(cc) < W):
                    break
                hit = road[max(0, int(rr) - 2):int(rr) + 3, max(0, int(cc) - 2):int(cc) + 3].any()
                if not hit:
                    gap = True
                elif gap:
                    found = t
                    break
            if found:
                problems.append(('break', (round(e[0]), round(e[1])), round(found)))

    # foot paths: dashes with no traced path near them
    dash_pts = dashes(rgb, s)
    paths = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(paths)
    for a, b, k, p in edges:
        d.line([px(*q) for q in p], fill=255, width=int(2 * 8 * s))
    paths = np.asarray(paths) > 0
    lost = np.array([q for q in dash_pts if not paths[int(q[0]), int(q[1])]]) if len(dash_pts) else np.zeros((0, 2))
    print(f'foot path dashes: {len(dash_pts)}, not on a traced line: {len(lost)}')
    if len(lost):
        from scipy.spatial import cKDTree
        tr = cKDTree(lost)
        uf = list(range(len(lost)))

        def f(x):
            while uf[x] != x:
                uf[x] = uf[uf[x]]
                x = uf[x]
            return x
        for i, j in tr.query_pairs(30 * s):
            uf[f(i)] = f(j)
        groups = Counter(f(i) for i in range(len(lost)))
        for g, n in groups.items():
            if n >= 3:
                q = lost[g]
                problems.append(('paths', world(q[1], q[0]), n))

    # kinks and doubles
    for a, b, k, p in edges:
        pts = np.array(p)
        for i in range(1, len(pts) - 1):
            v1, v2 = pts[i] - pts[i - 1], pts[i + 1] - pts[i]
            if np.hypot(*v1) < 0.3 or np.hypot(*v2) < 0.3:
                continue
            ang = math.degrees(math.acos(np.clip(v1 @ v2 / np.hypot(*v1) / np.hypot(*v2), -1, 1)))
            if ang > KINK_DEG:
                problems.append(('kink', (round(pts[i][0]), round(pts[i][1])), round(ang)))
    from scipy.spatial import cKDTree
    adj = set()
    for a, b, k, p in edges:
        adj |= {(a, b), (b, a)}
    for i, j in cKDTree(np.array(nodes)).query_pairs(3.0):
        if (i, j) not in adj:
            problems.append(('double', tuple(round(v) for v in nodes[i]), j))

    # how it hangs together
    par = {}

    def find(x):
        par.setdefault(x, x)
        while par[x] != x:
            par[x] = par[par[x]]
            x = par[x]
        return x
    for a, b, k, p in edges:
        par[find(a)] = find(b)
    tot = Counter()
    km = Counter()
    for a, b, k, p in edges:
        L = float(np.hypot(*np.diff(np.array(p), axis=0).T).sum())
        tot[find(a)] += L
        km[k] += L
    big = sorted(tot.values(), reverse=True)
    print('km by kind (0 main, 1 street, 2 dirt, 3 foot path):', {k: round(v / 1000, 1) for k, v in sorted(km.items())})
    print(f'{len(big)} connected pieces; biggest {[round(v / 1000, 2) for v in big[:6]]} km; '
          f'{sum(v for v in big[1:]) / 1000:.1f} km outside the biggest')
    print(f'road ends: {sum(1 for a, b, k, p in edges for nd in (a, b) if deg[nd] == 1 and k < 3)}')
    kinds = Counter(p[0] for p in problems)
    print('problems:', dict(kinds))
    for p in sorted(problems, key=lambda p: (p[0], -p[2])):
        print(f'  {p[0]:8} x {p[1][0]:>6} z {p[1][1]:>6}   {p[2]}')
    if args.sheet:
        os.makedirs(args.sheet, exist_ok=True)
        for i, (kind, (x, z), v) in enumerate(p for p in problems if p[0] in ('break', 'missing', 'stray', 'paths')):
            spot(rgb, edges, nodes, deg, x, z, px, os.path.join(args.sheet, f'{kind}_{i:03d}_{int(x)}_{int(z)}.png'))
    json.dump([[p[0], p[1], p[2]] for p in problems], open(os.path.join(HERE, 'roads', 'problems.json'), 'w'))


def dashes(rgb, s):
    """Centres (row, col) of the foot path dashes on the printed map, as extract_roads finds them (so this checks the
    tracing and linking of the dashes; tools/roads spot pictures show what the dash finder itself misses)."""
    return np.array([coords.mean(axis=0) for coords, tips in ex.find_dashes(rgb)])


def spot(rgb, edges, nodes, deg, x, z, px, path, half=90):
    cc, rr = px(x, z)
    s = ex.CAL['s']
    a0, b0 = int(cc - half * s), int(rr - half * s)
    crop = Image.fromarray(rgb[max(0, b0):int(rr + half * s), max(0, a0):int(cc + half * s)].copy())
    crop = Image.blend(crop, Image.new('RGB', crop.size, (255, 255, 255)), 0.3).resize((crop.width * 3, crop.height * 3))
    d = ImageDraw.Draw(crop)
    col = {0: (220, 0, 0), 1: (0, 90, 255), 2: (0, 160, 0), 3: (200, 0, 200)}

    def tp(q):
        c, r = px(*q)
        return ((c - max(0, a0)) * 3, (r - max(0, b0)) * 3)
    for a, b, k, p in edges:
        if any(abs(q[0] - x) < half + 60 and abs(q[1] - z) < half + 60 for q in p):
            d.line([tp(q) for q in p], fill=col[k], width=3)
    for i, q in enumerate(nodes):
        if abs(q[0] - x) < half and abs(q[1] - z) < half and deg[i] == 1:
            c, r = tp(q)
            d.ellipse((c - 8, r - 8, c + 8, r + 8), outline=(255, 120, 0), width=3)
    c, r = tp((x, z))
    d.rectangle((c - 20, r - 20, c + 20, r + 20), outline=(0, 0, 0), width=2)
    crop.save(path)


if __name__ == '__main__':
    sys.exit(main())

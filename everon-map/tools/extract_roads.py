"""Trace Everon's roads and paths from the printed topographic map image, for the map's vehicle route planner.

Input:  a big picture of the map (tools/roads/Everon-1989.jpg, 16100 x 16100 px, ~1.12 px per metre). Roads are drawn in flat
        colours: bright yellow main roads, cream yellow streets, tan dirt roads (and dashed grey foot paths).
Output: tools/roads/roads.raw.json  what the picture shows, before tools/link_roads.py joins, smooths and writes it:
        {"nodes": [[x, z], ...], "edges": [[a, b, kind, [[x, z], ...]], ...], "paths": [[[x, z], ...], ...]}
        x, z in metres like the rest of the map; a and b are node numbers (the edge's ends), kind is
        0 main road, 1 street, 2 dirt road; each path is a chain of dashes of a foot path, in order.

How: colour picks out each kind of road, a small closing bridges the grid lines, labels and icons drawn across them,
the picture is thinned to a one-pixel skeleton, short spurs are trimmed, and the skeleton is walked into edges between
junctions and ends (skan). Pixels are tied to map metres by the water line: the image's sea matches the game's
heightmap best at CAL below (a scale and offset found by matching the two water masks; roads then land within a few metres
of the satellite roads across the island).

Foot paths are drawn as dashed dark grey lines, so they are found as short dark grey dashes (not the black power lines
or the grid) and chained together where they line up.

Needs: numpy, scipy, pillow, scikit-image, skan.
Run:   python tools/extract_roads.py [--src tools/roads/Everon-1989.jpg] [--box x0 z0 x1 z1] [--preview out.png]
"""

import argparse
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage as ndi
from skimage import morphology
from skan import Skeleton, summarize

Image.MAX_IMAGE_PIXELS = None
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# Picture pixel of the world's north-west corner (x = 0, z = 12800) and pixels per metre (see the docstring)
CAL = {'x0': 444.0, 'y0': 1344.0, 's': 1.1184}
WORLD = 12800
COLOURS = {  # kind -> the flat colour the map draws it in
    0: (254, 245, 104),   # main road
    1: (255, 250, 182),   # street
    2: (215, 186, 152),   # dirt road
}
NEAR = 34            # colour distance that counts as "this colour"
MIN_BLOB_M = 40      # metres: smaller pieces are labels and icons
SPUR_M = 18          # metres: dead-end stubs shorter than this are skeleton noise
SIMPLIFY_M = 1.6     # metres: how far the traced line may stray from the skeleton


def world_to_px(x, z):
    return CAL['x0'] + CAL['s'] * x, CAL['y0'] + CAL['s'] * (WORLD - z)


def px_to_world(col, row):
    return (col - CAL['x0']) / CAL['s'], WORLD - (row - CAL['y0']) / CAL['s']


def classify(rgb):
    """kind per pixel (255 = none) by the nearest road colour."""
    a = rgb.astype(np.int32)
    best = np.full(a.shape[:2], 255, np.uint8)
    bestd = np.full(a.shape[:2], NEAR * NEAR + 1, np.int32)
    for kind, c in COLOURS.items():
        d = ((a - np.array(c, np.int32)) ** 2).sum(axis=2)
        better = d < bestd
        best[better] = kind
        bestd[better] = d[better]
    return best


def rdp(pts, eps):
    """Ramer-Douglas-Peucker on an (n, 2) array."""
    if len(pts) < 3:
        return pts
    keep = np.zeros(len(pts), bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        a, b = pts[i], pts[j]
        d = b - a
        L = np.hypot(*d)
        seg = pts[i + 1:j] - a
        dist = np.abs(seg[:, 0] * d[1] - seg[:, 1] * d[0]) / L if L else np.hypot(seg[:, 0], seg[:, 1])
        k = int(np.argmax(dist))
        if dist[k] > eps:
            keep[i + 1 + k] = True
            stack += [(i, i + 1 + k), (i + 1 + k, j)]
    return pts[keep]


def trace(labels, ppm):
    """labels: kind per pixel (255 none). Returns nodes (px) and edges (a, b, kind, pixel path)."""
    mask = labels != 255
    mask = ndi.binary_closing(mask, morphology.disk(2))
    mask = morphology.remove_small_objects(mask, max(20, int((MIN_BLOB_M * ppm) ** 2 * 0.12)))
    sk = morphology.skeletonize(mask)
    for _ in range(2):  # trim dead-end stubs, then re-thin
        if not sk.any():
            break
        g = Skeleton(sk, keep_images=False)
        tab = summarize(g, separator='_')
        short = tab[(tab['branch_type'] == 1) & (tab['branch_distance'] < SPUR_M * ppm)]
        if short.empty:
            break
        deg = ndi.convolve(sk.astype(np.uint8), np.ones((3, 3), np.uint8), mode='constant') - 1  # neighbours of each pixel
        for i in short.index:
            c = g.path_coordinates(i)  # runs between a junction and a tip, either way round; keep the junction's pixel
            tip_first = deg[int(c[0][0]), int(c[0][1])] == 1
            rows = c[:-1] if tip_first else c[1:]
            sk[rows[:, 0].astype(int), rows[:, 1].astype(int)] = False
        sk = morphology.skeletonize(sk)
    g = Skeleton(sk, keep_images=False)
    tab = summarize(g, separator='_')
    nodes, key, edges = [], {}, []

    def node(p):
        k = (int(p[0]), int(p[1]))
        if k not in key:
            key[k] = len(nodes)
            nodes.append(k)
        return key[k]

    for i in tab.index:
        c = g.path_coordinates(i).astype(int)
        if len(c) < 2:
            continue
        ks = labels[c[:, 0], c[:, 1]]
        ks = ks[ks != 255]
        kind = int(np.bincount(ks, minlength=3).argmax()) if len(ks) else 2
        edges.append((node(c[0]), node(c[-1]), kind, c))
    return nodes, edges



DASH_MAX_GAP_M = 30   # metres between two dashes of one path
DASH_TURN = 45        # degrees a path may bend between neighbouring dashes


def find_paths(rgb, ppm):
    """Chains of dark grey dashes: each a list of (row, col) points in order along the foot path."""
    from skimage import measure
    h, w = rgb.shape[:2]
    dash = np.zeros((h, w), bool)
    black = np.zeros((h, w), bool)
    coldark = np.zeros(w)
    rowdark = np.zeros(h)
    for a in range(0, h, 2048):
        band = rgb[a:a + 2048].astype(np.int16)
        mx, mn = band.max(axis=2), band.min(axis=2)
        dash[a:a + 2048] = (mx <= 110) & (mn >= 45) & (mx - mn <= 16)
        black[a:a + 2048] = mx < 45
        d = mx < 90
        coldark += d.sum(axis=0)
        rowdark[a:a + 2048] = d.sum(axis=1)
    # the grid: whole columns and rows that are mostly dark; and the black lines (power lines) with their soft edges
    skip = ndi.binary_dilation(black, iterations=3)
    for arr, n, lines_axis in ((coldark, h, 1), (rowdark, w, 0)):
        for i in np.where(arr > 0.25 * n)[0]:
            if lines_axis:
                skip[:, max(0, i - 2):i + 3] = True
            else:
                skip[max(0, i - 2):i + 3, :] = True
    dash &= ~skip
    del black, skip
    lab = measure.label(dash, connectivity=2)
    del dash
    area = np.bincount(lab.ravel())
    ok = (area >= 10) & (area <= 200)
    ok[0] = False
    keep = np.where(ok)[0]
    remap = np.zeros(len(area), np.int32)
    remap[keep] = np.arange(1, len(keep) + 1)
    lab = remap[lab]
    props = measure.regionprops(lab)
    ends = []  # (p, q) end points of each dash, (row, col) floats
    for r in props:
        if r.major_axis_length < 6 or r.minor_axis_length > 5.5:
            continue
        c = r.coords.astype(float)
        m = c.mean(axis=0)
        u, s, vt = np.linalg.svd(c - m, full_matrices=False)
        t = (c - m) @ vt[0]
        ends.append((m + vt[0] * t.min(), m + vt[0] * t.max()))
    del lab
    print(len(ends), 'dashes')
    if not ends:
        return []
    from scipy.spatial import cKDTree
    P = np.array([e[0] for e in ends]); Q = np.array([e[1] for e in ends])
    pts = np.vstack([P, Q])            # 0..n-1 first ends, n..2n-1 second ends
    n = len(ends)
    tree = cKDTree(pts)
    link = {}
    gap = DASH_MAX_GAP_M * ppm
    def unit(v):
        L = np.hypot(*v)
        return v / L if L else v
    for i in range(2 * n):
        d = i % n
        me = pts[i]
        out = unit(pts[i] - pts[(i + n) % (2 * n)])   # pointing out of this end
        best = None
        for j in tree.query_ball_point(me, gap):
            if j % n == d:
                continue
            v = pts[j] - me
            L = np.hypot(*v)
            if L < 0.5:
                continue
            other = unit(pts[j] - pts[(j + n) % (2 * n)])
            # the gap runs the way this dash points, and the next dash points the same way along
            if np.degrees(np.arccos(np.clip(unit(v) @ out, -1, 1))) > DASH_TURN or np.degrees(np.arccos(np.clip(unit(v) @ -other, -1, 1))) > DASH_TURN:
                continue
            if best is None or L < best[0]:
                best = (L, j)
        if best:
            link[i] = best[1]
    # keep only links both ends agree on, then walk each chain of dashes from its free end
    mutual = {i: j for i, j in link.items() if link.get(j) == i}
    other = lambda i: (i + n) % (2 * n)   # the far end of the same dash
    chains, seen = [], set()
    for d0 in range(n):
        if d0 in seen:
            continue
        e, walked = d0, {d0}
        while e in mutual or False:       # back along the chain to its start
            prev = other(mutual[e])
            if prev % n in walked:
                break
            walked.add(prev % n)
            e = prev
        chain = []
        while True:
            d = e % n
            if d in seen:
                break
            seen.add(d)
            chain += [pts[e], pts[other(e)]]
            nxt = mutual.get(other(e))
            if nxt is None:
                break
            e = nxt
        if len(chain) >= 6:               # three dashes or more
            chains.append(np.array(chain))
    print(len(chains), 'chains of dashes')
    return chains


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--src', default=os.path.join(HERE, 'roads', 'Everon-1989.jpg'))
    ap.add_argument('--box', type=float, nargs=4, metavar=('X0', 'Z0', 'X1', 'Z1'), help='only this part of the world, metres')
    ap.add_argument('--out', default=os.path.join(HERE, 'roads', 'roads.raw.json'))
    ap.add_argument('--preview', help='write a picture of the traced roads over the map')
    args = ap.parse_args()
    im = Image.open(args.src).convert('RGB')
    bx0, bz0, bx1, bz1 = args.box or (0, 0, WORLD, WORLD)
    c0, r1 = world_to_px(bx0, bz0)
    c1, r0 = world_to_px(bx1, bz1)
    c0, r0, c1, r1 = int(c0), int(r0), int(c1), int(r1)
    rgb = np.asarray(im.crop((c0, r0, c1, r1)))
    print('picture', rgb.shape[1], 'x', rgb.shape[0])
    labels = np.full(rgb.shape[:2], 255, np.uint8)
    for a in range(0, rgb.shape[0], 2048):  # in bands, to keep memory down
        labels[a:a + 2048] = classify(rgb[a:a + 2048])
    nodes, edges = trace(labels, CAL['s'])
    print(len(nodes), 'nodes', len(edges), 'edges')
    paths = find_paths(rgb, CAL['s'])
    eps = SIMPLIFY_M * CAL['s']
    out_nodes = [[round(v, 1) for v in px_to_world(n[1] + c0, n[0] + r0)] for n in nodes]
    out_edges = []
    for a, b, kind, path in edges:
        pts = rdp(path.astype(float), eps)
        w = [[round(v, 1) for v in px_to_world(p[1] + c0, p[0] + r0)] for p in pts]
        w[0], w[-1] = out_nodes[a], out_nodes[b]  # ends sit exactly on their junctions
        out_edges.append([a, b, kind, w])
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w', encoding='utf8') as f:
        out_paths = [[[round(v, 1) for v in px_to_world(p[1] + c0, p[0] + r0)] for p in ch] for ch in paths]
        json.dump({'note': 'made by tools/extract_roads.py; see there', 'nodes': out_nodes, 'edges': out_edges, 'paths': out_paths}, f, separators=(',', ':'))
    print('wrote', args.out, round(os.path.getsize(args.out) / 1e6, 2), 'MB')
    if args.preview:
        from PIL import ImageDraw
        pv = Image.fromarray(rgb.copy())
        d = ImageDraw.Draw(pv)
        col = {0: (220, 0, 0), 1: (0, 120, 255), 2: (0, 170, 0)}
        for a, b, kind, path in edges:
            d.line([(int(p[1]), int(p[0])) for p in path], fill=col[kind], width=3)
        for ch in paths:
            d.line([(int(p[1]), int(p[0])) for p in ch], fill=(255, 0, 255), width=3)
        pv.save(args.preview)


if __name__ == '__main__':
    sys.exit(main())

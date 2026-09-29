"""Trace Everon's roads and paths from the printed topographic map image, for the map's vehicle route planner.

Input:  a big picture of the map (tools/roads/Everon-1989.jpg, 16100 x 16100 px, ~1.12 px per metre). Roads are drawn in flat
        colours: bright yellow main roads, cream yellow streets, tan dirt roads (and dashed grey foot paths).
Output: tools/roads/roads.raw.json  what the picture shows, before tools/link_roads.py joins, smooths and writes it:
        {"nodes": [[x, z], ...], "edges": [[a, b, kind, [[x, z], ...]], ...], "paths": [[[x, z], ...], ...]}
        x, z in metres like the rest of the map; a and b are node numbers (the edge's ends), kind is
        0 main road, 1 street, 2 dirt road; each path is a traced foot path, in order.

How: colour picks out each kind of road (hill names are brown lettering whose soft edges pass through the dirt road
colour, so they're blanked first). Whatever is drawn across a road - a label's letters, an icon, a river, a power line,
the grid - is bridged by closing the road picture, filling only pixels that aren't plain ground (grey or green), so two
roads side by side never merge. The picture is thinned to a one-pixel skeleton, short spurs are trimmed, and the skeleton
is walked into edges between junctions and ends (skan); an edge is split where the road's colour changes (a dirt road
running on from where a main road ends). Pixels are tied to map metres by the water line: the image's sea matches the
game's heightmap best at CAL below (a scale and offset found by matching the two water masks; roads then land within a
few metres of the satellite roads across the island).

Foot paths are dashed dark grey lines (in two greys). The dashes are found by colour and shape (thin strokes; not the
black power lines, the grid, or label letters), each is drawn a little longer along its own direction so it meets the
next dash of its path, and the result is thinned and walked like the roads. Paths that still stop where the next bit
lines up (an icon hid a few dashes) are joined end to end.

Needs: numpy, scipy, pillow, scikit-image, skan.
Run:   python tools/extract_roads.py [--src tools/roads/Everon-1989.jpg] [--box x0 z0 x1 z1] [--preview out.png]
"""

import argparse
from collections import Counter
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
KIND_RUN_M = 25      # metres: a change of road colour must last this long to start a new edge
BRIDGE_PX = 9       # pixels: labels, icons and rivers up to about twice this wide are bridged where they cross a road


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


def open_ground(rgb):
    """Pixels of plain map: grey ground and buildings (any hill shading) and green woods. Roads are never bridged across
    these; everything else (labels, icons, power lines, the grid, rivers) may lie over a road and hide it."""
    a = rgb.astype(np.int16)
    mx, mn = a.max(axis=2), a.min(axis=2)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    grey = (mx >= 140) & (mx - mn <= 24)
    green = (g >= 140) & (g - b >= 20) & (g - r >= 8)
    return grey | green


def banded(fn, mask, pad=64, band=2048):
    """Apply a morphological fn to a big mask in overlapping bands of rows (keeps memory down)."""
    out = np.zeros_like(mask)
    for a in range(0, mask.shape[0], band):
        lo, hi = max(0, a - pad), min(mask.shape[0], a + band + pad)
        res = fn(mask[lo:hi])
        out[a:min(a + band, mask.shape[0])] = res[a - lo:a - lo + min(band, mask.shape[0] - a)]
    return out


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


def trace(labels, ground, ppm):
    """labels: kind per pixel (255 none); ground: open_ground(). Returns nodes (px) and edges (a, b, kind, pixel path)."""
    mask = labels != 255
    # Bridge what's drawn over a road (a label's letters, an icon, a river, a power line): close the road mask, but only
    # fill pixels that aren't open ground, so two roads side by side never merge across the ground between them.
    fp = morphology.disk(BRIDGE_PX)
    mask |= banded(lambda m: ndi.binary_closing(m, fp, border_value=0), mask) & ~ground
    mask = banded(lambda m: ndi.binary_closing(m, morphology.disk(2)), mask)
    mask = morphology.remove_small_objects(mask, max_size=max(20, int((MIN_BLOB_M * ppm) ** 2 * 0.12)))
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
    nodes, key, edges = [], {}, []
    if not sk.any():
        return nodes, edges
    g = Skeleton(sk, keep_images=False)
    tab = summarize(g, separator='_')

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
        # one edge per stretch of one kind: a dirt road running on from where a main road ends is its own edge
        for a, b, kind in kind_runs(labels[c[:, 0], c[:, 1]], ppm):
            edges.append((node(c[a]), node(c[b]), kind, c[a:b + 1]))
    return nodes, edges


def kind_runs(ks, ppm):
    """Split a traced line's pixel kinds (255 = bridged, no colour) into runs of one kind, at least KIND_RUN_M long
    (shorter runs are a colour blip, e.g. at a junction). Returns (first, last, kind) index ranges that share their
    end pixels."""
    n = len(ks)
    ok = np.nonzero(ks != 255)[0]
    if not len(ok):
        return [(0, n - 1, 2)]
    ks = ks[ok[np.clip(np.searchsorted(ok, np.arange(n)), 0, len(ok) - 1)]].astype(int)   # fill the gaps
    win = max(3, int(9 * ppm)) | 1
    votes = np.stack([np.convolve(ks == k, np.ones(win), mode='same') for k in range(3)])
    ks = votes.argmax(axis=0)
    runs = []   # [start, end, kind]
    for i, k in enumerate(ks):
        if runs and runs[-1][2] == k:
            runs[-1][1] = i
        else:
            runs.append([i, i, k])
    min_px = KIND_RUN_M * ppm
    while len(runs) > 1:
        j = min(range(len(runs)), key=lambda r: runs[r][1] - runs[r][0])
        if runs[j][1] - runs[j][0] >= min_px:
            break
        nb = [r for r in (j - 1, j + 1) if 0 <= r < len(runs)]
        m = max(nb, key=lambda r: runs[r][1] - runs[r][0])
        lo, hi = min(j, m), max(j, m)
        runs[lo:hi + 1] = [[runs[lo][0], runs[hi][1], runs[m][2]]]
        # neighbours of one kind now touching: one run
        k2 = 0
        while k2 < len(runs) - 1:
            if runs[k2][2] == runs[k2 + 1][2]:
                runs[k2:k2 + 2] = [[runs[k2][0], runs[k2 + 1][1], runs[k2][2]]]
            else:
                k2 += 1
    out = []
    for r, (a, b, k) in enumerate(runs):
        a = a if r == 0 else out[-1][1]
        out.append((a, b if r < len(runs) - 1 else n - 1, int(k)))
    return [o for o in out if o[1] > o[0]]



DASH_EXT_PX = 15      # pixels each dash is drawn longer at both ends, to meet the next dash of its path
PATH_SPUR_M = 16      # metres: shorter dead-end stubs of the traced paths are noise (a dash end drawn longer into nothing)
LETTER_NEAR_PX = 24   # a "dash" with two or more letter-like blobs this close is part of a label
PATH_MIN_M = 50      # metres: shorter separate bits aren't a path (a lone dash, a letter of a label)


def find_dashes(rgb):
    """The foot path dashes on the printed map: short dark grey strokes, 2-3 px wide. Returns (p, q) end points of each,
    (row, col) floats. Grid lines (a darker grey), power lines (black), label letters (wide strokes, or a lighter grey)
    and building outlines don't count."""
    from skimage import measure
    h, w = rgb.shape[:2]
    dash = np.zeros((h, w), bool)
    coldark, rowdark = np.zeros(w), np.zeros(h)
    for a in range(0, h, 2048):
        band = rgb[a:a + 2048].astype(np.int16)
        mx, mn = band.max(axis=2), band.min(axis=2)
        black = ndi.binary_dilation(mx < 42, iterations=2)
        # paths are printed in two greys (about 48 and 75); the grid lines are the darker one too
        dash[a:a + 2048] = (mx <= 92) & (mn >= 42) & (mx - mn <= 16) & ~black
        dk = mx < 90
        coldark += dk.sum(axis=0)
        rowdark[a:a + 2048] = dk.sum(axis=1)
    # the grid: whole columns and rows that are mostly dark
    for i in np.where(coldark > 0.25 * h)[0]:
        dash[:, max(0, i - 1):i + 2] = False
    for i in np.where(rowdark > 0.25 * w)[0]:
        dash[max(0, i - 1):i + 2, :] = False
    lab = measure.label(dash, connectivity=2)
    del dash
    out, letters = [], []
    for r in measure.regionprops(lab):
        # thin (no pixel more than ~3 px inside the stroke; some dashes taper) and long enough; it may bend along a curve
        if r.area > 600 or r.area < 8 or r.axis_major_length < 7:
            if r.area >= 25:
                letters.append(r.centroid)
            continue
        # a stroke, not a letter: thinned it's one line with two ends (not E, T, A, O), fairly straight end to end
        # (not C, S, L); a dash bending along a curve of the path still is
        sk = morphology.skeletonize(np.pad(r.image, 1))
        nb = ndi.convolve(sk.astype(np.uint8), np.ones((3, 3), np.uint8), mode='constant') - 1
        tips = np.argwhere(sk & (nb == 1))
        if len(tips) != 2 or np.hypot(*(tips[0] - tips[1])) < 0.72 * sk.sum() \
                or ndi.distance_transform_edt(np.pad(r.image, 1)).max() > 3.3:
            if r.area >= 25:
                letters.append(r.centroid)
            continue
        c = r.coords.astype(float)
        m = c.mean(axis=0)
        u, s, vt = np.linalg.svd(c - m, full_matrices=False)
        t = (c - m) @ vt[0]
        tips = []
        for tip in (c[np.argmin(t)], c[np.argmax(t)]):   # each end, and the way the dash runs out of it
            near = c[np.hypot(*(c - tip).T) <= 9]
            v = tip - near.mean(axis=0)
            L = np.hypot(*v)
            tips.append((tip, v / L if L else vt[0]))
        out.append((r.coords, tips, m))
    # the I of a label, or the 1 of a spot height, passes as a dash: but it has other letters right beside it
    if letters and out:
        from scipy.spatial import cKDTree
        tree = cKDTree(np.array(letters))
        out = [o for o in out if len(tree.query_ball_point(o[2], LETTER_NEAR_PX)) < 2]
    return [(coords, tips) for coords, tips, m in out]


def find_paths(rgb, ppm):
    """Foot paths as lines of (row, col) points. Each dash is drawn a little longer along its own direction so that
    it meets the next dash of its path (but not a path alongside), and the result is thinned to a centre line."""
    from PIL import ImageDraw
    dashes = find_dashes(rgb)
    print(len(dashes), 'dashes')
    h, w = rgb.shape[:2]
    canvas = Image.new('1', (w, h), 0)
    d = ImageDraw.Draw(canvas)
    for coords, tips in dashes:
        for tip, u in tips:
            b = tip + u * DASH_EXT_PX
            d.line([(tip[1], tip[0]), (b[1], b[0])], fill=1, width=3)
    mask = np.array(canvas, dtype=bool)
    del canvas
    for coords, tips in dashes:
        mask[coords[:, 0], coords[:, 1]] = True
    mask = banded(lambda m: ndi.binary_dilation(m, iterations=1), mask)
    sk = morphology.skeletonize(mask)
    del mask
    if not sk.any():
        return []
    for _ in range(2):  # trim stubs
        g = Skeleton(sk, keep_images=False)
        tab = summarize(g, separator='_')
        short = tab[(tab['branch_type'] == 1) & (tab['branch_distance'] < PATH_SPUR_M * ppm)]
        if short.empty:
            break
        deg = ndi.convolve(sk.astype(np.uint8), np.ones((3, 3), np.uint8), mode='constant') - 1
        for i in short.index:
            c = g.path_coordinates(i)
            tip_first = deg[int(c[0][0]), int(c[0][1])] == 1
            rows = c[:-1] if tip_first else c[1:]
            sk[rows[:, 0].astype(int), rows[:, 1].astype(int)] = False
        sk = morphology.skeletonize(sk)
    g = Skeleton(sk, keep_images=False)
    tab = summarize(g, separator='_')
    # drop separate bits too short to be a path
    keep = set()
    for sid, grp in tab.groupby('skeleton_id'):
        if grp['branch_distance'].sum() >= PATH_MIN_M * ppm:
            keep |= set(grp.index)
    chains, key = [], Counter()
    for i in tab.index:
        if i not in keep:
            continue
        c = g.path_coordinates(i).astype(float)
        if len(c) >= 2:
            chains.append(c)
            key[tuple(c[0].astype(int))] += 1
            key[tuple(c[-1].astype(int))] += 1
    free = [(key[tuple(c[0].astype(int))] == 1, key[tuple(c[-1].astype(int))] == 1) for c in chains]
    chains = join_chains(chains, ppm, free)
    print(len(chains), 'foot path lines')
    return chains


CHAIN_GAP_M = 70      # metres: a path hidden under an icon or a label, between two chains of dashes that line up
CHAIN_TURN = 30       # degrees


def join_chains(chains, ppm, free=None):
    """Join chains of dashes end to end where one carries on where the other stopped (an icon or a grid line hid a dash
    or two). Both ends must point at each other; each end joins at most once, nearest first."""
    from scipy.spatial import cKDTree

    def end(c, side):  # point, and unit direction pointing out of the chain
        p = c if side == 0 else c[::-1]
        k = min(len(p) - 1, 14)   # about 12 m back along the traced pixels
        v = p[0] - p[k]
        L = np.hypot(*v)
        return p[0], (v / L if L else v)

    ends = [(i, s) + end(c, s) for i, c in enumerate(chains) for s in (0, 1)]
    ok = [free is None or free[i][s] for i, s, *_ in ends]   # only loose ends join (not ends at a junction)
    tree = cKDTree(np.array([e[2] for e in ends]))
    cands = []
    gap = CHAIN_GAP_M * ppm
    for a, (i, s, p, u) in enumerate(ends):
        if not ok[a]:
            continue
        for b in tree.query_ball_point(p, gap):
            j, t, q, w = ends[b]
            if j == i or b <= a or not ok[b]:
                continue
            v = q - p
            L = np.hypot(*v)
            if L < 1:
                cands.append((L, a, b))
                continue
            v = v / L
            turn = max(np.degrees(np.arccos(np.clip(v @ u, -1, 1))), np.degrees(np.arccos(np.clip(-v @ w, -1, 1))))
            if turn <= CHAIN_TURN:
                cands.append((L * (1 + turn / CHAIN_TURN), a, b))
    cands.sort()
    uf = list(range(len(chains)))

    def find(x):
        while uf[x] != x:
            uf[x] = uf[uf[x]]
            x = uf[x]
        return x

    used, joins = set(), {}
    for _, a, b in cands:
        if a in used or b in used or find(ends[a][0]) == find(ends[b][0]):
            continue
        used |= {a, b}
        uf[find(ends[a][0])] = find(ends[b][0])
        joins[a], joins[b] = b, a
    # walk each joined run of chains from a free end
    out, seen = [], set()
    for start in range(len(ends)):
        i = ends[start][0]
        if i in seen or start in joins:
            continue
        run, e = [], start
        while True:
            i = ends[e][0]
            seen.add(i)
            c = chains[i] if ends[e][1] == 0 else chains[i][::-1]
            run.append(c)
            far = e ^ 1                    # the chain's other end
            if far not in joins:
                break
            e = joins[far]
        out.append(np.vstack(run))
    for i, c in enumerate(chains):     # closed rings (every end joined)
        if i not in seen:
            out.append(c)
    return out


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
    ground = np.zeros(rgb.shape[:2], bool)
    for a in range(0, rgb.shape[0], 2048):
        band = rgb[a:a + 2048].astype(np.int16)
        ground[a:a + 2048] = open_ground(rgb[a:a + 2048])
        # hill names are brown, and their soft edges pass through the dirt road colour: never road, never bridged
        brown = (band[..., 0] - band[..., 2] > 60) & (band[..., 1] < 140) & (band[..., 0] < 215)
        brown = ndi.binary_dilation(brown, iterations=3)
        labels[a:a + 2048][brown] = 255
        ground[a:a + 2048] |= brown
    nodes, edges = trace(labels, ground, CAL['s'])
    del ground
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
        out_paths = [[[round(v, 1) for v in px_to_world(p[1] + c0, p[0] + r0)] for p in rdp(ch, eps)] for ch in paths]
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

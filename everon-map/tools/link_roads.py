"""Join, tidy and smooth the traced roads into the network the map uses.

Input:  tools/roads/roads.raw.json   from tools/extract_roads.py: road edges (main road, street, dirt road) and chains of
                                     foot path dashes, all in map metres
Output: static/data/roads.json       {"nodes": [[x, z], ...], "edges": [[a, b, kind, [[x, z], ...]], ...]}
        kind 0 main road, 1 street, 2 dirt road, 3 foot path (vehicles can use it, but roads are preferred)

What it does, in order:
  1. tidy the trace: short edges between junctions are merged into one junction (the little triangles the thinning leaves
     at a crossing) and tiny loops around icons are dropped
  2. close the gaps: a road that stops short (a label or icon was drawn over it) is joined to the road it was heading for,
     if that lies straight ahead within GAP_M and isn't already connected
  3. foot paths: their dashes are chained already; each end is tied to a road or path close ahead of it, and where a path
     crosses a road they're joined
  4. node everything at its crossings, so the result is one graph
  5. smooth every line (a gentle average along it, with its ends and junctions held still), then simplify
  6. drop anything lying in the sea, and fragments shorter than MIN_PIECE_M that connect to nothing

Run:  python tools/link_roads.py [--in tools/roads/roads.raw.json] [--out static/data/roads.json]
"""

import argparse
import json
import math
import os
import sys
from collections import Counter

import numpy as np
from shapely import STRtree
from shapely.geometry import LineString, MultiLineString, Point
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

SHORT_EDGE_M = 14      # an edge this short between junctions is one junction
LOOP_M = 60            # a loop back to itself shorter than this is an icon or a label
GAP_M = 90             # how far a road may reach to close a gap
GAP_CONE = 38          # degrees off straight ahead a gap may lie
PATH_SNAP_M = 28       # how far a foot path's end reaches to a road or path
PATH_CONE = 55
SMOOTH_M = 6.0         # width of the smoothing (standard deviation along the line)
STEP_M = 2.0           # spacing of points while smoothing
SIMPLIFY_M = 0.6       # how far the smoothed line may stray when points are dropped
MIN_PIECE_M = 90       # smaller unconnected pieces are dropped


def length(p):
    return float(np.hypot(*np.diff(p, axis=0).T).sum()) if len(p) > 1 else 0.0


class UF:
    def __init__(self):
        self.p = {}

    def find(self, x):
        self.p.setdefault(x, x)
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a, b):
        self.p[self.find(a)] = self.find(b)


def tidy(nodes, edges):
    """Merge short junction-to-junction edges, drop icon loops and doubled edges."""
    deg = Counter()
    for a, b, k, p in edges:
        deg[a] += 1
        deg[b] += 1
    uf = UF()
    for a, b, k, p in edges:
        if a != b and length(p) < SHORT_EDGE_M and min(deg[a], deg[b]) >= 2 and max(deg[a], deg[b]) >= 3:
            uf.union(a, b)
    groups = {}
    for i in range(len(nodes)):
        groups.setdefault(uf.find(i), []).append(i)
    where = {r: np.mean([nodes[i] for i in m], axis=0) for r, m in groups.items()}
    out, seen = [], {}
    for a, b, k, p in edges:
        ra, rb = uf.find(a), uf.find(b)
        p = np.array(p, float)
        p[0], p[-1] = where[ra], where[rb]
        L = length(p)
        if ra == rb and L < LOOP_M:
            continue
        key = (min(ra, rb), max(ra, rb))
        if ra != rb and key in seen:  # two thin routes between the same junctions: keep the shorter
            j = seen[key]
            other = out[j]
            if max(L, length(other[3])) < 90 and abs(L - length(other[3])) < 0.4 * max(L, length(other[3])):
                if L < length(other[3]):
                    out[j] = (ra, rb, k, p)
                continue
        seen[key] = len(out)
        out.append((ra, rb, k, p))
    return where, out


def tangent(p, back=12.0):
    """Unit vector pointing out of the start of polyline p."""
    ls = LineString(p)
    q = np.array(ls.interpolate(min(back, ls.length)).coords[0])
    v = p[0] - q
    n = np.hypot(*v)
    return v / n if n else v


def angle(u, v):
    return math.degrees(math.acos(max(-1.0, min(1.0, float(u @ v) / (np.hypot(*u) * np.hypot(*v) + 1e-12)))))


def insert_vertex(pts, q):
    """Put point q into polyline pts on the segment nearest it; returns the new array."""
    best, bi = 1e18, 0
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        ab = b - a
        t = np.clip(((q - a) @ ab) / (ab @ ab + 1e-12), 0, 1)
        d = np.hypot(*(a + t * ab - q))
        if d < best:
            best, bi = d, i
    return np.insert(pts, bi + 1, q, axis=0)


def close_gaps(lines, ends):
    """lines: list of dict(kind, pts). ends: (line index, which end 0/-1) of every road end that touches nothing.
    Returns connector lines."""
    road = [i for i, l in enumerate(lines) if l['k'] < 3]
    geoms = [LineString(lines[i]['pts']) for i in road]
    tree = STRtree(geoms)
    comp = UF()
    for i in road:
        pts = lines[i]['pts']
        comp.union(('n', lines[i]['a']), ('n', lines[i]['b']))
    cands = []
    for li, side in ends:
        l = lines[li]
        if l['k'] >= 3:
            continue
        p = l['pts'] if side == 0 else l['pts'][::-1]
        e = p[0]
        t = tangent(p)
        me = comp.find(('n', l['a'] if side == 0 else l['b']))
        best = None
        for gi in tree.query(Point(e).buffer(GAP_M)):
            j = road[gi]
            if j == li:
                continue
            if comp.find(('n', lines[j]['a'])) == me:
                continue
            g = geoms[gi]
            q = np.array(g.interpolate(g.project(Point(e))).coords[0])
            v = q - e
            d = float(np.hypot(*v))
            if d > GAP_M or d < 0.5:
                continue
            ang = angle(v, t)
            if d > 10 and ang > GAP_CONE:
                continue
            cost = d * (1 + ang / GAP_CONE)
            if best is None or cost < best[0]:
                best = (cost, e, q, j, l['k'])
        if best:
            cands.append((best, ('n', l['a'] if side == 0 else l['b'])))
    cands.sort(key=lambda c: c[0][0])
    made = []
    for (cost, e, q, j, k), nd in cands:
        if comp.find(nd) == comp.find(('n', lines[j]['a'])):
            continue
        comp.union(nd, ('n', lines[j]['a']))
        lines[j]['pts'] = insert_vertex(lines[j]['pts'], q)
        made.append({'k': k, 'pts': np.array([e, q]), 'a': -1, 'b': -1})
    return made


def snap_paths(lines, path_ids):
    """Tie the ends of foot paths to a road or path just ahead of them."""
    others = list(range(len(lines)))
    geoms = [LineString(lines[i]['pts']) for i in others]
    tree = STRtree(geoms)
    made = []
    for li in path_ids:
        l = lines[li]
        for side in (0, -1):
            p = l['pts'] if side == 0 else l['pts'][::-1]
            e = p[0]
            t = tangent(p, 10.0)
            best = None
            for gi in tree.query(Point(e).buffer(PATH_SNAP_M)):
                if gi == li:
                    continue
                g = geoms[gi]
                q = np.array(g.interpolate(g.project(Point(e))).coords[0])
                v = q - e
                d = float(np.hypot(*v))
                if d > PATH_SNAP_M:
                    continue
                if d < 0.5:
                    best = None
                    break  # it already touches
                if d > 8 and angle(v, t) > PATH_CONE:
                    continue
                cost = d * (1 + angle(v, t) / PATH_CONE) * (1 if lines[gi]['k'] < 3 else 1.4)
                if best is None or cost < best[0]:
                    best = (cost, q, gi)
            if best:
                lines[best[2]]['pts'] = insert_vertex(lines[best[2]]['pts'], best[1])
                made.append({'k': 3, 'pts': np.array([e, best[1]]), 'a': -1, 'b': -1})
    return made


def smooth(pts, sigma=SMOOTH_M, step=STEP_M, eps=SIMPLIFY_M):
    """A gentle average along the line; both ends stay exactly where they are."""
    ls = LineString(pts)
    L = ls.length
    if L < 3 * step:
        return pts
    n = max(int(L / step), 4)
    s = np.linspace(0, L, n + 1)
    xy = np.array([ls.interpolate(d).coords[0] for d in s])
    k = int(round(3 * sigma / (L / n)))
    if k >= 1:
        w = np.exp(-0.5 * (np.arange(-k, k + 1) * (L / n) / sigma) ** 2)
        w /= w.sum()
        # reflect through the end points (odd extension) so the ends and their direction are kept
        pre = 2 * xy[0] - xy[1:k + 1][::-1] if len(xy) > k else np.repeat(xy[:1], k, 0)
        post = 2 * xy[-1] - xy[-k - 1:-1][::-1] if len(xy) > k else np.repeat(xy[-1:], k, 0)
        ext = np.vstack([pre, xy, post])
        xy = np.stack([np.convolve(ext[:, c], w, mode='valid') for c in (0, 1)], axis=1)
    xy[0], xy[-1] = pts[0], pts[-1]
    return rdp(xy, eps)


def rdp(pts, eps):
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
        Ln = np.hypot(*d)
        seg = pts[i + 1:j] - a
        dist = np.abs(seg[:, 0] * d[1] - seg[:, 1] * d[0]) / Ln if Ln else np.hypot(seg[:, 0], seg[:, 1])
        m = int(np.argmax(dist))
        if dist[m] > eps:
            keep[i + 1 + m] = True
            stack += [(i, i + 1 + m), (i + 1 + m, j)]
    return pts[keep]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--in', dest='src', default=os.path.join(HERE, 'roads', 'roads.raw.json'))
    ap.add_argument('--out', default=os.path.join(ROOT, 'static', 'data', 'roads.json'))
    args = ap.parse_args()
    with open(args.src, encoding='utf8') as f:
        raw = json.load(f)
    nodes = [np.array(n, float) for n in raw['nodes']]
    edges = [(a, b, k, np.array(p, float)) for a, b, k, p in raw['edges']]
    print(len(edges), 'road edges,', len(raw.get('paths', [])), 'path chains')

    where, edges = tidy(nodes, edges)
    print('after tidying:', len(edges), 'edges')
    lines = [{'k': k, 'pts': p, 'a': a, 'b': b} for a, b, k, p in edges]

    deg = Counter()
    for l in lines:
        deg[l['a']] += 1
        deg[l['b']] += 1
    ends = [(i, 0) for i, l in enumerate(lines) if deg[l['a']] == 1] + [(i, -1) for i, l in enumerate(lines) if deg[l['b']] == 1]
    print(len(ends), 'road ends touch nothing')
    gaps = close_gaps(lines, ends)
    print('closed', len(gaps), 'gaps')
    base = len(lines)
    for ch in raw.get('paths', []):
        lines.append({'k': 3, 'pts': np.array(ch, float), 'a': -1, 'b': -1})
    ties = snap_paths(lines, list(range(base, len(lines))))
    print('tied', len(ties), 'path ends')
    lines += gaps + ties

    # node everything at its crossings
    geoms = [LineString(l['pts']) for l in lines if len(l['pts']) > 1]
    src = [l for l in lines if len(l['pts']) > 1]
    tree = STRtree(geoms)
    noded = unary_union(geoms)
    pieces = list(noded.geoms) if hasattr(noded, 'geoms') else [noded]
    key, nd, out = {}, [], []

    def nid(c):
        k = (round(c[0], 1), round(c[1], 1))
        if k not in key:
            key[k] = len(nd)
            nd.append(np.array(c, float))
        return key[k]

    for pc in pieces:
        pts = np.array(pc.coords)
        if len(pts) < 2 or pc.length < 0.5:
            continue
        mid = pc.interpolate(0.5, normalized=True)
        near = [gi for gi in tree.query(mid.buffer(1.2)) if geoms[gi].distance(mid) < 1.2]
        kind = min(src[gi]['k'] for gi in near) if near else 2
        a, b = nid(pts[0]), nid(pts[-1])
        if a == b and pc.length < LOOP_M:
            continue
        out.append([a, b, kind, pts])
    print(len(nd), 'nodes', len(out), 'edges after noding')

    # drop what lies in the sea (the compass arrow drawn on the map, for one)
    import gzip
    hm = np.frombuffer(gzip.open(os.path.join(ROOT, 'static', 'data', 'light', 'everon-height.bin.gz')).read(), '<i2').reshape(1280, 1280)
    wet = lambda p: float(np.mean([hm[min(1279, max(0, int(z // 10))), min(1279, max(0, int(x // 10)))] < 5 for x, z in p]))
    out = [e for e in out if wet(e[3]) < 0.7]

    # drop small pieces that connect to nothing else
    uf = UF()
    for a, b, k, p in out:
        uf.union(a, b)
    tot = Counter()
    for a, b, k, p in out:
        tot[uf.find(a)] += length(p)
    out = [e for e in out if tot[uf.find(e[0])] >= MIN_PIECE_M]

    # smooth, and write with the nodes that are still used
    used = sorted({e[0] for e in out} | {e[1] for e in out})
    new = {o: i for i, o in enumerate(used)}
    res_nodes = [[round(float(nd[o][0]), 1), round(float(nd[o][1]), 1)] for o in used]
    res_edges = []
    for a, b, k, p in out:
        q = smooth(p)
        pts = [[round(float(v[0]), 1), round(float(v[1]), 1)] for v in q]
        pts[0], pts[-1] = res_nodes[new[a]], res_nodes[new[b]]
        res_edges.append([new[a], new[b], k, pts])
    uf = UF()
    for a, b, k, p in res_edges:
        uf.union(a, b)
    comp = Counter()
    for a, b, k, p in res_edges:
        comp[uf.find(a)] += length(np.array(p))
    big = sorted(comp.values(), reverse=True)
    km = Counter()
    for a, b, k, p in res_edges:
        km[k] += length(np.array(p))
    print('km by kind', {k: round(v / 1000, 1) for k, v in sorted(km.items())})
    print(len(big), 'connected pieces; biggest', [round(v / 1000, 1) for v in big[:8]], 'km')
    with open(args.out, 'w', encoding='utf8') as f:
        json.dump({'note': 'made by tools/extract_roads.py and tools/link_roads.py; see there', 'nodes': res_nodes, 'edges': res_edges},
                  f, separators=(',', ':'))
    print('wrote', args.out, round(os.path.getsize(args.out) / 1e6, 2), 'MB')


if __name__ == '__main__':
    sys.exit(main())

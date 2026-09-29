"""Build the map's road network from the game's own roads (exported by tools/workbench/.../EveronRoadExportTool.c).

Input:  everon_los/roads/roadentities.csv  from the Everon Road Export tool: every road piece of the world (RoadEntity)
          road,which,material,width,type,point,x,y,z
          - its spline points (which = ctrl) in world metres, its surface material, width and road type
Output: static/data/roads.json   {"nodes": [[x, z], ...], "edges": [[a, b, kind, [[x, z], ...]], ...]}
        kind 0 main road, 1 street, 2 dirt road, 3 foot path

The kind comes from the surface material (the game's road type agrees): asphalt with a dashed centre line is a main
road, plain asphalt and cobblestone a street, dirt and forest roads dirt roads, and trails foot paths. The same road
system also paints decals (beach debris, flower beds, runway markings, concrete panels): those are left out.

Each piece's spline points are joined by a smooth curve (Catmull-Rom, like the game's own splines). Pieces that meet
end to end share a junction, an end that stops on another road joins it there, and roads that stop either side of a
bridge are joined across it.

Run:  python tools/import_game_roads.py [--src "<everon_los folder>"] [--check]
"""

import argparse
import csv
import json
import math
import os
import sys
from collections import Counter, defaultdict

import numpy as np
from shapely import STRtree
from shapely.geometry import LineString, Point
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
END_M = 2.0         # piece ends this close are one junction
ON_ROAD_M = 4.0     # an end this close to another road joins it there
BRIDGE_M = 120      # longest gap two roads pointing at each other are joined across (a bridge)
LOOSE_M = 10        # a loose road end this close to another road, or another loose end, is joined to it
STEP_M = 2.0        # spacing of the smooth curve's points
SIMPLIFY_M = 0.3    # how far the written line may stray from the curve
KIND_NAMES = ['main road', 'street', 'dirt road', 'foot path']


def kind_of(material):
    """The map's kind of road for a surface material, or None if it isn't a road (a decal)."""
    m = material.lower()
    if '/roads/data/' not in m or 'decal_' in m:
        return None
    if 'trail' in m:
        return 3
    if 'asphalt' in m and 'dashed' in m:
        return 0
    if 'asphalt' in m or 'cobble' in m or 'concrete' in m:
        return 1
    if 'dirt' in m or 'forest' in m or 'gravel' in m:
        return 2
    return None


def catmull_rom(p, step=STEP_M):
    """A smooth curve through points p (n x 2), centripetal Catmull-Rom, sampled about every step metres."""
    p = np.asarray(p, float)
    keep = np.r_[True, np.hypot(*np.diff(p, axis=0).T) > 0.05]
    p = p[keep]
    if len(p) < 3:
        return p
    ext = np.vstack([2 * p[0] - p[1], p, 2 * p[-1] - p[-2]])
    out = [p[0]]
    for i in range(1, len(ext) - 2):
        p0, p1, p2, p3 = ext[i - 1], ext[i], ext[i + 1], ext[i + 2]
        t0 = 0.0
        t1 = t0 + max(np.hypot(*(p1 - p0)), 1e-6) ** 0.5
        t2 = t1 + max(np.hypot(*(p2 - p1)), 1e-6) ** 0.5
        t3 = t2 + max(np.hypot(*(p3 - p2)), 1e-6) ** 0.5
        n = max(1, int(math.ceil(np.hypot(*(p2 - p1)) / step)))
        for t in np.linspace(t1, t2, n + 1)[1:]:
            a1 = (t1 - t) / (t1 - t0) * p0 + (t - t0) / (t1 - t0) * p1
            a2 = (t2 - t) / (t2 - t1) * p1 + (t - t1) / (t2 - t1) * p2
            a3 = (t3 - t) / (t3 - t2) * p2 + (t - t2) / (t3 - t2) * p3
            b1 = (t2 - t) / (t2 - t0) * a1 + (t - t0) / (t2 - t0) * a2
            b2 = (t3 - t) / (t3 - t1) * a2 + (t - t1) / (t3 - t1) * a3
            out.append((t2 - t) / (t2 - t1) * b1 + (t - t1) / (t2 - t1) * b2)
    return np.array(out)


def length(p):
    p = np.asarray(p, float)
    return float(np.hypot(*np.diff(p, axis=0).T).sum()) if len(p) > 1 else 0.0


def rdp(pts, eps):
    pts = np.asarray(pts, float)
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


def unspike(p, short=3.0, turn=100):
    """Take out sharp turns on very short segments (a road end pulled a metre or two onto a junction)."""
    p = [np.asarray(x, float) for x in p]
    i = 1
    while 0 < i < len(p) - 1:
        v1, v2 = p[i] - p[i - 1], p[i + 1] - p[i]
        if min(np.hypot(*v1), np.hypot(*v2)) < short and np.hypot(*v1) > 0 and np.hypot(*v2) > 0 and angle(v1, v2) > turn:
            del p[i]
            i = max(1, i - 1)
        else:
            i += 1
    return np.array(p)


def angle(u, v):
    return math.degrees(math.acos(max(-1.0, min(1.0, float(u @ v) / (np.hypot(*u) * np.hypot(*v) + 1e-12)))))


def read_pieces(folder):
    pts, info = defaultdict(list), {}
    with open(os.path.join(folder, 'roadentities.csv'), encoding='utf8', errors='replace') as f:
        for r in csv.DictReader(f):
            if r['which'] != 'ctrl':
                continue
            pts[r['road']].append((int(r['point']), float(r['x']), float(r['z'])))
            info[r['road']] = (r['material'].split('}')[-1], float(r['width'] or 0), r['type'])
    pieces, skipped = [], Counter()
    for rid, p in pts.items():
        material, width, rtype = info[rid]
        kind = kind_of(material)
        if kind is None and material == '' and rtype == '2':
            kind = 1   # a few street pieces carry no material of their own
        if kind is None:
            skipped[material or '(none)'] += 1
            continue
        ctrl = np.array([(x, z) for _, x, z in sorted(p)])
        if len(ctrl) < 2:
            continue
        pieces.append({'id': rid, 'kind': kind, 'material': material, 'width': width, 'pts': catmull_rom(ctrl)})
    return pieces, skipped


def build(pieces):
    """One network: shared ends become junctions, an end stopping on another road joins it, crossings are noded,
    and roads stopping either side of a bridge are joined across it."""
    geoms = [LineString(p['pts']) for p in pieces]
    tree = STRtree(geoms)
    lines = [[p['kind'], [tuple(q) for q in p['pts']]] for p in pieces]
    # an end that stops on another road (not at that road's end): run it on to the road
    for i, p in enumerate(pieces):
        for side in (0, -1):
            e = Point(p['pts'][side])
            best = None
            for j in tree.query(e.buffer(ON_ROAD_M)):
                if j == i:
                    continue
                d = geoms[j].distance(e)
                if d <= ON_ROAD_M and (best is None or d < best[0]):
                    best = (d, j)
            if best and best[0] > 0.01:
                g = geoms[best[1]]
                q = g.interpolate(g.project(e))
                if side == 0:
                    lines[i][1].insert(0, (q.x, q.y))
                else:
                    lines[i][1].append((q.x, q.y))
    geo = [LineString(l[1]) for l in lines]
    noded = unary_union(geo)
    parts = list(noded.geoms) if hasattr(noded, 'geoms') else [noded]
    ltree = STRtree(geo)
    key, nodes, edges = {}, [], []

    def nid(c):
        k = (round(c[0] / END_M), round(c[1] / END_M))
        for dk in ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
            kk = (k[0] + dk[0], k[1] + dk[1])
            if kk in key and math.dist(nodes[key[kk]], c) <= END_M:
                return key[kk]
        key[k] = len(nodes)
        nodes.append([float(c[0]), float(c[1])])
        return key[k]

    for pc in parts:
        if pc.length < 0.2:
            continue
        mid = pc.interpolate(0.5, normalized=True)
        near = [j for j in ltree.query(mid.buffer(0.3)) if geo[j].distance(mid) < 0.3]
        kind = min(lines[j][0] for j in near) if near else 2
        pts = np.array(pc.coords)
        a, b = nid(pts[0]), nid(pts[-1])
        if a == b and pc.length < 3:
            continue
        pts[0], pts[-1] = nodes[a], nodes[b]
        edges.append([a, b, kind, pts])
    return nodes, edges


def split_edge(nodes, edges, i, q):
    """A new junction at point q on edge i (split in two); returns it."""
    a, b, k, p = edges[i]
    p = np.asarray(p, float)
    best, bi = 1e18, 0
    for s in range(len(p) - 1):
        ab = p[s + 1] - p[s]
        t = np.clip(((q - p[s]) @ ab) / (ab @ ab + 1e-12), 0, 1)
        d = np.hypot(*(p[s] + t * ab - q))
        if d < best:
            best, bi = d, s
    n = len(nodes)
    nodes.append([float(q[0]), float(q[1])])
    edges[i] = [a, n, k, np.vstack([p[:bi + 1], [q]])]
    edges.append([n, b, k, np.vstack([[q], p[bi + 1:]])])
    return n


def bridge_boxes(objects_dir):
    """Each bridge's outline on the ground: all its parts (deck, pillars, railings) that lie together, as one box."""
    parts = []
    if os.path.isdir(objects_dir):
        for fn in os.listdir(objects_dir):
            with open(os.path.join(objects_dir, fn), encoding='utf8', errors='replace') as f:
                for r in csv.DictReader(f):
                    if '/Bridges/' in r['prefab']:
                        parts.append((float(r['minx']), float(r['minz']), float(r['maxx']), float(r['maxz'])))
    par = list(range(len(parts)))

    def find(x):
        while par[x] != x:
            par[x] = par[par[x]]
            x = par[x]
        return x
    from scipy.spatial import cKDTree
    if parts:
        c = np.array([((a + b) / 2, (z0 + z1) / 2) for a, z0, b, z1 in parts])
        for i, j in cKDTree(c).query_pairs(30):
            par[find(i)] = find(j)
    boxes = {}
    for i, (x0, z0, x1, z1) in enumerate(parts):
        r = find(i)
        b = boxes.get(r, (x0, z0, x1, z1))
        boxes[r] = (min(b[0], x0), min(b[1], z0), max(b[2], x1), max(b[3], z1))
    return list(boxes.values())


def join_loose(nodes, edges, objects_dir):
    """Loose road ends that should meet something, as the game's roads sometimes stop a few metres short:
      - within LOOSE_M of another loose end: joined to it
      - within LOOSE_M of another road: joined to it there
      - on a bridge: carried on straight ahead to the road at the far end (up to BRIDGE_M)
    Returns how many were joined."""
    boxes = bridge_boxes(objects_dir)
    on_bridge = lambda xz: any(x0 - 5 <= xz[0] <= x1 + 5 and z0 - 5 <= xz[1] <= z1 + 5 for x0, z0, x1, z1 in boxes)
    made = 0
    for _ in range(3):
        deg = Counter()
        for a, b, k, p in edges:
            deg[a] += 1
            deg[b] += 1
        geoms = [LineString(p) for a, b, k, p in edges]
        tree = STRtree(geoms)
        loose = []
        for i, (a, b, k, p) in enumerate(edges):
            for nd, q in ((a, p), (b, p[::-1])):
                if deg[nd] == 1:
                    ls = LineString(q)
                    back = np.array(ls.interpolate(min(10.0, ls.length)).coords[0])
                    loose.append((nd, i, np.array(q[0], float), np.array(q[0], float) - back, k))
        done, joined = set(), 0
        # loose end to loose end
        from scipy.spatial import cKDTree
        if loose:
            t = cKDTree(np.array([l[2] for l in loose]))
            for x, y in sorted(t.query_pairs(LOOSE_M), key=lambda xy: math.dist(loose[xy[0]][2], loose[xy[1]][2])):
                n1, n2 = loose[x][0], loose[y][0]
                if n1 in done or n2 in done or loose[x][1] == loose[y][1]:
                    continue
                done |= {n1, n2}
                edges.append([n1, n2, min(loose[x][4], loose[y][4]), np.array([nodes[n1], nodes[n2]])])
                joined += 1
        # loose end to a road beside it, or across a bridge ahead of it
        for nd, i, e, tvec, k in loose:
            if nd in done:
                continue
            best = None
            for j in tree.query(Point(e).buffer(BRIDGE_M)):
                if j == i:
                    continue
                g = geoms[j]
                d = g.distance(Point(e))
                if d <= LOOSE_M:
                    q = np.array(g.interpolate(g.project(Point(e))).coords[0])
                    if best is None or d < best[0]:
                        best = (d, j, q)
                    continue
                if not on_bridge(e):
                    continue
                for s in np.arange(0, g.length, 2.0):   # straight ahead over the bridge
                    q = np.array(g.interpolate(s).coords[0])
                    v = q - e
                    dd = float(np.hypot(*v))
                    if dd <= BRIDGE_M and angle(v, tvec) <= 15 and on_bridge((e + q) / 2) and (best is None or dd < best[0]):
                        best = (dd, j, q)
            if best:
                d, j, q = best
                if d < 0.05:
                    continue
                n2 = split_edge(nodes, edges, j, q)
                edges.append([nd, n2, min(k, edges[j][2]), np.array([nodes[nd], q])])
                done.add(nd)
                joined += 1
                geoms = [LineString(p) for a, b, kk, p in edges]
                tree = STRtree(geoms)
        made += joined
        if not joined:
            break
    return made


def join_bridges(nodes, edges, objects_dir):
    """Roads that stop at either end of a bridge: loose ends pointing at each other, with a bridge between."""
    boxes = bridge_boxes(objects_dir)
    deg = Counter()
    for a, b, k, p in edges:
        deg[a] += 1
        deg[b] += 1
    tips = []
    for a, b, k, p in edges:
        if k == 3:
            continue
        for nd, q in ((a, p), (b, p[::-1])):
            if deg[nd] == 1:
                back = q[min(len(q) - 1, 5)]
                tips.append((nd, np.array(q[0]), np.array(q[0]) - np.array(back), k))
    made = 0
    used = set()
    cands = []
    for x in range(len(tips)):
        for y in range(x + 1, len(tips)):
            n1, e1, t1, k1 = tips[x]
            n2, e2, t2, k2 = tips[y]
            v = e2 - e1
            d = float(np.hypot(*v))
            if d > BRIDGE_M or d < 0.5:
                continue
            if angle(v, t1) > 25 or angle(-v, t2) > 25:
                continue
            mid = (e1 + e2) / 2
            on_bridge = any(bx0 - 5 <= mid[0] <= bx1 + 5 and bz0 - 5 <= mid[1] <= bz1 + 5 for bx0, bz0, bx1, bz1 in boxes)
            if on_bridge or d <= 25:
                cands.append((d, n1, n2, min(k1, k2)))
    for d, n1, n2, k in sorted(cands):
        if n1 in used or n2 in used:
            continue
        used |= {n1, n2}
        edges.append([n1, n2, k, np.array([nodes[n1], nodes[n2]])])
        made += 1
    return made


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--src', default=os.path.expanduser('~/Documents/My Games/ArmaReforgerWorkbench/profile/everon_los'))
    ap.add_argument('--out', default=os.path.join(ROOT, 'static', 'data', 'roads.json'))
    args = ap.parse_args()
    folder = os.path.join(args.src, 'roads')
    if not os.path.exists(os.path.join(folder, 'roadentities.csv')):
        sys.exit(f'No roads/roadentities.csv in {args.src}: run "Export roads" in the Everon Road Export tool first')
    pieces, skipped = read_pieces(folder)
    km = Counter()
    for p in pieces:
        km[p['kind']] += length(p['pts'])
    print(len(pieces), 'road pieces:', ', '.join(f'{KIND_NAMES[k]} {km[k] / 1000:.1f} km' for k in sorted(km)))
    print('left out (decals):', sum(skipped.values()), 'pieces, e.g.', ', '.join(m.split('/')[-1] for m, _ in skipped.most_common(5)))
    nodes, edges = build(pieces)
    print('bridges and short gaps joined:', join_bridges(nodes, edges, os.path.join(args.src, 'objects')))
    print('loose ends joined:', join_loose(nodes, edges, os.path.join(args.src, 'objects')))

    # junctions on the same spot (a road split where another joined it) are one
    from scipy.spatial import cKDTree
    same = list(range(len(nodes)))

    def root(x):
        while same[x] != x:
            same[x] = same[same[x]]
            x = same[x]
        return x
    for i, j in cKDTree(np.array(nodes, float)).query_pairs(0.5):
        same[root(i)] = root(j)
    edges = [[root(a), root(b), k, p] for a, b, k, p in edges]

    used = sorted({e[0] for e in edges} | {e[1] for e in edges})
    new = {o: i for i, o in enumerate(used)}
    out_nodes = [[round(nodes[o][0], 1), round(nodes[o][1], 1)] for o in used]
    out_edges = []
    for a, b, k, p in edges:
        if a == b and length(p) < 10:   # a metre out and back where an end was pulled onto a junction
            continue
        q = unspike(rdp(p, SIMPLIFY_M))
        pts = [[round(float(x), 1), round(float(z), 1)] for x, z in q]
        pts[0], pts[-1] = out_nodes[new[a]], out_nodes[new[b]]
        out_edges.append([new[a], new[b], int(k), pts])
    par = {}

    def find(x):
        par.setdefault(x, x)
        while par[x] != x:
            par[x] = par[par[x]]
            x = par[x]
        return x
    for a, b, k, p in out_edges:
        par[find(a)] = find(b)
    comp = Counter()
    for a, b, k, p in out_edges:
        comp[find(a)] += length(p)
    deg = Counter()
    for a, b, k, p in out_edges:
        deg[a] += 1
        deg[b] += 1
    big = sorted(comp.values(), reverse=True)
    print(f'{len(out_nodes)} junctions, {len(out_edges)} stretches; {len(big)} connected pieces, biggest '
          f'{[round(v / 1000, 1) for v in big[:5]]} km; {sum(1 for n in deg if deg[n] == 1)} dead ends')
    with open(args.out, 'w', encoding='utf8') as f:
        json.dump({'note': "made by tools/import_game_roads.py from the game's own roads; see there",
                   'nodes': out_nodes, 'edges': out_edges}, f, separators=(',', ':'))
    print('wrote', args.out, round(os.path.getsize(args.out) / 1e6, 2), 'MB')


if __name__ == '__main__':
    sys.exit(main())

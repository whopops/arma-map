"""Join, tidy and smooth the traced roads into the network the map uses.

Input:  tools/roads/roads.raw.json   from tools/extract_roads.py: road edges (main road, street, dirt road) and traced
                                     foot paths, all in map metres
        tools/roads/Everon-1989.jpg  the printed map, to check a gap is something drawn over a road, not open ground
Output: static/data/roads.json       {"nodes": [[x, z], ...], "edges": [[a, b, kind, [[x, z], ...]], ...]}
        kind 0 main road, 1 street, 2 dirt road, 3 foot path (vehicles can use it, but roads are preferred)

What it does, in order:
  1. tidy the trace: short edges between junctions are merged into one junction (the little triangles the thinning leaves
     at a crossing) and tiny loops around icons are dropped
  2. close the gaps, wherever the way round along the network is long (or there's none):
     - a road that stops short of the road it's heading for: joined within NEAR_GAP_M whatever lies between, and up to
       GAP_M if the printed map shows something drawn over the gap (a label, an icon, a river) rather than open ground
     - two road ends pointing at each other: joined across up to FACE_GAP_M
     - bridges: a road heading straight over a river to a road on the other bank, up to BRIDGE_M
  3. foot paths: each loose end is tied to a road or path just ahead of it
  4. node everything at its crossings, so the result is one graph; junctions within MERGE_M are one
  5. drop what lies in the sea, small loops of foot path, stubs just past a junction, and small unconnected pieces
  6. smooth each road as one line through its junctions (STROKE_SIGMA), so a through-road doesn't jog at every side
     road, then simplify

tools/check_roads.py checks the result against the printed map.

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
NEAR_GAP_M = 30        # a road stopping this close to the road it heads for is joined to it whatever lies between
BRIDGE_M = 110          # longest bridge
FACE_GAP_M = 60        # two road ends pointing at each other are joined across up to this
PATH_SNAP_M = 45       # how far a foot path's end reaches to a road or path
PATH_CONE = 55
SMOOTH_M = 6.0         # width of the smoothing (standard deviation along the line)
STROKE_SIGMA = {0: 12.0, 1: 8.0, 2: 8.0, 3: 5.0}   # the same, for each kind, smoothing a road through its junctions
THROUGH_TURN = 50      # a road carries on through a junction if it bends less than this there
STEP_M = 2.0           # spacing of points while smoothing
SIMPLIFY_M = 0.6       # how far the smoothed line may stray when points are dropped
MIN_PIECE_M = 90       # smaller unconnected pieces are dropped
MERGE_M = 2.5          # junctions this close together are one
JOIN_PIECE_M = 50      # a piece that joins nothing else is tied to the nearest road or path this close
TOUCH_M = 5            # ...or, with no loose end to tie, where it passes this close to another piece
STUB_M = 20            # a dead-end road this short off a junction is a leftover of the thinning
MAIN_STUB_M = 60       # the same for main roads, which never stop short


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


class Picture:
    """The printed map, to check that a gap about to be closed is something drawn over a road (a label, an icon, a
    river), not open ground."""
    CAL = {'x0': 444.0, 'y0': 1344.0, 's': 1.1184}   # as in extract_roads.py

    def __init__(self, path):
        from PIL import Image
        Image.MAX_IMAGE_PIXELS = None
        self.im = Image.open(path).convert('RGB') if os.path.exists(path) else None

    def px(self, x, z):
        return self.CAL['x0'] + self.CAL['s'] * x, self.CAL['y0'] + self.CAL['s'] * (12800 - z)

    def over_river(self, a, b):
        """Whether water shows within 10 px of the middle half of the line a-b (a bridge's river either side of it)."""
        if self.im is None:
            return False
        (c0, r0), (c1, r1) = self.px(*a), self.px(*b)
        ca, ra = c0 + (c1 - c0) * 0.25, r0 + (r1 - r0) * 0.25
        cb, rb = c0 + (c1 - c0) * 0.75, r0 + (r1 - r0) * 0.75
        lo_c, lo_r = int(min(ca, cb)) - 10, int(min(ra, rb)) - 10
        crop = np.asarray(self.im.crop((lo_c, lo_r, int(max(ca, cb)) + 11, int(max(ra, rb)) + 11))).astype(np.int16)
        r, g, bl = crop[..., 0], crop[..., 1], crop[..., 2]
        water = (bl - r >= 30) & (g - r >= 25)
        # the line itself runs over the bridge, not open water (so not across a bay or a lake)
        n = max(2, int(np.hypot(cb - ca, rb - ra)))
        on = [water[int(round(ra + (rb - ra) * t)) - lo_r, int(round(ca + (cb - ca) * t)) - lo_c] for t in np.linspace(0, 1, n)]
        return water.sum() >= 30 and np.mean(on) < 0.3

    def ground_share(self, a, b):
        """Share of the straight line a-b (map metres) crossing open ground, i.e. with nothing but plain map within 2 px
        either side of it."""
        if self.im is None:
            return 0.0
        (c0, r0), (c1, r1) = self.px(*a), self.px(*b)
        lo_c, lo_r = int(min(c0, c1)) - 16, int(min(r0, r1)) - 16
        crop = np.asarray(self.im.crop((lo_c, lo_r, int(max(c0, c1)) + 17, int(max(r0, r1)) + 17))).astype(np.int16)
        mx, mn = crop.max(axis=2), crop.min(axis=2)
        r, g, bl = crop[..., 0], crop[..., 1], crop[..., 2]
        plain = ((mx >= 140) & (mx - mn <= 24)) | ((g >= 140) & (g - bl >= 20) & (g - r >= 8))
        n = max(2, int(np.hypot(c1 - c0, r1 - r0)))
        nx, ny = -(r1 - r0) / n, (c1 - c0) / n   # unit normal, in pixels
        from scipy import ndimage as ndi
        water = ndi.binary_dilation((bl - r >= 30) & (g - r >= 25), iterations=12)   # a river under or beside it
        on = [(int(round(r0 + (r1 - r0) * t)) - lo_r, int(round(c0 + (c1 - c0) * t)) - lo_c) for t in np.linspace(0, 1, n)]
        if any(water[a, b] for a, b in on if 0 <= a < water.shape[0] and 0 <= b < water.shape[1]):
            plain &= mx >= 190   # over a river: the grey of a bridge counts as road
        bare = 0
        for t in np.linspace(0, 1, n):
            c, rr = c0 + (c1 - c0) * t, r0 + (r1 - r0) * t
            ok = True
            for o in (-2, -1, 0, 1, 2):
                cc, rw = int(round(c + nx * o)) - lo_c, int(round(rr + ny * o)) - lo_r
                if 0 <= rw < plain.shape[0] and 0 <= cc < plain.shape[1] and not plain[rw, cc]:
                    ok = False
                    break
            bare += ok
        return bare / n


def graph_dist(adj, start, goals, cutoff):
    """Shortest distance along the network from node start to any of goals ({node: extra metres}), up to cutoff."""
    import heapq
    best = {start: 0.0}
    heap = [(0.0, 0, start)]
    tick = 0
    found = math.inf
    while heap:
        d, _, u = heapq.heappop(heap)
        if d > cutoff or d >= found:
            break
        if d > best.get(u, math.inf):
            continue
        if u in goals:
            found = min(found, d + goals[u])
        for v, w in adj.get(u, ()):
            nd = d + w
            if nd < best.get(v, math.inf) and nd <= cutoff:
                best[v] = nd
                tick += 1
                heapq.heappush(heap, (nd, tick, v))
    return found


def close_gaps(lines, ends, pic):
    """lines: list of dict(kind, pts, a, b). ends: (line index, which end 0/-1) of every road end that touches nothing.
    A road end is joined to the road it's heading for when that lies within GAP_M, the way there along the network is
    long (or there's none), and the printed map shows something drawn over the gap rather than open ground.
    Returns connector lines."""
    road = [i for i, l in enumerate(lines) if l['k'] < 3]
    adj = {}

    def link(u, v, w):
        adj.setdefault(u, []).append((v, w))
        adj.setdefault(v, []).append((u, w))

    for i in road:
        link(lines[i]['a'], lines[i]['b'], length(lines[i]['pts']))
    geoms = {i: LineString(lines[i]['pts']) for i in road}
    order = list(geoms)
    tree = STRtree([geoms[i] for i in order])
    cands = []
    for li, side in ends:
        l = lines[li]
        if l['k'] >= 3:
            continue
        p = l['pts'] if side == 0 else l['pts'][::-1]
        e, t = p[0], tangent(p)
        me = l['a'] if side == 0 else l['b']
        for gi in tree.query(Point(e).buffer(GAP_M)):
            j = order[gi]
            if j == li and len(p) < 3:
                continue
            g = geoms[j]
            if j == li:  # the same line further along: only its far part (a road bending back to itself)
                continue
            # the best point along it: near, and as straight ahead as can be (a road curving in meets it at an angle)
            s0 = g.project(Point(e))
            best = None
            for s in np.unique(np.clip(np.concatenate([[s0], np.arange(s0 - GAP_M, s0 + GAP_M, 3.0)]), 0, g.length)):
                q = np.array(g.interpolate(s).coords[0])
                v = q - e
                d = float(np.hypot(*v))
                if d > GAP_M or d < 0.5:
                    continue
                ang = angle(v, t)
                cone = 90 if d <= 15 else 45 if d <= NEAR_GAP_M else 15 if d <= NEAR_GAP_M + 10 else GAP_CONE
                if d > 8 and ang > cone:
                    continue
                cost = d * (1 + ang / GAP_CONE)
                if best is None or cost < best[0]:
                    best = (cost, d, q, s)
            if best:
                cost, d, q, s = best
                cands.append((cost, d, e, q, j, s, me, None, l['k'], 'near'))
    # bridges: the map draws a bridge as a grey strip over the river, so a road stops at each bank, often where a track
    # meets it (so not a loose end). Any road edge heading straight over a river to a road just across is joined.
    for li, l in enumerate(lines):
        if l['k'] >= 3 or length(l['pts']) < 8:
            continue
        for side in (0, -1):
            p = l['pts'] if side == 0 else l['pts'][::-1]
            ls = LineString(p)
            # heading from further back: the last metres before a junction bend into the other road
            t = np.array(ls.interpolate(min(8.0, ls.length / 3)).coords[0]) - np.array(ls.interpolate(min(30.0, ls.length * 0.8)).coords[0])
            t = t / (np.hypot(*t) or 1)
            e = p[0]
            me = l['a'] if side == 0 else l['b']
            for gi in tree.query(Point(e).buffer(BRIDGE_M)):
                j = order[gi]
                if j == li:
                    continue
                g = geoms[j]
                best = None   # the nearest point of this road straight ahead
                for s in np.arange(0, g.length, 3.0):
                    q = np.array(g.interpolate(s).coords[0])
                    v = q - e
                    d = float(np.hypot(*v))
                    ang = angle(v, t)
                    if 12 < d <= BRIDGE_M and ang <= 20 and (best is None or d < best[1]):
                        best = (d * (1 + ang / 20), d, e, q, j, s)
                if best and pic.over_river(best[2], best[3]):
                    cands.append(best + (me, None, l['k'], 'bridge'))
    # two road ends pointing at each other (the road between them hidden under icons or a power line drawn along it)
    tips = []
    for li, side in ends:
        l = lines[li]
        if l['k'] < 3:
            p = l['pts'] if side == 0 else l['pts'][::-1]
            tips.append((p[0], tangent(p), l['a'] if side == 0 else l['b'], l['k']))
    for x in range(len(tips)):
        e1, t1, n1, k1 = tips[x]
        for y in range(x + 1, len(tips)):
            e2, t2, n2, k2 = tips[y]
            v = e2 - e1
            d = float(np.hypot(*v))
            if d > FACE_GAP_M or d < 0.5 or n1 == n2:
                continue
            a1, a2 = angle(v, t1), angle(-v, t2)
            if max(a1, a2) > 45:
                continue
            cands.append((0.7 * d * (1 + (a1 + a2) / 90), d, e1, e2, None, 0, n1, n2, max(k1, k2), 'face'))
    cands.sort(key=lambda c: c[0])
    made, done = [], set()
    for cost, d, e, q, j, s, me, other, k, how in cands:
        if me in done or other in done:
            continue
        if other is not None:
            goals = {other: 0.0}
        else:
            L = geoms[j].length
            ja, jb = lines[j]['a'], lines[j]['b']
            goals = {ja: s, jb: L - s}
        # already joined close by? (a junction the trace did find, or a gap closed a moment ago)
        if graph_dist(adj, me, goals, max(3 * d, d + 60)) < math.inf:
            continue
        if other is None and (d > NEAR_GAP_M + 10 or how == 'bridge') and pic.ground_share(e, q) > 0.25:
            continue
        done.add(me)
        if other is not None:
            done.add(other)
            link(me, other, d)
        else:
            lines[j]['pts'] = insert_vertex(lines[j]['pts'], q)
            mid = ('gap', len(made))
            link(me, mid, d)
            link(mid, ja, s)
            link(mid, jb, L - s)
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
        return np.array([pts[0], pts[-1]])   # a few metres: straight
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
    return unjog(rdp(xy, eps))


def split_edge(out, nd, i, q):
    """Put a new junction at point q on edge i (splitting it in two); returns the new node."""
    a, b, k, p = out[i]
    p = np.asarray(p, float)
    best, bi = 1e18, 0
    for s in range(len(p) - 1):
        ab = p[s + 1] - p[s]
        t = np.clip(((q - p[s]) @ ab) / (ab @ ab + 1e-12), 0, 1)
        d = np.hypot(*(p[s] + t * ab - q))
        if d < best:
            best, bi = d, s
    n = len(nd)
    nd.append(np.array(q, float))
    out[i] = [a, n, k, np.vstack([p[:bi + 1], [q]])]
    out.append([n, b, k, np.vstack([[q], p[bi + 1:]])])
    return n


def join_pieces(out, nd):
    """Tie every piece that isn't joined to the rest to the nearest road or path of another piece: at a crossing, or
    from one of its loose ends within JOIN_PIECE_M. Repeats until nothing more joins."""
    made = 0
    while True:
        uf = UF()
        deg = Counter()
        for a, b, k, p in out:
            uf.union(a, b)
            deg[a] += 1
            deg[b] += 1
        comp = Counter()
        for a, b, k, p in out:
            comp[uf.find(a)] += length(p)
        if len(comp) < 2:
            return made
        main_c = max(comp, key=comp.get)
        geoms = [LineString(p) for a, b, k, p in out]
        tree = STRtree(geoms)
        joined = False
        for c in sorted(comp, key=comp.get):
            if c == main_c:
                continue
            mine = [i for i, e in enumerate(out) if uf.find(e[0]) == c]
            best = None
            for i in mine:   # a crossing with another piece
                for j in tree.query(geoms[i]):
                    if uf.find(out[j][0]) == c:
                        continue
                    x = geoms[i].intersection(geoms[j])
                    if not x.is_empty:
                        q = np.array((x.geoms[0] if hasattr(x, 'geoms') else x).coords[0])
                        best = (0.0, i, j, q)
                        break
                if best:
                    break
            if best:
                _, i, j, q = best
                n1 = split_edge(out, nd, i, q)
                split_edge(out, nd, j, q)
                out[j][1] = out[-1][0] = n1   # both lines through the one new junction
                joined = True
                made += 1
                break
            for i in mine:   # a loose end close to another piece
                a, b, k, p = out[i]
                for nd_i, e in ((a, p[0]), (b, p[-1])):
                    if deg[nd_i] != 1:
                        continue
                    for j in tree.query(Point(e).buffer(JOIN_PIECE_M)):
                        if uf.find(out[j][0]) == c:
                            continue
                        g = geoms[j]
                        q = np.array(g.interpolate(g.project(Point(e))).coords[0])
                        d = float(np.hypot(*(q - e)))
                        if d <= JOIN_PIECE_M and (best is None or d < best[0]):
                            best = (d, nd_i, j, q, max(k, out[j][2]))
            if best:
                d, nd_i, j, q, k = best
                n2 = split_edge(out, nd, j, q)
                out.append([nd_i, n2, k, np.array([nd[nd_i], q])])
                joined = True
                made += 1
                break
            for i in mine:   # no loose end (a loop), but passing within a few metres of another piece
                for j in tree.query(geoms[i].buffer(TOUCH_M)):
                    if uf.find(out[j][0]) == c:
                        continue
                    from shapely.ops import nearest_points
                    p1, p2 = nearest_points(geoms[i], geoms[j])
                    d = p1.distance(p2)
                    if d <= TOUCH_M and (best is None or d < best[0]):
                        best = (d, i, j, np.array(p1.coords[0]), np.array(p2.coords[0]))
            if best:
                d, i, j, q1, q2 = best
                n1 = split_edge(out, nd, i, q1)
                n2 = split_edge(out, nd, j, q2)
                out.append([n1, n2, max(out[i][2], out[j][2]), np.array([q1, q2])])
                joined = True
                made += 1
                break
        if not joined:
            return made


def gauss_line(xy, sigma, step):
    """Gaussian average of evenly spaced points along a line; the two ends stay put and keep their direction."""
    k = int(round(3 * sigma / step))
    if k < 1 or len(xy) < 3:
        return xy
    w = np.exp(-0.5 * (np.arange(-k, k + 1) * step / sigma) ** 2)
    w /= w.sum()
    n = len(xy)
    idx = np.arange(-k, n + k)
    # reflect through the end points (odd extension), repeating the reflection for lines shorter than the window
    ext = np.empty((len(idx), 2))
    for j, i in enumerate(idx):
        if i < 0:
            ext[j] = 2 * xy[0] - xy[min(n - 1, -i)]
        elif i >= n:
            ext[j] = 2 * xy[-1] - xy[max(0, 2 * (n - 1) - i)]
        else:
            ext[j] = xy[i]
    out = np.stack([np.convolve(ext[:, c], w, mode='valid') for c in (0, 1)], axis=1)
    out[0], out[-1] = xy[0], xy[-1]
    return out


def smooth_network(out, nd):
    """Smooth each road as one line through its junctions (a road carries straight on through a junction where a side
    road joins it), then move the junction onto the smoothed road, so through-roads have no jog at every junction.
    Returns node positions {node: xy} and each edge's smoothed points."""
    ends = {}
    for i, (a, b, k, p) in enumerate(out):
        p = np.asarray(p, float)
        for side, node, q in ((0, a, p), (1, b, p[::-1])):
            ls = LineString(q)
            v = np.array(ls.interpolate(min(12.0, ls.length / 2)).coords[0]) - q[0]
            ends.setdefault(node, []).append((i, side, v / (np.hypot(*v) or 1), k))
    # at each junction pair the two ends that run most nearly straight through, the most important roads first
    pair = {}
    for node, es in ends.items():
        cands = []
        for x in range(len(es)):
            for y in range(x + 1, len(es)):
                i1, s1, v1, k1 = es[x]
                i2, s2, v2, k2 = es[y]
                if i1 == i2 or (k1 == 3) != (k2 == 3):   # roads with roads, paths with paths
                    continue
                turn = angle(v1, -v2)
                if turn <= THROUGH_TURN:
                    cands.append((min(k1, k2), (k1 != k2), turn, (i1, s1), (i2, s2)))
        for *_, e1, e2 in sorted(cands):
            if e1 not in pair and e2 not in pair:
                pair[e1], pair[e2] = e2, e1
    # strokes: runs of edges joined through junctions
    seen, strokes = set(), []
    for i in range(len(out)):
        if i in seen:
            continue
        seen.add(i)
        seq = [(i, False)]   # (edge, walked backwards?)
        for back in (False, True):
            cur = (i, 0) if back else (i, 1)   # the end of the run we carry on from
            while cur in pair:
                j, sj = pair[cur]               # edge j meets it at j's end sj
                if j in seen:
                    break
                seen.add(j)
                if back:                        # j comes before: it must run out through sj
                    seq.insert(0, (j, sj == 0))
                else:                           # j comes after: it runs on from sj
                    seq.append((j, sj == 1))
                cur = (j, 1 - sj)
        kind = min(out[j][2] for j, _ in seq)
        L = sum(length(out[j][3]) for j, _ in seq)
        strokes.append((kind, -L, seq))
    strokes.sort(key=lambda s: (s[0], s[1]))
    pos, pts = {}, {}
    for kind, _, seq in strokes:
        # the stroke as one line, with where each junction falls along it
        line, cut, nodes = [], [0.0], []
        for j, rev in seq:
            a, b, k, p = out[j]
            p = np.asarray(p, float)[::-1] if rev else np.asarray(p, float)
            na, nb = (b, a) if rev else (a, b)
            if not nodes:
                nodes.append(na)
            nodes.append(nb)
            p = p.copy()
            p[0] = pos.get(na, nd[na])
            p[-1] = pos.get(nb, nd[nb])
            line.append(p if not line else p[1:])
            cut.append(cut[-1] + length(p))
        line = np.vstack(line)
        ls = LineString(line)
        total = ls.length
        if total < 1e-6:
            for j, rev in seq:
                pts[j] = np.asarray(out[j][3], float)
            continue
        cut = [c * total / cut[-1] for c in cut]
        s = np.union1d(np.linspace(0, total, max(2, int(total / STEP_M)) + 1), cut)
        xy = np.array([ls.interpolate(d).coords[0] for d in s])
        xy = gauss_line(xy, STROKE_SIGMA[kind], total / max(1, len(s) - 1))
        at = [int(np.argmin(np.abs(s - c))) for c in cut]
        for n, i in zip(nodes, at):
            if n in pos:
                xy[i] = pos[n]          # a junction placed already by a more important road
            else:
                pos[n] = xy[i].copy()
        for (j, rev), i0, i1 in zip(seq, at[:-1], at[1:]):
            piece = xy[i0:i1 + 1] if i1 > i0 else np.array([xy[i0], xy[i1]])
            pts[j] = piece[::-1] if rev else piece
    return pos, [pts[i] for i in range(len(out))]


def unjog(p, short=3.0, turn=60):
    """Take out sharp jogs on very short segments (a metre or two where a line was pulled onto a junction)."""
    p = list(p)
    i = 1
    while 0 < i < len(p) - 1:
        v1, v2 = np.asarray(p[i]) - p[i - 1], np.asarray(p[i + 1]) - p[i]
        l1, l2 = np.hypot(*v1), np.hypot(*v2)
        if min(l1, l2) < short and l1 > 0 and l2 > 0 and angle(v1, v2) > turn:
            del p[i]
            i = max(1, i - 1)
        else:
            i += 1
    return np.array(p)


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
    pic = Picture(os.path.join(HERE, 'roads', 'Everon-1989.jpg'))
    gaps = close_gaps(lines, ends, pic)
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

    # junctions a metre or two apart are one junction (paths meeting a road or each other a little off the same spot)
    from scipy.spatial import cKDTree
    used = sorted({e[0] for e in out} | {e[1] for e in out})
    uf = UF()
    for i, j in cKDTree(np.array([nd[u] for u in used])).query_pairs(MERGE_M):
        uf.union(used[i], used[j])
    groups = {}
    for u in used:
        groups.setdefault(uf.find(u), []).append(u)
    for r, m in groups.items():
        if len(m) > 1:
            nd[r] = np.mean([nd[u] for u in m], axis=0)
    merged = []
    for a, b, k, p in out:
        ra, rb = uf.find(a), uf.find(b)
        p = np.array(p, float)
        p[0], p[-1] = nd[ra], nd[rb]
        if ra == rb and length(p) < LOOP_M:
            continue
        merged.append([ra, rb, k, p])
    out = merged

    # small loops of foot path (where the lengthened ends of neighbouring dashes crossed): drop the longest side while
    # the way round the other sides is about as short
    adj = {}
    for i, (a, b, k, p) in enumerate(out):
        adj.setdefault(a, []).append((b, length(p), i))
        adj.setdefault(b, []).append((a, length(p), i))
    gone = set()
    for i in sorted((i for i, e in enumerate(out) if e[2] == 3), key=lambda i: -length(out[i][3])):
        a, b, k, p = out[i]
        L = length(p)
        if L > LOOP_M or a == b:
            continue
        sub = {u: [(v, w) for v, w, j in vs if j != i and j not in gone] for u, vs in adj.items()}
        alt = graph_dist(sub, a, {b: 0.0}, max(1.6 * L, L + 12))
        if alt < math.inf and alt + L < LOOP_M:
            gone.add(i)
    out = [e for i, e in enumerate(out) if i not in gone]
    print('dropped', len(gone), 'small path loops')

    # drop stubs: a road running a few metres past a junction to nowhere (thinning leftovers at icons beside a road)
    for _ in range(2):
        deg = Counter()
        for a, b, k, p in out:
            deg[a] += 1
            deg[b] += 1
        out = [e for e in out if not (length(e[3]) < (MAIN_STUB_M if e[2] == 0 else STUB_M if e[2] < 3 else 12) and min(deg[e[0]], deg[e[1]]) == 1 and max(deg[e[0]], deg[e[1]]) >= 3)]

    print('tied', join_pieces(out, nd), 'separate pieces to the network')

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
    pos, smoothed = smooth_network(out, nd)
    res_nodes = [[round(float(v), 1) for v in pos.get(o, nd[o])] for o in used]
    res_edges = []
    for (a, b, k, p), q in zip(out, smoothed):
        q = unjog(rdp(np.asarray(q, float), SIMPLIFY_M))
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

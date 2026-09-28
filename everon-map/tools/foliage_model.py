"""Turn the foliage measurements into the see-through table the map's "Visual" line of sight uses.

Input:  tools/foliage/foliage_shots.csv and plants.csv (see tools/foliage/README.md)
Output: static/data/foliage.json

The line-of-sight tiles only know, for each 0.5 m spot, whether a tree or a bush stands there and how tall it is there.
So the table gives, for trees and for bushes of each height class, how strongly foliage blocks sight per metre a sight line travels through it
(k, per metre; what's left visible is e^(-sum of k x metres)) at each tenth of the plant's height, from its base (0) to its
top (1). Every plant kind counts as often as it grows on Everon. Height classes (by the plant's drawn height, at its
usual scale on Everon) keep tall trees' bare trunks apart from young spruces that are leafy to the ground; the map
picks the class by how tall the foliage stands at each spot.

Per shot and 0.5 m slice, the measurement gives the share of the view blocked within the plant's width in that slice.
Spread over the plant's full width D (its widest slice), that's a sight line through the middle crossing D metres of
plant and keeping 1 - cover x width / D of the view, so k = -ln(1 - cover x width / D) / D. A bare trunk (solid but
narrow) then counts for little, as it should for a line through a random spot of the plant.

The engine's physics shapes, which mark where plants stand in the tiles, cover less ground than the plants' drawn
leaves: all plants' marked spots add up to 0.62 of the area of their drawn outlines (tools/foliage_model.py --area, over
all tiles). Sight lines cross correspondingly fewer marked metres, so k is raised by 1 / sqrt(0.62) to keep a plant as
see-through as it was measured. Overlapping plants in woods make this an estimate.

Run:  python tools/foliage_model.py [--area]
"""

import argparse
import collections
import csv
import glob
import gzip
import json
import math
import os
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BINS = 10               # tenths of the plant's height
CLASSES = [3, 8, 16]    # height class limits, metres
AREA_RATIO = 0.62       # marked physics area / drawn plant area, from --area
SLICE = 0.5


def load():
    shots = collections.defaultdict(list)
    with open(os.path.join(HERE, 'foliage', 'foliage_shots.csv'), encoding='utf8') as f:
        for r in csv.DictReader(f):
            shots[r['id']].append(r)
    with open(os.path.join(HERE, 'foliage', 'plants.csv'), encoding='utf8') as f:
        plants = {r['prefab']: r for r in csv.DictReader(f)}
    return shots, plants


def profile(slices):
    """One shot: k per tenth of the plant's visible height (None where no slice falls)."""
    width = max(float(s['width_m']) for s in slices)
    top = max([float(s['slice_m']) + SLICE for s in slices if float(s['cover']) > 0.02] or [0])
    if width <= 0 or top <= 0:
        return None, width
    sums, ns = [0.0] * BINS, [0] * BINS
    for s in slices:
        y = float(s['slice_m'])
        if y >= top:
            continue  # the box above the drawn plant
        blocked = min(0.999, float(s['cover']) * float(s['width_m']) / width)
        b = min(BINS - 1, int((y + SLICE / 2) / top * BINS))
        sums[b] += -math.log(1 - blocked) / width
        ns[b] += 1
    return [sums[i] / ns[i] if ns[i] else None for i in range(BINS)], width


def fill(ks):
    """Fill tenths no slice fell in (short plants) from their neighbours."""
    have = [j for j in range(BINS) if ks[j] is not None]
    return [ks[i] if ks[i] is not None else ks[min(have, key=lambda j: abs(j - i))] if have else 0 for i in range(BINS)]


def area_ratio(shots, plants):
    widths = collections.defaultdict(list)
    for s in shots.values():
        widths[s[0]['prefab']].append(max(float(x['width_m']) for x in s))
    drawn = sum(int(p['count']) * math.pi * (statistics.median(widths[k]) * float(p['mean_scale'])) ** 2 / 4
                for k, p in plants.items() if k in widths)
    import numpy as np
    marked = 0
    for fn in glob.glob(os.path.join(ROOT, 'static', 'data', 'los', '*.bin.gz')):
        raw = gzip.open(fn).read()
        kind = np.frombuffer(raw, np.uint8, 1000 * 1000, 501 * 501 * 2 + 2 * 1000 * 1000)
        marked += np.count_nonzero((kind == 3) | (kind == 5)) * 0.25
    return marked / drawn


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--area', action='store_true', help='work out AREA_RATIO again from the tiles and print it')
    args = ap.parse_args()
    shots, plants = load()
    if args.area:
        print(f'marked / drawn plant area: {area_ratio(shots, plants):.3f}')
        return
    per_prefab, heights = collections.defaultdict(list), collections.defaultdict(list)
    for s in shots.values():
        ks, _ = profile(s)
        if ks:
            per_prefab[s[0]['prefab']].append(ks)
            heights[s[0]['prefab']].append(max(float(x['slice_m']) + SLICE for x in s if float(x['cover']) > 0.02))
    scale = 1 / math.sqrt(AREA_RATIO)
    out = {'bins': BINS, 'classes': CLASSES,
           'note': 'per kind and height class, k per metre at each tenth of a plant\'s height, base to top; made by tools/foliage_model.py'}
    for kind in ('tree', 'bush'):
        table = []
        for c in range(len(CLASSES) + 1):
            lo, hi = ([0] + CLASSES)[c], (CLASSES + [1e9])[c]
            sums, weights = [0.0] * BINS, [0.0] * BINS
            for prefab, profiles in per_prefab.items():
                h = statistics.median(heights[prefab]) * float(plants[prefab]['mean_scale'])
                if plants[prefab]['kind'] != kind or not lo <= h < hi:
                    continue
                w = int(plants[prefab]['count'])
                for ks in profiles:
                    for i, v in enumerate(fill(ks)):
                        sums[i] += v * w / len(profiles)
                        weights[i] += w / len(profiles)
            table.append([round(sums[i] / weights[i] * scale, 4) for i in range(BINS)] if weights[0] else None)
        # a class with no plants of this kind takes the nearest class's rates
        have = [c for c, t in enumerate(table) if t]
        out[kind] = [t or table[min(have, key=lambda j: abs(j - c))] for c, t in enumerate(table)]
        for c, t in enumerate(out[kind]):
            print(kind, f'{([0] + CLASSES)[c]}+ m', ' '.join(f'{v:.2f}' for v in t), '' if table[c] else '(copied)')
    path = os.path.join(ROOT, 'static', 'data', 'foliage.json')
    with open(path, 'w', encoding='utf8') as f:
        json.dump(out, f, indent=1)
    print('wrote', path)


if __name__ == '__main__':
    sys.exit(main())

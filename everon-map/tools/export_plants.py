"""Pull every standing tree and bush on Everon out of the island object export, for the map's per-plant line of sight.

Input:  the "Island: objects" export from the Everon LOS Export tool (objects/o_X_Z.csv, every object on the island)
        and tools/foliage/plants.csv (the measured kinds of plant)
Output: tools/foliage/everon_plants.csv.gz, one line per plant:
          kind   row of plants.csv (0 = its first plant), so the plant's measured profile can be looked up
          x, z   position (m)
          scale  size relative to the measured plant
          r      half the width of its bounding box (m)
          top    top of its bounding box (m, world height)
Plants that reach into two export tiles are listed once. Kinds that weren't measured (stumps, fallen trunks,
branches, debris) are left out.

Run:  python tools/export_plants.py [--src "<export folder>"]
"""

import argparse
import csv
import gzip
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--src', default=os.path.expanduser('~/Documents/My Games/ArmaReforgerWorkbench/profile/everon_los'))
    args = ap.parse_args()
    with open(os.path.join(HERE, 'foliage', 'plants.csv'), encoding='utf8') as f:
        kinds = {r['prefab']: i for i, r in enumerate(csv.DictReader(f))}
    folder = os.path.join(args.src, 'objects')
    if not os.path.isdir(folder):
        sys.exit(f'No objects folder in {args.src} - point --src at the folder holding objects/, terrain/ and surface/')
    seen, rows, unknown = set(), [], {}
    for fn in sorted(os.listdir(folder)):
        with open(os.path.join(folder, fn), encoding='utf8', errors='replace') as f:
            for r in csv.DictReader(f):
                p = r['prefab']
                if '/Vegetation/' not in p:
                    continue
                k = kinds.get(p)
                if k is None:
                    unknown[p] = unknown.get(p, 0) + 1
                    continue
                x, z = float(r['x']), float(r['z'])
                key = (k, round(x, 2), round(z, 2))
                if key in seen:
                    continue
                seen.add(key)
                rad = max(float(r['maxx']) - float(r['minx']), float(r['maxz']) - float(r['minz'])) / 2
                rows.append((k, round(x, 2), round(z, 2), round(float(r['scale']), 3), round(rad, 2), round(float(r['maxy']), 2)))
    out = os.path.join(HERE, 'foliage', 'everon_plants.csv.gz')
    with gzip.open(out, 'wt', encoding='utf8', newline='') as f:
        w = csv.writer(f)
        w.writerow(['kind', 'x', 'z', 'scale', 'r', 'top'])
        w.writerows(sorted(rows))
    print(f'{len(rows)} plants of {len({r[0] for r in rows})} kinds written to {out} ({os.path.getsize(out) / 1e6:.1f} MB)')
    if unknown:
        print(f'Left out {sum(unknown.values())} other vegetation objects, e.g.:')
        for p, n in sorted(unknown.items(), key=lambda i: -i[1])[:8]:
            print(f'  {n:7d}  {p}')


if __name__ == '__main__':
    sys.exit(main())

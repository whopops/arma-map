"""Measure how see-through trees and bushes are, from the Everon Foliage Measure screenshots.

Input (from the "Everon Foliage Measure" tool in Workbench, see tools/workbench): a folder holding shots.csv and, for
every shot, <id>_a.png (the plant shown) and <id>_b.png (the same view with the plant hidden).

For each shot the pixels that differ between the two images are where the plant blocks the view. The plant is cut
into 0.5 m slices by height above its ground; in each slice, "cover" is the share of the plant's outline that blocks
the view, and "k" is how quickly it blocks sight per metre of plant a sight line crosses (cover = 1 - e^(-k x width),
taking the plant to be about as deep as it is wide). Exposure differences between the two images are evened out
from the parts of the picture away from the plant.

Output, in the same folder:
  foliage_shots.csv      one line per shot and slice: id, prefab, kind, slice bottom (m), cover, k, width (m), pixels
  foliage_profiles.json  per kind of plant: height, and per slice the average cover and k over all its shots
  debug/<id>.png         the shot with what counted as plant tinted red and the slice lines drawn (first --debug shots)

Run:  python tools/measure_foliage.py [--src "<foliage folder>"] [--debug 20]
Needs numpy and Pillow (pip install numpy pillow).
"""

import argparse
import csv
import json
import math
import os
import sys

import numpy as np

SLICE = 0.5         # metres
THRESHOLD = 24      # 0-255: how much a pixel must change to count as blocked by the plant
MIN_ROWS = 2        # a slice needs at least this many image rows to be measured


def load_rgb(path):
    from PIL import Image
    with Image.open(path) as im:
        return np.asarray(im.convert('RGB'), dtype=np.float32)


def camera(row, w, h):
    """The camera's position, axes and focal length (pixels) for a shot."""
    cam = np.array([float(row['camx']), float(row['camy']), float(row['camz'])])
    dx, dz = float(row['dirx']), float(row['dirz'])
    p = math.radians(float(row['pitch']))
    fwd = np.array([dx * math.cos(p), math.sin(p), dz * math.cos(p)])
    right = np.array([dz, 0.0, -dx])
    up = np.cross(fwd, right)
    f = (h / 2) / math.tan(math.radians(float(row['fov'])) / 2)
    return cam, fwd, right, up, f


def project(points, cam, fwd, right, up, f, w, h):
    """World points (N x 3: x, y up, z north) to pixel columns and rows."""
    rel = np.asarray(points, dtype=np.float64) - cam
    z = rel @ fwd
    u = w / 2 + f * (rel @ right) / z
    v = h / 2 - f * (rel @ up) / z
    return u, v, z


def measure(row, src, debug_dir=None):
    a = load_rgb(os.path.join(src, row['id'] + '_a.png'))
    b = load_rgb(os.path.join(src, row['id'] + '_b.png'))
    if a.shape != b.shape:
        raise ValueError('the two screenshots are different sizes (was the viewport resized?)')
    h, w = a.shape[:2]
    cam, fwd, right, up, f = camera(row, w, h)

    # Where the plant can be in the picture: its bounding box, projected, with a margin.
    mn = [float(row[k]) for k in ('minx', 'miny', 'minz')]
    mx = [float(row[k]) for k in ('maxx', 'maxy', 'maxz')]
    corners = np.array([[x, y, z] for x in (mn[0], mx[0]) for y in (mn[1], mx[1]) for z in (mn[2], mx[2])])
    u, v, _ = project(corners, cam, fwd, right, up, f, w, h)
    pad = 0.03 * w
    u0, u1 = int(max(0, u.min() - pad)), int(min(w, u.max() + pad))
    v0, v1 = int(max(0, v.min() - pad)), int(min(h, v.max() + pad))
    if u1 - u0 < 4 or v1 - v0 < 4:
        raise ValueError('the plant is outside the picture')

    # Even out exposure: the brightness ratio between the images away from the plant.
    lum_a, lum_b = a.mean(axis=2), b.mean(axis=2)
    outside = np.ones((h, w), bool)
    outside[v0:v1, u0:u1] = False
    ok = outside & (lum_b > 12) & (lum_a > 12)
    ratio = float(np.median(lum_a[ok] / lum_b[ok])) if ok.sum() > 1000 else 1.0
    diff = np.abs(a - b * ratio).max(axis=2)
    blocked = np.zeros((h, w), bool)
    blocked[v0:v1, u0:u1] = diff[v0:v1, u0:u1] > THRESHOLD

    # Slices by height above the plant's ground, measured on the upright plane through the plant's middle.
    cx, cz, ground, height = float(row['x']), float(row['z']), float(row['ground']), float(row['height'])
    depth = float(np.dot(np.array([cx, ground, cz]) - cam, fwd))
    m_per_px = depth / f
    out = []
    n_slices = int(math.ceil(height / SLICE))
    for i in range(n_slices):
        y0, y1 = i * SLICE, min((i + 1) * SLICE, height)
        _, vv, _ = project([[cx, ground + y0, cz], [cx, ground + y1, cz]], cam, fwd, right, up, f, w, h)
        r0, r1 = int(max(v0, math.floor(min(vv)))), int(min(v1, math.ceil(max(vv))))
        if r1 - r0 < MIN_ROWS:
            continue
        band = blocked[r0:r1, u0:u1]
        cols = np.nonzero(band.any(axis=0))[0]
        if not len(cols):
            out.append(dict(y=y0, cover=0.0, k=0.0, width=0.0, px=0))
            continue
        c0, c1 = cols[0], cols[-1] + 1  # the plant's outline in this slice
        area = band[:, c0:c1]
        cover = float(area.mean())
        width = (c1 - c0) * m_per_px
        k = -math.log(max(1e-3, 1 - min(cover, 0.999))) / max(width, 0.25)
        out.append(dict(y=y0, cover=round(cover, 4), k=round(k, 4), width=round(width, 3), px=int(area.size)))

    if debug_dir is not None:
        from PIL import Image
        img = a.copy()
        img[blocked] = img[blocked] * 0.4 + np.array([255, 0, 0]) * 0.6
        for i in range(n_slices + 1):
            _, vv, _ = project([[cx, ground + i * SLICE, cz]], cam, fwd, right, up, f, w, h)
            r = int(round(vv[0]))
            if 0 <= r < h:
                img[r, u0:u1] = [255, 255, 0]
        img[v0:v1, [u0, u1 - 1]] = [0, 255, 255]
        img[[v0, v1 - 1], u0:u1] = [0, 255, 255]
        os.makedirs(debug_dir, exist_ok=True)
        Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(os.path.join(debug_dir, row['id'] + '.png'))
    return out, ratio


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--src', default=os.path.expanduser('~/Documents/My Games/ArmaReforgerWorkbench/profile/everon_los/foliage'))
    ap.add_argument('--debug', type=int, default=20, help='save marked-up pictures of the first N shots (0 = none, -1 = all)')
    args = ap.parse_args()
    src = args.src
    with open(os.path.join(src, 'shots.csv'), encoding='utf8') as f:
        rows = list(csv.DictReader(f))
    # A shot run again (after a stop) is written twice: keep the last line for each id.
    rows = list({r['id']: r for r in rows}.values())
    print(f'{len(rows)} shots in {src}')

    per_kind = {}
    lines, bad = [], 0
    for n, row in enumerate(rows):
        if not (os.path.exists(os.path.join(src, row['id'] + '_a.png')) and os.path.exists(os.path.join(src, row['id'] + '_b.png'))):
            continue
        debug = os.path.join(src, 'debug') if args.debug < 0 or n < args.debug else None
        try:
            slices, ratio = measure(row, src, debug)
        except Exception as e:  # one bad shot shouldn't stop the rest
            bad += 1
            print(f'  {row["id"]}: skipped ({e})')
            continue
        if abs(ratio - 1) > 0.15:
            print(f'  {row["id"]}: exposure changed by {abs(ratio - 1):.0%} between the two pictures (evened out)')
        p = per_kind.setdefault(row['prefab'], dict(kind=row['kind'], heights=[], slices={}))
        p['heights'].append(float(row['height']))
        for s in slices:
            lines.append([row['id'], row['prefab'], row['kind'], s['y'], s['cover'], s['k'], s['width'], s['px']])
            p['slices'].setdefault(s['y'], []).append((s['cover'], s['k']))
        if (n + 1) % 50 == 0:
            print(f'  {n + 1}/{len(rows)}')

    with open(os.path.join(src, 'foliage_shots.csv'), 'w', newline='', encoding='utf8') as f:
        wr = csv.writer(f)
        wr.writerow(['id', 'prefab', 'kind', 'slice_m', 'cover', 'k', 'width_m', 'pixels'])
        wr.writerows(lines)
    profiles = {}
    for prefab, p in sorted(per_kind.items()):
        profiles[prefab] = dict(
            kind=p['kind'], shots=len(p['heights']), height=round(float(np.median(p['heights'])), 2),
            slices=[dict(y=y, cover=round(float(np.mean([c for c, _ in v])), 3), k=round(float(np.mean([k for _, k in v])), 3), n=len(v))
                    for y, v in sorted(p['slices'].items())])
    with open(os.path.join(src, 'foliage_profiles.json'), 'w', encoding='utf8') as f:
        json.dump(profiles, f, indent=1)

    trees = [p for p in profiles.values() if p['kind'] == 'tree']
    bushes = [p for p in profiles.values() if p['kind'] == 'bush']
    def avg_cover(ps):
        c = [s['cover'] for p in ps for s in p['slices']]
        return f'{np.mean(c):.0%}' if c else '-'
    print(f'Done: {len(profiles)} kinds of plant ({len(trees)} trees, {len(bushes)} bushes), {bad} shots skipped.')
    print(f'Average share of the view blocked inside a plant\'s outline: trees {avg_cover(trees)}, bushes {avg_cover(bushes)}')
    print(f'Wrote foliage_shots.csv and foliage_profiles.json in {src}')


if __name__ == '__main__':
    sys.exit(main())

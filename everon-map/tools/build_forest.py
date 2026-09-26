"""Estimate Everon's tree cover from the satellite map and write static/data/everon-forest.bin.

The map has no forest data, but forests are easy to see from above: dark (conifers) or medium-dark and heavily
textured (mixed woods), while fields, grass, rock, roads and towns are brighter or smoother. This script stitches
the map tiles at 1.5 m per pixel, measures each 10 m cell (the same grid as the heightmap), and marks a cell as
forest when:

    on land (heightmap above 1 m)  and  slightly green  and  not smooth (so ponds are left out)  and
    (brightness < 62  or  (brightness < 78 and texture > 15.5))

using each cell's average over its 3 x 3 neighbourhood, then keeps a cell only if at least 5 of the 9 around it
agree, which removes speckle. Thresholds were tuned by eye against the imagery around Levie, the southern hills and
the northern farmland. It is an estimate: tree shadows on grass can count as forest, and single trees and thin
hedgerows are usually missed.

Output: 1280 x 1280 bits, one per 10 m cell, row 0 = the south edge (like everon-height.bin), packed
most-significant bit first; 204 800 bytes.

Needs Pillow and numpy. Missing tiles are fetched through the map server, so start it first:
    python server.py
    python tools/build_forest.py
"""
import os
import sys
import urllib.request

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TILE_DIR = 3                        # tiles/3 = Leaflet zoom 2: each tile is 800 m square
TILES = 16                          # 16 x 16 tiles cover the map
TILE_PX = 542                       # tile images are 542 px (the map shows them at 256)
MPP = 12.501 / 4 * 256 / TILE_PX    # metres per tile pixel (~1.48)
TOP = TILES * 256 * 12.501 / 4      # map latitude (game Z + 50) of the mosaic's top edge
CELLS, CELL_PX = 1280, 7            # 10 m cells, each resampled to 7 x 7 px for the texture measure
PAD = 64                            # sea margin: the tiles stop just short of the grid's top and right edges
DARK, MEDIUM, TEXTURE = 62, 78, 15.5
SERVER = os.environ.get('EVERON_SERVER', 'http://127.0.0.1:8765')


def tile(x, y):
    path = os.path.join(ROOT, 'tile_cache', str(TILE_DIR), str(x), f'{y}.jpg')
    if not os.path.isfile(path):
        try:  # the server downloads and caches it
            urllib.request.urlopen(f'{SERVER}/tiles/{TILE_DIR}/{x}/{y}.jpg', timeout=30).read()
        except Exception:
            return None  # open sea has no tile
    return Image.open(path).convert('RGB') if os.path.isfile(path) else None


def neighbourhood(a, fn):
    p = np.pad(a, 1, mode='edge')
    return fn([p[1 + dy:CELLS + 1 + dy, 1 + dx:CELLS + 1 + dx] for dy in (-1, 0, 1) for dx in (-1, 0, 1)])


def main():
    mosaic = Image.new('RGB', (TILES * TILE_PX + 2 * PAD,) * 2, (22, 35, 45))
    missing = 0
    for x in range(TILES):
        for y in range(TILES):  # y = 0 is the southern row
            t = tile(x, y)
            if t is None:
                missing += 1
            else:
                mosaic.paste(t, (PAD + x * TILE_PX, PAD + (TILES - 1 - y) * TILE_PX))
    print(f'{TILES * TILES - missing} tiles stitched ({missing} open-sea tiles missing)')

    # Resample the game grid (0..12800 m, Leaflet +50 m offset) so every 10 m cell is CELL_PX x CELL_PX pixels.
    box = (PAD + 50 / MPP, PAD + (TOP - 12850) / MPP, PAD + 12850 / MPP, PAD + (TOP - 50) / MPP)
    a = np.asarray(mosaic.resize((CELLS * CELL_PX,) * 2, Image.BILINEAR, box=box), dtype=np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    per_cell = lambda v: v.reshape(CELLS, CELL_PX, CELLS, CELL_PX)
    lum = per_cell(0.299 * r + 0.587 * g + 0.114 * b)
    bright = neighbourhood(lum.mean(axis=(1, 3)), lambda n: sum(n) / 9)
    texture = neighbourhood(lum.std(axis=(1, 3)), lambda n: sum(n) / 9)
    green = per_cell(g - (r + b) / 2).mean(axis=(1, 3))
    height = np.fromfile(os.path.join(ROOT, 'static', 'data', 'everon-height.bin'), dtype=np.int16).reshape(CELLS, CELLS)[::-1] / 10

    raw = (height > 1) & (green > 2) & (texture > 6) & ((bright < DARK) | ((bright < MEDIUM) & (texture > TEXTURE)))
    forest = neighbourhood(raw.astype(np.uint8), sum) >= 5  # majority of the 3 x 3 around each cell

    out = os.path.join(ROOT, 'static', 'data', 'everon-forest.bin')
    np.packbits(forest[::-1].ravel()).tofile(out)  # row 0 = south, like the heightmap
    land = (height > 1).sum()
    print(f'forest: {forest.sum()} cells, {forest.sum() / land * 100:.1f}% of the land -> {out}')


if __name__ == '__main__':
    sys.exit(main())

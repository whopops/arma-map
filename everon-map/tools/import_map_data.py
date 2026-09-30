"""Bring a map's baked data from reforger-map-tools into the site.

reforger-map-tools writes, per map, out/<slug>/<build>/site/ with roads.json, places.json, foliage.json, plants/, los/,
light/, tiles/ and foliage/. This copies what the site uses to static/data/maps/<id>/ (the layout app.js's MAPS table
expects):

    roads.json                the road network
    places.json               town and landmark names
    foliage.json, plants/     every tree and bush (position, ground height, scale, kind) and how see-through each kind is
    los/                      500 m line-of-sight tiles and index.json
    light/                    10 m grids (height, forest, canopy, buildings, lz, foliage, clutter)
    foliage/foliage_profiles.json   the measured plant profiles for the Measured line of sight
    tiles/                    satellite tiles, for every map but Everon (its come from the server's /tiles/ cache;
                              pass --tiles to copy those too)

foliage_shots.csv, the raw measurements, is a working file and isn't copied.

Files of the same size that are already there are left alone, so a re-run is quick.

Run:  python tools/import_map_data.py [--src <reforger-map-tools/out>] [--build 24903726] [--tiles] [map ...]
"""

import argparse
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(HERE), 'static', 'data')
SLUGS = {'everon': 'eden-853e92', 'kolguyev': 'cain-1ea95d', 'arland': 'arland-a9806a'}


def copy_tree(src, dst):
    # only what changed: a file of the same size already there is left alone (so a re-run doesn't recopy the tiles)
    def keep_new(s, d):
        if os.path.isfile(d) and os.path.getsize(d) == os.path.getsize(s):
            return d
        return shutil.copy2(s, d)
    shutil.copytree(src, dst, copy_function=keep_new, dirs_exist_ok=True)
    files = [os.path.join(r, f) for r, _, fs in os.walk(dst) for f in fs]
    print(f'  {os.path.relpath(dst, DATA)}: {len(files)} files, {sum(os.path.getsize(f) for f in files) / 1e6:.1f} MB')


def copy_file(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copyfile(src, dst)
    print(f'  {os.path.relpath(dst, DATA)}: {os.path.getsize(dst) / 1e6:.2f} MB')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('maps', nargs='*', default=list(SLUGS), help='everon, kolguyev, arland (default: all)')
    ap.add_argument('--src', default=os.path.expanduser('~/Projects/reforger-map-tools/out'))
    ap.add_argument('--build', default='24903726')
    ap.add_argument('--tiles', action='store_true', help="also copy Everon's satellite tiles")
    args = ap.parse_args()
    for m in args.maps:
        if m not in SLUGS:
            sys.exit(f'Unknown map {m}: use one of {", ".join(SLUGS)}')
        site = os.path.join(args.src, SLUGS[m], args.build, 'site')
        if not os.path.isdir(site):
            sys.exit(f'No baked data at {site}')
        out = os.path.join(DATA, 'maps', m)
        print(m)
        copy_file(os.path.join(site, 'foliage', 'foliage_profiles.json'), os.path.join(out, 'foliage', 'foliage_profiles.json'))
        for name in ('roads.json', 'places.json', 'foliage.json'):
            copy_file(os.path.join(site, name), os.path.join(out, name))
        for name in ('plants', 'los', 'light') + (('tiles',) if m != 'everon' or args.tiles else ()):
            copy_tree(os.path.join(site, name), os.path.join(out, name))


if __name__ == '__main__':
    main()

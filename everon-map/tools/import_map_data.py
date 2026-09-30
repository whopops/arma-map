"""Bring a map's baked data from reforger-map-tools into the site.

reforger-map-tools writes, per map, out/<slug>/<build>/site/ with roads.json, los/, light/, tiles/ and foliage/.
This copies what the site uses to static/data/maps/<id>/ (the layout app.js's MAPS table expects):

    kolguyev, arland   roads.json, los/ (500 m tiles + index.json), light/ (10 m grids), tiles/ (satellite),
                       foliage/foliage_profiles.json
    everon             only foliage/foliage_profiles.json and foliage/plants.json. Everon's satellite tiles, line-of-sight
                       tiles and light grids stay where they always were (the new ones are byte-identical), and so do its
                       roads (from the game's own road pieces, tools/import_game_roads.py).

plants.json is the plant list the Measured line of sight reads: {"kinds": [prefab, ...] in the order of the kind numbers
stored in each plant tile, "tiles": [...], "margin": m, "dir": folder of the plant tiles}. For Everon it's made from
tools/foliage/plants.csv and static/data/foliage.json (the tiles data/plants/ already holds). For another map it comes
from that map's own tree bake; until there is one, that map has no plants.json and app.js's MAPS entry says plants: null.

Run:  python tools/import_map_data.py [--src <reforger-map-tools/out>] [--build 24903726] [map ...]
"""

import argparse
import csv
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(HERE), 'static', 'data')
SLUGS = {'everon': 'eden-853e92', 'kolguyev': 'cain-1ea95d', 'arland': 'arland-a9806a'}


def copy_tree(src, dst):
    if os.path.isdir(dst):
        shutil.rmtree(dst)
    shutil.copytree(src, dst)
    files = [os.path.join(r, f) for r, _, fs in os.walk(dst) for f in fs]
    print(f'  {os.path.relpath(dst, DATA)}: {len(files)} files, {sum(os.path.getsize(f) for f in files) / 1e6:.1f} MB')


def copy_file(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copyfile(src, dst)
    print(f'  {os.path.relpath(dst, DATA)}: {os.path.getsize(dst) / 1e6:.2f} MB')


def everon_plants_json(dst):
    with open(os.path.join(HERE, 'foliage', 'plants.csv'), encoding='utf8') as f:
        kinds = [r['prefab'] for r in csv.DictReader(f)]
    with open(os.path.join(DATA, 'foliage.json'), encoding='utf8') as f:
        old = json.load(f)
    out = {'note': "Everon's plants: kind = row of tools/foliage/plants.csv; tile files in data/plants/",
           'dir': 'data/plants', 'margin': old['margin'], 'tiles': old['tiles'], 'kinds': kinds}
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, 'w', encoding='utf8') as f:
        json.dump(out, f, separators=(',', ':'))
    print(f'  {os.path.relpath(dst, DATA)}: {len(kinds)} kinds, {len(out["tiles"])} tiles')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('maps', nargs='*', default=list(SLUGS), help='everon, kolguyev, arland (default: all)')
    ap.add_argument('--src', default=os.path.expanduser('~/Projects/reforger-map-tools/out'))
    ap.add_argument('--build', default='24903726')
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
        if m == 'everon':
            everon_plants_json(os.path.join(out, 'foliage', 'plants.json'))
            continue
        copy_file(os.path.join(site, 'roads.json'), os.path.join(out, 'roads.json'))
        copy_tree(os.path.join(site, 'los'), os.path.join(out, 'los'))
        copy_tree(os.path.join(site, 'light'), os.path.join(out, 'light'))
        copy_tree(os.path.join(site, 'tiles'), os.path.join(out, 'tiles'))


if __name__ == '__main__':
    main()

// Full-detail line of sight, run off the page's main thread so the map never freezes.
//
// Data: data/los/X_Z.bin.gz, one per 500 m tile (see tools/bake_los.py): terrain every 1 m, and for every 0.5 m spot
// the top and underside of whatever stands there (buildings, walls, rocks, trees, bushes) and what kind it is, all
// measured by the game engine's own rays. Scored against 20,000 of the game's sight lines, this geometry agrees with
// the engine 95% of the time.
//
// Message in:  { id, xz, dir, arc, range, eyeH, targetH, reverse, elev, cell, model }
// Message out: { id, model, cells, W, H, minX, maxZ, cell, pct, treePct } (cells: 0 outside the arc, 1 hidden, 2 clear,
//              3 seen only through foliage) or { id, error }. Tile kinds: 1 building, 2 wall/rock/pole, 3 tree,
//              4 see-through fence, 5 bush.
//
// How: rays are cast across the arc and marched outward every 0.5 m. Ground, buildings, walls and rocks block from
// the ground up, so a running maximum of their slope from the eye hides anything below it. Foliage can have open
// space under it (the view under a forest canopy), so each foliage spot is a band of slopes from its underside to
// its top; a target's sight line is blocked by every band containing its slope. The bands are counted in a Fenwick
// tree over slope, so each step costs a couple of log-time updates. Up to THIN metres of foliage in the way counts
// as "through thin foliage"; more hides it.
//
// model 'visual' (being compared with the above): trees and bushes let sight through as much as they do on screen.
// Instead of the tiles' tree and bush spots it uses every plant on Everon (data/plants/X_Z.bin.gz) with its kind's
// shape and see-through measured from the game's own pictures (data/foliage.json; both made by
// tools/foliage_model.py): in each tenth of its height, a plant blocks sight at rate k per metre within half-width hw
// of its centre. The bands carry those rates instead of counts, so the tree sums the k x metres a sight line crosses,
// and e^(-sum) is the share of the target left visible: at least SEE_CLEAR counts as clear, at least SEE_MIN as seen
// through foliage, less as hidden.
'use strict';

const TILE = 500, TN = 501, SN = 1000, SC = 0.5, Q = 0.25;
const STEP = 0.5, THIN = 2, NEAR = 1;      // metres
const BINS = 8192;                          // slope resolution: angles from -90 to +90 degrees
const HIDDEN = 1, CLEAR = 2, TREES = 3, RANK = [0, 1, 3, 2];
const MAX_TILES = 90;
const SEE_CLEAR = 0.9, SEE_MIN = 0.2;

let index = null, tileSet = null, foliage = null;
const plantTiles = new Map(), plantPending = new Map(); // name -> {x, z, base, kind, scale, start, items} | null
const BUCKET = 4, NB = TILE / BUCKET;                     // plants are found through 4 m squares
const tiles = new Map();      // name -> {ter, top, bot, kind} | null (open sea); insertion order = age
const pending = new Map();    // name -> Promise

async function loadIndex() {
  if (index) return;
  const r = await fetch('data/los/index.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error(`index ${r.status}`);
  index = await r.json();
  tileSet = new Set(index.tiles);
}

async function loadFoliage() {
  if (foliage) return;
  const r = await fetch('data/foliage.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error(`foliage ${r.status}`);
  const f = await r.json();
  foliage = { bins: f.bins, margin: f.margin, tiles: new Set(f.tiles),
    // per 0.5 m step instead of per metre
    plants: f.plants.map(p => ({ h: p.h, hw: p.hw, k: p.k.map(k => k * STEP), reach: Math.max(...p.hw) })) };
}

// A tile's plants, with each 4 m square listing the plants that reach into it.
async function loadPlants(name) {
  if (plantTiles.has(name)) { const t = plantTiles.get(name); plantTiles.delete(name); plantTiles.set(name, t); return t; }
  if (plantPending.has(name)) return plantPending.get(name);
  const p = (async () => {
    let t = null;
    if (foliage.tiles.has(name)) {
      const r = await fetch(`data/plants/${name}.bin.gz?v=${index.version}`);
      if (!r.ok) throw new Error(`plants ${name}: ${r.status}`);
      const buf = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      const n = new Uint32Array(buf, 0, 1)[0], M = foliage.margin;
      const u16 = o => new Uint16Array(buf, o, n), u8 = o => new Uint8Array(buf, o, n);
      const rx = u16(4), rz = u16(4 + 2 * n), rb = u16(4 + 4 * n), kind = u8(4 + 6 * n), rs = u8(4 + 7 * n);
      const x = new Float32Array(n), z = new Float32Array(n), base = new Float32Array(n), scale = new Float32Array(n);
      const span = [];
      for (let i = 0; i < n; i++) {
        x[i] = rx[i] / 100 - M; z[i] = rz[i] / 100 - M; base[i] = rb[i] / 100; scale[i] = rs[i] / 100;
        const R = foliage.plants[kind[i]].reach * scale[i];
        span.push([Math.max(0, Math.floor((x[i] - R) / BUCKET)), Math.min(NB - 1, Math.floor((x[i] + R) / BUCKET)),
          Math.max(0, Math.floor((z[i] - R) / BUCKET)), Math.min(NB - 1, Math.floor((z[i] + R) / BUCKET))]);
      }
      const start = new Uint32Array(NB * NB + 1);
      span.forEach(([c0, c1, r0, r1]) => { for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) start[r * NB + c + 1]++; });
      for (let b = 0; b < NB * NB; b++) start[b + 1] += start[b];
      const items = new Uint32Array(start[NB * NB]), fillAt = start.slice(0, NB * NB);
      span.forEach(([c0, c1, r0, r1], i) => { for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) items[fillAt[r * NB + c]++] = i; });
      t = { x, z, base, kind, scale, start, items };
    }
    plantTiles.set(name, t);
    while (plantTiles.size > MAX_TILES) plantTiles.delete(plantTiles.keys().next().value);
    plantPending.delete(name);
    return t;
  })();
  plantPending.set(name, p);
  return p;
}

async function loadTile(name) {
  if (tiles.has(name)) { const t = tiles.get(name); tiles.delete(name); tiles.set(name, t); return t; }
  if (pending.has(name)) return pending.get(name);
  const p = (async () => {
    let t = null;
    if (tileSet.has(name)) {
      const r = await fetch(`data/los/${name}.bin.gz?v=${index.version}`);
      if (!r.ok) throw new Error(`tile ${name}: ${r.status}`);
      const buf = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      const o = TN * TN * 2;
      t = { ter: new Uint16Array(buf, 0, TN * TN), top: new Uint8Array(buf, o, SN * SN),
        bot: new Uint8Array(buf, o + SN * SN, SN * SN), kind: new Uint8Array(buf, o + 2 * SN * SN, SN * SN) };
    }
    tiles.set(name, t);
    while (tiles.size > MAX_TILES) tiles.delete(tiles.keys().next().value);
    pending.delete(name);
    return t;
  })();
  pending.set(name, p);
  return p;
}

// Everything a request needs, loaded before the maths starts.
async function loadArea(minX, minZ, maxX, maxZ, plants) {
  const jobs = [];
  for (let tz = Math.max(0, Math.floor(minZ / TILE)); tz <= Math.floor(maxZ / TILE); tz++) {
    for (let tx = Math.max(0, Math.floor(minX / TILE)); tx <= Math.floor(maxX / TILE); tx++) {
      jobs.push(loadTile(`${tx}_${tz}`));
      if (plants) jobs.push(loadPlants(`${tx}_${tz}`));
    }
  }
  await Promise.all(jobs);
}
const tileAt = (tx, tz) => tiles.get(`${tx}_${tz}`) || null;

// Ground height (m) at a point: terrain is every 1 m, joined in straight lines like the engine's.
function groundAt(x, z) {
  const tx = Math.floor(x / TILE), tz = Math.floor(z / TILE), t = tileAt(tx, tz);
  if (!t) return 0;
  const lx = Math.min(Math.max(x - tx * TILE, 0), TILE - 1e-6), lz = Math.min(Math.max(z - tz * TILE, 0), TILE - 1e-6);
  const c = Math.floor(lx), r = Math.floor(lz), fx = lx - c, fz = lz - r, T = t.ter;
  const a = T[r * TN + c], b = T[r * TN + c + 1], d = T[(r + 1) * TN + c], e = T[(r + 1) * TN + c + 1];
  return ((a + (b - a) * fx) * (1 - fz) + (d + (e - d) * fx) * fz) / 100;
}

// Fenwick tree over slope bins, for adding a band and asking how many bands (or how much k x metres) cover a bin.
const bit = new Float64Array(BINS + 2);
function bitAdd(i, v) { for (i++; i <= BINS + 1; i += i & -i) bit[i] += v; }
function bitSum(i) { let s = 0; for (i++; i > 0; i -= i & -i) s += bit[i]; return s; }
const binOf = t => Math.min(BINS - 1, Math.max(0, Math.floor((Math.atan(t) / Math.PI + 0.5) * BINS)));

function compute(req) {
  const { xz, dir, arc, range, eyeH, targetH, elev, cell } = req, visual = req.model === 'visual';
  const full = arc >= 360;
  const pts = full ? [[xz[0] - range, xz[1] - range], [xz[0] + range, xz[1] + range]] : sectorBox(xz, dir, arc, range);
  const minX = Math.floor(Math.min(...pts.map(p => p[0])) / cell) * cell, maxX = Math.max(...pts.map(p => p[0]));
  const minZ = Math.min(...pts.map(p => p[1])), maxZ = Math.ceil(Math.max(...pts.map(p => p[1])) / cell) * cell;
  const W = Math.max(1, Math.ceil((maxX - minX) / cell)), H = Math.max(1, Math.ceil((maxZ - minZ) / cell));
  const cells = new Uint8Array(W * H);
  const eye = groundAt(xz[0], xz[1]) + eyeH;
  const rays = Math.ceil(arc * Math.PI / 180 * range / (cell * 0.7)) + 1;
  const [lo, hi] = elev ? elev.map(d => Math.tan(d * Math.PI / 180)) : [-Infinity, Infinity];
  const thinCount = Math.round(THIN / STEP);
  for (let i = 0; i <= rays; i++) {
    const b = (dir - arc / 2 + arc * i / rays) * Math.PI / 180, sx = Math.sin(b), sz = Math.cos(b);
    bit.fill(0);
    let maxSolid = -Infinity, curT = null, curP = null, ctx = -1, ctz = -1;
    for (let r = STEP; r <= range; r += STEP) {
      const x = xz[0] + r * sx, z = xz[1] + r * sz;
      if (x < 0 || z < 0 || x >= 12800 || z >= 12800) break;
      const g = groundAt(x, z);
      // the target here
      const t = (g + targetH - eye) / r;
      let v;
      if (t < maxSolid || t < lo || t > hi) v = HIDDEN;
      else {
        const leaves = bitSum(binOf(t));
        if (visual) {
          const seen = Math.exp(-leaves);
          v = seen >= SEE_CLEAR ? CLEAR : seen >= SEE_MIN ? TREES : HIDDEN;
        } else v = leaves < 0.5 ? CLEAR : leaves <= thinCount + 0.5 ? TREES : HIDDEN;
      }
      const cx = Math.floor((x - minX) / cell), cz = Math.floor((maxZ - z) / cell);
      if (cx >= 0 && cx < W && cz >= 0 && cz < H) {
        const k = cz * W + cx;
        if (RANK[v] > RANK[cells[k]]) cells[k] = v;
      }
      // what stands here, for everything further out
      maxSolid = Math.max(maxSolid, (g - eye) / r);
      const tx = Math.floor(x / TILE), tz = Math.floor(z / TILE);
      if (tx !== ctx || tz !== ctz) { curT = tileAt(tx, tz); curP = visual ? plantTiles.get(`${tx}_${tz}`) || null : null; ctx = tx; ctz = tz; }
      if (curP && r > NEAR) { // every plant whose outline this spot is inside (not leaves brushing the observer's face)
        const lx = x - tx * TILE, lz = z - tz * TILE, P = curP;
        const bk = Math.min(NB - 1, Math.floor(lz / BUCKET)) * NB + Math.min(NB - 1, Math.floor(lx / BUCKET));
        for (let q = P.start[bk]; q < P.start[bk + 1]; q++) {
          const i = P.items[q], s = P.scale[i], pl = foliage.plants[P.kind[i]];
          const d = Math.hypot(lx - P.x[i], lz - P.z[i]) / s; // in the measured plant's metres
          if (d >= pl.reach) continue;
          const n = foliage.bins, h = pl.h * s, base = P.base[i] - eye;
          let prev = 0;
          for (let j = 0; j < n; j++) {
            const k = d < pl.hw[j] ? pl.k[j] / s : 0;
            if (k !== prev) bitAdd(binOf((base + h * j / n) / r), k - prev);
            prev = k;
          }
          if (prev) bitAdd(binOf((base + h) / r) + 1, -prev);
        }
      }
      if (!curT) continue;
      const c = Math.min(SN - 1, Math.floor((x - tx * TILE) / SC)), rr = Math.min(SN - 1, Math.floor((z - tz * TILE) / SC));
      const k = rr * SN + c, kind = curT.kind[k];
      if (!kind || kind === 4) continue; // nothing, or a see-through fence
      const top = curT.top[k] * Q;
      if (kind === 3 || kind === 5) { // trees and bushes: foliage
        if (r <= NEAR || visual) continue; // leaves brushing the observer's face; Visual has the plants above
        const a = binOf((g + curT.bot[k] * Q - eye) / r), z2 = binOf((g + top - eye) / r);
        bitAdd(a, 1); bitAdd(z2 + 1, -1);
      } else {
        maxSolid = Math.max(maxSolid, (g + top - eye) / r);
      }
    }
  }
  let clear = 0, trees = 0, total = 0;
  for (const v of cells) if (v) { total++; if (v === CLEAR) clear++; else if (v === TREES) trees++; }
  return { model: visual ? 'visual' : 'full', cells, W, H, minX, maxZ, cell, pct: total ? Math.round(clear / total * 100) : 100, treePct: total ? Math.round(trees / total * 100) : 0 };
}

// The bounding box of a sector (points on its arc and its tip).
function sectorBox(xz, dir, arc, range) {
  const out = [xz];
  for (let i = 0; i <= 16; i++) {
    const b = (dir - arc / 2 + arc * i / 16) * Math.PI / 180;
    out.push([xz[0] + range * Math.sin(b), xz[1] + range * Math.cos(b)]);
  }
  return out;
}

// One request at a time, newest first; stale ones are dropped by the page.
const queue = [];
let busy = false;
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const req = queue.pop();
    try {
      await loadIndex();
      if (req.model === 'visual') await loadFoliage();
      const r = req.range + 2;
      await loadArea(req.xz[0] - r, req.xz[1] - r, req.xz[0] + r, req.xz[1] + r, req.model === 'visual');
      const res = compute(req);
      postMessage({ id: req.id, ...res }, [res.cells.buffer]);
    } catch (err) {
      postMessage({ id: req.id, error: String(err && err.message || err) });
    }
  }
  busy = false;
}
onmessage = e => {
  if (e.data.cancel) { const i = queue.findIndex(q => q.id === e.data.cancel); if (i >= 0) queue.splice(i, 1); return; }
  queue.push(e.data);
  pump();
};

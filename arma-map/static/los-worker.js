// Measured line of sight (the page's 'profiles' mode), run off the page's main thread so the map never freezes.
//
// Data, per map (paths from CFG): los/X_Z.bin.gz, one per 500 m tile (baked by reforger-map-tools): terrain every 1 m,
// and for every 0.5 m spot the top and underside of whatever stands there (buildings, walls, rocks, trees, bushes) and
// what kind it is, all measured by the game engine's own rays. Scored against 20,000 of the game's sight lines, this
// geometry agrees with the engine 95% of the time. plants/X_Z.bin.gz: every tree and bush (position, ground height,
// scale, kind), and foliage/foliage_profiles.json: each kind as the game draws it.
//
// Message in:  { id, xz, dir, arc, range, eyeH, targetH, reverse, elev, cell, strength, cfg } (cfg: see CFG below)
// Message out: { id, model, cells, W, H, minX, maxZ, cell, pct, treePct } (cells: 0 outside the arc, 1 hidden, 2 clear,
//              3 seen only through foliage) or { id, error }. Tile kinds: 1 building, 2 wall/rock/pole, 3 tree,
//              4 see-through fence, 5 bush.
//
// How: rays are cast across the arc and marched outward every 0.5 m. Ground, buildings, walls and rocks block from
// the ground up, so a running maximum of their slope from the eye hides anything below it. The tiles' tree and bush
// spots are left out: the plants block instead, from the game's own pictures of every plant kind, taken from 8 sides
// at 25 to 300 m (foliage_profiles.json). Each plant a sight line passes through blocks it by the measured share of its
// outline at the height the line crosses it (`cover`, per 0.25 m slice, between the two distances that bracket the
// plant), times a strength the viewer sets. Several plants multiply: what's left visible is the product of
// (1 - strength x cover). A slice's width, which decides whether the line passes through it, comes back out of its
// cover and k (cover = 1 - e^(-k x width)). Plants are counted once per sight line, not per metre.
// Foliage can have open space under it (the view under a forest canopy), so each slice is a band of slopes from the
// eye, carrying -ln(1 - strength x cover); a target's sight line is thinned by every band containing its slope. The
// bands are summed in a Fenwick tree over slope, so each step costs a couple of log-time updates, and e^(-sum) is the
// share of the target left visible: at least SEE_CLEAR counts as clear, at least SEE_MIN as seen through foliage,
// less as hidden.
// Exact early-out: each tile keeps the highest terrain post per 5 m block. Before marching a ray, a suffix bound over
// 5 m chunks gives the highest target slope (ground + target height) possible from each chunk on. Once the solid
// horizon is strictly above that bound, every remaining target would be hidden whatever is found further out, so the
// ray only marks its untouched cells hidden and stops. Output cells are identical to marching every ray to its end.
'use strict';

const TILE = 500, TN = 501, SN = 1000, SC = 0.5, Q = 0.25;
const STEP = 0.5, NEAR = 1;                 // metres
const BINS = 8192;                          // slope resolution: angles from -90 to +90 degrees
const HIDDEN = 1, CLEAR = 2, TREES = 3, RANK = [0, 1, 3, 2];
const MAX_TILES = 90;
const MAX_QUERY_TILES = 225; // enough for 3 km circles; larger requests fail explicitly instead of losing terrain
let pinned = new Set();
const SEE_CLEAR = 0.9, SEE_MIN = 0.2;
const SLICE = 0.25, MAX_COVER = 0.98;

// Where this map's data is, from the page with every request: {size, losDir, profiles: {json, plants, dir}}.
let CFG = null, UNIT = 0.01;
let index = null, tileSet = null, profiles = null, plantSrc = null;
let plantTiles = new Map();
const plantPending = new Map();
const foliageSets = new Map(); // retain both datasets when comparing; terrain/object tiles stay shared
let foliageKey = null;
const BUCKET = 4, NB = TILE / BUCKET;                     // plants are found through 4 m squares
const tiles = new Map();      // name -> {ter, top, kind} | null (open sea); insertion order = age
const pending = new Map();    // name -> Promise

function trim(cache) {
  for (const key of cache.keys()) {
    if (cache.size <= MAX_TILES) break;
    if (!pinned.has(key)) cache.delete(key);
  }
}
const plantId = (tx, tz, p, i) => `${Math.round((tx * TILE + p.x[i]) * 100)}|${Math.round((tz * TILE + p.z[i]) * 100)}|${Math.round(p.base[i] * 100)}|${p.kind[i]}|${Math.round(p.scale[i] * 100)}`;

async function loadIndex() {
  if (index) return;
  const r = await fetch(`${CFG.losDir}/index.json`, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`index ${r.status}`);
  index = await r.json();
  tileSet = new Set(index.tiles);
  UNIT = (index.terrain && index.terrain.unit) || 0.01; // metres per step of the terrain (Kolguyev's hills need 2 cm)
}

// The measured profiles of the map's plant kinds. The plant list (the map's foliage.json) gives, in the order of the
// kind numbers stored with the plants, their prefab names, plus the tiles that have plants and the margin they are
// stored with.
async function loadProfiles() {
  if (profiles) return;
  const [rp, rl] = await Promise.all([fetch(CFG.profiles.json), fetch(CFG.profiles.plants, { cache: 'no-cache' })]);
  if (!rp.ok) throw new Error(`profiles ${rp.status}`);
  if (!rl.ok) throw new Error(`plant list ${rl.status}`);
  const raw = await rp.json(), list = await rl.json();
  // baseUnit: metres per step of the ground height
  const built = list.prefabs.map(prefab => (raw[prefab] ? buildProfile(raw[prefab]) : null));
  if (built.some(p => !p)) throw new Error('Foliage dataset is missing a plant profile.');
  profiles = built;
  plantSrc = { margin: list.margin, tiles: new Set(list.tiles), dir: CFG.profiles.dir, unit: list.baseUnit || 0.01,
    reach: profiles.map(p => (p ? p.reach : 0)) };
  foliageSets.set(foliageKey, { profiles, plantSrc, plantTiles });
}

function selectConfig(cfg) {
  if (CFG && (CFG.losDir !== cfg.losDir || CFG.size !== cfg.size)) {
    index = tileSet = null; tiles.clear(); foliageSets.clear(); foliageKey = null;
  }
  const key = JSON.stringify(cfg.profiles);
  CFG = cfg;
  if (key === foliageKey) return;
  foliageKey = key;
  const saved = foliageSets.get(key);
  profiles = saved ? saved.profiles : null;
  plantSrc = saved ? saved.plantSrc : null;
  plantTiles = saved ? saved.plantTiles : new Map();
}

// One kind's slices as arrays: for each measured distance the cover of every 0.25 m slice, and the slice's half-width.
function buildProfile(p) {
  const nS = Math.max(1, Math.ceil(p.height / SLICE) + 1);
  const raw = p.bands.map(b => {
    const cover = new Float32Array(nS).fill(NaN), width = new Float32Array(nS).fill(NaN);
    for (const s of b.slices) {
      const i = Math.round(s.y / SLICE);
      if (i < 0 || i >= nS) continue;
      cover[i] = s.cover;
      // width from cover and k, only where both are big enough to be exact
      if (s.cover > 0.03 && s.cover < 0.965 && s.k > 0.03) width[i] = -Math.log(1 - s.cover) / s.k;
    }
    return { d: b.d, near: !!b.near, cover, width };
  });
  // a slice missing from a band (tall crowns cut off at 25 m, etc.) takes the same slice from the nearest band that has it
  for (const b of raw) {
    for (let i = 0; i < nS; i++) {
      if (!Number.isNaN(b.cover[i])) continue;
      let best = null;
      for (const o of raw) if (!Number.isNaN(o.cover[i]) && (!best || Math.abs(o.d - b.d) < Math.abs(best.d - b.d))) best = o;
      b.cover[i] = best ? best.cover[i] : NaN;
    }
    let last = NaN; // still missing at the bottom or top: the neighbouring slice
    for (let i = 0; i < nS; i++) { if (Number.isNaN(b.cover[i])) b.cover[i] = last; else last = b.cover[i]; }
    last = 0;
    for (let i = nS - 1; i >= 0; i--) { if (Number.isNaN(b.cover[i])) b.cover[i] = last; else last = b.cover[i]; }
  }
  // the plant's width per slice: the widest exact reading in any band, holes filled from the nearest slice, at least a trunk
  const hw = new Float32Array(nS).fill(NaN);
  for (let i = 0; i < nS; i++) for (const b of raw) if (!Number.isNaN(b.width[i]) && !(hw[i] >= b.width[i] / 2)) hw[i] = b.width[i] / 2;
  const crown = (p.top && p.top.width_m ? p.top.width_m : 2) / 2;
  let anyWidth = false;
  for (let i = 0; i < nS; i++) if (!Number.isNaN(hw[i])) anyWidth = true;
  const has = j => j >= 0 && j < nS && !Number.isNaN(hw[j]);
  const known = hw.slice();
  for (let i = 0; i < nS; i++) {
    if (!Number.isNaN(known[i])) continue;
    let d = 1;
    for (; d < nS; d++) if ((i - d >= 0 && !Number.isNaN(known[i - d])) || (i + d < nS && !Number.isNaN(known[i + d]))) break;
    hw[i] = anyWidth && d < nS ? (i - d >= 0 && !Number.isNaN(known[i - d]) ? known[i - d] : known[i + d]) : crown;
  }
  const half = new Float32Array(nS);
  for (let i = 0; i < nS; i++) half[i] = Math.min(30, Math.max(0.15, hw[i]));
  // measured distances the plant's view is taken between: the close-up for anything nearer, the rest as measured
  const near = raw.find(b => b.near) || raw[0];
  const bands = [near, ...raw.filter(b => !b.near && b.d > near.d)].sort((a, b) => a.d - b.d);
  return { h: p.height, nS, half, bands, reach: Math.max(...half) };
}

// A tile's plants, with each 4 m square listing the plants that reach into it.
async function loadPlants(name) {
  const key = name, src = plantSrc;
  if (plantTiles.has(key)) { const t = plantTiles.get(key); plantTiles.delete(key); plantTiles.set(key, t); return t; }
  if (plantPending.has(key)) return plantPending.get(key);
  const p = (async () => {
    let t = null;
    if (src.tiles.has(name)) {
      const r = await fetch(`${src.dir}/${name}.bin.gz?v=${index.version}`);
      if (!r.ok) throw new Error(`plants ${name}: ${r.status}`);
      const buf = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      const n = new Uint32Array(buf, 0, 1)[0], M = src.margin;
      const u16 = o => new Uint16Array(buf, o, n), u8 = o => new Uint8Array(buf, o, n);
      const rx = u16(4), rz = u16(4 + 2 * n), rb = u16(4 + 4 * n), kind = u8(4 + 6 * n), rs = u8(4 + 7 * n);
      const x = new Float32Array(n), z = new Float32Array(n), base = new Float32Array(n), scale = new Float32Array(n);
      const span = [];
      for (let i = 0; i < n; i++) {
        x[i] = rx[i] / 100 - M; z[i] = rz[i] / 100 - M; base[i] = rb[i] * src.unit; scale[i] = rs[i] / 100;
        const R = src.reach[kind[i]] * scale[i];
        span.push([Math.max(0, Math.floor((x[i] - R) / BUCKET)), Math.min(NB - 1, Math.floor((x[i] + R) / BUCKET)),
          Math.max(0, Math.floor((z[i] - R) / BUCKET)), Math.min(NB - 1, Math.floor((z[i] + R) / BUCKET))]);
      }
      const start = new Uint32Array(NB * NB + 1);
      span.forEach(([c0, c1, r0, r1]) => { for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) start[r * NB + c + 1]++; });
      for (let b = 0; b < NB * NB; b++) start[b + 1] += start[b];
      const items = new Uint32Array(start[NB * NB]), fillAt = start.slice(0, NB * NB);
      span.forEach(([c0, c1, r0, r1], i) => { for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) items[fillAt[r * NB + c]++] = i; });
      // Boundary copies share an identity. Precompute it once instead of building strings at every ray step.
      const [tx, tz] = name.split('_').map(Number);
      t = { x, z, base, kind, scale, start, items };
      t.ids = Array.from({ length: n }, (_, i) => plantId(tx, tz, t, i));
    }
    plantTiles.set(key, t);
    trim(plantTiles);
    return t;
  })();
  plantPending.set(key, p);
  try { return await p; } finally { plantPending.delete(key); }
}

async function loadTile(name) {
  if (tiles.has(name)) { const t = tiles.get(name); tiles.delete(name); tiles.set(name, t); return t; }
  if (pending.has(name)) return pending.get(name);
  const p = (async () => {
    let t = null;
    if (tileSet.has(name)) {
      const r = await fetch(`${CFG.losDir}/${name}.bin.gz?v=${index.version}`);
      if (!r.ok) throw new Error(`tile ${name}: ${r.status}`);
      const buf = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      const o = TN * TN * 2;
      t = { ter: new Uint16Array(buf, 0, TN * TN), top: new Uint8Array(buf, o, SN * SN),
        kind: new Uint8Array(buf, o + 2 * SN * SN, SN * SN) }; // (the underside plane between them isn't needed)
      heightBlocks(t);
    }
    tiles.set(name, t);
    trim(tiles);
    return t;
  })();
  pending.set(name, p);
  try { return await p; } finally { pending.delete(name); }
}

// Everything a request needs, loaded before the maths starts.
async function loadArea(minX, minZ, maxX, maxZ) {
  const names = [], last = Math.ceil(CFG.size / TILE) - 1;
  for (let tz = Math.max(0, Math.floor(minZ / TILE)); tz <= Math.min(last, Math.floor(maxZ / TILE)); tz++) {
    for (let tx = Math.max(0, Math.floor(minX / TILE)); tx <= Math.min(last, Math.floor(maxX / TILE)); tx++) {
      names.push(`${tx}_${tz}`);
    }
  }
  if (names.length > MAX_QUERY_TILES) throw new Error('Measured query exceeds the tile budget; use Light for this range.');
  pinned = new Set(names);
  trim(tiles); trim(plantTiles);
  // Drain all loads before releasing pins, even when one fails.
  let next = 0, failure = null;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < names.length) {
      const name = names[next++];
      const results = await Promise.allSettled([loadTile(name), loadPlants(name)]);
      for (const result of results) if (result.status === 'rejected') failure ||= result.reason;
    }
  }));
  if (failure) throw failure;
}
const tileAt = (tx, tz) => tiles.get(`${tx}_${tz}`) || null;

// The highest terrain post in each HB x HB metre block of a tile. Bilinear ground inside a block never exceeds the
// posts at its corners and edges, so this bounds every groundAt there (a block's posts run to its far edge, inclusive).
const HB = 5, HN = TILE / HB, CHUNK = 10; // CHUNK: ray samples per horizon bound
function heightBlocks(t) {
  if (t.hmax) return t.hmax;
  const T = t.ter, rows = new Uint16Array(TN * HN), out = new Uint16Array(HN * HN);
  for (let r = 0; r < TN; r++) {
    for (let bc = 0; bc < HN; bc++) {
      let m = 0;
      for (let c = bc * HB; c <= bc * HB + HB; c++) if (T[r * TN + c] > m) m = T[r * TN + c];
      rows[r * HN + bc] = m;
    }
  }
  for (let br = 0; br < HN; br++) {
    for (let bc = 0; bc < HN; bc++) {
      let m = 0;
      for (let r = br * HB; r <= br * HB + HB; r++) if (rows[r * HN + bc] > m) m = rows[r * HN + bc];
      out[br * HN + bc] = m;
    }
  }
  return (t.hmax = out);
}
// The highest ground (m) of every global HB-block in [bx0..bx1] x [bz0..bz1], row by row: 0 for open sea and outside
// the map (as groundAt), Infinity where a tile should exist but is not loaded, so the march still reaches it and fails
// as before.
function heightGrid(bx0, bz0, bx1, bz1) {
  const w = bx1 - bx0 + 1, h = bz1 - bz0 + 1, v = new Float64Array(w * h);
  for (let tz = Math.floor(bz0 / HN); tz <= Math.floor(bz1 / HN); tz++) {
    for (let tx = Math.floor(bx0 / HN); tx <= Math.floor(bx1 / HN); tx++) {
      const t = tileAt(tx, tz), missing = !t && tileSet.has(`${tx}_${tz}`);
      if (!t && !missing) continue;
      const B = t && heightBlocks(t), ox = tx * HN, oz = tz * HN;
      for (let z = Math.max(bz0, oz); z <= Math.min(bz1, oz + HN - 1); z++) {
        for (let x = Math.max(bx0, ox); x <= Math.min(bx1, ox + HN - 1); x++) {
          v[(z - bz0) * w + x - bx0] = missing ? Infinity : B[(z - oz) * HN + x - ox] * UNIT;
        }
      }
    }
  }
  return { bx0, bz0, bx1, bz1, w, v };
}

// Ground height (m) at a point: terrain is every 1 m, joined in straight lines like the engine's.
function groundAt(x, z, loaded, tx = Math.floor(x / TILE), tz = Math.floor(z / TILE)) {
  const t = loaded === undefined ? tileAt(tx, tz) : loaded;
  if (!t) {
    if (tileSet.has(`${tx}_${tz}`)) throw new Error('Required terrain tile is not loaded.');
    return 0;
  }
  const lx = Math.min(Math.max(x - tx * TILE, 0), TILE - 1e-6), lz = Math.min(Math.max(z - tz * TILE, 0), TILE - 1e-6);
  const c = Math.floor(lx), r = Math.floor(lz), fx = lx - c, fz = lz - r, T = t.ter;
  const a = T[r * TN + c], b = T[r * TN + c + 1], d = T[(r + 1) * TN + c], e = T[(r + 1) * TN + c + 1];
  return ((a + (b - a) * fx) * (1 - fz) + (d + (e - d) * fx) * fz) * UNIT;
}

const seenPlants = new Set(); // the plants already added for the sight line being marched

// One plant on a sight line: for each 0.25 m slice the line passes through (within the slice's half-width of the plant's
// centre, `perp` metres off), the plant blocks by its measured cover at this distance. Adds -ln(1 - strength x cover) to
// the slope band that slice covers, so the sum over bands is -ln of the share left visible. base: the plant's ground
// height above the eye; r: distance along the line to the plant.
function addProfile(pf, s, base, r, perp, strength) {
  const B = pf.bands, last = B[B.length - 1];
  let a = B[0], b = B[0], f = 0;
  if (r >= last.d) a = b = last;
  else if (r > B[0].d) {
    let j = 1;
    while (B[j].d < r) j++;
    a = B[j - 1]; b = B[j]; f = (r - a.d) / (b.d - a.d);
  }
  let prev = 0;
  for (let j = 0; j < pf.nS; j++) {
    let tau = 0;
    if (perp < pf.half[j] * s) {
      const c = Math.min(MAX_COVER, strength * (a.cover[j] + (b.cover[j] - a.cover[j]) * f));
      if (c > 0.005) tau = -Math.log(1 - c);
    }
    tau = Math.round(tau * 40) / 40; // in steps, so runs of similar slices are one band
    if (tau !== prev) bitAdd(binOf((base + j * SLICE * s) / r), tau - prev);
    prev = tau;
  }
  if (prev) bitAdd(binOf((base + pf.nS * SLICE * s) / r) + 1, -prev);
}

// Fenwick tree over slope bins, for adding a band and asking how many bands (or how much k x metres) cover a bin.
const bit = new Float64Array(BINS + 2);
function bitAdd(i, v) { for (i++; i <= BINS + 1; i += i & -i) bit[i] += v; }
function bitSum(i) { let s = 0; for (i++; i > 0; i -= i & -i) s += bit[i]; return s; }
const binOf = t => Math.min(BINS - 1, Math.max(0, Math.floor((Math.atan(t) / Math.PI + 0.5) * BINS)));

function compute(req) {
  const { xz, dir, arc, range, eyeH, targetH, elev, cell } = req;
  const strength = Number.isFinite(req.strength) ? req.strength : 1, WORLD_M = CFG.size;
  const full = arc >= 360;
  const pts = full ? [[xz[0] - range, xz[1] - range], [xz[0] + range, xz[1] + range]] : sectorBox(xz, dir, arc, range);
  const minX = Math.floor(Math.min(...pts.map(p => p[0])) / cell) * cell, maxX = Math.max(...pts.map(p => p[0]));
  const minZ = Math.min(...pts.map(p => p[1])), maxZ = Math.ceil(Math.max(...pts.map(p => p[1])) / cell) * cell;
  const W = Math.max(1, Math.ceil((maxX - minX) / cell)), H = Math.max(1, Math.ceil((maxZ - minZ) / cell));
  const cells = new Uint8Array(W * H);
  const eye = groundAt(xz[0], xz[1]) + eyeH;
  const rays = Math.ceil(arc * Math.PI / 180 * range / (cell * 0.7)) + 1;
  const [lo, hi] = elev ? elev.map(d => Math.tan(d * Math.PI / 180)) : [-Infinity, Infinity];
  // the 0.5 m samples a ray can take, in chunks of CHUNK for the solid-horizon early-out; heights of the area's blocks
  const samples = Math.floor(range / STEP), chunks = Math.ceil(samples / CHUNK), ahead = new Float64Array(chunks + 1);
  const hg = heightGrid(Math.floor((minX - HB) / HB), Math.floor((minZ - HB) / HB), Math.floor((maxX + HB) / HB),
    Math.floor((maxZ + HB) / HB));
  for (let i = 0; i <= rays; i++) {
    const b = (dir - arc / 2 + arc * i / rays) * Math.PI / 180, sx = Math.sin(b), sz = Math.cos(b);
    bit.fill(0);
    seenPlants.clear();
    rayHorizon(ahead, chunks, samples, hg, xz, sx, sz, targetH - eye);
    let maxSolid = -Infinity, curT = null, curP = null, ctx = -1, ctz = -1, plantBucket = -1, hiddenFrom = 0;
    let chunk = 0, checkAt = STEP;
    for (let r = STEP; r <= range; r += STEP) {
      // Every target left is strictly below the solid horizon (a target exactly on it is not hidden): nothing on the
      // rest of this ray can change a cell, and plants found from here on would only thin those hidden targets.
      if (r >= checkAt) { // first sample of a chunk
        if (ahead[chunk++] < maxSolid) { hiddenFrom = r; break; }
        checkAt += CHUNK * STEP;
      }
      const x = xz[0] + r * sx, z = xz[1] + r * sz;
      if (x < 0 || z < 0 || x >= WORLD_M || z >= WORLD_M) break;
      const tx = Math.floor(x / TILE), tz = Math.floor(z / TILE);
      if (tx !== ctx || tz !== ctz) {
        curT = tileAt(tx, tz);
        curP = plantTiles.get(`${tx}_${tz}`) || null;
        plantBucket = -1;
        ctx = tx; ctz = tz;
      }
      const g = groundAt(x, z, curT, tx, tz);
      // the target here
      const cx = Math.floor((x - minX) / cell), cz = Math.floor((maxZ - z) / cell);
      if (cx >= 0 && cx < W && cz >= 0 && cz < H) {
        const k = cz * W + cx;
        // CLEAR is the highest-ranked result: another target sample cannot improve this output cell.
        // Keep marching its terrain and plants below, since they still affect targets farther out.
        if (cells[k] !== CLEAR) {
          const t = (g + targetH - eye) / r;
          let v;
          if (t < maxSolid || t < lo || t > hi) v = HIDDEN;
          else {
            const seen = Math.exp(-bitSum(binOf(t)));
            v = seen >= SEE_CLEAR ? CLEAR : seen >= SEE_MIN ? TREES : HIDDEN;
          }
          if (RANK[v] > RANK[cells[k]]) cells[k] = v;
        }
      }
      // what stands here, for everything further out
      maxSolid = Math.max(maxSolid, (g - eye) / r);
      if (curP && r > NEAR) { // each plant near this spot, once per sight line
        const lx = x - tx * TILE, lz = z - tz * TILE, P = curP;
        const bk = Math.min(NB - 1, Math.floor(lz / BUCKET)) * NB + Math.min(NB - 1, Math.floor(lx / BUCKET));
        // A straight ray encounters the same candidates throughout this bucket. Process them at its first
        // eligible step, preserving the original ordering; all later steps would only hit seenPlants.
        if (bk !== plantBucket) {
          plantBucket = bk;
          for (let q = P.start[bk]; q < P.start[bk + 1]; q++) {
            const i = P.items[q], gid = P.ids ? P.ids[i] : plantId(tx, tz, P, i);
            if (seenPlants.has(gid)) continue;
            seenPlants.add(gid);
            const pf = profiles[P.kind[i]];
            if (!pf) continue;
            const s = P.scale[i], dx = tx * TILE + P.x[i] - xz[0], dz = tz * TILE + P.z[i] - xz[1];
            const along = dx * sx + dz * sz, perp = Math.abs(dx * sz - dz * sx); // metres out along the line, and off to the side
            if (along < NEAR || perp >= pf.reach * s) continue;
            addProfile(pf, s, P.base[i] - eye, along, perp, strength);
          }
        }
      }
      if (!curT) continue;
      const c = Math.min(SN - 1, Math.floor((x - tx * TILE) / SC)), rr = Math.min(SN - 1, Math.floor((z - tz * TILE) / SC));
      const k = rr * SN + c, kind = curT.kind[k];
      // nothing, a see-through fence, or a tree or bush (the plants above stand in for those)
      if (!kind || kind === 4 || kind === 3 || kind === 5) continue;
      maxSolid = Math.max(maxSolid, (g + curT.top[k] * Q - eye) / r);
    }
    // The skipped samples would still have marked untouched cells hidden; do just that for the rest of the ray.
    if (hiddenFrom) markHidden(cells, W, H, minX, maxZ, cell, xz, sx, sz, hiddenFrom, range, WORLD_M);
  }
  let clear = 0, trees = 0, total = 0;
  for (const v of cells) if (v) { total++; if (v === CLEAR) clear++; else if (v === TREES) trees++; }
  return { model: req.model || 'profiles', cells, W, H, minX, maxZ, cell, pct: total ? Math.round(clear / total * 100) : 100, treePct: total ? Math.round(trees / total * 100) : 0 };
}

// ahead[c]: no target from chunk c of CHUNK samples onwards can have a higher slope than this. Each chunk takes the
// highest ground in the blocks around its samples, over its nearest (or, below the eye, farthest) distance.
function rayHorizon(ahead, chunks, samples, hg, xz, sx, sz, lift) {
  ahead[chunks] = -Infinity;
  for (let c = chunks - 1; c >= 0; c--) {
    const ra = (c * CHUNK + 1) * STEP, rb = Math.min((c + 1) * CHUNK, samples) * STEP;
    const xa = xz[0] + ra * sx, xb = xz[0] + rb * sx, za = xz[1] + ra * sz, zb = xz[1] + rb * sz;
    const bx0 = Math.floor((Math.min(xa, xb) - 1e-6) / HB), bz0 = Math.floor((Math.min(za, zb) - 1e-6) / HB);
    const bx1 = Math.floor((Math.max(xa, xb) + 1e-6) / HB), bz1 = Math.floor((Math.max(za, zb) + 1e-6) / HB);
    let top = Infinity; // (outside the grid: no bound)
    if (bx0 >= hg.bx0 && bz0 >= hg.bz0 && bx1 <= hg.bx1 && bz1 <= hg.bz1) {
      top = 0;
      for (let bz = bz0; bz <= bz1; bz++) for (let bx = bx0; bx <= bx1; bx++) top = Math.max(top, hg.v[(bz - hg.bz0) * hg.w + bx - hg.bx0]);
    }
    top += 1e-4 + lift;
    ahead[c] = Math.max(ahead[c + 1], top / (top >= 0 ? ra : rb));
  }
}

function markHidden(cells, W, H, minX, maxZ, cell, xz, sx, sz, from, range, WORLD_M) {
  for (let r = from; r <= range; r += STEP) {
    const x = xz[0] + r * sx, z = xz[1] + r * sz;
    if (x < 0 || z < 0 || x >= WORLD_M || z >= WORLD_M) break;
    const cx = Math.floor((x - minX) / cell), cz = Math.floor((maxZ - z) / cell);
    if (cx >= 0 && cx < W && cz >= 0 && cz < H && !cells[cz * W + cx]) cells[cz * W + cx] = HIDDEN;
  }
}

// The bounding box of a sector (points on its arc and its tip).
function sectorBox(xz, dir, arc, range) {
  const out = [xz];
  for (const bearing of [0, 90, 180, 270]) {
    if (arc >= 360 || Math.abs(((bearing - dir + 540) % 360) - 180) <= arc / 2) {
      const b = bearing * Math.PI / 180;
      out.push([xz[0] + range * Math.sin(b), xz[1] + range * Math.cos(b)]);
    }
  }
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
      selectConfig(req.cfg);
      await loadIndex();
      await loadProfiles();
      const points = sectorBox(req.xz, req.dir, req.arc, req.range);
      await loadArea(Math.min(...points.map(p => p[0])) - 2, Math.min(...points.map(p => p[1])) - 2,
        Math.max(...points.map(p => p[0])) + 2, Math.max(...points.map(p => p[1])) + 2);
      const res = compute(req);
      postMessage({ id: req.id, ...res }, [res.cells.buffer]);
    } catch (err) {
      postMessage({ id: req.id, error: String(err && err.message || err) });
    } finally {
      pinned.clear(); trim(tiles); trim(plantTiles);
    }
  }
  busy = false;
}
onmessage = e => {
  if (e.data.cancel) { const i = queue.findIndex(q => q.id === e.data.cancel); if (i >= 0) queue.splice(i, 1); return; }
  queue.push(e.data);
  pump();
};

// Builds the meshes off the page's main thread.
//
// Data: the field map's line-of-sight tiles, /data/maps/<map>/los/X_Z.bin.gz, one per 500 m tile: terrain every 1 m,
// and for every 0.5 m spot the top and underside of whatever stands there and what kind it is.
//
// Message in:  { type: 'jobs', jobs: [{ key, gen, name, t, o, smooth, wantTer }] }  (replaces the queue, nearest first)
//              { type: 'config', maxTiles }   (a job's smooth: false leaves trees as the raw 0.5 m boxes)
// Message out: { type: 'mesh', key, gen, name, t, o, sea, tv, ti, tCount, inst, iCount, tinst, trCount, rv, ri, rCount, ter, ymin, ymax }
//              { type: 'error', key, gen, name, error }
//
// Terrain: a grid every t metres (1, 2, 5 or 10) with a skirt hanging from its edges so neighbouring tiles at other
// detail levels never show a crack. Vertex, 16 bytes: Uint16 x (cm), y (2 cm), z (cm), pad; Int8 normal x3, pad;
// Uint8 colour x3, pad.
// Objects: one box per o-metre cell (0.5, 1, 2 or 4) from its underside to its top. Instance, 12 bytes: Uint16 x, z
// (in 0.5 m from the tile's corner), bottom, top (2 cm); Uint8 kind, trunk flag, the building's eave height above the
// ground (0.25 m), per-cell colour variation.
// Trees: where a tile has trees/X_Z.bin.gz (see reforger-map-tools' rmtlib/trees.py) and objects are drawn every 2 m or finer,
// its trees and bushes are drawn as shaped crowns instead of boxes. Instance, 12 bytes: Uint16 x, y, z (cm, 2 cm, cm
// from the tile's corner, sea level); Uint8 species, yaw, height (0.25 m), crown radius (0.1 m), variation, pad.
'use strict';

const TILE = 500, TN = 501, SN = 1000, Q = 0.25;
let index = null, tileSet = null, maxTiles = 12;
let DIR = '/data/maps/everon/', UNIT = 0.01;   // the map's data folder, and metres per terrain step (set from the page / index.json)
const tiles = new Map(), pending = new Map();
let queue = [], busy = false, current = null;
const done = new Map();   // key -> when it was finished: a job just sent back isn't redone while the page catches up
const treeMask = new Uint8Array(SN * SN);

async function loadIndex() {
  if (index) return;
  const r = await fetch(`${DIR}los/index.json`, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`index ${r.status}`);
  index = await r.json();
  tileSet = new Set(index.tiles);
  UNIT = index.terrain.unit;
}

let treeTiles = null, treeVersion = '';
async function loadTrees(name, t) {
  if (!t || t.trees !== undefined) return;
  if (!treeTiles) {
    try {
      const r = await fetch(`${DIR}trees/species.json`, { cache: 'no-cache' });
      const j = r.ok ? await r.json() : {};
      treeTiles = new Set(j.format === 2 ? j.tiles : []);    // 2: see TREE_FORMAT in main.js
      treeVersion = j.version || '';
    } catch { treeTiles = new Set(); }
  }
  if (!treeTiles.has(name)) { t.trees = null; return; }
  const r = await fetch(`${DIR}trees/${name}.bin.gz?v=${treeVersion}`);
  if (!r.ok) throw new Error(`trees ${name}: ${r.status}`);
  t.trees = new Uint8Array(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

async function loadTile(name) {
  if (tiles.has(name)) { const t = tiles.get(name); tiles.delete(name); tiles.set(name, t); return t; }
  if (pending.has(name)) return pending.get(name);
  const p = (async () => {
    let t = null;
    if (tileSet.has(name)) {
      const r = await fetch(`${DIR}los/${name}.bin.gz?v=${index.version}`);
      if (!r.ok) throw new Error(`tile ${name}: ${r.status}`);
      const buf = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      const o = TN * TN * 2;
      t = { ter: new Uint16Array(buf, 0, TN * TN), top: new Uint8Array(buf, o, SN * SN),
        bot: new Uint8Array(buf, o + SN * SN, SN * SN), kind: new Uint8Array(buf, o + 2 * SN * SN, SN * SN) };
    }
    tiles.set(name, t);
    while (tiles.size > maxTiles) tiles.delete(tiles.keys().next().value);
    pending.delete(name);
    return t;
  })();
  pending.set(name, p);
  p.catch(() => pending.delete(name));
  return p;
}

// Soft patchiness for the ground, the same function as the page's far terrain so the two match.
function hash(x, z) {
  let h = (Math.imul(x, 374761393) + Math.imul(z, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash(xi, zi), b = hash(xi + 1, zi), c = hash(xi, zi + 1), d = hash(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function groundColour(x, z, h, ny, out) {
  const n = 0.9 + 0.14 * vnoise(x / 70, z / 70) + 0.06 * vnoise(x / 13, z / 13);
  let r = 95, g = 118, b = 70;
  const rock = Math.min(1, Math.max(0, (0.82 - ny) / 0.22));
  r += (128 - r) * rock; g += (120 - g) * rock; b += (102 - b) * rock;
  const sand = Math.min(1, Math.max(0, (1.6 - h) / 1.2));
  r += (176 - r) * sand; g += (165 - g) * sand; b += (122 - b) * sand;
  out[0] = Math.min(255, r * n); out[1] = Math.min(255, g * n); out[2] = Math.min(255, b * n);
}

function buildTerrain(t, s, x0, z0) {
  const T = t.ter, n = TILE / s + 1, SKIRT = 8;
  const H = (c, r) => T[Math.min(r, 500) * TN + Math.min(c, 500)] * UNIT;
  const nv = n * n + 4 * n;
  const buf = new ArrayBuffer(nv * 16), u16 = new Uint16Array(buf), i8 = new Int8Array(buf), u8 = new Uint8Array(buf);
  const col = [0, 0, 0];
  let v = 0, ymin = Infinity, ymax = -Infinity;
  const put = (c, r, drop) => {
    const h = H(c, r);
    const cl = Math.max(c - s, 0), cr = Math.min(c + s, 500), rd = Math.max(r - s, 0), ru = Math.min(r + s, 500);
    let nx = -(H(cr, r) - H(cl, r)) / (cr - cl), nz = -(H(c, ru) - H(c, rd)) / (ru - rd), ny = 1;
    const L = Math.hypot(nx, ny, nz); nx /= L; ny /= L; nz /= L;
    const o = v * 16, y = Math.max(0, h - drop);
    u16[o / 2] = c * 100; u16[o / 2 + 1] = Math.round(y * 50); u16[o / 2 + 2] = r * 100;
    i8[o + 8] = Math.round(nx * 127); i8[o + 9] = Math.round(ny * 127); i8[o + 10] = Math.round(nz * 127);
    groundColour(x0 + c, z0 + r, h, ny, col);
    u8[o + 12] = col[0]; u8[o + 13] = col[1]; u8[o + 14] = col[2]; u8[o + 15] = 255;
    if (y < ymin) ymin = y;
    if (h > ymax) ymax = h;
    return v++;
  };
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) put(c * s, r * s, 0);
  const quads = (n - 1) * (n - 1) + 4 * (n - 1);
  const idx = new Uint32Array(quads * 6);
  let k = 0;
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const i = r * n + c;
      idx[k++] = i; idx[k++] = i + 1; idx[k++] = i + n;
      idx[k++] = i + 1; idx[k++] = i + n + 1; idx[k++] = i + n;
    }
  }
  const edges = [
    j => [j, 0], j => [j, n - 1], j => [0, j], j => [n - 1, j],
  ];
  for (const e of edges) {
    const first = v;
    for (let j = 0; j < n; j++) { const [c, r] = e(j); put(c * s, r * s, SKIRT); }
    for (let j = 0; j < n - 1; j++) {
      const [c0, r0] = e(j), [c1, r1] = e(j + 1), a = r0 * n + c0, b = r1 * n + c1;
      idx[k++] = a; idx[k++] = b; idx[k++] = first + j;
      idx[k++] = b; idx[k++] = first + j + 1; idx[k++] = first + j;
    }
  }
  return { tv: buf, ti: idx, tCount: k, ymin, ymax };
}

// Each building's eave: where its walls end and its roof starts, taken as a low percentile of the tops across the
// whole building (connected building spots). 0.25 m units per 0.5 m spot; 0 where there's no building.
function eaves(t) {
  if (t.eave) return t.eave;
  const kind = t.kind, top = t.top, label = new Int32Array(SN * SN).fill(-1), eave = new Uint8Array(SN * SN);
  const stack = new Int32Array(SN * SN), members = new Int32Array(SN * SN), hist = new Uint32Array(256);
  let comp = 0;
  for (let s = 0; s < SN * SN; s++) {
    if (kind[s] !== 1 || label[s] >= 0) continue;
    let sp = 0, n = 0;
    stack[sp++] = s; label[s] = comp; hist.fill(0);
    while (sp) {
      const i = stack[--sp];
      members[n++] = i; hist[top[i]]++;
      const r = (i / SN) | 0, c = i - r * SN;
      if (c > 0 && kind[i - 1] === 1 && label[i - 1] < 0) { label[i - 1] = comp; stack[sp++] = i - 1; }
      if (c < SN - 1 && kind[i + 1] === 1 && label[i + 1] < 0) { label[i + 1] = comp; stack[sp++] = i + 1; }
      if (r > 0 && kind[i - SN] === 1 && label[i - SN] < 0) { label[i - SN] = comp; stack[sp++] = i - SN; }
      if (r < SN - 1 && kind[i + SN] === 1 && label[i + SN] < 0) { label[i + SN] = comp; stack[sp++] = i + SN; }
    }
    // skip the low bits round the edge (steps, porches): 20th percentile of the spots over 2 m
    let tall = 0;
    for (let v = 8; v < 256; v++) tall += hist[v];
    let e = 0;
    if (tall) {
      let acc = 0;
      for (let v = 8; v < 256; v++) { acc += hist[v]; if (acc >= tall * 0.2) { e = v; break; } }
    }
    for (let k = 0; k < n; k++) eave[members[k]] = e;
    comp++;
  }
  t.eave = eave;
  return eave;
}

// The trees as instances, and which 0.5 m spots they cover (so the boxes there can be left out).
function buildTrees(t, mask) {
  const rec = t.trees, n = rec.length >> 3, T = t.ter, dv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  const out = new ArrayBuffer(n * 12), o16 = new Uint16Array(out), o8 = new Uint8Array(out);
  mask.fill(0);
  let k = 0, ymax = -Infinity;
  for (let i = 0; i < n; i++) {
    const cx = dv.getUint16(i * 8, true), cz = dv.getUint16(i * 8 + 2, true), x = cx / 100, z = cz / 100;
    const c = Math.min(Math.floor(x), 499), r = Math.min(Math.floor(z), 499), fx = x - c, fz = z - r;
    const a = T[r * TN + c], b = T[r * TN + c + 1], d = T[(r + 1) * TN + c], e = T[(r + 1) * TN + c + 1];
    const g = ((a + (b - a) * fx) * (1 - fz) + (d + (e - d) * fx) * fz) * UNIT;
    if (g < 0.1) continue;                                 // in the water
    const sp = rec[i * 8 + 4], yaw = rec[i * 8 + 5], h = rec[i * 8 + 6], rad = rec[i * 8 + 7] * 0.1;
    const o = k * 12;
    o16[o / 2] = cx; o16[o / 2 + 1] = Math.round(g * 50); o16[o / 2 + 2] = cz;
    o8[o + 6] = sp; o8[o + 7] = yaw; o8[o + 8] = h; o8[o + 9] = rec[i * 8 + 7];
    o8[o + 10] = hash(cx + 31, cz + 17) * 255; o8[o + 11] = 0;
    if (g + h * 0.25 > ymax) ymax = g + h * 0.25;
    // the spots under the crown: the boxes there are the tree itself
    const R = (rad * 1.15 + 0.5) * 2, mx = x * 2, mz = z * 2;
    for (let j = Math.max(0, Math.floor(mz - R)); j <= Math.min(SN - 1, Math.ceil(mz + R)); j++) {
      for (let q = Math.max(0, Math.floor(mx - R)); q <= Math.min(SN - 1, Math.ceil(mx + R)); q++) {
        if ((q + 0.5 - mx) ** 2 + (j + 0.5 - mz) ** 2 <= R * R) mask[j * SN + q] = 1;
      }
    }
    k++;
  }
  return { tinst: out.slice(0, k * 12), trCount: k, ymaxTrees: ymax };
}

function buildObjects(t, cell, tmask) {
  const f = Math.round(cell / 0.5), nb = SN / f, need = f <= 2 ? 1 : (f * f) / 4;
  const T = t.ter, top = t.top, bot = t.bot, kind = t.kind, eave = eaves(t);
  const out = new ArrayBuffer(nb * nb * 12), u16 = new Uint16Array(out), u8 = new Uint8Array(out);
  const ground = (x, z) => {
    const c = Math.min(Math.floor(x), 499), r = Math.min(Math.floor(z), 499), fx = x - c, fz = z - r;
    const a = T[r * TN + c], b = T[r * TN + c + 1], d = T[(r + 1) * TN + c], e = T[(r + 1) * TN + c + 1];
    return ((a + (b - a) * fx) * (1 - fz) + (d + (e - d) * fx) * fz) * UNIT;
  };
  let n = 0, ymax = -Infinity;
  for (let bj = 0; bj < nb; bj++) {
    for (let bi = 0; bi < nb; bi++) {
      let cnt = 0, maxTop = 0, kTop = 0, minBot = 255, trunk = 0, eaveQ = 0;
      for (let sj = 0; sj < f; sj++) {
        const row = (bj * f + sj) * SN + bi * f;
        for (let si = 0; si < f; si++) {
          const k = kind[row + si];
          if (!k || k === 4) continue; // nothing, or a see-through fence
          if (tmask && tmask[row + si] && (k === 3 || k === 5)) continue; // drawn as a tree instead
          cnt++;
          const tp = top[row + si];
          if (tp > maxTop) { maxTop = tp; kTop = k; }
          if (k === 1 && eave[row + si] > eaveQ) eaveQ = eave[row + si];
          if (k === 1 || k === 2) minBot = 0;
          else {
            const b = bot[row + si];
            if (b < minBot) minBot = b;
            if (k === 3 && b * Q < 1) trunk = 1;
          }
        }
      }
      if (cnt < need || maxTop * Q < 0.25) continue;
      const lx = (bi * f + f / 2) * 0.5, lz = (bj * f + f / 2) * 0.5, g = ground(lx, lz);
      const e = f * 0.5, gl = Math.min(ground(lx - e / 2, lz - e / 2), ground(Math.min(lx + e / 2, 500), lz - e / 2),
        ground(lx - e / 2, Math.min(lz + e / 2, 500)), ground(Math.min(lx + e / 2, 500), Math.min(lz + e / 2, 500)));
      const yT = g + maxTop * Q;
      const solid = kTop === 1 || kTop === 2 || minBot * Q < 0.3;
      const yB = solid ? gl - 0.3 : g + minBot * Q;
      const o = n * 6;
      u16[o] = bi * f; u16[o + 1] = bj * f;
      u16[o + 2] = Math.max(0, Math.round(yB * 50)); u16[o + 3] = Math.max(1, Math.round(yT * 50));
      u8[o * 2 + 8] = kTop; u8[o * 2 + 9] = trunk;
      u8[o * 2 + 10] = kTop === 1 ? eaveQ : 0; u8[o * 2 + 11] = hash(bi * f + 7919, bj * f + 104729) * 255;
      if (yT > ymax) ymax = yT;
      n++;
    }
  }
  return { inst: out.slice(0, n * 12), iCount: n, ymax };
}

// Roads and foot paths (the field map's roads.json, edges [a, b, kind, [[x, z], ...], width]): flat ribbons laid on
// the terrain mesh as it is drawn at this detail (a point's height is taken from the mesh's own triangles, then
// lifted a little). Each edge is kept as [kind, width, [x, z, x, z, ...]] and filed under every tile its bounding box
// touches; a tile draws the stretches whose middle lies inside it.
// Vertex, 16 bytes: Float32 x, y, z (m from the tile's corner), kind.
let roadTiles = null;
async function loadRoads() {
  if (roadTiles) return;
  roadTiles = new Map();
  try {
    const r = await fetch(`${DIR}roads.json?v=${index.version}`);
    if (!r.ok) return;
    const j = await r.json();
    for (const raw of j.edges) {
      if (raw[3].length < 2) continue;
      const e = [raw[2], raw[4], raw[3].flat()], p = e[2];
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < p.length; i += 2) {
        x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); z0 = Math.min(z0, p[i + 1]); z1 = Math.max(z1, p[i + 1]);
      }
      for (let tz = Math.max(0, Math.floor(z0 / TILE)); tz <= Math.floor(z1 / TILE); tz++) {
        for (let tx = Math.max(0, Math.floor(x0 / TILE)); tx <= Math.floor(x1 / TILE); tx++) {
          const k = `${tx}_${tz}`;
          if (!roadTiles.has(k)) roadTiles.set(k, []);
          roadTiles.get(k).push(e);
        }
      }
    }
  } catch { /* no roads for this map */ }
}

function buildRoads(t, name, s, x0, z0) {
  const list = roadTiles && roadTiles.get(name);
  if (!list) return { rv: null, ri: null, rCount: 0 };
  const T = t.ter;
  const H = (c, r) => T[Math.min(r, 500) * TN + Math.min(c, 500)] * UNIT;
  const ground = (x, z) => {                                 // height of the mesh's triangles at (x, z) in the tile
    const gx = Math.min(Math.max(x, 0), TILE - 1e-6) / s, gz = Math.min(Math.max(z, 0), TILE - 1e-6) / s;
    const c = Math.floor(gx), r = Math.floor(gz), fx = gx - c, fz = gz - r;
    const h00 = H(c * s, r * s), h10 = H((c + 1) * s, r * s), h01 = H(c * s, (r + 1) * s), h11 = H((c + 1) * s, (r + 1) * s);
    return fx + fz <= 1 ? h00 + fx * (h10 - h00) + fz * (h01 - h00) : h11 + (1 - fx) * (h01 - h11) + (1 - fz) * (h10 - h11);
  };
  const lift = 0.12 + 0.03 * s, step = Math.max(2, s), verts = [], idx = [];
  for (const [kind, width, p] of list) {
    const w = Math.max(width, 1.6) / 2;
    // the centre line every `step` metres
    const pts = [];
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i] - x0, az = p[i + 1] - z0, bx = p[i + 2] - x0, bz = p[i + 3] - z0;
      const m = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
      for (let k = 0; k < m; k++) pts.push([ax + (bx - ax) * k / m, az + (bz - az) * k / m]);
    }
    pts.push([p[p.length - 2] - x0, p[p.length - 1] - z0]);
    if (pts.length < 2) continue;
    // a left and a right edge point for each, along the mitred normal
    const L = [], R = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, pts.length - 1)];
      let dx = b[0] - a[0], dz = b[1] - a[1];
      const d = Math.hypot(dx, dz) || 1;
      dx /= d; dz /= d;
      L.push([pts[i][0] - dz * w, pts[i][1] + dx * w]); R.push([pts[i][0] + dz * w, pts[i][1] - dx * w]);
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2, mz = (pts[i][1] + pts[i + 1][1]) / 2;
      if (mx < 0 || mz < 0 || mx >= TILE || mz >= TILE) continue;
      const b = verts.length / 4;
      for (const q of [L[i], R[i], L[i + 1], R[i + 1]]) verts.push(q[0], ground(q[0], q[1]) + lift, q[1], kind);
      idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
  }
  if (!idx.length) return { rv: null, ri: null, rCount: 0 };
  return { rv: new Float32Array(verts).buffer, ri: new Uint32Array(idx), rCount: idx.length };
}

function build(t, job) {
  const base = { type: 'mesh', key: job.key, gen: job.gen, name: job.name, t: job.t, o: job.o, smooth: job.smooth };
  if (!t) return { msg: { ...base, sea: true }, transfer: [] };
  const [tx, tz] = job.name.split('_').map(Number);
  const ter = buildTerrain(t, job.t, tx * TILE, tz * TILE);
  const tr = t.trees && job.smooth && job.o <= 2 ? buildTrees(t, treeMask) : null;
  const obj = buildObjects(t, job.o, tr && treeMask);
  const rd = buildRoads(t, job.name, job.t, tx * TILE, tz * TILE);
  const msg = { ...base, sea: false, ...ter, ...obj, ...rd, ymax: Math.max(ter.ymax, obj.ymax, tr ? tr.ymaxTrees : -Infinity) };
  const transfer = [ter.tv, ter.ti.buffer, obj.inst];
  if (rd.rv) transfer.push(rd.rv, rd.ri.buffer);
  if (tr) { msg.tinst = tr.tinst; msg.trCount = tr.trCount; transfer.push(tr.tinst); } else msg.trCount = 0;
  if (job.wantTer) { msg.ter = t.ter.slice().buffer; transfer.push(msg.ter); }
  return { msg, transfer };
}

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const job = queue.shift();
    current = job.key;
    try {
      await loadIndex();
      await loadRoads();
      const t = await loadTile(job.name);
      if (job.smooth && job.o <= 2) await loadTrees(job.name, t);
      const { msg, transfer } = build(t, job);
      done.set(job.key, performance.now());
      if (done.size > 2000) done.delete(done.keys().next().value);
      postMessage(msg, transfer);
    } catch (err) {
      postMessage({ type: 'error', key: job.key, gen: job.gen, name: job.name, error: String(err && err.message || err) });
    }
    current = null;
  }
  busy = false;
}

onmessage = e => {
  const m = e.data;
  if (m.type === 'config') { maxTiles = m.maxTiles; if (m.dir) DIR = m.dir; }
  else if (m.type === 'jobs') {
    const now = performance.now();
    queue = m.jobs.filter(j => j.key !== current && !(now - (done.get(j.key) ?? -1e9) < 2000));
    pump();
  }
};

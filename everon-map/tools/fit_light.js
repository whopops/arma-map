// Score and fit the Light line of sight (static/app.js, lightLos) against the Visual model (static/los-worker.js).
//
//   node tools/fit_light.js spots <dir>           pick 200 test spots across the island's land (dir/spots.json)
//   node tools/fit_light.js truth <dir> [part n]  run Visual and Full at every spot (dir/truth/; slow, so it can be
//                                                 split: run parts 0..n-1 side by side)
//   node tools/fit_light.js score <dir> [json]    score Light (and origin/main's Light, if git has it) against them
//   node tools/fit_light.js fit <dir> [metric]    fit FOLIAGE_K, FOLIAGE_LOW_K, CLUTTER_K, SEE_CLEAR and SEE_TREES on
//                                                 the even spots (metric f1, bal or agree; default f1), report on the odd
//
// Scores are over Visual's 2.5 m cells, each compared with the Light cell it falls in; classes hidden, clear and seen
// through foliage. f1 is the mean of the three classes' F1 scores, bal the mean share of each class Light gets right,
// agree the share of all cells it gets right (mostly hidden ground, so it flatters). Needs Node 18+.
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib'), vm = require('vm'), cp = require('child_process');

const STATIC = path.join(__dirname, '..', 'static'), LIGHT = path.join(STATIC, 'data', 'light');
const APP = path.join(STATIC, 'app.js');

function between(src, a, b) { const i = src.indexOf(a); if (i < 0) throw new Error(`app.js: no "${a}"`); return src.slice(i, src.indexOf(b, i)); }
const gz = n => zlib.gunzipSync(fs.readFileSync(path.join(LIGHT, n + '.gz')));
const u8 = b => new Uint8Array(b.buffer, b.byteOffset, b.length);
let lightData = null;
function data() {
  if (lightData) return lightData;
  const h = gz('everon-height.bin'), nn = 1280 * 1280;
  lightData = { HEIGHT: new Int16Array(h.buffer, h.byteOffset, h.length / 2), CANOPY: u8(gz('everon-canopy.bin')), BUILDINGS: u8(gz('everon-buildings.bin')) };
  if (fs.existsSync(path.join(LIGHT, 'everon-foliage.bin.gz'))) {
    const f = u8(gz('everon-foliage.bin')), c = u8(gz('everon-clutter.bin')), fm = new Uint8Array(nn), cm = new Uint8Array(nn);
    for (let i = 0; i < f.length; i++) { const k = i % nn; if (f[i] > fm[k]) fm[k] = f[i]; if (c[i] > cm[k]) cm[k] = c[i]; }
    Object.assign(lightData, { FOLIAGE: f, CLUTTER: c, FOLIAGE_MAX: fm, CLUTTER_MAX: cm });
  }
  return lightData;
}

// app.js's lightLos, run outside the page, with any of its constants overridden.
function buildLight(src, params = {}) {
  let light = between(src, src.includes('  const FOLIAGE_K') ? '  const FOLIAGE_K' : '  const S_EFF', "  // Line of sight in the viewer's chosen detail");
  for (const [k, v] of Object.entries(params)) light = light.replace(new RegExp(`\\b${k} = [0-9.]+`), `${k} = ${v}`);
  const bands = src.includes('const LIGHT_BANDS') ? between(src, 'const LIGHT_BANDS', '\n') : '';
  const code = `const WORLD = 12800, HN = 1280, HCELL = 10, GUN_EYE = 1.2, TARGET_H = 1.5, LOS_CELL = 10, POST_KIND = { f: { eye: 1 } };
    const cellOf = ([x, z]) => (x < 0 || z < 0 || x >= WORLD || z >= WORLD ? -1 : Math.floor(z / HCELL) * HN + Math.floor(x / HCELL));
    const L = { latLngBounds: () => null }, toLL = p => p;
    ${bands}
    ${between(src, '  function heightAt(', '  // Exact heights')}
    ${light}
    this.lightLos = lightLos;`;
  const ctx = { Math, Map, Float64Array, Int32Array, Uint8Array, Infinity, ...data() };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.lightLos;
}

function worker() {
  const ctx = { console, Math, Promise, Map, Set, Uint8Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, Error, Response,
    DecompressionStream, String, fetch: async u => new Response(fs.readFileSync(path.join(STATIC, u.split('?')[0]))) };
  let done;
  ctx.postMessage = m => done(m);
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(STATIC, 'los-worker.js'), 'utf8'), ctx);
  return req => new Promise(r => { done = r; ctx.onmessage({ data: req }); });
}

function pickSpots(dir) {
  // Random land spots not standing on a building, wall or rock; mostly a gun's eye (1.2 m) looking for a standing
  // soldier out to 400 m, some overwatch (1 m, reversed), some standing at 700 m, some from 8 m up (a tower) at 800 m.
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const index = JSON.parse(fs.readFileSync(path.join(STATIC, 'data', 'los', 'index.json'))).tiles;
  const cfg = [...Array(5).fill([1.2, 1.5, 400, false]), [1, 1.5, 400, true], [1, 1.5, 400, true], [1.7, 1.5, 700, false], [1.7, 1.5, 700, false], [8, 1.5, 800, false]];
  const spots = [];
  while (spots.length < 200) {
    const name = index[Math.floor(rnd() * index.length)], [tx, tz] = name.split('_').map(Number);
    const raw = zlib.gunzipSync(fs.readFileSync(path.join(STATIC, 'data', 'los', name + '.bin.gz')));
    const r = Math.floor(rnd() * 1000), c = Math.floor(rnd() * 1000);
    const ground = raw.readUInt16LE(((r >> 1) * 501 + (c >> 1)) * 2), kind = raw[501 * 501 * 2 + 2 * 1000 * 1000 + r * 1000 + c];
    if (ground < 300 || kind === 1 || kind === 2) continue;
    const [eyeH, targetH, range, reverse] = cfg[Math.floor(rnd() * cfg.length)];
    spots.push({ xz: [tx * 500 + c * 0.5 + 0.25, tz * 500 + r * 0.5 + 0.25], eyeH, targetH, range, reverse });
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'spots.json'), JSON.stringify(spots));
  console.log(`${spots.length} spots in ${dir}/spots.json`);
}

async function makeTruth(dir, part = 0, parts = 1) {
  const ask = worker(), spots = JSON.parse(fs.readFileSync(path.join(dir, 'spots.json')));
  fs.mkdirSync(path.join(dir, 'truth'), { recursive: true });
  for (let i = part; i < spots.length; i += parts) for (const model of ['visual', 'full']) {
    const file = path.join(dir, 'truth', `${i}_${model}.json`);
    if (fs.existsSync(file)) continue;
    const s = spots[i];
    const m = await ask({ id: 1, xz: s.xz, dir: 0, arc: 360, range: s.range, eyeH: s.eyeH, targetH: s.targetH, reverse: s.reverse, elev: null, cell: 2.5, model });
    if (m.error) { console.log(i, m.error); continue; }
    fs.writeFileSync(file, JSON.stringify({ W: m.W, H: m.H, minX: m.minX, maxZ: m.maxZ, cell: m.cell, cells: Buffer.from(m.cells).toString('base64') }));
    if (model === 'visual') console.log(`spot ${i} done`);
  }
}

function scorer(dir) {
  const spots = JSON.parse(fs.readFileSync(path.join(dir, 'spots.json'))), cache = {};
  const truth = (i, model) => {
    const key = i + model;
    if (!(key in cache)) {
      const file = path.join(dir, 'truth', `${i}_${model}.json`);
      cache[key] = fs.existsSync(file) ? (t => ({ ...t, cells: Buffer.from(t.cells, 'base64') }))(JSON.parse(fs.readFileSync(file))) : null;
    }
    return cache[key];
  };
  const run = (fn, model, ids) => {
    const m = [0, 1, 2, 3].map(() => [0, 0, 0, 0]); // m[reference][light]; 1 hidden, 2 clear, 3 through foliage
    for (const i of ids) {
      const ref = truth(i, model), s = spots[i];
      if (!ref) continue;
      const los = fn(s.xz, 0, 360, s.range, false, s.eyeH, s.targetH, s.reverse);
      for (let cz = 0; cz < ref.H; cz++) for (let cx = 0; cx < ref.W; cx++) {
        const v = ref.cells[cz * ref.W + cx];
        if (!v) continue;
        const x = ref.minX + (cx + 0.5) * ref.cell, z = ref.maxZ - (cz + 0.5) * ref.cell;
        const lx = Math.floor((x - los.minX) / los.cell), lz = Math.floor((los.maxZ - z) / los.cell);
        if (lx < 0 || lx >= los.W || lz < 0 || lz >= los.H) continue;
        const l = los.cells[lz * los.W + lx];
        if (l) m[v][l]++;
      }
    }
    return summary(m);
  };
  return { spots, run, ids: spots.map((_, i) => i).filter(i => truth(i, 'visual')) };
}

function summary(m) {
  const cls = [1, 2, 3], real = a => m[a][1] + m[a][2] + m[a][3], pred = a => m[1][a] + m[2][a] + m[3][a];
  let tot = 0, agree = 0, seen = 0;
  for (const a of cls) for (const b of cls) { tot += m[a][b]; if (a === b) agree += m[a][b]; if ((a === 1) === (b === 1)) seen += m[a][b]; }
  const pct = a => cls.map(b => Math.round(100 * m[a][b] / Math.max(1, real(a))));
  return {
    f1: cls.map(a => (m[a][a] ? 2 * m[a][a] / (pred(a) + real(a)) : 0)).reduce((x, y) => x + y) / 3,
    bal: cls.map(a => m[a][a] / Math.max(1, real(a))).reduce((x, y) => x + y) / 3,
    agree: agree / tot, seen: seen / tot, cells: tot, hidden: pct(1), clear: pct(2), trees: pct(3),
  };
}
const fmt = r => `F1 ${(100 * r.f1).toFixed(1)}%  balanced ${(100 * r.bal).toFixed(1)}%  agree ${(100 * r.agree).toFixed(1)}%  ` +
  `seen-or-not ${(100 * r.seen).toFixed(1)}%  | reference hidden -> Light [hidden, clear, trees] % ${r.hidden}  clear -> ${r.clear}  trees -> ${r.trees}`;

function score(dir, params) {
  const { run, ids } = scorer(dir);
  const models = [['Light', buildLight(fs.readFileSync(APP, 'utf8'), params)]];
  try { models.unshift(['main Light', buildLight(cp.execSync('git show origin/main:everon-map/static/app.js', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString())]); } catch { /* no git */ }
  console.log(`${ids.length} spots`);
  for (const [name, fn] of models) for (const model of ['visual', 'full']) console.log(`${name.padEnd(10)} vs ${model.padEnd(6)} ${fmt(run(fn, model, ids))}`);
}

function fit(dir, metric = 'f1') {
  const { run, ids } = scorer(dir), src = fs.readFileSync(APP, 'utf8');
  const train = ids.filter(i => i % 2 === 0), test = ids.filter(i => i % 2 === 1);
  const read = k => +new RegExp(`\\b${k} = ([0-9.]+)`).exec(src)[1];
  const lim = { FOLIAGE_K: [0.05, 20], FOLIAGE_LOW_K: [0.05, 20], CLUTTER_K: [0, 20], SEE_CLEAR: [0.3, 0.995], SEE_TREES: [0.005, 0.6] };
  let p = Object.fromEntries(Object.keys(lim).map(k => [k, read(k)]));
  const f = q => (q.SEE_TREES >= q.SEE_CLEAR ? -1 : run(buildLight(src, q), 'visual', train)[metric]);
  let best = f(p), step = 1.6;
  console.log('start', best.toFixed(4), JSON.stringify(p));
  while (step > 1.03) {
    let improved = false;
    for (const k of Object.keys(p)) for (const dir of [step, 1 / step]) {
      const q = { ...p };
      q[k] = k === 'SEE_CLEAR' ? 1 - (1 - p[k]) * dir : k === 'CLUTTER_K' && !p[k] ? 0.05 : p[k] * dir;
      q[k] = +Math.min(lim[k][1], Math.max(lim[k][0], q[k])).toPrecision(4);
      const v = f(q);
      if (v > best + 1e-4) { best = v; p = q; improved = true; console.log(best.toFixed(4), JSON.stringify(p)); }
    }
    if (!improved) step = Math.sqrt(step);
  }
  console.log('fitted', JSON.stringify(p), `(train ${metric} ${best.toFixed(4)})`);
  console.log('held-out spots:', fmt(run(buildLight(src, p), 'visual', test)));
}

if (require.main === module) {
  const [cmd, dir, a, b] = process.argv.slice(2);
  if (!dir) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 14).join('\n')); process.exit(1); }
  if (cmd === 'spots') pickSpots(dir);
  else if (cmd === 'truth') makeTruth(dir, +a || 0, +b || 1);
  else if (cmd === 'score') score(dir, a ? JSON.parse(a) : {});
  else if (cmd === 'fit') fit(dir, a);
}
module.exports = { buildLight, scorer, summary };

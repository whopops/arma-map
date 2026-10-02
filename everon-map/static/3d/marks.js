// Marks: how each field-map marking looks in 3D. Every kind the field map's toolbar can draw is here, in two parts:
//   build()  plain coloured boxes standing on the ground (soldiers, vehicles, guns, flags, signs, fortifications...)
//            and the labels that name them
//   paint()  what lies flat on the ground (routes, arrows, areas, kill zones, sectors, fields of fire, range rings),
//            drawn with Canvas 2D in game metres; the page lays the picture over the terrain
// The colours, sizes and rules follow the field map (../app.js), so both read the same; mortar reach and
// impact zones come from its own firing solutions (mortar.js), and line of sight (range cards, MG nests, sectors, AA
// guns, overwatch, hull-down, where routes are seen) from its own worker (los.js). Its landing zone checks aren't
// repeated here.
// Both take env: { ground(x, z) -> height, field ({fia, conflict} from the map's reference file, or null), tables
// (/data/mortar-tables.json or null),
// los (line of sight, see los.js; null when it's switched off), forest(x, z) -> in a forest (the hull-down finder) }.
'use strict';

const Marks = (() => {
  const FRIENDLY = '#6cb8ff', ENEMY = '#ff5c5c', HEAR = '#b197fc', FIA = '#f783ac';
  const NATO = '#4dabf7', USSR = '#ff6b6b';
  const rad = d => d * Math.PI / 180;
  const hex = s => parseInt(String(s || '#ffffff').slice(1, 7), 16) || 0xffffff;
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const bearing = (a, b) => ((Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI) + 360) % 360;
  const toward = (xz, brg, r) => [xz[0] + r * Math.sin(rad(brg)), xz[1] + r * Math.cos(rad(brg))];
  const isPt = p => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
  const pts = v => (Array.isArray(v) ? v.filter(isPt) : []);
  const fmtDist = m => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`);
  const pad3 = n => String(Math.round(n) % 360).padStart(3, '0');

  // --- the field map's tables -------------------------------------------------------------------------------------
  const UNITS = { 'unit-inf-f': 'Friendly infantry', 'unit-arm-f': 'Friendly armour', 'unit-inf-e': 'Enemy infantry', 'unit-arm-e': 'Enemy armour' };
  const HAZARDS = { sniper: 'Sniper', blocked: 'Blocked or mined road', bridge: 'Bridge out', 'enemy-ambush': 'Enemy roadblock / ambush' };
  const MINES = { 'mine-at': 'AT minefield', 'mine-ap': 'AP minefield' };
  const MARKER_NAMES = { rally: 'Rally point', objective: 'Objective', danger: 'Danger', enemy: 'Enemy', vehicle: 'Vehicle', trp: 'TRP',
    contact: 'Contact', lz: 'LZ', radio: 'Radio', 'aa-f': 'AA gun', dot: 'Marker' };
  const FIRE = { he: { name: 'HE', color: '#ff922b' }, smoke: { name: 'Smoke', color: '#dee2e6' }, illum: { name: 'Illumination', color: '#ffe066' } };
  const AIR = { 'air-cas': { name: 'Gun run (CAS)', color: '#ff922b' }, 'air-medevac': { name: 'Medevac', color: '#ff6b6b' },
    'air-pickup': { name: 'Pickup / insertion', color: '#74c0fc' }, 'air-supply': { name: 'Resupply drop', color: '#8ce99a' } };
  const ARROWS = { advance: { name: 'Our advance', color: '#4dabf7', w: 5, dash: null }, enemy: { name: 'Enemy approach', color: '#ff5c5c', w: 4, dash: [10, 8] },
    patrol: { name: 'Enemy patrol route', color: '#ffa94d', w: 3, dash: [3, 7] }, flight: { name: 'Flight route', color: '#74c0fc', w: 3.5, dash: [12, 7] } };
  const POST = { f: 'Range card', e: 'Enemy line of sight', v: 'Enemy vehicle line of sight', fv: 'Friendly armour' };
  const CONSTRUCT = { wall: 'Sandbags', wire: 'Barbed wire', roadblock: 'Roadblock', bunker: 'Bunker', checkpoint: 'Checkpoint' };
  const HEARD = { rifle: 555, 'rifle-s': 310, mg: 695, hmg: 1150, launcher: 1150, gl: 555, pistol: 555, mortar: 330 };   // m, in a breeze
  const GUN_NAME = { rifle: 'Rifle or light MG', 'rifle-s': 'Suppressed rifle', mg: '7.62 MG', hmg: 'Heavy MG or cannon', launcher: 'RPG or LAW',
    gl: 'Grenade launcher', pistol: 'Pistol', mortar: 'Mortar' };
  const SECTOR_COLORS = ['#ffd43b', '#74c0fc', '#8ce99a', '#f783ac', '#ffa94d', '#b197fc', '#66d9e8', '#ff8787'];
  const LZ_R = 15, RADIO_CLEAR = 50, AT_KILL = 10, KILL_R = 20, DANGER_R = 35;
  const AMB = { kz: '#ff5c5c', assault: '#6cb8ff', support: '#ffc53d', security: '#8ce99a' };

  // unit markers and contacts time out (the owner's page removes them; until then they fade)
  const ttlOf = it => (it.type !== 'marker' ? 0 : it.icon === 'contact' ? it.ttl ?? 15 : UNITS[it.icon] ? it.ttl || 0 : 0);
  function age(it, now) {
    const ttl = ttlOf(it) * 60e3, a = now - (it.at || now);
    return !ttl ? 'live' : a > ttl ? 'expired' : a > ttl / 3 ? 'stale' : 'live';
  }
  const hasTimeouts = players => [...players.values()].some(p => [...p.items.values()].some(ttlOf));

  // every marking that should show, with its owner
  function entries(players, now) {
    const out = [];
    for (const [owner, p] of players) {
      for (const it of p.items.values()) {
        if (!it || typeof it !== 'object' || age(it, now) === 'expired') continue;
        out.push({ owner, color: it.color || p.color || '#ffffff', it, stale: age(it, now) === 'stale' });
      }
    }
    return out;
  }

  // The field map's ambush layout (ambushGeom): u runs along the kill zone, v away from it to the squad's side.
  function ambushGeom(a) {
    const len = dist(a.from, a.to), ux = (a.to[0] - a.from[0]) / len, uz = (a.to[1] - a.from[1]) / len;
    const side = a.side === -1 ? -1 : 1, nx = -uz * side, nz = ux * side;
    const P = (u, v) => [a.from[0] + ux * u + nx * v, a.from[1] + uz * u + nz * v];
    const D = Math.max(35, Math.min(90, len * 0.45)), K = 15, sd = Math.max(80, len * 0.5), road = bearing(a.from, a.to);
    const g = { len, P, kz: [P(0, -K), P(len, -K), P(len, K), P(0, K)],
      security: [[P(-sd, D * 0.5), (road + 180) % 360], [P(len + sd, D * 0.5), road]] };
    if (a.kind === 'l') {
      g.assault = [P(len * 0.1, D), P(len * 0.9, D)];
      g.support = [P(len + 30, K), P(len + 30, D)];
      g.fire = [[P(len * 0.5, D - 8), P(len * 0.5, K + 3)], [P(len + 24, (K + D) / 2), P(len * 0.45, K * 0.3)]];
    } else {
      g.support = [P(len * 0.05, D), P(len * 0.45, D)];
      g.assault = [P(len * 0.55, D), P(len * 0.95, D)];
      g.fire = [[P(len * 0.25, D - 8), P(len * 0.25, K + 3)], [P(len * 0.75, D - 8), P(len * 0.75, K + 3)]];
    }
    return g;
  }
  function postRings(range) {
    const out = [100, 200, 300, 400].filter(r => r <= range), step = range <= 800 ? 200 : 500;
    for (let r = Math.ceil(401 / step) * step; r <= range; r += step) out.push(r);
    return out;
  }
  function centroid(p) {
    let a = 0, cx = 0, cz = 0;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const f = p[j][0] * p[i][1] - p[i][0] * p[j][1];
      a += f; cx += (p[j][0] + p[i][0]) * f; cz += (p[j][1] + p[i][1]) * f;
    }
    return a ? [cx / (3 * a), cz / (3 * a)] : p[0];
  }
  const pathLength = p => p.reduce((s, q, i) => (i ? s + dist(p[i - 1], q) : 0), 0);

  // --- line of sight (the field map's losOverlay, range-card coverage, hull-down finder and route check) -----------
  // env.los(xz, dir, arc, range, eyeH, targetH, reverse, elev) gives a result (see los.js) or null while it's worked out.
  const LOS_HIDDEN = 1, LOS_CLEAR = 2, LOS_TREES = 3, LOS_RANK = [0, 1, 3, 2];
  const GUN_EYE = 1.2, TARGET_H = 1.5, AA_EYE = 2, AA_ELEV = [-10, 70], HELI_ALT = 100;   // m; the field map's default helicopter height
  const POST_EYE = { f: 1.0, e: 1.0, v: 2.0, fv: 2.0 };
  const gunEye = h => Math.round((GUN_EYE + (h || 0)) * 10) / 10;
  const isVehicleView = it => it.side === 'v' || it.side === 'fv' || (it.type === 'marker' && it.unit === 'arm');
  const postLos = (it, env) => env.los(it.xz, 0, 360, it.range, isVehicleView(it) ? POST_EYE.fv : POST_EYE[it.side] || POST_EYE.f, TARGET_H, false);
  // What marked enemies can see: their own views, else all round from where they are (soldiers 800 m, a sniper 1.2 km,
  // armour from its sights 2 m up to 1.5 km)
  const ENEMY_WATCH = { 'unit-inf-e': [1.0, 800], contact: [1.0, 800], enemy: [1.0, 800], 'enemy-ambush': [1.0, 800], sniper: [1.0, 1200], 'unit-arm-e': [2.0, 1500] };
  const HULL = { btr70: { hull: 1.9, sights: 2.3 }, brdm2: { hull: 1.75, sights: 2.3 }, lav25: { hull: 2.0, sights: 2.65 } };
  const HD_FOE = { s: 1.6, v: 2.0 }, HD_SLOPE = 0.5, HD_MIN = 60, HD_BACK = 30;
  const losAt = (los, xz) => {
    const cx = Math.floor((xz[0] - los.minX) / los.cell), cz = Math.floor((los.maxZ - xz[1]) / los.cell);
    return cx < 0 || cz < 0 || cx >= los.W || cz >= los.H ? null : los.cells[cz * los.W + cx] || null;
  };
  // A result painted cell by cell (fill(value, index) -> [r, g, b, a] or null), kept with the result.
  const pictures = new WeakMap();
  function picture(res, key, fill) {
    let m = pictures.get(res);
    if (!m) pictures.set(res, m = new Map());
    if (m.has(key)) return m.get(key);
    const c = document.createElement('canvas');
    c.width = res.W; c.height = res.H;
    const g = c.getContext('2d'), img = g.createImageData(res.W, res.H), px = img.data;
    for (let k = 0; k < res.W * res.H; k++) { const p = fill(res.cells[k], k); if (p) px.set(p, k * 4); }
    g.putImageData(img, 0, 0);
    m.set(key, c);
    return c;
  }
  // lays a grid's picture on the ground: its first row is the north edge
  function lay(ctx, g, pic) {
    ctx.save();
    ctx.globalAlpha = 1; ctx.imageSmoothingEnabled = false;
    ctx.translate(g.minX, g.maxZ); ctx.scale(g.cell, -g.cell);
    ctx.drawImage(pic, 0, 0);
    ctx.restore();
  }
  const rgb = s => { const n = hex(s); return [n >> 16, (n >> 8) & 255, n & 255]; };
  // clear ground tinted in the colour, ground seen only through trees yellow, dead ground dark
  function losOverlay(ctx, los, color, darkHidden = true, clearAlpha = 62) {
    const [r, g, b] = rgb(color);
    lay(ctx, los, picture(los, `${color}|${darkHidden}|${clearAlpha}`, v =>
      v === LOS_CLEAR ? [r, g, b, clearAlpha] : v === LOS_TREES ? [255, 222, 50, 80] : v === LOS_HIDDEN && darkHidden ? [6, 8, 12, 150] : null));
  }
  // Every range card and enemy view together: ground the enemy sees red, ground we see cyan, through trees yellow, and
  // ground inside our cards' reach that none of them sees dark (where an enemy can creep up unseen).
  let coverageLast = null;
  function coverage(ctx, all) {
    if (!all.length) return;
    const sig = all.map(x => x.side).join();
    if (!coverageLast || coverageLast.sig !== sig || coverageLast.parts.length !== all.length || coverageLast.parts.some((l, i) => l !== all[i].los)) {
      const C = Math.min(...all.map(x => x.los.cell));
      const minX = Math.min(...all.map(x => x.los.minX)), maxZ = Math.max(...all.map(x => x.los.maxZ));
      const Wd = Math.round((Math.max(...all.map(x => x.los.minX + x.los.W * x.los.cell)) - minX) / C);
      const Hd = Math.round((maxZ - Math.min(...all.map(x => x.los.maxZ - x.los.H * x.los.cell))) / C);
      const ours = new Uint8Array(Wd * Hd), theirs = new Uint8Array(Wd * Hd);
      for (const { side, los } of all) {
        const f = Math.round(los.cell / C), ox = Math.round((los.minX - minX) / C), oz = Math.round((maxZ - los.maxZ) / C);
        const dst = side === 'f' || side === 'fv' ? ours : theirs;
        for (let y = 0; y < los.H * f && y + oz < Hd; y++) {
          const row = (y + oz) * Wd + ox, src = Math.floor(y / f) * los.W;
          for (let x = 0; x < los.W * f && x + ox < Wd; x++) {
            const v = los.cells[src + Math.floor(x / f)];
            if (LOS_RANK[v] > LOS_RANK[dst[row + x]]) dst[row + x] = v;
          }
        }
      }
      const grid = { W: Wd, H: Hd, minX, maxZ, cell: C, cells: theirs };
      const pic = picture(grid, 'coverage', (v, k) => (theirs[k] === LOS_CLEAR ? [255, 92, 92, 88] : ours[k] === LOS_CLEAR ? [102, 217, 232, 50]
        : theirs[k] === LOS_TREES || ours[k] === LOS_TREES ? [255, 222, 50, 80] : ours[k] === LOS_HIDDEN ? [6, 8, 12, 155] : null));
      coverageLast = { sig, parts: all.map(x => x.los), grid, pic };
    }
    lay(ctx, coverageLast.grid, coverageLast.pic);
  }
  // Hull-down: from the enemy's spot, drivable ground where a vehicle's sights are in view and its hull isn't (green;
  // yellow if only through trees), and hidden ground within HD_BACK behind such a spot to wait in (blue).
  const hullCache = new Map();
  function hullDown(it, env) {
    const v = HULL[it.veh] || HULL.btr70, fh = HD_FOE[it.foe] || HD_FOE.s;
    const a = env.los(it.xz, 0, 360, it.range, fh, v.sights, true), b = env.los(it.xz, 0, 360, it.range, fh, v.hull, true);
    if (!a || !b || a.W !== b.W || a.H !== b.H) return null;
    const hit = hullCache.get(it.id);
    if (hit && hit.a === a && hit.b === b) return hit.res;
    const g = p => env.ground(p[0], p[1]), forest = p => (env.forest ? env.forest(p[0], p[1]) : false);
    const cells = new Uint8Array(a.W * a.H);
    for (let cz = 0; cz < a.H; cz++) for (let cx = 0; cx < a.W; cx++) {
      const i = cz * a.W + cx, sees = a.cells[i], hull = b.cells[i];
      if (!sees || hull !== LOS_HIDDEN || sees === LOS_HIDDEN) continue;
      const xz = [a.minX + (cx + 0.5) * a.cell, a.maxZ - (cz + 0.5) * a.cell];
      if (dist(xz, it.xz) < HD_MIN) continue;
      const h = g(xz);
      if (h < 0.5 || forest(xz)) continue;
      const dx = g([xz[0] + 3, xz[1]]) - g([xz[0] - 3, xz[1]]), dz = g([xz[0], xz[1] + 3]) - g([xz[0], xz[1] - 3]);
      if (Math.hypot(dx, dz) / 6 > HD_SLOPE) continue;
      cells[i] = sees === LOS_CLEAR ? 1 : 2;
    }
    const r = Math.ceil(HD_BACK / a.cell);
    for (let cz = 0; cz < a.H; cz++) for (let cx = 0; cx < a.W; cx++) {
      if (cells[cz * a.W + cx] !== 1) continue;
      for (let z = Math.max(0, cz - r); z <= Math.min(a.H - 1, cz + r); z++) for (let x = Math.max(0, cx - r); x <= Math.min(a.W - 1, cx + r); x++) {
        const j = z * a.W + x;
        if (cells[j] || a.cells[j] !== LOS_HIDDEN || b.cells[j] !== LOS_HIDDEN || Math.hypot(x - cx, z - cz) * a.cell > HD_BACK) continue;
        const q = [a.minX + (x + 0.5) * a.cell, a.maxZ - (z + 0.5) * a.cell];
        if (dist(q, it.xz) < HD_MIN || g(q) < 0.5 || forest(q)) continue;
        cells[j] = 3;
      }
    }
    // a ridge is only a cell or two wide: its spots are drawn a cell fatter so they show
    const out = new Uint8Array(cells);
    for (let k = 0; k < cells.length; k++) {
      if (cells[k] !== 1 && cells[k] !== 2) continue;
      const cx = k % a.W, cz = (k - cx) / a.W;
      for (let z = Math.max(0, cz - 1); z <= Math.min(a.H - 1, cz + 1); z++) for (let x = Math.max(0, cx - 1); x <= Math.min(a.W - 1, cx + 1); x++) {
        const j = z * a.W + x;
        if (out[j] !== 1 && (out[j] !== 2 || cells[k] === 1)) out[j] = cells[k];
      }
    }
    const res = { W: a.W, H: a.H, minX: a.minX, maxZ: a.maxZ, cell: a.cell, cells: out };
    if (hullCache.size > 20) hullCache.clear();
    hullCache.set(it.id, { a, b, res });
    return res;
  }
  // Route check: the stretches marked enemies see, clearly or through trees.
  function pointAlong(p, d) {
    for (let i = 0; i + 1 < p.length; i++) {
      const L = dist(p[i], p[i + 1]);
      if (d <= L || i === p.length - 2) { const t = L ? Math.min(1, d / L) : 0; return [p[i][0] + (p[i + 1][0] - p[i][0]) * t, p[i][1] + (p[i + 1][1] - p[i][1]) * t]; }
      d -= L;
    }
    return p[p.length - 1];
  }
  function exposure(p, ws) {
    const total = pathLength(p), step = Math.max(10, total / 500), S = [];
    for (let d = 0; d < total; d += step) S.push(d);
    S.push(total);
    const seen = S.map(d => {
      const xz = pointAlong(p, d);
      let best = 0;
      for (const w of ws) { const v = losAt(w, xz); if ((v === LOS_CLEAR || v === LOS_TREES) && LOS_RANK[v] > LOS_RANK[best]) { best = v; if (v === LOS_CLEAR) break; } }
      return { d, xz, seen: best };
    });
    const out = [];
    for (let i = 0; i < seen.length; i++) {
      if (!seen[i].seen) continue;
      let j = i;
      while (j + 1 < seen.length && seen[j + 1].seen === seen[i].seen) j++;
      const from = Math.max(0, seen[i].d - step / 2), to = Math.min(total, seen[j].d + step / 2);
      out.push({ clear: seen[i].seen === LOS_CLEAR, pts: [pointAlong(p, from), ...seen.slice(i, j + 1).map(s => s.xz), pointAlong(p, to)] });
      i = j;
    }
    return out;
  }

  // --- mortars (the field map's renderMortar and fire requests) ----------------------------------------------------
  const isLethal = shell => /^HE/.test(shell || '');
  const shellColor = shell => (/^Smoke/.test(shell) ? FIRE.smoke.color : /^Illum/.test(shell) ? FIRE.illum.color : '#adb5bd');
  const FIRE_SHELL = { he: /^HE/, smoke: /^Smoke/, illum: /^Illum/ };
  // each target of a mortar with its solution
  const mortarShots = (m, env) => pts(m.targets).map(t => ({ t, sol: Mortar.solve(env.tables, m.weapon, m.shell, m.xz, t, m.wind, env.ground) }));
  // A point fire request's spread: from the nearest mortar in the room that can reach it with a shell of the kind asked
  // for (the field map prefers your own or the one you follow; here nobody's is), or none.
  function fireSpread(req, players, env) {
    let best = null;
    for (const p of players.values()) {
      for (const m of p.items.values()) {
        if (m.type !== 'mortar' || !isPt(m.xz)) continue;
        const shell = Mortar.shellLike(env.tables, m.weapon, FIRE_SHELL[req.fire] || FIRE_SHELL.he, m.shell);
        const sol = Mortar.solve(env.tables, m.weapon, shell, m.xz, req.xz, m.wind, env.ground);
        if (sol.best && (!best || sol.d < best.d)) best = sol;
      }
    }
    return best;
  }

  // =================================================================================================================
  // 3D: boxes and labels
  // =================================================================================================================
  // Box: [x, y, z, along, up, across, turn, colour]; turn is radians from east towards north.
  // Labels: { xz, h (m above the ground), text, color, owner, dim }
  function build(players, env, now = Date.now()) {
    const { ground, field } = env;
    const boxes = [], labels = [];
    // a box standing on the ground at (x, z) (its bottom sunk below the lowest ground under it, so it never floats),
    // or with lift > 0, hanging that far above the highest ground under it
    const put = (x, z, along, up, across, turn, col, lift = 0) => {
      const c = Math.cos(turn), s = Math.sin(turn), a = along / 2, b = across / 2;
      let lo = Infinity, hi = -Infinity;
      for (const [u, v] of [[-a, -b], [a, -b], [-a, b], [a, b], [0, 0]]) {
        const g = ground(x + u * c - v * s, z + u * s + v * c);
        lo = Math.min(lo, g); hi = Math.max(hi, g);
      }
      if (lift > 0) boxes.push(x, hi + lift, z, along, up, across, turn, col);
      else boxes.push(x, lo - 0.2, z, along, up + (hi - lo) + 0.2, across, turn, col);
    };
    // a point `fwd` metres ahead of (x, z) along `turn` and `side` metres to its left
    const at = (x, z, turn, fwd, side) => [x + fwd * Math.cos(turn) - side * Math.sin(turn), z + fwd * Math.sin(turn) + side * Math.cos(turn)];
    // pieces of at most `step` metres along a line: f(x, z, length, turn) at the middle of each
    const along = (p, step, f) => {
      for (let i = 0; i + 1 < p.length; i++) {
        const [x0, z0] = p[i], [x1, z1] = p[i + 1], L = Math.hypot(x1 - x0, z1 - z0);
        if (L < 0.01) continue;
        const n = Math.max(1, Math.round(L / step)), turn = Math.atan2(z1 - z0, x1 - x0);
        for (let k = 0; k < n; k++) { const t = (k + 0.5) / n; f(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, L / n, turn); }
      }
    };
    const turnOf = brg => Math.PI / 2 - rad(brg || 0);
    const C = {
      sandbag: 0xb8a57a, concrete: 0x8e8e86, roof: 0x6c6c66, post: 0x5a4632, wire: 0x9aa0a6, steel: 0x4a4540, hut: 0x9c8f6e,
      red: 0xc83a32, white: 0xe6e6e6, gun: 0x2e3032, olive: 0x4f5a3a, crate: 0x7a6440, yellow: 0xf2c230,
    };

    // --- building blocks ------------------------------------------------------------------------------------------
    const beacon = (x, z, col, h = 4) => { put(x, z, 0.15, h, 0.15, 0, C.post); put(x, z, 0.8, 0.8, 0.8, Math.PI / 4, col, h); };
    const flag = (x, z, col, h = 6) => { put(x, z, 0.12, h + 0.2, 0.12, 0, C.post); const [fx, fz] = at(x, z, 0, 0.85, 0); put(fx, fz, 1.6, 1.0, 0.06, 0, col, h - 1.0); };
    const sign = (x, z, col, turn = 0) => { put(x, z, 0.1, 1.7, 0.1, turn, C.post); put(x, z, 0.9, 0.7, 0.06, turn, col, 1.0); };
    const soldier = (x, z, col, turn = 0) => { put(x, z, 0.45, 1.35, 0.3, turn, col); put(x, z, 0.28, 0.28, 0.28, turn, col, 1.4); };
    const squad = (x, z, col, turn = 0) => { for (const [f, s] of [[0, 0], [-1.6, 1.4], [-1.6, -1.4]]) { const [sx, sz] = at(x, z, turn, f, s); soldier(sx, sz, col, turn); } };
    const vehicle = (x, z, col, turn = 0) => { put(x, z, 6.5, 1.6, 2.8, turn, col); put(x, z, 2.2, 0.7, 2.0, turn, col, 1.6); const [bx, bz] = at(x, z, turn, 2.2, 0); put(bx, bz, 2.6, 0.12, 0.12, turn, C.gun, 1.95); };
    const aaGun = (x, z, col, brg) => {
      const t = turnOf(brg);
      put(x, z, 2.2, 0.8, 2.2, t, col); put(x, z, 1.2, 0.7, 1.2, t, C.gun, 0.8);
      for (const s of [-0.25, 0.25]) { const [gx, gz] = at(x, z, t, 1.2, s); put(gx, gz, 2.2, 0.1, 0.1, t, C.gun, 1.3); }
    };
    const tankTrap = (x, z, turn) => {
      put(x, z, 1.6, 0.25, 0.25, turn + Math.PI / 4, C.steel);
      put(x, z, 1.6, 0.25, 0.25, turn - Math.PI / 4, C.steel);
      put(x, z, 0.25, 1.2, 0.25, turn, C.steel);
    };
    const label = (e, xz, h, text, color) => labels.push({ xz, h, text, color: color || e.color, owner: e.owner, dim: e.stale });

    for (const e of entries(players, now)) {
      const it = e.it, own = hex(e.color), xz = isPt(it.xz) ? it.xz : null, name = it.label;
      try {
        if (it.type === 'marker' && xz) {
          const [x, z] = xz, icon = it.icon;
          if (icon === 'infantry') {                               // a player's own position
            if (it.unit === 'arm') vehicle(x, z, hex(FRIENDLY)); else squad(x, z, hex(FRIENDLY));
            label(e, xz, 3, `${e.owner}'s position`, FRIENDLY);
          } else if (UNITS[icon]) {                                // friendly / enemy infantry or armour
            const [, kind, side] = icon.split('-'), col = hex(side === 'e' ? ENEMY : FRIENDLY), t = typeof it.heading === 'number' ? turnOf(it.heading) : 0;
            if (kind === 'arm') vehicle(x, z, col, t); else squad(x, z, col, t);
            label(e, xz, kind === 'arm' ? 4 : 3, name || UNITS[icon], side === 'e' ? ENEMY : FRIENDLY);
          } else if (icon === 'contact') {
            beacon(x, z, hex(ENEMY), 5);
            const mins = Math.floor((now - (it.at || now)) / 60e3);
            label(e, xz, 6.5, [name || 'Contact', it.what, it.size, mins < 1 ? 'now' : `${mins} min`].filter(Boolean).join(' · '), ENEMY);
          } else if (icon === 'fire-point') {
            const f = FIRE[it.fire] || FIRE.he;
            beacon(x, z, hex(f.color), 4);
            label(e, xz, 5.5, `${name || 'Fire mission'} · ${f.name}`, f.color);
          } else if (AIR[icon]) {
            beacon(x, z, hex(AIR[icon].color), 5);
            label(e, xz, 6.5, `${name || AIR[icon].name}${it.status ? ` · ${it.status}` : ''}`, AIR[icon].color);
          } else if (icon === 'radio') {
            put(x, z, 0.5, 0.6, 0.35, 0, C.olive); put(x + 0.15, z, 0.04, 2.6, 0.04, 0, C.gun);
            label(e, xz, 3.2, name || 'Radio');
          } else if (icon === 'aa-f') {
            aaGun(x, z, hex(FRIENDLY), it.dir || 0);
            label(e, xz, 3, name || 'AA gun', FRIENDLY);
          } else if (MINES[icon]) {
            sign(x, z, C.red); label(e, xz, 2.4, name || MINES[icon], ENEMY);
          } else if (icon === 'trp') {
            put(x, z, 1.4, 0.4, 1.4, Math.PI / 4, own); put(x, z, 0.9, 0.4, 0.9, Math.PI / 4, own, 0.4); put(x, z, 0.4, 0.5, 0.4, Math.PI / 4, own, 0.8);
            label(e, xz, 2.2, name || 'TRP');
          } else if (icon === 'lz') {
            put(x, z, 0.1, 3, 0.1, 0, C.post); put(x + 0.5, z, 1.0, 0.35, 0.35, 0, 0xff8c1a, 2.5);    // a windsock
            label(e, xz, 4, name || 'LZ');
          } else if (icon === 'sniper') {
            soldier(x, z, hex(ENEMY)); label(e, xz, 2.5, name || HAZARDS.sniper, ENEMY);
          } else if (icon === 'enemy-ambush') {
            beacon(x, z, hex(ENEMY), 4); label(e, xz, 5.5, name || HAZARDS[icon], ENEMY);
          } else if (icon === 'blocked') {
            put(x, z, 0.3, 1.1, 0.3, 0, C.white);
            for (let k = 0; k < 5; k++) put(x - 2 + k + 0.5, z, 1.0, 0.15, 0.15, 0, k % 2 ? C.white : C.red, 0.95);
            label(e, xz, 2.5, name || HAZARDS.blocked, ENEMY);
          } else if (icon === 'bridge') {
            sign(x, z, 0xffa94d); label(e, xz, 2.4, name || HAZARDS.bridge, '#ffa94d');
          } else if (icon === 'rally') {
            flag(x, z, own); label(e, xz, 7, name || 'Rally point');
          } else if (icon === 'objective') {
            flag(x, z, hex('#ffd43b'), 8); label(e, xz, 9, name || 'Objective', '#ffd43b');
          } else if (icon === 'danger') {
            sign(x, z, C.yellow); label(e, xz, 2.4, name || 'Danger', '#ffd43b');
          } else if (icon === 'enemy') {
            beacon(x, z, hex(ENEMY), 4); label(e, xz, 5.5, name || 'Enemy', ENEMY);
          } else if (icon === 'vehicle') {
            vehicle(x, z, own); label(e, xz, 4, name || 'Vehicle');
          } else {
            beacon(x, z, own, 4); label(e, xz, 5.5, name || MARKER_NAMES[icon] || 'Marker');
          }
        } else if (it.type === 'construct') {
          const p = pts(it.points);
          if (it.kind === 'wall' && p.length > 1) {                // sandbags: a waist-high line of bags
            along(p, 1.2, (x, z, L, t) => put(x, z, L + 0.05, 0.9, 0.7, t, C.sandbag));
          } else if (it.kind === 'wire' && p.length > 1) {         // barbed wire: posts every 3 m, three strands
            along(p, 1.5, (x, z, L, t) => { for (const h of [0.3, 0.65, 1.0]) put(x, z, L, 0.05, 0.05, t, C.wire, h); });
            along(p, 3, (x, z, L, t) => { const [px, pz] = at(x, z, t, -L / 2, 0); put(px, pz, 0.12, 1.3, 0.12, t, C.post); });
            const [lx, lz] = p[p.length - 1];
            put(lx, lz, 0.12, 1.3, 0.12, 0, C.post);
          } else if (it.kind === 'roadblock' && p.length > 1) {    // tank traps every 2.5 m
            along(p, 2.5, (x, z, L, t) => tankTrap(x, z, t));
          } else if (it.kind === 'roadblock' && xz) {              // an older single-point roadblock: three traps
            for (const o of [-2.5, 0, 2.5]) tankTrap(xz[0] + o, xz[1], 0);
          } else if (it.kind === 'bunker' && xz) {                 // a low concrete box and its roof
            put(xz[0], xz[1], 5, 2.0, 5, 0, C.concrete);
            put(xz[0], xz[1], 5.6, 0.35, 5.6, 0, C.roof, 2.0);
          } else if (it.kind === 'checkpoint' && xz) {             // a hut, a barrier and a few bags
            const [x, z] = xz;
            put(x - 3.5, z, 2.5, 2.6, 2.5, 0, C.hut);
            put(x - 3.5, z, 3.0, 0.2, 3.0, 0, C.roof, 2.6);
            put(x - 1.6, z, 0.3, 1.1, 0.3, 0, C.white);
            for (let k = 0; k < 5; k++) put(x - 1.0 + k + 0.5, z, 1.0, 0.12, 0.12, 0, k % 2 ? C.white : C.red, 0.95);
            put(x - 3.5, z - 2.2, 3.0, 0.9, 0.7, 0, C.sandbag);
          }
          const where = xz || (p.length ? p[Math.floor(p.length / 2)] : null);
          if (where) label(e, where, it.kind === 'bunker' ? 4 : 3, name || CONSTRUCT[it.kind] || 'Construct');
        } else if (it.type === 'emplacement' && xz) {              // MG nest: a horseshoe of bags, the gun facing out
          const [x, z] = xz, t = turnOf(it.dir);
          for (let k = -4; k <= 4; k++) { const a = t + k * rad(26), [bx, bz] = at(x, z, a, 1.9, 0); put(bx, bz, 0.7, 0.8, 1.0, a, C.sandbag); }
          put(x, z, 0.3, 0.55, 0.3, t, C.gun);
          const [gx, gz] = at(x, z, t, 0.6, 0);
          put(gx, gz, 1.3, 0.1, 0.1, t, C.gun, 0.55);
          label(e, xz, 2.5, name || 'MG nest', FRIENDLY);
        } else if (it.type === 'aa' && xz) {                       // enemy AA gun
          aaGun(xz[0], xz[1], hex('#9a4a44'), it.dir || 0);
          label(e, xz, 3, name || 'AA gun', ENEMY);
        } else if (it.type === 'mortar' && xz) {                   // baseplate, tube, and a mark on each target
          put(xz[0], xz[1], 0.7, 0.1, 0.7, 0, C.gun); put(xz[0], xz[1], 0.14, 1.3, 0.14, 0, C.gun);
          label(e, xz, 2.5, `${name && name !== 'Mortar' ? name : 'Mortar'} · ${it.weapon || ''}`);
          mortarShots(it, env).forEach(({ t, sol }, i) => {
            beacon(t[0], t[1], sol.best ? own : hex('#ff6b6b'), 3);
            label(e, t, 4.5, `T${i + 1} · ${Mortar.short(sol)}`, sol.best ? undefined : '#ff6b6b');
          });
          const rch = Mortar.reach(env.tables, it.weapon, it.shell);   // how far each charge ring reaches, named at its top
          if (rch) for (const r of rch.rings) labels.push({ xz: [xz[0], xz[1] + r.max], h: 1, text: `R${r.ring} ${fmtDist(r.max)}`, color: e.color, owner: e.owner });
        } else if (it.type === 'post' && xz) {                     // range cards and enemy views
          const side = it.side || 'f', enemy = side === 'e' || side === 'v', col = hex(enemy ? ENEMY : side === 'fv' ? FRIENDLY : e.color);
          if (side === 'v' || side === 'fv') vehicle(xz[0], xz[1], col); else soldier(xz[0], xz[1], col);
          label(e, xz, 3.5, name || POST[side] || 'Range card', enemy ? ENEMY : undefined);
        } else if (it.type === 'overwatch' && xz) {
          soldier(xz[0], xz[1], own); label(e, xz, 2.5, `${name || 'Overwatch'} · ${fmtDist(it.range || 0)}`);
        } else if (it.type === 'hulldown' && xz) {
          vehicle(xz[0], xz[1], own); label(e, xz, 4, `${name || 'Hull-down'} · ${fmtDist(it.range || 0)}`);
        } else if (it.type === 'sectors' && xz) {
          beacon(xz[0], xz[1], 0xf1f3f5, 3); label(e, xz, 4.5, name || 'Sectors of fire');
          const n = Math.max(2, Math.min(12, it.n | 0)), names = it.names || [];
          for (let i = 0; i < n; i++) {
            const mid = (it.start || 0) + (i + 0.5) * 360 / n, col = SECTOR_COLORS[i % SECTOR_COLORS.length];
            labels.push({ xz: toward(xz, mid, (it.radius || 100) * 0.62), h: 2, text: `${'ABCDEFGHIJKL'[i]}${names[i] ? ` ${names[i]}` : ''}`, color: col, owner: e.owner });
          }
        } else if (it.type === 'audible' && xz) {
          beacon(xz[0], xz[1], hex(HEAR), 2.5);
          label(e, xz, 4, `${name || GUN_NAME[it.gun] || 'Gunfire'} · heard ${fmtDist(HEARD[it.gun] || HEARD.rifle)}`, HEAR);
        } else if (it.type === 'route') {
          const p = pts(it.points);
          if (p.length > 1) label(e, p[p.length - 1], 2, `${name ? `${name} · ` : ''}${fmtDist(pathLength(p))}`);
        } else if (it.type === 'arrow') {
          const p = pts(it.points), s = ARROWS[it.kind] || ARROWS.advance;
          if (p.length > 1) label(e, p[p.length - 1], 2, name || s.name, s.color);
        } else if (it.type === 'range' && isPt(it.from) && isPt(it.to)) {
          const mid = [(it.from[0] + it.to[0]) / 2, (it.from[1] + it.to[1]) / 2];
          label(e, mid, 2, `${name ? `${name} · ` : ''}${fmtDist(dist(it.from, it.to))} · ${pad3(bearing(it.from, it.to))}°`);
        } else if (it.type === 'area') {
          const p = pts(it.points);
          if (p.length > 2) {
            const f = FIRE[it.fire] || FIRE.he;
            const [text, col] = it.kind === 'fire' ? [`${name || 'Fire mission'} · ${f.name}`, f.color]
              : it.kind === 'cas' ? [name || AIR['air-cas'].name, AIR['air-cas'].color] : [name || 'Enemy in area', ENEMY];
            label(e, centroid(p), 2, text, col);
          }
        } else if (it.type === 'ambush' && isPt(it.from) && isPt(it.to) && dist(it.from, it.to) > 1) {
          const g = ambushGeom(it);
          label(e, g.P(g.len / 2, 0), 2, name || (it.kind === 'l' ? 'L-shaped ambush' : 'Linear ambush'), AMB.kz);
          for (const [xz2, brg] of g.security) { soldier(xz2[0], xz2[1], hex(AMB.security), turnOf(brg)); }
        } else if (it.type === 'fia' && field) {                   // this game's FIA caches: a crate and a pink marker
          for (const c of it.caches || []) {
            const spot = field.fia.find(f => f.name === c);
            if (!spot) continue;
            put(spot.xz[0], spot.xz[1], 1.2, 0.8, 0.8, 0, C.crate); beacon(spot.xz[0], spot.xz[1], hex(FIA), 5);
            label(e, spot.xz, 6.5, `FIA cache: ${c}`, FIA);
          }
        } else if (it.type === 'control' && field) {               // who holds each Conflict point: a flag in their colour
          for (const [pname, v] of Object.entries(it.marks || {})) {
            const spot = field.conflict.find(c => c.name === pname);
            if (!spot) continue;
            const col = v.s === 'ussr' ? USSR : NATO;
            flag(spot.xz[0], spot.xz[1], hex(col), 10);
            label(e, spot.xz, 11, `${pname} · ${v.s === 'ussr' ? 'USSR' : 'NATO'}`, col);
          }
        }
      } catch (err) { console.warn('Skipped a marking', it, err); }
    }
    return { boxes, labels };
  }

  // =================================================================================================================
  // On the ground: Canvas 2D in game metres (the caller sets the transform). `px` is metres per pixel of the picture:
  // lines are never drawn thinner than a pixel or two of it.
  // =================================================================================================================
  function paint(ctx, players, env, px, now = Date.now()) {
    const { field } = env;
    const W = (m, minPx = 1.5) => Math.max(m, minPx * px);
    const D = d => (d ? d.map(v => Math.max(v, 2.5 * px)) : []);
    const alpha = (a, e) => (e && e.stale ? a * 0.45 : a);
    const path = p => { ctx.beginPath(); ctx.moveTo(p[0][0], p[0][1]); for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]); };
    const line = (p, col, w, dash, a = 0.95, cap = 'round') => {
      if (p.length < 2) return;
      path(p);
      ctx.globalAlpha = a; ctx.strokeStyle = col; ctx.lineWidth = w; ctx.setLineDash(D(dash)); ctx.lineCap = cap; ctx.lineJoin = 'round';
      ctx.stroke();
    };
    const poly = (p, col, fillA, strokeW, dash, strokeA = 0.9) => {
      if (p.length < 3) return;
      path(p); ctx.closePath();
      if (fillA) { ctx.globalAlpha = fillA; ctx.fillStyle = col; ctx.fill(); }
      if (strokeW) { ctx.globalAlpha = strokeA; ctx.strokeStyle = col; ctx.lineWidth = strokeW; ctx.setLineDash(D(dash)); ctx.stroke(); }
    };
    const circle = (xz, r, col, fillA, strokeW, dash, strokeA = 0.9) => {
      ctx.beginPath(); ctx.arc(xz[0], xz[1], r, 0, Math.PI * 2);
      if (fillA) { ctx.globalAlpha = fillA; ctx.fillStyle = col; ctx.fill(); }
      if (strokeW) { ctx.globalAlpha = strokeA; ctx.strokeStyle = col; ctx.lineWidth = strokeW; ctx.setLineDash(D(dash)); ctx.stroke(); }
    };
    const sector = (xz, dir, arc, r) => {
      const n = Math.max(8, Math.round(arc / 3)), out = [xz];
      for (let i = 0; i <= n; i++) out.push(toward(xz, dir - arc / 2 + arc * i / n, r));
      return out;
    };
    const head = (tip, brg, col, size, a = 0.95) => {
      const s = W(size, 7);
      poly([tip, toward(toward(tip, brg + 180, s), brg - 90, s * 0.45), toward(tip, brg + 180, s * 0.7), toward(toward(tip, brg + 180, s), brg + 90, s * 0.45)], col, a, 0);
    };
    const cross = (xz, r, col, w) => { line([toward(xz, 0, r), toward(xz, 180, r)], col, w, null); line([toward(xz, 90, r), toward(xz, 270, r)], col, w, null); };
    // An ellipse around xz, `long` m along bearing az and `side` m across it (half-lengths), grown by `grow` m all round
    const ellipse = (xz, sh, grow) => {
      const a = rad(sh.az), L1 = sh.long + grow, S1 = sh.side + grow, out = [];
      for (let i = 0; i < 48; i++) {
        const t = i / 48 * 2 * Math.PI, u = L1 * Math.cos(t), s = S1 * Math.sin(t);
        out.push([xz[0] + u * Math.sin(a) + s * Math.cos(a), xz[1] + u * Math.cos(a) - s * Math.sin(a)]);
      }
      return out;
    };
    // Where rounds land around an aim point (the field map's impactZones): the 90% spread (an ellipse along the line of
    // fire, or a circle), and for HE the kill zone KILL_R and danger zone DANGER_R beyond it.
    const impactZones = (xz, spread, lethal, color, shape) => {
      const zone = (grow, c, fillA, w, dash) => (shape ? poly(ellipse(xz, shape, grow), c, fillA, W(w, w), dash) : circle(xz, spread + grow, c, fillA, W(w, w), dash));
      if (lethal) {
        zone(DANGER_R, '#ffd43b', 0.12, 1.8, [6, 5]);
        zone(KILL_R, '#ff5c5c', 0.1, 1.8, [6, 5]);
        if (spread) zone(0, '#ff2b2b', 0.35, 2, null);
      } else if (spread) zone(0, color, 0.16, 1.8, [5, 4]);
    };

    // line of sight first, under everything else
    const list = entries(players, now);
    if (env.los) {
      try {
        const cards = [], watchers = [];
        for (const e of list) {
          const it = e.it, xz = isPt(it.xz) ? it.xz : null;
          if (!xz) continue;
          if (it.type === 'post' || (it.type === 'marker' && it.icon === 'infantry' && it.range > 0)) {
            const los = postLos(it, env);
            if (los) cards.push({ side: it.type === 'post' ? it.side || 'f' : 'f', los });
            if (los && (it.side === 'e' || it.side === 'v')) watchers.push(los);
          } else if (it.type === 'emplacement') {
            const los = env.los(xz, it.dir || 0, it.arc || 60, it.range || 300, gunEye(it.height), TARGET_H, false);
            if (los) losOverlay(ctx, los, FRIENDLY);
          } else if (it.type === 'aa') {
            const los = env.los(xz, it.dir || 0, it.arc || 160, it.range || 1500, AA_EYE + (it.height || 0), HELI_ALT, false, AA_ELEV);
            if (los) losOverlay(ctx, los, ENEMY, false, 70);
          } else if (it.type === 'sectors') {
            const n = Math.max(2, Math.min(12, it.n | 0)), span = 360 / n;
            for (let i = 0; i < n; i++) {
              const los = env.los(xz, (it.start || 0) + i * span + span / 2, span, it.radius || 100, gunEye(it.height), TARGET_H, false);
              if (los) losOverlay(ctx, los, SECTOR_COLORS[i % SECTOR_COLORS.length], true, 38);
            }
          } else if (it.type === 'overwatch') {
            const los = env.los(xz, 0, 360, it.range || 400, TARGET_H, POST_EYE.f, true);
            if (los) losOverlay(ctx, los, e.color, false, 95);
          } else if (it.type === 'hulldown') {
            const r = hullDown(it, env);
            if (r) lay(ctx, r, picture(r, 'hull', v => (v === 1 ? [84, 255, 120, 200] : v === 2 ? [255, 222, 50, 130] : v === 3 ? [108, 184, 255, 105] : null)));
          } else if (it.type === 'marker' && ENEMY_WATCH[it.icon]) {
            const [eye, reach] = ENEMY_WATCH[it.icon];
            if (list.some(o => o.it.type === 'route')) { const los = env.los(xz, 0, 360, reach, eye, TARGET_H, false); if (los) watchers.push(los); }
          }
        }
        coverage(ctx, cards);
        if (watchers.length) {                                    // where routes are seen: a glow under them
          for (const e of list) {
            if (e.it.type !== 'route') continue;
            for (const s of exposure(pts(e.it.points), watchers)) line(s.pts, s.clear ? '#ff3b3b' : '#ffde32', W(9, 9), null, s.clear ? 0.6 : 0.5);
          }
        }
      } catch (err) { console.warn('Skipped line of sight', err); }
    }

    for (const e of list) {
      const it = e.it, xz = isPt(it.xz) ? it.xz : null, col = e.color;
      try {
        if (it.type === 'route') {
          const p = pts(it.points), c = it.plan && it.plan.mode === 'vehicle' ? '#51cf66' : col;
          line(p, '#000', W(4.5, 5), null, 0.45);
          line(p, c, W(2.5, 3), null, alpha(0.95, e));
          p.forEach((q, i) => circle(q, W(i === 0 || i === p.length - 1 ? 3 : 2, 3), c, 1, 0));
        } else if (it.type === 'arrow') {
          const p = pts(it.points), s = ARROWS[it.kind] || ARROWS.advance;
          if (p.length < 2) continue;
          line(p, '#0d1115', W(s.w * 0.9 + 2.5, s.w + 3), null, 0.45);
          line(p, s.color, W(s.w * 0.9, s.w), s.dash && s.dash.map(v => v * 2));
          head(p[p.length - 1], bearing(p[p.length - 2], p[p.length - 1]), s.color, it.kind === 'advance' ? 18 : 14);
          if (it.kind === 'patrol') {                              // chevrons show which way it goes
            const len = pathLength(p), gap = Math.max(40, len / 14);
            for (let d = gap, i = 0, done = 0; d < len - gap / 2; d += gap) {
              while (i < p.length - 2 && done + dist(p[i], p[i + 1]) < d) { done += dist(p[i], p[i + 1]); i++; }
              const t = (d - done) / (dist(p[i], p[i + 1]) || 1), q = [p[i][0] + (p[i + 1][0] - p[i][0]) * t, p[i][1] + (p[i + 1][1] - p[i][1]) * t];
              const b = bearing(p[i], p[i + 1]), s2 = W(5, 4);
              line([toward(toward(q, b + 90, s2), b + 180, s2), q, toward(toward(q, b - 90, s2), b + 180, s2)], s.color, W(1.5, 2), null);
            }
          }
        } else if (it.type === 'range' && isPt(it.from) && isPt(it.to)) {
          line([it.from, it.to], '#000', W(3.5, 4), null, 0.4);
          line([it.from, it.to], col, W(2, 2.5), [8, 6]);
          circle(it.from, W(2.5, 3), col, 1, 0); circle(it.to, W(4, 4), col, 0.6, W(1.2, 2), null);
        } else if (it.type === 'area') {
          const p = pts(it.points), f = FIRE[it.fire] || FIRE.he;
          const [c, fa, dash] = it.kind === 'fire' ? [f.color, 0.2, [10, 5]] : it.kind === 'cas' ? [AIR['air-cas'].color, 0.2, [10, 5]] : [ENEMY, 0.22, [7, 5]];
          poly(p, c, fa, W(2, 2), dash);
        } else if (it.type === 'ambush' && isPt(it.from) && isPt(it.to) && dist(it.from, it.to) > 1) {
          const g = ambushGeom(it);
          poly(g.kz, AMB.kz, 0.2, W(2, 2), [6, 4]);
          for (const [s, t] of g.fire) { line([s, t], '#f1f3f5', W(1.5, 1.6), [4, 4], 0.85); head(t, bearing(s, t), '#f1f3f5', 6); }
          for (const [p, c] of [[g.support, AMB.support], [g.assault, AMB.assault]]) { line(p, '#0d1115', W(7, 8), null, 0.55); line(p, c, W(4.5, 5), null); }
          for (const [q] of g.security) circle(q, W(4, 4), AMB.security, 0.6, W(1.2, 1.5), null);
        } else if (it.type === 'sectors' && xz) {
          const n = Math.max(2, Math.min(12, it.n | 0)), r = it.radius || 100;
          for (let i = 0; i < n; i++) {
            const a = (it.start || 0) + i * 360 / n, c = SECTOR_COLORS[i % SECTOR_COLORS.length];
            poly(sector(xz, a + 180 / n, 360 / n, r), c, 0.1, W(1.5, 1.6), null);
          }
        } else if (it.type === 'emplacement' && xz) {             // (no fill once its line of sight shows what it covers)
          const seen = env.los && env.los(xz, it.dir || 0, it.arc || 60, it.range || 300, gunEye(it.height), TARGET_H, false);
          poly(sector(xz, it.dir || 0, it.arc || 60, it.range || 300), FRIENDLY, seen ? 0 : 0.17, W(1.5, 1.5), [5, 4]);
        } else if (it.type === 'aa' && xz) {
          poly(sector(xz, it.dir || 0, it.arc || 160, it.range || 1500), ENEMY, 0.06, W(1.5, 1.5), [6, 5]);
        } else if (it.type === 'post' && xz) {
          const side = it.side || 'f', enemy = side === 'e' || side === 'v', c = enemy ? ENEMY : side === 'fv' ? FRIENDLY : col, R = it.range || 400;
          for (const r of enemy ? [R] : postRings(R)) circle(xz, r, c, 0, W(r === R ? 1.8 : 1.1, r === R ? 1.8 : 1.1), r === R ? [7, 5] : [2, 5], r === R ? 0.9 : 0.75);
        } else if (it.type === 'overwatch' && xz) {
          circle(xz, it.range || 400, col, 0, W(1.6, 1.6), [7, 5], 0.85);
        } else if (it.type === 'hulldown' && xz) {                // the enemy it's worked out from, in red
          circle(xz, it.range || 400, ENEMY, 0, W(1.6, 1.6), [7, 5], 0.75);
        } else if (it.type === 'audible' && xz) {
          circle(xz, HEARD[it.gun] || HEARD.rifle, HEAR, 0.05, W(1.6, 1.6), [3, 6]);
        } else if (it.type === 'mortar' && xz) {
          const rch = Mortar.reach(env.tables, it.weapon, it.shell);   // each ring's reach, and the shortest it can fire
          if (rch) {
            for (const r of rch.rings) circle(xz, r.max, col, 0, W(1.2, 1.2), [4, 6], 0.45);
            circle(xz, rch.min, '#ff6b6b', 0.08, W(1.2, 1.2), [2, 4]);
          }
          for (const { t, sol } of mortarShots(it, env)) {
            const c = sol.best ? col : '#ff6b6b';
            line([xz, t], c, W(1.5, 1.5), [2, 5], 0.8);
            if (sol.best) impactZones(t, sol.best.dispersion, isLethal(it.shell), shellColor(it.shell), sol.best.spread);
            cross(t, W(4, 5), c, W(1, 1.2));
          }
        } else if (it.type === 'fia' && field) {
          for (const c of it.caches || []) { const s = field.fia.find(f => f.name === c); if (s) circle(s.xz, 50, FIA, 0.12, W(2, 2), [6, 4]); }
        } else if (it.type === 'control' && field) {
          for (const [pname, v] of Object.entries(it.marks || {})) {
            const s = field.conflict.find(c => c.name === pname);
            if (s) circle(s.xz, 50, v.s === 'ussr' ? USSR : NATO, 0.18, W(2, 2), null);
          }
        } else if (it.type === 'marker' && xz) {
          const icon = it.icon;
          if (icon === 'infantry') {
            circle(xz, 5, FRIENDLY, 0.35, W(1, 1.2), null);
            if (it.range > 0) for (const r of postRings(it.range)) circle(xz, r, col, 0, W(1.2, 1.2), r === it.range ? [7, 5] : [2, 5], 0.75);
          } else if (UNITS[icon]) {
            const c = icon.endsWith('-e') ? ENEMY : FRIENDLY;
            circle(xz, icon.includes('arm') ? 9 : 6, c, alpha(0.35, e), W(1, 1.2), null, alpha(0.9, e));
            if (typeof it.heading === 'number') { const tip = toward(xz, it.heading, 30); line([toward(xz, it.heading, 9), tip], c, W(1.5, 2), null, alpha(0.9, e)); head(tip, it.heading, c, 6, alpha(0.95, e)); }
          } else if (icon === 'contact') {
            const tr = pts(it.trail);
            if (tr.length) { line([...tr, xz], ENEMY, W(1.5, 2), [2, 6], alpha(0.7, e)); tr.forEach(q => circle(q, W(2, 3), ENEMY, 0.8, 0)); }
            circle(xz, 6, ENEMY, alpha(0.3, e), W(1.2, 1.5), null, alpha(0.9, e));
            if (typeof it.heading === 'number') { const tip = toward(xz, it.heading, 30); line([toward(xz, it.heading, 8), tip], ENEMY, W(1.5, 2), null, alpha(0.9, e)); head(tip, it.heading, ENEMY, 6, alpha(0.95, e)); }
          } else if (icon === 'fire-point') {                     // sized by the nearest mortar that can reach it
            const f = FIRE[it.fire] || FIRE.he, s = fireSpread(it, players, env);
            impactZones(xz, s ? s.best.dispersion : 0, f === FIRE.he, f.color, s ? s.best.spread : null);
            cross(xz, W(8, 6), f.color, W(1.2, 1.5));
          } else if (AIR[icon]) {
            const c = AIR[icon].color;
            if (icon === 'air-medevac' || icon === 'air-pickup') circle(xz, LZ_R, c, 0.14, W(2, 2), [5, 4]);
            else { circle(xz, 30, c, 0.1, W(1.8, 1.8), [6, 5]); cross(xz, W(12, 6), c, W(1.2, 1.5)); }
          } else if (icon === 'radio') {
            if (it.ring) circle(xz, RADIO_CLEAR, col, 0.08, W(2, 2), [6, 5]);
          } else if (icon === 'lz') {
            circle(xz, LZ_R, '#adb5bd', 0.14, W(2, 2), [5, 4]);
            const H = 5, wH = W(1.4, 1.5);                          // a big H on the ground
            line([[xz[0] - H * 0.6, xz[1] - H], [xz[0] - H * 0.6, xz[1] + H]], '#f1f3f5', wH, null, 0.9, 'butt');
            line([[xz[0] + H * 0.6, xz[1] - H], [xz[0] + H * 0.6, xz[1] + H]], '#f1f3f5', wH, null, 0.9, 'butt');
            line([[xz[0] - H * 0.6, xz[1]], [xz[0] + H * 0.6, xz[1]]], '#f1f3f5', wH, null, 0.9, 'butt');
          } else if (icon === 'mine-at') {
            circle(xz, AT_KILL, ENEMY, 0.18, W(1.5, 1.5), [4, 3]);
          } else if (icon === 'mine-ap') {
            circle(xz, 5, ENEMY, 0.12, W(1.2, 1.2), [2, 3]);
          } else if (icon === 'trp') {
            poly([toward(xz, 0, 6), toward(xz, 120, 6), toward(xz, 240, 6)], col, 0.25, W(1.5, 1.5), null);
          } else if (icon === 'sniper') {
            circle(xz, 8, ENEMY, 0.15, W(1.5, 1.5), null); cross(xz, W(12, 6), ENEMY, W(1.2, 1.2));
          } else if (icon === 'enemy-ambush') {
            poly([toward(xz, 0, 9), toward(xz, 90, 9), toward(xz, 180, 9), toward(xz, 270, 9)], ENEMY, 0.3, W(1.5, 1.5), null);
          } else if (icon === 'blocked' || icon === 'bridge') {
            circle(xz, 8, icon === 'blocked' ? ENEMY : '#ffa94d', 0.2, W(1.5, 1.5), null);
          } else {
            circle(xz, 3, icon === 'enemy' ? ENEMY : col, 0.55, W(1, 1.2), null);
          }
        }
      } catch (err) { console.warn('Skipped a marking', it, err); }
    }
    ctx.globalAlpha = 1; ctx.setLineDash([]);
  }

  return { build, paint, hasTimeouts };
})();

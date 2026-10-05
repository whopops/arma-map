/* Arma Reforger Maps - the shot calculator: rocket launchers, scoped rifles and machine guns, and vehicle guns.
   Shared by the field map (app.js) and the shot planner page (shot/). Moved here unchanged from app.js.
   env: ground([x, z]) in m, hasGround() once heights are in, windParts(wind, az), fmtDist, dist, bearing. */
window.ShotCore = function ShotCore(env) {
  'use strict';
  const { ground, hasGround, windParts, fmtDist, dist, bearing } = env;

  // Rocket calculator: which sight mark, how much hold and which bearing, for a launcher on a range line -----------
  // From flights of the game's own rockets (reforger-map-tools rockettest.py, data/rockets.json): each rocket's flight in
  // still air at test elevations, every dt seconds (along the ground, up), and what wind adds to it per m/s (head, tail,
  // cross from the right: along, up, side). The game's rockets don't fly like the sights assume: motor rockets (PG-7VM,
  // PG-7VL) turn into a crosswind while they burn, the others drift with it, and some range marks are a degree off. So the
  // shot is solved from the flights, then the angle it needs above the line of sight is turned into the nearest mark.
  let ROCKETS = null, BULLETS = null;
  const ROCKET_CHOICES = [['RPG-7', 'PG-7VM'], ['RPG-7', 'PG-7VL'], ['RPG-7', 'PG-7VR'], ['M72A3', 'M72A3'], ['RPG-22', 'PG-22'], ['RPG-75', 'RPG-75']];
  const ROCKET_AIM = '#ffd43b'; // the aim line and crosshair (app.css .rk-aim)
  // Scoped rifles, machine guns and vehicle guns, flown the same way as the rockets (reforger-map-tools bullettest.py,
  // data/bullets.json: each round at its weapon's launch speed). `zeros`: a turret scope's ranges (its SightRangeInfo
  // list; the game zeroes the reticle centre for the range set). `lines`: a sight with range lines instead, [range,
  // texture row] measured off its reticle texture, `pxdeg` px per degree (m_fReticlePortion of the texture spans
  // m_fReticleAngularSize), `centre` the texture's centre row (where the aim mark is drawn), `axis` the row the bore
  // points at, per gun (least-squares fitted to the measured flights in bullets.json; the game's lines don't all match
  // the flights, and the hold covers the rest). `reticle`: how it's drawn.
  // `target`: what it's drawn against (man-sized for the infantry weapons; a LAV-25 for the NSV, BTR-70 and BRDM-2; a
  // BTR-70 for the LAV-25).
  const steps = (a, b, s) => Array.from({ length: Math.round((b - a) / s) + 1 }, (_, i) => a + i * s);
  const PP61 = { pxdeg: 152.8, axis: 512, centre: 512, reticle: 'pp61', mils: 0.06 };
  const LAV25 = { pxdeg: 376.4, axis: 511.5, centre: 511.5, reticle: 'lav' };
  const SCOPES = {
    'SVD': { name: 'SVD · PSO-1', round: '7N1 (SVD)', group: 'Rifles and machine guns', target: 'man', zeros: steps(100, 1000, 100), reticle: 'pso1', mils: 0.06 },
    'M21': { name: 'M21 · ART II', round: 'M118 (M21)', group: 'Rifles and machine guns', target: 'man', zeros: steps(300, 900, 100), reticle: 'art2' },
    'M16A2': { name: 'M16A2 · 4x20', round: 'M855 (M16A2)', group: 'Rifles and machine guns', target: 'man', zeros: steps(200, 500, 100), reticle: 'cross' },
    'M16A2 carbine': { name: 'M16A2 carbine · 4x20', round: 'M855 (M16A2 carbine)', group: 'Rifles and machine guns', target: 'man', zeros: steps(200, 500, 100), reticle: 'cross' },
    'AK-74N': { name: 'AK-74N · 1P29', round: '7N6 (AK-74)', group: 'Rifles and machine guns', target: 'man', zeros: steps(100, 500, 100), reticle: 'post' },
    'AKS-74UN': { name: 'AKS-74UN · 1P29', round: '7N6 (AKS-74U)', group: 'Rifles and machine guns', target: 'man', zeros: steps(100, 500, 100), reticle: 'post' },
    'RPK-74N': { name: 'RPK-74N · 1P29', round: '7N6 (RPK-74)', group: 'Rifles and machine guns', target: 'man', zeros: steps(100, 500, 100), reticle: 'post' },
    'PKMN': { name: 'PKMN · 1P29', round: '57N323S (PKM, UK59)', group: 'Rifles and machine guns', target: 'man', zeros: steps(100, 500, 100), reticle: 'post' },
    'UK59': { name: 'UK59 · 4x8', round: '57N323S (PKM, UK59)', group: 'Rifles and machine guns', target: 'man', zeros: steps(100, 1000, 100), reticle: 'uk59' },
    'NSV': { name: 'NSV · SPP', round: 'B32 (NSV)', group: 'Heavy and vehicle guns', target: 'lav', zeros: steps(400, 2000, 100), reticle: 'spp', mils: 0.06 },
    'BTR-70 KPVT': { name: 'BTR-70 · KPVT', round: 'BZ (KPVT)', group: 'Heavy and vehicle guns', target: 'lav', ...PP61, axis: 525.5, side: 'left',
      // [range, row, 1 = a long, labelled line]
      lines: [[400, 531.5, 1], [600, 544.5], [800, 560, 1], [1000, 581], [1200, 600.5, 1], [1400, 623], [1600, 651.5, 1], [1800, 687], [2000, 727.5, 1]] },
    'BTR-70 PKT': { name: 'BTR-70 · PKT', round: '57N323S (PKT)', group: 'Heavy and vehicle guns', target: 'lav', ...PP61, axis: 524, side: 'right',
      lines: [[200, 539], [400, 556.5, 1], [600, 578], [800, 612, 1], [1000, 654], [1200, 718, 1], [1400, 791.5], [1500, 837, 1]] },
    'LAV-25 M242 HE': { name: 'LAV-25 · M242 HEI-T', round: 'M792 HEI-T (M242)', group: 'Heavy and vehicle guns', target: 'btr', ...LAV25, axis: 378, side: 'left',
      lines: [[600, 511.5, 1], [1000, 567.5, 1], [1200, 608.5, 1], [1400, 652.5, 1], [1600, 705.5, 1], [1800, 773.5, 1], [2000, 859.5, 1], [2200, 941.5, 1]] },
    'LAV-25 M242 AP': { name: 'LAV-25 · M242 APDS-T', round: 'M791 APDS-T (M242)', group: 'Heavy and vehicle guns', target: 'btr', ...LAV25, axis: 428.5, side: 'right',
      lines: [[1000, 511.5, 1], [1900, 567.5, 1], [2400, 608.5, 1], [2900, 652.5, 1], [3400, 705.5, 1]] },
  };
  // The BRDM-2's turret is the BTR-70's (BRDM2_turret.et inherits BTR70_Turret.et): same guns, same PP-61 sight
  SCOPES['BRDM-2 KPVT'] = { ...SCOPES['BTR-70 KPVT'], name: 'BRDM-2 · KPVT' };
  SCOPES['BRDM-2 PKT'] = { ...SCOPES['BTR-70 PKT'], name: 'BRDM-2 · PKT' };
  const GUN_CHOICES = Object.entries(SCOPES).map(([k, g]) => [k, g.round]);
  const tableOf = r => (ROCKETS && ROCKETS.rockets[r]) || (BULLETS && BULLETS.rounds[r]) || null;
  const rocketName = (l, r) => SCOPES[l] ? SCOPES[l].name : l === r ? (l === 'M72A3' ? 'M72A3 LAW' : l) : `${l} ${r}`;
  const ROCKET_MIN_E = -15, ROCKET_MAX_E = 25; // degrees: a little past the tested elevations, the nearest one turned to fit

  // The still-air flight at elevation e (deg), between the two test elevations around it: interpolated in each flight's own
  // launch frame (distance along the launch line, drop below it), which hardly changes with elevation, then turned to e.
  // Past the end ones, the end flight is turned (closer to the game than carrying the interpolation on).
  function rocketFlight(R, e) {
    const el = R.elevs;
    let i = el.findIndex((x, k) => k < el.length - 1 && e <= el[k + 1]);
    if (i < 0) i = el.length - 2;
    const f = Math.min(Math.max((e - el[i]) / (el[i + 1] - el[i]), 0), 1), rad = Math.PI / 180;
    const ca = Math.cos(el[i] * rad), sa = Math.sin(el[i] * rad), cb = Math.cos(el[i + 1] * rad), sb = Math.sin(el[i + 1] * rad);
    const c = Math.cos(e * rad), s = Math.sin(e * rad);
    return R.calm[i].map(([x0, y0], k) => {
      const [x1, y1] = R.calm[i + 1][k];
      const u = (x0 * ca + y0 * sa) * (1 - f) + (x1 * cb + y1 * sb) * f, d = (x0 * sa - y0 * ca) * (1 - f) + (x1 * sb - y1 * cb) * f;
      return [u * c + d * s, u * s - d * c];
    });
  }
  // Bullets in the wind. The measured wind runs (bullets.json head/tail/cross) carry an offset along the flight that is
  // already there at the first frame, before the wind can have done anything: the windy and still-air runs weren't lined
  // up in time. Spread over the wind speed it read as metres of distance and height, so a crosswind from one side lifted
  // a shot by metres and from the other dropped it, and a head or tail wind moved the hold by metres too. Their sideways
  // drift does follow plain air drag (the lag rule, to a few cm), which is how the game flies its bullets. So a bullet's
  // wind is flown here: its drag (proportional to airspeed squared) fitted to its own still-air flight, the shot flown with
  // and without the wind, and the difference added to the measured flight.
  const RAD = Math.PI / 180, G = 9.81;
  // Positions [along, up, side] at t = i * dt (i < n) for drag k, launch speed v0, elevation e (deg) and air moving at
  // W = [along, up, side] m/s; midpoint steps, sub of them per sample.
  function flyDrag(k, v0, e, W, dt, n, sub) {
    const h = dt / sub, out = [[0, 0, 0]];
    let x = 0, y = 0, z = 0, vx = v0 * Math.cos(e * RAD), vy = v0 * Math.sin(e * RAD), vz = 0;
    const acc = (ax, ay, az) => {
      const ux = ax - W[0], uy = ay - W[1], uz = az - W[2], u = Math.hypot(ux, uy, uz);
      return [-k * u * ux, -k * u * uy - G, -k * u * uz];
    };
    for (let i = 1; i < n; i++) {
      for (let s = 0; s < sub; s++) {
        const a1 = acc(vx, vy, vz), mx = vx + a1[0] * h / 2, my = vy + a1[1] * h / 2, mz = vz + a1[2] * h / 2, a2 = acc(mx, my, mz);
        x += mx * h; y += my * h; z += mz * h;
        vx += a2[0] * h; vy += a2[1] * h; vz += a2[2] * h;
      }
      out.push([x, y, z]);
    }
    return out;
  }
  // A round's drag, fitted (golden section on log k) to its still-air flight at the elevation nearest level.
  function bulletDrag(R) {
    if (R.drag) return R.drag;
    const i0 = R.elevs.reduce((b, e, i) => Math.abs(e) < Math.abs(R.elevs[b]) ? i : b, 0), meas = R.calm[i0], n = meas.length;
    const err = lk => flyDrag(Math.exp(lk), R.v0, R.elevs[i0], [0, 0, 0], R.dt, n, 4)
      .reduce((s, [x, y], i) => s + (x - meas[i][0]) ** 2 + (y - meas[i][1]) ** 2, 0);
    let a = Math.log(1e-6), b = Math.log(1e-2);
    const r = (Math.sqrt(5) - 1) / 2;
    let c = b - r * (b - a), d = a + r * (b - a), fc = err(c), fd = err(d);
    for (let it = 0; it < 60; it++) {
      if (fc < fd) { b = d; d = c; fd = fc; c = b - r * (b - a); fc = err(c); } else { a = c; c = d; fc = fd; d = a + r * (b - a); fd = err(d); }
    }
    return (R.drag = Math.exp((a + b) / 2));
  }
  // What the wind adds to a bullet's flight at elevation e: [along, up, side] per sample (side + = right).
  function bulletWind(R, e, w) {
    const key = `${e.toFixed(4)}|${w.along.toFixed(3)}|${w.fromRight.toFixed(3)}`;
    R.windCache ??= new Map();
    let off = R.windCache.get(key);
    if (!off) {
      const k = bulletDrag(R), n = R.calm[0].length;
      const still = flyDrag(k, R.v0, e, [0, 0, 0], R.dt, n, 5), windy = flyDrag(k, R.v0, e, [w.along, 0, -w.fromRight], R.dt, n, 5);
      off = windy.map((p, i) => [p[0] - still[i][0], p[1] - still[i][1], p[2] - still[i][2]]);
      if (R.windCache.size > 400) R.windCache.clear();
      R.windCache.set(key, off);
    }
    return off;
  }
  // What the wind does to a rocket fired at elevation e, every dt: [along, up, side] (side + = right), from rockets.json's
  // `winds` (rocketfit.wind_runs): every test wind flown on its own, per elevation, as far as the shortest flight went.
  // The crosswind part comes from the runs from that side (right or left; with only one side flown, the other is its
  // mirror) and the along part from the head or tail runs. Each is blended between the two wind speeds flown around this
  // one (still air counting as 0 m/s), and between the two elevations around e; past the strongest wind flown it grows
  // in step with the speed. The two parts are added (rockettest.py check fires random winds from every side, both together).
  function rocketWind(R, e, w) {
    const key = `${e.toFixed(4)}|${w.along.toFixed(3)}|${w.fromRight.toFixed(3)}`;
    R.windCache ??= new Map();
    let off = R.windCache.get(key);
    if (off) return off;
    const el = R.elevs;
    let i = el.findIndex((x, k) => k < el.length - 1 && e <= el[k + 1]);
    if (i < 0) i = el.length - 2;
    const f = Math.min(Math.max((e - el[i]) / (el[i + 1] - el[i]), 0), 1), n = R.windLen;
    // one run at elevation e: its rows (an elevation the run didn't fly takes the other one)
    const atElev = run => {
      const a = run.d[i] || run.d[i + 1], b = run.d[i + 1] || run.d[i];
      return k => a[k].map((v, c) => v + (b[k][c] - v) * f);
    };
    const part = (from, mirror, s) => {
      if (!(s > 0)) return null;
      let runs = R.winds.filter(r => r.from === from), flip = 1;
      if (!runs.length && mirror) { runs = R.winds.filter(r => r.from === mirror); flip = -1; }
      if (!runs.length) return null;
      runs = runs.slice().sort((a, b) => a.speed - b.speed);
      const hi = runs.find(r => r.speed >= s), lo = [...runs].reverse().find(r => r.speed < s);
      const sideFlip = v => v.map((x, c) => (c === 2 ? x * flip : x));
      if (!hi) { const top = runs.at(-1), g = atElev(top), q = s / top.speed; return k => sideFlip(g(k)).map(x => x * q); }
      const gh = atElev(hi);
      if (!lo) { const q = s / hi.speed; return k => sideFlip(gh(k)).map(x => x * q); } // between still air and the lightest wind
      const gl = atElev(lo), q = (s - lo.speed) / (hi.speed - lo.speed);
      return k => sideFlip(gl(k).map((v, c) => v + (gh(k)[c] - v) * q));
    };
    const cross = w.fromRight >= 0 ? part('right', 'left', w.fromRight) : part('left', 'right', -w.fromRight);
    const along = w.along >= 0 ? part('tail', null, w.along) : part('head', null, -w.along);
    off = Array.from({ length: n }, (_, k) => {
      const a = cross ? cross(k) : [0, 0, 0], b = along ? along(k) : [0, 0, 0];
      return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
    });
    if (R.windCache.size > 400) R.windCache.clear();
    R.windCache.set(key, off);
    return off;
  }
  // Where a shot at elevation e is when it has come D m: {up, side (m, + = right), t (s)}, with the wind (w: m/s of tail or
  // head wind and of crosswind from the right), or null if the rocket blows up before it gets there.
  // A rocket's wind comes from its measured runs (rocketWind). A rocket in the wind can only be flown as far as its wind
  // runs go (rocketPrep); a rocket is never flown past the moment it blows up.
  function rocketAt(R, e, w, D) {
    const pts = rocketFlight(R, e), windy = !!(w.along || w.fromRight);
    let at, n = pts.length; // at(k): [along, up, side, extra time] at frame k
    if (R.bullet) {
      const off = windy ? bulletWind(R, e, w) : null;
      at = k => !windy ? [pts[k][0], pts[k][1], 0, 0] : [pts[k][0] + off[k][0], pts[k][1] + off[k][1], off[k][2], 0];
    } else if (R.winds && R.windBy === 'distance') {
      // measured at the same distance: the still-air flight's distance, the wind's height, side and delay
      const off = windy ? rocketWind(R, e, w) : null;
      if (windy) n = Math.min(n, off.length);
      at = k => !windy ? [pts[k][0], pts[k][1], 0, 0] : [pts[k][0], pts[k][1] + off[k][1], off[k][2], off[k][0]];
    } else if (R.winds) {
      const off = windy ? rocketWind(R, e, w) : null;
      if (windy) n = Math.min(n, off.length);
      at = k => !windy ? [pts[k][0], pts[k][1], 0, 0] : [pts[k][0] + off[k][0], pts[k][1] + off[k][1], off[k][2], 0];
    } else {
      // older rockets.json (one averaged table per m/s): head and tail as measured, and of the crosswind only the sideways
      // part (its along and up parts were the launch-timing offset that rocketfit now takes out)
      const lw = w.along >= 0 ? R.tail : R.head, ls = Math.abs(w.along);
      if (windy) n = Math.min(n, R.windLen);
      at = k => !windy ? [pts[k][0], pts[k][1], 0, 0] : [pts[k][0] + lw[k][0] * ls, pts[k][1] + lw[k][1] * ls, R.cross[k][2] * w.fromRight, 0];
    }
    let prev = at(0);
    for (let k = 1; k < n; k++) {
      const p = at(k);
      if (p[0] >= D) {
        const f = (D - prev[0]) / (p[0] - prev[0] || 1), t = (k - 1 + f) * R.dt + prev[3] + (p[3] - prev[3]) * f;
        if (!R.bullet && t > R.life) return null;
        return { up: prev[1] + (p[1] - prev[1]) * f, side: prev[2] + (p[2] - prev[2]) * f, t };
      }
      prev = p;
    }
    return null;
  }
  // The shot that hits D m out and H m up: elevation (deg), side drift, flight time; or {err} when it can't.
  // Elevations are tried a degree apart for bullets and a quarter of one for rockets: near a rocket's range the
  // elevations that still get there before it blows up can be under a degree wide.
  const aimStep = R => (R.bullet ? 1 : 0.25);
  function rocketAim(R, D, H, w) {
    // Up from the lowest elevation, a step at a time, to the first shot that gets there at or above the target, then
    // halved down to it. (Steeper shots cover less ground before they blow up, so past some elevation none get there.)
    const f = e => rocketAt(R, e, w, D), step = aimStep(R);
    // A launcher's range is how far its rocket can get before it blows up (rocketPrep's reach, at the best elevation,
    // where it's falling by then); at the target's own height it's less, and the message says how much
    const outOfRange = () => {
      const at = rocketRangeAt(R, H, w);
      return { err: `Out of range: it self-destructs after ${R.life.toFixed(2)} s, ` + (at > 0
        ? `${fmtDist(at)} away at the most at this height (${fmtDist(R.reach)} at its furthest, well below you)` : 'before it can climb this high') };
    };
    if (!R.bullet && D > R.reach) return outOfRange();
    let lo = null, hi = null, reached = false;
    for (let e = ROCKET_MIN_E; e <= ROCKET_MAX_E; e += step) {
      const h = f(e);
      if (h) reached = true;
      if (h && h.up >= H) { hi = e; break; }
      lo = h ? e : null;
    }
    if (hi == null) {
      if (!R.bullet && (w.along || w.fromRight) && D > R.windReach && !rocketAim(R, D, H, { along: 0, fromRight: 0 }).err)
        return { err: `In range, but its wind was only measured to ${fmtDist(R.windReach)}: solve it without wind, or move closer` };
      if (!R.bullet) return outOfRange();
      if (reached) return { err: 'Too far above you to reach' };
      const far = fmtDist(rocketFlight(R, 0).at(-1)[0]);
      return { err: `Further than the measured flights go (${R.life.toFixed(0)} s, about ${far} on level ground)` };
    }
    if (lo == null) return hi === ROCKET_MIN_E ? { err: 'Too steeply below you' } : { e: hi, ...f(hi) };
    for (let n = 0; n < 30; n++) {
      const m = (lo + hi) / 2, h = f(m);
      if (h && h.up >= H) hi = m; else lo = m;
    }
    return { e: hi, ...f(hi) };
  }
  // How far a rocket reaches before it blows up at H m above the launcher, in the wind w: the furthest distance a shot
  // still gets to (halved down to 1 m), or 0 when it can't climb that high at all.
  // (Close in, a high target can't be reached either, so it steps in from the far end to the first distance that can,
  // then halves out from there.)
  function rocketRangeAt(R, H, w) {
    const step = aimStep(R), ok = D => { for (let e = ROCKET_MIN_E; e <= ROCKET_MAX_E; e += step) { const h = rocketAt(R, e, w, D); if (h && h.up >= H) return true; } return false; };
    let hi = R.reach, lo = hi - 10;
    while (lo > 0 && !ok(lo)) { hi = lo; lo -= 10; }
    if (lo <= 0) return 0;
    while (hi - lo > 1) { const m = (lo + hi) / 2; if (ok(m)) lo = m; else hi = m; }
    return lo;
  }
  // The sight's marks for this weapon and round: [[range m, bore angle above the line of sight, deg]], nearest first.
  // A turret scope's marks are its zeroing ranges, at the angle that puts a level shot on that range (what the game
  // zeroes the reticle centre for); a range-line sight's are its lines, as measured off its reticle.
  const zeroCache = new Map();
  function rocketMarks(l, r, s) {
    const g = SCOPES[l];
    if (g && g.lines) return g.lines.map(([R, row]) => [R, (row - g.axis) / g.pxdeg]);
    if (g) {
      const key = `${l}|${r}`;
      if (!zeroCache.has(key)) {
        const T = tableOf(r);
        zeroCache.set(key, g.zeros.map(R => { const a = rocketAim(T, R, 0, { along: 0, fromRight: 0 }); return a.err ? null : [R, a.e]; }).filter(Boolean));
      }
      return zeroCache.get(key);
    }
    const L_ = ROCKETS.launchers[l], m = s === 'pgo7' && L_.sights.pgo7 ? L_.sights.pgo7[r] : L_.sights.iron;
    return Object.entries(m).map(([k, a]) => [+k, a]).sort((a, b) => a[0] - b[0]);
  }
  // What a gun's shot is aimed at: a man's chest, or a vehicle's hull (m above the ground), and its outline
  const GUN_TARGET_H = { man: 1.2, lav: 1.3, btr: 1.2 };
  function rocketSolve(it) {
    const { l, r, s } = it.rocket, R = tableOf(r), g = SCOPES[l];
    if (!R || !hasGround()) return null;
    const D = dist(it.from, it.to), az = bearing(it.from, it.to);
    const h2 = g ? GUN_TARGET_H[g.target] : (it.h2 ?? 1);
    const H = ground(it.to) + h2 - ground(it.from) - (it.h1 ?? 1.6);
    const { along, across } = windParts(it.wind, az), w = { along, fromRight: -across }; // across + = blowing to the right
    const sol = rocketAim(R, D, H, w);
    if (sol.err) return { D, H, az, ...sol };
    const calm = it.wind && it.wind.s > 0 ? rocketAim(R, D, H, { along: 0, fromRight: 0 }) : null;
    const spawn = g ? 0 : ROCKETS.launchers[l].spawn;
    const need = sol.e - spawn - Math.atan2(H, D) * 180 / Math.PI; // bore above the line of sight
    const marks = rocketMarks(l, r, s);
    const mark = marks.reduce((b, m) => Math.abs(m[1] - need) < Math.abs(b[1] - need) ? m : b);
    // the range the sight would need for this angle, along its marks (straight on past the end ones)
    let k = marks.findIndex(m => m[1] >= need);
    k = k <= 0 ? (k === 0 ? 0 : marks.length - 2) : k - 1;
    const [a, b] = [marks[k], marks[Math.min(k + 1, marks.length - 1)]];
    const equiv = b[1] !== a[1] ? a[0] + (need - a[1]) * (b[0] - a[0]) / (b[1] - a[1]) : a[0];
    const hold = D * Math.tan((need - mark[1]) * Math.PI / 180); // m above the target to put the mark
    const aimOff = -Math.atan2(sol.side, D) * 180 / Math.PI; // deg, + = aim right of the target
    const past = need > marks.at(-1)[1] ? 1 : need < marks[0][1] ? -1 : 0; // beyond the sight's marks
    // the same mark held for still air: what the wind adds to the hold is the difference (and all of the aim-off)
    const holdCalm = calm && !calm.err ? D * Math.tan((calm.e - spawn - Math.atan2(H, D) * 180 / Math.PI - mark[1]) * Math.PI / 180) : null;
    return { D, H, h2, az, sol, need, mark, equiv, past, hold, holdCalm, aimOff, aim: (az + aimOff + 360) % 360, calm, R, g,
      upwind: sol.side * w.fromRight > 0, along, across };
  }
  // What you see in the sights: the target at its real size for its distance, and where the sight's mark (iron sights:
  // the front sight's tip; PGO-7: the chosen range line where it meets the centre line) has to sit. Angles throughout,
  // so the hold and aim-off sit where they really are against the target; the view is zoomed to fit both.
  const SIGHT_TARGETS = { // target outlines in m (x across, y up from its ground), keyed by the target height picked
    0.5: { name: 'prone soldier', h: 0.45, parts: [['rect', -0.9, 0, 1.6, 0.35], ['circle', 0.85, 0.2, 0.13]] },
    1: { name: 'vehicle', h: 2.9, parts: [['rect', -3.6, 0.45, 7.2, 1.75], ['rect', -1.1, 2.2, 2.4, 0.7], ['rect', 1.1, 2.45, 2.3, 0.12],
      ['circle', -2.6, 0.5, 0.5], ['circle', -0.9, 0.5, 0.5], ['circle', 0.9, 0.5, 0.5], ['circle', 2.6, 0.5, 0.5]] },
    1.6: { name: 'standing soldier', h: 1.8, parts: [['rect', -0.22, 0, 0.44, 1.5], ['circle', 0, 1.62, 0.13]] },
  };
  SIGHT_TARGETS[2.2] = SIGHT_TARGETS[1];
  // What a gun's shot is drawn against: a man for the infantry weapons, a LAV-25 for the NSV, BTR-70 and BRDM-2 (what
  // they'd be shooting at), a BTR-70 for the LAV-25. Side-on outlines, to scale.
  const GUN_TARGETS = {
    man: SIGHT_TARGETS[1.6],
    lav: { name: 'LAV-25', h: 2.75, parts: [['rect', -3.2, 0.5, 6.4, 1.55], ['rect', -2.4, 2.05, 4.6, 0.2], ['rect', -0.5, 2.1, 1.8, 0.65],
      ['rect', 1.3, 2.42, 2.2, 0.09], ['circle', -2.5, 0.52, 0.52], ['circle', -1.2, 0.52, 0.52], ['circle', 0.9, 0.52, 0.52], ['circle', 2.2, 0.52, 0.52]] },
    btr: { name: 'BTR-70', h: 2.3, parts: [['rect', -3.7, 0.55, 7.4, 1.2], ['rect', -3.0, 1.75, 6.0, 0.3], ['rect', -0.3, 2.0, 1.0, 0.45],
      ['rect', 0.7, 2.18, 1.6, 0.08], ['circle', -2.8, 0.5, 0.5], ['circle', -1.4, 0.5, 0.5], ['circle', 1.4, 0.5, 0.5], ['circle', 2.8, 0.5, 0.5]] },
  };
  // A gun's reticle, in degrees from its aim point (measured off the game's reticle textures; see SCOPES): ox,oy the
  // aim point in px, k px per degree, sel the chosen line's angle (range-line sights). Returns SVG.
  function gunReticle(g, ox, oy, k, sel) {
    const W1 = '#e8eef3', P = (d, w = 1.1, c = W1) => `<path d="${d}" stroke="${c}" stroke-width="${w}" fill="none"/>`;
    const X = d => (ox + d * k).toFixed(1), Y = d => (oy + d * k).toFixed(1); // + = right / down
    const chev = (dy, hw = 0.032, hh = 0.059, c = W1) => P(`M${X(-hw)} ${Y(dy + hh)}L${X(0)} ${Y(dy)}L${X(hw)} ${Y(dy + hh)}`, 1.3, c);
    let s = '';
    if (g.reticle === 'pso1' || g.reticle === 'spp') {
      // the side scale: a tick every thousandth (0.06°) to 10 each side, every fifth long; lines beyond; the chevron
      s += P(`M${X(-1.92)} ${Y(0)}H${X(-0.73)}M${X(0.73)} ${Y(0)}H${X(1.92)}`);
      for (let i = -10; i <= 10; i++) if (i) s += P(`M${X(i * 0.06)} ${Y(0)}V${Y(i % 5 ? 0.059 : 0.118)}`, 0.9);
      s += chev(0, 0.032, 0.059, '#ffd43b');
      if (g.reticle === 'pso1') [0.205, 0.438, 0.691].forEach(d => s += chev(d));
      s += P(`M${X(0)} ${Y(g.reticle === 'pso1' ? 0.78 : 1.27)}V${Y(4)}`);
    } else if (g.reticle === 'cross') {
      s += P(`M${X(-3)} ${Y(0)}H${X(3)}M${X(0)} ${Y(-3)}V${Y(3)}`, 0.8, '#ffd43b');
      s += P(`M${X(-3)} ${Y(0)}H${X(-0.37)}M${X(0.37)} ${Y(0)}H${X(3)}M${X(0)} ${Y(-3)}V${Y(-0.34)}M${X(0)} ${Y(0.34)}V${Y(3)}`, 3);
    } else if (g.reticle === 'art2') {
      s += P(`M${X(-3)} ${Y(0)}H${X(3)}M${X(0)} ${Y(-3)}V${Y(3)}`, 0.8, '#ffd43b');
      s += P(`M${X(-3)} ${Y(0)}H${X(-0.76)}M${X(0.76)} ${Y(0)}H${X(3)}M${X(0)} ${Y(0.68)}V${Y(3)}`, 3);
    } else if (g.reticle === 'uk59') {
      s += P(`M${X(-3)} ${Y(0)}H${X(-0.34)}M${X(0.34)} ${Y(0)}H${X(3)}M${X(0)} ${Y(-3)}V${Y(-0.33)}M${X(0)} ${Y(0.49)}V${Y(3)}`, 1);
      s += chev(0, 0.125, 0.18, '#ffd43b');
    } else if (g.reticle === 'post') {
      // the 1P29's post, coming down from the top to a point: the point is the aim
      s += `<path d="M${X(-0.13)} ${Y(-4)}V${Y(-0.3)}L${X(0)} ${Y(0)}L${X(0.13)} ${Y(-0.3)}V${Y(-4)}" fill="rgba(255,212,59,.25)" stroke="#ffd43b" stroke-width="1.2"/>`;
    } else if (g.lines) {
      // range lines below the aim mark (PP-61: KPVT left, PKT right; LAV-25: HE left, AP right), the chosen one in yellow,
      // labelled in hundreds of metres
      const sx = g.side === 'left' ? -1 : 1;
      // (the aim mark and the scale above it sit at the texture's centre, which needn't be the bore's row)
      const long = g.reticle === 'pp61' ? 0.96 : 1.12, inner = g.reticle === 'pp61' ? 0 : 0.85, c = (g.centre - g.axis) / g.pxdeg;
      s += chev(c, 0.04, 0.06);
      s += P(`M${X(0)} ${Y(c)}V${Y((g.lines.at(-1)[1] - g.axis) / g.pxdeg + 0.05)}`);
      if (g.reticle === 'pp61') for (let i = -12; i <= 12; i++) s += P(`M${X(i * 0.06)} ${Y(c - 0.21)}V${Y(c - 0.21 - (i % 5 ? 0.04 : 0.08))}`, 0.8);
      else s += P(`M${X(-0.19)} ${Y(c - 0.155)}H${X(0.19)}M${X(0)} ${Y(c - 0.155)}V${Y(c - 0.4)}`);
      g.lines.forEach(([R, row, big]) => {
        const a = (row - g.axis) / g.pxdeg, on = Math.abs(a - sel) < 1e-6;
        const len = big ? long : inner + (long - inner) / 2;
        s += P(`M${X(sx * inner)} ${Y(a)}H${X(sx * len)}`, on ? 2 : 1, on ? '#ffd43b' : W1);
        if (big || on) s += `<text x="${X(sx * (len + 0.04))}" y="${(+Y(a) + 3).toFixed(1)}" fill="${on ? '#ffd43b' : W1}" font-size="9" font-family="var(--mono)"${sx < 0 ? ' text-anchor="end"' : ''}>${R / 100}</text>`;
      });
    }
    return s;
  }
  function sightPicture(x, it) {
    const { l, r, s } = it.rocket, pgo = s === 'pgo7' && l === 'RPG-7', g = x.g;
    const D = x.D, deg = m => Math.atan2(m, D) * 180 / Math.PI;
    const T = g ? GUN_TARGETS[g.target] : SIGHT_TARGETS[it.h2 ?? 1] || SIGHT_TARGETS[1], h2 = x.h2;
    const ax = deg(D * Math.tan(x.aimOff * Math.PI / 180)), ay = deg(h2) + deg(x.hold); // the mark's place, deg
    const cy0 = x.holdCalm != null ? deg(h2) + deg(x.holdCalm) : null; // where it would go in still air (straight above)
    // the view: target and both aim points, padded; never closer than a few target heights; a reticle with marks or
    // lines is shown far enough to see them
    const lineSpan = g && g.lines ? (g.lines.at(-1)[1] - Math.min(g.centre, g.lines[0][1])) / g.pxdeg : 0;
    const minH = pgo ? 3.4 : g ? Math.max(deg(T.h) * 3, g.lines ? lineSpan + 0.5 : g.reticle === 'pso1' ? 1.1 : 0.5) : Math.max(deg(T.h) * 4, 0.6);
    const reticleTop = g && g.lines ? ay + x.mark[1] - (g.centre - g.axis) / g.pxdeg + 0.45 : ay;
    const lo = Math.min(0, ay, cy0 ?? ay) - (pgo ? 0.3 : 0), hi = Math.max(deg(T.h), ay, reticleTop, cy0 ?? ay) + (pgo ? 0.3 : 0);
    // (the PGO-7 view is as wide as the reticle's lateral scale, ±3°, plus its range numbers, and centred on it; a gun's
    // reticle is centred too)
    const spanY = Math.max(minH, (hi - lo) * 1.5);
    const spanX = pgo ? Math.max(7.4, Math.abs(ax) * 2 + 7.4)
      : g ? Math.max(spanY * 1.45, Math.abs(ax) * 2 + (g.lines ? 2.8 : 1.4)) : Math.max(spanY * 1.45, Math.abs(ax) * 2.6 + deg(8));
    const W = 280, H = Math.round(W * spanY / spanX), k = W / spanX;
    const cx = W / 2 - (pgo || g ? ax : ax / 2) * k, cy = H / 2 + ((lo + hi) / 2) * k;
    const X = d => (cx + d * k).toFixed(1), Y = d => (cy - d * k).toFixed(1);
    const m2d = deg; // metres at the target to degrees
    let svg = `<rect width="${W}" height="${H}" fill="#1b2630"/><rect x="0" y="${Y(0)}" width="${W}" height="${Math.max(0, H - +Y(0))}" fill="#2c3a24"/>`;
    svg += `<g fill="#0b0f12" stroke="#c9d1d9" stroke-width="0.6">` + T.parts.map(([kind, a, b, c, d]) => kind === 'rect'
      ? `<rect x="${X(m2d(a))}" y="${Y(m2d(b + d))}" width="${(m2d(c) * k).toFixed(1)}" height="${(m2d(d) * k).toFixed(1)}"/>`
      : `<circle cx="${X(m2d(a))}" cy="${Y(m2d(b))}" r="${Math.max(0.8, m2d(c) * k).toFixed(1)}"/>`).join('') + '</g>';
    svg += `<circle cx="${X(0)}" cy="${Y(deg(h2))}" r="2" fill="#ff6b6b"/>`; // the point being hit
    const ox = +X(ax), oy = +Y(ay), Y0 = oy; // the mark goes here
    if (pgo) {
      // the PGO-7's reticle, its cross being the bore; the chosen line's centre on the aim point
      const P = ROCKETS.launchers['RPG-7'].sights.pgo7, top = Object.values(P['PG-7VM']), low = Object.values(P['PG-7VR']);
      const cross = Y0 - x.mark[1] * k, gy = a => (cross + a * k).toFixed(1), gx = u => (ox + u * ROCKETS.pgo7_lead_deg * k).toFixed(1);
      const sel = x.mark[1];
      svg += '<g stroke="#e8eef3" stroke-width="1" fill="none">';
      svg += `<path d="M${(ox - 6).toFixed(1)} ${cross.toFixed(1)}h12M${ox.toFixed(1)} ${(cross - 6).toFixed(1)}v12"/>`;
      top.forEach(a => svg += `<path d="M${gx(-5)} ${gy(a)}H${gx(5)}"${Math.abs(a - sel) < 1e-6 ? ' stroke="#ffd43b" stroke-width="2"' : ''}/>`);
      for (let u = -5; u <= 5; u++) if (u) svg += `<path d="M${gx(u)} ${gy(top[0])}V${gy(top[top.length - 1])}"/>`;
      low.forEach(a => svg += `<path d="M${gx(-5)} ${gy(a)}H${gx(5)}"${Math.abs(a - sel) < 1e-6 ? ' stroke="#ffd43b" stroke-width="2"' : ''}/>`);
      svg += `<path d="M${(ox - 1.5).toFixed(1)} ${gy(top[0] - 0.05)}V${gy(low[low.length - 1] + 0.1)}M${(ox + 1.5).toFixed(1)} ${gy(top[0] - 0.05)}V${gy(low[low.length - 1] + 0.1)}"/>`;
      svg += '</g><g fill="#e8eef3" font-size="9" font-family="var(--mono)">';
      Object.keys(P['PG-7VM']).forEach((m, i) => svg += `<text x="${(+gx(-5) - 3).toFixed(1)}" y="${(+gy(top[i]) + 3).toFixed(1)}" text-anchor="end">${+m / 100}</text>`);
      Object.keys(P['PG-7VL']).forEach((m, i) => svg += `<text x="${(+gx(5) + 3).toFixed(1)}" y="${(+gy(top[i]) + 3).toFixed(1)}">${String(+m / 100).replace('.', ',')}</text>`);
      Object.keys(P['PG-7VR']).forEach((m, i) => svg += `<text x="${(ox - 5).toFixed(1)}" y="${(+gy(low[i]) - 2).toFixed(1)}" text-anchor="end">${String(+m / 100).replace('.', ',')}</text>`);
      svg += '</g>';
    } else if (g) {
      // the gun's reticle: a turret scope's centre on the aim point; a range-line sight's chosen line there, its aim
      // mark above it by that line's angle
      svg += gunReticle(g, ox, g.lines ? Y0 - x.mark[1] * k : Y0, k, x.mark[1]);
    } else if (l === 'M72A3') {
      // rear peep and front cross-hair, centred on the aim point (see-through, so the target stays in view)
      svg += `<circle cx="${ox}" cy="${oy}" r="26" fill="none" stroke="#e8eef3" stroke-width="1.2" opacity="0.7"/>` +
        `<g stroke="#ffd43b" stroke-width="1.4"><path d="M${ox - 12} ${oy}h24M${ox} ${oy - 12}v24"/></g>`;
    } else {
      // rear notch and front post, drawn as outlines so the target stays in view: the post's tip on the aim point
      svg += `<path d="M${ox - 30} ${H}V${oy + 10}H${ox - 9}l3 -7h12l3 7H${ox + 30}V${H}" fill="none" stroke="#e8eef3" stroke-width="1.2" opacity="0.7"/>` +
        `<path d="M${ox - 2.5} ${H}V${oy}h5V${H}" fill="rgba(255,212,59,.25)" stroke="#ffd43b" stroke-width="1.2"/>`;
    }
    // the wind's share of the hold: a dashed ring where the mark would go in still air, an arrow from the aim point to
    // the red dot (where the round comes down with this wind), and in the corner which way the wind crosses the shot and
    // how hard
    let windTxt = '';
    if (cy0 != null) {
      const gx0 = +X(0), gy0 = +Y(cy0), rx = +X(0), ry = +Y(deg(h2)), far = Math.hypot(rx - ox, ry - oy);
      if (Math.hypot(ox - gx0, oy - gy0) > 4) svg += `<circle cx="${gx0}" cy="${gy0}" r="3.2" fill="none" stroke="#e8eef3" stroke-width="1.2" stroke-dasharray="2 1.5"/>`;
      if (far > 9) {
        const ux = (rx - ox) / far, uy = (ry - oy) / far, ex = rx - ux * 4, ey = ry - uy * 4;
        svg += `<path d="M${(ox + ux * 5).toFixed(1)} ${(oy + uy * 5).toFixed(1)}L${ex.toFixed(1)} ${ey.toFixed(1)}" stroke="#74c0fc" stroke-width="1.4"/>` +
          `<path d="M${ex.toFixed(1)} ${ey.toFixed(1)}l${(-ux * 5 - uy * 3).toFixed(1)} ${(-uy * 5 + ux * 3).toFixed(1)}M${ex.toFixed(1)} ${ey.toFixed(1)}l${(-ux * 5 + uy * 3).toFixed(1)} ${(-uy * 5 - ux * 3).toFixed(1)}" stroke="#74c0fc" stroke-width="1.4"/>`;
      }
      const ac = x.across, al = x.along, sgn = ac >= 0 ? 1 : -1;
      // bottom left, out of the way of the aim points (they sit above the target); bottom right when a range-line
      // reticle's labels are on the left
      const rt = g && g.lines && g.side === 'left', x0 = rt ? W - 50 : 0;
      if (Math.abs(ac) >= 0.5) svg += `<path d="M${x0 + (sgn > 0 ? 8 : 44)} ${H - 20}h${sgn * 36}l${-sgn * 6} -4m${sgn * 6} 4l${-sgn * 6} 4" fill="none" stroke="#74c0fc" stroke-width="1.6"/>`;
      svg += `<text x="${rt ? W - 6 : 6}" y="${H - 6}"${rt ? ' text-anchor="end"' : ''} fill="#74c0fc" font-size="10" font-family="var(--mono)">` +
        `wind ${Math.abs(ac).toFixed(1)} across · ${Math.abs(al).toFixed(1)} ${al >= 0 ? 'behind' : 'ahead'} m/s</text>`;
      const dv = x.hold - x.holdCalm, dl = D * Math.tan(x.aimOff * Math.PI / 180);
      const parts = [Math.abs(dl) >= 0.3 ? `${Math.abs(dl).toFixed(1)} m ${dl > 0 ? 'right' : 'left'}` : '',
        Math.abs(dv) >= 0.3 ? `${Math.abs(dv).toFixed(1)} m ${dv > 0 ? 'higher' : 'lower'}` : ''].filter(Boolean);
      windTxt = ` The wind (${Math.abs(ac).toFixed(1)} m/s across from your ${ac >= 0 ? 'left' : 'right'}, ${Math.abs(al).toFixed(1)} m/s ` +
        `${al >= 0 ? 'tail' : 'head'}wind) moves the hold ${parts.length ? parts.join(' and ') : 'by under 0.3 m'} from the still-air one (dashed ring); the blue arrow runs from the aim point to where the round comes down.`;
    }
    svg += `<circle cx="${ox}" cy="${oy}" r="3.2" fill="none" stroke="#ffd43b" stroke-width="1.4"/>`;
    const lat = Math.abs(D * Math.tan(x.aimOff * Math.PI / 180)), hold = Math.abs(x.hold);
    const small = g ? 0.1 : 0.4;
    const holdTxt = hold < small ? 'on' : `${hold.toFixed(1)} m (${(hold / T.h).toFixed(1)}× the ${T.name}'s height) ${x.hold > 0 ? 'above' : 'below'}`;
    const latTxt = lat < small ? '' : `, ${lat.toFixed(1)} m ${x.aimOff > 0 ? 'right' : 'left'}`;
    const gunWhat = g && (g.lines ? `the ${x.mark[0]} m ${{ pp61: { left: 'KPVT', right: 'PKT' }, lav: { left: 'HE', right: 'AP' } }[g.reticle][g.side]} line`
      : `${{ pso1: 'the top chevron', spp: 'the chevron', cross: 'the cross', art2: 'the cross', uk59: 'the chevron', post: "the post's tip" }[g.reticle]} (zeroed for ${x.mark[0]} m)`);
    const what = g ? gunWhat : pgo ? `the ${x.mark[0]} m line where it meets the centre line` : l === 'M72A3' ? `the ${x.mark[0]} m cross-hair` : `the front sight's tip (sight on ${x.mark[0]} m)`;
    const lead = pgo && lat >= 0.3 ? ` (the red dot on the ${(Math.abs(x.aimOff) / ROCKETS.pgo7_lead_deg).toFixed(1)} side mark, ${x.aimOff > 0 ? 'left' : 'right'} of centre)` : '';
    const source = g ? 'reticle drawn to scale from the game\'s own' : pgo ? 'reticle from the game\'s PGO-7' : 'sight shapes are a sketch';
    return `<div class="sight-pic"><svg viewBox="0 0 ${W} ${H}" width="100%">${svg}</svg>` +
      `<p class="sub">Put ${what} ${holdTxt} the red dot${latTxt}${lead}.${windTxt} Drawn ${Math.round(k * deg(1))} px per metre at the target; ` +
      `${source}.</p></div>`;
  }
  // A rocket's measured flights, made ready to fly from (once, as rockets.json loads):
  // - The last frames aren't trusted where a table jumps. In older rockets.json the tables ran on while some of the
  //   flights behind them had already blown up, so the average there switched between sets of flights (the PG-7VL's
  //   last frame moved it 2 m sideways, the M72A3's head wind table stepped 0.75 m at 650 m); rocketfit now stops every
  //   table at the first flight's end, so this finds nothing in a new file. In the last tenth of the flight, everything
  //   from the first frame that bends more than a smooth flight can is dropped: the still-air flights together (0.8 m
  //   per frame; smooth flights bend up to about 0.5 m, the bad last frames 1-1.9 m), and the wind tables together
  //   (0.05 m per m/s), so a bad wind frame doesn't cost the still-air flight its end. Only the columns rocketAt reads
  //   count (of an older file's averaged crosswind table, the sideways one).
  // - Each still-air flight runs on to the moment the rocket blows up (life), a frame or two past the last good one,
  //   straight on at its last speed under gravity (under 0.1 s: drag changes it by centimetres); the wind tables too
  //   when they end with them.
  // - reach: how far it can get before it blows up, at the best elevation; windReach: how far the wind tables go;
  //   windLen: their length in frames.
  const END_JUMP = { calm: 0.8, wind: 0.05 };
  // A wind run as rockets.json stores it (rocketfit.wind_runs: per elevation, every `step` frames) turned into
  // per-elevation tables every frame: d[elevation][frame] = [dt, up, side] (a run measured at the same distance as the
  // still-air flight) or [along, up, side] (an older run, at the same time), null where the run didn't fly that
  // elevation. (rocketfit.expand_wind does the same.)
  function expandWind(R, run) {
    const { n, step } = run, ks = [...new Set([...Array.from({ length: Math.ceil(n / step) }, (_, j) => j * step), n - 1])].sort((a, b) => a - b);
    const lerp = (xs, k, c) => {
      const j = Math.min(Math.floor(k / step), ks.length - 2), k0 = ks[j], k1 = ks[j + 1], f = (k - k0) / ((k1 - k0) || 1);
      return xs[j][c] + (xs[j + 1][c] - xs[j][c]) * f;
    };
    return run.x.map(xs => (xs ? Array.from({ length: n }, (_, k) => [0, 1, 2].map(c => lerp(xs, k, c))) : null));
  }
  function rocketPrep(R) {
    (R.winds || []).forEach(run => { if (!run.d) run.d = expandWind(R, run); });
    R.windBy = (R.winds || []).some(r => r.by === 'distance') ? 'distance' : 'time';
    const trim = tables => {
      const n = tables[0][0].length;
      for (let k = Math.max(2, Math.floor(n * 0.9)); k < n; k++) {
        if (tables.some(([a, cols, lim]) => cols.some(i => Math.abs(a[k][i] - 2 * a[k - 1][i] + a[k - 2][i]) > lim))) {
          tables.forEach(([a]) => a.splice(k));
          return;
        }
      }
    };
    // [table, columns read, how much a frame may bend]; a run's table is metres in its own wind, an older file's per m/s
    const windTabs = R.winds ? R.winds.flatMap(r => r.d.filter(Boolean).map(a => [a, [0, 1, 2], END_JUMP.wind * r.speed]))
      : [[R.head, [0, 1], END_JUMP.wind], [R.tail, [0, 1], END_JUMP.wind], [R.cross, [2], END_JUMP.wind]];
    trim(R.calm.map(c => [c, [0, 1], END_JUMP.calm]));
    trim(windTabs);
    const end = Math.ceil(R.life / R.dt + 1e-9) + 1, g = 9.81 * R.dt * R.dt; // frames to the moment it blows up
    const windWithIt = R.calm[0].length - windTabs[0][0].length <= 3; // (wind tables a few frames short are carried on too)
    while (R.calm[0].length < end) R.calm.forEach(c => { const a = c.at(-1), b = c.at(-2); c.push([2 * a[0] - b[0], 2 * a[1] - b[1] - g]); });
    while (windWithIt && windTabs[0][0].length < end) windTabs.forEach(([t]) => { const a = t.at(-1), b = t.at(-2); t.push(a.map((v, i) => 2 * v - b[i])); });
    R.windLen = Math.min(...windTabs.map(([t]) => t.length));
    const along = (c, t) => { const x = t / R.dt, k = Math.min(Math.floor(x), c.length - 2), f = x - k; return c[k][0] + (c[k + 1][0] - c[k][0]) * f; };
    R.reach = Math.max(...R.calm.map(c => along(c, R.life)));
    R.windReach = Math.max(...R.calm.map(c => along(c, Math.min(R.life, (R.windLen - 1) * R.dt))));
    return R;
  }
  return {
    ROCKET_CHOICES, ROCKET_AIM, SCOPES, GUN_CHOICES, GUN_TARGET_H, SIGHT_TARGETS, GUN_TARGETS,
    tableOf, rocketName, rocketFlight, rocketAt, rocketWind, rocketAim, rocketMarks, rocketSolve, gunReticle, sightPicture,
    get rockets() { return ROCKETS; },
    get bullets() { return BULLETS; },
    setRockets(d) { Object.values(d.rockets).forEach(rocketPrep); ROCKETS = d; },
    setBullets(d) { Object.values(d.rounds).forEach(R => { R.bullet = true; }); BULLETS = d; zeroCache.clear(); },
  };
};

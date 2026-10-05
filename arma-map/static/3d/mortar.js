// Shared mortar physics for the field map, workbench and 3D view.
// Terrain and roof heights are supplied by each page; firing tables are /data/mortar-tables.json.
'use strict';

const Mortar = (() => {
  const GRAV = 9.81;
  // How each shell flies (see the field map): muzzle speed, drag (AirDrag / Mass) and each charge ring's speed multiplier.
  const SHELL_PHYS = {
    'M252|HE M821': { v0: 66, k: 0.000462 / 4.06, rings: { 0: 1, 1: 1.531, 2: 2.085, 3: 2.541, 4: 2.977 } },
    'M252|Practice M879': { v0: 66, k: 0.000469 / 4.26, rings: { 0: 1, 1: 1.573, 2: 2.082, 3: 2.532, 4: 2.932 } },
    'M252|Smoke M819': { v0: 137, k: 0.0009139 / 4.85, rings: { 1: 0.666, 2: 0.959, 3: 1.184, 4: 1.387 } },
    'M252|Illumination M853A1': { v0: 152, k: 0.001488 / 4, rings: { 1: 0.638, 2: 1, 3: 1.281, 4: 1.596 } },
    '2B14|HE O-832DU': { v0: 76, k: 0.000615 / 3.1, rings: { 0: 1, 1: 1.321, 2: 1.736, 3: 2.087, 4: 2.455 } },
    '2B14|Smoke D-832DU': { v0: 71, k: 0.000655 / 3.48, rings: { 0: 1, 1: 1.339, 2: 1.748, 3: 2.086 } },
    '2B14|Illumination S-832C': { v0: 127, k: 0.001836 / 3.51, rings: { 1: 0.698, 2: 1.111, 3: 1.512, 4: 2.154 } },
  };
  const MUZZLE_H = 1.3;          // the shell leaves the barrel this high above the mortar's ground
  // the spread, measured through the game's real mortars (the field map's SPEED_SD, SPEED_BIAS and BARREL_SD)
  const SPEED_SD = 1.07;         // m/s on the base speed, one standard deviation
  const SPEED_BIAS = 0.13;       // m/s on the base speed: the game's launch speeds average this much above the shell's
  const MIL = 2 * Math.PI / 6400;
  const BARREL_SD = { M252: [3.09 * MIL, 4.19 * MIL], '2B14': [3.90 * MIL, 2.94 * MIL] }; // rad, sd up/down and sideways
  const P90 = 2.146;             // an ellipse this many standard deviations across holds 90% of the rounds
  const ringSpeed = (phys, coef) => (phys.v0 + SPEED_BIAS) * coef;

  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const bearing = (a, b) => ((Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI) + 360) % 360;

  // One shot at `ang` radians, muzzle speed v: where it comes down dh m above the mortar, with the wind along / across
  // the line of fire. {range, drift, tof}, or null when it never gets that high. path: collects [range, height] each step.
  function flight(v, k, ang, dh, along = 0, across = 0, path = null) {
    const dt = 0.1;
    let x = 0, y = 0, z = 0, vx = 0, vy = v * Math.sin(ang), vz = v * Math.cos(ang), t = 0;
    const acc = (ux, uy, uz) => {
      const rx = ux - across, rz = uz - along, s = Math.sqrt(rx * rx + uy * uy + rz * rz);
      return [-k * s * rx, -GRAV - k * s * uy, -k * s * rz];
    };
    for (;;) {
      const a1 = acc(vx, vy, vz);
      const a2 = acc(vx + a1[0] * dt / 2, vy + a1[1] * dt / 2, vz + a1[2] * dt / 2);
      const a3 = acc(vx + a2[0] * dt / 2, vy + a2[1] * dt / 2, vz + a2[2] * dt / 2);
      const a4 = acc(vx + a3[0] * dt, vy + a3[1] * dt, vz + a3[2] * dt);
      const py = y, px = x, pz = z;
      x += dt * (vx + dt / 6 * (a1[0] + a2[0] + a3[0]));
      y += dt * (vy + dt / 6 * (a1[1] + a2[1] + a3[1]));
      z += dt * (vz + dt / 6 * (a1[2] + a2[2] + a3[2]));
      vx += dt / 6 * (a1[0] + 2 * a2[0] + 2 * a3[0] + a4[0]);
      vy += dt / 6 * (a1[1] + 2 * a2[1] + 2 * a3[1] + a4[1]);
      vz += dt / 6 * (a1[2] + 2 * a2[2] + 2 * a3[2] + a4[2]);
      t += dt;
      if (path) path.push([z, y]);
      if (vy < 0 && y <= dh) {
        if (py < dh) return null;
        const f = (py - dh) / (py - y);
        return { range: pz + (z - pz) * f, drift: px + (x - px) * f, tof: t - dt + dt * f };
      }
      if (t > 150) return null;
    }
  }
  // The flattest shot the tube fires (45-85 degrees: LimitsVert in the game's Prefabs/Weapons/Core/Mortar_Base.et).
  const MIN_ELEV = 45 * Math.PI / 180;
  const MAX_ELEV = 85 * Math.PI / 180;
  // The high (plunging) angle that lands d m away, dh m up, in the given wind, or null if the ring can't reach (its
  // MIN_ELEV shot comes down short of it).
  const highCache = new Map();
  function highAngleFor(v, k, d, dh, along, across) {
    const key = `${v}|${k}|${Math.round(d * 2)}|${Math.round(dh * 4)}|${along.toFixed(2)}|${across.toFixed(2)}`;
    if (highCache.has(key)) return highCache.get(key);
    let lo = MIN_ELEV, hi = MAX_ELEV, res = null;
    const first = flight(v, k, lo, dh, along, across);
    const last = flight(v, k, hi, dh, along, across);
    if (first && last && first.range >= d && last.range <= d) {
      for (let i = 0; i < 22; i++) {
        const mid = (lo + hi) / 2, f = flight(v, k, mid, dh, along, across);
        if (!f || f.range < d) hi = mid; else lo = mid;
      }
      const ang = (lo + hi) / 2;
      res = { ang, ...flight(v, k, ang, dh, along, across) };
    }
    if (highCache.size > 4000) highCache.clear();
    highCache.set(key, res);
    return res;
  }
  // Wind as the crew enters it (m/s, the compass direction it blows FROM), along and across a line of fire on bearing az.
  function windParts(wind, az) {
    if (!wind || !(wind.s > 0)) return { along: 0, across: 0 };
    const toward = ((wind.d + 180) - az) * Math.PI / 180;
    return { along: wind.s * Math.cos(toward), across: wind.s * Math.sin(toward) };
  }
  // How far rounds spread (half-lengths of the 90% ellipse): long/short from the launch speed and the barrel's up/down
  // throw, sideways from its sideways throw (w: the mortar).
  function spreadOf(v, coef, k, ang, dh, along, across, d, w) {
    const f = (vv, aa) => flight(vv, k, aa, dh, along, across);
    const up = f(v + 1, ang), dn = f(v - 1, ang), hi = f(v, ang + 0.002), lo = f(v, ang - 0.002);
    if (!up || !dn || !hi || !lo) return null;
    const dRdv = (up.range - dn.range) / 2, dRda = (hi.range - lo.range) / 0.004;
    const [bUp, bSide] = BARREL_SD[w] || BARREL_SD.M252;
    const sdLong = Math.hypot(dRdv * SPEED_SD * coef, dRda * bUp);
    const sdSide = d * bSide / Math.cos(ang);
    return { long: P90 * sdLong, side: P90 * sdSide };
  }

  // Auto ring (the field map's autoRing / autoPref): ring 3 unless a ring that lands at least a third tighter reaches,
  // then the nearest ring to 3 among those; worked out once per shell on flat ground in still air every AUTO_STEP m, and
  // the nearest ring that can actually make it when that one can't.
  const AUTO_RING = 3, AUTO_SLACK = 1.5, AUTO_STEP = 10;
  const nearestRing = (rings, to) => rings.reduce((a, b) => (Math.abs(b.ring - to) < Math.abs(a.ring - to) ? b : a));
  const autoBands = new Map();
  // a ring kept for under AUTO_MIN_RUN m between two others isn't worth a charge change: the next ring out takes over
  const AUTO_MIN_RUN = 150;
  function foldShortRuns(bands, okAt) {
    for (let i = 0; i < bands.length;) {
      let j = i;
      while (j < bands.length && bands[j] === bands[i]) j++;
      if (i > 0 && j < bands.length && bands[i - 1] != null && bands[i] != null && bands[j] != null && (j - i) * AUTO_STEP < AUTO_MIN_RUN) {
        const fits = r => okAt.slice(i, j).every(ok => ok.includes(r)); // a ring that fires all along the run
        const to = fits(bands[j]) ? bands[j] : fits(bands[i - 1]) ? bands[i - 1] : null;
        if (to != null) bands.fill(to, i, j);
      }
      i = j;
    }
  }
  function autoPref(W, w, s, d) {
    const key = `${w}|${s}`;
    if (!autoBands.has(key)) {
      const rings = W.shells[s] || {}, phys = SHELL_PHYS[key], mpc = W.milsPerCircle || 6400, bands = [], okAt = [];
      const far = Math.max(...Object.values(rings).map(def => def.table[def.table.length - 1][0])) + 600;
      for (let dd = 0; dd <= far; dd += AUTO_STEP) {
        const ok = [];
        for (const [ring, def] of Object.entries(rings)) {
          const t = def.table;
          if (dd < t[0][0]) continue;
          if (!(phys && phys.rings[ring])) { if (dd <= t[t.length - 1][0]) ok.push({ ring: +ring, dispersion: def.dispersion }); continue; }
          const coef = phys.rings[ring], v = ringSpeed(phys, coef), real = highAngleFor(v, phys.k, dd, -MUZZLE_H, 0, 0);
          if (!real || real.ang < MIN_ELEV || real.ang > MAX_ELEV) continue;
          const sp = spreadOf(v, coef, phys.k, real.ang, -MUZZLE_H, 0, 0, dd, w);
          ok.push({ ring: +ring, dispersion: sp ? Math.max(sp.long, sp.side) : def.dispersion });
        }
        okAt.push(ok.map(r => r.ring));
        bands.push(ok.length ? nearestRing(ok.filter(r => r.dispersion <= Math.min(...ok.map(q => q.dispersion)) * AUTO_SLACK), AUTO_RING).ring : null);
      }
      foldShortRuns(bands, okAt);
      autoBands.set(key, bands);
    }
    const bands = autoBands.get(key), i = Math.min(Math.floor(d / AUTO_STEP), bands.length - 1); // the step at or below: a ring is never picked short of its table minimum
    return bands[i] ?? (d > bands.length * AUTO_STEP / 2 ? 9 : 0);
  }
  const autoRing = (rings, W, w, s, d) => (rings.length ? nearestRing(rings, autoPref(W, w, s, d)) : null);
  // The ring a mortar marking fires with, or null for auto (when it isn't set, or the shell hasn't that ring)
  const chargeOf = (tables, m, s = m.shell) => {
    const rings = tables && tables.weapons[m.weapon] && tables.weapons[m.weapon].shells[s];
    return Number.isInteger(m.charge) && rings && rings[m.charge] ? m.charge : null;
  };

  // Firing solution from mortar to target for every ring that can reach it; best is the ring set (charge), or on auto
  // the one autoRing picks. ground(x, z): the ground height there.
  const solved = new Map();
  function solve(tables, w, s, from, to, wind, ground, charge = null, impact = null) {
    const W = tables && tables.weapons[w], rings = W && W.shells[s];
    const target = impact ? impact(to) : { h: ground(to[0], to[1]), roof: 0 };
    const d = dist(from, to), hFrom = ground(from[0], from[1]), hTo = target.h;
    const dh = hFrom != null && hTo != null ? hTo - hFrom : 0, az = bearing(from, to);
    const key = `${w}|${s}|${from}|${to}|${wind ? `${wind.s},${wind.d}` : ''}|${hFrom}|${hTo}|${target.roof}|${charge}`;
    if (solved.has(key)) return solved.get(key);
    const mpc = W ? W.milsPerCircle : 6400;
    const out = { d, az, azMil: az * mpc / 360, hFrom, hTo, dh, roof: target.roof, mapAzMil: az * mpc / 360, wind: wind && wind.s > 0 ? wind : null, rings: [], best: null, charge: charge != null && rings && rings[charge] ? charge : null };
    if (rings) {
      const phys = SHELL_PHYS[`${w}|${s}`], { along, across } = windParts(wind, az);
      for (const [ring, def] of Object.entries(rings)) {
        // the reach comes from the model (see the field map's solve()); the table sets the shortest distance
        const t = def.table, modelled = !!(phys && phys.rings[ring]);
        if (d < t[0][0] || (!modelled && d > t[t.length - 1][0])) continue;
        let elev = 0, tof = 0, azAdj = 0, spread = null;
        if (!modelled) {
          const i = t.findIndex(row => row[0] >= d), a = t[Math.max(i - 1, 0)], b = t[i];
          const f = b[0] === a[0] ? 0 : (d - a[0]) / (b[0] - a[0]);
          const lerp = j => a[j] + (b[j] - a[j]) * f;
          elev = lerp(1) - dh * lerp(3) / 100; tof = lerp(2);
        } else {
          const coef = phys.rings[ring], v = ringSpeed(phys, coef);
          const real = highAngleFor(v, phys.k, d, dh - MUZZLE_H, along, across);
          if (!real) continue;
          elev = real.ang * mpc / (2 * Math.PI);
          tof = real.tof;
          azAdj = -Math.atan2(real.drift, d) * mpc / (2 * Math.PI);
          spread = spreadOf(v, coef, phys.k, real.ang, dh - MUZZLE_H, along, across, d, w);
        }
        if (elev < 45 * mpc / 360 || elev > 85 * mpc / 360) continue;
        out.rings.push({ ring: +ring, elev, tof, azMil: ((out.azMil + azAdj) % mpc + mpc) % mpc, azAdj,
          dispersion: spread ? Math.round(Math.max(spread.long, spread.side)) : def.dispersion,
          spread: spread && { long: Math.round(spread.long), side: Math.round(spread.side), az } });
      }
      out.rings.sort((x, y) => x.ring - y.ring);
      out.best = out.charge == null ? autoRing(out.rings, W, w, s, d) : out.rings.find(r => r.ring === out.charge) || null;
      if (out.best) out.azMil = out.best.azMil;
    }
    if (solved.size > 2000) solved.clear();
    solved.set(key, out);
    return out;
  }
  // "Ring 2 · 1203 mil · Az 812 · 21.4 s", as the field map labels a target
  const short = sol => (sol.best ? `Ring ${sol.best.ring} · ${Math.round(sol.best.elev)} mil · Az ${Math.round(sol.azMil)} · ${sol.best.tof.toFixed(1)} s`
    : sol.charge != null ? `ring ${sol.charge} can't reach` : 'out of range');
  // How far a ring reaches on bearing az over the real ground and in the wind: the furthest point its MIN_ELEV shot still
  // passes over on its way down (the field map's ringReach; ground(x, z) as for solve, the sea's surface counting as 0).
  const REACH_STEP = 5, REACH_BEARINGS = 72;
  function ringReach(v, k, from, h0, az, wind, ground, world) {
    const { along, across } = windParts(wind, az), path = [];
    flight(v, k, MIN_ELEV, -800, along, across, path);
    const sx = Math.sin(az * Math.PI / 180), sz = Math.cos(az * Math.PI / 180), muzzle = h0 + MUZZLE_H;
    const g = r => Math.max(ground(from[0] + r * sx, from[1] + r * sz), 0) - muzzle;
    const onMap = r => { const x = from[0] + r * sx, z = from[1] + r * sz; return x >= 0 && z >= 0 && x <= world && z <= world; };
    let top = 0;
    path.forEach((q, i) => { if (q[1] > path[top][1]) top = i; });
    // A low charge can hit rising terrain before its apex; the far descending intersection is unreachable then.
    for (let i = 1; i <= top; i++) {
      const [r0, y0] = path[i - 1], [r1, y1] = path[i], n = Math.max(1, Math.ceil((r1 - r0) / REACH_STEP));
      let lastR = r0, lastGap = y0 - g(r0);
      for (let j = 1; j <= n; j++) {
        const r = r0 + (r1 - r0) * j / n, y = y0 + (y1 - y0) * j / n, gap = y - g(r);
        if (!onMap(r)) return lastR;
        if (gap <= 0) return lastR + (r - lastR) * Math.max(0, lastGap / (lastGap - gap || 1));
        lastR = r; lastGap = gap;
      }
    }
    let outR = null, outY = null;
    for (let i = path.length - 1; i > top; i--) {
      const [r1, y1] = path[i], [r0, y0] = path[i - 1], n = Math.max(1, Math.ceil((r1 - r0) / REACH_STEP));
      for (let j = n; j >= 0; j--) {
        const r = r0 + (r1 - r0) * j / n, y = y0 + (y1 - y0) * j / n;
        if (onMap(r) && g(r) <= y) {
          if (outR == null) return r;
          const gIn = g(r) - y, gOut = g(outR) - outY;
          return gOut > gIn ? r + (outR - r) * Math.min(1, -gIn / (gOut - gIn)) : r;   // capped: outR can be off the map
        }
        outR = r; outY = y;
      }
    }
    return path.length ? path[top][0] : 0;
  }
  // Each ring's reach all round the mortar: with the shell's physics an outline over the ground in the mortar's wind
  // (pts, plus its shortest and longest, near / far), otherwise the table's flat circle (max); and the shortest distance
  // any ring fires (min). world: the map's size in metres.
  const reachCache = new Map();
  const invalidateTerrain = () => { reachCache.clear(); solved.clear(); };
  function reach(tables, w, s, from = null, wind = null, ground = null, world = 12800) {
    const rings = tables && tables.weapons[w] && tables.weapons[w].shells[s];
    if (!rings) return null;
    const phys = SHELL_PHYS[`${w}|${s}`];
    const key = `${w}|${s}|${from}|${wind ? `${wind.s},${wind.d}` : ''}|${world}|${!!ground}`;
    if (reachCache.has(key)) return reachCache.get(key);
    const h0 = from && ground ? Math.max(ground(from[0], from[1]), 0) : 0;
    const list = Object.entries(rings).map(([ring, def]) => {
      const r = { ring: +ring, min: def.table[0][0], max: def.table[def.table.length - 1][0] };
      if (from && ground && phys && phys.rings[ring]) {
        const v = ringSpeed(phys, phys.rings[ring]), dists = [];
        r.pts = [];
        for (let i = 0; i < REACH_BEARINGS; i++) {
          const az = i * 360 / REACH_BEARINGS, d = ringReach(v, phys.k, from, h0, az, wind, ground, world);
          dists.push(d);
          r.pts.push([from[0] + d * Math.sin(az * Math.PI / 180), from[1] + d * Math.cos(az * Math.PI / 180)]);
        }
        r.near = Math.min(...dists); r.far = r.max = Math.max(...dists);
      }
      return r;
    });
    const out = { rings: list.sort((a, b) => a.ring - b.ring), min: Math.min(...list.map(r => r.min)) };
    if (reachCache.size > 40) reachCache.clear();
    reachCache.set(key, out);
    return out;
  }
  // Auto's bands (the field map's autoBandPolys): for each stretch of distance the ring Auto uses there, as an outline all
  // round the mortar (pts) with the previous band's outline as its inner edge, and the shortest and longest of its edge.
  // A band's edge is where Auto hands over to the next ring (flat ground, still air) or where that ring runs out over the
  // ground and wind (its reach outline), whichever is nearer; the last band goes to its full reach. null without the
  // physics. rch: the reach() result.
  function autoBandPolys(tables, w, s, from, rch) {
    const W = tables && tables.weapons[w];
    if (!W || !rch || !from) return null;
    autoPref(W, w, s, 0);
    const bands = autoBands.get(`${w}|${s}`), segs = [];
    for (let i = 0; i < bands.length;) {
      let j = i;
      while (j < bands.length && bands[j] === bands[i]) j++;
      if (bands[i] != null) segs.push({ ring: bands[i], to: j * AUTO_STEP });
      i = j;
    }
    const out = [];
    let prev = null, prevRad = null;
    segs.forEach((sg, i) => {
      const o = rch.rings.find(r => r.ring === sg.ring);
      if (!o || !o.pts) return;
      const last = i === segs.length - 1;
      const rad = o.pts.map((q, k) => {
        const d = Math.hypot(q[0] - from[0], q[1] - from[1]);
        return Math.max(last ? d : Math.min(sg.to, d), prevRad ? prevRad[k] : 0);
      });
      const pts = rad.map((r, k) => { const az = k * 2 * Math.PI / rad.length; return [from[0] + r * Math.sin(az), from[1] + r * Math.cos(az)]; });
      out.push({ ring: sg.ring, pts, inner: prev, near: Math.min(...rad), far: Math.max(...rad) });
      prev = pts; prevRad = rad;
    });
    return out.length ? out : null;
  }
  // the weapon's shell of a kind (/^HE/, /^Smoke/, /^Illum/), else the one it has loaded
  const shellLike = (tables, w, re, fallback) => Object.keys((tables && tables.weapons[w] && tables.weapons[w].shells) || {}).find(s => re.test(s)) || fallback;

  function reachToward(tables, w, s, from, to, wind, ground, world, only = null) {
    const phys = SHELL_PHYS[`${w}|${s}`], rings = tables && tables.weapons[w]?.shells[s];
    if (!phys || !rings) return null;
    const h0 = Math.max(ground(from[0], from[1]) ?? 0, 0), az = bearing(from, to);
    return Math.max(...Object.keys(rings).filter(r => only == null || +r === only)
      .map(r => phys.rings[r] ? ringReach(ringSpeed(phys, phys.rings[r]), phys.k, from, h0, az, wind, ground, world) : 0));
  }

  // The field map uses point-array terrain callbacks and aims at building roofs.
  // Keep page-specific adaptation here so tests can exercise the same public interface as the browser.
  function field(env) {
    const ground = (x, z) => env.ground([x, z]);
    const reachGround = (x, z) => Math.max(env.height([x, z]) ?? 0, 0);
    return {
      solve: (w, s, from, to, wind = null, charge = null) => solve(env.tables(), w, s, from, to, wind, ground, charge, env.impact),
      reachOutline(w, s, from, wind) {
        if (!env.hasHeight() || !SHELL_PHYS[`${w}|${s}`]) return null;
        const out = reach(env.tables(), w, s, from, wind, reachGround, env.world());
        if (!out) return null;
        const rings = out.rings.filter(r => r.pts);
        return { rings, far: Math.max(0, ...rings.map(r => r.far)) };
      },
      reachToward: (w, s, from, to, wind, only = null) => env.hasHeight()
        ? reachToward(env.tables(), w, s, from, to, wind, reachGround, env.world(), only) : null,
      autoBandPolys: (w, s, from, outline) => autoBandPolys(env.tables(), w, s, from, outline),
    };
  }

  return { solve, short, reach, shellLike, chargeOf, autoBandPolys, invalidateTerrain, windParts, field };
})();

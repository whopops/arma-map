// Mortar: the field map's firing solutions (../app.js, solve() and what it uses), so a mortar's targets and fire
// requests show the same impact zones here: which charge ring reaches, and the ellipse 9 in 10 rounds land in, long
// along the line of fire and narrower across it. The flight model, the shells' physics and the spread are copied as
// they are; keep them in step with the field map. The firing tables are the field map's /data/mortar-tables.json.
//
// One difference: the field map aims at the roof when a target is on a building; here it's always the ground.
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
  const SPEED_SD = 1.07;         // m/s on the base speed, one standard deviation
  const BARREL = 0.5 / 48;       // rad, how far off the barrel can throw a round
  const P90 = 2.146;             // an ellipse this many standard deviations across holds 90% of the rounds

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
  // The high (plunging) angle that lands d m away, dh m up, in the given wind, or null if the ring can't reach (its
  // MIN_ELEV shot comes down short of it).
  const highCache = new Map();
  function highAngleFor(v, k, d, dh, along, across) {
    const key = `${v}|${k}|${Math.round(d * 2)}|${Math.round(dh * 4)}|${along.toFixed(2)}|${across.toFixed(2)}`;
    if (highCache.has(key)) return highCache.get(key);
    let lo = MIN_ELEV, hi = 89.5 * Math.PI / 180, res = null;
    const first = flight(v, k, lo, dh, along, across);
    if (first && first.range >= d) {
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
  // How far rounds spread (half-lengths of the 90% ellipse): long/short from the launch speed and the barrel, sideways
  // from the barrel.
  function spreadOf(v, coef, k, ang, dh, along, across, d) {
    const f = (vv, aa) => flight(vv, k, aa, dh, along, across);
    const up = f(v + 1, ang), dn = f(v - 1, ang), hi = f(v, ang + 0.002), lo = f(v, ang - 0.002);
    if (!up || !dn || !hi || !lo) return null;
    const dRdv = (up.range - dn.range) / 2, dRda = (hi.range - lo.range) / 0.004;
    const barrel = BARREL / 2;
    const sdLong = Math.hypot(dRdv * SPEED_SD * coef, dRda * barrel);
    const sdSide = d * barrel / Math.cos(ang);
    return { long: P90 * sdLong, side: P90 * sdSide };
  }

  // Firing solution from mortar to target for every ring that can reach it; best is the lowest (the tightest spread).
  // ground(x, z): the ground height there.
  const solved = new Map();
  function solve(tables, w, s, from, to, wind, ground) {
    const W = tables && tables.weapons[w], rings = W && W.shells[s];
    const d = dist(from, to), hFrom = ground(from[0], from[1]), hTo = ground(to[0], to[1]), dh = hTo - hFrom, az = bearing(from, to);
    const key = `${w}|${s}|${from}|${to}|${wind ? `${wind.s},${wind.d}` : ''}|${dh.toFixed(1)}`;
    if (solved.has(key)) return solved.get(key);
    const mpc = W ? W.milsPerCircle : 6400;
    const out = { d, az, azMil: az * mpc / 360, hFrom, hTo, dh, rings: [], best: null };
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
          const coef = phys.rings[ring], v = phys.v0 * coef;
          const real = highAngleFor(v, phys.k, d, dh - MUZZLE_H, along, across);
          if (!real) continue;
          elev = real.ang * mpc / (2 * Math.PI);
          tof = real.tof;
          azAdj = -Math.atan2(real.drift, d) * mpc / (2 * Math.PI);
          spread = spreadOf(v, coef, phys.k, real.ang, dh - MUZZLE_H, along, across, d);
        }
        if (elev > def.table[0][1] + 40) continue;
        out.rings.push({ ring: +ring, elev, tof, azMil: ((out.azMil + azAdj) % mpc + mpc) % mpc,
          dispersion: spread ? Math.round(Math.max(spread.long, spread.side)) : def.dispersion,
          spread: spread && { long: Math.round(spread.long), side: Math.round(spread.side), az } });
      }
      out.rings.sort((x, y) => x.ring - y.ring);
      out.best = out.rings[0] || null;
      if (out.best) out.azMil = out.best.azMil;
    }
    if (solved.size > 2000) solved.clear();
    solved.set(key, out);
    return out;
  }
  // "Ring 2 · 1203 mil · Az 812 · 21.4 s", as the field map labels a target
  const short = sol => (sol.best ? `Ring ${sol.best.ring} · ${Math.round(sol.best.elev)} mil · Az ${Math.round(sol.azMil)} · ${sol.best.tof.toFixed(1)} s` : 'out of range');
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
    let outR = null, outY = null;
    for (let i = path.length - 1; i > top; i--) {
      const [r1, y1] = path[i], [r0, y0] = path[i - 1], n = Math.max(1, Math.ceil((r1 - r0) / REACH_STEP));
      for (let j = n; j >= 0; j--) {
        const r = r0 + (r1 - r0) * j / n, y = y0 + (y1 - y0) * j / n;
        if (onMap(r) && g(r) <= y) {
          if (outR == null) return r;
          const gIn = g(r) - y, gOut = g(outR) - outY;
          return gOut > gIn ? r + (outR - r) * (-gIn) / (gOut - gIn) : r;
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
        const v = phys.v0 * phys.rings[ring], dists = [];
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
  // the weapon's shell of a kind (/^HE/, /^Smoke/, /^Illum/), else the one it has loaded
  const shellLike = (tables, w, re, fallback) => Object.keys((tables && tables.weapons[w] && tables.weapons[w].shells) || {}).find(s => re.test(s)) || fallback;

  return { solve, short, reach, shellLike };
})();

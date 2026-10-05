// Coarse LOS shared by the tactical map and its calibration runner. All grids are south-first, in metres.
'use strict';
const LightLos = (() => {
  const BANDS = [0, 1, 2, 4, 7, 12, 20, 45], CELL = 10, RANK = [0, 1, 3, 2];
  const bandAt = new Uint8Array(45);
  for (let b = 0; b < 7; b++) bandAt.fill(b, BANDS[b], BANDS[b + 1]);
  const legacy = Object.freeze({ crown: 0.55, low: 0.62, clutter: 0.7, clear: 0.7, hidden: 0.23, step: 5 });
  // Mesh-grid calibration retained these rates after rejecting a worse fitted trial; see LIGHT_CALIBRATION.md.
  const mesh = Object.freeze({ ...legacy });

  function groundAt(data, x, z) {
    const { cols: N, height: h } = data;
    const fx = Math.min(Math.max(x / CELL - 0.5, 0), N - 1), fz = Math.min(Math.max(z / CELL - 0.5, 0), N - 1);
    const c = Math.floor(fx), r = Math.floor(fz), c1 = Math.min(c + 1, N - 1), r1 = Math.min(r + 1, N - 1);
    const tx = fx - c, tz = fz - r;
    const south = h[r * N + c] + (h[r * N + c1] - h[r * N + c]) * tx;
    const north = h[r1 * N + c] + (h[r1 * N + c1] - h[r1 * N + c]) * tx;
    return Math.max((south + (north - south) * tz) / 10, 0);
  }
  function sector(xz, dir, arc, range) {
    if (arc >= 360) return [[xz[0] - range, xz[1] - range], [xz[0] + range, xz[1] + range]];
    const points = [xz], steps = Math.max(8, Math.round(arc / 3));
    for (let i = 0; i <= steps; i++) {
      const b = (dir - arc / 2 + arc * i / steps) * Math.PI / 180;
      points.push([xz[0] + range * Math.sin(b), xz[1] + range * Math.cos(b)]);
    }
    return points;
  }
  // Several tunings can share one march during calibration. They must use the same spatial step.
  function computeMany(req, data, tunings) {
    if (!data.height || req.range < 1) return tunings.map(() => null);
    const { xz, dir, arc, range, eyeH, targetH, elev } = req;
    const step = tunings[0].step || 5;
    if (tunings.some(t => (t.step || 5) !== step)) throw new Error('Light tunings must use the same step.');
    const strength = Number.isFinite(req.strength) ? Math.max(0, req.strength) : 1;
    const points = sector(xz, dir, arc, range);
    const minX = Math.floor(Math.min(...points.map(p => p[0])) / CELL) * CELL, maxX = Math.max(...points.map(p => p[0]));
    const minZ = Math.min(...points.map(p => p[1])), maxZ = Math.ceil(Math.max(...points.map(p => p[1])) / CELL) * CELL;
    const W = Math.max(1, Math.ceil((maxX - minX) / CELL)), H = Math.max(1, Math.ceil((maxZ - minZ) / CELL));
    const answers = tunings.map(() => new Uint8Array(W * H));
    const limits = tunings.map(t => ({ clear: -Math.log(t.clear), hidden: -Math.log(t.hidden) }));
    const minLow = Math.min(...tunings.map(t => t.low)) * strength;
    const minCrown = Math.min(...tunings.map(t => t.crown)) * strength;
    const minClutter = Math.min(...tunings.map(t => t.clutter));
    const cutoff = Math.max(...limits.map(t => t.hidden));
    const eye = groundAt(data, ...xz) + eyeH;
    const rays = Math.ceil(arc * Math.PI / 180 * range / (CELL * 0.7)) + 1;
    const [lo, hi] = elev ? elev.map(d => Math.tan(d * Math.PI / 180)) : [-Infinity, Infinity];
    const maxN = Math.ceil(range / step) + 1, NN = data.cols * data.cols;
    const hs = new Float64Array(maxN), blk = new Float64Array(maxN), ks = new Int32Array(maxN);
    const wooded = new Int32Array(maxN);
    const maxFoliage = Math.max(...tunings.map(t => Math.max(t.low, t.crown))) * strength * 0.5 / 255;
    const maxClutter = Math.max(...tunings.map(t => t.clutter)) / 255;
    for (let i = 0; i <= rays; i++) {
      const b = (dir - arc / 2 + arc * i / rays) * Math.PI / 180, sx = Math.sin(b), sz = Math.cos(b);
      let n = 0, m = 0;
      for (let r = step; r <= range; r += step) {
        const x = xz[0] + r * sx, z = xz[1] + r * sz;
        if (x < 0 || z < 0 || x > data.world || z > data.world) break;
        const k = x >= data.world || z >= data.world ? -1 : Math.floor(z / CELL) * data.cols + Math.floor(x / CELL);
        ks[n] = k; hs[n] = groundAt(data, x, z);
        blk[n] = hs[n] + (data.buildings && k >= 0 && r > 10 ? data.buildings[k] : 0);
        if (data.foliage && data.clutter && k >= 0 && (data.foliageMax[k] * maxFoliage + data.clutterMax[k] * maxClutter) * step > 0.01) wooded[m++] = n;
        n++;
      }
      let maxTerrain = -Infinity;
      for (let j = 0; j < n; j++) {
        const r = (j + 1) * step, t = (hs[j] + targetH - eye) / r;
        const blocked = t < maxTerrain || t < lo || t > hi;
        let lowTau = 0, crownTau = 0, clutterTau = 0;
        if (!blocked) {
          const len = step * Math.sqrt(1 + t * t);
          for (let q = 0; q < m; q++) {
            const w = wooded[q]; if (w > j) break;
            if (lowTau * minLow + crownTau * minCrown + clutterTau * minClutter > cutoff) break;
            const y = eye + t * (w + 1) * step - hs[w];
            if (y < 0 || y >= 45) continue;
            const band = bandAt[Math.floor(y)], at = band * NN + ks[w], weight = len * (w === j ? 0.5 : 1);
            const foliageTau = data.foliage[at] * 0.5 / 255 * weight;
            if (band <= 2) lowTau += foliageTau; else crownTau += foliageTau;
            if ((w + 1) * step > 10) clutterTau += data.clutter[at] / 255 * weight;
          }
        }
        maxTerrain = Math.max(maxTerrain, (blk[j] - eye) / r);
        const x = xz[0] + r * sx, z = xz[1] + r * sz;
        const cx = Math.floor((x - minX) / CELL), cz = Math.floor((maxZ - z) / CELL);
        if (cx < 0 || cx >= W || cz < 0 || cz >= H) continue;
        const k = cz * W + cx;
        for (let a = 0; a < tunings.length; a++) {
          const tuning = tunings[a], tau = (lowTau * tuning.low + crownTau * tuning.crown) * strength + clutterTau * tuning.clutter;
          const v = blocked || tau > limits[a].hidden ? 1 : tau > limits[a].clear ? 3 : 2;
          if (RANK[v] > RANK[answers[a][k]]) answers[a][k] = v;
        }
      }
    }
    return answers.map(cells => {
      let clear = 0, trees = 0, total = 0;
      for (const v of cells) if (v) { total++; if (v === 2) clear++; else if (v === 3) trees++; }
      return { cells, W, H, minX, maxZ, cell: CELL, pct: total ? Math.round(clear / total * 100) : 100,
        treePct: total ? Math.round(trees / total * 100) : 0 };
    });
  }
  return { legacy, mesh, groundAt, computeMany, compute: (req, data, tuning = mesh) => computeMany(req, data, [tuning])[0] };
})();

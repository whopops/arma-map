/* Shared sampling and verdicts for the LOS workbench. Unknown cells never imply hidden ground. */
(() => {
  'use strict';
  const rank = [0, 1, 3, 2];
  function sample(result, xz) {
    if (!result) return null;
    const c = Math.floor((xz[0] - result.minX) / result.cell), r = Math.floor((result.maxZ - xz[1]) / result.cell);
    return c >= 0 && r >= 0 && c < result.W && r < result.H ? result.cells[r * result.W + c] : 0;
  }
  function verdict(runs, xz, range, details = true) {
    let best = 0, pending = false, failed = false, inside = false;
    const positions = [];
    for (const run of runs) {
      if (Math.hypot(xz[0] - run.xz[0], xz[1] - run.xz[1]) > range) continue;
      inside = true;
      const v = sample(run.result, xz);
      if (details) positions.push({ label: run.label, value: run.failed ? 'error' : v === null || v === 0 ? 'pending' : v });
      if (run.failed) failed = true;
      else if (v === null || v === 0) pending = true;
      if (v && rank[v] > rank[best]) best = v;
      if (!details && best === 2) return { value: 2 };
    }
    // A clear line is conclusive; a foliage or hidden result must wait for all other positions.
    return { value: !inside ? 'outside' : best === 2 ? 2 : failed ? 'error' : pending ? 'pending' : best || 'pending', positions };
  }
  function around(xz, count, world) {
    const points = [xz.slice()];
    for (let i = 0; i < count - 1; i++) {
      const angle = i * 2 * Math.PI / (count - 1);
      points.push([xz[0] + 40 * Math.sin(angle), xz[1] + 40 * Math.cos(angle)]);
    }
    return points.filter(p => p.every(v => v >= 0 && v < world));
  }
  globalThis.LosAnalysis = { sample, verdict, around };
})();

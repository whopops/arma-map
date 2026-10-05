// Los: line of sight for the room's markings, the field map's own way. The sums are the field map's worker
// (/los-worker.js, the very same file) with its "Measured" model: every building, wall and rock from the game at
// 0.5 m, and every tree and bush as see-through as the game's own pictures of it show
// (/data/maps/<map>/foliage/foliage_profiles.json), worked out in 2.5 m cells, from the field map's own tiles and plants.
//
// grid(...) answers at once from what's been worked out, else asks the worker and answers null; onResult() is called
// as each answer arrives, so the caller can draw again. Results: {cells, W, H, minX, maxZ, cell, pct, treePct}; cells
// row by row from the north edge (maxZ), 0 outside the arc, 1 hidden, 2 clear, 3 seen only through trees.
'use strict';

const Los = (() => {
  const CELL = 2.5, KEEP = 60;
  return function los(cfg, onResult) {
    const cache = new Map(), wanted = new Map(), failures = new Map();
    let worker = null, seq = 0, error = null;
    function start() {
      worker = new Worker('/los-worker.js');
      worker.onmessage = e => {
        const d = e.data, entry = [...wanted].find(([, id]) => id === d.id);
        if (!entry) return;
        wanted.delete(entry[0]);
        if (d.error) {
          if (!error) console.error('Line of sight:', d.error);
          error = d.error;
          failures.set(entry[0], Date.now() + 5000);
          while (failures.size > KEEP) failures.delete(failures.keys().next().value);
          setTimeout(onResult, 5100);
        }
        else {
          error = null; failures.delete(entry[0]);
          cache.set(entry[0], d);
          while (cache.size > KEEP) cache.delete(cache.keys().next().value);
        }
        onResult();
      };
    }
    // From xz, across `arc` degrees centred on bearing `dir`, out to `range` m: what an eye eyeH above the ground sees
    // of a target targetH above it. reverse: marched out from the target with the heights swapped (overwatch).
    // elev: [lowest, highest] angle a gun can aim, in degrees.
    function grid(xz, dir, arc, range, eyeH, targetH, reverse = false, elev = null) {
      if (!(range >= 1)) return null;
      const key = `${xz}|${dir}|${arc}|${Math.round(range)}|${eyeH}|${targetH}|${reverse}|${elev}`;
      const hit = cache.get(key);
      if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
      if ((failures.get(key) || 0) > Date.now()) return null;
      if (!wanted.has(key)) {
        if (!worker) start();
        const id = ++seq;
        wanted.set(key, id);
        worker.postMessage({ id, xz, dir, arc, range, eyeH, targetH, reverse, elev, cell: CELL, model: 'profiles', strength: 1, cfg });
      }
      return null;
    }
    return { grid, get working() { return wanted.size; }, get error() { return error; } };
  };
})();

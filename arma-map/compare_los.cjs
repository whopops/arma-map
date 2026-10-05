// Compare the actual worker on identical local queries. No live rooms or network are used.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { gunzipSync } = require('node:zlib');
const { performance } = require('node:perf_hooks');
const root = path.join(__dirname, 'static');
const json = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
function worker() {
  const fetched = [];
  const ctx = vm.createContext({ Response, DecompressionStream,
    fetch: async url => {
      const file = String(url).split('?')[0]; fetched.push(file);
      return new Response(fs.readFileSync(path.join(root, file)));
    } });
  vm.runInContext(fs.readFileSync(path.join(root, 'los-worker.js'), 'utf8') + '\nglobalThis.api = {selectConfig, loadIndex, loadProfiles, loadArea, compute};', ctx);
  return { api: ctx.api, fetched };
}
function cfg(map, model) {
  const dir = `data/maps/${map}`, foliage = model === 'mesh' ? `${dir}/foliage-mesh` : dir;
  return { size: json(`${dir}/map.json`).world, losDir: `${dir}/los`,
    profiles: { json: `${foliage}/foliage/foliage_profiles.json`, plants: `${foliage}/foliage.json`, dir: `${foliage}/plants` } };
}
async function query(w, map, model, xz, dir) {
  const c = cfg(map, model), range = 200;
  const start = performance.now();
  w.api.selectConfig(c); await w.api.loadIndex(); await w.api.loadProfiles();
  await w.api.loadArea(xz[0] - range - 2, xz[1] - range - 2, xz[0] + range + 2, xz[1] + range + 2);
  const ready = performance.now();
  const result = w.api.compute({ xz, dir, arc: 90, range, eyeH: 1.6, targetH: 1, cell: 2.5, model, strength: 1 });
  return { result, loadMs: Math.round(ready - start), computeMs: Math.round(performance.now() - ready) };
}
function profileStats(map) {
  const dir = `data/maps/${map}`, a = json(`${dir}/foliage/foliage_profiles.json`), b = json(`${dir}/foliage-mesh/foliage/foliage_profiles.json`);
  const list = json(`${dir}/foliage.json`), mesh = json(`${dir}/foliage-mesh/foliage.json`);
  assert.deepEqual(list.prefabs, mesh.prefabs, 'plant kind indices changed');
  let n = 0, err = 0, delta = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (const prefab of list.prefabs) {
    assert.ok(a[prefab] && b[prefab]);
    for (const band of a[prefab].bands) {
      const other = b[prefab].bands.find(x => x.d === band.d && !!x.near === !!band.near);
      if (!other) continue;
      const ys = new Map(other.slices.map(s => [s.y, s.cover]));
      for (const s of band.slices) {
        const y = ys.get(s.y); if (y === undefined) continue;
        const x = s.cover; n++; err += Math.abs(y - x); delta += y - x;
        sa += x; sb += y; saa += x*x; sbb += y*y; sab += x*y;
      }
    }
  }
  return { kinds: list.prefabs.length, slices: n, coverMAE: +(err/n).toFixed(4), coverDelta: +(delta/n).toFixed(4),
    correlation: +((n*sab-sa*sb)/Math.sqrt((n*saa-sa*sa)*(n*sbb-sb*sb))).toFixed(4) };
}
async function run() {
  const report = { gameBuild: '24903726', note: 'Photo vs mesh agreement, not accuracy against engine sight lines. 200 m / 90 degree queries, eye 1.6 m, target 1 m, 2.5 m output.', maps: [] };
  for (const map of ['everon', 'arland', 'kolguyev']) {
    const w = worker(), start = json(`data/maps/${map}/map.json`).start;
    const entry = { map, ...profileStats(map), queries: [] };
    const list = json(`data/maps/${map}/foliage.json`);
    const name = `${Math.floor(start[0]/500)}_${Math.floor(start[1]/500)}`;
    assert.ok(list.tiles.includes(name));
    const plants = gunzipSync(fs.readFileSync(path.join(root, `data/maps/${map}/plants/${name}.bin.gz`)));
    const count = plants.readUInt32LE(0), i = Math.floor(count / 2);
    const forest = [Math.floor(start[0]/500)*500 + plants.readUInt16LE(4+2*i)/100 - list.margin + 12,
      Math.floor(start[1]/500)*500 + plants.readUInt16LE(4+2*count+2*i)/100 - list.margin + 12];
    // Town/start, nearby positions, and a known plant location, with identical queries for each dataset.
    const queries = [[start,0], [[start[0]+150,start[1]+100],90], [[start[0]-100,start[1]+150],180], [forest,225]];
    for (const [xz, dir] of queries) {
      const a = await query(w, map, 'profiles', xz, dir), b = await query(w, map, 'mesh', xz, dir);
      assert.equal(a.result.W, b.result.W); assert.equal(a.result.H, b.result.H);
      let changed = 0, total = 0;
      for (let i = 0; i < a.result.cells.length; i++) if (a.result.cells[i] || b.result.cells[i]) { total++; if (a.result.cells[i] !== b.result.cells[i]) changed++; }
      const before = w.fetched.length, again = await query(w, map, 'profiles', xz, dir);
      assert.deepEqual(Array.from(again.result.cells), Array.from(a.result.cells), 'switching back contaminated the photo result');
      assert.equal(w.fetched.length, before, 'switching back reloaded cached tiles/profiles');
      entry.queries.push({ xz, bearing: dir, changedPct: +(changed/total*100).toFixed(2),
        photo: { clearPct: a.result.pct, foliagePct: a.result.treePct, loadMs: a.loadMs, computeMs: a.computeMs },
        mesh: { clearPct: b.result.pct, foliagePct: b.result.treePct, loadMs: b.loadMs, computeMs: b.computeMs } });
    }
    report.maps.push(entry); console.log(JSON.stringify(entry));
  }
  if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
  return report;
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = run;

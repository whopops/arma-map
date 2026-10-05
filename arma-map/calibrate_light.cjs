// Fit only on training locations, then report untouched held-out locations. No network or rooms.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { gunzipSync } = require('node:zlib');
const { performance } = require('node:perf_hooks');
const root = path.join(__dirname, 'static');
const json = p => JSON.parse(fs.readFileSync(path.join(root, p)));
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(root, 'light-los.js'), 'utf8') + '\nglobalThis.api=LightLos;', context);
const light = context.api;
function bin(dir, name, type = Uint8Array) {
  const bytes = gunzipSync(fs.readFileSync(path.join(root, dir, `${name}.bin.gz`)));
  return new type(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
function maximum(grid, nn) {
  const out = new Uint8Array(nn);
  for (let i = 0; i < grid.length; i++) if (grid[i] > out[i % nn]) out[i % nn] = grid[i];
  return out;
}
function dataFor(map) {
  const dir = `data/maps/${map}`, def = json(`${dir}/map.json`), nn = def.lightCols ** 2;
  const common = { world: def.world, cols: def.lightCols, height: bin(`${dir}/light`, 'height', Int16Array),
    buildings: bin(`${dir}/light`, 'buildings'), clutter: bin(`${dir}/light`, 'clutter'), canopy: bin(`${dir}/light`, 'canopy') };
  common.clutterMax = maximum(common.clutter, nn);
  const photo = bin(`${dir}/light`, 'foliage'), mesh = bin(`${dir}/foliage-mesh/light`, 'foliage');
  assert.equal(mesh.length, nn * 7); assert.equal(photo.length, nn * 7);
  return { def, photo: { ...common, foliage: photo, foliageMax: maximum(photo, nn) },
    mesh: { ...common, foliage: mesh, foliageMax: maximum(mesh, nn) } };
}
function sitesFor(data, def) {
  const N = data.cols, sites = [], used = [];
  for (const split of ['train', 'development', 'holdout']) for (const kind of ['town', 'forest', 'open']) {
    const anchor = split === 'train' ? def.start : split === 'development'
      ? [def.world - def.start[0], def.world - def.start[1]] : [def.world * .23, def.world * .7];
    let best = null, score = Infinity;
    for (let r = 12; r < N - 12; r += 4) for (let c = 12; c < N - 12; c += 4) {
      const k = r * N + c, xz = [(c + .5) * 10, (r + .5) * 10];
      if (xz.some(x => x >= def.world - 100) || data.height[k] < 50 || data.buildings[k]) continue;
      if (used.some(p => Math.hypot(p[0] - xz[0], p[1] - xz[1]) < 500)) continue;
      const town = [-N, N, -1, 1].some(d => data.buildings[k+d] >= 3);
      if (kind === 'town' && !town || kind === 'forest' && (data.canopy[k] < 8 || data.foliageMax[k] < 20)
        || kind === 'open' && (data.foliageMax[k] > 2 || town)) continue;
      const distance = Math.hypot(anchor[0] - xz[0], anchor[1] - xz[1]);
      if (distance < score) { best = xz; score = distance; }
    }
    assert.ok(best, `${kind} site missing`); used.push(best);
    sites.push({ split, kind, xz: best, dir: [0,90,180,270,45,225,135,315,90][sites.length] });
  }
  return sites;
}
function worker(map, def) {
  const dir = `data/maps/${map}`, ctx = vm.createContext({ Response, DecompressionStream,
    fetch: async url => new Response(fs.readFileSync(path.join(root, String(url).split('?')[0]))) });
  vm.runInContext(fs.readFileSync(path.join(root, 'los-worker.js'), 'utf8') + '\nglobalThis.api={selectConfig,loadIndex,loadProfiles,loadArea,compute,sectorBox};', ctx);
  ctx.api.selectConfig({ size: def.world, losDir: `${dir}/los`, profiles: {
    json: `${dir}/foliage-mesh/foliage/foliage_profiles.json`, plants: `${dir}/foliage-mesh/foliage.json`, dir: `${dir}/foliage-mesh/plants` } });
  return ctx.api;
}
function coarseTruth(full, coarse) {
  const cells = new Uint8Array(coarse.cells.length), rank = [0,1,3,2];
  // The UI uses the best visible sample in each cell; coarsen Mesh with that same rule.
  for (let z = 0; z < full.H; z++) for (let x = 0; x < full.W; x++) {
    const v = full.cells[z * full.W + x]; if (!v) continue;
    const cx = Math.floor((full.minX + (x + .5) * full.cell - coarse.minX) / coarse.cell);
    const cz = Math.floor((coarse.maxZ - (full.maxZ - (z + .5) * full.cell)) / coarse.cell);
    if (cx < 0 || cz < 0 || cx >= coarse.W || cz >= coarse.H) continue;
    const k = cz * coarse.W + cx; if (rank[v] > rank[cells[k]]) cells[k] = v;
  }
  return cells;
}
function confusion(truth, predicted) {
  const m = Array(9).fill(0);
  for (let i = 0; i < truth.length; i++) if (truth[i] && predicted[i]) m[(truth[i]-1)*3+predicted[i]-1]++;
  return m;
}
function add(a,b) { for (let i=0;i<9;i++) a[i]+=b[i]; return a; }
function metrics(m) {
  const n = m.reduce((a,b)=>a+b,0), f1 = [];
  for (let c=0;c<3;c++) {
    const row = m[c*3]+m[c*3+1]+m[c*3+2], col = m[c]+m[c+3]+m[c+6];
    f1.push(row+col ? 2*m[c*3+c]/(row+col) : null);
  }
  const present=f1.filter(x=>x!==null);
  return { cells:n, agreement:n ? (m[0]+m[4]+m[8])/n : 0, macroF1:present.reduce((a,b)=>a+b,0)/present.length, f1, confusion:m };
}
function aggregate(scenes, key, candidate) {
  const matrices = scenes.map(s=>key==='candidates'?s.candidates[candidate]:s[key]);
  return {...metrics(matrices.reduce((m,s)=>add(m,s), Array(9).fill(0))),
    queryMacroF1:matrices.reduce((n,m)=>n+metrics(m).macroF1,0)/matrices.length};
}
async function run() {
  const verification = process.argv.includes('--verify-grid');
  const prior = verification ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : null;
  const candidates=[];
  for(const low of [.4,.6,.8,1.1]) for(const crown of [.4,.6,.8,1.1]) for(const clear of [.55,.7,.85])
    for(const hidden of [.15,.23,.35]) for(const clutter of [.35,.7,1.4])
      candidates.push({low,crown,clear,hidden,clutter,step:5});
  candidates.unshift({...light.legacy});
  if (verification) candidates.splice(1);
  const scenes=[], cases=[];
  for(const map of ['everon','arland','kolguyev']) {
    const data=dataFor(map), w=worker(map,data.def);
    await w.loadIndex(); await w.loadProfiles();
    for(const site of sitesFor(data.mesh,data.def)) for(const setup of [
      {range:200,eyeH:.6,targetH:1}, {range:600,eyeH:2,targetH:1.6}]) {
      const req={...setup,xz:site.xz,dir:site.dir,arc:90,cell:2.5,strength:1,model:'mesh'};
      const pts=w.sectorBox(req.xz,req.dir,req.arc,req.range);
      await w.loadArea(Math.min(...pts.map(p=>p[0]))-2,Math.min(...pts.map(p=>p[1]))-2,
        Math.max(...pts.map(p=>p[0]))+2,Math.max(...pts.map(p=>p[1]))+2);
      const start=performance.now(), full=w.compute(req), fullMs=performance.now()-start;
      const oldStart=performance.now(), old=light.compute(req,data.photo,light.legacy), oldMs=performance.now()-oldStart;
      const results=light.computeMany(req,data.mesh,candidates), truth=coarseTruth(full,old);
      const selectedStart=performance.now(), selected=light.compute(req,data.mesh,light.mesh), lightMs=performance.now()-selectedStart;
      assert.equal(old.cells.length,results[0].cells.length);
      scenes.push({map,...site,...setup,fullMs,oldMs,lightMs,legacy:confusion(truth,old.cells),
        selected:confusion(truth,selected.cells),candidates:results.map(r=>confusion(truth,r.cells))});
      cases.push({req,data:data.mesh,truth});
      console.log(`${map} ${site.split} ${site.kind} ${req.range} m: full ${Math.round(fullMs)} ms, Light ${Math.round(lightMs)} ms`);
    }
  }
  const train=scenes.filter(s=>s.split!=='holdout'), hold=scenes.filter(s=>s.split==='holdout');
  const scores=candidates.map((t,i)=>({t,i,score:aggregate(train,'candidates',i).queryMacroF1})).sort((a,b)=>b.score-a.score);
  const trial=scores[0];
  // Accept a fit only if its held-out class balance improves over the unchanged mesh-grid rates.
  const accepted=!verification && aggregate(hold,'candidates',trial.i).macroF1 > aggregate(hold,'candidates',0).macroF1;
  const best=accepted ? trial : {t:light.legacy,i:0};
  // Re-run the winner alone: report deployed-path results/timing, independent of the sweep's shared skips.
  for(let i=0;i<scenes.length;i++) {
    const start=performance.now(), r=light.compute(cases[i].req,cases[i].data,best.t);
    scenes[i].lightMs=performance.now()-start;
    scenes[i].selected=confusion(cases[i].truth,r.cells);
  }
  const report={reference:'Detailed Mesh, not engine ground truth',gameBuild:'24903726',metric:'Three-class macro F1; Mesh coarsened to 10 m with UI best-visible rule; common covered cells',
    candidates:prior ? prior.candidates : candidates.length,selectedTuning:best.t,selectionObjective:'Mean per-query macro F1 on training/development locations only; reject fits that lose held-out macro F1 against mesh grid with unchanged rates',
    rejectedTrial:prior ? prior.rejectedTrial || {tuning:prior.selectedTuning,training:prior.training.fitted,holdout:prior.holdout.fitted} : accepted ? null : {tuning:trial.t,training:aggregate(train,'candidates',trial.i),holdout:aggregate(hold,'candidates',trial.i)},
    training:{legacy:aggregate(train,'legacy'),meshGridOnly:aggregate(train,'candidates',0),production:aggregate(train,'selected')},
    holdout:{legacy:aggregate(hold,'legacy'),meshGridOnly:aggregate(hold,'candidates',0),production:aggregate(hold,'selected')},
    byMap:['everon','arland','kolguyev'].map(map=>({map,holdout:{legacy:aggregate(hold.filter(s=>s.map===map),'legacy'),
      production:aggregate(hold.filter(s=>s.map===map),'selected')}})),
    scenes:scenes.map(({candidates:all,...s})=>s)};
  if(process.argv[2]) fs.writeFileSync(process.argv[2],JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({selected:best.t,training:report.training,holdout:report.holdout},null,2));
  return report;
}
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={run,dataFor,coarseTruth,metrics};

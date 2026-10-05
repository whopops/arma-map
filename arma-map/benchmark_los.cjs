// Compare a Git baseline with the current detailed solver on actual packaged data, checking every cell.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const root = path.join(__dirname, 'static');
const baseline = process.argv[2] || 'HEAD';
const baselineCommit=execFileSync('git',['rev-parse',baseline],{cwd:__dirname,encoding:'utf8'}).trim();
const before = execFileSync('git', ['show', `${baselineCommit}:arma-map/static/los-worker.js`], {cwd:__dirname,encoding:'utf8'});
const after = fs.readFileSync(path.join(root, 'los-worker.js'), 'utf8');
function worker(source) {
  const ctx=vm.createContext({Response,DecompressionStream,
    fetch:async url=>new Response(fs.readFileSync(path.join(root,String(url).split('?')[0])))});
  vm.runInContext(source+'\nglobalThis.api={selectConfig,loadIndex,loadProfiles,loadArea,compute};',ctx);
  return ctx.api;
}
async function run() {
  const old=worker(before), current=worker(after), scenes=[];
  const fixtures=JSON.parse(fs.readFileSync(path.join(__dirname,'LIGHT_CALIBRATION.json'))).scenes
    .filter(s=>s.split==='holdout' && s.kind!=='open');
  for(const s of fixtures) for(const model of ['profiles','mesh']) {
    const dir=`data/maps/${s.map}`, foliage=model==='mesh'?`${dir}/foliage-mesh`:dir;
    const cfg={size:JSON.parse(fs.readFileSync(path.join(root,dir,'map.json'))).world,losDir:`${dir}/los`,
      profiles:{json:`${foliage}/foliage/foliage_profiles.json`,plants:`${foliage}/foliage.json`,dir:`${foliage}/plants`}};
    for(const w of [old,current]) {
      w.selectConfig(cfg); await w.loadIndex(); await w.loadProfiles();
      await w.loadArea(s.xz[0]-s.range-2,s.xz[1]-s.range-2,s.xz[0]+s.range+2,s.xz[1]+s.range+2);
    }
    const req={xz:s.xz,dir:s.dir,arc:90,range:s.range,eyeH:s.eyeH,targetH:s.targetH,cell:2.5,strength:1,model};
    // Alternate order across fixtures to reduce consistent warmup/order bias.
    const output=[], times=[];
    for(const i of scenes.length%2?[1,0]:[0,1]) {
      const start=performance.now(); output[i]=[old,current][i].compute(req); times[i]=performance.now()-start;
    }
    for(const key of ['W','H','minX','maxZ','cell','pct','treePct']) assert.equal(output[0][key],output[1][key]);
    assert.deepEqual(Array.from(output[0].cells),Array.from(output[1].cells),`${s.map} ${s.kind} ${s.range} ${model}`);
    scenes.push({map:s.map,kind:s.kind,model,...req,beforeMs:times[0],afterMs:times[1],cells:output[0].cells.length});
    console.log(`${s.map} ${s.kind} ${s.range}m ${model}: ${times[0].toFixed(0)} → ${times[1].toFixed(0)} ms, identical cells`);
  }
  const summary=[200,600].map(range=> {
    const rows=scenes.filter(s=>s.range===range), mean=key=>rows.reduce((a,s)=>a+s[key],0)/rows.length;
    return {range,queries:rows.length,beforeMs:mean('beforeMs'),afterMs:mean('afterMs'),speedup:mean('beforeMs')/mean('afterMs')};
  });
  const report={baseline:baselineCommit,
    metric:'Compute only; loaded local data, identical output cells required; alternating execution order',summary,scenes};
  if(process.argv[3]) fs.writeFileSync(process.argv[3],JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(summary,null,2));
}
run().catch(e=>{console.error(e);process.exitCode=1;});

// Run with node test_client.cjs. Executes the actual browser functions with small environment stubs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, 'static/app.js'), 'utf8');
const tables = JSON.parse(fs.readFileSync(path.join(__dirname, 'static/data/mortar-tables.json'), 'utf8'));
const ctx3 = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, 'static/3d/mortar.js'), 'utf8') + '\nglobalThis.model = Mortar;', ctx3);
const model = ctx3.model;
const legacyPath = path.join(__dirname, '../../everon_los/everon-3d-map/web/mortar.js');
const legacyContext = fs.existsSync(legacyPath) ? vm.createContext({}) : null;
if (legacyContext) vm.runInContext(fs.readFileSync(legacyPath, 'utf8') + '\nglobalThis.model = Mortar;', legacyContext);
const physics = app.slice(app.indexOf('  const GRAV = 9.81;'), app.indexOf('  // Auto: the ring for a target'));
let targetHeight = 0;
const ctx2 = vm.createContext({
  dist: (a,b) => Math.hypot(b[0]-a[0], b[1]-a[1]),
  bearing: (a,b) => (Math.atan2(b[0]-a[0], b[1]-a[1])*180/Math.PI+360)%360,
  groundFine: () => 0, impactHeight: () => ({h: targetHeight, roof: false}),
  weaponDef: w => tables.weapons[w], shellDef: (w,s) => tables.weapons[w].shells[s],
});
vm.runInContext(physics + '\nglobalThis.solve2 = solve;', ctx2);

function testMortarLimitsAndParity() {
  let accepted = 0;
  for (const [w,W] of Object.entries(tables.weapons)) {
    for (const [s,rings] of Object.entries(W.shells)) {
      for (const [charge,def] of Object.entries(rings)) {
        for (const height of [0,-100,100]) {
          for (const d of [def.table[0][0], def.table[Math.floor(def.table.length/2)][0]]) {
            targetHeight = height;
            const ground = (x,z) => z > 0 ? height : 0;
            const a = ctx2.solve2(w,s,[0,0],[0,d],null,+charge);
            const b = model.solve(tables,w,s,[0,0],[0,d],null,ground,+charge);
            const legacy = legacyContext && legacyContext.model.solve(tables,w,s,[0,0],[0,d],null,ground,+charge);
            for (const ring of legacy ? legacy.rings : []) {
              const deg = ring.elev * 360 / W.milsPerCircle;
              assert.ok(deg >= 45 && deg <= 85, `legacy viewer accepted impossible elevation ${deg}`);
            }
            assert.equal(!!a.best, !!b.best, `${w}/${s}/${charge}/${d}/${height}: 2D/3D mismatch`);
            if (a.best) {
              accepted++;
              const deg = a.best.elev * 360 / W.milsPerCircle;
              assert.ok(deg >= 45 && deg <= 85, `impossible elevation ${deg}`);
              assert.ok(Math.abs(a.best.elev-b.best.elev) < 0.001);
            }
          }
        }
      }
    }
  }
  assert.ok(accepted > 20, 'solver rejected all valid shots');
  const impossible = model.solve(tables,'M252','HE M821',[0,0],[0,50],null,()=>0,0);
  assert.equal(impossible.best, null, 'accepted the previously reproduced 86.66 degree shot');
  console.log(`Mortar limits and 2D/3D parity passed (${accepted} accepted sample solutions).`);
}

function testTerrainInvalidation() {
  let detail = false;
  const ground = (x,z) => detail && z > 6600 ? 100 : 0;
  const from = [6400,6400];
  const before = model.reach(tables,'M252','HE M821',from,null,ground);
  assert.equal(model.reach(tables,'M252','HE M821',from,null,ground), before);
  detail = true;
  model.invalidateTerrain();
  const after = model.reach(tables,'M252','HE M821',from,null,ground);
  assert.notEqual(after, before);
  assert.ok(Math.abs(after.rings.find(r=>r.ring===4).pts[0][1]-before.rings.find(r=>r.ring===4).pts[0][1]) > 50);
  const main = fs.readFileSync(path.join(__dirname,'static/3d/main.js'),'utf8');
  assert.match(main.slice(main.indexOf('if (m.ter)'), main.indexOf('if (m.ter)')+220), /Mortar\.invalidateTerrain\(\)/);
  console.log('Terrain detail invalidation passed.');
}

async function testImport() {
  const save = app.slice(app.indexOf('  const saveItem ='), app.indexOf('  const deleteItem ='));
  const start = app.indexOf("  $('#import-file').addEventListener('change',");
  const listener = app.slice(start, app.indexOf('\n  });',start)+7);
  for (const failAt of [0,1,null]) {
    const notices = []; let calls = 0, handler, id = 0;
    const context = vm.createContext({
      state: {me: {id:'session',token:'token'}},
      api: async () => { if (calls++ === failAt) throw new Error('Limit reached'); return {ok:true}; },
      toast: text => notices.push(text), uid: () => `test${++id}`,
      myMortar: () => null, myFia: () => null,
      setTimeout: fn => { fn(); return 0; },
      $: () => ({addEventListener: (_,fn) => {handler = fn;}}),
    });
    vm.runInContext(save + listener, context);
    await handler({target:{value:'plan.json',files:[{text:async()=>JSON.stringify({items:[{type:'marker'},{type:'marker'}]})}]}});
    if (failAt == null) assert.ok(notices.includes('Imported 2 markings.'));
    else {
      assert.ok(notices.includes('Limit reached'));
      assert.ok(notices.some(t=>t.includes(`Import stopped: ${failAt} of 2 markings imported.`)));
      assert.ok(!notices.some(t=>t.startsWith('Imported ')));
      assert.equal(calls, failAt+1, 'import continued after an API failure');
    }
  }
  console.log('Import success, total failure, and partial failure passed.');
}

function testScopedGuns() {
  const start = app.indexOf('  const steps = (a, b, s)');
  const SCOPES = new Function(app.slice(start, app.indexOf('  const GUN_CHOICES', start)) + ';return SCOPES')();
  const py = fs.readFileSync(path.join(__dirname,'server.py'),'utf8').match(/SCOPED_GUNS = \{([\s\S]*?)\n\}/)[1];
  const server = Object.fromEntries([...py.matchAll(/"([^"]+)": "([^"]+)"/g)].map(m=>[m[1],m[2]]));
  assert.deepEqual(Object.fromEntries(Object.entries(SCOPES).map(([k,g])=>[k,g.round])), server, 'SCOPES in app.js and SCOPED_GUNS in server.py differ');
  for (const [k,g] of Object.entries(SCOPES)) if (g.lines)
    g.lines.forEach((l,i) => i && assert.ok(l[0] > g.lines[i-1][0] && l[1] > g.lines[i-1][1], `${k}: range lines out of order`));
  const file = path.join(__dirname,'static/data/bullets.json');
  if (fs.existsSync(file)) {
    const rounds = JSON.parse(fs.readFileSync(file,'utf8')).rounds;
    for (const g of Object.values(SCOPES)) assert.ok(rounds[g.round], `bullets.json has no ${g.round}`);
  }
  console.log(`Scoped guns match the server${fs.existsSync(file) ? ' and bullets.json' : ''}.`);
}

(async () => {testMortarLimitsAndParity(); testTerrainInvalidation(); testScopedGuns(); await testImport();})().catch(e=>{console.error(e);process.exitCode=1;});

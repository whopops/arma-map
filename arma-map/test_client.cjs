// Run with node test_client.cjs. Executes the actual browser functions with small environment stubs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tables = JSON.parse(fs.readFileSync(path.join(__dirname, 'static/data/mortar-tables.json'), 'utf8'));
const ctx3 = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, 'static/3d/mortar.js'), 'utf8') + '\nglobalThis.model = Mortar;', ctx3);
const model = ctx3.model;
const legacyPath = path.join(__dirname, '../../everon_los/everon-3d-map/web/mortar.js');
const legacyContext = fs.existsSync(legacyPath) ? vm.createContext({}) : null;
if (legacyContext) vm.runInContext(fs.readFileSync(legacyPath, 'utf8') + '\nglobalThis.model = Mortar;', legacyContext);
let targetHeight = 0, roofHeight = 0;
const field = model.field({ tables: () => tables, ground: () => 0,
  impact: () => ({ h: targetHeight + roofHeight, roof: roofHeight }), height: () => 0,
  hasHeight: () => true, world: () => 12800 });
const ctx2 = { solve2: field.solve };
const transfer = vm.createContext({ setTimeout });
vm.runInContext(fs.readFileSync(path.join(__dirname, 'static/plan-sync.js'), 'utf8') + '\nglobalThis.model = PlanSync;', transfer);
const plans = transfer.model;

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
  targetHeight = 0; roofHeight = 20;
  const roof = field.solve('M252','HE M821',[0,0],[0,500],null,1);
  assert.equal(roof.hTo, 20);
  assert.equal(roof.roof, 20);
  assert.equal(roof.mapAzMil, 0);
  roofHeight = 0;
  assert.notEqual(field.solve('M252','HE M821',[0,0],[0,500],null,1).best.elev, roof.best.elev);
  const unknown = model.field({ tables: () => tables, ground: () => null, impact: () => ({h:null,roof:0}),
    height: () => null, hasHeight: () => false, world: () => 12800 });
  assert.equal(unknown.solve('M252','HE M821',[0,0],[0,500]).dh, 0);
  assert.equal(unknown.reachOutline('M252','HE M821',[0,0],null), null);
  console.log('Terrain detail invalidation passed.');
}

function testMortarCompatibilityFixtures() {
  const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'test_fixtures/mortar-solutions.json'), 'utf8'));
  for (const sample of fixtures.cases) {
    targetHeight = sample.height; roofHeight = sample.roof;
    const sol = field.solve(sample.weapon, sample.shell, sample.from, sample.to, sample.wind, sample.charge);
    assert.ok(sol.best, `${sample.weapon}: compatibility shot no longer solves`);
    assert.equal(sol.best.ring, sample.expected.ring);
    for (const [key, actual] of Object.entries({elev:sol.best.elev, azMil:sol.azMil, tof:sol.best.tof,
      long:sol.best.spread.long, side:sol.best.spread.side})) {
      assert.ok(Math.abs(actual - sample.expected[key]) < 1e-6, `${sample.weapon}/${sample.height}/${key}: changed from the pre-refactor solution`);
    }
  }
  targetHeight = 0; roofHeight = 0;
  console.log('Fixed mortar compatibility fixtures passed (terrain, roofs, wind and both weapons).');
}

async function testImport() {
  const input = plans.read(JSON.stringify({items:[{type:'marker'},{type:'marker'}]}));
  for (const failAt of [0,1,null]) {
    let calls = 0, id = 0;
    const result = await plans.importItems(input, { existing: () => null, uid: () => `test${++id}`,
      save: async () => calls++ !== failAt, wait: async () => {} });
    assert.equal(result.imported, failAt == null ? 2 : failAt);
    assert.equal(calls, failAt == null ? 2 : failAt + 1, 'import continued after a failure');
  }
  for (const text of ['null', '{}', '{"items":{}}', 'broken']) assert.throws(() => plans.read(text), /valid plan/);
  assert.throws(() => plans.read('[]'), /No markings/);
  let merged;
  await plans.importItems([{type:'fia',caches:['002003','004005']}], { existing: () => ({id:'fia123',caches:['002003']}),
    uid: () => 'unused', save: async it => { merged=it; return true; }, wait: async () => {} });
  assert.equal(merged.id, 'fia123');
  assert.deepEqual(Array.from(merged.caches), ['002003','004005']);
  console.log('Import success, total failure, partial failure, validation and FIA merging passed.');
}

async function testRestore() {
  const items = [{id:'mark1',type:'marker'}, {id:'mark2',type:'marker'}];
  for (const status of [503, 400, undefined, 429, 401]) {
    const live = new Map(), backup = plans.backup(), me = {};
    backup.begin(me, items);
    const result = await plans.restore(items, { current: () => live, active: () => true, attempts: 2,
      upload: async () => { throw Object.assign(new Error('unavailable'), {status}); }, wait: async () => {} });
    assert.ok(result.failed > 0);
    assert.deepEqual(Array.from(backup.items(me, [...live.values()]), it => it.id), ['mark1','mark2']);
    assert.equal(backup.items({}, []).length, 0, 'backup leaked to another session');
  }
  const live = new Map(), backup = plans.backup(), me = {};
  backup.begin(me, items);
  let calls = 0;
  const partial = await plans.restore(items, { current: () => live, active: () => true,
    upload: async item => { if (calls++ === 1) throw new Error('network'); live.set(item.id,item); }, wait: async () => {} });
  assert.equal(partial.uploaded, 1); assert.equal(partial.failed, 1);
  assert.equal(backup.items(me, [...live.values()]).length, 2);
  live.set('mark2', {...items[1],label:'new edit'}); backup.acknowledge(me, live);
  assert.equal(backup.items(me, [...live.values()]).find(it => it.id==='mark2').label, 'new edit');
  live.delete('mark2');
  assert.equal(backup.items(me, [...live.values()]).length, 1, 'acknowledged deletion was resurrected');
  const delayed = await plans.restore(items, { current: () => new Map(), active: () => true,
    upload: async () => {}, wait: async () => {} });
  assert.equal(delayed.pending.length, 2, 'successful POST lost items before SSE acknowledgement');
  let tries = 0;
  const retried = await plans.restore([items[0]], { current: () => new Map(), active: () => true,
    upload: async () => { if (!tries++) throw Object.assign(new Error('rate'), {status:429}); }, wait: async () => {} });
  assert.equal(retried.uploaded, 1); assert.equal(retried.failed, 0);
  let active = true;
  const cancelled = await plans.restore(items, { current: () => new Map(), active: () => active,
    upload: async () => { active=false; }, wait: async () => {} });
  assert.equal(cancelled.cancelled, true);
  console.log('Restore failures, retry limits, expiry, cancellation, delayed acknowledgement and backup retention passed.');
}

function testScopedGuns() {
  const context = vm.createContext({window:{}});
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'static/shot-core.js'), 'utf8'),context);
  const {SCOPES} = context.window.ShotCore({});
  for (const [k,g] of Object.entries(SCOPES)) if (g.lines)
    g.lines.forEach((l,i) => i && assert.ok(l[0] > g.lines[i-1][0] && l[1] > g.lines[i-1][1], `${k}: range lines out of order`));
  if (process.argv.includes('--scoped-guns')) process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(SCOPES).map(([k,g])=>[k,g.round])))+'\n');
  const file = path.join(__dirname,'static/data/bullets.json');
  if (fs.existsSync(file)) {
    const rounds = JSON.parse(fs.readFileSync(file,'utf8')).rounds;
    for (const g of Object.values(SCOPES)) assert.ok(rounds[g.round], `bullets.json has no ${g.round}`);
  }
  console.log(`Scoped guns are valid${fs.existsSync(file) ? ' and their rounds exist in bullets.json' : ''}.`);
}

// The shot calculator in the wind: a crosswind from the left and from the right are mirror images (same hold and flight
// time, opposite aim-off), and a light head or tail wind barely moves a bullet's hold. The measured wind runs once
// lifted a downhill RPK shot 3-4 m in a crosswind from one side and dropped it from the other.
function testShotWind() {
  const files = ['rockets.json', 'bullets.json'].map(f => path.join(__dirname, 'static/data', f));
  if (!files.every(f => fs.existsSync(f))) return;
  const ctx = vm.createContext({ window: {}, Math });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'static/shot-core.js'), 'utf8'), ctx);
  let below = 0; // target ground height; shot due south from [0, 0], whose ground is 0
  const windParts = (wind, az) => {
    if (!wind || !(wind.s > 0)) return { along: 0, across: 0 };
    const toward = ((wind.d + 180) - az) * Math.PI / 180;
    return { along: wind.s * Math.cos(toward), across: wind.s * Math.sin(toward) };
  };
  const SC = ctx.window.ShotCore({ ground: p => (p[1] < 0 ? below : 0), hasGround: () => true, windParts, fmtDist: m => `${m} m`,
    dist: (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]), bearing: () => 180 });
  SC.setRockets(JSON.parse(fs.readFileSync(files[0], 'utf8')));
  SC.setBullets(JSON.parse(fs.readFileSync(files[1], 'utf8')));
  const solve = (l, r, D, dh, wind) => { below = dh; return SC.rocketSolve({ from: [0, 0], to: [0, -D], rocket: { l, r, s: 'iron' }, wind, h1: 1.6, h2: 1 }); };
  const cases = [['RPK-74N', '7N6 (RPK-74)', 272, -52], ['SVD', '7N1 (SVD)', 600, 40], ['RPG-7', 'PG-7VM', 250, -30], ['RPG-22', 'PG-22', 150, 20], ['M72A3', 'M72A3', 200, 0]];
  for (const [l, r, D, dh] of cases) {
    const L = solve(l, r, D, dh, { s: 12, d: 90 }), R = solve(l, r, D, dh, { s: 12, d: 270 });
    const lift = x => D * Math.tan((x.sol.e - Math.atan2(x.H, D) * 180 / Math.PI) * Math.PI / 180); // bore above the target, m
    // a bullet's wind is flown from its drag, so it mirrors exactly; a rocket's comes from the runs flown from each side,
    // which the game shows to be mirror images to a few cm (rockettest.py score's wind report)
    const tol = SC.SCOPES[l] ? { lift: 0.05, t: 0.01, aim: 0.02 } : { lift: 0.15, t: 0.02, aim: 0.05 };
    assert.ok(Math.abs(lift(L) - lift(R)) < tol.lift, `${l} ${r}: crosswind from the left and right need different elevations`);
    assert.ok(Math.abs(L.sol.t - R.sol.t) < tol.t, `${l} ${r}: crosswind changes the flight time with its side`);
    assert.ok(Math.abs(L.aimOff + R.aimOff) < tol.aim, `${l} ${r}: crosswind aim-off isn't mirrored`);
    if (SC.SCOPES[l]) for (const d of [0, 180]) {
      const calm = solve(l, r, D, dh, null), w = solve(l, r, D, dh, { s: 3, d });
      assert.ok(Math.abs(lift(w) - lift(calm)) < 0.25, `${l} ${r}: a 3 m/s ${d ? 'head' : 'tail'} wind moves the shot by metres`);
    }
  }
  console.log('Shot calculator crosswinds mirror, light head and tail winds barely move a bullet.');
  const raw = JSON.parse(fs.readFileSync(files[0], 'utf8')).rockets;
  // A rocket's wind, from rockets.json's measured winds (format 2): at a wind and elevation that were flown it is that
  // run exactly; from the left it is the left runs, not the right ones mirrored; between two wind speeds it lies
  // between their runs.
  for (const [name, R] of Object.entries(SC.rockets.rockets)) {
    if (!R.winds) continue;
    const i0 = R.elevs.indexOf(0), k = Math.floor(R.windLen / 2);
    const run = (from, speed) => R.winds.find(r => r.from === from && r.speed === speed);
    const wind = (along, fromRight) => SC.rocketWind(R, 0, { along, fromRight })[k];
    for (const r of R.winds) {
      const got = r.from === 'right' ? wind(0, r.speed) : r.from === 'left' ? wind(0, -r.speed) : r.from === 'tail' ? wind(r.speed, 0) : wind(-r.speed, 0);
      got.forEach((v, c) => assert.ok(Math.abs(v - r.d[i0][k][c]) < 1e-9, `${name}: the ${r.speed} m/s ${r.from} wind isn't its run`));
    }
    const lo = run('right', 5), hi = run('right', 10);
    if (lo && hi) wind(0, 7.5).forEach((v, c) => assert.ok(Math.abs(v - (lo.d[i0][k][c] + hi.d[i0][k][c]) / 2) < 1e-9, `${name}: 7.5 m/s isn't halfway between 5 and 10`));
  }
  console.log('Rocket winds are the runs flown, blended between their speeds.');
  // The rockets' last frames are dropped where a table jumps, and the flights carried on to the moment the rocket blows
  // up: no table the calculator reads bends at the end more than a smooth flight can, the still-air flights reach the
  // self-destruct time, and no wind table loses more than a tenth.
  for (const [name, R] of Object.entries(SC.rockets.rockets)) {
    const n0 = raw[name].calm[0].length, calm = R.calm[0].length;
    assert.ok(R.calm.every(c => c.length === calm) && (calm - 1) * R.dt >= R.life, `${name}: still-air flights stop short of its self-destruct time`);
    const winds = R.winds ? R.winds.flatMap(r => r.d.filter(Boolean).map(a => [a, 0.05 * r.speed, [0, 1, 2]]))
      : [[R.head, 0.05, [0, 1]], [R.tail, 0.05, [0, 1]], [R.cross, 0.05, [2]]];
    assert.ok(winds.every(([a]) => a.length === R.windLen) && R.windLen >= n0 * 0.9, `${name}: wind tables trimmed unevenly or too far`);
    for (const [a, lim, cols] of [...R.calm.map(c => [c, 0.8, [0, 1]]), ...winds]) for (let k = Math.floor(n0 * 0.9); k < a.length; k++)
      for (const i of cols) assert.ok(Math.abs(a[k][i] - 2 * a[k - 1][i] + a[k - 2][i]) <= lim, `${name}: a table jumps at frame ${k}`);
  }
  console.log('Rocket flights end without jumps, at the moment they blow up.');
  // A launcher's range is how far its rocket gets before it self-destructs, at the target's height: just inside it
  // solves (and lands before the rocket blows up), just outside it says why it can't.
  const still = { along: 0, fromRight: 0 };
  for (const [name, R] of Object.entries(SC.rockets.rockets)) for (const H of [-60, 0, 30]) {
    const far = SC.rocketAim(R, R.reach + 5, H, still);
    const at = Math.floor(+(/([\d.]+) m away at the most at this height/.exec(far.err || '') || [])[1]);
    assert.ok(at > 0 && at <= R.reach, `${name}: no range given at ${H} m (${far.err})`);
    const inside = SC.rocketAim(R, at - 1, H, still), outside = SC.rocketAim(R, at + 2, H, still);
    assert.ok(!inside.err && inside.t <= R.life, `${name}: ${at - 1} m at ${H} m should solve before it blows up (${inside.err})`);
    assert.ok(/self-destructs/.test(outside.err || ''), `${name}: ${at + 2} m at ${H} m should be out of range`);
  }
  console.log('Rocket launchers stop at the range their rocket reaches before it self-destructs.');
}

async function testRoomEvents() {
  const source = fs.readFileSync(path.join(__dirname, 'static/room-events.js'), 'utf8');
  const events = fetch => {
    const ctx = vm.createContext({ fetch, AbortController, TextDecoder, console,
      setTimeout: callback => { queueMicrotask(callback); return 0; }, clearTimeout: () => {} });
    vm.runInContext(source + '\nglobalThis.model = RoomEvents;', ctx);
    return ctx.model;
  };
  const response = text => {
    // Split every byte, including the middle of a UTF-8 character and SSE delimiters.
    const bytes = new TextEncoder().encode(text);
    return new Response(new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    }}), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const calls = [], messages = [];
  const Stream = events(async (url, options) => {
    calls.push({ url, options });
    return response(': comment\r\nretry: 1500\r\n\r\ndata: {"label":"café"}\r\n\r\nevent: bye\r\ndata: {"reason":"Done"}\r\n\r\n');
  });
  const stream = new Stream('/api/events', { id: 'session', token: 'private-token' });
  await new Promise(resolve => {
    stream.onmessage = e => messages.push(JSON.parse(e.data));
    stream.addEventListener('bye', () => { stream.close(); resolve(); });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/events');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(JSON.parse(calls[0].options.body).token, 'private-token');
  assert.equal(messages[0].label, 'café');
  assert.equal(stream.retry, 1500);
  assert.equal(stream.readyState, Stream.CLOSED);

  let attempts = 0;
  const Retry = events(async () => {
    attempts++;
    if (attempts === 1) throw new Error('Network blip');
    if (attempts === 2) return response('data: first\n\n'); // EOF should reconnect too
    return response('data: second\n\nevent: bye\ndata: end\n\n');
  });
  const retried = new Retry('/api/events', { id: 'session', token: 'secret' });
  const received = [];
  await new Promise(resolve => {
    retried.onmessage = e => received.push(e.data);
    retried.addEventListener('bye', () => { retried.close(); resolve(); });
  });
  assert.equal(attempts, 3);
  assert.deepEqual(received, ['first', 'second']);

  for (const status of [400, 401, 403, 404, 405]) {
    let requests = 0;
    const Expired = events(async () => { requests++; return new Response('{}', { status }); });
    const expired = new Expired('/api/events', { id: 'session', token: 'secret' });
    await new Promise(resolve => { expired.onerror = resolve; });
    assert.equal(expired.readyState, Expired.CLOSED);
    assert.equal(requests, 1);
  }
  console.log('POST event streams: split UTF-8/frames, credentials outside URLs, reconnects and expired sessions passed.');
}

(async () => {testMortarLimitsAndParity(); testTerrainInvalidation(); testMortarCompatibilityFixtures(); testScopedGuns(); testShotWind(); await testImport(); await testRestore(); await testRoomEvents();})().catch(e=>{console.error(e);process.exitCode=1;});

// Exercise the builder's real item factory and classifier against every catalog entry.
function testBaseConstruction() {
  const ctx = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'static/construction.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'static/base-items.js'), 'utf8')+'\nglobalThis.factory = BaseItems;', ctx);
  const builder = ctx.factory({ catalog: ctx.window.ConstructionCatalog, state: () => ({arc:60,postRange:400,sectorCount:4}),
    uid: () => 'test-item', nextLabel: t => t, myColor: () => '#6cb8ff', friendly: '#6cb8ff',
    roundXZ: p => p.map(v=>Math.round(v*10)/10), bearing: () => 90, dist: (a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]) });
  const items = [];
  for (const [key, def] of Object.entries(ctx.window.ConstructionCatalog)) {
    const it = builder.makeItem(key, def.kind === 'line' ? [[100,100], [120,100]] : [100,100], [120,100]);
    assert.equal(it.type, def.type);
    assert.equal(builder.toolOf(it), key);
    items.push(JSON.parse(JSON.stringify(it)));
  }
  assert.equal(builder.toolOf({ type: 'emplacement', kind: 'mg' }), 'lmg');
  assert.equal(builder.toolOf({ type: 'emplacement', kind: 'unknown' }), null);
  assert.equal(builder.toolOf({ type: 'construct', kind: 'lmg' }), null);
  // Every new object must have visible, finite 3D geometry and a readable label.
  const view = vm.createContext({ window: ctx.window, console: { warn: (...args) => { throw new Error(String(args)); } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'static/3d/marks.js'), 'utf8') + '\nglobalThis.build = Marks.build;', view);
  for (const it of items) {
    const rendered = view.build(new Map([['Builder', { color: '#6cb8ff', items: new Map([[it.id, it]]) }]]), { ground: () => 0 });
    assert.ok(rendered.boxes.length > 0, `Missing 3D geometry for ${it.kind}`);
    assert.ok(rendered.boxes.every(Number.isFinite), `Invalid 3D geometry for ${it.kind}`);
    assert.equal(rendered.labels.length, 1, `Missing 3D label for ${it.kind}`);
    const withoutLabel = { ...it, label: '' };
    const unnamed = view.build(new Map([['Builder', { items: new Map([[it.id, withoutLabel]]) }]]), { ground: () => 0 });
    assert.equal(unnamed.labels[0].text, ctx.window.ConstructionCatalog[it.kind].name);
  }
  // Feed these actual browser payloads to Python validation in the server tests.
  if (process.argv.includes('--construction-items')) process.stdout.write(JSON.stringify(items) + '\n');
  console.log(`Base construction: ${items.length} catalog objects and legacy MG compatibility passed`);
}
testBaseConstruction();
if (!process.argv.includes('--construction-items')) require('./test_light.cjs')();
if (!process.argv.includes('--construction-items')) require('./test_regressions.cjs')().catch(err => { console.error(err); process.exitCode = 1; });

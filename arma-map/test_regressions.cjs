// Deterministic races and LOS fixtures against the actual shared browser scripts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { gzipSync } = require('node:zlib');
const source = name => fs.readFileSync(path.join(__dirname, 'static', name), 'utf8');

async function syncRaces() {
  const ctx = vm.createContext({ setTimeout });
  vm.runInContext(source('plan-sync.js') + '\nglobalThis.sync = PlanSync;', ctx);
  const sync = ctx.sync, me = {}, backup = sync.backup(), a = { id: 'a' }, b = { id: 'b' };
  backup.begin(me, [a, b]);
  const live = new Map([['b', b]]), uploads = [];
  let resume;
  const blocked = new Promise(resolve => { resume = resolve; });
  const restore = sync.restore([a, b], { current: () => live, active: () => true,
    deleted: id => backup.deleted(me, id), upload: async item => { uploads.push(item.id); await blocked; } });
  live.delete('b'); backup.remove(me, 'b'); resume();
  await restore;
  assert.deepEqual(uploads, ['a']);
  assert.equal(backup.items(me, []).some(item => item.id === 'b'), false);
  // The delete arrives while its own restore upload is already on the network.
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; }), removed = [];
  backup.begin(me, [b]);
  const late = sync.restore([b], { current: () => new Map(), active: () => true,
    deleted: id => backup.deleted(me, id), upload: () => waiting, remove: async id => removed.push(id) });
  backup.remove(me, 'b'); finish();
  const result = await late;
  assert.deepEqual(removed, ['b']); assert.equal(result.pending.length, 0);
  // Submitted intent is durable before its echo; an older echo cannot overwrite a newer edit.
  backup.begin(me, []); backup.stage(me, { id: 'b', label: 'new' });
  assert.equal(backup.items(me, [{ id: 'b', label: 'old' }])[0].label, 'new');
  backup.remove(me, 'b'); assert.equal(backup.items(me, [{ id: 'b', label: 'old' }]).length, 0);
  const write = sync.writer(), order = [];
  let release;
  const pause = new Promise(resolve => { release = resolve; });
  const create = write(me, 'b', async () => { order.push('create'); await pause; });
  const move = write(me, 'b', async () => order.push('move'));
  const remove = write(me, 'b', async () => order.push('delete'));
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(order, ['create']); release();
  await Promise.all([create, move, remove]); assert.deepEqual(order, ['create', 'move', 'delete']);
  await write(me, 'b', async () => { throw Error('network'); }).catch(() => {});
  await write(me, 'b', async () => order.push('retry'));
  assert.equal(order.at(-1), 'retry');
}

async function losFixtures() {
  const raw = new Uint8Array(501 * 501 * 2 + 3 * 1000 * 1000);
  new Uint16Array(raw.buffer, 0, 501 * 501).fill(1234);
  const tile = gzipSync(raw), requested = [];
  let fail = true;
  const ctx = vm.createContext({ Response, DecompressionStream, setTimeout,
    fetch: async url => {
      requested.push(url);
      if (url.includes('retry') && fail) { fail = false; return new Response('', { status: 503 }); }
      return new Response(tile);
    } });
  const fixtureCode = `
    globalThis.fixture = {
      configure() {
        CFG = {size: 6000, losDir: 'tiles'}; index = {version: 1};
        tileSet = new Set(Array.from({length:100},(_,i)=> Math.floor(i/10)+'_'+(i%10)));
        tileSet.add('retry'); plantSrc = {tiles: new Set()};
      }, loadArea, loadTile, groundAt,
      finish() { pinned.clear(); trim(tiles); trim(plantTiles); return tiles.size; },
      size() { return tiles.size; },
      large() { CFG.size = 20000; return loadArea(0,0,20000,20000); },
      foliage() {
        CFG = {size: 1000}; UNIT = 1; tiles.clear(); plantTiles.clear();
        tileSet = new Set(['0_0','1_0']);
        const ground = {ter:new Uint16Array(TN*TN),top:new Uint8Array(SN*SN),kind:new Uint8Array(SN*SN)};
        for (let r=0;r<SN;r++) {ground.kind[r*SN+20]=1; ground.top[r*SN+20]=40;}
        tiles.set('0_0',ground); tiles.set('1_0',ground);
        profiles = [{reach:20,nS:40,half:new Float32Array(40).fill(20),bands:[{d:25,cover:new Float32Array(40).fill(.2)}]}];
        const plant = x => ({x:[x],z:[250],base:[0],kind:[0],scale:[1],
          start:Uint32Array.from({length:NB*NB+1},(_,i)=>i),items:new Uint32Array(NB*NB)});
        plantTiles.set('0_0',plant(500)); plantTiles.set('1_0',plant(0));
        let calls = 0; const original = addProfile;
        addProfile = (...args) => {calls++; original(...args);};
        const first=compute({xz:[480,250],dir:90,arc:0,range:40,eyeH:1,targetH:1,cell:2.5});
        const once=calls;
        const results=[first];
        for(const xz of [[499,250],[500,250],[510,250]]) for(const strength of [0,.5,1.5]) for(const arc of [0,45,360])
          results.push(compute({xz,dir:90,arc,range:80,eyeH:2,targetH:1,cell:2.5,strength,elev:[-10,45]}));
        addProfile = original; return {calls:once,results:results.map(r=>Array.from(r.cells))};
      }
    };`;
  vm.runInContext(source('los-worker.js') + fixtureCode, ctx);
  const f = ctx.fixture; f.configure();
  await assert.rejects(f.loadTile('retry'), /503/);
  await f.loadTile('retry'); // rejected pending promise was released
  await f.loadArea(0, 0, 4999, 4999);
  assert.equal(f.size(), 100); assert.equal(f.groundAt(250, 250), 12.34);
  assert.ok(f.finish() <= 90);
  await assert.rejects(f.large(), /tile budget/);
  const optimized=f.foliage();
  assert.equal(optimized.calls, 2, 'one boundary crown should be counted once in each of the two identical rays');
  const reference=vm.createContext({});
  // Undo the two skip guards in a reference worker; later targets must still see intervening obstructions.
  vm.runInContext(source('los-worker.js').replace('if (bk !== plantBucket)', 'if (true)')
    .replace('if (cells[k] !== CLEAR)', 'if (true)') + fixtureCode,reference);
  assert.deepEqual(JSON.parse(JSON.stringify(optimized)),JSON.parse(JSON.stringify(reference.fixture.foliage())),
    'LOS skips changed near-eye, tile-boundary, foliage-strength or far-obstruction results');
}

function ringSlope() {
  const ctx = vm.createContext({});
  vm.runInContext(source('3d/mortar.js') + '\nglobalThis.mortar = Mortar;', ctx);
  const tables = JSON.parse(fs.readFileSync(path.join(__dirname, 'static/data/mortar-tables.json')));
  const from = [6400, 6400], ground = (x, z) => z > 6420 ? 500 : 0;
  const rings = ctx.mortar.reach(tables, 'M252', 'HE M821', from, null, ground).rings;
  for (const charge of [0, 1]) {
    const ring = rings.find(r => r.ring === charge);
    assert.ok(ring.pts[0][1] - from[1] < 30, `charge ${charge} outline passed through ascending hillside`);
  }
}

function losRecovery() {
  let now = 0, worker, wakeups = [];
  class Worker {
    constructor() { worker = this; this.requests = []; }
    postMessage(request) { this.requests.push(request); }
  }
  const ctx = vm.createContext({ Worker, Date: { now: () => now }, console: { error() {} }, setTimeout: callback => wakeups.push(callback) });
  vm.runInContext(source('3d/los.js') + '\nglobalThis.create = Los;', ctx);
  const los = ctx.create({}, () => {}), args = [[100, 100], 0, 90, 200, 1, 1];
  los.grid(...args);
  worker.onmessage({ data: { id: worker.requests[0].id, error: 'tile 503' } });
  los.grid(...args); assert.equal(worker.requests.length, 1, 'retry has no backoff');
  los.grid([200, 200], ...args.slice(1)); assert.equal(worker.requests.length, 2, 'one failure disabled other queries');
  now = 5100; wakeups.forEach(callback => callback()); los.grid(...args);
  assert.equal(worker.requests.length, 3);
  worker.onmessage({ data: { id: worker.requests[2].id, cells: [2] } });
  assert.equal(los.error, null); assert.equal(los.grid(...args).cells[0], 2);
  // Shared 3D adapter must key results by dataset and send the newly selected config.
  let model = 'profiles';
  const selectable = ctx.create(() => ({ model, profiles: { json: `${model}/profiles.json` } }), () => {});
  selectable.grid(...args);
  worker.onmessage({ data: { id: worker.requests[0].id, cells: [2] } });
  model = 'mesh';
  assert.equal(selectable.grid(...args), null);
  assert.equal(worker.requests[1].model, 'mesh');
  assert.equal(worker.requests[1].cfg.profiles.json, 'mesh/profiles.json');
  worker.onmessage({ data: { id: worker.requests[1].id, cells: [1] } });
  assert.equal(selectable.grid(...args).cells[0], 1);
  model = 'profiles';
  assert.equal(selectable.grid(...args).cells[0], 2);
  assert.equal(worker.requests.length, 2, 'switching back should reuse its own cached result');
}

async function run() {
  await syncRaces(); await losFixtures(); losRecovery(); ringSlope();
  console.log('Synchronization races, LOS tile retention/retry, boundary foliage and ascending hillside checks passed.');
}
module.exports = run;
if (require.main === module) run().catch(err => { console.error(err); process.exitCode = 1; });

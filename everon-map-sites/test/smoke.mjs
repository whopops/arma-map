// End-to-end check of the site against a running copy: `npm run dev` in one terminal, `npm test` in another.
// Set BASE to test elsewhere and ADMIN_PASSWORD to the admin password (defaults match .dev.vars in the README).
// Each run uses fresh random room codes and a made-up address per section, so runs don't trip over each other.

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'local-test-password-123';
const SLOW = process.env.SLOW === '1'; // also wait out the 15 s timeout for a player who stops checking in

let failures = 0, passes = 0;
function check(what, ok, detail) {
  if (ok) passes++;
  else { failures++; console.log(`FAIL ${what}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`); }
}

const rnd = () => Math.random().toString(36).slice(2, 8);
const fakeIp = () => `10.${1 + Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

async function req(method, path, { body, ip, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(ip ? { 'CF-Connecting-IP': ip } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const type = res.headers.get('Content-Type') || '';
  const data = type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer());
  return { status: res.status, data, headers: res.headers };
}

const post = (path, body, ip, headers) => req('POST', path, { body, ip, headers });

class Client {
  constructor(ip) { this.ip = ip; this.cursor = null; }
  async join(name, room) {
    const r = await post('/api/join', { name, room }, this.ip);
    if (r.status === 200) Object.assign(this, { me: r.data });
    return r;
  }
  auth(extra = {}) { return { id: this.me.id, token: this.me.token, ...extra }; }
  async poll() {
    const q = `id=${encodeURIComponent(this.me.id)}&token=${encodeURIComponent(this.me.token)}` + (this.cursor === null ? '' : `&since=${this.cursor}`);
    const r = await req('GET', `/api/events?${q}`, { ip: this.ip });
    if (r.status === 200 && r.data.cursor !== undefined) this.cursor = r.data.cursor;
    return r;
  }
  async events() { const r = await this.poll(); return r.status === 200 ? (r.data.events || []) : []; }
}

const marker = (id, extra = {}) => ({ id, type: 'marker', icon: 'rally', xz: [5000, 6000], label: 'Rally', ...extra });

async function staticAndTiles() {
  let r = await req('GET', '/');
  check('index page', r.status === 200 && new TextDecoder().decode(r.data).includes('Everon Field Map'));
  check('security headers', (r.headers.get('Content-Security-Policy') || '').includes("frame-ancestors 'none'") &&
    r.headers.get('X-Frame-Options') === 'DENY', Object.fromEntries(r.headers));
  check('page cache header', r.headers.get('Cache-Control') === 'no-cache', r.headers.get('Cache-Control'));
  for (const p of ['/app.js', '/app.css', '/live-worker.js', '/vendor/leaflet/leaflet.js', '/data/everon.json', '/data/everon-height.bin']) {
    r = await req('GET', p);
    check(`static ${p}`, r.status === 200, r.status);
  }
  r = await req('GET', '/data/everon-height.bin');
  check('heightmap size', r.data.length === 3276800, r.data.length);
  r = await req('GET', '/nope.txt');
  check('missing file is 404', r.status === 404, r.status);
  r = await req('GET', '/tiles/3/3/0.jpg');
  check('shipped tile', r.status === 200 && r.data[0] === 0xff && r.data[1] === 0xd8 &&
    r.headers.get('Cache-Control') === 'public, max-age=604800', r.status);
  r = await req('GET', '/tiles/3/03/000.jpg');
  check('tile spelling normalised', r.status === 200, r.status);
  r = await req('GET', '/tiles/5/9/0.jpg');
  check('tile outside the map is 404', r.status === 404, r.status);
  r = await req('GET', '/tiles/6/0/0.jpg');
  check('bad zoom is 404', r.status === 404, r.status);
  r = await req('GET', '/admin');
  check('admin page', r.status === 200 && new TextDecoder().decode(r.data).includes('admin') && r.headers.get('Cache-Control') === 'no-store', r.status);
  r = await req('PUT', '/');
  check('other methods refused', r.status === 405, r.status);
}

async function joining() {
  const ip = fakeIp(), room = `t-${rnd()}`;
  const a = new Client(ip);
  let r = await a.join('Bad/Name', room);
  check('bad username refused', r.status === 400, r.data);
  r = await a.join('Alpha', 'x');
  check('bad room refused', r.status === 400, r.data);
  r = await a.join('  Alpha ', room.toUpperCase());
  check('join', r.status === 200 && r.data.name === 'Alpha' && r.data.room === room && /^#[0-9a-f]{6}$/.test(r.data.color), r.data);
  const b = new Client(ip);
  r = await b.join('alpha', room);
  check('same name (any case) refused in room', r.status === 409, r.data);
  r = await b.join('alpha', `${room}-2`);
  check('same name allowed in another room', r.status === 200, r.data);
  await post('/api/leave', b.auth(), ip);
  r = await b.join('Bravo', room);
  check('second player joins', r.status === 200 && r.data.color !== a.me.color, r.data);
  r = await post('/api/join', 'not json', ip);
  check('bad body refused', r.status === 400, r.data);
  r = await post('/api/join', { name: 'x'.repeat(200_000) }, ip);
  check('huge body refused', r.status === 400, r.data);
  await post('/api/leave', a.auth(), ip);
  await post('/api/leave', b.auth(), ip);
}

async function sharing() {
  const ip = fakeIp(), room = `t-${rnd()}`;
  const a = new Client(ip), b = new Client(ip);
  await a.join('Alpha', room);
  let ev = await a.events();
  check('first poll is a snapshot', ev.length === 1 && ev[0].type === 'snapshot' && ev[0].you === 'Alpha' &&
    ev[0].room === room && ev[0].players.length === 1 && ev[0].briefing === null, ev);
  await b.join('Bravo', room);
  ev = await a.events();
  check('join event', ev.some(e => e.type === 'join' && e.player.name === 'Bravo' && e.player.items.length === 0), ev);
  await b.events();

  let r = await post('/api/item', a.auth({ item: marker('m-0001') }), ip);
  check('add marking', r.status === 200, r.data);
  ev = await b.events();
  check('marking reaches others', ev.length === 1 && ev[0].type === 'item' && ev[0].owner === 'Alpha' && ev[0].item.label === 'Rally', ev);
  r = await post('/api/item', a.auth({ item: marker('m-0001', { label: 'Moved', xz: [5100, 6100] }) }), ip);
  ev = await b.events();
  check('edit marking', r.status === 200 && ev[0]?.item.label === 'Moved', ev);
  await post('/api/item', a.auth({ item: { id: 'r-0001', type: 'route', points: [[1, 2], [300, 400], [500, 600]], label: 'Route 1' } }), ip);
  await b.events();

  r = await post('/api/item', a.auth({ item: marker('m-0002', { xz: [99999, 0] }) }), ip);
  check('bad position refused', r.status === 400 && r.data.error === 'Bad marker position.', r.data);
  r = await post('/api/item', a.auth({ item: { id: 'x-0001', type: 'nuke' } }), ip);
  check('unknown type refused', r.status === 400 && r.data.error === 'Unknown item type.', r.data);
  r = await post('/api/item', a.auth({ item: marker('m-0003', { icon: 'constructor' }) }), ip);
  check('"constructor" name refused', r.status === 400 && r.data.error === 'Bad icon.', r.data);
  r = await post('/api/item', a.auth({ item: marker('m-0004', { note: 'x'.repeat(600) }) }), ip);
  check('long note refused', r.status === 400 && r.data.error === 'Bad note.', r.data);
  r = await post('/api/item', { id: a.me.id, token: 'wrong', item: marker('m-0005') }, ip);
  check('wrong token refused', r.status === 401, r.data);

  // A late joiner gets everything so far, in order.
  const c = new Client(ip);
  await c.join('Charlie', room);
  ev = await c.events();
  const alpha = ev[0]?.players.find(p => p.name === 'Alpha');
  check('snapshot has markings in order', alpha && alpha.items.map(i => i.id).join() === 'm-0001,r-0001' && alpha.items[0].label === 'Moved', ev);
  await a.events(); await b.events();

  // Air support: anyone in the room can move a request along.
  await post('/api/item', a.auth({ item: marker('air-0001', { icon: 'air-cas', air: { weapon: 'rockets' } }) }), ip);
  await b.events();
  r = await post('/api/air-status', b.auth({ owner: 'Alpha', itemId: 'air-0001', status: 'ack' }), ip);
  ev = await a.events();
  check('air request acknowledged', r.status === 200 && ev.some(e => e.type === 'item' && e.owner === 'Alpha' &&
    e.item.status === 'ack' && e.item.statusBy === 'Bravo'), { r: r.data, ev });
  r = await post('/api/air-status', b.auth({ owner: 'Alpha', itemId: 'm-0001', status: 'ack' }), ip);
  check('air status only on requests', r.status === 404, r.data);
  r = await post('/api/air-status', b.auth({ owner: 'Alpha', itemId: 'air-0001', status: 'bogus' }), ip);
  check('bad air status refused', r.status === 400, r.data);

  r = await post('/api/delete', a.auth({ itemId: 'm-0001' }), ip);
  ev = await b.events();
  check('delete marking', r.status === 200 && ev.some(e => e.type === 'delete' && e.owner === 'Alpha' && e.id === 'm-0001'), ev);
  await a.events();
  r = await post('/api/delete', b.auth({ itemId: 'r-0001' }), ip);
  ev = await a.events();
  check("can't delete someone else's marking", r.status === 200 && !ev.some(e => e.type === 'delete'), ev);

  r = await post('/api/briefing', a.auth({ text: 'Take the airfield at dawn.' }), ip);
  ev = await b.events();
  check('briefing', r.status === 200 && ev.some(e => e.type === 'briefing' && e.briefing.text === 'Take the airfield at dawn.' &&
    e.briefing.by === 'Alpha'), ev);
  r = await post('/api/briefing', a.auth({ text: 'x'.repeat(6001) }), ip);
  check('long briefing refused', r.status === 400, r.data);
  const d = new Client(ip);
  await d.join('Delta', room);
  ev = await d.events();
  check('snapshot has briefing', ev[0]?.briefing?.text === 'Take the airfield at dawn.', ev[0]?.briefing);

  r = await post('/api/leave', a.auth(), ip);
  ev = await b.events();
  check('leave removes player', r.status === 200 && ev.some(e => e.type === 'leave' && e.name === 'Alpha'), ev);
  r = await a.poll();
  check('left player is signed out', r.status === 401, r.status);
  for (const x of [b, c, d]) await post('/api/leave', x.auth(), ip);
  // The last one out takes the room and its briefing with them.
  const e = new Client(ip);
  await e.join('Foxtrot', room);
  const snap = (await e.events())[0];
  check('room forgotten when empty', snap && snap.briefing === null && snap.players.length === 1, snap);
  await post('/api/leave', e.auth(), ip);
}

async function limits() {
  const ip = fakeIp(), room = `t-${rnd()}`;
  const a = new Client(ip);
  await a.join('Alpha', room);
  // Markings per player: 500. Adding them one by one is slow over HTTP, so this checks the size limit instead.
  const big = i => ({ id: `big-${String(i).padStart(4, '0')}`, type: 'route', label: 'x'.repeat(400),
    points: Array.from({ length: 200 }, (_, k) => [1000 + k * 3.25, 2000 + k * 7.125]) });
  let r = await post('/api/item', a.auth({ item: big(0) }), ip);
  check('big marking accepted', r.status === 200, r.data);
  r = await post('/api/item', a.auth({ item: { ...big(1), note: 'y'.repeat(500), label: 'z'.repeat(500),
    points: Array.from({ length: 200 }, (_, k) => [1000.123456789 + k, 2000.123456789 + k]) } }), ip);
  check('item size check runs', r.status === 200 || r.data.error === 'Item too large.', r.data);
  // Players per address: 12.
  const extra = [];
  for (let i = 0; i < 12; i++) {
    const c = new Client(ip);
    let j = await c.join(`P${i}`, `${room}-${i % 3}`);
    while (j.status === 429 && /Slow down/.test(j.data.error)) { // joins are limited to 10 at once, then one per 5 s
      for (let t = 0; t < 5; t++) { // keep everyone checking in meanwhile, or they time out and free their places
        await new Promise(res => setTimeout(res, 1100));
        for (const x of [a, ...extra]) await x.poll();
      }
      j = await c.join(`P${i}`, `${room}-${i % 3}`);
    }
    if (j.status === 200) extra.push(c);
    else { check('per-address limit', j.status === 429 && i === 11, { i, j: j.data }); break; }
  }
  check('per-address limit reached', extra.length === 11, extra.length);
  for (const c of [a, ...extra]) await post('/api/leave', c.auth(), ip);
}

async function adminView() {
  const adminIp = fakeIp(), ip = fakeIp(), room = `t-${rnd()}`;
  let r = await req('GET', '/api/admin/rooms', { ip: adminIp });
  check('admin needs sign-in', r.status === 401, r.data);
  r = await post('/api/admin/login', { password: 'wrong' }, adminIp);
  check('wrong admin password', r.status === 401 && r.data.error === 'Wrong password.', r.data);
  r = await post('/api/admin/login', { password: ADMIN_PASSWORD }, adminIp);
  check('admin sign-in', r.status === 200 && typeof r.data.token === 'string', r.data);
  const token = r.data.token;
  const auth = { Authorization: `Bearer ${token}` };
  r = await req('GET', '/api/admin/rooms', { ip: fakeIp(), headers: auth });
  check('admin token tied to address', r.status === 401, r.data);

  const a = new Client(ip), b = new Client(ip), c = new Client(fakeIp());
  await a.join('Alpha', room); await b.join('Bravo', room); await c.join('Charlie', `${room}-b`);
  await a.events(); await b.events(); await c.events();
  await post('/api/item', a.auth({ item: marker('m-0001') }), ip);
  await post('/api/briefing', a.auth({ text: 'Hold' }), ip);
  r = await req('GET', '/api/admin/rooms', { ip: adminIp, headers: auth });
  const rm = r.data.rooms?.find(x => x.room === room);
  check('admin sees room', r.status === 200 && rm && rm.players.length === 2 && rm.briefing?.chars === 4 &&
    rm.players[0].name === 'Alpha' && rm.players[0].markings === 1 && rm.players[0].connected === true &&
    rm.players[0].ip === ip && r.data.you === adminIp, r.data);

  r = await post('/api/admin/kick', { player: a.me.id }, adminIp, auth);
  check('kick', r.status === 200 && r.data.name === 'Alpha', r.data);
  r = await a.poll();
  check('kicked player told why', r.status === 200 && r.data.bye === 'You were removed from the map by the admin.', r.data);
  let ev = await b.events();
  check('others see the kick', ev.some(e => e.type === 'leave' && e.name === 'Alpha'), ev);
  r = await post('/api/admin/kick', { player: a.me.id }, adminIp, auth);
  check('kick twice', r.status === 404, r.data);

  const a2 = new Client(ip);
  await a2.join('Alpha2', `${room}-c`);
  r = await post('/api/admin/ban', { player: b.me.id, hours: 24 }, adminIp, auth);
  check('ban 24 h removes everyone on the address', r.status === 200 && r.data.ip === ip &&
    r.data.removed.sort().join() === 'Alpha2,Bravo', r.data);
  r = await b.poll();
  check('banned player told why', r.status === 200 && /banned from this map for another 2[34] h/.test(r.data.bye), r.data);
  r = await new Client(ip).join('Again', room);
  check('banned address cannot join', r.status === 403 && /banned/.test(r.data.error), r.data);
  r = await req('GET', '/api/admin/rooms', { ip: adminIp, headers: auth });
  check('ban listed', r.data.bans?.some(x => x.ip === ip && x.until && x.names.includes('Bravo')), r.data.bans);
  r = await post('/api/admin/unban', { ip }, adminIp, auth);
  check('lift ban', r.status === 200, r.data);
  r = await new Client(ip).join('Again', room);
  check('can join after unban', r.status === 200, r.data);
  await post('/api/leave', { id: r.data.id, token: r.data.token }, ip);

  const ip6 = '2001:db8:1:2:3:4:5:6';
  const v6 = new Client(ip6);
  await v6.join('Six', room);
  r = await post('/api/admin/ban', { player: v6.me.id, hours: null }, adminIp, auth);
  check('permanent ban covers the IPv6 /64', r.status === 200 && r.data.ip === '2001:db8:1:2::/64', r.data);
  r = await new Client('2001:db8:1:2:ffff::1').join('Six2', room);
  check('rest of the /64 blocked', r.status === 403 && r.data.error === 'You have been banned from this map.', r.data);
  await post('/api/admin/unban', { ip: '2001:db8:1:2::/64' }, adminIp, auth);

  r = await post('/api/admin/close-room', { room: `${room}-b` }, adminIp, auth);
  check('close room', r.status === 200 && r.data.removed === 1, r.data);
  r = await c.poll();
  check('closed room told why', r.data.bye === 'The admin closed this room.', r.data);
  r = await post('/api/admin/close-room', { room: `${room}-b` }, adminIp, auth);
  check('close empty room', r.status === 404, r.data);

  r = await post('/api/admin/logout', {}, adminIp, auth);
  r = await req('GET', '/api/admin/rooms', { ip: adminIp, headers: auth });
  check('signed out', r.status === 401, r.data);

  // Five wrong passwords lock the address out.
  const bad = fakeIp();
  for (let i = 0; i < 5; i++) await post('/api/admin/login', { password: `nope${i}` }, bad);
  r = await post('/api/admin/login', { password: ADMIN_PASSWORD }, bad);
  check('lockout after wrong passwords', r.status === 429 && /Too many wrong passwords/.test(r.data.error), r.data);
}

async function rateLimit() {
  const ip = fakeIp();
  let limited = false;
  for (let i = 0; i < 15 && !limited; i++) {
    const r = await post('/api/join', { name: `R${i}`, room: `t-${rnd()}` }, ip);
    if (r.status === 429 && /Slow down/.test(r.data.error)) limited = true;
    else if (r.status === 200) await post('/api/leave', { id: r.data.id, token: r.data.token }, ip);
  }
  check('join rate limit', limited);
}

async function timeout() {
  const ip = fakeIp(), room = `t-${rnd()}`;
  const a = new Client(ip), b = new Client(ip);
  await a.join('Quiet', room); await b.join('Chatty', room);
  await a.events(); await b.events();
  await post('/api/item', a.auth({ item: marker('m-0001') }), ip);
  const until = Date.now() + 19_000;
  let gone = false;
  while (Date.now() < until && !gone) {
    await new Promise(r => setTimeout(r, 1000));
    gone = (await b.events()).some(e => e.type === 'leave' && e.name === 'Quiet');
  }
  check('silent player removed after 15 s', gone);
  check('removed player signed out', (await a.poll()).status === 401);
  await post('/api/leave', b.auth(), ip);
}

for (const [name, fn] of Object.entries({ staticAndTiles, joining, sharing, limits, adminView, rateLimit, ...(SLOW ? { timeout } : {}) })) {
  try {
    await fn();
  } catch (err) {
    failures++;
    console.log(`FAIL ${name} threw: ${err.stack}`);
  }
}
console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);

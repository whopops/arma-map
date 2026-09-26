// Everon Field Map - server for ChatGPT Sites (Cloudflare Workers + D1).
//
// Does what the original server.py does: serves the web app and map tiles, relays shared markings between the
// players in a room, and runs the admin view (kick, ban, close rooms). The differences come from the platform:
//
// - There is no long-running process, so nothing lives in memory. Players, markings, room briefings, bans and
//   admin sign-ins are kept in the D1 database (binding DB), and each change is written as an event row.
// - There are no long-lived connections, so browsers ask for new events about once a second (GET /api/events)
//   instead of holding an event stream open. A player who stops asking for 15 s is taken off the map, as before.
// - There is no disk, so tiles missing from public/tiles are fetched from upstream and, if an R2 bucket is bound
//   as TILES, kept there.
// - Settings come from environment variables/secrets: EVERON_ADMIN_PASSWORD (12+ characters; without it the admin
//   view is off) and EVERON_ADMIN_ALLOW (optional comma-separated addresses or networks allowed to use it).
//   The player's address comes from the platform (CF-Connecting-IP), so there is no --behind-proxy.
//
// Nothing about players is kept after they leave: their markings go with them, and a room (with its briefing)
// disappears when its last player leaves.

import { validateItem, pyJsonSize, AIR_STATUSES } from './validate.js';
import { addrKey, parseIp, parseNet, inNet } from './net.js';

const TILE_UPSTREAM = 'https://reforger.recoil.org/map-tiles/everon/{z}/{x}/{y}/tile.jpg';

const GRACE_MS = 15_000;          // how long a player may go without checking in before their markings vanish
const SEEN_WRITE_MS = 3_000;      // check-ins closer together than this don't rewrite last_seen
const CONNECTED_MS = 5_000;       // the admin view shows a player as connected if they checked in this recently
const EVENT_KEEP_MS = 120_000;    // events older than this are pruned; a browser that far behind was dropped already
const REMOVED_KEEP_MS = 600_000;  // how long a removed player can still learn why
const MAX_EVENTS_PER_POLL = 500;  // a browser further behind than this gets a fresh snapshot instead
const MAX_ITEMS_PER_PLAYER = 500;
const MAX_PLAYER_BYTES = 2_000_000;  // all of one player's markings together
const MAX_BODY_BYTES = 100_000;
const MAX_PLAYERS = 1000;            // on the whole map
const MAX_ROOM_PLAYERS = 60;
const MAX_PLAYERS_PER_IP = 12;       // a LAN party or a household behind one address still fits
// Requests per address: a bucket of `burst` that refills at `rate` per second. "poll" is the once-a-second check-in,
// with room for a household or LAN party of players behind one address.
const RATE_LIMITS = { post: [20, 120], poll: [30, 120], join: [0.2, 10], tile: [60, 600], static: [20, 200] };
const USERNAME_RE = /^[A-Za-z0-9 _\-.[\]]{1,20}$/;
const ROOM_RE = /^[a-z0-9_-]{3,32}$/;
const ADMIN_SESSION_MS = 12 * 3600_000;  // a sign-in lasts at most this long
const ADMIN_IDLE_MS = 30 * 60_000;       // ...and ends after this long without the admin page open
const ADMIN_MAX_SESSIONS = 10;
const ADMIN_MAX_FAILURES = 5;            // wrong passwords from one address before it is locked out
const ADMIN_LOCKOUT_MS = 300_000;
// Wrong passwords from all addresses together before sign-in pauses for everyone, so guessing from many
// addresses at once gets nowhere either. Admins already signed in carry on.
const ADMIN_GLOBAL_MAX_FAILURES = 30;
const ADMIN_GLOBAL_WINDOW_MS = 15 * 60_000;
const ADMIN_MIN_PASSWORD = 12;
const MAX_BRIEFING_CHARS = 6000;
const COLORS = ['#ff6b6b', '#4dabf7', '#51cf66', '#fcc419', '#cc5de8', '#ff922b',
  '#22b8cf', '#f06595', '#94d82d', '#845ef7', '#20c997', '#e8590c'];
const ADMIN_PAGES = new Set(['/admin', '/admin.html', '/admin.js']);

// Sent with every response. The page runs only its own scripts (no inline ones), talks only to this site,
// and can't be framed by another site.
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; " +
    "form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

// The database tables, created on first use so the site needs no separate setup step (schema.sql has the same).
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, created INTEGER NOT NULL, briefing TEXT)`,
  `CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, token TEXT NOT NULL, room TEXT NOT NULL, ip TEXT NOT NULL,
    addr_key TEXT NOT NULL, name TEXT NOT NULL, lname TEXT NOT NULL, color TEXT NOT NULL, joined INTEGER NOT NULL,
    last_seen INTEGER NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS players_room_name ON players (room, lname)`,
  `CREATE INDEX IF NOT EXISTS players_last_seen ON players (last_seen)`,
  `CREATE INDEX IF NOT EXISTS players_addr_key ON players (addr_key)`,
  `CREATE TABLE IF NOT EXISTS items (player_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, size INTEGER NOT NULL,
    PRIMARY KEY (player_id, id))`,
  `CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, data TEXT NOT NULL,
    at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS events_room_seq ON events (room, seq)`,
  `CREATE INDEX IF NOT EXISTS events_at ON events (at)`,
  `CREATE TABLE IF NOT EXISTS removed (id TEXT PRIMARY KEY, reason TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS bans (ip TEXT PRIMARY KEY, until INTEGER, names TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, until INTEGER NOT NULL, seen INTEGER NOT NULL,
    addr_key TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS admin_failures (addr_key TEXT PRIMARY KEY, count INTEGER NOT NULL, first INTEGER NOT NULL,
    locked_until INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS admin_recent (at INTEGER NOT NULL)`,
];

let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db.batch(SCHEMA.map(s => db.prepare(s))).catch(err => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

// --- small helpers ----------------------------------------------------------

const enc = new TextEncoder();

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}

function tokenUrlsafe(bytes) {
  let s = '';
  for (const b of crypto.getRandomValues(new Uint8Array(bytes))) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

// Compares two strings in time that doesn't depend on where they differ (tokens and hashes have fixed lengths).
function sameString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const clen = s => [...s].length;

function json(code, obj, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  });
}

const reply = ([code, obj]) => json(code, obj);

function text(code, body, type = 'text/plain') {
  return new Response(body, { status: code, headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });
}

function secure(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

function audit(msg) {
  console.log(new Date().toISOString().replace('T', ' ').slice(0, 19), '[admin]', msg);
}

function banMessage(ban) {
  if (!ban.until) return 'You have been banned from this map.';
  const leftMin = Math.ceil(Math.max(0, ban.until - Date.now()) / 60_000);
  const hours = Math.floor(leftMin / 60), mins = leftMin % 60;
  const left = hours && mins ? `${hours} h ${mins} min` : hours ? `${hours} h` : `${mins} min`;
  return `You have been banned from this map for another ${left}.`;
}

// --- rate limits (per running copy of the site; the platform may run several) --------------------------------

const buckets = new Map(); // "kind address" -> [tokens, last time]

function allow(key, kind) {
  const [rate, burst] = RATE_LIMITS[kind];
  const now = Date.now() / 1000;
  if (buckets.size > 50_000) { // forget idle addresses
    for (const [k, b] of buckets) if (now - b[1] >= 600) buckets.delete(k);
  }
  const id = `${kind} ${key}`;
  let b = buckets.get(id);
  if (!b) { b = [burst, now]; buckets.set(id, b); }
  b[0] = Math.min(burst, b[0] + (now - b[1]) * rate);
  b[1] = now;
  if (b[0] < 1) return false;
  b[0] -= 1;
  return true;
}

// --- the map: rooms, players and their markings -----------------------------------------------------------

class Hub {
  constructor(db) { this.db = db; }

  eventStmt(room, ev) {
    return this.db.prepare('INSERT INTO events (room, data, at) VALUES (?, ?, ?)').bind(room, JSON.stringify(ev), Date.now());
  }

  async auth(pid, token) {
    if (typeof pid !== 'string' || typeof token !== 'string') return null;
    const p = await this.db.prepare('SELECT * FROM players WHERE id = ?').bind(pid).first();
    if (!p || !sameString(p.token, token)) return null;
    return p;
  }

  // Takes a player off the map with their markings; the room goes too if they were the last one in it.
  // `reason` is shown to them on the join screen. False if they had already gone.
  async remove(pid, reason = '') {
    const p = await this.db.prepare('DELETE FROM players WHERE id = ? RETURNING name, room').bind(pid).first();
    if (!p) return false;
    const now = Date.now();
    const stmts = [
      this.db.prepare('DELETE FROM items WHERE player_id = ?').bind(pid),
      this.eventStmt(p.room, { type: 'leave', name: p.name }),
      this.db.prepare('DELETE FROM rooms WHERE code = ?1 AND NOT EXISTS (SELECT 1 FROM players WHERE room = ?1)').bind(p.room),
    ];
    if (reason) stmts.push(this.db.prepare('INSERT OR REPLACE INTO removed (id, reason, at) VALUES (?, ?, ?)').bind(pid, reason, now));
    await this.db.batch(stmts);
    return true;
  }

  // Players who stopped checking in leave; old events and notes are pruned. Runs at most every few seconds.
  async reap() {
    const now = Date.now();
    if (now - Hub.lastReap < 2000) return;
    Hub.lastReap = now;
    const { results } = await this.db.prepare('SELECT id FROM players WHERE last_seen < ? LIMIT 100').bind(now - GRACE_MS).all();
    for (const r of results) await this.remove(r.id);
    if (now - Hub.lastPrune > 60_000) {
      Hub.lastPrune = now;
      await this.db.batch([
        this.db.prepare('DELETE FROM events WHERE at < ?').bind(now - EVENT_KEEP_MS),
        this.db.prepare('DELETE FROM removed WHERE at < ?').bind(now - REMOVED_KEEP_MS),
        this.db.prepare('DELETE FROM admin_recent WHERE at < ?').bind(now - ADMIN_GLOBAL_WINDOW_MS),
        this.db.prepare('DELETE FROM admin_sessions WHERE until < ?1 OR seen < ?2').bind(now, now - ADMIN_IDLE_MS),
        this.db.prepare('DELETE FROM admin_failures WHERE first < ?1 AND locked_until < ?2').bind(now - ADMIN_LOCKOUT_MS, now),
      ]);
    }
  }

  async join(name, room, ip) {
    const key = addrKey(ip);
    const ban = await bans(this.db).active(key);
    if (ban) return [403, { error: banMessage(ban) }];
    name = (typeof name === 'string' ? name : '').trim();
    room = (typeof room === 'string' ? room : '').trim().toLowerCase();
    if (!USERNAME_RE.test(name)) return [400, { error: 'Use 1-20 letters, numbers, spaces, - _ . [ ]' }];
    if (!ROOM_RE.test(room)) return [400, { error: 'Room codes are 3-32 letters, numbers, - or _.' }];
    await this.reap();
    const [all, fromIp, others] = await this.db.batch([
      this.db.prepare('SELECT count(*) AS n FROM players'),
      this.db.prepare('SELECT count(*) AS n FROM players WHERE addr_key = ?').bind(key),
      this.db.prepare('SELECT lname, color FROM players WHERE room = ?').bind(room),
    ]);
    const inRoom = others.results;
    if (all.results[0].n >= MAX_PLAYERS) return [503, { error: 'The map server is full right now. Try again later.' }];
    if (inRoom.length >= MAX_ROOM_PLAYERS) return [403, { error: `This room is full (${MAX_ROOM_PLAYERS} players).` }];
    if (fromIp.results[0].n >= MAX_PLAYERS_PER_IP) return [429, { error: 'Too many players from your address are on the map already.' }];
    const taken = [409, { error: 'That username is in use in this room right now. Pick another.' }];
    if (inRoom.some(p => p.lname === name.toLowerCase())) return taken;
    const used = new Set(inRoom.map(p => p.color));
    const color = COLORS.find(c => !used.has(c)) || COLORS[inRoom.length % COLORS.length];
    const now = Date.now();
    const p = { id: randomHex(8), token: randomHex(16), name, color, room };
    try {
      await this.db.batch([
        this.db.prepare('INSERT OR IGNORE INTO rooms (code, created, briefing) VALUES (?, ?, NULL)').bind(room, now),
        this.db.prepare(`INSERT INTO players (id, token, room, ip, addr_key, name, lname, color, joined, last_seen)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(p.id, p.token, room, ip, key, name, name.toLowerCase(), color, now, now),
        this.eventStmt(room, { type: 'join', player: { name, color, items: [] } }),
      ]);
    } catch (err) {
      if (/UNIQUE/i.test(String(err && err.message))) return taken; // someone took the name a moment ago
      throw err;
    }
    return [200, { id: p.id, token: p.token, name, color, room }];
  }

  // Everything in the room right now, and the event number it is up to.
  async snapshot(p) {
    const [seq, players, items, room] = await this.db.batch([
      this.db.prepare('SELECT coalesce(max(seq), 0) AS seq FROM events'),
      this.db.prepare('SELECT id, name, color FROM players WHERE room = ? ORDER BY joined, rowid').bind(p.room),
      this.db.prepare(`SELECT i.player_id, i.data FROM items i JOIN players p ON p.id = i.player_id
        WHERE p.room = ? ORDER BY i.rowid`).bind(p.room),
      this.db.prepare('SELECT briefing FROM rooms WHERE code = ?').bind(p.room),
    ]);
    const byId = new Map(players.results.map(o => [o.id, { name: o.name, color: o.color, items: [] }]));
    for (const it of items.results) byId.get(it.player_id)?.items.push(JSON.parse(it.data));
    const briefing = room.results[0]?.briefing;
    return {
      cursor: seq.results[0].seq,
      event: { type: 'snapshot', you: p.name, room: p.room, players: [...byId.values()], briefing: briefing ? JSON.parse(briefing) : null },
    };
  }

  // A browser checking in: the events since `since`, or a snapshot to start from.
  async poll(pid, token, since) {
    if (typeof pid !== 'string' || typeof token !== 'string') return json(401, { error: 'Unknown session.' });
    const p = await this.db.prepare('SELECT * FROM players WHERE id = ?').bind(pid).first();
    if (!p) {
      const gone = await this.db.prepare('SELECT reason FROM removed WHERE id = ?').bind(pid).first();
      return gone ? json(200, { bye: gone.reason }) : json(401, { error: 'Unknown session.' });
    }
    if (!sameString(p.token, token)) return json(401, { error: 'Unknown session.' });
    const now = Date.now();
    if (now - p.last_seen > SEEN_WRITE_MS) {
      await this.db.prepare('UPDATE players SET last_seen = ? WHERE id = ?').bind(now, pid).run();
    }
    const after = /^\d{1,15}$/.test(since || '') ? Number(since) : null;
    if (after !== null) {
      const { results } = await this.db.prepare('SELECT seq, data FROM events WHERE room = ? AND seq > ? ORDER BY seq LIMIT ?')
        .bind(p.room, after, MAX_EVENTS_PER_POLL + 1).all();
      if (results.length <= MAX_EVENTS_PER_POLL) {
        const cursor = results.length ? results[results.length - 1].seq : after;
        // The events are stored as JSON already; pass them on as they are.
        return new Response(`{"cursor":${cursor},"events":[${results.map(r => r.data).join(',')}]}`,
          { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      }
      // Too far behind: start again from a snapshot.
    }
    const snap = await this.snapshot(p);
    return json(200, { cursor: snap.cursor, events: [snap.event] });
  }

  async upsert(pid, token, item) {
    const p = await this.auth(pid, token);
    if (!p) return [401, { error: 'Session expired. Reload the page.' }];
    const err = validateItem(item);
    if (err) return [400, { error: err }];
    const stats = await this.db.prepare(`SELECT count(*) AS n, coalesce(sum(size), 0) AS total,
        (SELECT size FROM items WHERE player_id = ?1 AND id = ?2) AS cur FROM items WHERE player_id = ?1`)
      .bind(p.id, item.id).first();
    if (stats.cur === null && stats.n >= MAX_ITEMS_PER_PLAYER) return [400, { error: `Limit of ${MAX_ITEMS_PER_PLAYER} markings reached.` }];
    const size = pyJsonSize(item);
    if (stats.total - (stats.cur || 0) + size > MAX_PLAYER_BYTES) {
      return [400, { error: 'Your markings are too big altogether. Delete some first.' }];
    }
    await this.db.batch([
      // Only while the player is still on the map; updating in place keeps the marking's place in the order.
      this.db.prepare(`INSERT INTO items (player_id, id, data, size) SELECT ?1, ?2, ?3, ?4
          WHERE EXISTS (SELECT 1 FROM players WHERE id = ?1)
          ON CONFLICT (player_id, id) DO UPDATE SET data = excluded.data, size = excluded.size`)
        .bind(p.id, item.id, JSON.stringify(item), size),
      this.eventStmt(p.room, { type: 'item', owner: p.name, item }),
    ]);
    return [200, { ok: true }];
  }

  async setAirStatus(pid, token, owner, itemId, status) {
    if (!AIR_STATUSES.has(status) || typeof owner !== 'string' || typeof itemId !== 'string') {
      return [400, { error: 'Bad request status.' }];
    }
    const p = await this.auth(pid, token);
    if (!p) return [401, { error: 'Session expired. Reload the page.' }];
    const row = await this.db.prepare(`SELECT o.id AS owner_id, o.name AS owner, i.data FROM players o
        JOIN items i ON i.player_id = o.id WHERE o.room = ? AND o.name = ? AND i.id = ?`)
      .bind(p.room, owner, itemId).first();
    const it = row && JSON.parse(row.data);
    const isRequest = it && ((it.type === 'marker' && String(it.icon ?? '').startsWith('air-')) ||
      (it.type === 'area' && it.kind === 'cas'));
    if (!isRequest) return [404, { error: 'That request has gone.' }];
    const updated = { ...it, status, statusBy: p.name };
    const data = JSON.stringify(updated);
    await this.db.batch([
      this.db.prepare('UPDATE items SET data = ?, size = ? WHERE player_id = ? AND id = ?')
        .bind(data, pyJsonSize(updated), row.owner_id, itemId),
      this.eventStmt(p.room, { type: 'item', owner: row.owner, item: updated }),
    ]);
    return [200, { ok: true }];
  }

  async delete(pid, token, itemId) {
    const p = await this.auth(pid, token);
    if (!p) return [401, { error: 'Session expired. Reload the page.' }];
    if (typeof itemId !== 'string') return [400, { error: 'Bad item id.' }];
    const gone = await this.db.prepare('DELETE FROM items WHERE player_id = ? AND id = ? RETURNING id').bind(p.id, itemId).first();
    if (gone) await this.eventStmt(p.room, { type: 'delete', owner: p.name, id: itemId }).run();
    return [200, { ok: true }];
  }

  async setBriefing(pid, token, text) {
    if (typeof text !== 'string' || clen(text) > MAX_BRIEFING_CHARS) {
      return [400, { error: `The briefing is limited to ${MAX_BRIEFING_CHARS} characters.` }];
    }
    const p = await this.auth(pid, token);
    if (!p) return [401, { error: 'Session expired. Reload the page.' }];
    const briefing = { text, by: p.name, at: Date.now() };
    await this.db.batch([
      this.db.prepare(`INSERT INTO rooms (code, created, briefing) VALUES (?1, ?2, ?3)
          ON CONFLICT (code) DO UPDATE SET briefing = excluded.briefing`).bind(p.room, Date.now(), JSON.stringify(briefing)),
      this.eventStmt(p.room, { type: 'briefing', briefing }),
    ]);
    return [200, { ok: true }];
  }

  async leave(pid, token) {
    const p = await this.auth(pid, token);
    if (p) await this.remove(p.id);
    return [200, { ok: true }];
  }

  // Every active room and who is in it, for the admin view.
  async adminSnapshot() {
    await this.reap();
    const now = Date.now();
    const [rooms, players] = await this.db.batch([
      this.db.prepare('SELECT code, created, briefing FROM rooms'),
      this.db.prepare(`SELECT p.id, p.room, p.ip, p.addr_key, p.name, p.color, p.joined, p.last_seen,
          (SELECT count(*) FROM items i WHERE i.player_id = p.id) AS markings FROM players p ORDER BY p.joined, p.rowid`),
    ]);
    const out = [];
    for (const r of rooms.results) {
      const inRoom = players.results.filter(p => p.room === r.code);
      if (!inRoom.length) continue;
      const b = r.briefing ? JSON.parse(r.briefing) : null;
      out.push({
        room: r.code,
        created: r.created,
        briefing: b && b.text.trim() ? { by: b.by, at: b.at, chars: clen(b.text) } : null,
        players: inRoom.map(p => {
          const away = now - p.last_seen;
          return {
            id: p.id, ip: p.ip, key: p.addr_key, name: p.name, color: p.color, joined: p.joined,
            connected: away < CONNECTED_MS, awaySeconds: away < CONNECTED_MS ? 0 : Math.floor(away / 1000),
            markings: p.markings,
          };
        }),
      });
    }
    out.sort((a, b) => b.players.length - a.players.length || (a.room < b.room ? -1 : a.room > b.room ? 1 : 0));
    return { now, rooms: out, bans: await bans(this.db).list(), totalPlayers: out.reduce((s, r) => s + r.players.length, 0) };
  }

  // --- moderation (admin only) ---
  async kick(pid) {
    const p = typeof pid === 'string' && await this.db.prepare('SELECT id, name FROM players WHERE id = ?').bind(pid).first();
    if (!p || !await this.remove(p.id, 'You were removed from the map by the admin.')) {
      return [404, { error: 'That player has already left.' }];
    }
    return [200, { ok: true, name: p.name }];
  }

  async ban(pid, hours) {
    if (hours !== null && hours !== undefined && !(typeof hours === 'number' && hours > 0 && hours <= 24 * 365)) {
      return [400, { error: 'Bad ban length.' }];
    }
    const p = typeof pid === 'string' && await this.db.prepare('SELECT id, name, addr_key FROM players WHERE id = ?').bind(pid).first();
    if (!p) return [404, { error: "That player has already left." }];
    const ban = await bans(this.db).add(p.addr_key, hours, p.name);
    // Everyone on that address goes, whichever room they are in.
    const { results } = await this.db.prepare('SELECT id, name FROM players WHERE addr_key = ?').bind(p.addr_key).all();
    const removed = [];
    for (const o of results) if (await this.remove(o.id, banMessage(ban))) removed.push(o.name);
    return [200, { ok: true, removed, name: p.name, ip: p.addr_key }];
  }

  async closeRoom(room) {
    if (typeof room !== 'string') return [404, { error: 'That room is already empty.' }];
    const { results } = await this.db.prepare('SELECT id FROM players WHERE room = ?').bind(room).all();
    if (!results.length) return [404, { error: 'That room is already empty.' }];
    let removed = 0;
    for (const p of results) if (await this.remove(p.id, 'The admin closed this room.')) removed++;
    await this.db.prepare('DELETE FROM rooms WHERE code = ?').bind(room).run();
    return [200, { ok: true, removed }];
  }
}
Hub.lastReap = 0;
Hub.lastPrune = 0;

// --- IP bans: {until: ms or null for permanent, names: [...], at: ms} per address -------------------------

function bans(db) {
  const purge = () => db.prepare('DELETE FROM bans WHERE until IS NOT NULL AND until <= ?').bind(Date.now()).run();
  const row = b => b && { until: b.until, names: JSON.parse(b.names), at: b.at };
  return {
    async active(key) {
      await purge();
      return row(await db.prepare('SELECT * FROM bans WHERE ip = ?').bind(key).first());
    },
    async add(key, hours, name) {
      const now = Date.now();
      const old = row(await db.prepare('SELECT * FROM bans WHERE ip = ?').bind(key).first());
      let names = old ? old.names : [];
      if (!names.includes(name)) names = [...names, name].slice(-10);
      const b = { until: hours ? Math.floor(now + hours * 3600_000) : null, names, at: now };
      await db.prepare('INSERT OR REPLACE INTO bans (ip, until, names, at) VALUES (?, ?, ?, ?)')
        .bind(key, b.until, JSON.stringify(names), b.at).run();
      return b;
    },
    async remove(key) {
      if (typeof key !== 'string') return [404, { error: "That address isn't banned." }];
      const gone = await db.prepare('DELETE FROM bans WHERE ip = ? RETURNING ip').bind(key).first();
      return gone ? [200, { ok: true }] : [404, { error: "That address isn't banned." }];
    },
    async list() {
      await purge();
      const { results } = await db.prepare('SELECT * FROM bans ORDER BY at DESC').all();
      return results.map(b => ({ ip: b.ip, ...row(b) }));
    },
  };
}

// --- admin sign-in ------------------------------------------------------------------------------------------
// A correct password gets a session token (only its hash is stored), tied to the address that signed in, ending
// after ADMIN_IDLE_MS unused or ADMIN_SESSION_MS in all. Wrong passwords lock out the address after
// ADMIN_MAX_FAILURES, and pause sign-in for everyone after ADMIN_GLOBAL_MAX_FAILURES from all addresses together.

class Admin {
  constructor(db, env) {
    this.db = db;
    this.password = typeof env.EVERON_ADMIN_PASSWORD === 'string' ? env.EVERON_ADMIN_PASSWORD : '';
  }

  setupError() {
    if (!this.password) return 'The admin view is switched off. Set the EVERON_ADMIN_PASSWORD secret for this site to turn it on.';
    if (clen(this.password) < ADMIN_MIN_PASSWORD) return `The admin password (EVERON_ADMIN_PASSWORD) must be at least ${ADMIN_MIN_PASSWORD} characters.`;
    return null;
  }

  async login(addr, password) {
    const setup = this.setupError();
    if (setup) return [503, { error: setup }];
    const now = Date.now();
    const key = addrKey(addr);
    const [fail, recent] = await this.db.batch([
      this.db.prepare('SELECT * FROM admin_failures WHERE addr_key = ?').bind(key),
      this.db.prepare('SELECT count(*) AS n, min(at) AS first FROM admin_recent WHERE at > ?').bind(now - ADMIN_GLOBAL_WINDOW_MS),
    ]);
    let f = fail.results[0];
    if (f && f.locked_until > now) {
      return [429, { error: `Too many wrong passwords. Try again in ${Math.floor((f.locked_until - now) / 60_000) + 1} min.` }];
    }
    const r = recent.results[0];
    if (r.n >= ADMIN_GLOBAL_MAX_FAILURES) {
      const wait = Math.floor((ADMIN_GLOBAL_WINDOW_MS - (now - r.first)) / 60_000) + 1;
      return [429, { error: `Admin sign-in is paused after many wrong passwords. Try again in ${wait} min.` }];
    }
    // Both sides hashed first, so the comparison takes the same time whatever the password's length.
    const ok = typeof password === 'string' && password.length <= 1000 &&
      sameString(hex(await sha256(password)), hex(await sha256(this.password)));
    if (!ok) {
      if (!f || now - f.first > ADMIN_LOCKOUT_MS) f = { count: 0, first: now, locked_until: 0 };
      f.count += 1;
      if (f.count >= ADMIN_MAX_FAILURES) {
        f.locked_until = now + ADMIN_LOCKOUT_MS;
        audit(`${addr} locked out for ${ADMIN_LOCKOUT_MS / 60_000} min after ${f.count} wrong passwords`);
      } else {
        audit(`wrong password from ${addr}`);
      }
      if (r.n + 1 === ADMIN_GLOBAL_MAX_FAILURES) {
        audit(`sign-in paused for everyone: ${r.n + 1} wrong passwords in ${ADMIN_GLOBAL_WINDOW_MS / 60_000} min`);
      }
      await this.db.batch([
        this.db.prepare('INSERT INTO admin_recent (at) VALUES (?)').bind(now),
        this.db.prepare('INSERT OR REPLACE INTO admin_failures (addr_key, count, first, locked_until) VALUES (?, ?, ?, ?)')
          .bind(key, f.count, f.first, f.locked_until),
      ]);
      return [401, { error: 'Wrong password.' }];
    }
    const token = tokenUrlsafe(32);
    await this.db.batch([
      this.db.prepare('DELETE FROM admin_failures WHERE addr_key = ?').bind(key),
      this.db.prepare('DELETE FROM admin_sessions WHERE until <= ?1 OR seen <= ?2').bind(now, now - ADMIN_IDLE_MS),
      // The oldest sign-ins make way so there are never more than ADMIN_MAX_SESSIONS.
      this.db.prepare(`DELETE FROM admin_sessions WHERE token_hash IN
          (SELECT token_hash FROM admin_sessions ORDER BY seen DESC LIMIT -1 OFFSET ?)`).bind(ADMIN_MAX_SESSIONS - 1),
      this.db.prepare('INSERT INTO admin_sessions (token_hash, until, seen, addr_key) VALUES (?, ?, ?, ?)')
        .bind(hex(await sha256(token)), now + ADMIN_SESSION_MS, now, key),
    ]);
    audit(`signed in from ${addr}`);
    return [200, { token }];
  }

  // True if token is a live session from this address; using it keeps it alive.
  async check(token, addr) {
    if (typeof token !== 'string' || !token || this.setupError()) return false;
    const now = Date.now();
    const h = hex(await sha256(token));
    const s = await this.db.prepare('SELECT * FROM admin_sessions WHERE token_hash = ?').bind(h).first();
    if (!s || now >= s.until || now - s.seen >= ADMIN_IDLE_MS) {
      if (s) await this.db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(h).run();
      return false;
    }
    if (s.addr_key !== addrKey(addr)) return false; // a token copied to another address is useless there
    if (now - s.seen > 10_000) await this.db.prepare('UPDATE admin_sessions SET seen = ? WHERE token_hash = ?').bind(now, h).run();
    return true;
  }

  async logout(token) {
    if (typeof token === 'string' && token) {
      const gone = await this.db.prepare('DELETE FROM admin_sessions WHERE token_hash = ? RETURNING token_hash')
        .bind(hex(await sha256(token))).first();
      if (gone) audit('signed out');
    }
    return [200, { ok: true }];
  }
}

// --- the admin allow-list (EVERON_ADMIN_ALLOW) --------------------------------------------------------------

let allowCache = { raw: null, nets: null };
function adminAllowed(env, ip) {
  const raw = (env.EVERON_ADMIN_ALLOW || '').trim();
  if (!raw) return true;
  if (allowCache.raw !== raw) {
    try {
      allowCache = { raw, nets: raw.split(',').map(s => s.trim()).filter(Boolean).map(parseNet) };
    } catch (err) {
      console.error(`EVERON_ADMIN_ALLOW: ${err.message}; the admin view is closed until it is fixed.`);
      allowCache = { raw, nets: [] };
    }
  }
  const addr = parseIp(ip);
  return !!addr && allowCache.nets.some(net => inNet(addr, net));
}

// --- requests -----------------------------------------------------------------------------------------------

function clientIp(request) {
  // Set by the platform to the address the request really came from; a browser can't fake it.
  return request.headers.get('CF-Connecting-IP') || '127.0.0.1';
}

async function readJson(request) {
  const n = Number(request.headers.get('Content-Length') || 0);
  if (n > MAX_BODY_BYTES) return null;
  let body;
  try {
    body = await request.text();
  } catch {
    return null;
  }
  if (!body || enc.encode(body).length > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function bearer(request) {
  const auth = request.headers.get('Authorization') || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

// A file from public/, following the platform's own redirects (e.g. /admin.html -> /admin) inside the site.
async function asset(env, request, path) {
  let url = new URL(path, request.url);
  for (let i = 0; i < 3; i++) {
    const res = await env.ASSETS.fetch(new Request(url, { method: request.method === 'HEAD' ? 'HEAD' : 'GET' }));
    if (res.status < 300 || res.status >= 400) return res;
    const loc = res.headers.get('Location');
    if (!loc) return res;
    url = new URL(loc, url);
  }
  return text(404, 'Not found');
}

async function serveStatic(env, request, path) {
  if (path === '' || path === '/') path = '/index.html';
  const res = await asset(env, request, path);
  if (!res.ok) return text(404, 'Not found');
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', ADMIN_PAGES.has(path) ? 'no-store' : 'no-cache');
  return out;
}

const missingTiles = new Set();

async function serveTile(env, ctx, request, z, x, y) {
  [z, x, y] = [z, x, y].map(Number); // one spelling per tile ("007" is "7")
  const n = 2 ** (7 - z); // tiles per side at this zoom
  if (x >= n || y >= n) return new Response(null, { status: 404, headers: { 'Content-Type': 'image/jpeg' } });
  const key = `${z}/${x}/${y}`;
  const hit = body => new Response(body, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800' } });
  const miss = code => new Response(null, { status: code, headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' } });
  // 1. Tiles shipped with the site (the ones the original server had cached).
  const shipped = await asset(env, request, `/tiles/${key}.jpg`);
  if (shipped.ok) return hit(shipped.body);
  // 2. Tiles fetched before and kept in the R2 bucket, if one is bound.
  if (env.TILES) {
    const obj = await env.TILES.get(`${key}.jpg`);
    if (obj) return hit(obj.body);
  }
  if (missingTiles.has(key)) return miss(404);
  // 3. The upstream tile server.
  let data;
  try {
    const res = await fetch(TILE_UPSTREAM.replace('{z}', z).replace('{x}', x).replace('{y}', y), {
      headers: { 'User-Agent': 'EveronFieldMap/1.0 (personal tile cache)' },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) { missingTiles.add(key); return miss(404); }
    if (!res.ok) return miss(502);
    data = new Uint8Array(await res.arrayBuffer());
  } catch {
    return miss(502);
  }
  if (data.length > 5_000_000 || data[0] !== 0xff || data[1] !== 0xd8) return miss(502); // only ever keep JPEGs
  if (env.TILES) ctx.waitUntil(env.TILES.put(`${key}.jpg`, data, { httpMetadata: { contentType: 'image/jpeg' } }).catch(() => {}));
  return hit(data);
}

async function adminPost(env, hub, admin, request, path, body, ip) {
  if (path === '/api/admin/login') return reply(await admin.login(ip, body.password));
  if (path === '/api/admin/logout') return reply(await admin.logout(bearer(request)));
  if (!await admin.check(bearer(request), ip)) return json(401, { error: 'Please sign in again.' });
  let code, res;
  if (path === '/api/admin/kick') {
    [code, res] = await hub.kick(body.player);
    if (code === 200) audit(`${ip} kicked ${res.name}`);
  } else if (path === '/api/admin/ban') {
    [code, res] = await hub.ban(body.player, body.hours);
    if (code === 200) audit(`${ip} banned ${res.name} (${res.ip}) ${body.hours ? `${body.hours} h` : 'permanently'}; removed ${res.removed.join(', ')}`);
  } else if (path === '/api/admin/unban') {
    [code, res] = await bans(env.DB).remove(body.ip);
    if (code === 200) audit(`${ip} lifted the ban on ${body.ip}`);
  } else if (path === '/api/admin/close-room') {
    [code, res] = await hub.closeRoom(body.room);
    if (code === 200) audit(`${ip} closed room ${body.room} (${res.removed} removed)`);
  } else {
    [code, res] = [404, { error: 'Not found.' }];
  }
  return json(code, res);
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  let path = url.pathname;
  const ip = clientIp(request);
  const key = addrKey(ip);
  const limited = kind => allow(key, kind) ? null : json(429, { error: 'Slow down a little - too many requests.' });
  const isAdmin = ADMIN_PAGES.has(path) || path.startsWith('/api/admin/');
  if (isAdmin && !adminAllowed(env, ip)) return text(404, 'Not found'); // outside EVERON_ADMIN_ALLOW it doesn't exist
  const needsDb = path.startsWith('/api/');
  if (needsDb) await ensureSchema(env.DB);
  const hub = needsDb && new Hub(env.DB);

  if (request.method === 'GET' || request.method === 'HEAD') {
    if (path === '/api/events') {
      const busy = limited('poll');
      if (busy) return busy;
      ctx.waitUntil(hub.reap().catch(err => console.error('reap', err)));
      return hub.poll(url.searchParams.get('id'), url.searchParams.get('token'), url.searchParams.get('since'));
    }
    if (path === '/api/admin/rooms') {
      const busy = limited('post');
      if (busy) return busy;
      const admin = new Admin(env.DB, env);
      if (!await admin.check(bearer(request), ip)) return json(401, { error: 'Please sign in again.' });
      return json(200, { ...await hub.adminSnapshot(), you: key });
    }
    if (path.startsWith('/api/')) return json(404, { error: 'Not found.' });
    if (path === '/admin') path = '/admin.html';
    const m = /^\/tiles\/([0-5])\/(\d{1,3})\/(\d{1,3})\.jpg$/.exec(path);
    if (m) return limited('tile') || serveTile(env, ctx, request, m[1], m[2], m[3]);
    return limited('static') || serveStatic(env, request, path);
  }

  if (request.method === 'POST') {
    const busy = limited('post');
    if (busy) return busy;
    const body = await readJson(request);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'Bad request.' });
    if (!hub) return json(404, { error: 'Not found.' });
    if (path.startsWith('/api/admin/')) return adminPost(env, hub, new Admin(env.DB, env), request, path, body, ip);
    if (path === '/api/join') return limited('join') || reply(await hub.join(body.name, body.room, ip));
    const { id, token } = body;
    if (path === '/api/item') return reply(await hub.upsert(id, token, body.item));
    if (path === '/api/air-status') return reply(await hub.setAirStatus(id, token, body.owner, body.itemId, body.status));
    if (path === '/api/delete') return reply(await hub.delete(id, token, body.itemId));
    if (path === '/api/briefing') return reply(await hub.setBriefing(id, token, body.text));
    if (path === '/api/leave') return reply(await hub.leave(id, token));
    return json(404, { error: 'Not found.' });
  }

  return json(405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD, POST' });
}

export default {
  async fetch(request, env, ctx) {
    let res;
    try {
      res = await route(request, env, ctx);
    } catch (err) { // never show a stack trace to the browser; keep one line in the log
      console.error(`Error handling ${request.method} ${new URL(request.url).pathname}: ${err && err.stack || err}`);
      res = json(500, { error: 'Server error.' });
    }
    return secure(res);
  },
};

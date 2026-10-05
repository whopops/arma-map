// Room: joins a field-map room and keeps everyone's markings up to date for the workbenches and 3D view.
// The 3D view requests an observer session; workbench sessions may publish markings and settings.
//
// The field map's API, under `api` (/api):
//   POST {api}/join   {name, room, map, observer?} -> {id, token, name, color, room, map}
//   POST {api}/events {id, token}       server-sent events: snapshot, join, leave, item, delete, clock, wind
//                                        (+ briefing); an "event: bye" when the server removes us
//   POST {api}/leave  {id, token}
//   POST {api}/wind   {id, token, wind: {s, d}}, POST {api}/clock {id, token, clock}: the room's own settings
// handlers.onSettings(kind) when the room's clock or wind arrive or change (pages that show them: mortar, shot planner).
// Markings are {id, type, ...} in game metres ([x, z], x east, z north), owned by the player who drew them; a
// player's markings go when they leave, unless the room keeps its plan (then the leave event says "kept", and the
// snapshot lists those who left with "away": true).
'use strict';

const Room = (() => {
  async function post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let j = {};
    try { j = await r.json(); } catch { /* not JSON */ }
    if (!r.ok) throw new Error(j.error || `The map server answered ${r.status}`);
    return j;
  }

  // handlers: onChange() whenever any marking changes; onStatus(state, text, removed) with state 'off' | 'joining' |
  // 'on', and removed true when the server has put us out of the room (kicked, banned, room closed)
  return function room(api, handlers) {
    const players = new Map();       // name -> { color, items: Map(id -> item) }
    let me = null, es = null;
    // the room's own settings, shared by every page in it: the game clock ({game, rate, ..., at}, with skew: the
    // server's time minus ours) and the wind ({s, d}: m/s, and where it blows from), null until someone sets them
    let clock = null, clockSkew = 0, wind = null;
    const changed = event => handlers.onChange && handlers.onChange(event);
    const status = (state, text, removed = false) => handlers.onStatus && handlers.onStatus(state, text, removed);

    function setPlayer(p) {
      players.set(p.name, { color: p.color, items: new Map((p.items || []).map(it => [it.id, it])) });
    }
    function onEvent(ev) {
      if (ev.type === 'snapshot') {
        players.clear();
        for (const p of ev.players) setPlayer(p);
        setClock(ev.clock, ev.now);
        wind = ev.wind || null;
        handlers.onSettings && handlers.onSettings();
      } else if (ev.type === 'clock' || ev.type === 'wind') {
        if (ev.type === 'clock') setClock(ev.clock, ev.now); else wind = ev.wind || null;
        handlers.onSettings && handlers.onSettings(ev.type);
        return;
      } else if (ev.type === 'join') setPlayer(ev.player);
      // in a kept room ("kept"), a player's markings stay after they leave
      else if (ev.type === 'leave') { if (!ev.kept) players.delete(ev.name); }
      else if (ev.type === 'item') {
        if (!players.has(ev.owner)) players.set(ev.owner, { color: ev.item.color || '#ffffff', items: new Map() });
        players.get(ev.owner).items.set(ev.item.id, ev.item);
      } else if (ev.type === 'delete') {
        const p = players.get(ev.owner);
        if (p) p.items.delete(ev.id);
      } else return;
      changed(ev);
      status('on', summary());
    }
    function setClock(c, serverNow) {
      clock = c || null;
      if (c && serverNow) clockSkew = serverNow - Date.now();
    }
    function summary() {
      let n = 0;
      for (const p of players.values()) n += p.items.size;
      return `Room ${me.room} · ${players.size} on the map · ${n} marking${n === 1 ? '' : 's'}`;
    }
    function end(text, removed = false) {
      if (es) { es.close(); es = null; }
      me = null;
      players.clear();
      clock = null; wind = null;
      changed();
      status('off', text || '', removed);
    }

    return {
      players,
      get me() { return me; },
      get wind() { return wind; },
      get clock() { return clock; },
      // the game time (seconds since midnight of the clock's date) now, or null without a clock
      gameNow() { return clock ? clock.game + (Date.now() + clockSkew - clock.at) / 1000 * clock.rate : null; },
      // set the room's wind ({s, d}) or clock; everyone in the room (this page included) hears it back as an event
      setWind(w) { return me ? post(`${api}/wind`, { id: me.id, token: me.token, wind: { s: +w.s, d: ((+w.d % 360) + 360) % 360 } }) : Promise.resolve(); },
      setClock(c) { return me ? post(`${api}/clock`, { id: me.id, token: me.token, clock: c }) : Promise.resolve(); },
      // Joins and returns the server's answer (its .map is the room's map, which may not be the one asked for). The
      // caller calls listen() once it's happy to stay.
      async join(name, code, map, observer = false) {
        status('joining', 'Joining…');
        try {
          me = await post(`${api}/join`, { name, room: code, map, observer });
          return me;
        } catch (err) {
          status('off', err.message === 'Failed to fetch' ? 'Can’t reach the map server.' : err.message);
          throw err;
        }
      },
      listen() {
        const s = new RoomEvents(`${api}/events`, me);
        es = s;
        s.onmessage = m => { try { onEvent(JSON.parse(m.data)); } catch (err) { console.error(err); } };
        s.addEventListener('bye', m => {
          let reason = '';
          try { reason = JSON.parse(m.data).reason || ''; } catch { /* no reason given */ }
          end(reason || 'The session ended.', true);
        });
        // the browser reconnects by itself after a blip; closed means the server no longer knows us
        s.onerror = () => { if (s.readyState === RoomEvents.CLOSED && es === s) end('Lost the connection to the map server.'); };
        status('on', `Room ${me.room}`);
      },
      // Leaving removes us from the room at once (else the server drops us about 15 s after the stream closes).
      leave() {
        if (!me) return;
        const body = JSON.stringify({ id: me.id, token: me.token });
        if (!navigator.sendBeacon(`${api}/leave`, body)) {
          fetch(`${api}/leave`, { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'application/json' } }).catch(() => {});
        }
        end('');
      },
    };
  };
})();

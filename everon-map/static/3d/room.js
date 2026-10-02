// Room: joins a field-map room (the same server.py that serves this page) and keeps everyone's markings up to date,
// so the 3D view can draw them. It only reads: nothing is ever drawn or changed in the room from here.
//
// The field map's API, under `api` (/api):
//   POST {api}/join   {name, room, map}  -> {id, token, name, color, room, map}   (a room keeps the map it was opened on)
//   GET  {api}/events?id&token           server-sent events: snapshot, join, leave, item, delete (+ briefing, clock);
//                                        an "event: bye" when the server removes us
//   POST {api}/leave  {id, token}
// Markings are {id, type, ...} in game metres ([x, z], x east, z north), owned by the player who drew them; a
// player's markings go when they leave.
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
    const changed = () => handlers.onChange && handlers.onChange();
    const status = (state, text, removed = false) => handlers.onStatus && handlers.onStatus(state, text, removed);

    function setPlayer(p) {
      players.set(p.name, { color: p.color, items: new Map((p.items || []).map(it => [it.id, it])) });
    }
    function onEvent(ev) {
      if (ev.type === 'snapshot') {
        players.clear();
        for (const p of ev.players) setPlayer(p);
      } else if (ev.type === 'join') setPlayer(ev.player);
      else if (ev.type === 'leave') players.delete(ev.name);
      else if (ev.type === 'item') {
        if (!players.has(ev.owner)) players.set(ev.owner, { color: ev.item.color || '#ffffff', items: new Map() });
        players.get(ev.owner).items.set(ev.item.id, ev.item);
      } else if (ev.type === 'delete') {
        const p = players.get(ev.owner);
        if (p) p.items.delete(ev.id);
      } else return;
      changed();
      status('on', summary());
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
      changed();
      status('off', text || '', removed);
    }

    return {
      players,
      get me() { return me; },
      // Joins and returns the server's answer (its .map is the room's map, which may not be the one asked for). The
      // caller calls listen() once it's happy to stay.
      async join(name, code, map) {
        status('joining', 'Joining…');
        try {
          me = await post(`${api}/join`, { name, room: code, map });
          return me;
        } catch (err) {
          status('off', err.message === 'Failed to fetch' ? 'Can’t reach the map server.' : err.message);
          throw err;
        }
      },
      listen() {
        const s = new EventSource(`${api}/events?id=${encodeURIComponent(me.id)}&token=${encodeURIComponent(me.token)}`);
        es = s;
        s.onmessage = m => { try { onEvent(JSON.parse(m.data)); } catch (err) { console.error(err); } };
        s.addEventListener('bye', m => {
          let reason = '';
          try { reason = JSON.parse(m.data).reason || ''; } catch { /* no reason given */ }
          end(reason || 'The session ended.', true);
        });
        // the browser reconnects by itself after a blip; closed means the server no longer knows us
        s.onerror = () => { if (s.readyState === EventSource.CLOSED && es === s) end('Lost the connection to the map server.'); };
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

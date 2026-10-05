/* Arma Reforger Maps - shot planner: the field map's shot calculator on a page of its own. The flights, sights and
   solving are shot-core.js, the same code the map's Shot calculator runs. On its own it all stays in this browser;
   joined to a room (3d/room.js, the same rooms as the field map) your shot is a Shot calculator marking under your
   name, so the full map shows it, and the room's enemy markings and your position can be picked as the two ends. */
(() => {
  'use strict';

  // --- Coordinates and helpers (as in app.js) ------------------------------------------------------------------------
  const OFFSET = 50, SCALE = 12.501;
  const CRS = L.Util.extend({}, L.CRS, {
    projection: L.Projection.LonLat,
    transformation: new L.Transformation(1 / SCALE, 0, -1 / SCALE, 0),
    scale: z => Math.pow(2, z),
    zoom: s => Math.log(s) / Math.LN2,
    distance: (a, b) => Math.hypot(b.lng - a.lng, b.lat - a.lat),
    infinite: true,
  });
  const toLL = ([x, z]) => L.latLng(z + OFFSET, x + OFFSET);
  const toXZ = ll => [ll.lng - OFFSET, ll.lat - OFFSET];
  const pad = (n, w) => String(Math.max(0, Math.floor(n))).padStart(w, '0');
  const grid = ([x, z]) => `${pad(x / 10, 4)} ${pad(z / 10, 4)}`;
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const bearing = (a, b) => ((Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI) + 360) % 360;
  const fmtDist = m => m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = sel => document.querySelector(sel);
  const signed = v => Math.round(v) === 0 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(Math.round(v))}`;
  const round1 = v => Math.round(v * 10) / 10;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function windParts(wind, az) {
    if (!wind || !(wind.s > 0)) return { along: 0, across: 0 };
    const toward = ((wind.d + 180) - az) * Math.PI / 180;
    return { along: wind.s * Math.cos(toward), across: wind.s * Math.sin(toward) };
  }
  // A grid as players type it: "045 067" (100 m squares), "0452 0671" (10 m), 6-10 digits run together, or X Z in metres.
  function parseCoords(text, world) {
    const s = text.trim();
    let a, b;
    const pair = s.match(/^(\d{1,5})\s*[,;/\s]\s*(\d{1,5})$/);
    if (pair) { a = pair[1]; b = pair[2]; } else {
      const run = s.replace(/[\s-]/g, '');
      if (!/^\d+$/.test(run) || run.length % 2 || run.length < 6 || run.length > 10) return null;
      a = run.slice(0, run.length / 2); b = run.slice(run.length / 2);
    }
    const conv = str => str.length === 3 ? +str * 100 + 50 : str.length === 4 && +str * 10 <= world ? +str * 10 + 5 : +str;
    const xz = [conv(a), conv(b)];
    return xz.every(v => v >= 0 && v <= world) ? xz : null;
  }

  // --- Terrain: the 10 m heights the map uses ------------------------------------------------------------------------
  let HEIGHT = null, HN = 1300;
  const HCELL = 10;
  function heightAt([x, z]) {
    if (!HEIGHT) return 0;
    const fx = Math.min(Math.max(x / HCELL - 0.5, 0), HN - 1), fz = Math.min(Math.max(z / HCELL - 0.5, 0), HN - 1);
    const c0 = Math.floor(fx), r0 = Math.floor(fz), c1 = Math.min(c0 + 1, HN - 1), r1 = Math.min(r0 + 1, HN - 1);
    const tx = fx - c0, tz = fz - r0, v = (r, c) => HEIGHT[r * HN + c] / 10;
    const south = v(r0, c0) + (v(r0, c1) - v(r0, c0)) * tx, north = v(r1, c0) + (v(r1, c1) - v(r1, c0)) * tx;
    return south + (north - south) * tz;
  }
  // A point can carry its own ground height (.h): the Range only mode's made-up points
  const ground = p => p.h != null ? p.h : Math.max(heightAt(p), 0);

  // --- State, kept in this browser for 5 minutes after the page was last open (as the mortar page keeps its own), so a
  // reload or a trip to another page keeps it but an old session never comes back. `owner`: the room and name the shot
  // was last in ('' if never in one), `ownerSig` what it was then: joining a room, the kept shot goes into it only if it
  // was made for that room and name, or outside any room, or changed since. ------------------------------------------
  const KEY = 'shotPlanner', KEEP_MS = 5 * 60e3;
  let S = { map: null, mode: 'map', w: 'RPG-7|PG-7VM', s: 'iron', h1: 1.6, h2: 1, from: null, to: null, wind: { s: 0, d: 0 },
    range: { D: 300, dh: 0, brg: 0 }, owner: '', ownerSig: null };
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (v && Date.now() - (v.at || 0) < KEEP_MS) S = { ...S, ...v };
    else localStorage.removeItem(KEY); // an old session: start clean
  } catch (e) { /* start fresh */ }
  const shotSigOf = () => JSON.stringify([S.from, S.to, S.w, S.s, S.h1, S.h2]);
  // Copies saved by older versions omitted sight/height. Do not mistake that format change for a user edit.
  try {
    const old = JSON.parse(S.ownerSig);
    if (Array.isArray(old) && old.length === 3 && JSON.stringify(old) === JSON.stringify([S.from, S.to, S.w])) S.ownerSig = shotSigOf();
  } catch { /* no legacy signature */ }
  let ownedBy = () => null; // the room and name the shot now belongs to, while in a room (set up with the room below)
  const save = () => {
    const owner = ownedBy();
    if (owner) { S.owner = owner; S.ownerSig = shotSigOf(); }
    try { localStorage.setItem(KEY, JSON.stringify({ ...S, at: Date.now() })); } catch (e) { /* not remembered */ }
  };
  setInterval(() => { // while the page is open the 5 minutes don't run
    try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); if (v) { v.at = Date.now(); localStorage.setItem(KEY, JSON.stringify(v)); } } catch { /* storage unavailable */ }
  }, 60e3);

  const SC = ShotCore({ ground, hasGround: () => S.mode === 'range' || !!HEIGHT, windParts, fmtDist, dist, bearing });

  // --- Map: the satellite pictures -----------------------------------------------------------------------------------
  let MAPS = {}, MAP = null;
  const map = L.map('map', { crs: CRS, center: toLL([6400, 6400]), zoom: 0, minZoom: -1, maxZoom: 7, zoomSnap: 0.5,
    attributionControl: false, doubleClickZoom: false, preferCanvas: true });
  map.zoomControl.setPosition('topright');
  const BLANK_TILE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const MapTiles = L.TileLayer.extend({
    getTileUrl(c) {
      const z = 5 - c.z, n = 2 ** (7 - z), y = -(c.y + 1), url = this.options.url;
      if (!url || c.x < 0 || y < 0 || c.x >= n || y >= n) return BLANK_TILE;
      return url.replace('{z}', z).replace('{x}', c.x).replace('{y}', y);
    },
  });
  let tileLayer = null;

  let loadGen = 0;
  function loadHeights() {
    HEIGHT = null;
    const gen = ++loadGen;
    fetch(`${MAP.dir}/los/index.json`).then(r => r.ok ? r.json() : {}).catch(() => ({}))
      .then(ix => fetch(`${MAP.dir}/light/height.bin.gz?v=${ix.version || 4}`))
      .then(r => { if (!r.ok) throw new Error(r.status); return new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(); })
      .then(buf => { if (gen === loadGen) { HEIGHT = new Int16Array(buf); render(); } })
      .catch(err => { console.error(err); $('#geo').textContent = 'Could not load the terrain heights. Reload the page to try again.'; });
  }

  function fillMapPick() {
    $('#map-pick').innerHTML = Object.values(MAPS).map(m =>
      `<button type="button" role="radio" data-map="${esc(m.id)}" class="${MAP && m.id === MAP.id ? 'sel' : ''}" aria-checked="${!!MAP && m.id === MAP.id}">${esc(m.name)}</button>`).join('');
  }
  function useMap(id, keepPoints) {
    const next = MAPS[id] || MAPS[Object.keys(MAPS)[0]];
    if (!next) return;
    const changed = !MAP || MAP.id !== next.id;
    MAP = next;
    HN = MAP.cols;
    if (S.map !== MAP.id || !keepPoints) { S.from = null; S.to = null; }
    S.map = MAP.id;
    save();
    fillMapPick();
    if (tileLayer) tileLayer.remove();
    const b = L.latLngBounds(toLL([0, 0]), toLL([MAP.size, MAP.size]));
    tileLayer = new MapTiles('', { url: MAP.tiles, minZoom: -1, maxZoom: 7, minNativeZoom: 0, maxNativeZoom: 5, bounds: b, keepBuffer: 3,
      errorTileUrl: BLANK_TILE }).addTo(map);
    tileLayer.bringToBack();
    map.setMaxBounds(b.pad(0.25));
    if (S.from && S.to) map.fitBounds(L.latLngBounds([toLL(S.from), toLL(S.to)]).pad(0.8), { maxZoom: 4, animate: false });
    else map.fitBounds(b, { animate: false });
    if (changed) loadHeights();
    render();
  }
  $('#map-pick').addEventListener('click', e => {
    const b = e.target.closest('[data-map]');
    if (!b || inRoom() || (MAP && b.dataset.map === MAP.id)) return;
    useMap(b.dataset.map, false);
  });

  // The two ends, the shot line, and the aim line out to a crosshair on the aim bearing
  const pin = cls => L.divIcon({ className: '', iconSize: [0, 0], html: `<span class="pin ${cls}"></span>` });
  const youMark = L.marker([0, 0], { icon: pin('you'), draggable: true, keyboard: false, zIndexOffset: 500 });
  const tgtMark = L.marker([0, 0], { icon: pin('tgt'), draggable: true, keyboard: false, zIndexOffset: 500 });
  const shotLine = L.polyline([], { color: '#fff', weight: 1.5, opacity: 0.8, dashArray: '6 5', interactive: false });
  const aimShadow = L.polyline([], { color: '#000', weight: 4.5, opacity: 0.5, interactive: false });
  const aimLine = L.polyline([], { color: SC.ROCKET_AIM, weight: 2, interactive: false });
  const aimMark = L.marker([0, 0], { keyboard: false, interactive: false, zIndexOffset: 400, icon: L.divIcon({ className: '', iconSize: [0, 0], html: '' }) });
  // Dragging an end: the shot follows live (the side panel's heavy parts wait for the drop). `dragging` is the marker
  // being dragged, left where the mouse puts it by drawMap; the click a browser can send at the drop is ignored, so it
  // doesn't also move the target there.
  let dragging = null, droppedAt = 0;
  const dragEnd = (m, which) => m
    .on('dragstart', () => { dragging = m; })
    .on('drag', e => { S[which] = toXZ(e.target.getLatLng()); render(true); })
    .on('dragend', () => { dragging = null; droppedAt = Date.now(); S[which] = S[which].map(round1); changed(); });
  dragEnd(youMark, 'from');
  dragEnd(tgtMark, 'to');

  let picking = null; // 'from' or 'to' after a Pick button
  const setEnd = (which, xz) => { S[which] = xz.map(round1); picking = null; changed(); };
  map.on('click', e => {
    if (S.mode !== 'map' || dragging || Date.now() - droppedAt < 300) return;
    const xz = toXZ(e.latlng);
    if (!MAP || xz.some(v => v < 0 || v > MAP.size)) return;
    setEnd(picking || (!S.from ? 'from' : 'to'), xz);
  });
  map.on('mousemove', e => { const xz = toXZ(e.latlng); $('#cursor-grid').textContent = MAP && xz.every(v => v >= 0 && v <= MAP.size) ? grid(xz) : '— —'; });
  document.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => {
    picking = picking === b.dataset.pick ? null : b.dataset.pick;
    render(true);
  }));
  const gridInput = (el, which) => el.addEventListener('change', () => {
    const xz = MAP && parseCoords(el.value, MAP.size);
    el.classList.toggle('bad', !!el.value.trim() && !xz);
    if (!xz) return;
    setEnd(which, xz);
    map.panTo(toLL(xz));
  });
  gridInput($('#g-from'), 'from');
  gridInput($('#g-to'), 'to');
  $('#swap').addEventListener('click', () => { [S.from, S.to] = [S.to, S.from]; changed(); });
  $('#clear').addEventListener('click', () => { clearRoomShot(); S.from = S.to = null; picking = null; changed(); });

  // --- Inputs --------------------------------------------------------------------------------------------------------
  const opt = (v, t, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(t)}</option>`;
  const group = (name, list) => `<optgroup label="${esc(name)}">${list.map(([a, b]) => opt(`${a}|${b}`, SC.rocketName(a, b), `${a}|${b}` === S.w)).join('')}</optgroup>`;
  $('#weapon').innerHTML = group('Rocket launchers', SC.ROCKET_CHOICES) +
    [...new Set(Object.values(SC.SCOPES).map(q => q.group))].map(gr => group(gr, SC.GUN_CHOICES.filter(([a]) => SC.SCOPES[a].group === gr))).join('');
  if (!$('#weapon').value) S.w = $('#weapon').value = 'RPG-7|PG-7VM';
  $('#weapon').addEventListener('change', e => { S.w = e.target.value; changed(); });
  $('#sight').addEventListener('change', e => { S.s = e.target.value; changed(); });
  $('#h1').addEventListener('change', e => { S.h1 = +e.target.value; changed(); });
  $('#h2').addEventListener('change', e => { S.h2 = +e.target.value; changed(); });
  const num = (el, lo, hi, dflt) => { const v = +el.value; return el.value !== '' && Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : dflt; };
  const deg360 = v => ((Math.round(v) % 360) + 360) % 360;
  function readWind() {
    S.wind = { s: num($('#w-s'), 0, 40, 0), d: deg360(num($('#w-d'), -720, 720, 0)) };
    changed();
    sendWindToRoom(); // in a room, the room's wind (see roomSettings)
  }
  ['#w-s', '#w-d'].forEach(k => $(k).addEventListener('input', readWind));
  $('#wind-quick').innerHTML = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].map((n, i) => `<button type="button" data-from="${i * 45}" title="Wind blowing from the ${n}">${n}</button>`).join('');
  $('#wind-quick').addEventListener('click', e => {
    const b = e.target.closest('[data-from]');
    if (!b) return;
    $('#w-d').value = b.dataset.from;
    if (!(+$('#w-s').value > 0)) $('#w-s').value = 5;
    readWind();
  });
  function readRange() {
    S.range = { D: num($('#r-dist'), 1, 4000, 300), dh: num($('#r-dh'), -500, 500, 0), brg: deg360(num($('#r-brg'), -720, 720, 0)) };
    changed();
  }
  ['#r-dist', '#r-dh'].forEach(k => $(k).addEventListener('input', readRange));
  $('#r-brg').addEventListener('input', () => {
    if (S.mode === 'range') { readRange(); return; }
    if (!S.from || !S.to) return;
    const az = deg360(num($('#r-brg'),-720,720,0)) * Math.PI / 180;
    const D = dist(S.from,S.to);
    S.to = [round1(S.from[0]+D*Math.sin(az)),round1(S.from[1]+D*Math.cos(az))];
    changed();
  });
  function setMode(m) {
    S.mode = m;
    picking = null;
    document.querySelectorAll('[data-mode]').forEach(b => { const on = b.dataset.mode === m; b.classList.toggle('sel', on); b.setAttribute('aria-checked', on); });
    $('#pos-map').classList.toggle('hidden', m === 'range');
    $('#pos-range').classList.toggle('hidden', m !== 'range');
    changed();
  }
  document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  // the saved values into the form
  $('#sight').value = S.s === 'pgo7' ? 'pgo7' : 'iron';
  $('#h1').value = String(S.h1); $('#h2').value = String(S.h2);
  $('#w-s').value = S.wind.s; $('#w-d').value = S.wind.d;
  $('#r-dist').value = S.range.D; $('#r-dh').value = S.range.dh; $('#r-brg').value = S.range.brg;

  // --- The shot ------------------------------------------------------------------------------------------------------
  function shotItem() {
    const [l, r] = S.w.split('|'), g = SC.SCOPES[l];
    const it = { rocket: { l, r, s: g ? 'scope' : l === 'RPG-7' ? S.s : 'iron' }, h1: S.h1, h2: S.h2, wind: S.wind.s > 0 ? S.wind : null };
    if (S.mode === 'range') {
      const b = S.range.brg * Math.PI / 180;
      it.from = Object.assign([0, 0], { h: 0 });
      it.to = Object.assign([S.range.D * Math.sin(b), S.range.D * Math.cos(b)], { h: S.range.dh });
    } else { it.from = S.from; it.to = S.to; }
    return it;
  }
  const solvable = it => SC.rockets && (S.mode === 'range' || (it.from && it.to && HEIGHT)) && (!SC.SCOPES[it.rocket.l] || SC.tableOf(it.rocket.r));

  // Side-on: the ground under the shot (10 m heights; trees and buildings not counted) and the round's path over it
  function pathProfile(x, it) {
    const D = x.D, N = Math.min(120, Math.max(30, Math.round(D / 5)));
    const { along, across } = windParts(it.wind, x.az), w = { along, fromRight: -across };
    const start = ground(it.from) + it.h1, pts = [];
    for (let i = 0; i <= N; i++) {
      const d = D * i / N, t = i / N;
      const p = S.mode === 'range' ? null : [it.from[0] + (it.to[0] - it.from[0]) * t, it.from[1] + (it.to[1] - it.from[1]) * t];
      const g = p ? ground(p) : ground(it.from) + (ground(it.to) - ground(it.from)) * t;
      const a = i ? SC.rocketAt(x.R, x.sol.e, w, d) : { up: 0 };
      pts.push({ d, g, y: a ? start + a.up : null });
    }
    let hit = null;
    for (const s of pts) if (s.d > 3 && s.d < D - 3 && s.y != null && s.y < s.g) { hit = s; break; }
    const ys = pts.flatMap(s => s.y != null ? [s.g, s.y] : [s.g]);
    const lo = Math.floor(Math.min(...ys) - 2), hi = Math.ceil(Math.max(...ys, ground(it.to) + x.h2) + 2);
    const W = 340, H = 110, X = d => (d / D * W).toFixed(1), Y = h => (H - 4 - (h - lo) / (hi - lo) * (H - 12)).toFixed(1);
    const gl = pts.map(s => `${X(s.d)},${Y(s.g)}`).join(' ');
    const path = pts.filter(s => s.y != null).map(s => `${X(s.d)},${Y(s.y)}`).join(' ');
    const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
      `<polygon class="earth" points="0,${H} ${gl} ${W},${H}"/><polyline class="gline" points="${gl}"/>` +
      `<polyline class="flight${hit ? ' blocked' : ''}" points="${path}"/>` +
      `<circle class="you" cx="2" cy="${Y(start)}" r="3.5"/><circle class="tgt" cx="${W - 2}" cy="${Y(ground(it.to) + x.h2)}" r="3.5"/>` +
      (hit ? `<circle class="hit" cx="${X(hit.d)}" cy="${Y(hit.g)}" r="5"/>` : '') + '</svg>';
    const peak = Math.max(...pts.filter(s => s.y != null).map(s => s.y - start));
    return `<div class="prof">${svg}<div class="prof-scale"><span>${hi} m</span><span>${lo} m</span></div></div>` +
      `<div class="facts">${hit ? `<span class="bad">The ground may block it about ${fmtDist(hit.d)} out.</span>` : 'Clears the ground all the way.'}` +
      ` Highest ${peak.toFixed(1)} m above the muzzle. Trees and buildings not counted.</div>`;
  }

  let lastText = '';
  // The answer: the four numbers (also over the map), then the sight picture and the flight
  function answer() {
    const it = shotItem(), { l, r } = it.rocket, g = SC.SCOPES[l];
    if (!SC.rockets) return { html: '<div class="empty">Loading the rocket flights…</div>' };
    if (g && !SC.tableOf(r)) return { html: '<div class="empty">This weapon\'s measured flights aren\'t on the site yet.</div>' };
    if (S.mode === 'map' && (!it.from || !it.to)) {
      return { html: `<div class="empty"><b>${!it.from ? 'Click the map where you fire from.' : 'Now click the target.'}</b><br>` +
        `Or type grids above${inRoom() ? ', or click a marking from the room' : ''}.</div>` };
    }
    if (S.mode === 'map' && !HEIGHT) return { html: '<div class="empty">Loading the terrain…</div>' };
    const x = SC.rocketSolve(it);
    if (!x) return { html: '<div class="empty">Loading…</div>' };
    const up = `${signed(x.H)} m`;
    if (x.err) return { x, html: `<div class="empty err-box"><b>${esc(x.err)}</b><br>${fmtDist(x.D)} away, ${up}.</div>` };
    const pgo = it.rocket.s === 'pgo7' && l === 'RPG-7', lined = pgo || (g && g.lines);
    const latM = x.D * Math.tan(x.aimOff * Math.PI / 180), small = g ? 0.1 : 0.4;
    const holds = [Math.abs(x.hold) < small ? '' : `${Math.abs(x.hold).toFixed(1)} m ${x.hold > 0 ? 'high' : 'low'}`,
      Math.abs(latM) < small ? '' : `${Math.abs(latM).toFixed(1)} m ${latM > 0 ? 'right' : 'left'}`].filter(Boolean);
    const ticks = g && g.mils ? [Math.abs(x.need - x.mark[1]) >= g.mils / 4 ? `${(Math.abs(x.need - x.mark[1]) / g.mils).toFixed(1)} ${x.hold > 0 ? 'up' : 'down'}` : '',
      Math.abs(x.aimOff) >= g.mils / 4 ? `${(Math.abs(x.aimOff) / g.mils).toFixed(1)} ${x.aimOff > 0 ? 'right' : 'left'}` : ''].filter(Boolean).join(', ') : '';
    const markName = lined ? 'Line' : g ? 'Zero' : 'Sight';
    const beyond = x.past > 0 ? `Past the top ${lined ? 'line' : g ? 'zero' : 'mark'}: the hold makes up the rest.` : x.past < 0 ? `Under the lowest ${lined ? 'line' : g ? 'zero' : 'mark'}.` : '';
    const holdTxt = holds.length ? holds.join(', ') : 'on target';
    lastText = `${SC.rocketName(l, r)}: ${fmtDist(x.D)} ${up}. ${markName} ${x.mark[0]} m, hold ${holdTxt}, aim ${x.aim.toFixed(1)}°, ${x.sol.t.toFixed(1)} s.`;
    let html = `<div class="big"><div><span class="k">${markName}</span><span class="v">${x.mark[0]}<small> m</small></span></div>` +
      `<div><span class="k">Hold</span><span class="v sm hold">${holds.length ? holds.map(esc).join('<br>') : 'On'}</span></div>` +
      `<div><span class="k">Aim</span><span class="v sm">${x.aim.toFixed(1)}°</span></div>` +
      `<div><span class="k">Flight</span><span class="v sm">${x.sol.t.toFixed(1)}<small> s</small></span></div></div>` +
      `<div class="facts"><b>${fmtDist(x.D)}</b> on ${x.az.toFixed(1)}°, target <b>${up}</b>${ticks ? ` · ${ticks} ticks` : ''}</div>`;
    if (beyond) html += `<div class="facts warn">${beyond}</div>`;
    html += '<div class="actions"><button type="button" id="copy">Copy for chat</button></div>';
    html += `<h3>Sight picture</h3>${SC.sightPicture(x, it)}`;
    html += `<h3>Flight path</h3>${pathProfile(x, it)}`;
    if (x.calm && !x.calm.err) {
      html += `<div class="facts">Without aiming off for the wind it would land ${Math.abs(x.sol.side).toFixed(1)} m ${x.sol.side > 0 ? 'right' : 'left'}.` +
        (!g && x.upwind && Math.abs(x.sol.side) > 0.3 ? ' Its motor turns it into the wind, so it ends up upwind.' : '') + '</div>';
    }
    if (!g && x.R.spread > 5) html += `<div class="facts">This rocket varies about ±${Math.round(x.R.spread)} m in range from one to the next.</div>`;
    const hud = `${markName} ${x.mark[0]} m · hold ${holdTxt} · aim ${x.aim.toFixed(1)}° <small>${fmtDist(x.D)}, ${x.sol.t.toFixed(1)} s</small>`;
    return { x, html, hud };
  }

  function drawMap(x) {
    // The two ends stay on the map and are only moved: taking a marker off the map (as this did on every redraw, and a
    // drag redraws on every move) ends its drag, so a dragged end stopped after the first move. The one being dragged
    // is where the mouse put it already.
    [shotLine, aimShadow, aimLine, aimMark].forEach(m => m.remove());
    const place = (m, xz) => {
      if (S.mode !== 'map' || !xz) { m.remove(); return; }
      if (m !== dragging) m.setLatLng(toLL(xz));
      if (!map.hasLayer(m)) m.addTo(map);
    };
    place(youMark, S.from);
    place(tgtMark, S.to);
    if (S.mode !== 'map' || !S.from || !S.to) return;
    shotLine.setLatLngs([toLL(S.from), toLL(S.to)]).addTo(map);
    if (x && !x.err) {
      const rad = x.aim * Math.PI / 180, aimXZ = [S.from[0] + x.D * Math.sin(rad), S.from[1] + x.D * Math.cos(rad)];
      const pts = [toLL(S.from), toLL(aimXZ)];
      aimShadow.setLatLngs(pts).addTo(map);
      aimLine.setLatLngs(pts).addTo(map);
      const hold = Math.abs(x.hold) < 0.4 ? '' : ` ${x.hold > 0 ? '+' : '−'}${Math.abs(x.hold).toFixed(1)} m`;
      aimMark.setIcon(L.divIcon({ className: '', iconSize: [0, 0], html: `<span class="rk-aim"><i></i><b>Aim ${x.aim.toFixed(1)}° · ${x.mark[0]} m${hold}</b></span>` }));
      aimMark.setLatLng(toLL(aimXZ)).addTo(map);
    }
  }

  function drawRose(az) {
    const w = S.wind;
    let s = '<circle r="27" class="rc"/><text y="-17" class="n">N</text>';
    if (az != null) s += `<path class="tl" d="M0 0L${(Math.sin(az * Math.PI / 180) * 26).toFixed(1)} ${(-Math.cos(az * Math.PI / 180) * 26).toFixed(1)}"/>`;
    if (w.s > 0) s += `<g transform="rotate(${w.d % 360})"><path class="wa" d="M0 -16 L0 17 M-6 9 L0 17 L6 9"/></g>`;
    $('#wind-rose').innerHTML = s;
  }

  // light: while dragging, skip the side panel's heavier parts until the drag ends
  function render(light) {
    const it = shotItem();
    const [l] = S.w.split('|'), g = SC.SCOPES[l];
    $('#f-sight').classList.toggle('hidden', l !== 'RPG-7');
    $('#f-h1').classList.toggle('hidden', !!g && g.target !== 'man');
    $('#f-h2').classList.toggle('hidden', !!g);
    for (const [w, el] of [['from', $('#g-from')], ['to', $('#g-to')]]) {
      if (document.activeElement !== el) { el.value = S[w] ? grid(S[w]) : ''; el.classList.remove('bad'); }
    }
    document.querySelectorAll('[data-pick]').forEach(b => b.classList.toggle('sel', picking === b.dataset.pick));
    $('#map').classList.toggle('aiming', S.mode === 'map');
    $('#hint').textContent = S.mode !== 'map' ? 'Range only: the map isn\'t used.'
      : picking ? `Click the map to set ${picking === 'from' ? 'where you fire from' : 'the target'}`
      : !S.from ? 'Click where you fire from' : !S.to ? 'Now click the target' : 'Click to move the target · drag either end';
    const x = solvable(it) ? SC.rocketSolve(it) : null;
    drawMap(x);
    const targetAz = it.from && it.to ? bearing(it.from,it.to) : null;
    drawRose(targetAz);
    $('#r-brg').disabled = targetAz == null;
    if (document.activeElement !== $('#r-brg')) $('#r-brg').value = targetAz == null ? '' : String(deg360(Math.round(targetAz*10)/10));
    $('#r-brg').title = S.mode === 'map' ? 'Changing direction rotates the target around your position, keeping the range.' : 'Compass direction from you to the target in degrees.';
    const parts = windParts(S.wind,targetAz || 0);
    $('#shot-wind-components').textContent = targetAz == null ? 'Set your position and target to get a direction.'
      : S.wind.s > 0 ? `${Math.abs(parts.along).toFixed(1)} m/s ${parts.along >= 0 ? 'tailwind' : 'headwind'} · ${Math.abs(parts.across).toFixed(1)} m/s crosswind ${parts.across >= 0 ? 'to the right' : 'to the left'}` : 'No wind correction: wind speed is zero.';
    $('#geo').textContent = S.mode === 'map' && it.from && it.to && HEIGHT
      ? `You at ${Math.round(ground(it.from))} m, the target at ${Math.round(ground(it.to))} m above the sea.` : '';
    $('#use-me').classList.toggle('hidden', !myPosition());
    if (light) return;
    const a = answer();
    $('#result').innerHTML = a.html;
    $('#aim').classList.toggle('hidden', !a.hud);
    $('#aim').innerHTML = a.hud || '';
    const c = $('#copy');
    if (c) c.addEventListener('click', () => {
      navigator.clipboard.writeText(lastText).then(() => { c.textContent = 'Copied'; setTimeout(() => { c.textContent = 'Copy for chat'; }, 1500); })
        .catch(() => { c.textContent = 'Could not copy'; });
    });
    renderRoom();
  }
  // Something about the shot changed: remember it, redraw, and share it with the room
  function changed() { save(); render(); publishSoon(); }

  // ---------------------------------------------------------------------------
  // Room: the field map's own rooms, joined the way the mortar page does it (mortar.js). The field map's keys are
  // shared: one session per tab (name, room, map) and the 5-minute copy of your markings, so switching between the
  // pages in one tab keeps your room and your markings. Your shot is a Shot calculator marking under your name.
  // ---------------------------------------------------------------------------
  const SESSION_KEY = 'everon-session', NAME_KEY = 'everon-mortar-name', KEEP_PREFIX = 'everon-kept:';
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };
  // the name last joined under, offered again for 5 minutes (like the rest of what a page keeps; an older plain entry goes)
  const nameKept = () => { try { const v = JSON.parse(ls.get(NAME_KEY) || 'null'); return v && v.name && Date.now() - v.at < 5 * 60e3 ? String(v.name) : ''; } catch { ls.set(NAME_KEY, null); return ''; } };
  const ses = {
    get(k) { try { return JSON.parse(sessionStorage.getItem(k) || 'null'); } catch { return null; } },
    set(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  async function api(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
    return data;
  }

  const roomLayer = L.layerGroup().addTo(map);
  let want = null, listening = false, synced = false, restoring = false, leaving = false;
  let publishTimer = 0, retryTimer = 0, retryN = 0;
  const itemWrites = PlanSync.writer();
  const room = Room('/api', { onChange: ev => roomChanged(ev), onStatus: (state, text, removed) => roomStatus(state, text, removed),
    onSettings: kind => roomSettings(kind) });
  const inRoom = () => !!(listening && room.me);
  const roomKey = () => (room.me ? `${room.me.room}|${room.me.name.toLowerCase()}` : '');
  ownedBy = () => (inRoom() && synced ? roomKey() : null);
  const myItems = () => (room.me && room.players.get(room.me.name) && room.players.get(room.me.name).items) || new Map();
  const isShot = it => it.type === 'range' && !!it.rocket;
  // This page's shot: the marking it made (its id kept per room in this tab)
  const shotIdKey = () => `shot-planner:${room.me.map}:${room.me.room}:${room.me.name.toLowerCase()}`;
  const myShot = () => { const id = room.me && ses.get(shotIdKey()); return (id && !planBackup.deleted(room.me, id) && myItems().get(id)) || null; };
  // Markings from the room worth aiming at or from: enemies, and everyone's own position
  const ENEMY_ICONS = { contact: 'Contact', 'unit-inf-e': 'Enemy infantry', 'unit-arm-e': 'Enemy armour', enemy: 'Enemy', 'enemy-ambush': 'Roadblock / ambush', sniper: 'Sniper', 'aa-e': 'Enemy AA' };
  function roomPoints() {
    const out = [];
    if (!room.me) return out;
    for (const [name, p] of room.players) for (const it of p.items.values()) {
      if (it.type !== 'marker' || !Array.isArray(it.xz)) continue;
      if (ENEMY_ICONS[it.icon]) out.push({ xz: it.xz, enemy: true, label: it.label || ENEMY_ICONS[it.icon], name });
      else if (it.icon === 'infantry') out.push({ xz: it.xz, enemy: false, label: name === room.me.name ? 'You' : name, name, color: p.color });
    }
    return out;
  }
  const myPosition = () => (inRoom() && roomPoints().find(p => !p.enemy && p.name === room.me.name)) || null;
  $('#use-me').addEventListener('click', () => { const p = myPosition(); if (p) { setEnd('from', p.xz); map.panTo(toLL(p.xz)); } });

  function buildItem() {
    const ex = myShot(), [l, r] = S.w.split('|'), g = SC.SCOPES[l];
    const id = ex ? ex.id : (ses.get(shotIdKey()) || `shot-${Math.random().toString(36).slice(2, 10)}`);
    ses.set(shotIdKey(), id);
    const item = { ...(ex || {}), id, type: 'range', from: S.from.map(round1), to: S.to.map(round1),
      label: (ex && ex.label) || 'Shot (planner)', note: (ex && ex.note) || '', color: (ex && ex.color) || room.me.color,
      h1: S.h1, h2: S.h2, rocket: { l, r, s: g ? 'scope' : l === 'RPG-7' ? S.s : 'iron' } };
    if (S.wind.s > 0) item.wind = { s: S.wind.s, d: S.wind.d }; else delete item.wind;
    return item;
  }
  const shotSig = it => JSON.stringify([it.from, it.to, it.h1, it.h2, it.rocket, it.wind || null]);
  function publishSoon() {
    if (!inRoom() || !synced || restoring || S.mode !== 'map' || !S.from || !S.to) return;
    clearTimeout(publishTimer);
    publishTimer = setTimeout(publishNow, 400);
  }
  async function publishNow() {
    publishTimer = 0;
    if (!inRoom() || !synced || restoring || S.mode !== 'map' || !S.from || !S.to) return;
    const me = room.me, item = buildItem(), ex = myShot();
    if (ex && shotSig(ex) === shotSig(item)) return;
    ses.set(shotIdKey(), item.id);
    planBackup.stage(me, item); writeKept();
    try { await itemWrites(me, item.id, () => api('/api/item', { id: me.id, token: me.token, item })); }
    catch (err) { $('#room-status').textContent = err.message; }
  }
  // Load a shot marking from the room into the planner (yours, or a teammate's to check)
  function clearRoomShot() {
    clearTimeout(publishTimer); publishTimer = 0;
    if (!inRoom() || !synced) return;
    const me = room.me, id = ses.get(shotIdKey());
    if (!id) return;
    planBackup.remove(me, id);
    // Clear local endpoints before persisting so writeKept cannot append the deleted shot.
    S.from = S.to = null;
    writeKept();
    itemWrites(me, id, () => api('/api/delete', { id: me.id, token: me.token, itemId: id }))
      .catch(err => { $('#room-status').textContent = err.message; });
    ses.set(shotIdKey(), null);
  }
  function loadShot(it) {
    S.mode = 'map';
    S.from = it.from.slice(); S.to = it.to.slice();
    S.w = `${it.rocket.l}|${it.rocket.r}`; if (it.rocket.s === 'pgo7' || it.rocket.s === 'iron') S.s = it.rocket.s;
    if (it.h1 != null) S.h1 = it.h1; if (it.h2 != null) S.h2 = it.h2;
    const w = room.wind || it.wind; // the room's wind if it has one, else the one saved on the shot
    S.wind = w && w.s > 0 ? { s: w.s, d: w.d } : { s: 0, d: 0 };
    $('#weapon').value = S.w; $('#sight').value = S.s === 'pgo7' ? 'pgo7' : 'iron';
    $('#h1').value = String(S.h1); $('#h2').value = String(S.h2); $('#w-s').value = S.wind.s; $('#w-d').value = S.wind.d;
    setMode('map');
    map.fitBounds(L.latLngBounds([toLL(S.from), toLL(S.to)]).pad(0.8), { maxZoom: 4, animate: false });
  }

  // The 5-minute copy of your markings the field map keeps (same key and shape), so the map restores them when you go back
  const keptKey = me => `${KEEP_PREFIX}${me.map}:${me.room}:${me.name.toLowerCase()}`;
  function keptFor(me) {
    try {
      const k = JSON.parse(ls.get(keptKey(me)) || 'null');
      if (k && Array.isArray(k.items) && k.items.length && Date.now() - k.at < 5 * 60e3) return k.items;
    } catch { /* damaged */ }
    return null;
  }
  const planBackup = PlanSync.backup();
  function writeKept() {
    const me = room.me;
    if (!me || !synced) return;
    let items = planBackup.items(me, [...myItems().values()]);
    if (!restoring && S.mode === 'map' && S.from && S.to && SC.rockets) { const mine = buildItem(); if (!planBackup.deleted(me, mine.id)) items = items.filter(i => i.id !== mine.id).concat(mine); }
    ls.set(keptKey(me), items.length ? JSON.stringify({ at: Date.now(), items }) : null);
  }
  setInterval(writeKept, 60e3);

  function roomStatus(state, text, removed = false) {
    $('#room-status').textContent = text || '';
    $('#room-join').textContent = state === 'on' ? 'Leave' : 'Join';
    $('#room-join').disabled = state === 'joining';
    $('#room-name').disabled = $('#room-code').disabled = state !== 'off';
    $('#map-note').classList.toggle('hidden', state !== 'on');
    $('#map-pick').classList.toggle('locked', state === 'on');
    if (state === 'off') {
      const was = listening;
      listening = false; synced = false; restoring = false; clearTimeout(publishTimer); publishTimer = 0;
      if (removed) { ses.set(SESSION_KEY, null); want = null; }
      else if (was && want && !leaving) scheduleRejoin();
      if (!text) $('#room-status').textContent = 'Join to put your shot on the squad\'s map and pick targets they marked.';
    }
    render();
  }
  function scheduleRejoin() {
    if (retryN >= 6) { want = null; roomStatus('off', 'Lost the connection to the room. Press Join to come back.'); return; }
    retryN++;
    $('#room-status').textContent = 'Reconnecting…';
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if (want) joinRoom(want.name, want.code, { again: 2, auto: true, map: want.map }); }, 2500 * retryN);
  }
  // map: the map the room was on, when we know it (a room that emptied while you switched pages is opened again on the
  // map asked for, so asking for this page's own last map would put the squad on the wrong one)
  async function joinRoom(name, code, { again = 0, auto = false, map: roomMap = null } = {}) {
    name = String(name).trim(); code = String(code).trim().toLowerCase();
    if (!name || !code) { $('#room-status').textContent = 'Enter your name and the room code.'; return; }
    await mapsReady;
    want = { name, code, map: MAPS[roomMap] ? roomMap : S.map };
    let me = null;
    for (let tries = again + 1; !me; tries--) {
      try { me = await room.join(name, code, want.map); }
      catch (err) {
        if (tries > 1 && /in use/.test(err.message)) { $('#room-status').textContent = 'Waiting for your last session to end…'; await sleep(1500); continue; }
        if (auto && /reach/.test(err.message)) { scheduleRejoin(); return; }
        want = null;
        if (/in use/.test(err.message)) $('#room-status').textContent = `${err.message} (Is the field map open in another tab under this name?)`;
        return;
      }
    }
    ls.set(NAME_KEY, JSON.stringify({ name: me.name, at: Date.now() }));
    want.map = me.map;
    if (me.map !== S.map) {
      if (!MAPS[me.map]) { want = null; room.leave(); roomStatus('off', `That room is on ${me.map}, which this page doesn't have.`); return; }
      useMap(me.map, false);
    }
    ses.set(SESSION_KEY, { name: me.name, room: me.room, map: me.map });
    history.replaceState(null, '', `#room=${encodeURIComponent(me.room)}`);
    retryN = 0; synced = false; restoring = false;
    $('#room-name').value = me.name; $('#room-code').value = me.room;
    listening = true;
    room.listen();
  }
  function leaveRoom() {
    if (!room.me) { want = null; return; }
    clearTimeout(retryTimer);
    if (publishTimer) { clearTimeout(publishTimer); publishTimer = 0; publishNow(); }
    writeKept();
    want = null;
    ses.set(SESSION_KEY, null);
    history.replaceState(null, '', location.pathname);
    room.leave();
  }
  $('#room-form').addEventListener('submit', e => {
    e.preventDefault();
    document.activeElement && document.activeElement.blur();
    if (room.me || want) { clearTimeout(retryTimer); leaveRoom(); want = null; roomStatus('off', ''); return; }
    joinRoom($('#room-name').value, $('#room-code').value);
  });
  $('#room-code').addEventListener('input', e => { e.target.value = e.target.value.toLowerCase().replace(/\s+/g, '-'); });
  $('#room-invite').addEventListener('click', async () => {
    const link = `${location.origin}/#room=${encodeURIComponent(room.me.room)}`;
    try { await navigator.clipboard.writeText(link); $('#room-status').textContent = 'Invite link copied. Send it to your squad.'; }
    catch { $('#room-status').textContent = link; }
  });
  // Going to another page or coming back: this tab's session is saved, so the other page joins by itself
  // (beforeunload too, as the field map does: by pagehide the browser has already closed the event stream, which
  // reads as a lost connection and forgets the session, so the leave would never be sent and the name stays taken)
  const goAway = () => { leaving = true; writeKept(); if (room.me) room.leave(); };
  addEventListener('beforeunload', goAway);
  addEventListener('pagehide', goAway);
  addEventListener('pageshow', e => { leaving = false; if (e.persisted && want) joinRoom(want.name, want.code, { again: 3, map: want.map }); });

  async function afterSnapshot() {
    const me = room.me;
    restoring = true;
    try {
      // markings the field map kept for you (it leaves the room when you come here): put back what the server lacks
      const items = keptFor(me) || [];
      planBackup.begin(me, items);
      const result = await PlanSync.restore(items, { current: myItems, active: () => room.me === me,
        deleted: id => planBackup.deleted(me, id),
        remove: itemId => itemWrites(me, itemId, () => api('/api/delete', { id: me.id, token: me.token, itemId })),
        upload: item => itemWrites(me, item.id, () => api('/api/item', { id: me.id, token: me.token, item })), wait: sleep });
      if (!result.cancelled && room.me === me && (result.failed || result.expired)) {
        $('#room-status').textContent = 'Some markings could not be restored. Their browser backup is kept; rejoin to retry.';
      }
    } finally { if (room.me === me) restoring = false; }
    if (room.me !== me) return;
    if (S.from && S.to && S.owner && S.owner !== roomKey() && shotSigOf() === S.ownerSig) {
      // the kept shot belongs to another room or name and hasn't changed since: it stays out of this room
      S.from = null; S.to = null; S.owner = roomKey(); S.ownerSig = null;
      save();
    } else publishNow();
    writeKept();
    render();
  }
  function roomChanged(ev) {
    if (ev?.type === 'delete' && ev.owner === room.me?.name) planBackup.remove(room.me, ev.id);
    if (ev?.type === 'delete' && ev.owner === room.me?.name && ev.id === ses.get(shotIdKey())) {
      S.from = S.to = null; ses.set(shotIdKey(), null); save();
    }
    if (room.me) planBackup.acknowledge(room.me, myItems());
    if (inRoom() && !synced) { synced = true; afterSnapshot(); }
    if (!inRoom()) renderRoomClock();
    render();
  }
  // The room's wind and clock (the snapshot when joining, then 'wind' and 'clock' events). In a room the wind is the
  // room's, one for everyone on the map, the mortar page and here: typed here it goes to the room, set anywhere it comes
  // back here. A room with no wind yet takes the one set here before joining.
  let roomWindTimer = 0;
  function roomSettings(kind) {
    if (kind !== 'clock') {
      const w = room.wind;
      if (w) {
        const typing = [$('#w-s'), $('#w-d')].includes(document.activeElement);
        if (!typing && (w.s !== S.wind.s || w.d !== S.wind.d)) {
          S.wind = { s: w.s, d: ((w.d % 360) + 360) % 360 };
          $('#w-s').value = S.wind.s; $('#w-d').value = S.wind.d;
          changed();
        }
      } else if (!kind && S.wind.s > 0) room.setWind(S.wind).catch(err => console.error(err));
    }
    renderRoomClock();
  }
  function sendWindToRoom() {
    if (!inRoom()) return;
    clearTimeout(roomWindTimer);
    roomWindTimer = setTimeout(() => room.setWind(S.wind).catch(err => { $('#room-status').textContent = err.message; }), 500);
  }
  // The room's game clock, shown and set here as on the map (whose Map settings also has its sun and moon, date and speed)
  const CLOCK_DEFAULT = { rate: 1, year: 2035, month: 6, day: 21, lat: 49 };
  function renderRoomClock() {
    const on = inRoom(), now = on ? room.gameNow() : null;
    $('#room-clock').classList.toggle('hidden', !on);
    if (!on) return;
    const t = now == null ? null : Math.floor(((now % 86400) + 86400) % 86400), rate = room.clock && room.clock.rate;
    $('#room-clock-time').textContent = t == null ? 'not set' : `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor(t % 3600 / 60)).padStart(2, '0')}` +
      (rate === 0 ? ' (paused)' : rate > 1 ? ` (${rate}×)` : '');
  }
  setInterval(renderRoomClock, 1000);
  $('#room-clock').addEventListener('submit', async e => {
    e.preventDefault();
    const m = /^(\d{1,2})[:.]?(\d{2})$/.exec($('#room-clock-in').value.trim());
    if (!m || +m[1] > 23 || +m[2] > 59) { $('#room-status').textContent = 'Type the game time as hours and minutes, like 06:42.'; return; }
    const c = { ...CLOCK_DEFAULT, ...(room.clock || {}) };
    try {
      await room.setClock({ game: +m[1] * 3600 + +m[2] * 60, rate: c.rate, year: c.year, month: c.month, day: c.day, lat: c.lat });
      $('#room-clock-in').value = '';
    } catch (err) { $('#room-status').textContent = err.message; }
  });

  // The room on the map (enemy markings and positions, click one to use it) and the list of shots
  let lastShotsHtml = '';
  function renderRoom() {
    const on = inRoom();
    $('#room-invite').classList.toggle('hidden', !on);
    $('#shots-card').classList.toggle('hidden', !on);
    const hash = on ? `#room=${encodeURIComponent(room.me.room)}&name=${encodeURIComponent(room.me.name)}` : '';
    $('#to-map').href = `/${on ? `#room=${encodeURIComponent(room.me.room)}` : ''}`;
    $('#to-mortar').href = `/mortar.html${hash}`;
    if ($('#to-base')) $('#to-base').href = `/base.html${hash}`;
    roomLayer.clearLayers();
    if (!on) { lastShotsHtml = ''; return; }
    if (S.mode === 'map') for (const pt of roomPoints()) {
      const c = L.circleMarker(toLL(pt.xz), { radius: pt.enemy ? 7 : 6, color: '#0b0f12', weight: 2, fillColor: pt.enemy ? '#ff5c5c' : (pt.color || '#6cb8ff'),
        fillOpacity: 0.95, bubblingMouseEvents: false })
        .bindTooltip(`${esc(pt.label)}${pt.enemy ? ' · click: target' : ' · click: fire from here'}`, { className: 'item-label', direction: 'top', offset: [0, -8] });
      c.on('click', () => setEnd(pt.enemy ? 'to' : 'from', pt.xz));
      roomLayer.addLayer(c);
    }
    const mineId = myShot() && myShot().id, shots = [];
    for (const [name, p] of room.players) for (const it of p.items.values()) if (isShot(it)) shots.push({ name, color: p.color, it });
    const html = shots.length ? shots.map(({ name, color, it }) => `<div class="mate${it.id === mineId ? ' on' : ''}"><span class="sw" style="background:${esc(color)}"></span>` +
      `<span class="t"><b>${esc(it.label || 'Shot')} · ${esc(name)}</b><span>${esc(SC.rocketName(it.rocket.l, it.rocket.r))} · ${fmtDist(dist(it.from, it.to))}</span></span>` +
      (it.id === mineId ? '<span class="note" style="margin:0">this one</span>' : `<button type="button" data-load="${esc(name)}|${esc(it.id)}">Open</button>`) + '</div>').join('')
      : '<div class="empty">No shots in the room yet. Yours appears here, and on the full map, once both ends are set.</div>';
    if (html !== lastShotsHtml) { $('#shots').innerHTML = html; lastShotsHtml = html; }
  }
  $('#shots').addEventListener('click', e => {
    const b = e.target.closest('[data-load]');
    if (!b) return;
    const [name, id] = b.dataset.load.split('|'), p = room.players.get(name), it = p && p.items.get(id);
    if (!it) return;
    if (name === room.me.name) ses.set(shotIdKey(), id); // one of yours: the planner now edits it
    loadShot(it);
  });

  // --- Start: the map list, the flights, then the room this tab was in (or the one in the link) ------------------------
  const mapsReady = fetch('/api/maps').then(r => r.json()).then(d => {
    Object.entries(d.maps).forEach(([id, m]) => {
      MAPS[id] = { id, name: m.title || id, size: m.world, dir: `/data/maps/${id}`, tiles: m.tiles, cols: m.lightCols || 1300 };
    });
    useMap(MAPS[S.map] ? S.map : d.default, true);
  }).catch(err => { console.error(err); $('#result').innerHTML = '<div class="empty err-box"><b>Could not load the map list.</b></div>'; });
  fetch('/data/rockets.json').then(r => r.json()).then(d => { SC.setRockets(d); render(); })
    .catch(err => { console.error(err); $('#result').innerHTML = '<div class="empty err-box"><b>Could not load the rocket data.</b></div>'; });
  fetch('/data/bullets.json').then(r => r.ok ? r.json() : null).then(d => { if (d) { SC.setBullets(d); render(); } }).catch(err => console.error(err));
  setMode(S.mode === 'range' ? 'range' : 'map');

  const hp = new URLSearchParams(location.hash.slice(1)), session = ses.get(SESSION_KEY);
  const hashRoom = (hp.get('room') || '').trim(), hashName = (hp.get('name') || '').trim();
  $('#room-name').value = hashName || (session && session.name) || nameKept() || '';
  $('#room-code').value = hashRoom || (session && session.room) || '';
  const roomMap = session && session.room === (hashRoom || session.room) ? session.map : null;
  if (hashRoom && (hashName || (session && session.room === hashRoom))) joinRoom(hashName || session.name, hashRoom, { again: 3, map: roomMap });
  else if (!hashRoom && session && session.room) joinRoom(session.name, session.room, { again: 3, map: roomMap });
})();

/* Base design page: pick a Conflict base, see its cap and build zones, lay out its defences (the field map's own Defend
   markings: bunkers, MG nests, watch posts, sandbags, wire, tank traps, checkpoints, sectors of fire, TRPs) and see the
   dead ground round it and where an enemy can see into it. The line of sight is the field map's Measured model
   (los-worker.js). On its own the plan stays in this browser; joined to a room the defences are your markings, so the
   full map and everyone else sees them (see Room below). */
(() => {
  'use strict';
  const $ = sel => document.querySelector(sel);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------------------------------------------------------------------------
  // Coordinates (as the field map: game X runs east, Z north, metres; tiles 1 unit = 1 m with a 50 m offset)
  // ---------------------------------------------------------------------------
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
  const grid = ([x, z]) => `${pad(x / 100, 3)} ${pad(z / 100, 3)}`;
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const bearing = (a, b) => ((Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI) + 360) % 360;
  const fmtDist = m => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`);
  const round1 = v => Math.round(v * 10) / 10;
  const roundXZ = p => [round1(p[0]), round1(p[1])];
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const FRIENDLY = '#6cb8ff';

  // Conflict base kinds and their colours (the field map's CONFLICT_STYLE); radio ranges from the game data
  const KINDS = {
    'Main base (HQ)': ['#ff6b6b', 'H'], 'Military base': ['#ffa94d', 'M'], 'Town base': ['#74c0fc', 'T'],
    'Small base': ['#a9e34b', 'S'], 'Radio tower': ['#da77f2', 'R'],
  };
  const radioRange = b => (b.kind === 'Radio tower' ? 3000 : 2000);
  const ZONES = {
    cap: { r: () => 50, style: { color: '#ffd43b', weight: 2, fillColor: '#ffd43b', fillOpacity: 0.12 } },
    build: { r: () => 100, style: { color: '#74c0fc', weight: 1.8, dashArray: '6 5', fillColor: '#74c0fc', fillOpacity: 0.05 } },
    radio: { r: radioRange, style: { color: '#e599f7', weight: 1.5, dashArray: '2 6', fill: false } },
  };

  // The defences: the field map's Defend markings, in the same shapes it saves them
  const { TOOLS, isGun, toolOf, makeItem } = BaseItems({ catalog: window.ConstructionCatalog,
    state: () => S, uid, nextLabel, myColor: () => myColor(), roundXZ, bearing, dist, friendly: FRIENDLY });
  // Build the palette from the same catalog used by the squad map and 3D view.
  $('#tools').innerHTML = [...new Set(Object.values(TOOLS).map(t => t.group))].map(group =>
    `<div class="tool-group"><h3>${esc(group)}</h3><div class="tools">${Object.entries(TOOLS).filter(([, t]) => t.group === group).map(([id, t]) =>
      `<button data-tool="${id}" title="${esc(t.kind === 'line' ? 'Click along the line; Enter finishes' : t.kind === 'aim' ? 'Click to place, then click to aim and set reach' : 'Click to place')}">${esc(t.name)}</button>`).join('')}</div></div>`).join('');
  const LINE_STYLE = {
    'dragon-teeth': { color: '#aab4bd', weight: 5, dashArray: '4 5', opacity: 0.95 },
    wall: { color: '#c8b27c', weight: 6, opacity: 0.95 },
    wire: { color: '#ced4da', weight: 2.5, dashArray: '3 4', opacity: 0.95 },
    roadblock: { color: '#ffa94d', weight: 4, dashArray: '1 7', lineCap: 'square', opacity: 0.95 },
  };
  const anchor = it => it.xz || (it.points && it.points[0]);

  // ---------------------------------------------------------------------------
  // What's been set, kept in this browser
  // ---------------------------------------------------------------------------
  // (for 5 minutes after the page was last open, so an old session never comes back; `owner`, the room and name the plan
  // was last in, and `ownerSig`, what it was then: joining a room, the kept plan goes into it only if it was made for
  // that room and name, or outside any room, or changed since)
  const KEY = 'everon-base-page', KEEP_MS = 5 * 60e3;
  const S = { map: null, tool: null, sel: null, arc: 60, postRange: 400, sectorCount: 4, reach: 400, dead: true, enemy: false,
    owner: '', ownerSig: null,
    zones: { cap: true, build: true, radio: false }, perMap: {} /* map id -> { base: name, items: [] } */ };
  (function restore() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (!v) return;
      if (!(Date.now() - (v.at || 0) < KEEP_MS)) { localStorage.removeItem(KEY); return; } // an old session: start clean
      S.owner = typeof v.owner === 'string' ? v.owner : ''; S.ownerSig = v.ownerSig || null;
      Object.assign(S, {
        map: v.map || null, arc: [30, 60, 90, 120, 180].includes(v.arc) ? v.arc : 60, postRange: [200, 400, 800].includes(v.postRange) ? v.postRange : 400,
        sectorCount: [3, 4, 6, 8].includes(v.sectorCount) ? v.sectorCount : 4, reach: [200, 400, 600, 800, 1600, 2400].includes(v.reach) ? v.reach : 400,
        dead: v.dead !== false, enemy: !!v.enemy,
      });
      if (v.zones) for (const k of Object.keys(S.zones)) S.zones[k] = !!v.zones[k];
      for (const [id, m] of Object.entries(v.perMap || {})) {
        S.perMap[id] = { base: typeof m.base === 'string' ? m.base : null, items: (m.items || []).filter(it => it && typeof it.id === 'string' && toolOf(it) && anchor(it)).slice(0, 200) };
      }
    } catch (e) { /* nothing saved, or storage is off */ }
  })();
  let ownedBy = () => null; // the room and name the plan now belongs to, while in a room (set up with the room below)
  const planSig = () => JSON.stringify(S.perMap);
  function save() {
    const owner = ownedBy();
    if (owner) { S.owner = owner; S.ownerSig = planSig(); }
    try {
      localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), owner: S.owner, ownerSig: S.ownerSig, map: S.map, arc: S.arc,
        postRange: S.postRange, sectorCount: S.sectorCount, reach: S.reach, dead: S.dead, enemy: S.enemy, zones: S.zones, perMap: S.perMap }));
    } catch (e) { /* not remembered */ }
  }
  setInterval(() => { // while the page is open the 5 minutes don't run
    try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); if (v) { v.at = Date.now(); localStorage.setItem(KEY, JSON.stringify(v)); } } catch { /* storage unavailable */ }
  }, 60e3);
  const cur = () => (S.perMap[S.map] = S.perMap[S.map] || { base: null, items: [] });

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------
  let MAPS = {}, WORLD = 12800, BASES = [], HEIGHT = null, HN = 1300, loadGen = 0;
  const base = () => BASES.find(b => b.name === cur().base) || null;

  function heightAt([x, z]) {
    if (!HEIGHT) return null;
    const fx = Math.min(Math.max(x / 10 - 0.5, 0), HN - 1), fz = Math.min(Math.max(z / 10 - 0.5, 0), HN - 1);
    const c0 = Math.floor(fx), r0 = Math.floor(fz), c1 = Math.min(c0 + 1, HN - 1), r1 = Math.min(r0 + 1, HN - 1);
    const tx = fx - c0, tz = fz - r0, v = (r, c) => HEIGHT[r * HN + c] / 10;
    const south = v(r0, c0) + (v(r0, c1) - v(r0, c0)) * tx, north = v(r1, c0) + (v(r1, c1) - v(r1, c0)) * tx;
    return south + (north - south) * tz;
  }

  // ---------------------------------------------------------------------------
  // Map
  // ---------------------------------------------------------------------------
  const map = L.map('map', { crs: CRS, center: toLL([6400, 6400]), zoom: 0, minZoom: -1, maxZoom: 7, zoomSnap: 0.5, attributionControl: false,
    doubleClickZoom: false });
  map.zoomControl.setPosition('bottomright');
  const BLANK_TILE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const MapTiles = L.TileLayer.extend({
    getTileUrl(c) {
      const z = 5 - c.z, n = 2 ** (7 - z), y = -(c.y + 1), url = this.options.url;
      if (!url || c.x < 0 || y < 0 || c.x >= n || y >= n) return BLANK_TILE;
      return url.replace('{z}', z).replace('{x}', c.x).replace('{y}', y);
    },
  });
  const GridOverlay = L.GridLayer.extend({
    createTile(coords) {
      const size = this.getTileSize(), c = document.createElement('canvas');
      c.width = size.x; c.height = size.y;
      const ctx = c.getContext('2d'), b = this._tileCoordsToBounds(coords);
      const w = b.getWest() - OFFSET, e = b.getEast() - OFFSET, s = b.getSouth() - OFFSET, n = b.getNorth() - OFFSET;
      const px = g => Math.round((g - w) / (e - w) * size.x) + 0.5, py = g => Math.round((n - g) / (n - s) * size.y) + 0.5;
      for (const step of coords.z >= 2.5 ? [100, 1000] : [1000]) {
        ctx.strokeStyle = step === 1000 ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.13)';
        ctx.beginPath();
        for (let g = Math.ceil(w / step) * step; g <= e; g += step) {
          if (g < 0 || g > WORLD) continue;
          ctx.moveTo(px(g), Math.max(0, py(WORLD))); ctx.lineTo(px(g), Math.min(size.y, py(0)));
        }
        for (let g = Math.ceil(s / step) * step; g <= n; g += step) {
          if (g < 0 || g > WORLD) continue;
          ctx.moveTo(Math.max(0, px(0)), py(g)); ctx.lineTo(Math.min(size.x, px(WORLD)), py(g));
        }
        ctx.stroke();
      }
      ctx.font = '600 11px Consolas, monospace'; ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 3;
      const label = (t, x, y) => { ctx.strokeText(t, x, y); ctx.fillText(t, x, y); };
      for (let g = Math.ceil(w / 1000) * 1000; g <= e; g += 1000) if (g >= 0 && g <= WORLD) label(pad(g / 100, 3), px(g) + 3, 12);
      for (let g = Math.ceil(s / 1000) * 1000; g <= n; g += 1000) if (g >= 0 && g <= WORLD) label(pad(g / 100, 3), 3, py(g) - 3);
      return c;
    },
  });
  let tileLayer = null, gridLayer = null;
  map.createPane('shade').style.zIndex = 350;   // line-of-sight shading, over the tiles and under the markings
  const shadeLayer = L.layerGroup().addTo(map);
  const zoneLayer = L.layerGroup().addTo(map);  // the chosen base's zones
  const baseLayer = L.layerGroup().addTo(map);  // every base, to pick from
  const roomLayer = L.layerGroup().addTo(map);  // the squad's defences
  const itemLayer = L.layerGroup().addTo(map);  // yours
  const draftLayer = L.layerGroup().addTo(map); // what's being drawn

  function showMapBase(id) {
    const m = MAPS[id];
    WORLD = m.world;
    const bounds = L.latLngBounds(toLL([0, 0]), toLL([WORLD, WORLD]));
    if (tileLayer) tileLayer.remove();
    if (gridLayer) gridLayer.remove();
    tileLayer = new MapTiles('', { url: m.tiles, minZoom: -1, maxZoom: 7, minNativeZoom: 0, maxNativeZoom: 5, bounds, keepBuffer: 3, errorTileUrl: BLANK_TILE }).addTo(map);
    tileLayer.bringToBack();
    gridLayer = new GridOverlay({ bounds, zIndex: 5, minZoom: -1, maxZoom: 7 }).addTo(map);
    map.setMaxBounds(bounds.pad(0.25));
  }
  function zoomTo(radius) {
    const b = base();
    map.invalidateSize({ animate: false });
    if (!b) {
      const size = map.getSize(), fit = size.x && size.y ? Math.log2(Math.min(size.x, size.y) / (WORLD / SCALE)) : 0;
      map.setView(toLL([WORLD / 2, WORLD / 2]), Math.min(3, Math.max(-1, Math.round(fit * 2) / 2)), { animate: false });
      return;
    }
    const r = radius * 1.08;
    map.fitBounds(L.latLngBounds(toLL([b.xz[0] - r, b.xz[1] - r]), toLL([b.xz[0] + r, b.xz[1] + r])), { maxZoom: 6, animate: false });
  }

  const glyph = (ch, color, cls = '') => L.divIcon({ className: `glyph ${cls}`, iconSize: [0, 0], html: `<div style="background:${color}">${esc(ch)}</div>` });
  const tag = text => ({ permanent: true, direction: 'right', offset: [14, 0], className: 'item-label', content: text });
  const tip = text => ({ direction: 'right', offset: [14, 0], className: 'item-label', content: text });
  // A wedge from xz, centred on dir, arc degrees wide, out to range
  function wedge(xz, dir, arc, range) {
    const pts = arc >= 360 ? [] : [toLL(xz)], n = Math.max(8, Math.round(arc / 4));
    for (let i = 0; i <= n; i++) {
      const a = (dir - arc / 2 + arc * i / n) * Math.PI / 180;
      pts.push(toLL([xz[0] + range * Math.sin(a), xz[1] + range * Math.cos(a)]));
    }
    return pts;
  }

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------
  function renderBases() {
    baseLayer.clearLayers();
    const chosen = cur().base;
    for (const b of BASES) {
      const [color, ch] = KINDS[b.kind] || ['#ced4da', '?'], on = b.name === chosen;
      const mk = L.marker(toLL(b.xz), { keyboard: false, zIndexOffset: on ? 200 : 0, icon: glyph(ch, color, `base${on ? ' on' : ''}`) });
      mk.bindTooltip(esc(`${b.name} · ${b.kind}`), on ? tag() : tip());
      mk.on('click', e => { if (S.tool) { L.DomEvent.stop(e); mapClick(b.xz); } else pickBase(b.name, true); });
      baseLayer.addLayer(mk);
    }
  }
  function renderZones() {
    zoneLayer.clearLayers();
    const b = base();
    if (!b) return;
    for (const [k, z] of Object.entries(ZONES)) {
      if (!S.zones[k]) continue;
      zoneLayer.addLayer(L.circle(toLL(b.xz), { radius: z.r(b), interactive: false, ...z.style }));
    }
  }
  // One defence on the map. mine: draggable and selectable; else a teammate's, dimmed.
  function drawItem(layer, it, color, mine, owner) {
    const t = toolOf(it), sel = mine && S.sel === it.id, label = `${it.label || TOOLS[t].name}${owner ? ` (${owner})` : ''}`;
    const dim = mine ? 1 : 0.55;
    if (TOOLS[t].kind === 'line' && it.points) {
      const pts = it.points.map(toLL);
      layer.addLayer(L.polyline(pts, { color: '#080b0e', weight: (LINE_STYLE[t].weight || 3) + 3, opacity: 0.55 * dim, interactive: false }));
      const ln = L.polyline(pts, { ...LINE_STYLE[t], opacity: LINE_STYLE[t].opacity * dim, interactive: mine });
      ln.bindTooltip(esc(label), { sticky: true, className: 'item-label' });
      if (mine) ln.on('click', e => { L.DomEvent.stop(e); select(it.id); });
      if (sel) layer.addLayer(L.polyline(pts, { color: '#fff', weight: 2, dashArray: '4 4', interactive: false }));
      layer.addLayer(ln);
      return;
    }
    if (isGun(t)) {
      layer.addLayer(L.polygon(wedge(it.xz, it.dir, it.arc, it.range), { color, weight: 1.5, dashArray: '5 4', fillColor: color, fillOpacity: 0.1 * dim, opacity: dim, interactive: false }));
    } else if (t === 'post') {
      layer.addLayer(L.circle(toLL(it.xz), { radius: it.range, color, weight: 1.3, dashArray: '3 6', fill: false, opacity: 0.8 * dim, interactive: false }));
    } else if (t === 'sectors') {
      layer.addLayer(L.circle(toLL(it.xz), { radius: it.radius, color, weight: 1.5, fill: false, opacity: dim, interactive: false }));
      for (let i = 0; i < it.n; i++) {
        const a = (it.start + 360 * i / it.n) * Math.PI / 180, mid = (it.start + 360 * (i + 0.5) / it.n) * Math.PI / 180;
        layer.addLayer(L.polyline([toLL(it.xz), toLL([it.xz[0] + it.radius * Math.sin(a), it.xz[1] + it.radius * Math.cos(a)])], { color, weight: 1.5, opacity: dim, interactive: false }));
        const name = (it.names && it.names[i]) || String.fromCharCode(65 + i), at = [it.xz[0] + it.radius * 0.7 * Math.sin(mid), it.xz[1] + it.radius * 0.7 * Math.cos(mid)];
        layer.addLayer(L.marker(toLL(at), { interactive: false, keyboard: false,
          icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<span class="ring-label" style="--c:${color};transform:translate(-50%,-50%)">${esc(name)}</span>` }) }));
      }
    }
    const mk = L.marker(toLL(it.xz), { keyboard: false, draggable: mine, zIndexOffset: mine ? 400 : 100,
      icon: glyph(TOOLS[t].glyph || 'TT', t === 'trp' ? '#ffd43b' : color, `def${mine ? '' : ' mate'}${sel ? ' sel' : ''}`) });
    mk.bindTooltip(esc(label), mine && (sel || t === 'trp') ? tag() : tip());
    if (mine) {
      mk.on('click', e => { L.DomEvent.stop(e); select(it.id); });
      mk.on('dragend', () => moveItem(it.id, toXZ(mk.getLatLng())));
    }
    layer.addLayer(mk);
  }
  function renderItems() {
    itemLayer.clearLayers();
    const color = myColor();
    for (const it of cur().items) drawItem(itemLayer, it, it.color || color, true);
  }
  function renderRoomMap() {
    roomLayer.clearLayers();
    if (!inRoom()) return;
    for (const { name, color, it } of squadDefences()) drawItem(roomLayer, it, it.color || color, false, name);
  }

  // The panel: tool options and the list of defences
  function renderToolOpts() {
    document.querySelectorAll('#tools [data-tool]').forEach(b => b.classList.toggle('sel', b.dataset.tool === S.tool));
    const seg = (key, vals, unit = '') => `<span class="seg">${vals.map(v => `<button data-opt="${key}" data-v="${v}" class="${S[key] === v ? 'sel' : ''}">${v}${unit}</button>`).join('')}</span>`;
    const o = $('#tool-opts');
    o.innerHTML = isGun(S.tool) ? `<span>${S.tool === 'aa-mg' ? 'Ground field of fire' : 'Field of fire'}</span>${seg('arc', [30, 60, 90, 120, 180], '°')}`
      : S.tool === 'post' ? `<span>Watches out to</span>${seg('postRange', [200, 400, 800])}<span>m</span>`
        : S.tool === 'sectors' ? `<span>Sectors</span>${seg('sectorCount', [3, 4, 6, 8])}`
          : TOOLS[S.tool] && TOOLS[S.tool].kind === 'line' ? '<span>Click along the line. Double-click or press Enter to finish, Esc to stop.</span>' : '';
  }
  function itemFacts(it, b) {
    const t = toolOf(it), at = anchor(it), from = b ? ` · ${fmtDist(dist(b.xz, at))} ${pad(Math.round(bearing(b.xz, at)) % 360, 3)}°` : '';
    if (TOOLS[t].kind === 'line' && it.points) {
      let len = 0;
      for (let i = 1; i < it.points.length; i++) len += dist(it.points[i - 1], it.points[i]);
      return `${Math.round(len)} m long${from}`;
    }
    if (isGun(t)) return `aims ${pad(it.dir, 3)}° · ${it.arc}° wide${from}`;
    if (t === 'post') return `watches ${it.range} m${from}`;
    if (t === 'sectors') return `${it.n} sectors · ${it.radius} m${from}`;
    return from.slice(3);
  }
  function renderList() {
    const items = cur().items, b = base(), box = $('#items');
    $('#items-actions').classList.toggle('hidden', !items.length);
    let html = items.length ? items.map(it => {
      const t = toolOf(it);
      return `<div class="item ${S.sel === it.id ? 'on' : ''}" data-sel="${esc(it.id)}"><span class="k">${esc(it.label || TOOLS[t].name)}</span>` +
        `<span class="g">${grid(anchor(it))}</span><span class="m">${esc(itemFacts(it, b))}</span><span class="sp"></span>` +
        `<button class="ghost" data-del="${esc(it.id)}" title="Remove" aria-label="Remove ${esc(it.label || TOOLS[t].name)}">✕</button></div>`;
    }).join('') : `<div class="empty">${b ? 'Pick a tool above, then click the map.' : 'Pick a base first, or just start placing.'}</div>`;
    const mates = inRoom() ? squadDefences() : [];
    if (mates.length) {
      html += `<div class="note" style="margin:8px 0 2px">From the squad</div>` + mates.map(({ name, color, it }) =>
        `<div class="item mate"><span class="dot" style="background:${esc(it.color || color)}"></span><span class="k">${esc(it.label || TOOLS[toolOf(it)].name)}</span>` +
        `<span class="m">${esc(name)}</span><span class="sp"></span><span class="g">${grid(anchor(it))}</span></div>`).join('');
    }
    box.innerHTML = html;
  }
  function renderBaseNote() {
    const b = base(), note = $('#base-note');
    $('#base-pick').value = b ? b.name : '';
    $('#radio-label').textContent = b ? `Radio range ${radioRange(b) / 1000} km` : 'Radio range';
    if (!b) { note.textContent = BASES.length ? 'Or click a base on the map.' : 'This map has no Conflict bases listed.'; return; }
    const h = heightAt(b.xz);
    note.textContent = `${b.kind}${b.control ? ' · control point' : ''} · ${grid(b.xz)}${h != null ? ` · ground ${Math.round(h)} m` : ''}`;
  }
  function renderHint() {
    const t = S.tool;
    let text;
    if (!HEIGHT) text = 'Loading…';
    else if (!t) text = base() ? 'Pick an object to place, or click a base to switch' : 'Click a base to start';
    else if (draft && TOOLS[t].kind === 'aim') text = isGun(t) ? `Click where the ${TOOLS[t].name} aims` : 'Click how far out the sectors go';
    else if (draft) text = `${draft.pts.length} point${draft.pts.length === 1 ? '' : 's'} · double-click or Enter to finish · Esc to stop`;
    else text = isGun(t) ? `Click where the ${TOOLS[t].name} goes` : t === 'sectors' ? 'Click the centre of the sectors' : TOOLS[t].kind === 'line' ? `Click where the ${TOOLS[t].name.toLowerCase()} start` : `Click where the ${TOOLS[t].name.toLowerCase()} goes`;
    $('#hint').textContent = text;
    $('#map').classList.toggle('aiming', !!t);
  }
  function render() {
    renderBases(); renderZones(); renderItems(); renderRoomMap(); renderToolOpts(); renderList(); renderBaseNote(); renderHint(); updatePageLinks();
    losSoon();
  }

  // ---------------------------------------------------------------------------
  // Changes
  // ---------------------------------------------------------------------------
  const inWorld = xz => xz[0] >= 0 && xz[1] >= 0 && xz[0] <= WORLD && xz[1] <= WORLD;
  const myColor = () => (room.me && room.me.color) || FRIENDLY;
  function pickBase(name, zoom) {
    cur().base = name || null;
    S.sel = null;
    save(); render();
    if (zoom) zoomTo(160);
  }
  function select(id) {
    S.sel = S.sel === id ? null : id;
    renderItems(); renderList();
  }
  // How many of this kind you have, for its number ("Bunker 3"); TRPs are numbered across the whole squad
  function nextLabel(t) {
    if (t === 'trp') {
      const used = new Set([...cur().items, ...squadDefences().map(x => x.it)].filter(i => toolOf(i) === 'trp').map(i => (/^TRP (\d+)/.exec(i.label || '') || [])[1]));
      let n = 1;
      while (used.has(String(n))) n++;
      return `TRP ${n}`;
    }
    const used = new Set(cur().items.filter(i => toolOf(i) === t).map(i => i.label));
    let n = 1;
    while (used.has(`${TOOLS[t].name} ${n}`)) n++;
    return `${TOOLS[t].name} ${n}`;
  }
  function addItem(it) {
    cur().items.push(it);
    S.sel = it.id;
    save(); render();
    publish(it);
  }
  function moveItem(id, xz) {
    const it = cur().items.find(i => i.id === id);
    if (!it || !it.xz) return;
    if (!inWorld(xz)) { toast("That's off the map."); render(); return; }
    it.xz = roundXZ(xz);
    S.sel = id;
    save(); render();
    publish(it);
  }
  function removeItem(id) {
    const m = cur();
    m.items = m.items.filter(i => i.id !== id);
    if (S.sel === id) S.sel = null;
    save(); render();
    unpublish(id);
  }

  // Placing: points take one click; MG nests and sectors two (where, then aim); lines a click per point
  let draft = null; // { tool, pts }
  function setTool(t) {
    S.tool = S.tool === t ? null : t;
    cancelDraft();
    renderToolOpts(); renderHint();
  }
  function cancelDraft() { draft = null; draftLayer.clearLayers(); renderHint(); }
  function mapClick(xz) {
    const t = S.tool;
    if (!t || !HEIGHT) return;
    if (!inWorld(xz)) return toast("That's off the map.");
    const kind = TOOLS[t].kind;
    if (kind === 'point') { addItem(makeItem(t, xz)); return; }
    if (kind === 'aim') {
      if (!draft) { draft = { tool: t, pts: [xz] }; drawDraft(xz); renderHint(); return; }
      if (dist(draft.pts[0], xz) < (isGun(t) ? 10 : 20)) return toast('Click a bit further out.');
      const it = makeItem(t, draft.pts[0], xz);
      cancelDraft();
      addItem(it);
      return;
    }
    // a line: a double-click lands two clicks on one spot first, so a point on top of the last one is skipped
    if (!draft) draft = { tool: t, pts: [] };
    const last = draft.pts[draft.pts.length - 1];
    if (!last || dist(last, xz) > 1) draft.pts.push(xz);
    if (draft.pts.length >= 200) return finishLine();
    drawDraft(xz); renderHint();
  }
  function finishLine() {
    if (!draft || TOOLS[draft.tool].kind !== 'line') return;
    if (draft.pts.length < 2) { cancelDraft(); return toast('A line needs two points or more.'); }
    const it = makeItem(draft.tool, draft.pts);
    cancelDraft();
    addItem(it);
  }
  function drawDraft(cursor) {
    draftLayer.clearLayers();
    if (!draft) return;
    const t = draft.tool, color = myColor(), a = draft.pts[0];
    if (TOOLS[t].kind === 'line') {
      const pts = [...draft.pts, ...(cursor ? [cursor] : [])].map(toLL);
      draftLayer.addLayer(L.polyline(pts, { ...LINE_STYLE[t], interactive: false }));
      draft.pts.forEach(p => draftLayer.addLayer(L.circleMarker(toLL(p), { radius: 3, color: '#fff', weight: 1, fillColor: LINE_STYLE[t].color, fillOpacity: 1, interactive: false })));
    } else if (cursor && dist(a, cursor) >= 1) {
      const r = dist(a, cursor), dir = bearing(a, cursor);
      if (isGun(t)) draftLayer.addLayer(L.polygon(wedge(a, dir, S.arc, r), { color, weight: 1.5, dashArray: '5 4', fillColor: color, fillOpacity: 0.12, interactive: false }));
      else {
        draftLayer.addLayer(L.circle(toLL(a), { radius: r, color, weight: 1.5, dashArray: '5 4', fill: false, interactive: false }));
        for (let i = 0; i < S.sectorCount; i++) {
          const ang = (dir + 360 * i / S.sectorCount) * Math.PI / 180;
          draftLayer.addLayer(L.polyline([toLL(a), toLL([a[0] + r * Math.sin(ang), a[1] + r * Math.cos(ang)])], { color, weight: 1.2, interactive: false }));
        }
      }
      draftLayer.addLayer(L.marker(toLL(cursor), { interactive: false, keyboard: false,
        icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<span class="ring-label">${Math.round(r)} m · ${pad(Math.round(dir) % 360, 3)}°</span>` }) }));
    }
    if (a && TOOLS[t].kind === 'aim') draftLayer.addLayer(L.marker(toLL(a), { interactive: false, keyboard: false, icon: glyph(TOOLS[t].glyph, color, 'def') }));
  }

  // ---------------------------------------------------------------------------
  // What can be seen: the field map's Measured line of sight (los-worker.js), one run per position
  // ---------------------------------------------------------------------------
  // Dead ground: from every position (bunkers, MG nests within their field of fire, watch posts, checkpoints, sector
  // centres; yours and the squad's), looking for a crouched enemy (1 m) out to the chosen distance. Ground none of them
  // sees is shaded. With no positions yet, it's from the middle of the base.
  // Enemy view: from the middle of the cap zone and four points 40 m out, which spots an enemy standing (1.7 m eye)
  // could see a man standing there from. Sight lines run both ways, so it's the same run with the heights swapped.
  const CELL = 2.5, HIDDEN = 1, CLEAR = 2, TREES = 3, RANK = [0, 1, 3, 2];
  let worker = null, workerMap = null, reqSeq = 0, losTimer = 0, losGen = 0, losFailed = false;
  const losCache = new Map(); // key -> result
  const losWanted = new Map(); // request id -> { key, gen }
  const fullSupported = () => typeof Worker !== 'undefined' && typeof DecompressionStream !== 'undefined';
  function ensureWorker() {
    if (worker && workerMap === S.map) return worker;
    if (worker) worker.terminate();
    losCache.clear(); losWanted.clear();
    workerMap = S.map;
    worker = new Worker('/los-worker.js');
    worker.onmessage = e => {
      const d = e.data, w = losWanted.get(d.id);
      if (!w) return;
      losWanted.delete(d.id);
      if (d.error) {
        console.error('Line of sight:', d.error);
        if (!losFailed) { losFailed = true; $('#los-note').textContent = 'Could not load the line of sight data for this map.'; }
        return;
      }
      losCache.set(w.key, d);
      while (losCache.size > 60) losCache.delete(losCache.keys().next().value);
      if (w.gen === losGen) drawShading();
    };
    return worker;
  }
  const workerCfg = () => {
    const dir = `/data/maps/${S.map}`;
    const foliageDir = losModel === 'mesh' ? `${dir}/foliage-mesh` : dir;
    return { size: WORLD, losDir: `${dir}/los`, profiles: { json: `${foliageDir}/foliage/foliage_profiles.json`, plants: `${foliageDir}/foliage.json`, dir: `${foliageDir}/plants` } };
  };
  let losModel = 'profiles';
  try { if (localStorage.getItem('everon-map-los-detail') === 'mesh') losModel = 'mesh'; } catch { /* storage unavailable */ }
  $('#los-model').value = losModel;
  $('#los-model').addEventListener('change', e => {
    losModel = e.target.value; losFailed = false;
    try { localStorage.setItem('everon-map-los-detail', losModel); } catch { /* storage unavailable */ }
    requestLos();
  });
  const reqKey = r => `${S.map}|${losModel}|${r.xz}|${r.dir}|${r.arc}|${r.range}|${r.eyeH}|${r.targetH}`;
  // The runs the current plan needs, each { xz, dir, arc, range, eyeH, targetH }
  function deadRuns(b) {
    const out = [], R = S.reach;
    const all = [...cur().items, ...(inRoom() ? squadDefences().map(x => x.it) : [])];
    for (const it of all) {
      const t = toolOf(it);
      if (!it.xz || dist(it.xz, b.xz) > R + 200) continue;
      if (isGun(t)) out.push({ xz: it.xz, dir: it.dir, arc: it.arc, range: R, eyeH: 1.2 + (it.height || 0), targetH: 1 });
      else if ((t === 'bunker' || t === 'sandbag-position')) out.push({ xz: it.xz, dir: 0, arc: 360, range: R, eyeH: 1.2, targetH: 1 });
      else if (t === 'post' || t === 'checkpoint' || t === 'sectors') out.push({ xz: it.xz, dir: 0, arc: 360, range: R, eyeH: 1.6, targetH: 1 });
    }
    // no positions yet: the middle of the base and four spots 40 m out (the middle alone is often inside a building)
    if (!out.length) for (const xz of aroundBase(b)) out.push({ xz, dir: 0, arc: 360, range: R + 40, eyeH: 1.6, targetH: 1, fallback: true });
    return out.slice(0, 24);
  }
  const aroundBase = b => [b.xz, ...[0, 90, 180, 270].map(a => roundXZ([b.xz[0] + 40 * Math.sin(a * Math.PI / 180), b.xz[1] + 40 * Math.cos(a * Math.PI / 180)]))];
  function enemyRuns(b) {
    return aroundBase(b).map(xz => ({ xz, dir: 0, arc: 360, range: S.reach + 40, eyeH: 1.7, targetH: 1.7 }));
  }
  function losSoon() {
    clearTimeout(losTimer);
    losTimer = setTimeout(requestLos, 250);
  }
  let runs = { dead: [], enemy: [] };
  function requestLos() {
    const b = base();
    losGen++;
    runs = { dead: [], enemy: [] };
    if (!b || !HEIGHT || (!S.dead && !S.enemy)) { drawShading(); return; }
    if (!fullSupported()) { $('#los-note').textContent = 'This browser cannot work out line of sight.'; return; }
    if (S.dead) runs.dead = deadRuns(b);
    if (S.enemy) runs.enemy = enemyRuns(b);
    const w = ensureWorker();
    // drop what's still queued for an older plan
    for (const [id, x] of losWanted) if (x.gen !== losGen) { w.postMessage({ cancel: id }); losWanted.delete(id); }
    for (const r of [...runs.dead, ...runs.enemy]) {
      const key = reqKey(r);
      if (losCache.has(key) || [...losWanted.values()].some(x => x.key === key)) continue;
      const id = ++reqSeq;
      losWanted.set(id, { key, gen: losGen });
      w.postMessage({ id, ...r, reverse: false, elev: null, cell: CELL, model: losModel, strength: 1, cfg: workerCfg() });
    }
    drawShading();
  }
  // Every needed run that has come back, as one picture of the area round the base
  function drawShading() {
    shadeLayer.clearLayers();
    const b = base(), note = $('#los-note');
    if (!b || (!runs.dead.length && !runs.enemy.length)) { if (!losFailed) note.textContent = b ? '' : 'Pick a base to see its dead ground.'; return; }
    const R = S.reach, N = Math.ceil(2 * R / CELL), minX = b.xz[0] - R, maxZ = b.xz[1] + R;
    const dead = runs.dead.map(r => losCache.get(reqKey(r))).filter(Boolean), enemy = runs.enemy.map(r => losCache.get(reqKey(r))).filter(Boolean);
    const waiting = runs.dead.length - dead.length + runs.enemy.length - enemy.length;
    const canvas = document.createElement('canvas');
    canvas.width = N; canvas.height = N;
    const ctx = canvas.getContext('2d'), img = ctx.createImageData(N, N), px = img.data;
    const at = (res, x, z) => {
      const cx = Math.floor((x - res.minX) / res.cell), cz = Math.floor((res.maxZ - z) / res.cell);
      return cx >= 0 && cx < res.W && cz >= 0 && cz < res.H ? res.cells[cz * res.W + cx] : 0;
    };
    let inside = 0, nDead = 0, nSeen = 0;
    for (let j = 0; j < N; j++) {
      const z = maxZ - (j + 0.5) * CELL;
      for (let i = 0; i < N; i++) {
        const x = minX + (i + 0.5) * CELL;
        if ((x - b.xz[0]) ** 2 + (z - b.xz[1]) ** 2 > R * R || x < 0 || z < 0 || x > WORLD || z > WORLD) continue;
        inside++;
        const k = (j * N + i) * 4;
        let rgba = null;
        if (enemy.length) {
          let best = 0;
          for (const res of enemy) { const v = at(res, x, z); if (RANK[v] > RANK[best]) best = v; }
          if (best === CLEAR) { nSeen++; rgba = [255, 70, 70, 120]; } else if (best === TREES) rgba = [255, 70, 70, 50];
        }
        if (!rgba && dead.length) {
          let best = 0;
          for (const res of dead) { const v = at(res, x, z); if (RANK[v] > RANK[best]) best = v; }
          if (best === HIDDEN || best === 0) { nDead++; rgba = [60, 10, 110, 150]; } else if (best === TREES) rgba = [255, 200, 60, 70];
        } else if (rgba && dead.length) {
          let best = 0;
          for (const res of dead) { const v = at(res, x, z); if (RANK[v] > RANK[best]) best = v; }
          if (best === HIDDEN || best === 0) nDead++;
        }
        if (rgba) { px[k] = rgba[0]; px[k + 1] = rgba[1]; px[k + 2] = rgba[2]; px[k + 3] = rgba[3]; }
      }
    }
    ctx.putImageData(img, 0, 0);
    if (dead.length || enemy.length) {
      const bounds = L.latLngBounds(toLL([minX, maxZ - N * CELL]), toLL([minX + N * CELL, maxZ]));
      shadeLayer.addLayer(L.imageOverlay(canvas.toDataURL(), bounds, { pane: 'shade', className: 'los-img', interactive: false }));
    }
    if (losFailed) return;
    const parts = [];
    if (runs.dead.length && dead.length === runs.dead.length) {
      const from = runs.dead[0].fallback ? 'in and around the cap zone (place positions to use theirs)' : `${runs.dead.length} position${runs.dead.length === 1 ? '' : 's'}`;
      parts.push(`${Math.round(nDead / Math.max(1, inside) * 100)}% of the ground within ${R} m is dead ground, seen from ${from}.`);
    }
    if (runs.enemy.length && enemy.length === runs.enemy.length) parts.push(`An enemy can see into the base from ${Math.round(nSeen / Math.max(1, inside) * 100)}% of it.`);
    if (waiting) parts.push(`Working out line of sight (${waiting} to go)…`);
    note.textContent = parts.join(' ');
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  map.on('click', e => mapClick(toXZ(e.latlng)));
  map.on('dblclick', () => finishLine());
  map.on('mousemove', e => {
    const xz = toXZ(e.latlng), b = base();
    $('#cursor-grid').textContent = inWorld(xz) ? `${grid(xz)}${b ? ` · ${fmtDist(dist(b.xz, xz))} ${pad(Math.round(bearing(b.xz, xz)) % 360, 3)}°` : ''}` : '— —';
    if (draft) drawDraft(xz);
  });
  document.addEventListener('keydown', e => {
    if (e.target.closest('input, select, textarea')) return;
    if (e.key === 'Escape') { if (draft) cancelDraft(); else if (S.tool) setTool(S.tool); }
    else if (e.key === 'Enter' && draft) finishLine();
    else if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel) removeItem(S.sel);
  });
  $('#tools').addEventListener('click', e => { const b = e.target.closest('[data-tool]'); if (b) setTool(b.dataset.tool); });
  $('#tool-opts').addEventListener('click', e => {
    const b = e.target.closest('[data-opt]');
    if (!b) return;
    S[b.dataset.opt] = +b.dataset.v;
    save(); renderToolOpts();
  });
  $('#items').addEventListener('click', e => {
    let b;
    if ((b = e.target.closest('[data-del]'))) removeItem(b.dataset.del);
    else if ((b = e.target.closest('[data-sel]'))) {
      const it = cur().items.find(i => i.id === b.dataset.sel);
      select(b.dataset.sel);
      if (it && S.sel === it.id && !map.getBounds().contains(toLL(anchor(it)))) map.panTo(toLL(anchor(it)));
    }
  });
  $('#items-clear').addEventListener('click', () => {
    const m = cur();
    if (!m.items.length || !confirm(`Remove all ${m.items.length} of your defences on this map?`)) return;
    const ids = m.items.map(i => i.id);
    m.items = []; S.sel = null; save(); render();
    ids.forEach(unpublish);
  });
  $('#base-pick').addEventListener('change', e => pickBase(e.target.value, true));
  $('#base-zoom').addEventListener('click', () => zoomTo(160));
  $('#approaches').addEventListener('click', () => zoomTo(S.reach));
  $('#zones').addEventListener('change', e => {
    const cb = e.target.closest('[data-zone]');
    if (!cb) return;
    S.zones[cb.dataset.zone] = cb.checked;
    save(); renderZones();
  });
  $('#show-dead').addEventListener('change', e => { S.dead = e.target.checked; save(); requestLos(); });
  $('#show-enemy').addEventListener('change', e => { S.enemy = e.target.checked; save(); requestLos(); });
  $('#reach').addEventListener('change', e => { S.reach = +e.target.value; save(); requestLos(); });
  function showSettings() {
    $('#show-dead').checked = S.dead; $('#show-enemy').checked = S.enemy; $('#reach').value = String(S.reach);
    document.querySelectorAll('#zones [data-zone]').forEach(cb => { cb.checked = !!S.zones[cb.dataset.zone]; });
  }
  let toastTimer = 0;
  function toast(text, ms = 3500) {
    const el = $('#toast');
    el.textContent = text; el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
  }
  $('#toast').addEventListener('click', () => $('#toast').classList.add('hidden'));

  // map choice
  async function setMap(id) {
    const gen = ++loadGen;
    S.map = id;
    $('#los-model option[value="mesh"]').disabled = !MAPS[id].hasMeshFoliage;
    if (losModel === 'mesh' && !MAPS[id].hasMeshFoliage) { losModel = 'profiles'; $('#los-model').value = losModel; }
    $('#map-pick').value = id;
    HEIGHT = null; BASES = []; S.sel = null; cancelDraft();
    losCache.clear(); losFailed = false; $('#los-note').textContent = '';
    showMapBase(id);
    $('#base-pick').innerHTML = '';
    save(); render();
    try {
      const m = MAPS[id];
      const [poi, ix] = await Promise.all([
        m.poi ? fetch(m.poi).then(r => (r.ok ? r.json() : null)).catch(() => null) : null,
        fetch(`/data/maps/${id}/los/index.json`, { cache: 'no-cache' }).then(r => r.json()).catch(() => null),
      ]);
      if (gen !== loadGen) return;
      BASES = ((poi && poi.conflict) || []).filter(c => c && c.name && Array.isArray(c.xz)).sort((a, b) => a.name.localeCompare(b.name));
      const groups = Object.keys(KINDS).map(k => [k, BASES.filter(b => b.kind === k)]).filter(([, l]) => l.length);
      $('#base-pick').innerHTML = '<option value="">Choose…</option>' + groups.map(([k, l]) =>
        `<optgroup label="${esc(k)}">${l.map(b => `<option value="${esc(b.name)}">${esc(b.name)}</option>`).join('')}</optgroup>`).join('');
      if (cur().base && !BASES.some(b => b.name === cur().base)) cur().base = null;
      HN = (ix && ix.light && ix.light.cols) || m.lightCols || 1300;
      const buf = await fetch(`/data/maps/${id}/light/height.bin.gz?v=${(ix && ix.version) || 4}`).then(r => {
        if (!r.ok) throw new Error(r.status);
        return new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      });
      if (gen !== loadGen) return;
      HEIGHT = new Int16Array(buf);
      render();
      zoomTo(160);
    } catch (err) {
      console.error(err);
      if (gen === loadGen) $('#hint').textContent = 'Could not load this map. Reload the page to try again.';
    }
  }
  $('#map-pick').addEventListener('change', e => setMap(e.target.value));

  // ---------------------------------------------------------------------------
  // Room: the field map's own rooms (3d/room.js does the joining and the live updates). In a room your defences are
  // normal markings under your name, so the full map and everyone else sees them, and you see the squad's. The plan
  // you made here before joining goes into the room when you join. The field map's keys are shared: one session per
  // tab (name, room, map) and the 5-minute copy of your markings, so moving between this page and the map in one tab
  // keeps your room and your markings.
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
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  let want = null, listening = false, synced = false, restoring = false, leaving = false, retryTimer = 0, retryN = 0;
  const room = Room('/api', { onChange: ev => roomChanged(ev), onStatus: (state, text, removed) => roomStatus(state, text, removed) });
  const inRoom = () => !!(listening && room.me);
  ownedBy = () => (inRoom() && synced ? `${room.me.room}|${room.me.name.toLowerCase()}` : null);
  const myItems = () => (room.me && room.players.get(room.me.name) && room.players.get(room.me.name).items) || new Map();
  function squadDefences() {
    const out = [];
    if (room.me) for (const [name, p] of room.players) if (name !== room.me.name) for (const it of p.items.values()) if (toolOf(it) && anchor(it)) out.push({ name, color: p.color, it });
    return out;
  }
  const itemWrites = PlanSync.writer();
  async function publish(it) {
    if (!inRoom() || !synced) return;
    const me = room.me, item = JSON.parse(JSON.stringify(it));
    planBackup.stage(me, item); writeKept();
    try { await itemWrites(me, item.id, () => api('/api/item', { id: me.id, token: me.token, item })); }
    catch (err) { toast(err.message); }
  }
  async function unpublish(id) {
    if (!inRoom() || !synced) return;
    const me = room.me;
    planBackup.remove(me, id); writeKept();
    try { await itemWrites(me, id, () => api('/api/delete', { id: me.id, token: me.token, itemId: id })); }
    catch (err) { toast(err.message); }
  }
  // Your defences in the room are the plan: mirror them here (and so into this browser)
  function mirrorFromRoom() {
    const m = cur(), mine = planBackup.items(room.me, [...myItems().values()]).filter(it => toolOf(it) && anchor(it));
    const sig = l => JSON.stringify(l.map(i => i.id).sort()) + JSON.stringify(l.map(i => [i.id, anchor(i), i.label, i.dir, i.range, i.n]).sort());
    if (sig(mine) === sig(m.items)) return false;
    m.items = mine.map(it => ({ ...it }));
    if (S.sel && !m.items.some(i => i.id === S.sel)) S.sel = null;
    save();
    return true;
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
    let items = [...myItems().values()];
    items = planBackup.items(me, items);
    ls.set(keptKey(me), items.length ? JSON.stringify({ at: Date.now(), items }) : null);
  }
  setInterval(writeKept, 60e3);

  function roomStatus(state, text, removed = false) {
    const st = $('#room-status');
    st.textContent = text || '';
    $('#room-join').textContent = state === 'on' ? 'Leave' : 'Join';
    $('#room-join').disabled = state === 'joining';
    $('#room-name').disabled = $('#room-code').disabled = state !== 'off';
    lockMapPick(state === 'on');
    $('#room-invite').classList.toggle('hidden', state !== 'on');
    if (state === 'off') {
      const was = listening;
      listening = false; synced = false; restoring = false;
      if (removed) { ses.set(SESSION_KEY, null); want = null; }
      else if (was && want && !leaving) scheduleRejoin();
      renderRoomMap(); renderList(); updatePageLinks();
    }
  }
  // A room keeps the map it was opened on, so while you're in one the map choice is locked to it (as on the mortar page)
  function lockMapPick(locked) {
    const sel = $('#map-pick');
    sel.disabled = locked;
    sel.title = locked ? "Locked to this room's map. Leave the room to pick another." : 'Pick the map';
    [...sel.options].forEach(o => { const t = (MAPS[o.value] && (MAPS[o.value].title || o.value)) || o.value; o.textContent = locked && o.value === S.map ? `🔒 ${t}` : t; });
  }
  function scheduleRejoin() {
    if (retryN >= 6) { want = null; roomStatus('off', 'Lost the connection to the room. Press Join to come back.'); return; }
    retryN++;
    $('#room-status').textContent = 'Reconnecting…';
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if (want) joinRoom(want.name, want.code, { again: 2, auto: true, map: want.map }); }, 2500 * retryN);
  }
  async function joinRoom(name, code, { again = 0, auto = false, map: mapHint = null } = {}) {
    name = String(name).trim(); code = String(code).trim().toLowerCase();
    if (!name || !code) return roomStatus('off', 'Enter your name and the room code.');
    want = { name, code, map: (mapHint && MAPS[mapHint]) ? mapHint : S.map };
    let me = null;
    for (let tries = again + 1; !me; tries--) {
      // (a room that emptied while you switched pages is opened again on the map it was on, not this page's last map)
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
      await setMap(me.map);
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
    try { await navigator.clipboard.writeText(link); toast('Invite link copied. Send it to your squad.'); }
    catch { toast(link, 8000); }
  });
  // Going to the map or another page: this tab's session is already saved, so the next page joins by itself
  function goodbye() {
    if (leaving || !room.me) return;
    leaving = true;
    try { writeKept(); } catch (err) { console.error(err); }
    room.leave();
  }
  addEventListener('beforeunload', goodbye);
  addEventListener('pagehide', goodbye);
  addEventListener('pageshow', e => { leaving = false; if (e.persisted && want) joinRoom(want.name, want.code, { again: 3, map: want.map }); });
  function updatePageLinks() {
    const on = inRoom(), hash = on ? `#room=${encodeURIComponent(room.me.room)}&name=${encodeURIComponent(room.me.name)}` : '';
    $('#to-map').href = `/${on ? `#room=${encodeURIComponent(room.me.room)}` : ''}`;
    $('#to-shot').href = `/shot.html${hash}`;
    $('#to-mortar').href = `/mortar.html${hash}`;
  }

  async function afterSnapshot() {
    const me = room.me;
    restoring = true;
    try {
      // markings the field map kept for you, then this page's plan: put back what the server lacks (a kept plan that
      // belongs to another room or name and hasn't changed since stays out of this room)
      const key = `${me.room}|${me.name.toLowerCase()}`;
      if (S.owner && S.owner !== key && planSig() === S.ownerSig) { for (const m of Object.values(S.perMap)) m.items = []; S.owner = key; S.ownerSig = null; save(); }
      const local = cur().items.map(it => ({ ...it, color: me.color && it.type !== 'emplacement' ? me.color : it.color }));
      const items = [...(keptFor(me) || []), ...local];
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
    writeKept();
    mirrorFromRoom();
    render();
  }
  function roomChanged(ev) {
    if (ev?.type === 'delete' && ev.owner === room.me?.name) planBackup.remove(room.me, ev.id);
    if (room.me) planBackup.acknowledge(room.me, myItems());
    if (!inRoom()) { render(); return; }
    if (!synced) { synced = true; afterSnapshot(); return; }
    if (!restoring) mirrorFromRoom();
    render();
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------
  function autoJoin() {
    const q = new URLSearchParams(location.hash.slice(1)), sess = ses.get(SESSION_KEY);
    const code = (q.get('room') || (sess && sess.room) || '').toLowerCase();
    $('#room-name').value = (q.get('name') || (sess && sess.name) || nameKept() || '').slice(0, 20);
    $('#room-code').value = code;
    if (!/^[a-z0-9_-]{3,32}$/.test(code)) return;
    if (!$('#room-name').value) { roomStatus('off', 'Enter your name to join this room.'); return; }
    joinRoom($('#room-name').value, code, { again: 3, map: sess && sess.room === code ? sess.map : null });
  }
  showSettings();
  fetch('/api/maps').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }).then(maps => {
    MAPS = maps.maps;
    $('#map-pick').innerHTML = Object.entries(MAPS).map(([id, m]) => `<option value="${esc(id)}">${esc(m.title || id)}</option>`).join('');
    return setMap(MAPS[S.map] ? S.map : maps.default || Object.keys(MAPS)[0]);
  }).then(autoJoin).catch(err => {
    console.error(err);
    $('#hint').textContent = 'Could not load the map list. Is the map server running?';
  });
  window.addEventListener('resize', () => map.invalidateSize());
})();

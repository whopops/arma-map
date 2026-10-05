/* Mortar page: a gun, its wind and a list of targets, each with what to set on the sight. The ballistics are the 3D view's
   copy of the field map's solver (3d/mortar.js, global `Mortar`); the firing tables, terrain heights and tiles are the
   field map's own data files. On its own it all stays in this browser; joined to a room it shares your mortar and shows
   the room's mortars and fire requests (see Room below). */
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
  const fmtReach = (a, b) => (b - a < 15 ? fmtDist(b) : b < 1000 ? `${Math.round(a)}–${Math.round(b)} m` : `${(a / 1000).toFixed(2)}–${(b / 1000).toFixed(2)} km`);
  const round1 = v => Math.round(v * 10) / 10;

  // A typed grid: 6 digits (100 m squares, "045 068" or "045068") or 8 digits (10 m squares); the middle of the square.
  function parseGrid(str) {
    const parts = String(str).trim().split(/[\s,/.-]+/).filter(Boolean);
    let a, b;
    if (parts.length === 2) [a, b] = parts;
    else if (parts.length === 1 && /^(\d{6}|\d{8})$/.test(parts[0])) { const h = parts[0].length / 2; a = parts[0].slice(0, h); b = parts[0].slice(h); }
    else return null;
    if (!/^\d{3,4}$/.test(a) || a.length !== b.length) return null;
    const unit = a.length === 3 ? 100 : 10;
    return [+a * unit + unit / 2, +b * unit + unit / 2];
  }

  // ---------------------------------------------------------------------------
  // What the crew has set, kept in this browser for 5 minutes after the page was last open (like the field map's copy
  // of your markings), so a reload or a trip to another page keeps it but an old session never comes back. `owner` is
  // the room and name it was last in ('' if never in one), with `ownerSig`, what the mortar was then: joining a room,
  // the kept mortar goes into it only if it was made for that room and name, or outside any room, or changed since.
  // ---------------------------------------------------------------------------
  const KEY = 'everon-mortar-page', KEEP_MS = 5 * 60e3;
  const MAX_TARGETS = 30;
  const S = { map: null, weapon: 'M252', shell: 'HE M821', charge: null, wind: { s: 0, d: 0 }, corr: 'gun', step: 50, mode: 'gun', sel: null,
    owner: '', ownerSig: null,
    perMap: {} /* map id -> { gun: [x, z] | null, targets: [{ id, xz, undo: [] }] } */ };
  let nextId = 1;
  (function restore() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (!v) return;
      if (!(Date.now() - (v.at || 0) < KEEP_MS)) { localStorage.removeItem(KEY); return; } // an old session: start clean
      S.owner = typeof v.owner === 'string' ? v.owner : ''; S.ownerSig = v.ownerSig || null;
      Object.assign(S, { map: v.map || null, weapon: v.weapon || S.weapon, shell: v.shell || S.shell, charge: Number.isInteger(v.charge) ? v.charge : null,
        corr: v.corr === 'compass' ? 'compass' : 'gun', step: [10, 25, 50, 100].includes(v.step) ? v.step : 50 });
      if (v.wind && v.wind.s >= 0 && v.wind.s <= 40) S.wind = { s: +v.wind.s, d: ((+v.wind.d || 0) % 360 + 360) % 360 };
      for (const [id, m] of Object.entries(v.perMap || {})) {
        const ok = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
        S.perMap[id] = { gun: ok(m.gun) ? m.gun : null, selected: Number.isInteger(m.selected) ? m.selected : 0, targets: (m.targets || []).filter(ok).slice(0, MAX_TARGETS).map(xz => ({ id: nextId++, xz, undo: [] })) };
      }
    } catch (e) { /* nothing saved, or storage is off */ }
  })();
  let ownedBy = () => null; // the room and name the mortar now belongs to, while in a room (set up with the room below)
  function save() {
    const owner = ownedBy();
    if (owner) { S.owner = owner; S.ownerSig = TABLES ? localSig() : S.ownerSig; }
    try {
      const perMap = {};
      for (const [id, m] of Object.entries(S.perMap)) perMap[id] = { gun: m.gun, selected: id === S.map && S.sel != null ? Math.max(0,m.targets.findIndex(t => t.id === S.sel)) : m.selected || 0, targets: m.targets.map(t => t.xz) };
      localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), owner: S.owner, ownerSig: S.ownerSig, map: S.map, weapon: S.weapon, shell: S.shell,
        charge: S.charge, wind: S.wind, corr: S.corr, step: S.step, perMap }));
    } catch (e) { /* not remembered */ }
    persistFlights();
    publishSoon(); // in a room, the mortar marking follows
  }
  // while the page is open the 5 minutes don't run: they count from when it was last open
  setInterval(() => {
    try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); if (v) { v.at = Date.now(); localStorage.setItem(KEY, JSON.stringify(v)); } } catch { /* storage unavailable */ }
  }, 60e3);
  const cur = () => (S.perMap[S.map] = S.perMap[S.map] || { gun: null, targets: [] });
  const windOrNull = () => (S.wind.s > 0 ? S.wind : null);

  // ---------------------------------------------------------------------------
  // Data: map list, firing tables, terrain
  // ---------------------------------------------------------------------------
  let MAPS = {}, TABLES = null, WORLD = 12800;
  let HEIGHT = null, HN = 1300; // the 10 m heights (decimetres, row 0 = south)
  let detailIndex = null, detailV = 0, TERRAIN_UNIT = 0.01, loadGen = 0;
  const detailTiles = new Map(), detailLoading = new Set();
  const SEA = 'sea';
  const ready = () => !!(TABLES && HEIGHT && MAPS[S.map]);

  const gunels = () => TABLES.weapons[S.weapon];
  const shellRings = () => (TABLES && TABLES.weapons[S.weapon] && TABLES.weapons[S.weapon].shells[S.shell]) || null;
  const chargeSet = () => { const r = shellRings(); return Number.isInteger(S.charge) && r && r[S.charge] ? S.charge : null; };

  function heightAt([x, z]) {
    if (!HEIGHT) return null;
    const fx = Math.min(Math.max(x / 10 - 0.5, 0), HN - 1), fz = Math.min(Math.max(z / 10 - 0.5, 0), HN - 1);
    const c0 = Math.floor(fx), r0 = Math.floor(fz), c1 = Math.min(c0 + 1, HN - 1), r1 = Math.min(r0 + 1, HN - 1);
    const tx = fx - c0, tz = fz - r0, v = (r, c) => HEIGHT[r * HN + c] / 10;
    const south = v(r0, c0) + (v(r0, c1) - v(r0, c0)) * tx, north = v(r1, c0) + (v(r1, c1) - v(r1, c0)) * tx;
    return south + (north - south) * tz;
  }
  const coarse = (x, z) => heightAt([x, z]) ?? 0;

  // The game's own 1 m terrain, in 500 m tiles fetched when a gun or target first needs them (the 10 m heights stand in
  // until a tile lands, and the solutions redo themselves then).
  function detailTile(x, z) {
    if (!detailIndex || x < 0 || z < 0 || x >= WORLD || z >= WORLD) return undefined;
    const tx = Math.floor(x / 500), tz = Math.floor(z / 500), name = `${tx}_${tz}`;
    if (detailTiles.has(name)) return detailTiles.get(name);
    if (!detailIndex.has(name)) return SEA;
    if (!detailLoading.has(name)) {
      detailLoading.add(name);
      const gen = loadGen;
      fetch(`/data/maps/${S.map}/los/${name}.bin.gz?v=${detailV}`)
        .then(r => { if (!r.ok) throw new Error(r.status); return new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(); })
        .then(buf => {
          if (gen !== loadGen) return;
          detailTiles.set(name, { x0: tx * 500, z0: tz * 500, ter: new Uint16Array(buf, 0, 501 * 501) });
          while (detailTiles.size > 16) detailTiles.delete(detailTiles.keys().next().value);
          detailLoading.delete(name);
          afterDetailSoon();
        })
        .catch(err => { detailLoading.delete(name); console.error(`Detail tile ${name}`, err); });
    }
    return undefined;
  }
  function groundFine(x, z) {
    const t = detailTile(x, z);
    if (t === SEA) return 0;
    if (!t) return coarse(x, z);
    const lx = Math.min(Math.max(x - t.x0, 0), 499.999), lz = Math.min(Math.max(z - t.z0, 0), 499.999);
    const c = Math.floor(lx), r = Math.floor(lz), fx = lx - c, fz = lz - r, T = t.ter;
    const a = T[r * 501 + c], b = T[r * 501 + c + 1], d = T[(r + 1) * 501 + c], e = T[(r + 1) * 501 + c + 1];
    return ((a + (b - a) * fx) * (1 - fz) + (d + (e - d) * fx) * fz) * TERRAIN_UNIT;
  }
  let detailTimer = 0;
  function afterDetailSoon() {
    clearTimeout(detailTimer);
    detailTimer = setTimeout(() => { Mortar.invalidateTerrain(); render(); }, 80);
  }

  // ---------------------------------------------------------------------------
  // Map
  // ---------------------------------------------------------------------------
  const map = L.map('map', { crs: CRS, center: toLL([6400, 6400]), zoom: 0, minZoom: -1, maxZoom: 7, zoomSnap: 0.25, zoomDelta: 0.5, attributionControl: false,
    doubleClickZoom: false, preferCanvas: true });
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
      // grid numbers on the 1 km lines (in 100 m units, as the grids are written)
      ctx.font = '600 11px Consolas, monospace'; ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 3;
      const label = (t, x, y) => { ctx.strokeText(t, x, y); ctx.fillText(t, x, y); };
      for (let g = Math.ceil(w / 1000) * 1000; g <= e; g += 1000) if (g >= 0 && g <= WORLD) label(pad(g / 100, 3), px(g) + 3, 12);
      for (let g = Math.ceil(s / 1000) * 1000; g <= n; g += 1000) if (g >= 0 && g <= WORLD) label(pad(g / 100, 3), 3, py(g) - 3);
      return c;
    },
  });
  let tileLayer = null, gridLayer = null;
  const zoneLayer = L.layerGroup().addTo(map);   // reach rings, targets, lines
  const ghostLayer = L.layerGroup().addTo(map);  // the live aim under the cursor
  const placeLayer = L.layerGroup().addTo(map);  // town and landmark names, Conflict bases (under everything else)

  // Small labels give way when zoomed out, as on the field map.
  function updateZoomClass() {
    const z = map.getZoom(), el = map.getContainer();
    el.classList.toggle('z-lo', z < 1);
    el.classList.toggle('z-mid', z >= 1 && z < 2);
    el.style.setProperty('--zs', Math.pow(2, z));
  }
  map.on('zoomend', updateZoomClass);
  updateZoomClass();

  // Conflict base kinds, coloured and lettered as on the field map (CONFLICT_STYLE in app.js).
  const CONFLICT_STYLE = {
    'Main base (HQ)': ['#ff6b6b', 'H'], 'Military base': ['#ffa94d', 'M'], 'Town base': ['#74c0fc', 'T'],
    'Small base': ['#a9e34b', 'S'], 'Radio tower': ['#da77f2', 'R'],
  };
  const labelIcon = (text, cls, style = '') => L.divIcon({ className: `map-label ${cls}`, iconSize: [0, 0],
    html: `<span${style ? ` style="${style}"` : ''}>${esc(text)}</span>` });
  let placeGen = 0;
  async function loadPlaces(id) {
    const gen = ++placeGen;
    placeLayer.clearLayers();
    const [ref, places] = await Promise.all([
      MAPS[id]?.poi ? fetch(MAPS[id].poi).then(r => r.json()).catch(() => ({})) : Promise.resolve({}),
      fetch(`/data/maps/${id}/places.json`).then(r => r.json()).catch(() => null),
    ]);
    if (gen !== placeGen) return;
    const towns = places?.towns || [], landmarks = places?.landmarks || [], conflict = ref?.conflict || [];
    const put = (xz, icon) => L.marker(toLL(xz), { icon, interactive: false, keyboard: false, zIndexOffset: -1000 }).addTo(placeLayer);
    landmarks.forEach(t => put(t.xz, labelIcon(t.name, `lbl-landmark${/Water|Bay/.test(t.type) ? ' lbl-water' : ''}`)));
    // a town name sharing its spot with a base badge moves just clear of it (badgeSide in app.js)
    towns.forEach(t => {
      const c = conflict.find(c => Math.abs(c.xz[0] - t.xz[0]) < t.name.length * 50 && Math.abs(c.xz[1] - t.xz[1]) < 250);
      const dz = c ? c.xz[1] - t.xz[1] : 0;
      const side = c ? (dz > 0 ? ' lbl-below' : ' lbl-above') : '';
      put(t.xz, labelIcon(t.name, `lbl-town${t.type === 'Town' || t.type === 'City' ? ' big' : ''}${side}`, c ? `--bd:${(Math.abs(dz) / SCALE).toFixed(1)}` : ''));
    });
    // base labels are left off when the base carries its town's name: the town label already says it
    const simple = s => String(s).toLowerCase().normalize('NFD').replace(/[^a-z]/g, '');
    const townNames = new Set(towns.map(t => simple(t.name)));
    conflict.forEach(c => {
      const [color, ch] = CONFLICT_STYLE[c.kind] || ['#ccc', '?'];
      put(c.xz, L.divIcon({ className: `glyph poi${c.control ? ' control' : ''}`, iconSize: [0, 0], html: `<div style="--c:${color}">${ch}</div>` }));
      if (!townNames.has(simple(c.name))) put(c.xz, labelIcon(c.name, 'lbl-conflict'));
    });
  }

  function showMapBase(id, refit) {
    const m = MAPS[id];
    WORLD = m.world;
    const bounds = L.latLngBounds(toLL([0, 0]), toLL([WORLD, WORLD]));
    if (tileLayer) tileLayer.remove();
    if (gridLayer) gridLayer.remove();
    tileLayer = new MapTiles('', { url: m.tiles, minZoom: -1, maxZoom: 7, minNativeZoom: 0, maxNativeZoom: 5, bounds, keepBuffer: 3, errorTileUrl: BLANK_TILE }).addTo(map);
    tileLayer.bringToBack();
    gridLayer = new GridOverlay({ bounds, zIndex: 5, minZoom: -1, maxZoom: 7 }).addTo(map);
    map.setMaxBounds(bounds.pad(0.25));
    if (refit) fitAll(true);
  }
  function fitAll(wholeMapIfEmpty) {
    const m = cur(), pts = [...(m.gun ? [m.gun] : []), ...m.targets.map(t => t.xz)];
    map.invalidateSize({ animate: false });
    if (pts.length) {
      // a lone gun is shown with its whole reach; with targets, the gun and targets with a margin
      let b = L.latLngBounds(pts.map(toLL));
      if (pts.length === 1 && ready()) {
        const rch = reachNow(), far = rch ? Math.max(...rch.rings.map(r => r.far || r.max || 0)) : 0, r = Math.min(Math.max(far, 800), 3500) * 1.08;
        b = L.latLngBounds(toLL([m.gun[0] - r, m.gun[1] - r]), toLL([m.gun[0] + r, m.gun[1] + r]));
      } else b = b.pad(0.6);
      map.fitBounds(b, { maxZoom: 3, animate: false });
    } else if (wholeMapIfEmpty) {
      map.fitBounds(L.latLngBounds(toLL([0, 0]), toLL([WORLD, WORLD])), { animate: false });
    }
  }

  // ---------------------------------------------------------------------------
  // Solutions
  // ---------------------------------------------------------------------------
  // A gun, as the maths needs it: where, what it fires, the wind it was given and the ring set (null = Auto). Mine is
  // what's on this page; a teammate's is their mortar marking in the room.
  const myDesc = () => { const g = cur().gun; return g && { xz: g, weapon: S.weapon, shell: S.shell, wind: windOrNull(), charge: chargeSet() }; };
  const descOf = it => ({ xz: it.xz, weapon: it.weapon, shell: it.shell, wind: it.wind && it.wind.s > 0 ? it.wind : null, charge: Mortar.chargeOf(TABLES, it) });
  const solveWith = (d, xz, shell = d.shell) => Mortar.solve(TABLES, d.weapon, shell, d.xz, xz, d.wind, groundFine, d.charge);
  const reachWith = (d, shell = d.shell) => Mortar.reach(TABLES, d.weapon, shell, d.xz, d.wind, coarse, WORLD);
  const solveTo = xz => solveWith(myDesc(), xz);
  const reachNow = () => reachWith(myDesc());
  // How far the rings go towards a bearing, from the reach outline (for "out of range" notes)
  function reachToward(rch, gun, az, ring) {
    const list = (rch && rch.rings || []).filter(r => r.pts && (ring == null || r.ring === ring));
    if (!list.length) return null;
    const i = Math.round(az / (360 / list[0].pts.length)) % list[0].pts.length;
    return Math.max(...list.map(r => dist(gun, r.pts[i])));
  }
  function whyNot(sol, d = myDesc(), shell = d.shell) {
    const rings = TABLES.weapons[d.weapon].shells[shell], rch = reachWith(d, shell), ch = sol.charge;
    const others = sol.rings.map(r => r.ring), alt = others.length ? ` Ring${others.length > 1 ? 's' : ''} ${others.join(', ')} can.` : '';
    if (ch != null) {
      const min = rings[ch].table[0][0];
      if (sol.d < min) return `Too close for ring ${ch} (at least ${fmtDist(min)}).${alt}`;
      const r = reachToward(rch, d.xz, sol.az, ch);
      return `Ring ${ch} can't reach this far${r != null ? ` (about ${fmtDist(r)} this way)` : ''}.${alt}`;
    }
    const min = Math.min(...Object.values(rings).map(r => r.table[0][0]));
    if (sol.d < min) return `Too close (at least ${fmtDist(min)}).`;
    const r = reachToward(rch, d.xz, sol.az);
    return `Out of range${r != null ? ` (reaches about ${fmtDist(r)} this way)` : ''}.`;
  }

  // What one round does around where it bursts, measured in the game (the field map's BLAST; keep them in step)
  const BLAST = {
    'HE M821': { kill: 18, danger: 27 }, 'HE O-832DU': { kill: 11, danger: 16 }, 'Practice M879': { kill: 0, danger: 5 },
    'Smoke M819': { kill: 0, danger: 5 }, 'Smoke D-832DU': { kill: 0, danger: 5 },
  };
  const RING_COLORS = ['#ffd43b', '#ff922b', '#f783ac', '#da77f2', '#74c0fc'];
  const shellColor = shell => (/^Smoke/.test(shell) ? '#ced4da' : /^Illum/.test(shell) ? '#ffe066' : '#adb5bd');

  function ellipseLL(xz, sh, grow = 0) {
    const a = sh.az * Math.PI / 180, L1 = sh.long + grow, S1 = sh.side + grow, pts = [];
    for (let i = 0; i < 48; i++) {
      const t = i / 48 * 2 * Math.PI, u = L1 * Math.cos(t), s = S1 * Math.sin(t);
      pts.push(toLL([xz[0] + u * Math.sin(a) + s * Math.cos(a), xz[1] + u * Math.cos(a) - s * Math.sin(a)]));
    }
    return pts;
  }
  function impactZones(layer, xz, best, shell = S.shell) {
    const shape = best.spread, spread = best.dispersion;
    const zone = (grow, style) => (shape ? L.polygon(ellipseLL(xz, shape, grow), style) : L.circle(toLL(xz), { radius: spread + grow, ...style }));
    const b = BLAST[shell];
    if (b) layer.addLayer(zone(b.danger, { color: '#ffd43b', weight: 1.8, dashArray: '6 5', fillColor: '#ffd43b', fillOpacity: 0.12, interactive: false }));
    if (b && b.kill) {
      layer.addLayer(zone(b.kill, { color: '#ff5c5c', weight: 1.8, dashArray: '6 5', fillColor: '#ff5c5c', fillOpacity: 0.1, interactive: false }));
      layer.addLayer(zone(0, { color: '#ff2b2b', weight: 2, fillColor: '#ff2b2b', fillOpacity: 0.35, interactive: false }));
    } else {
      const c = shellColor(shell);
      layer.addLayer(zone(0, { color: c, weight: 1.8, dashArray: '5 4', fillColor: c, fillOpacity: 0.16, interactive: false }));
    }
  }

  const glyph = (ch, color, cls = '') => L.divIcon({ className: `glyph ${cls}`, iconSize: [0, 0], html: `<div style="background:${color}">${ch}</div>` });
  const tag = text => ({ permanent: true, direction: 'right', offset: [14, 0], className: 'item-label', content: text });

  // ---------------------------------------------------------------------------
  // Drawing the map
  // ---------------------------------------------------------------------------
  function renderMap() {
    zoneLayer.clearLayers();
    const m = cur(), gun = m.gun;
    if (!gun || !ready()) return;
    const color = '#c8d96f', center = toLL(gun), set = chargeSet(), rings = shellRings() || {};
    const rch = reachNow();
    const ringStyle = ring => {
      const c = RING_COLORS[ring] || color;
      return { casing: { color: '#080b0e', weight: 5, opacity: 0.6, fill: false, interactive: false },
        line: { color: c, weight: 2.4, opacity: 1, fillColor: c, fillOpacity: 0.06, interactive: false } };
    };
    const label = (xz, text, ring) => L.marker(toLL(xz), { interactive: false, keyboard: false,
      icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<span class="ring-label" style="--c:${RING_COLORS[ring] || color}">${esc(text)}</span>` }) });
    const NE = 9; // the 45 degree point of the 72-bearing outline
    const bands = set == null && rch ? Mortar.autoBandPolys(TABLES, S.weapon, S.shell, gun, rch) : null;
    if (bands) {
      bands.forEach(b => {
        const st = ringStyle(b.ring), outer = b.pts.map(toLL);
        zoneLayer.addLayer(L.polygon(b.inner ? [outer, b.inner.map(toLL)] : outer, { ...st.line, stroke: false }));
        zoneLayer.addLayer(L.polygon(outer, st.casing));
        zoneLayer.addLayer(L.polygon(outer, { ...st.line, fill: false }));
        zoneLayer.addLayer(label(b.pts[NE], `R${b.ring} to ${fmtReach(b.near, b.far)}`, b.ring));
      });
    } else if (rch) {
      rch.rings.filter(r => set == null || r.ring === set).forEach(r => {
        const st = ringStyle(r.ring);
        if (r.pts) {
          zoneLayer.addLayer(L.polygon(r.pts.map(toLL), st.casing));
          zoneLayer.addLayer(L.polygon(r.pts.map(toLL), st.line));
          zoneLayer.addLayer(label(r.pts[NE], `R${r.ring} ${fmtReach(r.near, r.far)}`, r.ring));
        } else {
          zoneLayer.addLayer(L.circle(center, { radius: r.max, ...st.casing }));
          zoneLayer.addLayer(L.circle(center, { radius: r.max, ...st.line }));
        }
      });
    }
    // the shortest it will fire: a red disc
    const min = set != null ? rings[set].table[0][0] : Math.min(...Object.values(rings).map(r => r.table[0][0]));
    zoneLayer.addLayer(L.circle(center, { radius: min, color: '#080b0e', weight: 4.5, opacity: 0.5, fill: false, interactive: false }));
    zoneLayer.addLayer(L.circle(center, { radius: min, color: '#ff6b6b', weight: 2, dashArray: '5 4', fillColor: '#ff6b6b', fillOpacity: 0.16, interactive: false }));

    m.targets.forEach((t, i) => {
      const sol = solveTo(t.xz), ok = !!sol.best, sel = S.sel === t.id;
      zoneLayer.addLayer(L.polyline([center, toLL(t.xz)], { color: ok ? color : '#ff6b6b', weight: sel ? 2.2 : 1.5, opacity: 0.85, dashArray: '2 5', interactive: false }));
      if (ok) impactZones(zoneLayer, t.xz, sol.best);
      const mk = L.marker(toLL(t.xz), { keyboard: false, draggable: true, icon: glyph(i + 1, ok ? '#ffa94d' : '#ff6b6b', sel ? 'sel' : '') });
      const text = s2 => `T${i + 1} · ${s2.best ? Mortar.short(s2) : 'out of range'}`;
      mk.bindTooltip(esc(text(sol)), tag());
      mk.on('drag', () => mk.setTooltipContent(esc(text(solveTo(toXZ(mk.getLatLng()))))));
      mk.on('dragend', () => moveTarget(t.id, toXZ(mk.getLatLng()), true));
      mk.on('click', () => selectTarget(t.id, true));
      zoneLayer.addLayer(mk);
    });

    const gm = L.marker(center, { keyboard: false, draggable: true, zIndexOffset: 500, icon: glyph('⊕', color, 'gun') });
    gm.bindTooltip(esc(`Mortar · ${S.weapon}`), tag());
    gm.on('dragend', () => setGun(toXZ(gm.getLatLng())));
    zoneLayer.addLayer(gm);
  }

  // ---------------------------------------------------------------------------
  // The panel
  // ---------------------------------------------------------------------------
  const fired = new Map(); // target id -> { end: ms, tof }
  const flightConfig = () => JSON.stringify([S.weapon,S.shell,S.charge,S.wind,cur().gun]);
  function persistFlights() {
    if (!S.map) return;
    const targets = cur().targets;
    const flights = [...fired].flatMap(([id, f]) => {
      const t = targets.find(t => t.id === id);
      return t && f.end > Date.now() - 6000 ? [{ xz:t.xz, end:f.end }] : [];
    });
    try { sessionStorage.setItem(`operations-flights:${S.map}`,JSON.stringify({config:flightConfig(),flights})); } catch { /* storage optional */ }
  }
  function restoreFlights() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(`operations-flights:${S.map}`) || 'null');
      if (!saved || saved.config !== flightConfig()) return;
      for (const f of saved.flights || []) {
        const t = cur().targets.find(t => t.xz[0] === f.xz?.[0] && t.xz[1] === f.xz?.[1]);
        if (t && Number.isFinite(f.end) && f.end > Date.now() - 6000) fired.set(t.id,{end:f.end});
      }
    } catch { /* stale or unavailable storage */ }
  }
  function targetCard(t, i) {
    const sol = solveTo(t.xz), b = sol.best, on = S.sel === t.id;
    const exactGrid = `${pad(t.xz[0] / 10, 4)} ${pad(t.xz[1] / 10, 4)}`;
    const head = `<div class="tgt-head"><span class="id">T${i + 1}</span><span class="grid" title="${esc(`${Math.round(t.xz[0])}, ${Math.round(t.xz[1])}`)}">${exactGrid}</span>` +
      `<span>${fmtDist(sol.d)} · ${pad(Math.round(sol.az) % 360, 3)}°</span><span class="sp"></span>` +
      `<button class="ghost" data-del="${t.id}" title="Remove this target" aria-label="Remove target T${i + 1}">✕</button></div>`;
    const edit = `<div class="target-edit"><label class="field"><span>Change target grid / 10 m precision</span><input id="active-target-grid" class="gridbox" value="${exactGrid}" inputmode="numeric" aria-label="Active target grid"></label><button data-update-grid="${t.id}">Update target</button></div>`;
    if (!b) return `<div class="tgt bad ${on ? 'on' : ''}">${head}<div class="facts"><span class="bad">${esc(whyNot(sol))}</span></div>${edit}${on ? adjustHtml(t) : ''}</div>`;
    const dh = `${sol.dh >= 0 ? '+' : '−'}${Math.abs(Math.round(sol.dh))} m`;
    const zone = BLAST[S.shell];
    const mpc = gunels().milsPerCircle;
    const aimOff = Math.round(b.azMil - (sol.az * mpc / 360));
    const big = `<div class="big"><div><span class="k">Ring</span><span class="v">${b.ring}</span></div>` +
      `<div><span class="k">Elevation</span><span class="v">${Math.round(b.elev)}<small> mil</small></span></div>` +
      `<div><span class="k">Azimuth</span><span class="v">${Math.round(sol.azMil)}<small> mil</small></span></div>` +
      `<div><span class="k">Flight</span><span class="v">${b.tof.toFixed(1)}<small> s</small></span></div></div>`;
    const wind = S.wind.s > 0 && aimOff % mpc !== 0 ? ` · wind aims ${Math.abs(aimOff)} mil ${aimOff < 0 ? 'left' : 'right'} (included)` : '';
    const facts = `<div class="facts">Target is <b>${dh}</b> from the mortar · 9 in 10 rounds land within <b>${b.spread ? `±${b.spread.long} m long/short, ±${b.spread.side} m left/right` : `±${b.dispersion} m`}</b>` +
      (zone ? ` · kill <b>${zone.kill ? `+${zone.kill} m` : 'none'}</b> · danger <b>+${zone.danger} m</b>` : '') + `${wind}</div>`;
    const fire = fired.get(t.id);
    const fireBtn = `<div class="fire-row"><button data-fire="${t.id}" data-tof="${b.tof.toFixed(2)}" class="${fire ? 'cd' : ''}">${fire ? '…' : 'Fired'}</button></div>`;
    let more = '';
    if (on) {
      const multi = sol.rings.length > 1;
      more = (multi ? `<details class="alternate-rings"><summary>Compare ${sol.rings.length} available charge rings</summary><table class="rings"><tr><th>Ring</th><th>Elev</th><th>Az</th><th>Flight</th><th>Spread</th></tr>` +
        sol.rings.map(r => `<tr class="${r === b ? 'best' : ''}"><td>${r.ring}</td><td>${Math.round(r.elev)}</td><td>${Math.round(r.azMil)}</td><td>${r.tof.toFixed(1)} s</td>` +
          `<td>${r.spread ? `±${r.spread.long} / ±${r.spread.side} m` : `±${r.dispersion} m`}</td></tr>`).join('') + `</table></details>` : '') + adjustHtml(t);
    }
    return `<div class="tgt ${on ? 'on' : ''}">${head}${big}${fireBtn}${more}${edit}${facts}</div>`;
  }
  function adjustHtml(t) {
    const g = S.corr === 'gun';
    const pad4 = g
      ? [['add', 'Add ↑'], ['drop', 'Drop ↓'], ['left', '← Left'], ['right', 'Right →']]
      : [['n', 'North'], ['s', 'South'], ['e', 'East'], ['w', 'West']];
    return `<div class="adjust"><div class="lab"><span>Move by</span>` +
      `<span class="seg">${[10, 25, 50, 100].map(v => `<button data-step="${v}" class="${S.step === v ? 'sel' : ''}">${v}</button>`).join('')}</span><span>m</span><span class="sp"></span>` +
      `<span class="seg"><button data-corr="gun" class="${g ? 'sel' : ''}" title="Add / drop along the line from the mortar to the target">gun line</button>` +
      `<button data-corr="compass" class="${g ? '' : 'sel'}" title="North / south / east / west">compass</button></span></div>` +
      `<div class="pad">${pad4.map(([k, n]) => `<button data-adj="${k}" data-id="${t.id}">${n}</button>`).join('')}</div>` +
      `<div class="fire-row"><button data-undo="${t.id}" ${t.undo.length ? '' : 'disabled'}>Undo last correction</button></div></div>`;
  }
  function renderTargets() {
    const m = cur(), box = $('#targets');
    $('#mission-count').textContent = `${m.targets.length} target${m.targets.length === 1 ? '' : 's'}`;
    $('#tgt-actions').classList.toggle('hidden', !m.targets.length);
    if (!ready()) { box.innerHTML = '<div class="empty">Loading terrain and firing tables…</div>'; return; }
    if (!m.gun) {
      box.innerHTML = '<div class="empty"><b>Set your mortar first.</b><ol class="mission-steps">' +
        '<li><span><b>Place the gun.</b> Type its grid under Gun setup, or pick <i>Set mortar</i> and click the reference map.</span></li>' +
        '<li><span><b>Enter the wind</b> as the in-game map shows it: speed, and the direction it blows from.</span></li>' +
        '<li><span><b>Add targets</b> by grid above, or with <i>Add targets</i> on the reference map. Each gets its ring, elevation, azimuth and flight time here.</span></li>' +
        '</ol></div>';
      return;
    }
    if (!m.targets.length) { box.innerHTML = '<div class="empty"><b>Ready for a fire mission.</b><br>Enter a target grid above. Ring, elevation, azimuth and flight time appear here.<br>Use the reference map when you need to check a location.</div>'; return; }
    if (!m.targets.some(t => t.id === S.sel)) S.sel = (m.targets[m.selected || 0] || m.targets[0]).id;
    const index = m.targets.findIndex(t => t.id === S.sel);
    const rows = m.targets.map((t, i) => {
      const sol = solveTo(t.xz), b = sol.best;
      return `<tr class="${S.sel === t.id ? 'selected' : ''}"><td><button data-sel="${t.id}" aria-pressed="${S.sel === t.id}">T${i + 1}<span>${pad(t.xz[0] / 10, 4)} ${pad(t.xz[1] / 10, 4)}</span></button></td>` +
        (b ? `<td>${b.ring}</td><td>${Math.round(b.elev)}</td><td>${Math.round(sol.azMil)}</td><td>${b.tof.toFixed(1)} s</td>` : '<td colspan="4" class="unreachable">Out of range</td>') +
        `<td class="queue-status" data-countdown="${t.id}">${b ? 'READY' : 'CHECK'}</td></tr>`;
    }).join('');
    box.innerHTML = `<div class="active-mission"><div class="active-mission-label"><span>ACTIVE TARGET / T${index + 1}</span><div class="target-navigation"><button data-next="-1" ${index === 0 ? 'disabled' : ''} aria-label="Previous target">← Previous</button><button data-next="1" ${index === m.targets.length - 1 ? 'disabled' : ''} aria-label="Next target">Next →</button></div></div>${targetCard(m.targets[index], index)}</div>` +
      `<section class="mission-queue" aria-label="Target queue"><h2><span>TARGET QUEUE / ${m.targets.length.toString().padStart(2, '0')}</span><span>Elevation & azimuth in mils</span></h2><div class="queue-scroll"><table class="mission-table"><thead><tr><th>Target / grid</th><th>Ring</th><th>Elev</th><th>Az</th><th>Flight</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
    updateCountdowns();
  }
  function renderGunNote() {
    const m = cur(), note = $('#gun-note');
    note.classList.remove('err');
    if (!ready()) { note.textContent = 'Loading…'; return; }
    if (!m.gun) { note.textContent = 'Type a grid, or click the map.'; if (document.activeElement !== $('#gun-grid')) $('#gun-grid').value = ''; return; }
    if (document.activeElement !== $('#gun-grid')) $('#gun-grid').value = grid(m.gun);
    const rch = reachNow(), set = chargeSet(), alt = groundFine(m.gun[0], m.gun[1]);
    const list = rch ? rch.rings.filter(r => set == null || r.ring === set) : [], top = list[list.length - 1];
    const rings = shellRings(), min = set != null ? rings[set].table[0][0] : Math.min(...Object.values(rings).map(r => r.table[0][0]));
    note.textContent = `Ground ${Math.round(alt)} m · fires ${fmtDist(min)} to ${top && top.near != null ? fmtReach(top.near, top.far) : '—'}` +
      `${top && top.near != null ? ' (it varies with direction, wind and hills)' : ''}`;
  }
  function renderModeUi() {
    const m = cur();
    $('#mode-gun').classList.toggle('sel', S.mode === 'gun');
    $('#mode-tgt').classList.toggle('sel', S.mode === 'tgt');
    $('#mode-tgt').disabled = !m.gun;
    $('#map').classList.toggle('aiming', ready());
    $('#hint').textContent = !ready() ? 'Loading…' : S.mode === 'gun' ? (m.gun ? 'Click the map to move your mortar' : 'Click the map to place your mortar')
      : m.targets.length >= MAX_TARGETS ? `Up to ${MAX_TARGETS} targets. Remove one first.` : 'Click to add a target · drag a target to correct it';
    if (S.mode !== 'tgt') hideAim();
  }
  function render() {
    renderModeUi(); renderGunNote(); renderMap(); renderTargets(); renderRoomPanels(); renderRoomMap();
  }

  // ---------------------------------------------------------------------------
  // Changes
  // ---------------------------------------------------------------------------
  const inWorld = xz => xz[0] >= 0 && xz[1] >= 0 && xz[0] <= WORLD && xz[1] <= WORLD;
  function setGun(xz, fit) {
    if (!inWorld(xz)) return toastNote('#gun-note', "That's off the map.");
    const m = cur(), first = !m.gun;
    m.gun = [round1(xz[0]), round1(xz[1])];
    fired.clear();
    if (S.mode === 'gun') S.mode = 'tgt';
    save(); render();
    if (fit || first) fitAll();
  }
  function addTarget(xz, fit) {
    const m = cur();
    if (!m.gun) return;
    if (!inWorld(xz)) return toastNote('#tgt-note', "That's off the map.");
    if (m.targets.length >= MAX_TARGETS) return toastNote('#tgt-note', `Up to ${MAX_TARGETS} targets.`);
    const t = { id: nextId++, xz: [round1(xz[0]), round1(xz[1])], undo: [] };
    m.targets.push(t);
    S.sel = t.id;
    save(); render();
    if (fit) fitAll();
    scrollToCard(t.id);
  }
  function moveTarget(id, xz, fromDrag) {
    const t = cur().targets.find(q => q.id === id);
    if (!t) return;
    if (!inWorld(xz)) { toastNote('#tgt-note', "That's off the map."); render(); return; }
    t.undo.push(t.xz);
    if (t.undo.length > 20) t.undo.shift();
    t.xz = [round1(xz[0]), round1(xz[1])];
    fired.delete(id);
    S.sel = id;
    save(); render();
  }
  function selectTarget(id, scroll) {
    S.sel = id;
    cur().selected = Math.max(0,cur().targets.findIndex(t => t.id === id));
    save();
    renderMap(); renderTargets();
    if (S.sel != null && scroll) scrollToCard(id);
  }
  function scrollToCard(id) {
    const el = $('#targets .tgt-head');
    if (el) el.closest('.tgt').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function adjust(id, kind) {
    const m = cur(), t = m.targets.find(q => q.id === id);
    if (!t || !m.gun) return;
    const d = S.step, a = bearing(m.gun, t.xz) * Math.PI / 180, f = [Math.sin(a), Math.cos(a)], r = [Math.cos(a), -Math.sin(a)];
    const v = { add: f, drop: f.map(q => -q), right: r, left: r.map(q => -q), n: [0, 1], s: [0, -1], e: [1, 0], w: [-1, 0] }[kind];
    if (!v) return;
    const to = [t.xz[0] + v[0] * d, t.xz[1] + v[1] * d];
    if (!inWorld(to)) return toastNote('#tgt-note', "That's off the map.");
    t.undo.push(t.xz);
    t.xz = [round1(to[0]), round1(to[1])];
    fired.delete(id);
    save(); render();
  }
  function toastNote(sel, text) {
    const el = $(sel), old = el.dataset.old || el.textContent;
    el.dataset.old = old; el.textContent = text; el.classList.add('err');
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.textContent = old; el.classList.remove('err'); delete el.dataset.old; }, 3500);
  }

  // Countdown from "Fired" to the splash
  function updateCountdowns() {
    const now = Date.now();
    document.querySelectorAll('[data-fire]').forEach(btn => {
      const f = fired.get(+btn.dataset.fire);
      if (!f) { btn.className = ''; btn.textContent = 'Fired'; return; }
      const left = (f.end - now) / 1000;
      if (left > 0) { btn.className = 'cd'; btn.textContent = `Splash in ${left.toFixed(1)} s · tap to stop`; }
      else if (left > -6) { btn.className = 'done'; btn.textContent = 'SPLASH'; }
      else { fired.delete(+btn.dataset.fire); btn.className = ''; btn.textContent = 'Fired'; }
    });
    document.querySelectorAll('[data-countdown]').forEach(cell => {
      const id = +cell.dataset.countdown, f = fired.get(id), left = f ? (f.end - now) / 1000 : 0;
      cell.classList.toggle('flying', !!f);
      if (f && left <= -6) fired.delete(id);
      cell.textContent = f && left > -6 ? (left > 0 ? `${left.toFixed(1)} s` : 'SPLASH') : cell.closest('tr').querySelector('.unreachable') ? 'CHECK' : 'READY';
    });
  }
  setInterval(() => { if (fired.size) updateCountdowns(); }, 200);

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  map.on('click', e => {
    if (!ready()) return;
    const xz = toXZ(e.latlng);
    if (S.mode === 'gun' || !cur().gun) setGun(xz); else addTarget(xz);
  });
  // live solution under the cursor while adding targets
  let aimFrame = 0, lastLL = null;
  function hideAim() { $('#aim').classList.add('hidden'); ghostLayer.clearLayers(); }
  map.on('mousemove', e => {
    lastLL = e.latlng;
    const xz = toXZ(e.latlng);
    $('#cursor-grid').textContent = inWorld(xz) ? grid(xz) : '— —';
    if (aimFrame) return;
    aimFrame = requestAnimationFrame(() => {
      aimFrame = 0;
      const m = cur();
      if (S.mode !== 'tgt' || !m.gun || !ready() || !lastLL) return hideAim();
      const at = toXZ(lastLL);
      if (!inWorld(at)) return hideAim();
      const sol = solveTo(at);
      ghostLayer.clearLayers();
      ghostLayer.addLayer(L.polyline([toLL(m.gun), toLL(at)], { color: '#c8d96f', weight: 2, dashArray: '6 6', interactive: false }));
      if (sol.best) impactZones(ghostLayer, at, sol.best);
      const el = $('#aim');
      el.classList.remove('hidden');
      el.innerHTML = sol.best
        ? `${Mortar.short(sol)} <small>${fmtDist(sol.d)}</small>`
        : `<small>${esc(whyNot(sol))}</small>`;
    });
  });
  map.on('mouseout', hideAim);

  $('#mode-gun').addEventListener('click', () => { S.mode = 'gun'; renderModeUi(); });
  $('#mode-tgt').addEventListener('click', () => { if (cur().gun) { S.mode = 'tgt'; renderModeUi(); } });

  // gun grid
  function submitGrid(input, noteSel, apply) {
    const xz = parseGrid(input.value);
    if (!xz) return toastNote(noteSel, 'Type a grid like 123 456 (6 digits) or 1234 5678 (8 digits).');
    if (!inWorld(xz)) return toastNote(noteSel, "That's off the map.");
    apply(xz);
  }
  $('#gun-set').addEventListener('click', () => submitGrid($('#gun-grid'), '#gun-note', xz => { setGun(xz, true); }));
  $('#gun-grid').addEventListener('keydown', e => { if (e.key === 'Enter') $('#gun-set').click(); });
  $('#tgt-add').addEventListener('click', () => {
    if (!cur().gun) return toastNote('#tgt-note', 'Set your mortar first.');
    submitGrid($('#tgt-grid'), '#tgt-note', xz => { addTarget(xz, true); $('#tgt-grid').value = ''; $('#tgt-grid').focus(); });
  });
  $('#tgt-grid').addEventListener('keydown', e => { if (e.key === 'Enter') $('#tgt-add').click(); });
  $('#tgt-clear').addEventListener('click', () => {
    const m = cur();
    if (!m.targets.length) return;
    if (!confirm(`Remove all ${m.targets.length} targets?`)) return;
    m.targets = []; S.sel = null; fired.clear(); save(); render();
  });

  // the target list
  $('#targets').addEventListener('click', e => {
    const q = sel => e.target.closest(sel);
    let b;
    if ((b = q('[data-next]'))) {
      const m = cur(), index = m.targets.findIndex(t => t.id === S.sel), next = m.targets[index + +b.dataset.next];
      if (next) selectTarget(next.id, false);
    } else if ((b = q('[data-update-grid]'))) {
      submitGrid($('#active-target-grid'), '#tgt-note', xz => moveTarget(+b.dataset.updateGrid, xz));
    } else if ((b = q('[data-del]'))) {
      const m = cur(), id = +b.dataset.del;
      m.targets = m.targets.filter(t => t.id !== id); fired.delete(id);
      if (S.sel === id) S.sel = null;
      save(); render();
    } else if ((b = q('[data-fire]'))) {
      const id = +b.dataset.fire;
      if (fired.has(id)) fired.delete(id); else fired.set(id, { end: Date.now() + (+b.dataset.tof) * 1000 });
      persistFlights();
      updateCountdowns();
    } else if ((b = q('[data-adj]'))) adjust(+b.dataset.id, b.dataset.adj);
    else if ((b = q('[data-undo]'))) {
      const t = cur().targets.find(x => x.id === +b.dataset.undo);
      if (t && t.undo.length) { t.xz = t.undo.pop(); fired.delete(t.id); save(); render(); }
    } else if ((b = q('[data-step]'))) { S.step = +b.dataset.step; save(); renderTargets(); }
    else if ((b = q('[data-corr]'))) { S.corr = b.dataset.corr; save(); renderTargets(); }
    else if ((b = q('[data-sel]'))) {
      const id = +b.dataset.sel, t = cur().targets.find(x => x.id === id);
      selectTarget(id, false);
      if (t && S.sel === id && !map.getBounds().contains(toLL(t.xz))) map.panTo(toLL(t.xz));
    }
  });
  $('#targets').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.id === 'active-target-grid') {
      e.preventDefault(); $('#targets [data-update-grid]').click();
    }
  });

  // weapon, shell, ring
  function fillSelects() {
    const ws = $('#weapon'), ss = $('#shell'), cs = $('#charge');
    ws.innerHTML = Object.entries(TABLES.weapons).map(([k, w]) => `<option value="${esc(k)}">${esc(w.label)}</option>`).join('');
    if (!TABLES.weapons[S.weapon]) S.weapon = Object.keys(TABLES.weapons)[0];
    ws.value = S.weapon;
    const shells = Object.keys(TABLES.weapons[S.weapon].shells);
    if (!shells.includes(S.shell)) S.shell = shells.find(s => /^HE/.test(s)) || shells[0];
    ss.innerHTML = shells.map(s => `<option>${esc(s)}</option>`).join('');
    ss.value = S.shell;
    const rings = shellRings() || {};
    [...cs.options].forEach(o => { o.disabled = o.value !== '' && !rings[o.value]; });
    if (S.charge != null && !rings[S.charge]) S.charge = null;
    cs.value = S.charge == null ? '' : String(S.charge);
  }
  function gunChanged() { Mortar.invalidateTerrain(); fillSelects(); save(); render(); }
  $('#weapon').addEventListener('change', e => { S.weapon = e.target.value; fired.clear(); gunChanged(); });
  $('#shell').addEventListener('change', e => { S.shell = e.target.value; fired.clear(); gunChanged(); });
  $('#charge').addEventListener('change', e => { S.charge = e.target.value === '' ? null : +e.target.value; fired.clear(); gunChanged(); });

  // wind
  let windTimer = 0;
  // In a room the wind is the room's (one for everyone, on the map, this page and the shot planner): what is typed here
  // goes to the room, and the room's wind, set anywhere, comes back here (roomSettings).
  let roomWindTimer = 0;
  function readWind() {
    S.wind = { s: Math.min(Math.max(+$('#wind-s').value || 0, 0), 40), d: ((Math.round(+$('#wind-d').value || 0) % 360) + 360) % 360 };
    $('#wind-g').setAttribute('transform', `rotate(${S.wind.d})`);
    $('#wind-g').style.opacity = S.wind.s > 0 ? 1 : 0.3;
    clearTimeout(windTimer);
    windTimer = setTimeout(() => { fired.clear(); save(); render(); }, 150);
    if (inRoom()) {
      clearTimeout(roomWindTimer);
      roomWindTimer = setTimeout(() => room.setWind(S.wind).catch(err => toastNote('#room-status', err.message)), 500);
    }
  }
  $('#wind-s').addEventListener('input', readWind);
  $('#wind-d').addEventListener('input', readWind);
  $('#wind-quick').innerHTML = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].map((n, i) => `<button type="button" data-from="${i * 45}" title="Wind blowing from the ${n}">${n}</button>`).join('');
  $('#wind-quick').addEventListener('click', e => {
    const b = e.target.closest('[data-from]');
    if (!b) return;
    $('#wind-d').value = b.dataset.from;
    readWind();
  });
  function showWind() {
    $('#wind-s').value = S.wind.s; $('#wind-d').value = S.wind.d;
    $('#wind-g').setAttribute('transform', `rotate(${S.wind.d})`);
    $('#wind-g').style.opacity = S.wind.s > 0 ? 1 : 0.3;
  }

  // map choice
  async function setMap(id) {
    const gen = ++loadGen;
    S.map = id;
    $('#map-pick').value = id;
    HEIGHT = null; detailIndex = null; detailTiles.clear(); detailLoading.clear();
    Mortar.invalidateTerrain();
    S.sel = null; fired.clear(); restoreFlights();
    S.mode = cur().gun ? 'tgt' : 'gun';
    showMapBase(id, true);
    loadPlaces(id);
    save(); render();
    try {
      const ix = await fetch(`/data/maps/${id}/los/index.json`, { cache: 'no-cache' }).then(r => r.json()).catch(() => null);
      if (gen !== loadGen) return;
      if (ix && typeof DecompressionStream !== 'undefined') {
        detailV = ix.version; TERRAIN_UNIT = (ix.terrain && ix.terrain.unit) || 0.01;
        HN = (ix.light && ix.light.cols) || MAPS[id].lightCols || 1300;
        detailIndex = new Set(ix.tiles);
      } else HN = MAPS[id].lightCols || 1300;
      const buf = await fetch(`/data/maps/${id}/light/height.bin.gz?v=${detailV || 4}`).then(r => {
        if (!r.ok) throw new Error(r.status);
        return new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      });
      if (gen !== loadGen) return;
      HEIGHT = new Int16Array(buf);
      Mortar.invalidateTerrain();
      render();
      fitAll(true);
    } catch (err) {
      console.error(err);
      if (gen === loadGen) { $('#hint').textContent = 'Could not load the terrain heights. Reload the page to try again.'; }
    }
  }
  $('#map-pick').addEventListener('change', e => { if (e.target.disabled || room.me || want) { e.target.value = S.map; return; } setMap(e.target.value); });
  $('#fit').addEventListener('click', () => fitAll(true));

  // ---------------------------------------------------------------------------
  // Room: the field map's own rooms (3d/room.js does the joining and the live updates). In a room your mortar is a
  // normal mortar marking under your name, so the full map and everyone else sees it; you see their mortars and every
  // fire request, with a firing solution from your mortar (or a teammate's you choose to use). The field map's keys are
  // shared: one session per tab (name, room, map), the followed mortar, and the 5-minute copy of your markings, so
  // switching between this page and the map in one tab keeps your room and your markings.
  // ---------------------------------------------------------------------------
  const SESSION_KEY = 'everon-session', FOLLOW_KEY = 'everon-map-follow-mortar', NAME_KEY = 'everon-mortar-name', KEEP_PREFIX = 'everon-kept:';
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
  const FIRE = {
    he: { name: 'HE', color: '#ff922b', shell: /^HE/ },
    smoke: { name: 'Smoke', color: '#dee2e6', shell: /^Smoke/ },
    illum: { name: 'Illumination', color: '#ffe066', shell: /^Illum/ },
  };
  const isFireReq = it => (it.type === 'area' && it.kind === 'fire') || (it.type === 'marker' && it.icon === 'fire-point');
  function polyCentroid(pts) {
    let a = 0, cx = 0, cz = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const f = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
      a += f; cx += (pts[j][0] + pts[i][0]) * f; cz += (pts[j][1] + pts[i][1]) * f;
    }
    return a ? [cx / (3 * a), cz / (3 * a)] : pts[0];
  }
  const fireAim = req => (req.points ? polyCentroid(req.points) : req.xz);
  const fmtAgo = ms => { const m = Math.floor(ms / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`; };

  const roomLayer = L.layerGroup().addTo(map); // teammates' mortars and the fire requests
  let want = null;          // { name, code } while we mean to be in a room (rejoins after a dropped connection)
  let listening = false, synced = false, restoring = false, leaving = false;
  let publishTimer = 0, retryTimer = 0, retryN = 0, knownReqs = new Set();
  let followId = ls.get(FOLLOW_KEY) || null;
  const published = new Set(); // signatures of what we sent, so the server's echo isn't mistaken for someone else's change
  let pendingMortarId = null, joiningUnedited = false;
  const itemWrites = PlanSync.writer();
  const room = Room('/api', { onChange: ev => roomChanged(ev), onStatus: (state, text, removed) => roomStatus(state, text, removed),
    onSettings: kind => roomSettings(kind) });
  const inRoom = () => !!(listening && room.me);
  const roomKey = () => (room.me ? `${room.me.room}|${room.me.name.toLowerCase()}` : '');
  ownedBy = () => (inRoom() && synced ? roomKey() : null);
  const myItems = () => (room.me && room.players.get(room.me.name) && room.players.get(room.me.name).items) || new Map();
  const existingMortar = () => [...myItems().values()].find(i => i.type === 'mortar' && !planBackup.deleted(room.me, i.id)) || null;

  // ---- what's in the room
  const mortarSig = ({ xz, weapon, shell, charge, wind, targets }) => (xz ? JSON.stringify([xz.map(round1), weapon, shell, Number.isInteger(charge) ? charge : null,
    wind && wind.s > 0 ? [wind.s, wind.d % 360] : null, (targets || []).map(p => p.map(round1))]) : null);
  const localSig = () => mortarSig({ xz: cur().gun, weapon: S.weapon, shell: S.shell, charge: chargeSet(), wind: S.wind, targets: cur().targets.map(t => t.xz) });
  function teamMortars() {
    const out = [];
    if (room.me) for (const [name, p] of room.players) if (name !== room.me.name) for (const it of p.items.values()) if (it.type === 'mortar' && it.xz) out.push({ name, color: p.color, it });
    return out;
  }
  function fireRequests() {
    const out = [];
    if (room.me) for (const [name, p] of room.players) for (const it of p.items.values()) if (isFireReq(it)) out.push({ name, color: p.color, it });
    return out.sort((a, b) => (b.it.at || 0) - (a.it.at || 0));
  }
  // The gun the fire requests are solved for: the teammate's mortar you chose to use, else yours.
  function solutionSource() {
    const f = followId && teamMortars().find(x => x.it.id === followId);
    if (f) return { desc: descOf(f.it), name: f.name, label: f.it.label || 'Mortar', own: false };
    const d = myDesc();
    return d ? { desc: d, name: room.me && room.me.name, label: 'Your mortar', own: true } : null;
  }

  // ---- your mortar marking
  function buildItem() {
    const g = cur().gun, ex = existingMortar();
    if (ex) pendingMortarId = ex.id;
    const item = { ...(ex || {}), id: ex ? ex.id : (pendingMortarId ||= `mortar-${Math.random().toString(36).slice(2, 10)}`), type: 'mortar', xz: g, weapon: S.weapon, shell: S.shell,
      targets: cur().targets.map(t => t.xz), label: (ex && ex.label) || 'Mortar', note: (ex && ex.note) || '', color: (ex && ex.color) || room.me.color };
    const ch = chargeSet();
    if (ch != null) item.charge = ch; else delete item.charge;
    if (S.wind.s > 0) item.wind = { s: S.wind.s, d: S.wind.d }; else delete item.wind;
    return item;
  }
  function publishSoon() {
    if (!inRoom() || !synced || restoring || !cur().gun) return;
    clearTimeout(publishTimer);
    publishTimer = setTimeout(publishNow, 350);
  }
  async function publishNow() {
    publishTimer = 0;
    if (!inRoom() || !synced || restoring || !cur().gun || !TABLES) return;
    const me = room.me, item = buildItem(), ex = existingMortar(), sig = mortarSig(item);
    if (ex && mortarSig(ex) === sig) return;
    published.add(sig);
    if (published.size > 8) published.delete(published.values().next().value);
    planBackup.stage(me, item); writeKept();
    try { await itemWrites(me, item.id, () => api('/api/item', { id: me.id, token: me.token, item })); }
    catch (err) { published.delete(sig); toastNote('#room-status', err.message); }
  }
  // Take a mortar marking from the room as this page's setup (first join, or a teammate corrected your targets)
  function adoptMortar(it) {
    pendingMortarId = it.id;
    const m = cur(), old = m.targets;
    m.gun = [round1(it.xz[0]), round1(it.xz[1])];
    S.weapon = it.weapon; S.shell = it.shell;
    S.charge = Number.isInteger(it.charge) ? it.charge : null;
    // the room's wind if it has one (the mortar takes it, see roomSettings), else the one saved on the mortar
    const w = room.wind || it.wind;
    S.wind = w && w.s > 0 ? { s: w.s, d: ((w.d % 360) + 360) % 360 } : { s: 0, d: 0 };
    m.targets = (it.targets || []).map((xz, i) => (old[i] ? { ...old[i], xz: xz.slice(), undo: old[i].xz[0] === xz[0] && old[i].xz[1] === xz[1] ? old[i].undo : [] } : { id: nextId++, xz: xz.slice(), undo: [] }));
    if (S.mode === 'gun') S.mode = 'tgt';
    fillSelects(); showWind(); save(); render();
  }
  function adoptFromRoom() {
    if (restoring || publishTimer) return;
    const ex = existingMortar();
    if (!ex) return;
    const sig = mortarSig(ex);
    if (sig === localSig() || published.has(sig)) return;
    adoptMortar(ex);
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
    if (!restoring && cur().gun && TABLES) { const mine = buildItem(); if (!planBackup.deleted(me, mine.id)) items = items.filter(i => i.id !== mine.id && i.type !== 'mortar').concat(mine); }
    ls.set(keptKey(me), items.length ? JSON.stringify({ at: Date.now(), items }) : null);
  }
  setInterval(writeKept, 60e3);

  // ---- joining and leaving
  function roomStatus(state, text, removed = false) {
    const st = $('#room-status');
    st.textContent = text || '';
    st.classList.remove('err');
    $('#room-join').textContent = state === 'on' ? 'Leave' : 'Join';
    $('#room-join').disabled = state === 'joining';
    $('#room-name').disabled = $('#room-code').disabled = state !== 'off';
    lockMapPick(state !== 'off' || !!want);
    if (state === 'off') {
      const was = listening;
      listening = false; synced = false; restoring = false; clearTimeout(publishTimer); publishTimer = 0;
      if (removed) { ses.set(SESSION_KEY, null); want = null; }
      else if (was && want && !leaving) scheduleRejoin();
      renderRoomPanels(); renderRoomMap();
    }
  }
  // A room keeps the map it was opened on, so while you're in one (or joining, or reconnecting) the map choice is locked to it
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
  // map: the map the room was on, when we know it. A room that emptied while we changed pages is opened again on the map
  // we ask for, so asking for this page's own last map (not the room's) would put the squad on the wrong one.
  async function joinRoom(name, code, { again = 0, auto = false, map: roomMap = null } = {}) {
    name = String(name).trim(); code = String(code).trim().toLowerCase();
    if (!name || !code) return roomStatus('off', 'Enter your name and the room code.');
    want = { name, code, map: MAPS[roomMap] ? roomMap : S.map };
    let me = null;
    for (let tries = again + 1; !me; tries--) {
      try { me = await room.join(name, code, want.map); }
      catch (err) {
        if (tries > 1 && /in use/.test(err.message)) { $('#room-status').textContent = 'Waiting for your last session to end…'; await sleep(1500); continue; }
        if (auto && /reach/.test(err.message)) { scheduleRejoin(); return; }
        want = null; lockMapPick(false);
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
    joiningUnedited = !!(cur().gun && S.owner && S.owner !== roomKey() && localSig() === S.ownerSig);
    pendingMortarId = null;
    retryN = 0; synced = false; restoring = false; published.clear();
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
    try { await navigator.clipboard.writeText(link); toastNote('#room-status', 'Invite link copied. Send it to your squad.'); }
    catch { toastNote('#room-status', link); }
  });
  // Going to the map or coming back: this tab's session is already saved, so the other page joins by itself
  // (on beforeunload as well as pagehide: by pagehide the browser may already have cut the live-update stream, which
  // would make the room code think the connection was lost before we could say goodbye, as the field map's own page does)
  function goodbye() {
    if (leaving || !room.me) return;
    leaving = true;
    try { writeKept(); } catch (err) { console.error(err); } // (leaving the room must happen anyway)
    room.leave();
  }
  addEventListener('beforeunload', goodbye);
  addEventListener('pagehide', goodbye);
  addEventListener('pageshow', e => { leaving = false; if (e.persisted && want) joinRoom(want.name, want.code, { again: 3, map: want.map }); });
  function updatePageLinks() {
    const code = room.me ? `#room=${encodeURIComponent(room.me.room)}` : '';
    $('#to-map').href = `/${code}`;
    $('#to-shot').href = `/shot.html${code}`;
    if ($('#to-base')) $('#to-base').href = `/base.html${code}`;
  }

  // ---- changes in the room
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
    const ex = existingMortar();
    if (ex) adoptMortar(ex);
    else if (cur().gun && joiningUnedited) {
      // the kept mortar belongs to another room or name and hasn't changed since: it stays out of this room
      const m = cur();
      m.gun = null; m.targets = []; S.sel = null; S.mode = 'gun';
      S.owner = roomKey(); S.ownerSig = null; synced = true;
      save(); render();
    } else if (cur().gun) publishNow();
    writeKept();
    renderRoomPanels(); renderRoomMap();
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
    if (!m || +m[1] > 23 || +m[2] > 59) return toastNote('#room-status', 'Type the game time as hours and minutes, like 06:42.');
    const c = { ...CLOCK_DEFAULT, ...(room.clock || {}) };
    try {
      await room.setClock({ game: +m[1] * 3600 + +m[2] * 60, rate: c.rate, year: c.year, month: c.month, day: c.day, lat: c.lat });
      $('#room-clock-in').value = '';
    } catch (err) { toastNote('#room-status', err.message); }
  });
  // The room's wind and clock (the snapshot when joining, then 'wind' and 'clock' events): the wind is this page's, and
  // the mortar marking takes it; a room with no wind yet takes the one set here before joining.
  function roomSettings(kind) {
    if (kind !== 'clock') {
      const w = room.wind;
      if (w) {
        const typing = $('.wind').contains(document.activeElement);
        if (!typing && (w.s !== S.wind.s || w.d !== S.wind.d)) {
          S.wind = { s: w.s, d: ((w.d % 360) + 360) % 360 };
          showWind(); fired.clear(); save(); render();
        }
      } else if (!kind && S.wind.s > 0) room.setWind(S.wind).catch(err => console.error(err));
    }
    renderRoomClock();
  }
  function roomChanged(ev) {
    if (ev?.type === 'delete' && ev.owner === room.me?.name) planBackup.remove(room.me, ev.id);
    if (ev?.type === 'delete' && ev.owner === room.me?.name && ev.id === pendingMortarId) {
      cur().gun = null; cur().targets = []; pendingMortarId = null; save(); render();
    }
    if (room.me) planBackup.acknowledge(room.me, myItems());
    if (!inRoom()) { renderRoomPanels(); renderRoomMap(); renderRoomClock(); return; }
    if (!synced) { synced = true; knownReqs = new Set(fireRequests().map(r => r.it.id)); afterSnapshot(); }
    else { adoptFromRoom(); notifyRequests(); }
    renderRoomPanels(); renderRoomMap();
  }
  function toast(html, ms = 9000) {
    const el = $('#toast');
    el.innerHTML = html; el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), ms);
  }
  $('#toast').addEventListener('click', () => { $('#toast').classList.add('hidden'); $('#req-card').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  function notifyRequests() {
    if (!ready()) return;
    for (const { name, it } of fireRequests()) {
      if (knownReqs.has(it.id)) continue;
      knownReqs.add(it.id);
      if (name === room.me.name) continue;
      const f = FIRE[it.fire] || FIRE.he, src = solutionSource();
      let sol = null, shell = null;
      if (src) { shell = Mortar.shellLike(TABLES, src.desc.weapon, f.shell, src.desc.shell); sol = solveWith(src.desc, fireAim(it), shell); }
      toast(`<b>${esc(f.name)} request</b> from ${esc(name)}${it.label ? ` · ${esc(it.label)}` : ''}<br>` +
        (sol && sol.best ? Mortar.short(sol) : src ? 'out of range for this mortar' : 'set your mortar for a solution'));
    }
  }

  // ---- drawing the room: the cards on the left
  let lastReqHtml = '', lastTeamHtml = '';
  function renderRoomPanels() {
    const on = inRoom();
    $('#room-invite').classList.toggle('hidden', !on);
    $('#req-card').classList.toggle('hidden', !on);
    $('#team-card').classList.toggle('hidden', !on);
    updatePageLinks();
    if (!on || !ready()) { lastReqHtml = lastTeamHtml = ''; return; }
    renderRequests(); renderTeam();
  }
  function requestCard({ name, it }, src) {
    const f = FIRE[it.fire] || FIRE.he, aim = fireAim(it), d = src.desc, mineReq = name === room.me.name;
    const shell = Mortar.shellLike(TABLES, d.weapon, f.shell, d.shell), sol = solveWith(d, aim, shell), b = sol.best;
    const label = it.label || 'Fire mission';
    const details = `${label} · ${name} · ${shell} · asked ${fmtAgo(Date.now() - (it.at || Date.now()))}`;
    const add = src.own && cur().gun ? `<button data-add-req="${esc(it.id)}" title="Add ${esc(label)} as my target" aria-label="Add ${esc(label)} as my target">+ Add</button>` : '';
    const clear = mineReq || b ? `<button class="ghost" data-clear="${esc(it.id)}" data-owner="${esc(name)}" title="Mission complete: remove this request" aria-label="Remove ${esc(label)} fire request">✕</button>` : '';
    const solution = b ? `<td>${b.ring}</td><td>${Math.round(b.elev)}</td><td>${Math.round(sol.azMil)}</td><td>${b.tof.toFixed(1)} s</td>`
      : `<td colspan="4" class="unreachable">${esc(whyNot(sol,d,shell))}</td>`;
    return `<tr><td><div class="request-name"><span class="pill" style="background:${f.color}">${esc(f.name)}</span><button data-req="${esc(it.id)}" title="${esc(details)}" aria-label="Show ${esc(details)} on map">${esc(label)}</button></div></td>` +
      `<td>${grid(aim)}</td><td>${fmtDist(sol.d)}</td>${solution}<td><div class="request-actions">${add}${clear}</div></td></tr>`;
  }
  function renderRequests() {
    const src = solutionSource(), reqs = fireRequests();
    $('#req-count').textContent = reqs.length || '';
    $('#req-from').textContent = src && !src.own ? `Solutions from ${src.label} (${src.name})` : '';
    const html = !reqs.length ? '<div class="empty">No fire requests right now.</div>'
      : !src ? '<div class="empty">Set your mortar, or use a teammate\'s, to get solutions.</div>'
      : `<div class="request-scroll"><table class="mission-table request-table" aria-label="Fire requests; elevation and azimuth in mils"><thead><tr><th>Mission</th><th>Grid</th><th>Range</th><th>Ring</th><th>Elev</th><th>Az</th><th>Flight</th><th>Actions</th></tr></thead><tbody>${reqs.map(r => requestCard(r,src)).join('')}</tbody></table></div>`;
    if (html !== lastReqHtml) { lastReqHtml = html; $('#requests').innerHTML = html; }
  }
  function renderTeam() {
    const mates = teamMortars(), me = cur().gun;
    const html = !mates.length ? '<div class="empty">No other mortars in the room.</div>' : mates.map(({ name, color, it }) => {
      const on = followId === it.id, d = descOf(it);
      let lines = '';
      if (on) {
        lines = (it.targets || []).map((t, i) => {
          const sol = solveWith(d, t);
          return `<div class="line"><b>T${i + 1}</b> <span class="g">${grid(t)}</span> ${sol.best ? esc(Mortar.short(sol)) : '<span class="bad">out of range</span>'}</div>`;
        }).join('') || '<div class="facts">No targets yet.</div>';
      }
      return `<div class="mate ${on ? 'on' : ''}"><div class="tgt-head"><span class="dot" style="background:${esc(color)}"></span><b>${esc(name)}</b>` +
        `<span>${esc(it.label && it.label !== 'Mortar' ? `${it.label} · ` : '')}${esc(it.weapon)}</span><span class="sp"></span>` +
        `<button data-follow="${on ? '' : esc(it.id)}" class="${on ? 'sel' : ''}">${on ? 'Using its solutions' : 'Use its solutions'}</button></div>` +
        `<div class="facts">${esc(it.shell)} · ${(it.targets || []).length} target${(it.targets || []).length === 1 ? '' : 's'}` +
        `${me ? ` · ${fmtDist(dist(me, it.xz))} from you` : ''}${it.wind && it.wind.s > 0 ? ` · wind ${it.wind.s} m/s from ${pad(Math.round(it.wind.d) % 360, 3)}°` : ''}</div>${lines}</div>`;
    }).join('');
    if (html !== lastTeamHtml) { lastTeamHtml = html; $('#team').innerHTML = html; }
  }
  $('#requests').addEventListener('click', e => {
    let b;
    if ((b = e.target.closest('[data-clear]'))) {
      const me = room.me;
      api('/api/clear-fire', { id: me.id, token: me.token, owner: b.dataset.owner, itemId: b.dataset.clear })
        .catch(err => toastNote('#room-status', err.message));
    } else if ((b = e.target.closest('[data-add-req]'))) {
      const hit = fireRequests().find(r => r.it.id === b.dataset.addReq);
      if (hit) {
        const requestShell = Mortar.shellLike(TABLES,S.weapon,(FIRE[hit.it.fire] || FIRE.he).shell,S.shell);
        if (requestShell !== S.shell) { S.shell = requestShell; fired.clear(); fillSelects(); }
        S.mode = 'tgt'; addTarget(fireAim(hit.it));
      }
    } else if ((b = e.target.closest('[data-req]'))) {
      const hit = fireRequests().find(r => r.it.id === b.dataset.req);
      if (hit) map.panTo(toLL(fireAim(hit.it)));
    }
  });
  $('#team').addEventListener('click', e => {
    const b = e.target.closest('[data-follow]');
    if (!b) return;
    followId = b.dataset.follow || null;
    ls.set(FOLLOW_KEY, followId);
    lastReqHtml = lastTeamHtml = '';
    renderRoomPanels(); renderRoomMap();
  });

  // ---- drawing the room: on the map
  function renderRoomMap() {
    roomLayer.clearLayers();
    if (!inRoom() || !ready()) return;
    for (const { name, color, it } of teamMortars()) {
      const on = followId === it.id, c = toLL(it.xz), d = descOf(it);
      (it.targets || []).forEach((t, i) => {
        roomLayer.addLayer(L.polyline([c, toLL(t)], { color, weight: 1.2, opacity: on ? 0.8 : 0.45, dashArray: '2 5', interactive: false }));
        if (on) {
          const sol = solveWith(d, t);
          if (sol.best) impactZones(roomLayer, t, sol.best, it.shell);
          roomLayer.addLayer(L.marker(toLL(t), { keyboard: false, icon: glyph(i + 1, color, 'mate') })
            .bindTooltip(esc(`${name} T${i + 1} · ${sol.best ? Mortar.short(sol) : 'out of range'}`), tag()));
        } else roomLayer.addLayer(L.circleMarker(toLL(t), { radius: 4, color: '#0d1115', weight: 1.5, fillColor: color, fillOpacity: 0.9, interactive: false }));
      });
      roomLayer.addLayer(L.marker(c, { keyboard: false, zIndexOffset: 300, icon: glyph('⊕', color, 'mate') })
        .bindTooltip(esc(`${it.label && it.label !== 'Mortar' ? `${it.label} · ` : 'Mortar · '}${it.weapon} (${name})${on ? ' · solutions shown' : ''}`), tag()));
    }
    for (const { name, it } of fireRequests()) {
      const f = FIRE[it.fire] || FIRE.he, tip = `${f.name} request${it.label ? ` · ${it.label}` : ''} (${name})`;
      if (it.points) roomLayer.addLayer(L.polygon(it.points.map(toLL), { color: f.color, weight: 2.2, dashArray: '10 5', fillColor: f.color, fillOpacity: 0.2, interactive: true }).bindTooltip(esc(tip), { sticky: true }));
      else roomLayer.addLayer(L.marker(toLL(it.xz), { keyboard: false, icon: glyph('!', f.color, 'req') }).bindTooltip(esc(tip), tag()));
    }
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
  showWind();
  Promise.all([
    fetch('/api/maps').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
    fetch('/data/mortar-tables.json').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
  ]).then(([maps, tables]) => {
    MAPS = maps.maps; TABLES = tables;
    $('#map-pick').innerHTML = Object.entries(MAPS).map(([id, m]) => `<option value="${esc(id)}">${esc(m.title || id)}</option>`).join('');
    fillSelects();
    return setMap(MAPS[S.map] ? S.map : maps.default || Object.keys(MAPS)[0]);
  }).then(autoJoin).catch(err => {
    console.error(err);
    $('#hint').textContent = 'Could not load the map list or firing tables. Is the map server running?';
  });
  window.addEventListener('resize', () => map.invalidateSize());
})();

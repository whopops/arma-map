/* Arma Reforger Maps - client */
(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Coordinates. Game X runs east, game Z runs north, both in metres (0..12800).
  // Tiles and CRS: 1 unit = 1 m, 50 m tile offset.
  // ---------------------------------------------------------------------------
  const OFFSET = 50;
  const SCALE = 12.501;
  // The maps a room can be opened on, as the server lists them (/api/maps: one per data/maps/<id>/map.json). Every map's
  // data lives in data/maps/<id>/ (roads.json, places.json, light/, los/, plants/, foliage.json, foliage/, tiles/), as
  // baked by reforger-map-tools. size: the world's side in metres. poi: extra reference layers (Conflict bases, caves,
  // supplies...) when the map has them. plants/plantsDir: the plant list and tile files the Measured line of sight reads.
  const mapDef = (id, m) => ({
    id, name: m.title || id, size: m.world, dir: `data/maps/${id}`, tiles: m.tiles, poi: m.poi || null,
    foliage: `data/maps/${id}/foliage/foliage_profiles.json`, plants: m.hasPlants ? `data/maps/${id}/foliage.json` : null,
    plantsDir: `data/maps/${id}/plants`, relief: m.hasRelief ? `data/maps/${id}/relief/{z}/{x}/{y}.jpg?v=${+m.hasRelief}` : null,
  });
  let MAPS = {}, DEFAULT_MAP = null;
  // until the list arrives: an empty 12.8 km map with no tiles
  let MAP = { id: '', name: '', size: 12800, dir: '', tiles: null, poi: null, foliage: null, plants: null, plantsDir: null };
  let WORLD = MAP.size;
  const mapLosDir = () => `${MAP.dir}/los`;
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
  const grid = ([x, z], digits = 3) => {
    const div = digits === 4 ? 10 : 100;
    return `${pad(x / div, digits)} ${pad(z / div, digits)}`;
  };
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const bearing = (a, b) => ((Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI) + 360) % 360;
  const fmtDist = m => m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
  const fmtBearing = deg => `${pad(Math.round(deg) % 360, 3)}° · ${pad(Math.round(deg * 6400 / 360) % 6400, 4)} mil`;
  const pathLength = pts => pts.reduce((s, p, i) => i ? s + dist(pts[i - 1], p) : 0, 0);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const $ = sel => document.querySelector(sel);

  // ---------------------------------------------------------------------------
  // Map
  // ---------------------------------------------------------------------------
  let worldBounds = L.latLngBounds(toLL([0, 0]), toLL([WORLD, WORLD]));
  const map = L.map('map', {
    crs: CRS,
    center: toLL([6400, 6400]),
    zoom: 0,
    minZoom: -1,
    maxZoom: 7,
    zoomSnap: 0.5,
    zoomControl: false,
    attributionControl: false,
    doubleClickZoom: false,
    preferCanvas: true,
    maxBounds: worldBounds.pad(0.25),
    maxBoundsViscosity: 0.8,
  });
  // The zoom buttons live in the right-hand column, above the game clock and the squad pop-out.
  const zoomEl = L.control.zoom({ position: 'bottomright' }).addTo(map).getContainer();
  $('#right-dock').insertBefore(zoomEl, $('#clock-wrap'));

  const BLANK_TILE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const MapTiles = L.TileLayer.extend({
    getTileUrl(c) {
      // the 50 m offset makes Leaflet ask for a column just past the last tile at some zooms: nothing is there. The
      // range is Everon's and Kolguyev's; a smaller map simply has no file for the rest (the server answers 404).
      const z = 5 - c.z, n = 2 ** (7 - z), y = -(c.y + 1), url = this.options.url;
      if (!url || c.x < 0 || y < 0 || c.x >= n || y >= n) return BLANK_TILE;
      return url.replace('{z}', z).replace('{x}', c.x).replace('{y}', y);
    },
  });
  let tileLayer = null;
  // The base picture: the satellite tiles, or the shaded-relief map (relief/, same layout) on maps that have it. The
  // choice is remembered in this browser.
  let baseMap = 'satellite';
  try { if (localStorage.getItem('baseMap') === 'relief') baseMap = 'relief'; } catch (e) { /* no storage: satellite */ }
  function setBaseTiles() {
    const relief = baseMap === 'relief' && MAP.relief;
    if (tileLayer) tileLayer.remove();
    tileLayer = new MapTiles('', { url: relief ? MAP.relief : MAP.tiles, className: relief ? 'relief-tiles' : '', minZoom: -1, maxZoom: 7, minNativeZoom: 0, maxNativeZoom: 5, bounds: worldBounds, keepBuffer: 3, errorTileUrl: BLANK_TILE }).addTo(map);
    tileLayer.bringToBack();
    $('#base-map').classList.toggle('hidden', !MAP.relief);
    document.querySelectorAll('#base-map [data-base]').forEach(b => {
      const sel = b.dataset.base === (relief ? 'relief' : 'satellite');
      b.classList.toggle('sel', sel);
      b.setAttribute('aria-checked', sel);
    });
    settingsSummary();
  }
  const pickBase = which => {
    baseMap = which;
    try { localStorage.setItem('baseMap', baseMap); } catch (e) { /* not remembered */ }
    setBaseTiles();
  };
  document.querySelectorAll('#base-map [data-base]').forEach(b => b.addEventListener('click', () => pickBase(b.dataset.base)));
  // The satellite picture, the map's edges and the view for the map in MAP; the join screen shows the one picked in its
  // list until a room's own map is known. Every layer's `bounds` option is read when a tile is asked for, so they are updated here.
  function showMapBase() {
    WORLD = MAP.size;
    worldBounds = L.latLngBounds(toLL([0, 0]), toLL([WORLD, WORLD]));
    setBaseTiles();
    map.setMaxBounds(worldBounds.pad(0.25));
    // A 12.8 km map opens at zoom 0; a smaller map opens zoomed in far enough to fill the window.
    map.invalidateSize({ animate: false });
    const size = map.getSize(), fit = size.x && size.y ? Math.log2(Math.min(size.x, size.y) / (WORLD / SCALE)) : 0;
    map.setView(toLL([WORLD / 2, WORLD / 2]), Math.min(3, Math.max(0, Math.round(fit * 2) / 2)), { animate: false });
    [gridLayer, contourLayer, hillshadeLayer, forestLayer, lzShadeLayer].forEach(l => { l.options.bounds = worldBounds; });
  }

  const GridOverlay = L.GridLayer.extend({
    createTile(coords) {
      const size = this.getTileSize();
      const c = document.createElement('canvas');
      c.width = size.x; c.height = size.y;
      const ctx = c.getContext('2d');
      const b = this._tileCoordsToBounds(coords);
      const w = b.getWest() - OFFSET, e = b.getEast() - OFFSET, s = b.getSouth() - OFFSET, n = b.getNorth() - OFFSET;
      const px = g => Math.round((g - w) / (e - w) * size.x) + 0.5;
      const py = g => Math.round((n - g) / (n - s) * size.y) + 0.5;
      const zoom = coords.z;
      const steps = zoom >= 2.5 ? [100, 1000] : [1000];
      for (const step of steps) {
        const major = step === 1000;
        ctx.strokeStyle = major ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.13)';
        ctx.lineWidth = major ? 1 : 1;
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
      return c;
    },
  });
  const gridLayer = new GridOverlay({ bounds: worldBounds, zIndex: 5, minZoom: -1, maxZoom: 7 }).addTo(map);

  // Contour lines from the terrain heightmap, rasterised per tile: a pixel is drawn where the height band
  // changes against its right or lower neighbour. Every fifth line (index contour) is brighter.
  const ContourLayer = L.GridLayer.extend({
    createTile(coords) {
      const size = this.getTileSize(), c = document.createElement('canvas');
      c.width = size.x; c.height = size.y;
      if (!HEIGHT) return c;
      const b = this._tileCoordsToBounds(coords);
      const w = b.getWest() - OFFSET, e = b.getEast() - OFFSET, s = b.getSouth() - OFFSET, n = b.getNorth() - OFFSET;
      const interval = coords.z >= 3 ? 10 : coords.z >= 1 ? 20 : 50;
      const W = size.x, H = size.y, band = new Float32Array((W + 1) * (H + 1));
      for (let y = 0; y <= H; y++) {
        const z = n - (n - s) * y / H;
        for (let x = 0; x <= W; x++) band[y * (W + 1) + x] = heightAt([w + (e - w) * x / W, z]);
      }
      const ctx = c.getContext('2d'), img = ctx.createImageData(W, H), px = img.data;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const h = band[y * (W + 1) + x], hr = band[y * (W + 1) + x + 1], hd = band[(y + 1) * (W + 1) + x];
          if (h < 0 && hr < 0 && hd < 0) continue; // open sea
          const k = Math.floor(h / interval);
          const edge = Math.floor(hr / interval) !== k ? Math.max(k, Math.floor(hr / interval))
            : Math.floor(hd / interval) !== k ? Math.max(k, Math.floor(hd / interval)) : null;
          if (edge === null) continue;
          const index = edge % 5 === 0, i = (y * W + x) * 4;
          px[i] = 255; px[i + 1] = index ? 226 : 214; px[i + 2] = index ? 170 : 150; px[i + 3] = index ? 200 : 105;
        }
      }
      ctx.putImageData(img, 0, 0);
      return c;
    },
  });
  const contourLayer = new ContourLayer({ bounds: worldBounds, zIndex: 4, minZoom: -1, maxZoom: 7 });

  // Hill shading: light from the north-west, 45° up, with heights exaggerated so Everon's gentle hills still read.
  // Slopes facing the light are brightened and slopes facing away darkened; flat ground stays clear.
  const SUN_AZ = 315 * Math.PI / 180, SUN_ALT = 45 * Math.PI / 180, RELIEF = 2.5;
  const HillshadeLayer = L.GridLayer.extend({
    createTile(coords) {
      const size = this.getTileSize(), c = document.createElement('canvas');
      c.width = size.x; c.height = size.y;
      if (!HEIGHT) return c;
      const b = this._tileCoordsToBounds(coords);
      const w = b.getWest() - OFFSET, e = b.getEast() - OFFSET, s = b.getSouth() - OFFSET, n = b.getNorth() - OFFSET;
      const W = size.x, H = size.y, mx = (e - w) / W, mz = (n - s) / H;
      const d = Math.max(mx * 1.5, 20); // slope over two heightmap cells or more, so the 10 m grid doesn't show
      const lx = Math.sin(SUN_AZ) * Math.cos(SUN_ALT), ly = Math.cos(SUN_AZ) * Math.cos(SUN_ALT), lz = Math.sin(SUN_ALT);
      const g = p => Math.max(heightAt(p), 0);
      const ctx = c.getContext('2d'), img = ctx.createImageData(W, H), px = img.data;
      for (let y = 0; y < H; y++) {
        const z = n - mz * (y + 0.5);
        for (let x = 0; x < W; x++) {
          const X = w + mx * (x + 0.5);
          const dx = (g([X + d, z]) - g([X - d, z])) / (2 * d) * RELIEF, dz = (g([X, z + d]) - g([X, z - d])) / (2 * d) * RELIEF;
          if (!dx && !dz) continue; // flat ground or sea
          const shade = (-dx * lx - dz * ly + lz) / Math.sqrt(dx * dx + dz * dz + 1) - lz, i = (y * W + x) * 4;
          if (shade < 0) { px[i] = 8; px[i + 1] = 12; px[i + 2] = 20; px[i + 3] = Math.min(190, -shade * 420); }
          else { px[i] = 255; px[i + 1] = 246; px[i + 2] = 225; px[i + 3] = Math.min(110, shade * 330); }
        }
      }
      ctx.putImageData(img, 0, 0);
      return c;
    },
  });
  const hillshadeLayer = new HillshadeLayer({ bounds: worldBounds, zIndex: 3, minZoom: -1, maxZoom: 7 });

  // Trees and buildings, per 10 m cell (row 0 = south edge), baked from the game's own objects by reforger-map-tools
  // (rmtlib/bake_los.py; FOLIAGE and CLUTTER by rmtlib/bake_plants.py):
  // FOREST   one bit per cell: woods (trees or bushes 3 m or taller over at least 35% of it). Drawn as a green hatch.
  // CANOPY   four planes of HN*HN bytes: canopy top (m), crown base (m), share of the cell blocked at head height by
  //          trunks, bushes and low branches (0-255), share covered by crowns seen from above (0-255).
  // BUILDINGS building height (m) where buildings fill at least 40% of the cell.
  // FOLIAGE  per height band above the ground (LIGHT_BANDS), the cell's average foliage k (how strongly leaves block
  //          sight, per metre, 0-255 = 0-LIGHT_K_MAX), from every measured plant.
  // CLUTTER  per height band, the share of the cell filled by buildings, walls, rocks and poles (0-255).
  let FOREST = null; // Uint8Array of packed bits
  let CANOPY = null, BUILDINGS = null, FOLIAGE = null, CLUTTER = null, FOLIAGE_MAX = null, CLUTTER_MAX = null; // max over bands
  const LIGHT_BANDS = [0, 1, 2, 4, 7, 12, 20, 45], LIGHT_K_MAX = 0.5;
  const cellOf = ([x, z]) => (x < 0 || z < 0 || x >= WORLD || z >= WORLD ? -1 : Math.floor(z / HCELL) * HN + Math.floor(x / HCELL));
  const canopyTop = p => { const k = cellOf(p); return CANOPY && k >= 0 ? CANOPY[k] : 0; };
  const buildingTop = p => { const k = cellOf(p); return BUILDINGS && k >= 0 ? BUILDINGS[k] : 0; };
  const isForest = ([x, z]) => {
    if (!FOREST || x < 0 || z < 0 || x >= WORLD || z >= WORLD) return false;
    const k = Math.floor(z / HCELL) * HN + Math.floor(x / HCELL);
    return (FOREST[k >> 3] >> (7 - (k & 7))) & 1;
  };
  const ForestLayer = L.GridLayer.extend({
    createTile(coords) {
      const size = this.getTileSize(), c = document.createElement('canvas');
      c.width = size.x; c.height = size.y;
      if (!FOREST) return c;
      const b = this._tileCoordsToBounds(coords);
      const w = b.getWest() - OFFSET, e = b.getEast() - OFFSET, s = b.getSouth() - OFFSET, n = b.getNorth() - OFFSET;
      const W = size.x, H = size.y, ctx = c.getContext('2d'), img = ctx.createImageData(W, H), px = img.data;
      const mx = (e - w) / W, mz = (n - s) / H, edge = 1.5; // outline pixels: forest with non-forest 1.5 px away
      for (let y = 0; y < H; y++) {
        const z = n - mz * (y + 0.5);
        for (let x = 0; x < W; x++) {
          const X = w + mx * (x + 0.5);
          if (!isForest([X, z])) continue;
          const i = (y * W + x) * 4;
          const rim = !isForest([X + edge * mx, z]) || !isForest([X - edge * mx, z]) || !isForest([X, z + edge * mz]) || !isForest([X, z - edge * mz]);
          px[i] = rim ? 160 : 110; px[i + 1] = 255; px[i + 2] = rim ? 140 : 120;
          px[i + 3] = rim ? 235 : (x + y) % 8 < 3 ? 170 : 45;
        }
      }
      ctx.putImageData(img, 0, 0);
      return c;
    },
  });
  const forestLayer = new ForestLayer({ bounds: worldBounds, zIndex: 4, minZoom: -1, maxZoom: 7 });

  // Helicopter landing suitability at every 10 m cell, baked by reforger-map-tools (rmtlib/bake_los.py) from the game's own terrain and
  // objects with the same rules as the landing zone check (the lz grid: 0 water, 1 good, 2 marginal, 3 no-go).
  // It leaves out the approach directions, which are too slow to check everywhere; hover or drop an LZ for those.
  // Loaded the first time the shading is shown.
  let LZ_GRID = null, lzGridLoading = false;
  function lzGrid() {
    if (LZ_GRID || lzGridLoading) return LZ_GRID;
    lzGridLoading = true;
    lightBin('lz')
      .then(buf => { LZ_GRID = new Uint8Array(buf); lzShadeLayer.redraw(); })
      .catch(err => { lzGridLoading = false; console.error('Landing grid not loaded', err); });
    return null;
  }
  const LZ_SHADE = [null, [81, 207, 102, 80], [255, 197, 61, 75], [255, 92, 92, 60]];
  const LzShadeLayer = L.GridLayer.extend({
    createTile(coords) {
      const size = this.getTileSize(), c = document.createElement('canvas');
      c.width = size.x; c.height = size.y;
      const g = lzGrid();
      if (!g) return c;
      const b = this._tileCoordsToBounds(coords);
      const w = b.getWest() - OFFSET, e = b.getEast() - OFFSET, s = b.getSouth() - OFFSET, n = b.getNorth() - OFFSET;
      const W = size.x, H = size.y, ctx = c.getContext('2d'), img = ctx.createImageData(W, H), px = img.data;
      const mx = (e - w) / W, mz = (n - s) / H;
      for (let y = 0; y < H; y++) {
        const z = n - mz * (y + 0.5);
        if (z < 0 || z >= WORLD) continue;
        const row = Math.floor(z / HCELL) * HN;
        for (let x = 0; x < W; x++) {
          const X = w + mx * (x + 0.5);
          if (X < 0 || X >= WORLD) continue;
          const col = LZ_SHADE[g[row + Math.floor(X / HCELL)]];
          if (!col) continue;
          const i = (y * W + x) * 4;
          px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2]; px[i + 3] = col[3];
        }
      }
      ctx.putImageData(img, 0, 0);
      return c;
    },
  });
  const lzShadeLayer = new LzShadeLayer({ bounds: worldBounds, zIndex: 4, minZoom: -1, maxZoom: 7 });
  // Shown while the landing zone tool is active, and whenever its layer is ticked.
  let lzShadeOn = false;
  const syncLzShade = () => (lzShadeOn || state.tool === 'lz' ? lzShadeLayer.addTo(map) : lzShadeLayer.remove());
  contourLayer.on('add remove', () => { if (lastCursor) map.fire('mousemove', { latlng: toLL(lastCursor) }); });

  // Grid numbers along the bottom and right edges, like the margin of a paper map.
  function updateRulers() {
    const rx = $('#ruler-x'), rz = $('#ruler-z');
    if (!map.hasLayer(gridLayer)) { rx.innerHTML = rz.innerHTML = ''; return; }
    const step = map.getZoom() >= 2.5 ? 100 : 1000;
    const size = map.getSize(), b = map.getBounds();
    const [w, s] = toXZ(b.getSouthWest()), [e, n] = toXZ(b.getNorthEast());
    let xs = '', zs = '';
    for (let g = Math.max(0, Math.ceil(w / step) * step); g <= Math.min(WORLD, e); g += step) {
      const p = map.latLngToContainerPoint(toLL([g, s])).x;
      if (p > 20 && p < size.x - 44) xs += `<span style="left:${p}px">${pad(g / 100, 3)}</span>`;
    }
    for (let g = Math.max(0, Math.ceil(s / step) * step); g <= Math.min(WORLD, n); g += step) {
      const p = map.latLngToContainerPoint(toLL([w, g])).y;
      if (p > 70 && p < size.y - 26) zs += `<span style="top:${p}px">${pad(g / 100, 3)}</span>`;
    }
    rx.innerHTML = xs; rz.innerHTML = zs;
  }
  map.on('move zoom resize', updateRulers);
  map.whenReady(updateRulers);

  function updateZoomClass() {
    const z = map.getZoom(), el = map.getContainer();
    el.classList.toggle('z-lo', z < 1);
    el.classList.toggle('z-mid', z >= 1 && z < 2);
    el.style.setProperty('--zs', Math.pow(2, z)); // pixels per zoom-0 pixel, for labels kept clear of badges
  }
  map.on('zoomend', updateZoomClass);
  updateZoomClass();

  // ---------------------------------------------------------------------------
  // Shared UI helpers
  // ---------------------------------------------------------------------------
  let toastTimer;
  function toast(msg, ms = 3000) {
    const t = $('#toast');
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
  }

  // Player markings are filled circles; reference badges ("poi") are dark with a coloured ring.
  const glyphIcon = (ch, color, cls = '') => L.divIcon({
    className: `glyph ${cls}`, iconSize: [0, 0],
    html: `<div style="${cls.includes('poi') ? '--c' : 'background'}:${color}">${ch}</div>`,
  });
  const labelIcon = (text, cls, style = '') => L.divIcon({ className: `map-label ${cls}`, iconSize: [0, 0],
    html: `<span${style ? ` style="${style}"` : ''}>${esc(text)}</span>` });

  // Popups pan into the part of the map not covered by the sidebar, toolbar and open right-hand panels.
  function popup() {
    const sb = $('#sidebar'), wide = window.innerWidth > 720;
    const left = wide && !sb.classList.contains('collapsed') ? sb.getBoundingClientRect().right + 16 : 16;
    const open = wide ? ['#mortar-panel', '#squad-panel'].map(s => $(s)).filter(el => !el.classList.contains('hidden')) : [];
    const right = open.length ? window.innerWidth - Math.min(...open.map(el => el.getBoundingClientRect().left)) + 16 : 60;
    return L.popup({ maxWidth: 280, autoPanPaddingTopLeft: [left, 120], autoPanPaddingBottomRight: [right, 70] });
  }

  // Fly to a spot and open its popup when the flight ends (or after 1.2 s if the animation is held up).
  function flyAndOpen(xz, htmlFn, bounds = null) {
    let done = false;
    const open = () => {
      if (done) return;
      done = true;
      popup().setLatLng(toLL(xz)).setContent(htmlFn()).openOn(map);
    };
    const target = toLL(xz), zoom = Math.max(map.getZoom(), 3), size = map.getSize();
    // Leaflet's flyTo produces NaN positions when there is nowhere to fly (already centred) or the map has no size.
    const already = !bounds && zoom === map.getZoom() && map.latLngToContainerPoint(target).distanceTo(size.divideBy(2)) < 2;
    if (already || !size.x || !size.y) {
      if (bounds) map.fitBounds(bounds, { maxZoom: 4, animate: false }); else map.setView(target, zoom, { animate: false });
      open();
      return;
    }
    map.once('moveend', open);
    setTimeout(open, 1200);
    if (bounds) map.flyToBounds(bounds, { maxZoom: 4, duration: 0.8 });
    else map.flyTo(target, zoom, { duration: 0.8 });
  }

  function popupHtml(title, sub, xz, extra = '') {
    return `<div class="pop"><h3>${esc(title)}</h3>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}` +
      `<div class="grid">${grid(xz)}</div>${extra}</div>`;
  }

  // Click on anything: open info in Select mode, otherwise feed the click (snapped) into the active tool.
  function bindInfo(layer, htmlFn, snapXZ) {
    layer.on('click', e => {
      if (state.tool === 'pan') {
        popup().setLatLng(e.latlng).setContent(htmlFn()).openOn(map);
      } else {
        handleToolClick(snapXZ ? snapXZ() : toXZ(e.latlng));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Reference layers
  // ---------------------------------------------------------------------------
  // Colours mirror the --c-* tokens in app.css.
  const C = {
    hq: '#ff6b6b', mil: '#ffa94d', town: '#74c0fc', small: '#a9e34b', radio: '#da77f2',
    supply: '#4dabf7', vehicle: '#ffd43b', fuel: '#ff922b', repair: '#8ce99a', fia: '#f783ac', mob: '#ff8787', cave: '#ffc078',
  };
  const CONFLICT_STYLE = {
    'Main base (HQ)': [C.hq, 'H', 'Main base (HQ)'],
    'Military base': [C.mil, 'M', 'Military base'],
    'Town base': [C.town, 'T', 'Town base'],
    'Small base': [C.small, 'S', 'Small base'],
    'Radio tower': [C.radio, 'R', 'Radio tower'],
  };
  const badge = (ch, color) => `<span class="lg-badge" style="--c:${color}">${ch}</span>`;
  const LAYER_DEFS = [
    { group: 'Places', key: 'towns', label: 'Towns', on: true, icon: '<span class="lg-text">Aa</span>' },
    { key: 'landmarks', label: 'Landmarks', on: true, icon: '<span class="lg-text it">Aa</span>' },
    { key: 'caves', label: 'Caves & hideouts', on: true, icon: badge('◖', C.cave) },
    { group: 'Conflict', key: 'conflict', label: 'Bases & capture points', on: true, icon: badge('T', C.town), legend: true },
    { key: 'radio', label: 'Radio network', on: false, icon: '<span class="lg-radio"></span>', legendHtml:
      '<div class="legend-key one"><div><span class="lk-line solid"></span>Both in range of each other</div>' +
      '<div><span class="lk-line dash"></span>Only the radio tower reaches</div></div>' },
    { key: 'masts', label: 'Radio masts', on: false, icon: '<span class="lg-radio"></span>', countFn: d => d.conflict.filter(c => c.kind === 'Radio tower').length },
    { key: 'mob', label: 'HQ start positions', on: false, icon: badge('⚑', C.mob) },
    { group: 'Terrain', key: 'forest', label: 'Forest', on: false, icon: '<span class="lg-forest"></span>', countText: '', legendHtml:
      '<div class="legend-key one"><div>Ground ⅓+ covered by trees or bushes 3 m+. Line of sight uses each tree\'s real height.</div></div>' },
    { key: 'roads', label: 'Roads', on: false, icon: '<span class="lg-road"></span>', countText: '', legendHtml:
      '<div class="legend-key one"><div><span class="lk-line road-main"></span>Main road</div>' +
      '<div><span class="lk-line road-street"></span>Street</div>' +
      '<div><span class="lk-line road-dirt"></span>Dirt road</div></div>' },
    { key: 'paths', label: 'Foot paths', on: false, icon: '<span class="lg-path"></span>', countText: '', legendHtml:
      '<div class="legend-key one"><div><span class="lk-line road-path"></span>Foot path (vehicle routes avoid them)</div></div>' },
    { key: 'hillshade', label: 'Hill shading', on: false, icon: '<span class="lg-hill"></span>', countText: '' },
    { key: 'contours', label: 'Contour lines', on: false, icon: '<span class="lg-contour"></span>', countText: '10–50 m' },
    { key: 'fiaGame', box: '#fia-layers', label: "Show this game's caches", on: true, icon: '<span class="lg-live">◆</span>', dynamic: true },
    { key: 'fia', box: '#fia-layers', label: 'Show all possible cache spots', on: false, icon: badge('◆', C.fia) },
    { group: 'Planning overlays', key: 'coverage', label: 'Line-of-sight shading', on: true, icon: '<span class="lg-cov"></span>', countText: '', legendHtml:
      '<div class="legend-key one"><div><span class="lk-sw" style="--c:#66d9e8"></span>Seen from a range card</div>' +
      '<div><span class="lk-sw trees"></span>Seen only through trees</div>' +
      '<div><span class="lk-sw dark"></span>Hidden from every range card</div>' +
      '<div><span class="lk-sw" style="--c:#ff5c5c"></span>Enemy can see</div></div>' },
    { key: 'lzs', label: 'Helicopter landing', on: false, icon: '<span class="lg-lz"></span>', countText: '', legendHtml:
      '<div class="legend-key one"><div><span class="lk-sw" style="--c:#51cf66"></span>Good: flat and clear of trees</div>' +
      '<div><span class="lk-sw" style="--c:#ffc53d"></span>Marginal: sloping or trees nearby</div>' +
      '<div><span class="lk-sw" style="--c:#ff5c5c"></span>No-go: steep or trees on the spot</div></div>' },
    { group: 'Resources', key: 'supplies', label: 'Supply stashes', on: false, icon: `<span class="lg-dot" style="--c:${C.supply}"></span>` },
    { key: 'infinite', label: 'Infinite supply points', on: false, icon: badge('∞', C.supply), countFn: d => d.supplies.filter(s => s.amount === 'Infinite').length },
    { key: 'vehicles', label: 'Vehicle spawns', on: false, icon: `<span class="lg-dot" style="--c:${C.vehicle}"></span>` },
    { key: 'refuel', label: 'Refuel points', on: false, icon: `<span class="lg-dot" style="--c:${C.fuel}"></span>` },
    { key: 'repair', label: 'Repair points', on: false, icon: `<span class="lg-dot" style="--c:${C.repair}"></span>` },
    { key: 'fuelStations', label: 'Fuel stations', on: false, icon: badge('F', C.fuel) },
  ];
  const refLayers = {};
  let FIA_KNOWN = []; // [{name, xz}] - every spot a Conflict FIA cache can appear

  // Cap / build zone circles, toggled per Conflict point from its popup (only you see them).
  const ZONES = {
    cap: { label: 'Cap zone', radius: 50, style: { color: '#ffd43b', weight: 2, fillColor: '#ffd43b', fillOpacity: 0.14 } },
    build: { label: 'Build zone', radius: 100, style: { color: '#74c0fc', weight: 1.5, dashArray: '6 5', fillColor: '#74c0fc', fillOpacity: 0.07 } },
    radio: { label: 'Radio range', radius: null, style: { color: '#e599f7', weight: 1.5, dashArray: '2 6', fillColor: '#e599f7', fillOpacity: 0.04 } },
  };
  // Conflict radio ranges from the game data: 2 km for bases, 3 km for relay radio towers.
  const radioRange = c => (c.kind === 'Radio tower' ? 3000 : 2000);
  const zoneRadius = (c, key) => (key === 'radio' ? radioRange(c) : ZONES[key].radius);
  const fmtRadius = r => (r >= 1000 ? `${r / 1000} km` : `${r} m`);
  const CONFLICT_POINTS = [];
  const RADIO_LINKS = new Proxy({}, { get: (o, k) => (o[k] ??= []) }); // idx -> [{j, mutual}]
  function radioSummary(idx) {
    const c = CONFLICT_POINTS[idx], links = RADIO_LINKS[idx];
    const names = links.map(l => CONFLICT_POINTS[l.j].name).sort();
    return `<p class="sub">Radio range ${fmtRadius(radioRange(c))} · linked to ${links.length} point${links.length === 1 ? '' : 's'}</p>` +
      (names.length ? `<p class="sub radio-list">${names.map(esc).join(', ')}</p>` : '');
  }
  const zoneLayers = new Map(); // `${idx}:${zone}` -> L.circle

  // Which side holds each Conflict point (and radio tower). Marked by anyone in the room and shared: a player's 'control' item
  // holds {point name: {s: 'nato' | 'ussr', at: time}}; where two players disagree the newer mark wins.
  const SIDES = { nato: ['NATO', '#4dabf7'], ussr: ['USSR', '#ff6b6b'] };
  const controlLayer = L.layerGroup();
  function controlMarks() {
    const out = new Map();
    state.players.forEach(p => {
      if (!isMine(p.name) && !state.showOthers) return;
      p.items.forEach(it => {
        if (it.type !== 'control') return;
        for (const [name, m] of Object.entries(it.marks || {})) if (!out.has(name) || out.get(name).at < m.at) out.set(name, m);
      });
    });
    return out;
  }
  function controlButtons(name) {
    const cur = controlMarks().get(name);
    if (!state.me) return '<p class="sub">Join a room to mark who holds this point.</p>';
    return `<div class="row ctl-row">` + Object.entries(SIDES).map(([k, [label, color]]) =>
      `<button data-act="ctl" data-name="${esc(name)}" data-side="${k}" aria-pressed="${cur?.s === k}" style="border-color:${color}">${label}</button>`).join('') +
      `<button data-act="ctl" data-name="${esc(name)}" data-side="" aria-pressed="${!cur}">Unknown</button></div>`;
  }
  function syncControl() {
    controlLayer.clearLayers();
    const marks = controlMarks();
    CONFLICT_POINTS.forEach(c => {
      const m = c && marks.get(c.name);
      if (!m || !SIDES[m.s]) return;
      const color = SIDES[m.s][1];
      controlLayer.addLayer(L.circleMarker(toLL(c.xz), { radius: 15, color, weight: 3, fillColor: color, fillOpacity: 0.3, interactive: false }));
      controlLayer.addLayer(L.marker(toLL(c.xz), { interactive: false, keyboard: false,
        icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<span class="ctl-tag" style="background:${color}">${SIDES[m.s][0]}</span>` }) }));
    });
  }
  function setControl(name, side) {
    if (!state.me) return toast('Join a room to mark who holds a point.');
    const me = state.players.get(state.me.name), mine = me && [...me.items.values()].find(i => i.type === 'control');
    const marks = { ...(mine ? mine.marks : {}) };
    // Clearing removes only your own mark: one somebody else made stays until they clear it (or you mark the point again).
    if (side) marks[name] = { s: side, at: Date.now() }; else delete marks[name];
    if (!side && controlMarks().get(name) && !(mine && mine.marks[name])) return toast('Another player marked that one; ask them to clear it.');
    if (!Object.keys(marks).length) { if (mine) deleteItem(mine.id); return; }
    saveItem(mine ? { ...mine, marks } : { id: uid(), type: 'control', marks, label: 'Point control', note: '', color: state.me.color });
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-act="ctl"]');
    if (!b) return;
    map.closePopup();
    setControl(b.dataset.name, b.dataset.side);
  });

  function zoneToggles(idx) {
    return `<div class="zone-toggles">` + Object.entries(ZONES).map(([key, z]) =>
      `<label class="switch"><input type="checkbox" data-zone="${key}" data-cp="${idx}"${zoneLayers.has(`${idx}:${key}`) ? ' checked' : ''}>` +
      `<span class="zone-swatch" style="--c:${z.style.color}"></span><span>${z.label} · ${fmtRadius(zoneRadius(CONFLICT_POINTS[idx], key))}</span></label>`).join('') + `</div>`;
  }

  function setZone(idx, key, on) {
    const id = `${idx}:${key}`, c = CONFLICT_POINTS[idx], z = ZONES[key];
    if (!c || !z) return;
    if (on && !zoneLayers.has(id)) {
      const circle = L.circle(toLL(c.xz), { radius: zoneRadius(c, key), interactive: false, ...z.style });
      zoneLayers.set(id, circle);
      refLayers.conflict.addLayer(circle); // hidden along with the Conflict layer
    } else if (!on && zoneLayers.has(id)) {
      refLayers.conflict.removeLayer(zoneLayers.get(id));
      zoneLayers.delete(id);
    }
  }
  document.addEventListener('change', e => {
    const cb = e.target.closest('input[data-zone]');
    if (cb) setZone(+cb.dataset.cp, cb.dataset.zone, cb.checked);
  });
  const searchIndex = []; // static entries: {name, sub, xz, open}

  function dot(xz, color, radius, htmlFn) {
    const m = L.circleMarker(toLL(xz), { radius, color: '#111', weight: 1.5, fillColor: color, fillOpacity: 0.95, bubblingMouseEvents: false });
    bindInfo(m, htmlFn, () => xz);
    return m;
  }
  function glyphMarker(xz, ch, color, cls, htmlFn) {
    const m = L.marker(toLL(xz), { icon: glyphIcon(ch, color, cls), keyboard: false });
    bindInfo(m, htmlFn, () => xz);
    return m;
  }
  function addSearch(name, sub, xz, html) {
    searchIndex.push({ name, sub, xz, key: norm(`${name} ${sub}`), html });
  }

  function buildReference(d) {
    const g = key => (refLayers[key] = L.layerGroup());

    // A town name with a Conflict base badge on it moves just clear of the badge: above it when the base is south of the
    // name, below when it is north. --bd is the base's distance north or south in pixels at zoom 0; app.css scales it by
    // the zoom (--zs), so the name only moves as far as it has to and comes back to its spot once the two part.
    const badgeSide = t => {
      const halfWidth = t.name.length * 50; // about 4 px a character at zoom 0, in metres
      const c = (d.conflict || []).find(c => Math.abs(c.xz[0] - t.xz[0]) < halfWidth && Math.abs(c.xz[1] - t.xz[1]) < 250);
      if (!c) return ['', ''];
      const dz = c.xz[1] - t.xz[1];
      return [dz > 0 ? ' lbl-below' : ' lbl-above', `--bd:${(Math.abs(dz) / SCALE).toFixed(1)}`];
    };
    const towns = g('towns');
    d.towns.forEach(t => {
      const big = t.type === 'Town' || t.type === 'City';
      const [side, style] = badgeSide(t);
      L.marker(toLL(t.xz), { icon: labelIcon(t.name, `lbl-town${big ? ' big' : ''}${side}`, style), interactive: false, keyboard: false }).addTo(towns);
      addSearch(t.name, `Town · ${t.type}`, t.xz, () => popupHtml(t.name, t.type, t.xz));
    });

    const lm = g('landmarks');
    d.landmarks.forEach(t => {
      const water = /Water|Bay/.test(t.type);
      L.marker(toLL(t.xz), { icon: labelIcon(t.name, `lbl-landmark${water ? ' lbl-water' : ''}`), interactive: false, keyboard: false }).addTo(lm);
      addSearch(t.name, `Landmark · ${t.type}`, t.xz, () => popupHtml(t.name, t.type, t.xz));
    });

    const caves = g('caves');
    d.caves.forEach(c => {
      const html = () => popupHtml(c.name, `${c.kind} · approx. 100 m square`, c.xz, `<p>${esc(c.note)}</p>`);
      glyphMarker(c.xz, c.kind === 'Cave' ? '◖' : c.kind === 'Bunker' ? '▼' : '⌂', C.cave, 'poi', html).addTo(caves);
      L.marker(toLL(c.xz), { icon: labelIcon(c.name, 'lbl-cave'), interactive: false, keyboard: false }).addTo(caves);
      addSearch(c.name, c.kind, c.xz, html);
    });

    // Base labels are skipped when the base simply carries its town's name - the town label already says it.
    const simple = s => norm(s).replace(/[^a-z]/g, '');
    const townNames = new Set(d.towns.map(t => simple(t.name)));
    const cf = g('conflict');
    d.conflict.forEach((c, idx) => {
      const [color, ch] = CONFLICT_STYLE[c.kind] || ['#ccc', '?'];
      const sub = `${c.kind}${c.control ? ' · Control point' : ''}`;
      CONFLICT_POINTS[idx] = c;
      const html = () => popupHtml(c.name, sub, c.xz, controlButtons(c.name) + radioSummary(idx) + zoneToggles(idx));
      glyphMarker(c.xz, ch, color, `poi${c.control ? ' control' : ''}`, html).addTo(cf);
      if (!townNames.has(simple(c.name))) {
        L.marker(toLL(c.xz), { icon: labelIcon(c.name, 'lbl-conflict'), interactive: false, keyboard: false }).addTo(cf);
      }
      addSearch(c.name, `Conflict · ${sub}`, c.xz, html);
    });

    // Radio network: link every pair of Conflict points where at least one is in the other's radio range.
    const radio = g('radio');
    d.radio = [];
    d.conflict.forEach((a, i) => d.conflict.forEach((b, j) => {
      if (j <= i) return;
      const dd = dist(a.xz, b.xz), ra = radioRange(a), rb = radioRange(b);
      if (dd > Math.max(ra, rb)) return;
      const mutual = dd <= Math.min(ra, rb);
      RADIO_LINKS[i].push({ j, mutual }); RADIO_LINKS[j].push({ j: i, mutual });
      d.radio.push([i, j]);
      L.polyline([toLL(a.xz), toLL(b.xz)], mutual
        ? { color: '#f1f3f5', weight: 1.6, opacity: 0.7, interactive: false }
        : { color: '#66d9e8', weight: 1.6, opacity: 0.8, dashArray: '5 6', interactive: false }).addTo(radio);
    }));

    cf.addLayer(controlLayer); // who holds each point, drawn under the base markers (see syncControl)

    // Radio masts: the relay radio towers on their own, each with the 3 km it reaches.
    const masts = g('masts');
    d.conflict.forEach(c => {
      if (c.kind !== 'Radio tower') return;
      const html = () => popupHtml(c.name, 'Radio tower · relay', c.xz, controlButtons(c.name) + `<p class="sub">Radio range ${fmtRadius(radioRange(c))}</p>`);
      masts.addLayer(L.circle(toLL(c.xz), { radius: radioRange(c), interactive: false, ...ZONES.radio.style }));
      glyphMarker(c.xz, CONFLICT_STYLE['Radio tower']?.[1] || '▲', CONFLICT_STYLE['Radio tower']?.[0] || '#e599f7', 'poi', html).addTo(masts);
    });

    const mob = g('mob');
    d.mob.forEach(m => {
      const html = () => popupHtml(m.name, 'Possible HQ / MOB start position', m.xz);
      glyphMarker(m.xz, '⚑', C.mob, 'poi', html).addTo(mob);
      addSearch(m.name, 'Conflict · HQ start position', m.xz, html);
    });

    const sup = g('supplies');
    d.supplies.forEach(s => dot(s.xz, C.supply, 5, () => popupHtml('Supply stash', `${s.amount} supplies · ${s.access} access`, s.xz)).addTo(sup));
    // The stashes that never run out, on their own layer so they're easy to find.
    const inf = g('infinite');
    d.supplies.filter(s => s.amount === 'Infinite').forEach(s =>
      glyphMarker(s.xz, '∞', C.supply, 'poi', () => popupHtml('Infinite supply point', `Never runs out · ${s.access} access`, s.xz)).addTo(inf));
    const veh = g('vehicles');
    d.vehicles.forEach(v => dot(v.xz, C.vehicle, 4.5, () => popupHtml('Vehicle spawn', '', v.xz)).addTo(veh));
    const fuel = g('refuel');
    d.refuel.forEach(v => dot(v.xz, C.fuel, 6, () => popupHtml('Refuel point', '', v.xz)).addTo(fuel));
    const rep = g('repair');
    d.repair.forEach(v => dot(v.xz, C.repair, 6, () => popupHtml('Repair point', '', v.xz)).addTo(rep));
    // Fuel stations: from the game's own map symbols (places.json), so every map has them.
    const fs = g('fuelStations');
    d.fuelStations.forEach(v => glyphMarker(v.xz, 'F', C.fuel, 'poi', () => popupHtml(v.name || 'Fuel station', v.name ? 'Fuel station' : '', v.xz)).addTo(fs));

    const fia = g('fia');
    FIA_KNOWN = d.fia;
    d.fia.forEach(f => {
      const html = () => {
        const owner = fiaOwner(f.name);
        const action = owner
          ? `<p class="sub">Marked for this game by ${esc(owner)}.</p>`
          : `<div class="row"><button class="primary" data-act="fia-add" data-name="${esc(f.name)}">Mark as this game's cache</button></div>`;
        return popupHtml(`FIA cache: ${f.name}`, 'Possible hidden cache spot (Conflict)', f.xz, action);
      };
      glyphMarker(f.xz, '◆', C.fia, 'poi', html).addTo(fia);
      addSearch(f.name, 'FIA hidden cache', f.xz, html);
    });
    g('roads');
    g('paths');
    g('fiaGame');
    d.fiaGame = []; // counted live in the layer list
    syncControl();
    refLayers.contours = contourLayer;
    refLayers.hillshade = hillshadeLayer;
    refLayers.forest = forestLayer;
    refLayers.lzs = { addTo() { lzShadeOn = true; syncLzShade(); }, remove() { lzShadeOn = false; syncLzShade(); } };
    refLayers.coverage = coverageLayer;

    // Layer checkboxes, each showing the icon it puts on the map. A layer this map has no data for is left out (and a
    // group heading with nothing under it), and so is the FIA section when the map has no cache spots.
    $('.acc[data-sec="fia"]').classList.toggle('hidden', !d.fia.length);
    let group = null;
    const groupsShown = new Set();
    LAYER_DEFS.forEach(def => {
      const box = $(def.box || '#layers');
      if (def.group) group = def.group;
      const count = def.countText ?? (def.countFn ? def.countFn(d) : d[def.key].length);
      if (count === 0 && !def.dynamic) return;
      if (!def.box && group && !groupsShown.has(group)) {
        groupsShown.add(group);
        box.insertAdjacentHTML('beforeend', `<div class="layer-group-title">${group}</div>`);
      }
      const row = document.createElement('label');
      row.className = 'layer';
      row.innerHTML = `<input type="checkbox" ${def.on ? 'checked' : ''}><span class="lg">${def.icon}</span><span class="lbl">${def.label}</span>` +
        `<span class="n"${def.dynamic ? ` id="${def.key}-n"` : ''}>${count}</span>`;
      const cb = row.querySelector('input');
      cb.addEventListener('change', () => cb.checked ? refLayers[def.key].addTo(map) : refLayers[def.key].remove());
      box.appendChild(row);
      if (def.legendHtml) box.insertAdjacentHTML('beforeend', def.legendHtml);
      if (def.legend) {
        box.insertAdjacentHTML('beforeend', `<div class="legend-key">` +
          Object.values(CONFLICT_STYLE).map(([color, ch, name]) => `<div>${badge(ch, color)}${name}</div>`).join('') +
          `<div><span class="lg-badge ctl" style="--c:#aab4bd">·</span>Control point</div></div>`);
      }
      if (def.on) refLayers[def.key].addTo(map);
    });
  }

  $('#show-grid').addEventListener('change', e => { e.target.checked ? gridLayer.addTo(map) : gridLayer.remove(); updateRulers(); });

  // ---------------------------------------------------------------------------
  // Players & shared markings
  // ---------------------------------------------------------------------------
  const state = {
    me: null,            // {id, token, name, color}
    players: new Map(),  // name -> {name, color, items: Map(id -> item), layers: Map(id -> layer), group}
    showOthers: true,
    tool: 'pan',
    es: null,
  };

  const TYPE_NAME = { marker: 'Marker', route: 'Route', range: 'Range line', mortar: 'Mortar', fia: 'FIA caches', control: 'Point control', emplacement: 'MG nest', construct: 'Construct',
    arrow: 'Arrow', ambush: 'Ambush', post: 'Range card', sectors: 'Sectors of fire', overwatch: 'Overwatch', aa: 'Enemy AA gun', hulldown: 'Hull-down finder', audible: 'Who can hear it' };
  // "wall" is the sandbag line (the original name, kept so older exported plans still import).
  const CONSTRUCT_NAME = Object.fromEntries(Object.entries(window.ConstructionCatalog).filter(([, v]) => v.type === 'construct').map(([k, v]) => [k, v.name]));
  const emplacementName = it => window.ConstructionCatalog[it.kind]?.name || 'MG nest';
  const POINT_CONSTRUCTS = ['bunker', 'checkpoint']; // one click drops them
  const LINE_CONSTRUCTS = ['wall', 'wire', 'roadblock']; // drawn point by point (roadblock = a line of tank traps)
  const typeLabel = it => (it.type === 'construct' ? CONSTRUCT_NAME[it.kind]
    : it.type === 'emplacement' ? emplacementName(it)
    : it.type === 'marker' && it.icon === 'infantry' ? (it.unit === 'arm' ? 'Armour position' : 'Infantry position')
    : it.type === 'marker' && UNITS[it.icon] ? UNITS[it.icon]
    : it.type === 'marker' && it.icon === 'trp' ? 'Reference point (TRP)'
    : it.type === 'marker' && it.icon === 'contact' ? 'Contact report'
    : it.type === 'marker' && it.icon === 'lz' ? 'Landing zone'
    : it.type === 'marker' && HAZARDS[it.icon] ? HAZARDS[it.icon]
    : it.type === 'marker' && MARKER_TOOLS[it.icon] ? MARKER_TOOLS[it.icon]
    : it.type === 'arrow' ? ARROWS[it.kind]?.name
    : it.type === 'post' ? (POST_KIND[it.side] || POST_KIND.f).name
    : it.type === 'ambush' ? (it.kind === 'l' ? 'L-shaped ambush' : 'Linear ambush')
    : it.type === 'area' && it.kind === 'fire' ? `${(FIRE[it.fire] || FIRE.he).name} fire request (area)`
    : it.type === 'marker' && it.icon === 'fire-point' ? `${(FIRE[it.fire] || FIRE.he).name} fire request (point)`
    : it.type === 'area' && it.kind === 'cas' ? 'Gun run (CAS), area'
    : it.type === 'area' ? 'Enemy in area'
    : it.type === 'marker' && it.icon === 'radio' ? 'Radio backpack'
    : it.type === 'marker' && it.icon === 'aa-f' ? 'Friendly AA gun'
    : airKey(it) ? AIR[airKey(it)].name
    : it.type === 'aa' ? 'Enemy AA gun'
    : it.type === 'marker' && MINES[it.icon] ? MINES[it.icon]
    : TYPE_NAME[it.type]) || 'Marking';
  const LINE_STYLE = { wall: '#c8b27c', wire: '#d8c48a', roadblock: '#aab4bd', 'enemy-area': '#ff5c5c', advance: '#4dabf7', 'enemy-approach': '#ff5c5c', patrol: '#ffa94d' };
  // Drawn arrows: the draw tool that makes them, and how each kind looks.
  const ARROWS = {
    advance: { tool: 'advance', name: 'Our advance', color: '#4dabf7', weight: 5, dash: null },
    enemy: { tool: 'enemy-approach', name: 'Enemy approach', color: '#ff5c5c', weight: 4, dash: '10 8' },
    patrol: { tool: 'patrol', name: 'Enemy patrol route', color: '#ffa94d', weight: 3, dash: '3 7' },
    flight: { tool: 'heli-route', name: 'Flight route', color: '#74c0fc', weight: 3.5, dash: '12 7' },
  };
  const ARROW_OF_TOOL = { advance: 'advance', 'enemy-approach': 'enemy', patrol: 'patrol' };
  const HAZARDS = { sniper: 'Sniper', blocked: 'Blocked or mined road', bridge: 'Bridge out', 'enemy-ambush': 'Enemy roadblock / ambush' };
  // Freehand areas: where the enemy is, and where we want fire (HE, smoke or illumination).
  const isEnemyArea = it => it.type === 'area' && (it.kind || 'enemy') === 'enemy';
  const isFireArea = it => it.type === 'area' && it.kind === 'fire';
  const isFirePoint = it => it.type === 'marker' && it.icon === 'fire-point';
  const isFireReq = it => isFireArea(it) || isFirePoint(it);
  const FIRE = {
    he: { name: 'HE', color: '#ff922b', shell: /^HE/ },
    smoke: { name: 'Smoke', color: '#dee2e6', shell: /^Smoke/ },
    illum: { name: 'Illumination', color: '#ffe066', shell: /^Illum/ },
  };
  // Radio backpack: players can spawn on it only while no enemy is within this distance.
  const RADIO_CLEAR = 50;
  // Air support requests: a pin with a short form. Anyone in the room can move a request on (acknowledged, en route,
  // complete), so the pilot can answer it. Pickups and medevacs get the landing zone check; gun runs warn about
  // friendlies within danger-close distance of the target.
  const HEADINGS = [['', 'Any direction'], ['0', 'From the north'], ['45', 'From the north-east'], ['90', 'From the east'], ['135', 'From the south-east'],
    ['180', 'From the south'], ['225', 'From the south-west'], ['270', 'From the west'], ['315', 'From the north-west']];
  const SMOKE_MARKS = ['Nothing', 'Red smoke', 'Green smoke', 'Yellow smoke', 'Purple smoke', 'White smoke', 'Chemlight'];
  const AIR = {
    'air-cas': { name: 'Gun run (CAS)', short: 'CAS', badge: 'CAS', color: '#ff922b', where: 'target is',
      fields: [['target', 'Target'], ['dir', 'Attack', HEADINGS]] },
    'air-medevac': { name: 'Medevac', short: 'Medevac', badge: '✚', color: '#ff6b6b', where: 'casualties are to be picked up', lz: true,
      fields: [['patients', 'Casualties', ['1', '2', '3', '4', '5', '6+']], ['urgency', 'Urgency', ['Urgent', 'Priority', 'Routine']],
        ['secure', 'Pickup zone', ['Secure', 'Possible enemy', 'Enemy in the area']], ['mark', 'Marked with', SMOKE_MARKS]] },
    'air-pickup': { name: 'Pickup / insertion', short: 'Pickup', badge: 'PU', color: '#74c0fc', where: 'troops are to be picked up or dropped', lz: true,
      fields: [['task', 'Task', ['Pickup', 'Insertion']], ['seats', 'Seats', ['1', '2', '3', '4', '5', '6', '7', '8', '10', '12+']], ['mark', 'Marked with', SMOKE_MARKS]] },
    'air-supply': { name: 'Resupply drop', short: 'Resupply', badge: 'SUP', color: '#8ce99a', where: 'supplies are needed',
      fields: [['needs', 'What is needed']] },
  };
  const AIR_STATUS = {
    requested: { name: 'Requested' }, ack: { name: 'Acknowledged' }, enroute: { name: 'En route' }, done: { name: 'Complete' },
  };
  const DANGER_CLOSE = 100; // metres from a gun run's target that counts as danger close
  // Which kind of air request a marking is: a pin (marker) or, for gun runs, also a freehand target area.
  const airKey = it => (it.type === 'marker' && AIR[it.icon] ? it.icon : it.type === 'area' && it.kind === 'cas' ? 'air-cas' : null);
  const MARKER_TOOLS = { rally: 'Rally point', objective: 'Objective', danger: 'Danger' }; // markers with their own tool
  const TTL_OPTIONS = [[0, 'Never'], [5, '5 min'], [15, '15 min'], [30, '30 min']]; // unit / contact timeouts, minutes
  // Range cards (f) and the enemy's views: a crouched soldier (e) or a vehicle's sights about 2 m up (v).
  // eye = eye height above the ground in metres.
  const POST_KIND = {
    f: { name: 'Range card', label: 'Range card', eye: 1.0, who: 'a crouched observer' },
    e: { name: 'Enemy line of sight', label: 'Enemy view', eye: 1.0, who: 'a crouched enemy' },
    v: { name: 'Enemy vehicle line of sight', label: 'Enemy vehicle view', eye: 2.0, who: "an enemy vehicle's sights" },
    fv: { name: 'Friendly armour', label: 'Armour', eye: 2.0, who: "a vehicle's sights" },
  };
  const OUR_SIDES = new Set(['f', 'fv']); // range cards and our vehicles' views
  const isOurPost = it => it.type === 'post' && OUR_SIDES.has(it.side || 'f');
  const isEnemyPost = it => it.type === 'post' && !isOurPost(it);
  // A player's own position marker can carry a range card too (range > 0).
  const isPositionCard = it => it.type === 'marker' && it.icon === 'infantry' && it.range > 0;
  const isRangeCard = it => isOurPost(it) || isPositionCard(it);
  const cardName = (p, it) => (isPositionCard(it) ? `${p.name}'s position` : it.label || 'Range card');
  // Markers with their own symbol, whose type isn't picked in the editor
  const FIXED_ICONS = new Set(['infantry', 'trp', 'contact', 'lz', 'radio', 'fire-point', 'aa-f', 'air-cas', 'air-medevac', 'air-pickup', 'air-supply']);
  const UNITS = { 'unit-inf-f': 'Friendly infantry', 'unit-arm-f': 'Friendly armour', 'unit-inf-e': 'Enemy infantry', 'unit-arm-e': 'Enemy armour' };
  const ENEMY = '#ff5c5c', FRIENDLY = '#6cb8ff';
  function unitSvg(kind, side, me = false) {
    if (side === 'f') {
      const sym = kind === 'inf' ? '<path class="sym" d="M1 1L31 21M31 1L1 21"/>' : '<ellipse class="sym" cx="16" cy="11" rx="8.5" ry="4.8"/>';
      return `<svg class="unit-svg friend${me ? ' me' : ''}" viewBox="0 0 32 22"><rect class="frame" x="1" y="1" width="30" height="20"/>${sym}</svg>`;
    }
    const sym = kind === 'inf' ? '<path class="sym" d="M8.25 8.25L21.75 21.75M21.75 8.25L8.25 21.75"/>' : '<ellipse class="sym" cx="15" cy="15" rx="7" ry="4"/>';
    return `<svg class="unit-svg enemy" viewBox="0 0 30 30"><path class="frame" d="M15 1.5L28.5 15 15 28.5 1.5 15z"/>${sym}</svg>`;
  }
  // Polygon area in square metres (shoelace) - points are already in metres.
  const polyArea = pts => Math.abs(pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
  const fmtArea = m2 => m2 >= 1e6 ? `${(m2 / 1e6).toFixed(2)} km²` : m2 >= 1e4 ? `${(m2 / 1e4).toFixed(1)} ha` : `${Math.round(m2)} m²`;
  const GLYPH = { dot: '', enemy: '✖', objective: '★', rally: '⚑', vehicle: '▣', danger: '!' };
  const MINES = { 'mine-at': 'AT minefield', 'mine-ap': 'AP minefield' };
  const AT_KILL_RADIUS = 10; // metres, drawn around every AT mine marker
  const positionOf = p => p && [...p.items.values()].find(i => i.type === 'marker' && i.icon === 'infantry');
  const myPosition = () => state.me && positionOf(state.players.get(state.me.name));
  // Players whose position line of sight is switched off on this page (remembered in this browser only).
  const LOS_OFF_KEY = 'everon-map-los-off';
  let losOff;
  try { losOff = new Set(JSON.parse(localStorage.getItem(LOS_OFF_KEY) || '[]')); } catch { losOff = new Set(); }
  const showsPosLos = (p, it) => isPositionCard(it) && !losOff.has(p.name);
  function fmtAgo(ms) {
    const m = Math.floor(ms / 60000);
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
  }
  const mineIcon = icon => L.divIcon({
    className: `mine-glyph ${icon}`, iconSize: [0, 0],
    html: `<div><span>${icon === 'mine-at' ? 'AT' : 'AP'}</span></div>`,
  });
  // Your markings, grouped in toolbar order; each group carries its toolbar menu's colour.
  const isMarker = (it, ...icons) => it.type === 'marker' && icons.includes(it.icon);
  const GROUPED_ICONS = new Set(['infantry', 'unit-inf-f', 'unit-arm-f', 'rally', 'objective', 'contact', 'unit-inf-e', 'unit-arm-e',
    'sniper', 'enemy', 'enemy-ambush', 'trp', 'mine-at', 'mine-ap', 'blocked', 'bridge', 'danger', 'lz', 'radio', 'fire-point', 'aa-f', 'air-cas', 'air-medevac', 'air-pickup', 'air-supply']);
  const MINE_GROUPS = [
    { cat: 'friendly', name: 'My position', test: it => isMarker(it, 'infantry') },
    { cat: 'friendly', name: 'Friendly units', test: it => isMarker(it, 'unit-inf-f', 'unit-arm-f') || (it.type === 'post' && it.side === 'fv') },
    { cat: 'friendly', name: 'Rally points & objectives', test: it => isMarker(it, 'rally', 'objective') },
    { cat: 'friendly', name: 'Radio backpacks', test: it => isMarker(it, 'radio') },
    { cat: 'friendly', name: 'Friendly AA', test: it => isMarker(it, 'aa-f') },
    { cat: 'friendly', name: 'Mortar', test: it => it.type === 'mortar' },
    { cat: 'friendly', name: 'Advance arrows', test: it => it.type === 'arrow' && it.kind === 'advance' },
    { cat: 'enemy', name: 'Contacts', test: it => isMarker(it, 'contact') },
    { cat: 'enemy', name: 'Enemy units', test: it => isMarker(it, 'unit-inf-e', 'unit-arm-e', 'sniper', 'enemy', 'enemy-ambush') },
    { cat: 'enemy', name: 'Enemy in area', test: isEnemyArea },
    { cat: 'enemy', name: 'Enemy movement', test: it => it.type === 'arrow' && (it.kind === 'enemy' || it.kind === 'patrol') },
    { cat: 'enemy', name: 'Enemy AA', test: it => it.type === 'aa' },
    { cat: 'enemy', name: 'Enemy line of sight', test: isEnemyPost },
    { cat: 'plan', name: 'Markers', test: it => it.type === 'marker' && !GROUPED_ICONS.has(it.icon) },
    { cat: 'plan', name: 'Routes', test: it => it.type === 'route' },
    { cat: 'plan', name: 'Ambushes', test: it => it.type === 'ambush' },
    { cat: 'plan', name: 'Range lines', test: it => it.type === 'range' },
    { cat: 'plan', name: 'Overwatch', test: it => it.type === 'overwatch' },
    { cat: 'plan', name: 'Hull-down', test: it => it.type === 'hulldown' },
    { cat: 'plan', name: 'Who can hear it', test: it => it.type === 'audible' },
    { cat: 'plan', name: 'Flight routes', test: it => it.type === 'arrow' && it.kind === 'flight' },
    { cat: 'plan', name: 'Landing zones', test: it => isMarker(it, 'lz') },
    { cat: 'support', name: 'Fire support requests', test: isFireReq },
    { cat: 'support', name: 'Air support requests', test: it => !!airKey(it) },
    { cat: 'defend', name: 'Range cards', test: it => isOurPost(it) && it.side !== 'fv' },
    { cat: 'defend', name: 'Reference points', test: it => isMarker(it, 'trp') },
    { cat: 'defend', name: 'Sectors of fire', test: it => it.type === 'sectors' },
    { cat: 'defend', name: 'Gun emplacements', test: it => it.type === 'emplacement' },
    { cat: 'defend', name: 'Fortifications', test: it => it.type === 'construct' },
    { cat: 'hazards', name: 'Minefields', test: it => isMarker(it, 'mine-at', 'mine-ap') },
    { cat: 'hazards', name: 'Hazards', test: it => isMarker(it, 'blocked', 'bridge', 'danger') },
    { cat: 'intel', name: 'FIA caches', test: it => it.type === 'fia' },
    { cat: 'intel', name: 'Point control', test: it => it.type === 'control' },
  ];
  const CAT_COLOR = { friendly: '#6cb8ff', enemy: '#ff6b6b', plan: '#c8d96f', defend: '#c8b27c', hazards: '#ffc53d', support: '#ff922b', intel: '#f783ac' };

  async function api(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
    return data;
  }
  const itemWrites = PlanSync.writer();
  const saveItem = item => {
    const me = state.me;
    if (!me) return Promise.resolve(false);
    item = JSON.parse(JSON.stringify(item));
    planBackup.stage(me, item);
    writeKept(); // preserve a new marking even if navigation beats its stream echo
    return itemWrites(me, item.id, () => api('/api/item', { id: me.id, token: me.token, item }))
      .then(() => true).catch(e => { toast(e.message); return false; });
  };
  const deleteItem = itemId => {
    const me = state.me;
    if (!me) return Promise.resolve();
    planBackup.remove(me, itemId);
    writeKept();
    return itemWrites(me, itemId, () => api('/api/delete', { id: me.id, token: me.token, itemId })).catch(e => toast(e.message));
  };

  const isMine = name => state.me && name === state.me.name;

  function getPlayer(name, color) {
    let p = state.players.get(name);
    if (!p) {
      p = { name, color, items: new Map(), layers: new Map(), group: L.layerGroup() };
      state.players.set(name, p);
      if (isMine(name) || state.showOthers) p.group.addTo(map);
    }
    if (color) p.color = color;
    return p;
  }

  function removePlayer(name) {
    const p = state.players.get(name);
    if (!p) return;
    p.group.remove();
    state.players.delete(name);
  }

  function itemSummary(it) {
    if (it.type === 'route') { const rc = routeCheck(it.points); return `${fmtDist(pathLength(it.points))}${rc ? ` · ${fmtTime(rc.walk)}` : ''}`; }
    if (it.type === 'overwatch') { const los = overwatchLos(it.xz, it.range); return `${fmtDist(it.range)}${los ? ` · ${los.pct}% clear` : ''}`; }
    if (it.type === 'hulldown') return `${fmtDist(it.range)} · ${hullOf(it).short}`;
    if (it.type === 'audible') return `heard ${fmtDist(gunOf(it).range)}`;
    if (isMarker(it, 'lz')) { const c = lzCheck(it.xz); return c ? LZ_WORD[c.verdict] : grid(it.xz); }
    if (it.type === 'range') return `${fmtDist(dist(it.from, it.to))} · ${pad(Math.round(bearing(it.from, it.to)) % 360, 3)}°`;
    if (it.type === 'mortar') return `${it.weapon} · ${(it.targets || []).length} target${(it.targets || []).length === 1 ? '' : 's'}`;
    if (it.type === 'fia') return `${it.caches.length} cache${it.caches.length === 1 ? '' : 's'}`;
    if (it.type === 'control') { const n = Object.keys(it.marks || {}).length; return `${n} point${n === 1 ? '' : 's'}`; }
    if (it.type === 'emplacement') return `${pad(Math.round(it.dir) % 360, 3)}° · ${it.arc}° · ${fmtDist(it.range)}${it.height ? ` · +${it.height} m` : ''}`;
    if (it.type === 'construct') return it.points ? fmtDist(pathLength(it.points)) : grid(it.xz);
    if (isFireReq(it)) return `${(FIRE[it.fire] || FIRE.he).name} ${it.points ? 'area' : 'point'} · ${fmtAgo(Date.now() - (it.at || Date.now()))}`;
    if (airKey(it)) return `${AIR_STATUS[it.status || 'requested'].name} · ${fmtAgo(Date.now() - (it.at || Date.now()))}`;
    if (it.type === 'area') return fmtArea(polyArea(it.points));
    if (isMarker(it, 'radio')) { const b = radioBlockers(it.xz); return b.length ? 'Spawn blocked' : grid(it.xz); }
    if (it.type === 'aa') return `${pad(Math.round(it.dir) % 360, 3)}° · ${it.arc}° · ${fmtDist(it.range)}`;
    if (it.type === 'arrow') return fmtDist(pathLength(it.points));
    if (it.type === 'ambush') return fmtDist(dist(it.from, it.to));
    if (it.type === 'sectors') return `${it.n} × ${fmtDist(it.radius)}`;
    if (it.type === 'post' || isPositionCard(it)) { const los = postLos(it); return `${fmtDist(it.range)}${los ? ` · sees ${los.pct}%` : ''}`; }
    if (it.type === 'marker' && it.icon === 'contact') return fmtAgo(Date.now() - (it.at || Date.now()));
    return grid(it.xz);
  }
  function itemAnchor(it) {
    if (it.type === 'ambush') return [(it.from[0] + it.to[0]) / 2, (it.from[1] + it.to[1]) / 2];
    if (it.type === 'arrow') return it.points[it.points.length - 1];
    if (it.type === 'post' || it.type === 'sectors' || it.type === 'overwatch' || it.type === 'hulldown' || it.type === 'aa' || it.type === 'audible') return it.xz;
    if (it.type === 'construct') return it.points ? it.points[0] : it.xz;
    if (it.type === 'area') return it.points[0];
    if (it.type === 'fia') return (FIA_KNOWN.find(f => f.name === it.caches[0]) || { xz: [6400, 6400] }).xz;
    if (it.type === 'control') return (CONFLICT_POINTS.find(c => c && c.name === Object.keys(it.marks || {})[0]) || { xz: [WORLD / 2, WORLD / 2] }).xz;
    return it.type === 'marker' || it.type === 'mortar' || it.type === 'emplacement' ? it.xz : it.type === 'range' ? it.from : it.points[0];
  }

  function itemPopup(owner, it) {
    let extra = '';
    if (it.type === 'route') {
      const legs = it.points.slice(1).map((p, i) => `<div>Leg ${i + 1}: ${fmtDist(dist(it.points[i], p))} · ${fmtBearing(bearing(it.points[i], p))}</div>`).join('');
      if (it.plan) extra += `<p class="sub">Planned ${fmtAgo(Date.now() - (it.plan.at || Date.now()))}; re-plans when enemies change.</p>`;
      const overM = it.plan && it.plan.mode === 'vehicle' ? steepRuns(it.points, it.steep).reduce((m, run) => m + pathLength(run), 0) : 0;
      if (overM) extra += `<p><b class="rc-no">Over ${SLOPE_LIMIT_DEG}° for ${fmtDist(overM)}</b> <span class="sub">(red) · no other way through</span></p>`;
      extra += `<p><b>${fmtDist(pathLength(it.points))}</b> over ${it.points.length - 1} leg${it.points.length > 2 ? 's' : ''}</p>` +
        routeCheckHtml(routeCheck(it.points)) + `<details class="legs"><summary>Legs</summary><div class="sub">${legs}</div></details>`;
    }
    if (it.type === 'range' && it.rocket) {
      extra += `<p><b>${fmtDist(dist(it.from, it.to))}</b> · ${fmtBearing(bearing(it.from, it.to))}</p><div class="sub">To grid ${grid(it.to)}</div>` +
        rocketHtml(owner, it) + `<details class="legs"><summary>Line of sight</summary>${sightHtml(sightProfile(it.from, it.to, it.h1 ?? 1.6, it.h2 ?? 1))}</details>`;
    } else if (it.type === 'range') {
      extra += `<p><b>${fmtDist(dist(it.from, it.to))}</b> · ${fmtBearing(bearing(it.from, it.to))}</p><div class="sub">To grid ${grid(it.to)}</div>` +
        sightHtml(sightProfile(it.from, it.to, it.h1 ?? 1.6, it.h2 ?? 1.6)) +
        (isMine(owner) ? `<button type="button" class="rk-add" data-rk-add data-id="${esc(it.id)}">Shot calculator</button>` : '');
    }
    if (it.type === 'mortar') extra += mortarInfoHtml(it);
    if (it.type === 'marker' && it.icon === 'infantry' && it.at) extra += `<p class="sub">Updated ${fmtAgo(Date.now() - it.at)}</p>`;
    if (it.type === 'marker' && UNITS[it.icon] && it.at) extra += `<p class="sub">Marked ${fmtAgo(Date.now() - it.at)} · ${timeoutText(it)}</p>`;
    if (isFireReq(it)) extra += fireHtml(it, owner);
    else if (it.type === 'area') {
      const ring = [...it.points, it.points[0]];
      extra += `<p><b>${fmtArea(polyArea(it.points))}</b> · perimeter ${fmtDist(pathLength(ring))}</p>`;
      if (it.at) extra += `<p class="sub">Marked ${fmtAgo(Date.now() - it.at)}</p>`;
    }
    if (isMarker(it, 'radio')) extra += radioHtml(owner, it);
    if (it.type === 'aa') extra += aaHtml(it);
    if (airKey(it)) extra += airHtml(owner, it);
    if (it.type === 'arrow' && it.kind === 'flight') extra += flightHtml(flightCheck(it.points));
    if (it.type === 'emplacement') {
      extra += `<div class="stats">` +
        `<div><span class="k">Facing</span><span class="v">${pad(Math.round(it.dir) % 360, 3)}°</span></div>` +
        `<div><span class="k">Arc</span><span class="v">${it.arc}°</span></div>` +
        `<div><span class="k">Range</span><span class="v">${fmtDist(it.range)}</span></div></div>`;
      const los = fieldOfFireLos(it.xz, it.dir, it.arc, it.range, true, gunEye(it.height));
      if (it.height) extra += `<p class="sub">Raised ${it.height} m</p>`;
      if (los) extra += `<p><b>Sees ${los.pct}%</b> of its field of fire${los.treePct ? `, ${los.treePct}% more only through trees` : ''}</p>` +
        `<p class="sub">Dark: dead ground · yellow: through trees</p>`;
    }
    if (it.type === 'marker' && it.icon === 'mine-at') extra += `<p class="sub">Shaded circle: ${AT_KILL_RADIUS} m kill radius</p>`;
    extra += planPopupHtml(owner, it);
    if (it.note) extra += `<p>${esc(it.note).replace(/\n/g, '<br>')}</p>`;
    if (isMine(owner)) {
      const flip = it.type === 'ambush' ? `<button data-act="flip" data-id="${esc(it.id)}" title="Put the squad on the other side of the kill zone">Flip side</button>` : '';
      extra += `<div class="row"><button data-act="edit" data-id="${esc(it.id)}">Edit</button>${flip}<button class="danger" data-act="delete" data-id="${esc(it.id)}">Delete</button></div>`;
    }
    const xz = itemAnchor(it);
    if (it.type === 'construct' && it.points) extra += `<p><b>${fmtDist(pathLength(it.points))}</b> long</p>`;
    return popupHtml(it.label || typeLabel(it), `${typeLabel(it)} · by ${owner}${isMine(owner) ? ' (you)' : ''}`, xz, extra);
  }

  // A marking being dragged isn't redrawn until it's dropped (a redraw would drop the marker from under the mouse).
  const dragging = { id: null, pending: null };
  function renderItem(p, it) {
    if (dragging.id === it.id) { dragging.pending = [p, it]; return; }
    try { drawItem(p, it); } catch (err) { console.warn('Could not draw a marking', it && it.id, err); }
  }
  const dragStart = id => { map.closePopup(); dragging.id = id; dragging.pending = null; };
  function dragEnd() {
    const pend = dragging.pending;
    dragging.id = null; dragging.pending = null;
    if (pend) renderItem(...pend);
  }
  function drawItem(p, it) {
    const old = p.layers.get(it.id);
    if (old) p.group.removeLayer(old);
    const color = it.color || p.color;
    const tagText = it.label ? (isMine(p.name) ? it.label : `${it.label} (${p.name})`) : (isMine(p.name) ? '' : p.name);
    const html = () => itemPopup(p.name, p.items.get(it.id) || it);
    const layer = L.featureGroup();

    if (it.type === 'marker' && it.icon === 'infantry') {
      // A player's own position: friendly infantry with a white frame and their name underneath.
      const m = L.marker(toLL(it.xz), { icon: L.divIcon({ className: 'unit-glyph', iconSize: [0, 0], html: unitSvg(it.unit === 'arm' ? 'arm' : 'inf', 'f', true) }),
        keyboard: false, riseOnHover: true, zIndexOffset: 1000 });
      m.bindTooltip(esc(isMine(p.name) ? `${p.name} (you)` : p.name), { permanent: true, direction: 'bottom', offset: [0, 12], className: 'inf-label' });
      bindInfo(m, html, () => it.xz);
      if (showsPosLos(p, it)) drawRangeRings(layer, it.xz, it.range, color, postRings(it.range));
      layer.addLayer(m);
    } else if (it.type === 'marker' && UNITS[it.icon]) {
      const [, kind, side] = it.icon.split('-');
      const t = timeoutState(it);
      if (t === 'expired') { p.layers.set(it.id, layer); p.group.addLayer(layer); return; } // the owner's page removes it
      const m = L.marker(toLL(it.xz), { icon: L.divIcon({ className: `unit-glyph${t === 'stale' ? ' stale' : ''}`, iconSize: [0, 0], html: unitSvg(kind, side) }),
        keyboard: false, riseOnHover: true, zIndexOffset: side === 'e' ? 600 : 500 });
      const name = it.label || UNITS[it.icon];
      const age = ttlOf(it) ? ` · ${fmtAgo(Date.now() - (it.at || Date.now()))}` : '';
      m.bindTooltip(esc(isMine(p.name) ? name + age : `${name} (${p.name})${age}`), { direction: 'right', offset: [16, 0], className: 'item-label' });
      bindInfo(m, html, () => it.xz);
      layer.addLayer(m);
    } else if (isFireReq(it)) {
      renderFire(p, it, layer, html);
    } else if (isMarker(it, 'radio')) {
      renderRadio(p, it, layer, color, html);
    } else if (isMarker(it, 'aa-f')) {
      const m = L.marker(toLL(it.xz), { icon: L.divIcon({ className: 'empl-glyph aa-glyph', iconSize: [0, 0], html: '<div style="--c:#6cb8ff">AA</div>' }),
        keyboard: false, riseOnHover: true, zIndexOffset: 500 });
      m.bindTooltip(esc(isMine(p.name) ? it.label || 'AA' : `${it.label || 'AA'} (${p.name})`), { direction: 'right', offset: [16, 0], className: 'item-label' });
      bindInfo(m, html, () => it.xz);
      layer.addLayer(m);
    } else if (airKey(it)) {
      renderAir(p, it, layer, html);
    } else if (it.type === 'aa') {
      renderAa(p, it, layer, html);
    } else if (it.type === 'area') {
      const poly = L.polygon(it.points.map(toLL), {
        color: ENEMY, weight: 2, dashArray: '7 5', fillColor: ENEMY, fillOpacity: 0.22, bubblingMouseEvents: false,
      });
      const name = it.label || 'Enemy in area';
      poly.bindTooltip(esc(isMine(p.name) ? name : `${name} (${p.name})`), { permanent: true, direction: 'center', className: 'area-label' });
      bindInfo(poly, html);
      layer.addLayer(poly);
    } else if (it.type === 'marker' && MINES[it.icon]) {
      // Minefields: the symbol says it all, so the name only shows on hover.
      if (it.icon === 'mine-at') {
        layer.addLayer(L.circle(toLL(it.xz), {
          radius: AT_KILL_RADIUS, color: '#ff5c5c', weight: 1.5, dashArray: '4 3', fillColor: '#ff5c5c', fillOpacity: 0.18, interactive: false,
        }));
      }
      const m = L.marker(toLL(it.xz), { icon: mineIcon(it.icon), keyboard: false, riseOnHover: true });
      m.bindTooltip(esc(isMine(p.name) ? it.label || MINES[it.icon] : `${it.label || MINES[it.icon]} (${p.name})`), { direction: 'right', offset: [14, -4], className: 'item-label' });
      bindInfo(m, html, () => it.xz);
      layer.addLayer(m);
    } else if (it.type === 'marker' && it.icon === 'trp') {
      renderTrp(p, it, layer, color, html);
    } else if (it.type === 'marker' && it.icon === 'contact') {
      renderContact(p, it, layer, html);
    } else if (it.type === 'marker' && it.icon === 'lz') {
      renderLz(p, it, layer, html);
    } else if (it.type === 'marker' && HAZARDS[it.icon]) {
      const m = L.marker(toLL(it.xz), { icon: hazardIcon(it.icon), keyboard: false, riseOnHover: true, zIndexOffset: 550 });
      const name = it.label || HAZARDS[it.icon];
      m.bindTooltip(esc(isMine(p.name) ? name : `${name} (${p.name})`), { direction: 'right', offset: [16, 0], className: 'item-label' });
      bindInfo(m, html, () => it.xz);
      layer.addLayer(m);
    } else if (it.type === 'marker') {
      const m = L.marker(toLL(it.xz), { icon: glyphIcon(GLYPH[it.icon] ?? '', color), keyboard: false, riseOnHover: true });
      if (tagText) m.bindTooltip(esc(tagText), { permanent: true, direction: 'right', offset: [12, 0], className: 'item-label' });
      bindInfo(m, html, () => it.xz);
      layer.addLayer(m);
    } else if (it.type === 'route') {
      const lls = it.points.map(toLL), rc = state.showLos ? routeCheck(it.points) : null;
      if (rc) drawExposure(layer, rc);
      const casing = L.polyline(lls, { color: '#000', weight: 6, opacity: 0.45, interactive: false });
      const drive = it.plan && it.plan.mode === 'vehicle'; // a drive: green, red where over the slope limit
      const line = L.polyline(lls, { color: drive ? DRIVE_OK : color, weight: drive ? 4 : 3.5, opacity: 0.95, bubblingMouseEvents: false });
      layer.addLayer(casing).addLayer(line);
      if (drive) steepRuns(it.points, it.steep).forEach(run => layer.addLayer(L.polyline(run.map(toLL), { color: DRIVE_STEEP, weight: 4.5, opacity: 1, lineCap: 'butt', interactive: false })));
      const last = it.points.length - 1;
      it.points.forEach((pt, i) => {
        const v = L.circleMarker(toLL(pt), { radius: i === 0 || i === last ? 5 : 3.5, color: '#000', weight: 1.5, fillColor: color, fillOpacity: 1, bubblingMouseEvents: false });
        bindInfo(v, html, () => pt);
        if (i === last) {
          const endTag = `${tagText ? tagText + ' · ' : ''}${fmtDist(pathLength(it.points))}`;
          v.bindTooltip(esc(endTag), { permanent: true, direction: 'right', offset: [8, 0], className: 'item-label' });
        }
        layer.addLayer(v);
      });
      bindInfo(line, html);
    } else if (it.type === 'range') {
      const a = toLL(it.from), b = toLL(it.to);
      layer.addLayer(L.polyline([a, b], { color: '#000', weight: 5, opacity: 0.4, interactive: false }));
      const line = L.polyline([a, b], { color, weight: 2.5, dashArray: '8 6', bubblingMouseEvents: false });
      bindInfo(line, html);
      layer.addLayer(line);
      if (state.openPopupId === it.id) { // just drawn with the profile tool
        state.openPopupId = null;
        popup().setLatLng(toLL([(it.from[0] + it.to[0]) / 2, (it.from[1] + it.to[1]) / 2])).setContent(html()).openOn(map);
      }
      const from = L.circleMarker(a, { radius: 4, color: '#000', weight: 1.5, fillColor: color, fillOpacity: 1, bubblingMouseEvents: false });
      const to = L.circleMarker(b, { radius: 6, color, weight: 2, fillColor: '#000', fillOpacity: 0.6, bubblingMouseEvents: false });
      bindInfo(from, html, () => it.from); bindInfo(to, html, () => it.to);
      layer.addLayer(from).addLayer(to);
      // Distance and bearing sit on the middle of the line, turned to run along it and kept upright.
      const brg = bearing(it.from, it.to);
      let angle = brg - 90;
      if (angle > 90) angle -= 180;
      const mid = [(it.from[0] + it.to[0]) / 2, (it.from[1] + it.to[1]) / 2];
      const text = `${fmtDist(dist(it.from, it.to))} · ${pad(Math.round(brg) % 360, 3)}°`;
      const label = L.marker(toLL(mid), {
        keyboard: false,
        icon: L.divIcon({
          className: 'range-label', iconSize: [0, 0],
          html: `<span style="transform: translate(-50%, -50%) rotate(${angle.toFixed(1)}deg) translateY(-11px); border-color:${color}">` +
            `${tagText ? `<small>${esc(tagText)}</small> ` : ''}${text}</span>`,
        }),
      });
      bindInfo(label, html, () => mid);
      layer.addLayer(label);
      // A rocket shot also shows where to aim: a line on the aim bearing, out as far as the target, ending in a
      // crosshair labelled with the bearing, sight mark and hold. Off the target by the wind's aim-off.
      if (it.rocket) needShotData();
      const x = it.rocket && rocketSolve(it);
      if (x && !x.err) {
        const rad = x.aim * Math.PI / 180, D = dist(it.from, it.to);
        const aimXZ = [it.from[0] + D * Math.sin(rad), it.from[1] + D * Math.cos(rad)], c = toLL(aimXZ);
        layer.addLayer(L.polyline([a, c], { color: '#000', weight: 4.5, opacity: 0.5, interactive: false }));
        const aimLine = L.polyline([a, c], { color: ROCKET_AIM, weight: 2, bubblingMouseEvents: false });
        bindInfo(aimLine, html);
        const hold = Math.abs(x.hold) < 0.4 ? '' : ` ${x.hold > 0 ? '+' : '−'}${Math.abs(x.hold).toFixed(1)} m`;
        const mark = L.marker(c, { keyboard: false, zIndexOffset: 400, icon: L.divIcon({ className: '', iconSize: [0, 0],
          html: `<span class="rk-aim"><i></i><b>Aim ${x.aim.toFixed(1)}° · ${x.mark[0]} m${hold}</b></span>` }) });
        bindInfo(mark, html, () => aimXZ);
        layer.addLayer(aimLine).addLayer(mark);
      }
    } else if (it.type === 'mortar') {
      renderMortar(p, it, layer, color, html);
    } else if (it.type === 'construct') {
      renderConstruct(p, it, layer, html);
    } else if (it.type === 'emplacement') { // always friendly blue, whoever placed it
      const los = state.showLos ? fieldOfFireLos(it.xz, it.dir, it.arc, it.range, true, gunEye(it.height)) : null;
      if (los) layer.addLayer(losOverlay(los, FRIENDLY));
      layer.addLayer(L.polygon(sectorLatLngs(it.xz, it.dir, it.arc, it.range), {
        color: FRIENDLY, weight: 1.5, opacity: 0.9, dashArray: '5 4', fillColor: FRIENDLY, fillOpacity: los ? 0 : 0.17, interactive: false,
      }));
      const m = L.marker(toLL(it.xz), { icon: emplIcon(FRIENDLY, false, it.kind), keyboard: false, riseOnHover: true, zIndexOffset: 300 });
      const name = it.label || emplacementName(it);
      m.bindTooltip(esc(isMine(p.name) ? name : `${name} (${p.name})`), { direction: 'right', offset: [16, 0], className: 'item-label' });
      bindInfo(m, html, () => it.xz);
      layer.addLayer(m);
    } else if (it.type === 'arrow') {
      renderArrow(p, it, layer, html);
    } else if (it.type === 'ambush') {
      renderAmbush(p, it, layer, html);
    } else if (it.type === 'post') {
      renderPost(p, it, layer, color, html);
    } else if (it.type === 'sectors') {
      renderSectors(p, it, layer, html);
    } else if (it.type === 'overwatch') {
      renderOverwatch(p, it, layer, color, html);
    } else if (it.type === 'hulldown') {
      renderHullDown(p, it, layer, color, html);
    } else if (it.type === 'audible') {
      renderAudible(p, it, layer, html);
    }
    if (isMine(p.name) && it.xz) enableDrag(p, it, layer);
    p.layers.set(it.id, layer);
    p.group.addLayer(layer);
  }

  // Your own point markings can be dragged to a new spot; whatever hangs off them (a field of fire, range rings,
  // sectors, a mortar's reach) moves with them once the move is saved. Mortar targets stay where they are (they're
  // dragged on their own; see renderMortar).
  function enableDrag(p, it, layer) {
    const at = toLL(it.xz);
    const m = layer.getLayers().find(l => l instanceof L.Marker && l.options.interactive !== false && !l.options.draggable && l.getLatLng().equals(at));
    if (!m) return;
    m.options.draggable = true;
    m.on('dragstart', () => dragStart(it.id));
    m.on('dragend', () => {
      dragEnd();
      const xz = toXZ(m.getLatLng()), cur = p.items.get(it.id) || it;
      if (xz[0] < 0 || xz[1] < 0 || xz[0] > WORLD || xz[1] > WORLD) { toast("That's off the map."); renderItem(p, cur); return; }
      saveItem({ ...cur, xz: roundXZ(xz) });
    });
  }

  function unrenderItem(p, id) {
    const l = p.layers.get(id);
    if (l) p.group.removeLayer(l);
    p.layers.delete(id);
  }

  function onEvent(ev) {
    switch (ev.type) {
      case 'snapshot':
        state.loadedSession = state.me;
        [...state.players.keys()].forEach(removePlayer);
        ev.players.forEach(pl => {
          const p = getPlayer(pl.name, pl.color);
          p.away = !!pl.away; // left a room that keeps its plan; their markings stay
          pl.items.forEach(it => { p.items.set(it.id, it); renderItem(p, it); });
        });
        setKeep(!!ev.keep);
        setBriefing(ev.briefing || null, false);
        setClock(ev.clock, ev.now);
        // the room's wind; a room without one takes the wind set here before joining
        if (ev.wind || !state.wind) setRoomWind(ev.wind || null);
        else api('/api/wind', { id: state.me.id, token: state.me.token, wind: state.wind }).catch(err => console.error(err));
        if (state.restore) { restoreMine(state.restore); state.restore = null; }
        break;
      case 'clock':
        setClock(ev.clock, ev.now);
        if (!isMine(ev.clock.by)) toast(`${ev.clock.by} set the game time to ${fmtGame(ev.clock.game)}`);
        return;
      case 'wind':
        setRoomWind(ev.wind, ev.wind && ev.wind.by);
        return;
      case 'briefing':
        setBriefing(ev.briefing, true);
        return;
      case 'join': {
        const p = getPlayer(ev.player.name, ev.player.color);
        p.away = false;
        for (const it of ev.player.items || []) { p.items.set(it.id, it); renderItem(p, it); }
        if (!isMine(ev.player.name)) toast(`${ev.player.name} joined`);
        break;
      }
      case 'leave':
        if (ev.kept && state.players.has(ev.name)) {
          state.players.get(ev.name).away = true;
          toast(`${ev.name} left - their markings stay in this room`);
        } else {
          const had = state.players.get(ev.name)?.items.size;
          removePlayer(ev.name);
          toast(`${ev.name} left${had ? ' - their markings were removed' : ''}`);
        }
        break;
      case 'keep':
        setKeep(ev.keep);
        if (!isMine(ev.by)) toast(ev.keep ? `${ev.by} set this room to keep its plan` : `${ev.by} stopped this room keeping its plan`, 6000);
        break;
      case 'item': {
        if (isMine(ev.owner) && planBackup.deleted(state.me, ev.item.id)) break;
        const p = getPlayer(ev.owner);
        const isNew = !p.items.has(ev.item.id), before = p.items.get(ev.item.id);
        p.items.set(ev.item.id, ev.item);
        if (isMine(ev.owner)) planBackup.acknowledge(state.me, p.items);
        const air = airKey(ev.item) && AIR[airKey(ev.item)];
        if (air && isNew && !isMine(ev.owner)) toast(`${air.name} requested by ${ev.owner}${airSummary(ev.item) ? `: ${airSummary(ev.item)}` : ''}`, 8000);
        if (air && !isNew && before && before.status !== ev.item.status && ev.item.statusBy && !isMine(ev.item.statusBy)) {
          toast(`${ev.item.label || air.short}: ${AIR_STATUS[ev.item.status || 'requested'].name} by ${ev.item.statusBy}`, 8000);
        }
        const sm = isNew && isFireReq(ev.item) && !isMine(ev.owner) && TABLES && solutionMortar();
        if (sm) {
          const { sol } = fireSolution(sm.it, ev.item);
          toast(`${(FIRE[ev.item.fire] || FIRE.he).name} requested by ${ev.owner}: ${sol.best ? fmtSolution(sol, true) : noReach(sol)}`, 8000);
        }
        renderItem(p, ev.item);
        break;
      }
      case 'delete': {
        if (isMine(ev.owner)) planBackup.remove(state.me, ev.id);
        const p = state.players.get(ev.owner);
        const gone = p && p.items.get(ev.id);
        if (gone && ev.by && ev.by !== ev.owner && !isMine(ev.by)) { // someone cleared another player's request
          toast(`${gone.label || 'Fire mission'}${isMine(ev.owner) ? '' : ` (${ev.owner})`} cleared by ${ev.by}: mission complete`, 6000);
        }
        if (p) { p.items.delete(ev.id); unrenderItem(p, ev.id); }
        map.closePopup();
        break;
      }
    }
    if (ev.type === 'snapshot' || isMine(ev.owner)) keepMine();
    refreshLists();
  }

  function refreshLists() {
    // players
    const ul = $('#players');
    const players = [...state.players.values()].sort((a, b) => isMine(b.name) - isMine(a.name) || a.name.localeCompare(b.name));
    ul.innerHTML = players.map(p => `<li data-name="${esc(p.name)}" class="${positionOf(p) ? 'has-pos' : ''}"${positionOf(p) ? ' title="Show on map"' : ''}>` +
      `<span class="avatar" style="background:${p.color}">${esc([...p.name][0].toUpperCase())}</span>` +
      `<span class="n">${esc(p.name)}${isMine(p.name) ? ' <span class="you">(you)</span>' : p.away ? ' <span class="you">(away)</span>' : ''}</span>` +
      `<span class="c">${p.items.size || 'no'} marking${p.items.size === 1 ? '' : 's'}</span>` +
      (isPositionCard(positionOf(p) || {}) ? `<button type="button" class="los-tog${losOff.has(p.name) ? '' : ' on'}" data-act="los" ` +
        `aria-pressed="${!losOff.has(p.name)}" title="${losOff.has(p.name) ? 'Show' : 'Hide'} ${esc(p.name)}'s line of sight">${EYE_ICON}</button>` : '') +
      (positionOf(p) ? `<span class="pos${positionOf(p).unit === 'arm' ? ' arm' : ''}" aria-label="has a position marker"></span>` : '') + `</li>`).join('');
    $('#player-count').textContent = $('#squad-tab-count').textContent = players.length || '';
    // mine
    const me = state.me && state.players.get(state.me.name);
    const items = me ? [...me.items.values()] : [];
    $('#mine-count').textContent = items.length || '';
    // Grouped by category, in a fixed order; empty categories are left out.
    const groups = MINE_GROUPS.map(g => ({ ...g, items: items.filter(g.test) })).filter(g => g.items.length);
    $('#mine').innerHTML = groups.map(g =>
      `<li class="grp${collapsedGroups.has(g.name) ? ' closed' : ''}" data-grp="${g.name}" role="button" tabindex="0" aria-expanded="${!collapsedGroups.has(g.name)}" style="--g:${CAT_COLOR[g.cat]}">` +
      `<span class="grp-name">${g.name}</span><span class="grp-n">${g.items.length}</span></li>` +
      (collapsedGroups.has(g.name) ? [] : g.items).map(it => {
        const icon = MINES[it.icon]
          ? `<span class="mine-glyph ${it.icon} mini"><div><span>${it.icon === 'mine-at' ? 'AT' : 'AP'}</span></div></span>`
          : `<span class="swatch" style="background:${it.color || me.color}"></span>`;
        return `<li data-id="${esc(it.id)}">${icon}<span class="t">${esc(it.label || typeLabel(it))}</span>` +
          `<span class="d">${itemSummary(it)}</span><button data-act="delete" data-id="${esc(it.id)}" title="Delete" aria-label="Delete">✕</button></li>`;
      }).join('')).join('');
    if (document.activeElement === $('#search')) runSearch();
    renderContactLog();
    refreshMortarPanel();
    refreshFia();
    syncControl();
    refreshCoverage();
    refreshThreats();
    refreshFireLabels();
    refreshSectorFoes();
  }
  // Sectors of fire show how many enemy are in each sector, so redraw them when enemy positions or TRPs move.
  let sectorSigLast = null;
  function refreshSectorFoes() {
    const sig = allVisibleItems(i => (i.type === 'marker' && !!ENEMY_WATCH[i.icon] && timeoutState(i) !== 'expired') || isMarker(i, 'trp')).map(({ it }) => `${it.id}:${it.xz}`).join('|');
    if (sig === sectorSigLast) return;
    sectorSigLast = sig;
    state.players.forEach(p => p.items.forEach(it => { if (it.type === 'sectors') renderItem(p, it); }));
  }
  // Contact log: every live contact report, newest first, with how far it is from your position marker.
  function renderContactLog() {
    const rows = allVisibleItems(i => isMarker(i, 'contact') && timeoutState(i) !== 'expired').sort((a, b) => (b.it.at || 0) - (a.it.at || 0));
    $('#contact-count').textContent = rows.length || '';
    const me = myPosition();
    $('#contact-log').innerHTML = rows.length ? rows.map(({ p, it }) => {
      const t = timeoutState(it), mins = Math.floor((Date.now() - (it.at || Date.now())) / 60e3);
      const what = [it.what || 'Contact', it.size].filter(Boolean).join(' · ');
      const sub = [it.activity, mins < 1 ? 'now' : `${mins} min ago${typeof it.gt === 'number' ? ` (${fmtGame(it.gt)})` : ''}`, isMine(p.name) ? 'you' : p.name].filter(Boolean).join(' · ');
      const away = me ? `${fmtDist(dist(me.xz, it.xz))} ${compass(bearing(me.xz, it.xz))}` : grid(it.xz);
      return `<li class="${t === 'stale' ? 'stale' : ''}" data-owner="${esc(p.name)}" data-id="${esc(it.id)}" tabindex="0" role="button">` +
        `<span class="cg">!</span><span class="ct"><b>${esc(what)}</b><span class="sub">${esc(sub)}</span></span><span class="cd">${esc(away)}</span></li>`;
    }).join('') : '<li class="empty">No contacts. Enemy ▾ → Contact report.</li>';
  }
  const openContact = li => {
    const p = state.players.get(li.dataset.owner), it = p && p.items.get(li.dataset.id);
    if (it) focusItem(p, it);
  };
  $('#contact-log').addEventListener('click', e => { const li = e.target.closest('li[data-id]'); if (li) openContact(li); });
  $('#contact-log').addEventListener('keydown', e => { const li = e.target.closest('li[data-id]'); if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openContact(li); } });
  let fireSigLast = null;
  function refreshFireLabels() {
    const sig = allVisibleItems(i => i.type === 'mortar').map(({ it: m }) => `${m.id}:${m.xz}:${m.weapon}`).join('|') +
      `|${solutionMortar()?.it.id}|${!!TABLES}|${!!HEIGHT}`;
    if (sig === fireSigLast) return;
    fireSigLast = sig;
    state.players.forEach(p => p.items.forEach(it => { if (isFireReq(it)) renderItem(p, it); }));
  }

  // Collapsible groups in My markings; which ones are closed is remembered in this browser only.
  const GRP_KEY = 'everon-map-closed-groups';
  let collapsedGroups;
  try { collapsedGroups = new Set(JSON.parse(localStorage.getItem(GRP_KEY) || '[]')); } catch { collapsedGroups = new Set(); }
  function toggleGroup(name) {
    collapsedGroups.has(name) ? collapsedGroups.delete(name) : collapsedGroups.add(name);
    try { localStorage.setItem(GRP_KEY, JSON.stringify([...collapsedGroups])); } catch { /* storage unavailable */ }
    refreshLists();
  }
  $('#mine').addEventListener('keydown', e => {
    const g = e.target.closest('li.grp');
    if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleGroup(g.dataset.grp); }
  });

  $('#mine').addEventListener('click', e => {
    if (e.target.closest('button')) return;
    const grp = e.target.closest('li.grp');
    if (grp) return toggleGroup(grp.dataset.grp);
    const li = e.target.closest('li');
    const me = state.players.get(state.me.name);
    const it = li && me.items.get(li.dataset.id);
    if (it) focusItem(me, it);
  });

  function focusItem(p, it) {
    const layer = p.layers.get(it.id);
    const r = it.type === 'post' ? it.range : it.type === 'sectors' ? it.radius : 0;
    const bounds = r ? L.latLngBounds(toLL([it.xz[0] - r, it.xz[1] - r]), toLL([it.xz[0] + r, it.xz[1] + r])).pad(0.1)
      : layer && ['route', 'range', 'area', 'arrow', 'ambush'].includes(it.type) || (it.type === 'construct' && it.points) ? layer.getBounds().pad(0.3) : null;
    flyAndOpen(itemAnchor(it), () => itemPopup(p.name, it), bounds);
  }

  const EYE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/></svg>';
  function togglePosLos(name) {
    losOff.has(name) ? losOff.delete(name) : losOff.add(name);
    try { localStorage.setItem(LOS_OFF_KEY, JSON.stringify([...losOff])); } catch { /* storage unavailable */ }
    const p = state.players.get(name), pos = positionOf(p);
    if (pos) renderItem(p, pos);
    refreshLists();
    refreshCoverage(true);
  }
  $('#players').addEventListener('click', e => {
    const tog = e.target.closest('[data-act="los"]');
    if (tog) return togglePosLos(tog.closest('li').dataset.name);
    const li = e.target.closest('li.has-pos');
    const p = li && state.players.get(li.dataset.name);
    const pos = positionOf(p);
    if (pos) flyAndOpen(pos.xz, () => itemPopup(p.name, pos));
  });

  $('#show-others').addEventListener('change', e => {
    state.showOthers = e.target.checked;
    state.players.forEach(p => {
      if (isMine(p.name)) return;
      state.showOthers ? p.group.addTo(map) : p.group.remove();
    });
    refreshFia();
    refreshCoverage();
  });

  // Edit / delete buttons inside popups and lists
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b || !state.me) return;
    const me = state.players.get(state.me.name);
    const it = me && me.items.get(b.dataset.id);
    if (!it) return;
    if (b.dataset.act === 'delete') { deleteItem(it.id); }
    if (b.dataset.act === 'flip') { map.closePopup(); saveItem({ ...it, side: -it.side }); }
    if (b.dataset.act === 'edit') { map.closePopup(); openEditor(it, false); }
    if (b.dataset.act === 'contact-move') { map.closePopup(); state.contactMove = it.id; updateHint(); }
  });
  // "It moved": the next click on the map is where the contact is now. Its old spot joins the dotted track (the last
  // six are kept), its heading points along the move, and its age starts again.
  const CONTACT_TRAIL = 6;
  function finishContactMove(xz) {
    const it = state.players.get(state.me.name)?.items.get(state.contactMove);
    state.contactMove = null;
    updateHint();
    if (!it) return;
    if (dist(it.xz, xz) < 5) return toast('That is where it already is.');
    saveItem({ ...it, xz: roundXZ(xz), trail: [...(it.trail || []), it.xz].slice(-CONTACT_TRAIL), heading: Math.round(bearing(it.xz, xz)) % 360, at: Date.now(),
      ...(clock ? { gt: Math.floor(gameAt() % 86400) } : {}) });
  }

  // ---------------------------------------------------------------------------
  // Editor modal
  // ---------------------------------------------------------------------------
  const PALETTE = ['#ff6b6b', '#ffa94d', '#ffd43b', '#a9e34b', '#51cf66', '#22b8cf', '#4dabf7', '#845ef7', '#f06595', '#f8f9fa'];
  let editing = null; // {item, isNew}
  function openEditor(item, isNew) {
    editing = { item: { ...item }, isNew };
    $('#editor-title').textContent = `${isNew ? 'New' : 'Edit'} ${typeLabel(item).replace(/^(?!TRP)\w/, c => c.toLowerCase())}`;
    $('#ed-label').value = item.label || '';
    $('#ed-note').value = item.note || '';
    $('#ed-icon').value = item.icon || 'dot';
    const plainKind = [...$('#ed-icon').options].some(o => o.value === (item.icon || 'dot'));
    $('#ed-icon-row').classList.toggle('hidden', item.type !== 'marker' || FIXED_ICONS.has(item.icon) || !plainKind);
    // Contact report details
    const contact = item.type === 'marker' && item.icon === 'contact';
    $('#ed-contact').classList.toggle('hidden', !contact);
    if (contact) {
      $('#ed-what').value = item.what || '';
      $('#ed-size').value = item.size || '';
      $('#ed-activity').value = item.activity || '';
      $('#ed-heading').value = typeof item.heading === 'number' ? String(item.heading) : '';
      $('#ed-kit').value = item.kit || '';
    }
    // Timeout for unit markers and contact reports; platform height for MG nests
    const timed = item.type === 'marker' && (UNITS[item.icon] || item.icon === 'contact');
    $('#ed-ttl-row').classList.toggle('hidden', !timed);
    if (timed) {
      const ttl = String(ttlOf(item)), sel = $('#ed-ttl');
      if (![...sel.options].some(o => o.value === ttl)) sel.insertAdjacentHTML('beforeend', `<option value="${ttl}">${ttl} min</option>`);
      sel.value = ttl;
      editing.ttl = ttl;
    }
    const raisable = item.type === 'emplacement' || item.type === 'sectors';
    $('#ed-height-row').classList.toggle('hidden', !raisable);
    if (raisable) $('#ed-height').value = item.height || 0;
    // Who covers each sector of fire
    const air = airKey(item) && AIR[airKey(item)];
    $('#ed-air').classList.toggle('hidden', !air);
    if (air) {
      const vals = item.air || {};
      $('#ed-air').innerHTML = air.fields.map(([k, label, opts]) => `<label class="field"><span>${label}</span>` + (opts
        ? `<select data-air="${k}">${opts.map(o => { const [v, t] = [].concat(o, o).slice(0, 2); return `<option value="${esc(v)}"${vals[k] === v ? ' selected' : ''}>${esc(t)}</option>`; }).join('')}</select>`
        : `<input data-air="${k}" maxlength="60" value="${esc(vals[k] || '')}">`) + '</label>').join('');
    }
    $('#ed-sectors').classList.toggle('hidden', item.type !== 'sectors');
    if (item.type === 'sectors') {
      $('#ed-sector-rows').innerHTML = sectorSpans(item).map(([a, b], i) =>
        `<label class="sec-row"><span class="sec-id" style="--c:${SECTOR_COLORS[i % SECTOR_COLORS.length]}">${SECTOR_LETTERS[i]}</span>` +
        `<span class="sec-brg">${pad(Math.round(a) % 360, 3)}°–${pad(Math.round(b) % 360, 3)}°</span>` +
        `<input data-i="${i}" maxlength="40" placeholder="Player or fireteam" value="${esc((item.names || [])[i] || '')}"></label>`).join('');
    }
    // Colour only matters where the symbol takes the owner's colour
    const fixedColor = (item.type === 'marker' && (['contact', 'lz', 'aa-f'].includes(item.icon) || HAZARDS[item.icon] || AIR[item.icon])) ||
      isFireReq(item) || !!airKey(item) || item.type === 'aa' || item.type === 'emplacement' ||
      ['arrow', 'ambush', 'sectors'].includes(item.type) || isEnemyPost(item) || (item.type === 'post' && item.side === 'fv');
    $('#ed-color-row').classList.toggle('hidden', fixedColor);
    $('#ed-delete').classList.toggle('hidden', isNew);
    const colors = $('#ed-colors');
    const current = item.color || state.me.color;
    colors.innerHTML = [state.me.color, ...PALETTE.filter(c => c !== state.me.color)].map(c =>
      `<button type="button" data-color="${c}" style="background:${c}" class="${c === current ? 'sel' : ''}" title="${c}"></button>`).join('');
    editing.item.color = current;
    $('#editor').classList.remove('hidden');
    $('#ed-label').focus();
    $('#ed-label').select();
  }
  function closeEditor() {
    editing = null;
    $('#editor').classList.add('hidden');
    document.activeElement?.blur();
  }
  $('#ed-colors').addEventListener('click', e => {
    const b = e.target.closest('[data-color]');
    if (!b || !editing) return;
    editing.item.color = b.dataset.color;
    $('#ed-colors').querySelectorAll('button').forEach(x => x.classList.toggle('sel', x === b));
  });
  $('#editor-form').addEventListener('submit', e => {
    e.preventDefault();
    if (!editing) return;
    const it = editing.item;
    it.label = $('#ed-label').value.trim();
    it.note = $('#ed-note').value.trim();
    if (it.type === 'marker' && !$('#ed-icon-row').classList.contains('hidden')) it.icon = $('#ed-icon').value;
    if (it.type === 'marker' && it.icon === 'contact') {
      it.what = $('#ed-what').value;
      it.size = $('#ed-size').value;
      it.activity = $('#ed-activity').value;
      it.kit = $('#ed-kit').value.trim();
      it.heading = $('#ed-heading').value === '' ? null : +$('#ed-heading').value;
    }
    if (it.type === 'sectors') it.names = [...$('#ed-sector-rows').querySelectorAll('input')].map(i => i.value.trim());
    if (airKey(it)) it.air = Object.fromEntries([...$('#ed-air').querySelectorAll('[data-air]')].map(el => [el.dataset.air, el.value.trim()]));
    // A changed timeout counts from now
    if (!$('#ed-ttl-row').classList.contains('hidden') && $('#ed-ttl').value !== editing.ttl) { it.ttl = +$('#ed-ttl').value; it.at = Date.now(); }
    if (it.type === 'emplacement' || it.type === 'sectors') it.height = Math.min(100, Math.max(0, Math.round((+$('#ed-height').value || 0) * 10) / 10));
    saveItem(it);
    closeEditor();
  });
  $('#ed-cancel').addEventListener('click', closeEditor);
  $('#ed-delete').addEventListener('click', () => { if (editing) deleteItem(editing.item.id); closeEditor(); });
  $('#editor').addEventListener('mousedown', e => { if (e.target.id === 'editor') closeEditor(); });

  // ---------------------------------------------------------------------------
  // Toolbox: every map tool, grouped the way the toolbar shows them. This one list drives the toolbar menus,
  // the keyboard (a group's letter opens its menu, then the item's number picks it: E then 1 = contact report),
  // the hint shown while a tool is active, and the Ctrl+K tool finder.
  // ---------------------------------------------------------------------------
  const RADIO_SVG_BODY = '<rect x="6" y="9" width="12" height="12" rx="2"/><path d="M9 9V3M9 13h6M9 16.5h6"/><path d="M12.5 5.5a4 4 0 0 1 4 0M11 3a7 7 0 0 1 7 0"/>';
  const svg = (body, style = '') => `<svg viewBox="0 0 24 24"${style ? ` style="${style}"` : ''}>${body}</svg>`;
  const mineSvg = kind => `<span class="mine-glyph mine-${kind} mini"><div><span>${kind.toUpperCase()}</span></div></span>`;
  const FINISH = 'Backspace undoes a point · Enter or double-click to finish';
  const TOOLBOX = [
    { id: 'friendly', name: 'Friendly', key: 'F', color: '#6cb8ff', title: 'Your positions, units and routes',
      icon: svg('<rect x="3" y="6" width="18" height="12" rx="1"/><path d="M3 6l18 12M21 6L3 18"/>'),
      items: [
        { tool: 'infantry', name: 'My position', icon: unitSvg('inf', 'f', true) },
        { tool: 'unit-inf-f', name: 'Friendly infantry', short: 'Infantry', icon: unitSvg('inf', 'f') },
        { tool: 'vehicle-view-f', name: 'Friendly armour', short: 'Armour', icon: unitSvg('arm', 'f') },
        '-',
        { tool: 'advance', name: 'Advance arrow', short: 'Advance', icon: svg('<path d="M3 18L17 7" stroke-width="3"/><path d="M12 5.5l7-.5-.5 7z" fill="currentColor"/>', 'color:#4dabf7'),
          hint: `Click along your route · ${FINISH}` },
        { tool: 'rally', name: 'Rally point', icon: svg('<path d="M6 21V4"/><path d="M6 4h11l-2.5 4L17 12H6z" fill="rgba(108,184,255,.3)"/>', 'color:#6cb8ff'),
          hint: 'Click to drop a rally point' },
        { tool: 'objective', name: 'Objective', icon: svg('<path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6l-5.4 2.9 1.2-6-4.5-4.2 6.1-.7z"/>', 'color:#ffd43b'),
          hint: 'Click to drop an objective' },
        { tool: 'radio', name: 'Radio backpack', short: 'Radio', icon: svg(RADIO_SVG_BODY, 'color:#6cb8ff') },
        { tool: 'aa-f', name: 'AA gun', icon: '<span class="mi-badge" style="--c:#6cb8ff">AA</span>', hint: 'Click to mark a friendly AA gun' },
        { tool: 'mortar', name: 'Mortar', icon: svg('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.5"/><path d="M12 2v4.5M12 17.5V22M2 12h4.5M17.5 12H22"/>') },
      ] },
    { id: 'enemy', name: 'Enemy', key: 'E', color: '#ff6b6b', title: 'Enemy sightings, units, movement and sight lines',
      icon: svg('<path d="M12 2.5L21.5 12 12 21.5 2.5 12z"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7"/>'),
      items: [
        { tool: 'contact', name: 'Contact report', short: 'Contact', icon: svg('<path d="M12 3l9 9-9 9-9-9z" fill="rgba(255,92,92,.35)"/><path d="M12 8v5M12 16v.1"/>', 'color:#ff5c5c') },
        { tool: 'unit-inf-e', name: 'Enemy infantry', short: 'Infantry', icon: unitSvg('inf', 'e') },
        { tool: 'unit-arm-e', name: 'Enemy armour', short: 'Armour', icon: unitSvg('arm', 'e') },
        { tool: 'sniper', name: 'Sniper', icon: svg('<circle cx="12" cy="12" r="7"/><path d="M12 2v6M12 16v6M2 12h6M16 12h6"/>', 'color:#ff5c5c'),
          hint: 'Click where the sniper is' },
        { tool: 'enemy-ambush', name: 'Enemy roadblock / ambush', short: 'Ambush site',
          icon: svg('<path d="M12 3l9 9-9 9-9-9z" fill="rgba(255,92,92,.3)"/><path d="M7 12h10" stroke-width="2.6"/><path d="M9 8.5l3-2 3 2" />', 'color:#ff5c5c'),
          hint: 'Click where the enemy has set up a roadblock or ambush' },
        '-',
        { tool: 'enemy-area', name: 'Enemy in area', short: 'In area', icon: '<svg class="area-ico" viewBox="0 0 24 24"><path d="M4 8l7-5 9 4-1.5 11L8 21 3 15z"/></svg>',
          hint: 'Hold the mouse button and circle the area; let go to close it' },
        { tool: 'enemy-approach', name: 'Approach arrow', short: 'Approach', icon: svg('<path d="M3 18L17 7" stroke-width="2.4" stroke-dasharray="3.5 3"/><path d="M12 5.5l7-.5-.5 7z" fill="currentColor"/>', 'color:#ff5c5c'),
          hint: `Click along their expected route · ${FINISH}` },
        { tool: 'patrol', name: 'Patrol route', short: 'Patrol', icon: svg('<path d="M3 17c4-8 10 2 16-8" stroke-dasharray="2.5 3"/><path d="M15 8.5l4.5.5-.8 4.4"/>', 'color:#ffa94d'),
          hint: `Click along the enemy patrol route · ${FINISH}` },
        '-',
        { tool: 'enemy-view', name: 'Enemy line of sight', short: 'Enemy LOS', icon: svg('<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>', 'color:#ff5c5c') },
        '-',
        { tool: 'aa-e', name: 'AA gun', short: 'Enemy AA', icon: '<span class="mi-badge" style="--c:#ff5c5c">AA</span>' },
      ] },
    { id: 'plan', name: 'Plan', key: 'P', color: '#c8d96f', title: 'Markers, routes, ambushes, range and terrain tools',
      icon: svg('<path d="M4 20l6-6 4 3 6-9"/><path d="M15 8h5v5"/>'),
      items: [
        { tool: 'marker', name: 'Marker', icon: svg('<path d="M12 21s-6.5-5.6-6.5-10.5a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21z"/><circle cx="12" cy="10.5" r="2.2"/>'),
          hint: 'Click to drop a marker with a label and a note' },
        { tool: 'route', name: 'Route', icon: svg('<circle cx="5" cy="19" r="2"/><circle cx="19" cy="5" r="2"/><path d="M7 19h7a3.5 3.5 0 0 0 0-7h-4a3.5 3.5 0 0 1 0-7h7"/>'),
          hint: `Click to add waypoints · ${FINISH}` },
        { tool: 'ambush', name: 'Ambush', icon: svg('<rect x="3" y="14" width="18" height="6" rx="1" style="color:#ff5c5c" stroke-dasharray="2.5 2"/><path d="M5 9h9" stroke="#6cb8ff" stroke-width="2.6"/><path d="M19 5v6" stroke="#ffc53d" stroke-width="2.6"/>') },
        '-',
        { tool: 'range', name: 'Range line', icon: svg('<circle cx="5" cy="19" r="2"/><path d="M7 17L15.5 8.5" stroke-dasharray="2.5 2.5"/><circle cx="18" cy="6" r="3.2"/>'),
          hint: 'Click the start point, then the target' },
        { tool: 'profile', name: 'Elevation profile', short: 'Profile', icon: svg('<path d="M2 19l5.5-8 4 5 4.5-10L22 19z"/><path d="M2 21h20" stroke-dasharray="2 2.5"/>'),
          hint: 'Click the start, then the target · side-on view with line of sight' },
        '-',
        { tool: 'hulldown', name: 'Hull-down finder', short: 'Hull-down', icon: svg('<path d="M2 17c4 0 5-6 10-6s6 6 10 6" /><rect x="8" y="12" width="8" height="3.4" rx="1" fill="currentColor" stroke="none"/><path d="M16 13.4h4"/>', 'color:#8ce99a') },
        { tool: 'overwatch', name: 'Overwatch finder', short: 'Overwatch', icon: svg('<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>', 'color:#8ce99a') },
        { tool: 'cover-route', name: 'Route planner', short: 'Route planner', icon: svg('<circle cx="4.5" cy="19" r="2"/><circle cx="19.5" cy="5" r="2"/><path d="M6 17.5c3-1 2-6 6-6s3-5 6-5" stroke-dasharray="3 2.5"/><path d="M3 9c3-3 6-3 8 0" style="color:#ff6b6b"/>', 'color:#8ce99a') },
        { tool: 'lz', name: 'Landing zone check', short: 'LZ check', icon: svg('<circle cx="12" cy="12" r="9"/><path d="M8.5 7.5v9M15.5 7.5v9M8.5 12h7" stroke-width="2.2"/>', 'color:#8ce99a'),
          hint: 'Hover to check a spot · click to mark a landing zone' },
        { tool: 'audible', name: 'Who can hear it', short: 'Heard from', icon: svg('<path d="M9 18V6l9-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="15.5" cy="16" r="2.5"/>', 'color:#b197fc') },
        '-', // last, so the tools above keep their number keys
        { tool: 'rocket', name: 'Shot calculator', short: 'Shot', icon: svg('<path d="M3 19l9-9"/><path d="M12 10l3.5-3.5 3 1-1-3L21 3" /><path d="M10.5 8.5l5 5" /><circle cx="19" cy="17" r="2.5" stroke-dasharray="2 1.6"/>'),
          hint: 'Click where you fire from, then the target · rockets, scoped rifles, MGs and vehicle guns: sight setting, hold and aim bearing, with wind' },
      ] },
    { id: 'support', name: 'Support', key: 'S', color: '#ff922b', title: 'Fire missions, gun runs, medevac, pickups, resupply',
      icon: svg('<circle cx="12" cy="12" r="7.5"/><path d="M12 2v6M12 16v6M2 12h6M16 12h6"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>', 'color:#ff922b'),
      items: [
        { tool: 'fire-support', name: 'Fire support request', short: 'Fire request', icon: '<svg class="area-ico fire" viewBox="0 0 24 24"><path d="M4 8l7-5 9 4-1.5 11L8 21 3 15z"/><path class="x" d="M8 8l8 8M16 8l-8 8"/></svg>' },
        '-',
        ...Object.entries(AIR).map(([tool, a]) => ({ tool, name: a.name, short: a.short, icon: `<span class="mi-badge" style="--c:${a.color}">${a.badge}</span>`,
          hint: tool === 'air-cas' ? null : `Click where the ${a.where}, then fill in the request` })),
      ] },
    { id: 'defend', name: 'Defend', key: 'D', color: '#c8b27c', title: 'TRPs, sectors of fire, fortifications',
      icon: svg('<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/>'),
      items: [
        { tool: 'trp', name: 'Target reference point', short: 'TRP', icon: svg('<path d="M12 3l9.5 17h-19z"/><path d="M12 10v6M9 13h6"/>'),
          hint: 'Click to drop a TRP' },
        { tool: 'sectors', name: 'Sectors of fire', short: 'Sectors', icon: svg('<circle cx="12" cy="12" r="9"/><path d="M12 12V3M12 12l7.8 4.5M12 12l-7.8 4.5"/>') },
        '-',
        { tool: 'emplacement', name: 'MG nest', icon: svg('<path d="M12 20L4.5 7.5a14 14 0 0 1 15 0z" stroke-dasharray="2.5 2"/><rect x="9" y="16.5" width="6" height="5" rx="1"/>') },
        { tool: 'bunker', name: 'Bunker', icon: svg('<path d="M3 19v-7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v7z"/><path d="M7 12.5h10" stroke-width="2.6"/>'),
          hint: 'Click to drop a bunker' },
        { tool: 'wall', name: 'Sandbags', icon: svg('<rect x="2.5" y="13" width="6.5" height="5" rx="2.2"/><rect x="8.8" y="13" width="6.5" height="5" rx="2.2"/><rect x="15" y="13" width="6.5" height="5" rx="2.2"/><rect x="5.6" y="8" width="6.5" height="5" rx="2.2"/><rect x="11.9" y="8" width="6.5" height="5" rx="2.2"/>', 'color:#c8b27c'),
          hint: `Click along the sandbag line · ${FINISH}` },
        { tool: 'wire', name: 'Barbed wire', short: 'Wire', icon: svg('<path d="M2 12h20"/><path d="M5 9l3 6M8 9l-3 6M16 9l3 6M19 9l-3 6"/>'),
          hint: `Click along the wire · ${FINISH}` },
        { tool: 'checkpoint', name: 'Checkpoint', icon: svg('<path d="M5 20V8"/><circle cx="5" cy="7" r="1.8"/><path d="M6.5 9.5h15v3h-15z" style="color:#ff6b6b"/><path d="M3 20h5"/>'),
          hint: 'Click to drop a checkpoint' },
        { tool: 'roadblock', name: 'Roadblock', icon: svg('<path d="M2 20h20" stroke-dasharray="2 2.5"/><path d="M7 7l-4 11M7 7l4 11M1.5 14h11M17 7l-4 11M17 7l4 11M11.5 14h11"/>'),
          hint: `Click along the line of tank traps · ${FINISH}` },
      ] },
    { id: 'hazards', name: 'Hazards', key: 'H', color: '#ffc53d', title: 'Minefields, blocked roads, bridges out',
      icon: svg('<path d="M12 3.5L21.5 20h-19z"/><path d="M12 10v4.5M12 17.2v.1"/>'),
      items: [
        { tool: 'mine-at', name: 'AT minefield', icon: mineSvg('at'), hint: 'Click to drop an anti-tank minefield (10 m kill radius)' },
        { tool: 'mine-ap', name: 'AP minefield', icon: mineSvg('ap'), hint: 'Click to drop an anti-personnel minefield' },
        { tool: 'blocked', name: 'Blocked or mined road', short: 'Blocked road', icon: svg('<circle cx="12" cy="12" r="9" fill="rgba(255,92,92,.35)"/><path d="M7 12h10" stroke-width="3"/>', 'color:#ff5c5c'),
          hint: 'Click to mark a blocked or mined road' },
        { tool: 'bridge', name: 'Bridge out', icon: svg('<path d="M2 9h7M15 9h7M2 15h7M15 15h7"/><path d="M11 6l2 3-2 3 2 3-2 3"/>', 'color:#ffa94d'),
          hint: 'Click to mark a bridge that is out' },
      ] },
  ];
  // tool id -> its toolbox entry (with .group and .n, its number in the menu)
  const TOOL = {};
  TOOLBOX.forEach(g => g.items.filter(it => it !== '-').forEach((it, i) => { TOOL[it.tool] = { ...it, group: g, n: i + 1 }; }));
  const toolKeys = tool => (TOOL[tool] ? `${TOOL[tool].group.key} ${TOOL[tool].n % 10}` : '');

  let draw = null; // {tool, points: [xz], layer, line, ghost}
  let lastCursor = null;

  // Build the toolbar menus from the toolbox. The last two open to the left so they stay on screen.
  $('#tool-menus').innerHTML = TOOLBOX.map((g, gi) => {
    const items = g.items.map(it => (it === '-' ? '<div class="menu-sep" role="separator"></div>'
      : `<button type="button" class="menu-item" data-tool="${it.tool}" role="menuitem"><span class="mi-ico">${it.icon}</span>` +
        `<span class="mi-name">${esc(it.name)}</span><kbd>${TOOL[it.tool].n % 10}</kbd></button>`)).join('');
    const last = g.items.filter(it => it !== '-').length;
    return `<div class="tool-group${gi >= TOOLBOX.length - 2 ? ' end' : ''}" data-group="${g.id}" style="--g:${g.color}">` +
      `<button type="button" class="tool menu-btn" aria-haspopup="menu" aria-expanded="false" title="${esc(g.title)} (${g.key})">` +
      `${g.icon}<span class="name">${g.name}</span><kbd>${g.key}</kbd><svg class="caret" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5"/></svg></button>` +
      `<div class="dropdown panel hidden" role="menu" aria-label="${g.name}">` +
      `<div class="menu-head"><b>${g.name}</b><span>${g.key} then ${last > 9 ? '1–9, 0' : `1–${last}`}</span></div>${items}</div></div>`;
  }).join('');

  function setTool(tool) {
    finishDraw();
    cancelEmplDraft();
    cancelShapeDraft();
    cancelCoverDraft();
    cancelAaDraft();
    state.tool = tool;
    if (tool === 'rocket') needShotData(); // its pickers list the launchers and guns, and the shot follows right away
    const mine = tool === 'infantry' && myPosition();
    if (mine) { state.posUnit = mine.unit || 'inf'; state.posRange = mine.range || 0; }
    syncLzShade();
    document.querySelectorAll('#toolbar [data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
    // A menu's button shows the chosen tool's short name, in the group's colour, while that tool is active.
    TOOLBOX.forEach(g => {
      const btn = document.querySelector(`.tool-group[data-group="${g.id}"] .menu-btn`);
      const it = TOOL[tool] && TOOL[tool].group === g ? TOOL[tool] : null;
      btn.classList.toggle('active', !!it);
      btn.querySelector('.name').textContent = it ? it.short || it.name : g.name;
    });
    closeMenus();
    map.getContainer().classList.toggle('tool-active', tool !== 'pan');
    isLassoTool(tool) ? map.dragging.disable() : map.dragging.enable();
    cancelLasso();
    if (tool !== 'mortar') state.mortarPlacing = false;
    else if (solutionMortar()) setMortarPanel(true);
    updateHint();
    map.closePopup();
    updateLive();
    updateMortarGhost();
  }
  function updateHint() {
    const text = state.contactMove ? "Click where the contact is now · Esc cancels" : state.tool === 'mortar' ? mortarHint() : state.tool === 'heli-route' ? coverHint() : TOOL[state.tool]?.hint || '';
    const hint = $('#hint');
    hint.textContent = text;
    hint.classList.toggle('hidden', !text);
    $('#arc-picker').classList.toggle('hidden', state.tool !== 'emplacement');
    $('#arc-hint').textContent = emplDraft ? 'Move to aim · click to set · Esc cancels' : 'Click to place the nest';
    renderPicker();
  }

  // Menus open from their button or their letter key; a number key then picks an item.
  let openGroup = null;
  function closeMenus() {
    document.querySelectorAll('.dropdown').forEach(m => m.classList.add('hidden'));
    document.querySelectorAll('.menu-btn').forEach(b => b.setAttribute('aria-expanded', 'false'));
    openGroup = null;
  }
  function toggleMenu(id) {
    const wasOpen = openGroup === id;
    closeMenus();
    if (wasOpen) return;
    const g = document.querySelector(`.tool-group[data-group="${id}"]`);
    g.querySelector('.dropdown').classList.remove('hidden');
    g.querySelector('.menu-btn').setAttribute('aria-expanded', 'true');
    openGroup = id;
  }
  function pickFromOpenMenu(n) {
    const it = TOOLBOX.find(g => g.id === openGroup)?.items.filter(x => x !== '-')[n - 1];
    if (it) setTool(it.tool);
  }
  $('#toolbar').addEventListener('click', e => {
    const item = e.target.closest('[data-tool]');
    if (item) return setTool(item.dataset.tool);
    const btn = e.target.closest('.menu-btn');
    if (btn) { e.stopPropagation(); toggleMenu(btn.closest('.tool-group').dataset.group); }
  });
  document.addEventListener('click', e => { if (!e.target.closest('.tool-group')) closeMenus(); });

  function startDraw(tool, xz) {
    const layer = L.layerGroup().addTo(map);
    const color = LINE_STYLE[tool] || state.me.color;
    const line = L.polyline([], { color, weight: 3, opacity: 0.95, interactive: false }).addTo(layer);
    const ghost = L.polyline([], { color, weight: 2, dashArray: '6 6', opacity: 0.9, interactive: false }).addTo(layer);
    draw = { tool, points: [], layer, line, ghost, color, pins: [] };
    addDrawPoint(xz);
  }

  function addDrawPoint(xz) {
    const pts = draw.points;
    const prev = pts[pts.length - 1];
    if (prev && dist(prev, xz) < 0.5 * SCALE / Math.pow(2, map.getZoom())) return; // double-click duplicate
    pts.push(xz);
    draw.line.addLatLng(toLL(xz));
    const pin = L.circleMarker(toLL(xz), { radius: 4, color: '#000', weight: 1.5, fillColor: draw.color, fillOpacity: 1, interactive: false }).addTo(draw.layer);
    draw.pins.push(pin);
    updateGhost();
  }

  function undoDrawPoint() {
    if (!draw) return;
    draw.points.pop();
    draw.layer.removeLayer(draw.pins.pop());
    draw.line.setLatLngs(draw.points.map(toLL));
    if (!draw.points.length) { draw.layer.remove(); draw = null; }
    updateGhost();
  }

  function finishDraw() {
    if (!draw) return;
    const d = draw;
    draw = null;
    d.layer.remove();
    if (LINE_CONSTRUCTS.includes(d.tool) && d.points.length >= 2) {
      const n = [...(state.players.get(state.me.name)?.items.values() || [])].filter(i => i.type === 'construct' && i.kind === d.tool).length + 1;
      saveItem({ id: uid(), type: 'construct', kind: d.tool, points: d.points.map(roundXZ), label: `${CONSTRUCT_NAME[d.tool]} ${n}`, note: '', color: state.me.color });
    }
    if (ARROW_OF_TOOL[d.tool] && d.points.length >= 2) {
      const kind = ARROW_OF_TOOL[d.tool];
      const n = [...(state.players.get(state.me.name)?.items.values() || [])].filter(i => i.type === 'arrow' && i.kind === kind).length + 1;
      saveItem({ id: uid(), type: 'arrow', kind, points: d.points.map(roundXZ), label: `${ARROWS[kind].name} ${n}`, note: '', color: ARROWS[kind].color });
    }
    if (d.tool === 'route' && d.points.length >= 2) {
      const n = [...(state.players.get(state.me.name)?.items.values() || [])].filter(i => i.type === 'route').length + 1;
      saveItem({ id: uid(), type: 'route', points: d.points.map(roundXZ), label: `Route ${n}`, note: '', color: state.me.color });
    }
    updateLive();
  }

  const roundXZ = ([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10];
  const trpIssued = new Map(); // TRP number -> when it was handed out
  // Default names count your markings, but a quick second click can come before the server echoes the first one.
  const recentNumbers = new Map(); // key -> {n, t}
  function issueNumber(key, n) {
    const r = recentNumbers.get(key);
    if (r && Date.now() - r.t < 5000 && r.n >= n) n = r.n + 1;
    recentNumbers.set(key, { n, t: Date.now() });
    return n;
  }

  // ---------------------------------------------------------------------------
  // Enemy area lasso: press, circle the area, let go. While drawing, a point is kept only every few pixels; on
  // release the outline is simplified once (Ramer-Douglas-Peucker, tolerance about a pixel and a half) and closed
  // straight back to the start, so even a long scribble costs next to nothing and stays under 200 points.
  // ---------------------------------------------------------------------------
  const LASSO_STEP_PX = 5, LASSO_MAX_POINTS = 200;
  const isLassoTool = t => t === 'enemy-area' || (t === 'fire-support' && state.fireShape === 'area') || (t === 'air-cas' && state.casShape === 'area');
  let lasso = null; // {points: [xz], shape}
  const metresPerPixel = () => SCALE / Math.pow(2, map.getZoom());

  function simplify(pts, tol) {
    if (pts.length < 3) return pts.slice();
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const [ax, az] = pts[a], [bx, bz] = pts[b], dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz) || 1;
      let far = -1, farD = tol;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs(dz * (pts[i][0] - ax) - dx * (pts[i][1] - az)) / len; // distance from the chord
        if (d > farD) { farD = d; far = i; }
      }
      if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  function cancelLasso() {
    if (!lasso) return;
    lasso.shape.remove();
    lasso = null;
  }
  function lassoPoint(e) { return toXZ(map.mouseEventToLatLng(e)); }
  const mapEl = map.getContainer();
  // Keep getting moves for this pointer even outside the map; not every pointer can be captured.
  const capturePointer = e => { try { mapEl.setPointerCapture(e.pointerId); } catch { /* not capturable */ } };
  mapEl.addEventListener('pointerdown', e => {
    if (!isLassoTool(state.tool) || !state.me || e.button !== 0) return;
    cancelLasso();
    capturePointer(e);
    const color = state.tool === 'fire-support' ? FIRE[state.fireKind].color : state.tool === 'air-cas' ? AIR['air-cas'].color : ENEMY;
    lasso = { tool: state.tool, points: [lassoPoint(e)], shape: L.polygon([], {
      color, weight: 2, dashArray: '6 4', fillColor: color, fillOpacity: 0.18, interactive: false }).addTo(map) };
  });
  mapEl.addEventListener('pointermove', e => {
    if (!lasso) return;
    const xz = lassoPoint(e), last = lasso.points[lasso.points.length - 1];
    if (dist(last, xz) < LASSO_STEP_PX * metresPerPixel()) return;
    lasso.points.push(xz);
    lasso.shape.setLatLngs(lasso.points.map(toLL));
  });
  mapEl.addEventListener('pointerup', () => {
    if (!lasso) return;
    const raw = lasso.points, tool = lasso.tool;
    cancelLasso();
    let tol = 1.5 * metresPerPixel(), pts = simplify(raw, tol);
    while (pts.length > LASSO_MAX_POINTS) pts = simplify(raw, tol *= 1.6);
    const span = Math.max(...pts.map(p => p[0])) - Math.min(...pts.map(p => p[0])) + Math.max(...pts.map(p => p[1])) - Math.min(...pts.map(p => p[1]));
    if (pts.length < 3 || polyArea(pts) < 100 || span < 12 * metresPerPixel()) {
      return toast('Hold the mouse button and circle the area to mark it.');
    }
    const mine = [...(state.players.get(state.me.name)?.items.values() || [])];
    if (tool === 'air-cas') { // a gun run on an area: sent straight away, like a point (details can be added with Edit)
      const n = issueNumber('air-cas', mine.filter(i => airKey(i) === 'air-cas').length + 1);
      saveItem({ id: uid(), type: 'area', kind: 'cas', points: pts.map(roundXZ), label: `CAS ${n}`, note: '', color: AIR['air-cas'].color,
        at: Date.now(), status: 'requested', air: {} });
      return;
    }
    if (tool === 'fire-support') {
      const n = issueNumber('fire', mine.filter(isFireReq).length + 1);
      saveItem({ id: uid(), type: 'area', kind: 'fire', fire: state.fireKind, points: pts.map(roundXZ), label: `Fire mission ${n}`, note: '',
        color: FIRE[state.fireKind].color, at: Date.now() });
      return;
    }
    const n = issueNumber('area', mine.filter(isEnemyArea).length + 1);
    saveItem({ id: uid(), type: 'area', kind: 'enemy', points: pts.map(roundXZ), label: `Enemy in area ${n}`, note: '', color: ENEMY, at: Date.now() });
  });
  mapEl.addEventListener('pointercancel', cancelLasso);

  // Middle mouse button pans the map with any tool (handy while the lasso has taken over left-drag). It is handled
  // here in the capture phase so Leaflet doesn't also react to it, and so the browser doesn't start auto-scrolling.
  let midPan = null; // {id, x, y}
  mapEl.addEventListener('pointerdown', e => {
    if (e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    capturePointer(e);
    midPan = { id: e.pointerId, x: e.clientX, y: e.clientY };
    mapEl.classList.add('mid-panning');
  }, true);
  mapEl.addEventListener('mousedown', e => { if (e.button === 1) { e.preventDefault(); e.stopPropagation(); } }, true);
  mapEl.addEventListener('pointermove', e => {
    if (!midPan || e.pointerId !== midPan.id) return;
    map.panBy([midPan.x - e.clientX, midPan.y - e.clientY], { animate: false });
    midPan.x = e.clientX; midPan.y = e.clientY;
  });
  const endMidPan = e => {
    if (!midPan || e.pointerId !== midPan.id) return;
    midPan = null;
    mapEl.classList.remove('mid-panning');
  };
  mapEl.addEventListener('pointerup', endMidPan);
  mapEl.addEventListener('pointercancel', endMidPan);
  mapEl.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); }); // no middle-click paste or link opening

  function handleToolClick(xz) {
    if (!state.me) return;
    if (xz[0] < 0 || xz[1] < 0 || xz[0] > WORLD || xz[1] > WORLD) return toast("That's off the map.");
    const tool = state.tool;
    if (tool === 'marker') {
      const n = [...(state.players.get(state.me.name)?.items.values() || [])].filter(i => i.type === 'marker').length + 1;
      openEditor({ id: uid(), type: 'marker', xz: roundXZ(xz), label: `Marker ${n}`, note: '', icon: 'dot', color: state.me.color }, true);
    } else if (isLassoTool(tool)) {
      // drawn freehand with the lasso (press, circle, let go), so a plain click does nothing
    } else if (tool === 'fire-support') {
      const n = issueNumber('fire', [...(state.players.get(state.me.name)?.items.values() || [])].filter(isFireReq).length + 1);
      saveItem({ id: uid(), type: 'marker', icon: 'fire-point', fire: state.fireKind, xz: roundXZ(xz), label: `Fire mission ${n}`, note: '',
        color: FIRE[state.fireKind].color, at: Date.now() });
    } else if (tool === 'radio') {
      const n = issueNumber('radio', [...(state.players.get(state.me.name)?.items.values() || [])].filter(i => isMarker(i, 'radio')).length + 1);
      saveItem({ id: uid(), type: 'marker', icon: 'radio', xz: roundXZ(xz), label: `Radio ${n}`, note: '', color: state.me.color, ring: state.radioRing });
    } else if (tool === 'route' || LINE_CONSTRUCTS.includes(tool) || ARROW_OF_TOOL[tool]) {
      if (!draw) startDraw(tool, xz); else addDrawPoint(xz);
    } else if (tool === 'range' || tool === 'profile' || tool === 'rocket') {
      if (!draw) startDraw('range', xz);
      else {
        const from = draw.points[0];
        draw.layer.remove(); draw = null;
        if (dist(from, xz) >= 1) {
          const mine = [...(state.players.get(state.me.name)?.items.values() || [])].filter(i => i.type === 'range');
          const id = uid();
          if (tool === 'rocket') { // a range line with the rocket calculator on it, opened as soon as it's drawn
            const [l, r] = state.rkChoice.split('|');
            state.openPopupId = id;
            saveItem({ id, type: 'range', from: roundXZ(from), to: roundXZ(xz), label: `Shot ${mine.filter(i => i.rocket).length + 1}`, note: '',
              color: state.me.color, h1: 1.6, h2: 1, rocket: { l, r, s: SCOPES[l] ? 'scope' : l === 'RPG-7' ? state.rkSight : 'iron' }, ...(state.rkWind ? { wind: state.rkWind } : {}) });
          } else if (tool === 'profile') { // opens its popup, with the profile, as soon as it's drawn
            state.openPopupId = id;
            saveItem({ id, type: 'range', from: roundXZ(from), to: roundXZ(xz), label: `Profile ${mine.filter(i => i.h1 != null && !i.rocket).length + 1}`, note: '', color: state.me.color,
              h1: state.profFrom, h2: state.profTo });
          } else saveItem({ id, type: 'range', from: roundXZ(from), to: roundXZ(xz), label: `Range line ${mine.filter(i => i.h1 == null).length + 1}`, note: '', color: state.me.color });
        }
        updateLive();
      }
    } else if (tool === 'mortar') {
      mortarClick(xz);
    } else if (UNITS[tool]) {
      saveItem({ id: uid(), type: 'marker', icon: tool, xz: roundXZ(xz), label: UNITS[tool], note: '', color: state.me.color, at: Date.now(), ttl: state.unitTtl });
    } else if (tool === 'infantry') {
      const mine = myPosition();
      saveItem({ id: mine ? mine.id : uid(), type: 'marker', icon: 'infantry', xz: roundXZ(xz), label: 'Position',
        note: mine ? mine.note : '', color: mine ? mine.color : state.me.color, at: Date.now(), range: state.posRange, unit: state.posUnit });
    } else if (POINT_CONSTRUCTS.includes(tool)) {
      const n = issueNumber(tool, [...(state.players.get(state.me.name)?.items.values() || [])].filter(i => i.type === 'construct' && i.kind === tool).length + 1);
      saveItem({ id: uid(), type: 'construct', kind: tool, xz: roundXZ(xz), label: `${CONSTRUCT_NAME[tool]} ${n}`, note: '', color: state.me.color });
    } else if (tool === 'emplacement') {
      emplClick(xz);
    } else if (MINES[tool]) {
      saveItem({ id: uid(), type: 'marker', icon: tool, xz: roundXZ(xz), label: MINES[tool], note: '', color: state.me.color });
    } else if (MARKER_TOOLS[tool]) {
      // Rally points, objectives and dangers are markers with that symbol, named and described in the editor.
      const n = issueNumber(tool, [...(state.players.get(state.me.name)?.items.values() || [])].filter(i => i.type === 'marker' && i.icon === tool).length + 1);
      openEditor({ id: uid(), type: 'marker', icon: tool, xz: roundXZ(xz), label: `${MARKER_TOOLS[tool]} ${n}`, note: '',
        color: tool === 'danger' ? '#ffc53d' : state.me.color }, true);
    } else if (HAZARDS[tool]) {
      saveItem({ id: uid(), type: 'marker', icon: tool, xz: roundXZ(xz), label: HAZARDS[tool], note: '', color: ENEMY, at: Date.now() });
    } else if (tool === 'contact') {
      openEditor({ id: uid(), type: 'marker', icon: 'contact', xz: roundXZ(xz), label: 'Contact', note: '', color: ENEMY, at: Date.now(),
        what: '', size: '', activity: '', kit: '', heading: null, ttl: state.contactTtl, ...(clock ? { gt: Math.floor(gameAt() % 86400) } : {}) }, true);
    } else if (tool === 'trp') {
      // Numbered across the whole squad so "TRP 3" means the same point to everyone.
      // Numbers handed out in the last few seconds count as used too, in case the server hasn't echoed them back yet.
      const used = new Set(allVisibleItems(i => i.type === 'marker' && i.icon === 'trp').map(({ it }) => (/^TRP (\d+)/.exec(it.label || '') || [])[1]));
      trpIssued.forEach((t, k) => { if (Date.now() - t < 5000) used.add(k); else trpIssued.delete(k); });
      let n = 1;
      while (used.has(String(n))) n++;
      trpIssued.set(String(n), Date.now());
      openEditor({ id: uid(), type: 'marker', icon: 'trp', xz: roundXZ(xz), label: `TRP ${n}`, note: '', color: state.me.color }, true);
    } else if (tool === 'vehicle-view-f' && !state.armourRange) {
      saveItem({ id: uid(), type: 'marker', icon: 'unit-arm-f', xz: roundXZ(xz), label: UNITS['unit-arm-f'], note: '', color: state.me.color, at: Date.now() });
    } else if (postSideOf(tool)) {
      const side = postSideOf(tool), range = side === 'fv' ? state.armourRange : state.postRange;
      const n = issueNumber(`post-${side}`, [...(state.players.get(state.me.name)?.items.values() || [])].filter(i => i.type === 'post' && i.side === side).length + 1);
      saveItem({ id: uid(), type: 'post', side, xz: roundXZ(xz), range,
        label: `${POST_KIND[side].label} ${n}`, note: '', color: side === 'f' ? state.me.color : ENEMY });
    } else if (tool === 'ambush' || tool === 'sectors') {
      shapeClick(xz);
    } else if (tool === 'audible') {
      saveItem({ id: uid(), type: 'audible', xz: roundXZ(xz), gun: state.hearGun, label: GUNS[state.hearGun].name, note: '', color: state.me.color });
    } else if (tool === 'hulldown') {
      const n = [...(state.players.get(state.me.name)?.items.values() || [])].filter(i => i.type === 'hulldown').length + 1;
      saveItem({ id: uid(), type: 'hulldown', xz: roundXZ(xz), range: state.hdRange, veh: state.hdVeh, foe: state.hdFoe, label: `Hull-down ${n}`, note: '', color: state.me.color });
    } else if (tool === 'overwatch') {
      const n = issueNumber('overwatch', [...(state.players.get(state.me.name)?.items.values() || [])].filter(i => i.type === 'overwatch').length + 1);
      saveItem({ id: uid(), type: 'overwatch', xz: roundXZ(xz), range: state.owRange, label: `Overwatch ${n}`, note: '', color: state.me.color });
    } else if (tool === 'cover-route') {
      state.routeMode === 'air' ? heliClick(xz) : coverClick(xz);
    } else if (tool === 'heli-route') {
      heliClick(xz);
    } else if (tool === 'aa-e') {
      aaClick(xz);
    } else if (tool === 'aa-f') {
      const n = issueNumber('aa-f', [...(state.players.get(state.me.name)?.items.values() || [])].filter(i => isMarker(i, 'aa-f')).length + 1);
      saveItem({ id: uid(), type: 'marker', icon: 'aa-f', xz: roundXZ(xz), label: `AA ${n}`, note: '', color: '#6cb8ff' });
    } else if (AIR[tool]) {
      const n = issueNumber(tool, [...(state.players.get(state.me.name)?.items.values() || [])].filter(i => airKey(i) === tool).length + 1);
      const req = { id: uid(), type: 'marker', icon: tool, xz: roundXZ(xz), label: `${AIR[tool].short} ${n}`, note: '', color: AIR[tool].color,
        at: Date.now(), status: 'requested', air: {} };
      // A gun run goes out at once, since there's rarely time for a form; the others ask for their details first.
      tool === 'air-cas' ? saveItem(req) : openEditor(req, true);
    } else if (tool === 'lz') {
      const n = issueNumber('lz', [...(state.players.get(state.me.name)?.items.values() || [])].filter(i => isMarker(i, 'lz')).length + 1);
      saveItem({ id: uid(), type: 'marker', icon: 'lz', xz: roundXZ(xz), label: `LZ ${n}`, note: '', color: state.me.color });
    }
  }

  function updateGhost() {
    if (!draw) return;
    const last = draw.points[draw.points.length - 1];
    draw.ghost.setLatLngs(lastCursor && last ? [toLL(last), toLL(lastCursor)] : []);
    updateLive();
  }

  function updateLive() {
    const live = $('#live');
    live.style.color = '';
    if (state.tool === 'mortar') { live.classList.toggle('hidden', !mortarLive(live)); return; }
    if (shapeDraft) {
      const d = shapeDraft, c = lastCursor;
      let text = '';
      if (d.tool === 'sectors' && c) text = `Radius ${fmtDist(dist(d.pts[0], c))} · first line ${pad(Math.round(bearing(d.pts[0], c)) % 360, 3)}° · ${state.sectorCount} sectors`;
      else if (d.pts.length === 1 && c) text = `Kill zone ${fmtDist(dist(d.pts[0], c))} · ${fmtBearing(bearing(d.pts[0], c))}`;
      else if (d.pts.length === 2) text = `Kill zone ${fmtDist(dist(d.pts[0], d.pts[1]))} · click the side your squad waits on`;
      live.textContent = text;
      live.classList.toggle('hidden', !text);
      return;
    }
    if (state.tool === 'lz') {
      const c = lastCursor && lzAssess(lastCursor);
      if (c) {
        live.textContent = `${LZ_WORD[c.verdict]}${c.reasons.length ? `: ${c.reasons.join(', ')}` : ''} · slope ${Math.round(c.deg)}° · ` +
          `approaches ${c.open.length ? c.open.join(' ') : 'none'}`;
        live.style.color = LZ_COLOR[c.verdict];
      }
      live.classList.toggle('hidden', !c);
      return;
    }
    if (state.tool === 'emplacement') {
      const on = emplDraft && lastCursor;
      if (on) live.textContent = `Facing ${fmtBearing(bearing(emplDraft.xz, lastCursor))} · Range ${fmtDist(dist(emplDraft.xz, lastCursor))} · Arc ${state.arc}°` +
        (emplDraft.pct != null ? ` · Sees ${emplDraft.pct}%${emplDraft.treePct ? ` (+${emplDraft.treePct}% trees)` : ''}` : '');
      live.classList.toggle('hidden', !on);
      return;
    }
    if (!draw || !lastCursor || !draw.points.length) { live.classList.add('hidden'); return; }
    const last = draw.points[draw.points.length - 1];
    const seg = dist(last, lastCursor);
    let text = `${fmtDist(seg)} · ${fmtBearing(bearing(last, lastCursor))}`;
    if (draw.points.length > 1) text += ` · Σ ${fmtDist(pathLength(draw.points) + seg)}`;
    live.textContent = text;
    live.classList.remove('hidden');
  }

  map.on('click', e => {
    if (state.contactMove) { finishContactMove(toXZ(e.latlng)); return; }
    if (state.tool === 'pan') return;
    handleToolClick(toXZ(e.latlng));
  });
  map.on('dblclick', () => { if (draw && draw.tool !== 'range') finishDraw(); });
  map.on('contextmenu', e => {
    if (emplDraft) { cancelEmplDraft(); return; }
    if (shapeDraft) { cancelShapeDraft(); return; }
    if (coverDraft) { cancelCoverDraft(); map.closePopup(); return; }
    if (aaDraft) { cancelAaDraft(); return; }
    if (draw) { if (draw.tool === 'range') { draw.layer.remove(); draw = null; updateLive(); } else finishDraw(); return; }
    const xz = toXZ(e.latlng);
    popup().setLatLng(e.latlng).setContent(popupHtml('Location', `X ${Math.round(xz[0])} · Z ${Math.round(xz[1])}`, xz)).openOn(map);
  });
  map.on('mousemove', e => {
    lastCursor = toXZ(e.latlng);
    const alt = state.tool === 'mortar' || map.hasLayer(contourLayer) ? heightAt(lastCursor) : null;
    $('#cursor-grid').textContent = alt == null ? grid(lastCursor) : `${grid(lastCursor)} · ${Math.round(alt)} m`;
    updateGhost();
    if (state.tool === 'mortar') { updateMortarGhost(); updateLive(); }
    if (emplDraft) { updateEmplDraft(); updateLive(); }
    if (shapeDraft) { updateShapeDraft(); updateLive(); }
    if (state.tool === 'lz') updateLive();
    if (aaDraft) updateAaDraft();
  });
  map.on('mouseout', () => {
    lastCursor = null;
    if (draw) { draw.ghost.setLatLngs([]); updateLive(); }
    if (state.tool === 'mortar') { updateMortarGhost(); updateLive(); }
  });

  document.addEventListener('keydown', e => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
    if (e.key === 'Escape') {
      if (!$('#editor').classList.contains('hidden')) { closeEditor(); return; }
      if (state.contactMove) { state.contactMove = null; updateHint(); return; }
      if (openGroup) { closeMenus(); return; }
      if (typing) { document.activeElement.blur(); return; }
      if (emplDraft) { cancelEmplDraft(); return; }
      if (shapeDraft) { cancelShapeDraft(); return; }
      if (coverDraft) { cancelCoverDraft(); map.closePopup(); return; }
      if (aaDraft) { cancelAaDraft(); return; }
      if (lasso) { cancelLasso(); return; }
      if (draw) {
        if (draw.tool === 'range') { draw.layer.remove(); draw = null; updateLive(); } else finishDraw();
      } else if (state.tool !== 'pan') setTool('pan');
      else map.closePopup();
      return;
    }
    const modalOpen = ['#editor', '#join', '#palette'].some(s => !$(s).classList.contains('hidden'));
    if (typing || modalOpen || !state.me || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Enter' && draw) { finishDraw(); e.preventDefault(); return; }
    if (e.key === 'Backspace' && draw) { undoDrawPoint(); e.preventDefault(); return; }
    // Numbers: pick from an open menu, otherwise choose an option for the current tool.
    if (/^[0-9]$/.test(e.key)) {
      if (openGroup) return pickFromOpenMenu(+e.key || 10);
      if (e.key === '0') return;
      if (state.tool === 'emplacement' && e.key <= '4') return setArc([30, 60, 90, 120][+e.key - 1]);
      const opt = pickerOptions(state.tool)[+e.key - 1];
      if (opt) setPickerValue(...opt);
      return;
    }
    const k = e.key.toLowerCase();
    if (k === 'q') return setTool('pan');
    const group = TOOLBOX.find(g => g.key.toLowerCase() === k);
    if (group) toggleMenu(group.id);
  });

  // ---------------------------------------------------------------------------
  // Mortar: terrain heights + in-game firing tables
  // ---------------------------------------------------------------------------
  let HN = 1300;                 // cells per side of the 10 m grids; each map's los/index.json gives its own (light.cols)
  const HCELL = 10;              // metres per cell, row 0 = south edge
  let HEIGHT = null;             // Int16Array of decimetres
  let TABLES = null;             // {weapons: {M252: {label, milsPerCircle, shells: {name: {ring: {dispersion, table}}}}}}
  state.mortarWeapon = 'M252';
  state.mortarShell = 'HE M821';
  state.mortarPlacing = false;

  function heightAt([x, z]) {
    if (!HEIGHT) return null;
    const fx = Math.min(Math.max(x / HCELL - 0.5, 0), HN - 1), fz = Math.min(Math.max(z / HCELL - 0.5, 0), HN - 1);
    const c0 = Math.floor(fx), r0 = Math.floor(fz), c1 = Math.min(c0 + 1, HN - 1), r1 = Math.min(r0 + 1, HN - 1);
    const tx = fx - c0, tz = fz - r0;
    const v = (r, c) => HEIGHT[r * HN + c] / 10;
    const south = v(r0, c0) + (v(r0, c1) - v(r0, c0)) * tx;
    const north = v(r1, c0) + (v(r1, c1) - v(r1, c0)) * tx;
    return south + (north - south) * tz;
  }

  // Exact heights and objects for the few spots that need them (the mortar and its targets, landing zones): the same
  // 500 m full-detail tiles static/los-worker.js reads - terrain every 1 m and what stands on every 0.5 m, all
  // measured by the game engine - fetched here when first needed and kept. Until a tile arrives the 10 m heights
  // stand in, and the mortar and landing zones redo themselves when it lands.
  const SEA = 'sea';
  let detailIndex = null, detailV = 0, TERRAIN_UNIT = 0.01; // metres per step of a tile's terrain values
  const detailTiles = new Map(), detailLoading = new Set();
  let detailRedraw = 0;
  // The map's line-of-sight index: which 500 m tiles exist, the version that busts the browser's cache, and the units.
  // Resolves to the index (or null) once read, so the 10 m grids can take their size from it.
  function loadDetailIndex() {
    if (typeof DecompressionStream === 'undefined') return Promise.resolve(null);
    return fetch(`${mapLosDir()}/index.json`, { cache: 'no-cache' }).then(r => r.json())
      .then(ix => {
        detailIndex = new Set(ix.tiles); detailV = ix.version;
        TERRAIN_UNIT = (ix.terrain && ix.terrain.unit) || 0.01;
        afterDetail();
        return ix;
      })
      .catch(err => { console.error('Detail tiles not available', err); return null; });
  }
  // A tile (or SEA for open water), or undefined while it loads or when there's no detail to be had.
  function detailTile(x, z) {
    if (!detailIndex || x < 0 || z < 0 || x >= WORLD || z >= WORLD) return undefined;
    const tx = Math.floor(x / 500), tz = Math.floor(z / 500), name = `${tx}_${tz}`;
    if (detailTiles.has(name)) return detailTiles.get(name);
    if (!detailIndex.has(name)) return SEA;
    if (!detailLoading.has(name)) {
      detailLoading.add(name);
      fetch(`${mapLosDir()}/${name}.bin.gz?v=${detailV}`)
        .then(r => { if (!r.ok) throw new Error(r.status); return new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(); })
        .then(buf => {
          const o = 501 * 501 * 2, n = 1000 * 1000;
          detailTiles.set(name, { x0: tx * 500, z0: tz * 500, ter: new Uint16Array(buf, 0, 501 * 501),
            top: new Uint8Array(buf, o, n), kind: new Uint8Array(buf, o + 2 * n, n) });
          while (detailTiles.size > 16) detailTiles.delete(detailTiles.keys().next().value);
          detailLoading.delete(name);
          clearTimeout(detailRedraw);
          detailRedraw = setTimeout(afterDetail, 50);
        })
        .catch(err => { detailLoading.delete(name); console.error(`Detail tile ${name}`, err); });
    }
    return undefined;
  }
  let detailGen = 0; // counts detail-tile arrivals, so results built on the 1 m heights are redone when more arrive
  function afterDetail() {
    lzCache.clear();
    detailGen++;
    Mortar.invalidateTerrain();
    rerenderMortars();
    state.players.forEach(p => p.items.forEach(it => { if (isMarker(it, 'lz') || airKey(it) || isFireReq(it) || it.type === 'hulldown') renderItem(p, it); }));
    refreshLists();
    if (state.tool === 'lz' || state.tool === 'mortar') updateLive();
  }
  // Ground height (m) from the engine's 1 m terrain, or the 10 m heights while the tile loads.
  function groundFine([x, z]) {
    const t = detailTile(x, z);
    if (t === SEA) return 0;
    if (!t) return heightAt([x, z]);
    const lx = Math.min(Math.max(x - t.x0, 0), 499.999), lz = Math.min(Math.max(z - t.z0, 0), 499.999);
    const c = Math.floor(lx), r = Math.floor(lz), fx = lx - c, fz = lz - r, T = t.ter;
    const a = T[r * 501 + c], b = T[r * 501 + c + 1], d = T[(r + 1) * 501 + c], e = T[(r + 1) * 501 + c + 1];
    return ((a + (b - a) * fx) * (1 - fz) + (d + (e - d) * fx) * fz) * TERRAIN_UNIT;
  }
  // What stands on the 0.5 m spot: {kind: 1 building, 2 wall/rock/pole/prop, 3 tree, 4 see-through fence, 5 bush, top: m}.
  function objectAt([x, z]) {
    const t = detailTile(x, z);
    if (!t || t === SEA) return null;
    const c = Math.min(999, Math.floor((x - t.x0) * 2)), r = Math.min(999, Math.floor((z - t.z0) * 2)), k = r * 1000 + c;
    return t.kind[k] ? { kind: t.kind[k], top: t.top[k] / 4 } : null;
  }
  // Loaded for every tile a box touches? (Starts the missing ones loading.)
  function detailReady(x0, z0, x1, z1) {
    let ok = !!detailIndex;
    for (let x = Math.floor(x0 / 500) * 500; x <= x1; x += 500) for (let z = Math.floor(z0 / 500) * 500; z <= z1; z += 500) {
      if (detailTile(Math.max(x, x0), Math.max(z, z0)) === undefined) ok = false;
    }
    return ok;
  }
  // Where a round aimed at xz lands: the roof if it's on a building, else the ground.
  function impactHeight(xz) {
    const g = groundFine(xz), o = objectAt(xz);
    return o && o.kind === 1 ? { h: g + o.top, roof: o.top } : { h: g, roof: 0 };
  }

  const weaponDef = w => TABLES && TABLES.weapons[w];
  const shellDef = (w, s) => weaponDef(w) && weaponDef(w).shells[s];

  function shellLimits(w, s) {
    const rings = Object.values(shellDef(w, s) || {});
    if (!rings.length) return null;
    return { min: Math.min(...rings.map(r => r.table[0][0])), max: Math.max(...rings.map(r => r.table[r.table.length - 1][0])) };
  }

  const fieldMortar = Mortar.field({ tables: () => TABLES, ground: groundFine, impact: impactHeight,
    height: heightAt, hasHeight: () => !!HEIGHT, world: () => WORLD });
  const { solve, reachOutline, reachToward, autoBandPolys } = fieldMortar;
  const windParts = Mortar.windParts;
  const chargeOf = m => (Number.isInteger(m && m.charge) ? m.charge : null);
  const solveFor = (m, to, shell = m.shell) => solve(m.weapon, shell, m.xz, to, m.wind, chargeOf(m));
  const RING_COLORS = ['#ffd43b', '#ff922b', '#f783ac', '#da77f2', '#74c0fc'];

  // "2.88–3.08 km" (or one figure when it hardly varies)
  const fmtReach = (a, b) => (b - a < 15 ? fmtDist(b) : b < 1000 ? `${Math.round(a)}–${Math.round(b)} m` : `${(a / 1000).toFixed(2)}–${(b / 1000).toFixed(2)} km`);
  // "ring 3" / "rings 1, 2"
  const ringList = rs => `ring${rs.length > 1 ? 's' : ''} ${rs.join(', ')}`;
  // Why mortar m can't hit a target: too close for every ring, or past the furthest reach that way. With a ring set,
  // why that ring can't, and which rings could.
  function outOfRangeText(m, to, shell = m.shell) {
    const w = m.weapon, s = shell, d = dist(m.xz, to), sol = solveFor(m, to, shell), ch = sol.charge;
    if (ch != null) {
      const others = sol.rings.map(r => r.ring), alt = others.length ? ` · ${ringList(others)} can` : '';
      const min = shellDef(w, s)[ch].table[0][0], r = reachToward(w, s, m.xz, to, m.wind, ch);
      if (r != null && d > r) return `Ring ${ch} reaches ${fmtDist(r)} this way${alt}`;
      return `Too close for ring ${ch}${d < min ? ` (at least ${fmtDist(min)})` : ''}${alt}`;
    }
    const lim = shellLimits(w, s);
    if (lim && d < lim.min) return `Too close (at least ${fmtDist(lim.min)})`;
    const r = reachToward(w, s, m.xz, to, m.wind);
    return r != null ? `Out of range (reaches ${fmtDist(r)} this way)` : `Out of range (max ${fmtDist(lim ? lim.max : 0)})`;
  }

  const myMortar = () => {
    const me = state.me && state.players.get(state.me.name);
    return me ? [...me.items.values()].find(i => i.type === 'mortar') : null;
  };
  // Another player's mortar whose firing solutions you've chosen to see (its popup's "Show its solutions" button), so a
  // mortar team can all read the same numbers. Remembered in this browser; it wins over your own mortar while it's on
  // the map, and your own takes over again if it goes.
  const FOLLOW_KEY = 'everon-map-follow-mortar';
  state.followMortar = (() => { try { return localStorage.getItem(FOLLOW_KEY) || null; } catch { return null; } })();
  const followedMortar = () => (state.followMortar && allVisibleItems(i => i.type === 'mortar' && i.id === state.followMortar)[0]) || null;
  // The mortar whose solutions fire requests show: the one you follow, else your own. {p, it} or null.
  const solutionMortar = () => {
    const f = followedMortar();
    if (f) return f;
    const m = myMortar();
    return m ? { p: state.players.get(state.me.name), it: m } : null;
  };
  function setFollowMortar(id) {
    state.followMortar = id;
    try { if (id) localStorage.setItem(FOLLOW_KEY, id); else localStorage.removeItem(FOLLOW_KEY); } catch { /* storage unavailable */ }
    fireSigLast = null;
    refreshLists();
    state.players.forEach(p => p.items.forEach(it => { if (it.type === 'mortar') renderItem(p, it); }));
  }

  function mortarHint() {
    if (!TABLES) return 'Loading firing tables…';
    if (!myMortar() || state.mortarPlacing) return 'Click the map to place your mortar';
    return 'Click a target for a firing solution · move the mouse for a live solution';
  }

  const noReach = sol => (sol.charge != null ? `ring ${sol.charge} can't reach` : 'out of range');
  function fmtSolution(sol, short = false) {
    const az = `${pad(Math.round(sol.az) % 360, 3)}° / ${Math.round(sol.azMil)} mil`;
    const dh = `${sol.dh >= 0 ? '+' : '−'}${Math.abs(Math.round(sol.dh))} m`;
    if (!sol.best) return `${sol.charge != null ? `Ring ${sol.charge} can't reach` : 'Out of range'} · ${fmtDist(sol.d)}`;
    const b = sol.best;
    return short
      ? `Ring ${b.ring} · ${Math.round(b.elev)} mil · Az ${Math.round(sol.azMil)} · ${b.tof.toFixed(1)} s`
      : `Ring ${b.ring} · Elev ${Math.round(b.elev)} mil · Az ${az} · ${fmtDist(sol.d)} · Δh ${dh}${sol.roof ? ` (a roof, ${Math.round(sol.roof)} m up)` : ''} · ${b.tof.toFixed(1)} s`;
  }

  function solutionTable(sol) {
    if (!sol.rings.length) return '';
    const az = !!sol.wind; // with wind each ring aims off differently
    return `<table class="fire"><tr><th>Ring</th><th>Elev</th>${az ? '<th>Az</th>' : ''}<th>Time</th><th>Spread</th></tr>` +
      sol.rings.map(r => `<tr class="${r === sol.best ? 'best' : ''}"><td>${r.ring}</td><td>${Math.round(r.elev)} mil</td>` +
        `${az ? `<td>${Math.round(r.azMil)}</td>` : ''}<td>${r.tof.toFixed(1)} s</td><td>${r.spread ? `±${r.spread.long} / ±${r.spread.side} m` : `±${r.dispersion} m`}</td></tr>`).join('') +
      `</table>`;
  }
  // "Wind 6 m/s from 240° · aim 4 mil left" for the ring used
  function windLine(sol) {
    if (!sol.wind || !sol.best) return '';
    const a = Math.round(sol.best.azAdj);
    return `<p class="sub">Wind ${sol.wind.s} m/s from ${pad(Math.round(sol.wind.d) % 360, 3)}° · ` +
      `${a ? `aim ${Math.abs(a)} mil ${a < 0 ? 'left' : 'right'}` : 'no aim-off needed'} (included above)</p>`;
  }

  // A mortar's reach: with a ring set, that ring's; on auto, from the shortest any ring fires to the longest ring's outline.
  // {min, max} m from the tables, top: the outline ring (reachOutline) or null, ring: the ring set or null.
  function mortarReach(m) {
    const rings = shellDef(m.weapon, m.shell), ch = chargeOf(m), ring = ch != null && rings && rings[ch] ? ch : null;
    const outline = reachOutline(m.weapon, m.shell, m.xz, m.wind);
    if (ring == null) {
      const lim = shellLimits(m.weapon, m.shell);
      return lim && { ...lim, top: outline && outline.rings[outline.rings.length - 1], ring };
    }
    const t = rings[ring].table;
    return { min: t[0][0], max: t[t.length - 1][0], top: outline && outline.rings.find(o => o.ring === ring), ring };
  }

  function mortarInfoHtml(m) {
    const W = weaponDef(m.weapon), lim = mortarReach(m), alt = heightAt(m.xz), top = lim && lim.top;
    let html = `<p><b>${esc(W ? W.label : m.weapon)}</b> · ${esc(m.shell)} · ${lim && lim.ring != null ? `ring ${lim.ring}` : 'auto ring'}</p>` +
      (m.wind ? `<div class="sub">Wind ${m.wind.s} m/s from ${pad(Math.round(m.wind.d) % 360, 3)}° (in its solutions)</div>` : '');
    if (myMortar()?.id !== m.id) {
      const on = state.followMortar === m.id;
      html += `<div class="row"><button data-follow-mortar="${on ? '' : esc(m.id)}" aria-pressed="${on}">` +
        `${on ? 'Stop using its solutions' : 'Use its solutions'}</button></div>`;
    }
    if (alt != null) html += `<div class="sub">Altitude ${Math.round(alt)} m</div>`;
    if (lim && top) html += `<div class="sub">Reach ${fmtDist(lim.min)} to ${esc(fmtReach(top.near, top.far))}, by direction: further downhill and downwind</div>`;
    else if (lim) html += `<div class="sub">Reach ${fmtDist(lim.min)} – ${fmtDist(lim.max)}</div>`;
    html += `<div class="sub">Heard: firing ${fmtDist(GUNS.mortar.range)} · impacts ${fmtDist(impactHeard(m.shell))} (${esc(NOISE.find(n => n[0] === state.noise)[1].toLowerCase())})</div>` +
      `<div class="row"><button data-act="hear-mortar" aria-pressed="${state.hearMortar}">${state.hearMortar ? 'Hide' : 'Show'} sound ranges on the map</button></div>`;
    const reqs = allVisibleItems(isFireReq);
    if (reqs.length && TABLES) {
      html += '<table class="fire trp-table"><tr><th>Fire request</th><th>Shell</th><th>Solution</th></tr>' + reqs.map(({ p, it }) => {
        const { shell, sol } = fireSolution(m, it);
        return `<tr><td>${esc(it.label || 'Fire mission')} · ${(FIRE[it.fire] || FIRE.he).name}${isMine(p.name) ? '' : ` (${esc(p.name)})`}</td>` +
          `<td>${esc(shell)}</td><td>${fmtSolution(sol, true)}</td></tr>`;
      }).join('') + '</table>';
    }
    return html;
  }

  // What one round does to soldiers around where it bursts, measured in the game (reforger-map-tools blasttest.py: real
  // shells dropped among the game's riflemen on open ground, about 9,000 of them):
  //   kill:   half of those standing go down (dead, or unconscious where the server allows it) this close;
  //   danger: 1 in 10 is still wounded this far out; past it the fragments stop, and nobody was touched.
  // The angle a round comes down at and the side of the burst made no difference, so the zones are round. The practice
  // round has a small blast charge and the smoke rounds the HE warhead with a small charge, so they hurt too, close in.
  // Illumination rounds carry no explosive (a time fuze releases a flare).
  const BLAST = {
    'HE M821': { kill: 18, danger: 27 },
    'HE O-832DU': { kill: 11, danger: 16 },
    'Practice M879': { kill: 0, danger: 5 },
    'Smoke M819': { kill: 0, danger: 5 },
    'Smoke D-832DU': { kill: 0, danger: 5 },
  };
  const blastOf = shell => BLAST[shell] || null;
  // The worst of a fire request's kind (HE, smoke, illumination), for when no mortar in range says which shell it is
  const worstBlast = re => Object.entries(BLAST).filter(([s]) => re.test(s)).map(([s, b]) => ({ shell: s, ...b }))
    .sort((a, b) => b.danger - a.danger)[0] || null;
  // Where rounds land around an aim point. The target zone is the spread: with the shell's physics an ellipse along the
  // line of fire holding 90% of the rounds (see spreadOf), otherwise a circle the range table's average dispersion across.
  // Around it, from BLAST: the kill zone (dashed red: a round landing on the spread's edge downs half of those standing
  // this far out) and the danger zone (dashed yellow: wounds this far out). A shell that hurts nobody shows only its
  // spread, in its own colour.
  const shellColor = shell => (/^Smoke/.test(shell) ? FIRE.smoke.color : /^Illum/.test(shell) ? FIRE.illum.color : '#adb5bd');
  // An ellipse around xz, `long` m along bearing az and `side` m across it (half-lengths), grown by `grow` m all round.
  function ellipseLL(xz, sh, grow = 0) {
    const a = sh.az * Math.PI / 180, L1 = sh.long + grow, S1 = sh.side + grow, pts = [];
    for (let i = 0; i < 48; i++) {
      const t = i / 48 * 2 * Math.PI, u = L1 * Math.cos(t), s = S1 * Math.sin(t);
      pts.push(toLL([xz[0] + u * Math.sin(a) + s * Math.cos(a), xz[1] + u * Math.cos(a) - s * Math.sin(a)]));
    }
    return pts;
  }
  function impactZones(layer, xz, spread, shell, color, shape = null) {
    const zone = (grow, style) => (shape ? L.polygon(ellipseLL(xz, shape, grow), style) : L.circle(toLL(xz), { radius: spread + grow, ...style }));
    const b = blastOf(shell);
    if (b) layer.addLayer(zone(b.danger, { color: '#ffd43b', weight: 1.8, dashArray: '6 5', fillColor: '#ffd43b', fillOpacity: 0.12, interactive: false }));
    if (b && b.kill) {
      layer.addLayer(zone(b.kill, { color: '#ff5c5c', weight: 1.8, dashArray: '6 5', fillColor: '#ff5c5c', fillOpacity: 0.1, interactive: false }));
      if (spread) layer.addLayer(zone(0, { color: '#ff2b2b', weight: 2, fillColor: '#ff2b2b', fillOpacity: 0.35, interactive: false }));
    } else if (spread) {
      layer.addLayer(zone(0, { color, weight: 1.8, dashArray: '5 4', fillColor: color, fillOpacity: 0.16, interactive: false }));
    }
  }
  // "90% land ±45 m long/short, ±12 m left/right · kill +18 m · danger +27 m"
  // (or the circle's size without the physics), and any friendlies inside the danger zone.
  function impactText(shell, spread, xz, shape = null) {
    const where = shape ? `90% land ±${shape.long} m long/short, ±${shape.side} m left/right` : spread ? `Rounds land within about ${spread} m` : '';
    const b = blastOf(shell);
    if (!b) return { zone: where, near: [] };
    const hurt = [b.kill && `kill +${b.kill} m`, `danger +${b.danger} m`];
    return { zone: [where, ...hurt].filter(Boolean).join(' · '), near: friendliesNear({ xz }, spread + b.danger) };
  }
  const friendlyWarning = near => (near.length
    ? `<p><b class="rc-no">Friendlies in the danger zone</b>: ${near.slice(0, 6).map(x => `${esc(x.name)} ${x.d < 1 ? '(inside)' : fmtDist(x.d)}`).join(', ')}</p>` : '');

  function targetPopup(owner, m, idx) {
    const t = m.targets[idx];
    const sol = solveFor(m, t);
    const W = weaponDef(m.weapon);
    const dh = sol.hTo != null ? `${sol.dh >= 0 ? '+' : '−'}${Math.abs(Math.round(sol.dh))} m` : '—';
    let extra = `<div class="stats">` +
      `<div><span class="k">Distance</span><span class="v">${fmtDist(sol.d)}</span></div>` +
      `<div><span class="k">Azimuth</span><span class="v">${Math.round(sol.azMil)} mil</span></div>` +
      `<div><span class="k">Height Δ</span><span class="v">${dh}</span></div></div>` +
      `<div class="sub" style="margin-top:5px">${pad(Math.round(sol.az) % 360, 3)}° · ${W ? W.milsPerCircle : 6400}-mil scale` +
      (sol.hTo != null ? ` · target ${Math.round(sol.hTo)} m, mortar ${Math.round(sol.hFrom)} m` : '') + `</div>`;
    if (sol.best) {
      const z = impactText(m.shell, sol.best.dispersion, t, sol.best.spread);
      extra += `<p>${z.zone}</p>${friendlyWarning(z.near)}`;
    }
    extra += sol.rings.length ? solutionTable(sol) + windLine(sol)
      : `<p style="color:var(--danger)">${esc(outOfRangeText(m, t))} for ${esc(m.shell)}</p>`;
    if (sol.best) extra += nudgeTable(nudges(m, m.shell, t, sol), `Adjust ${NUDGE_M} m · ring ${sol.best.ring}`);
    if (isMine(owner)) extra += `<div class="row"><button class="danger" data-act="del-target" data-idx="${idx}">Remove target</button></div>`;
    return popupHtml(`Target ${idx + 1}`, `${m.weapon} ${m.shell} · by ${owner}${isMine(owner) ? ' (you)' : ''}`, t, extra);
  }

  function renderMortar(p, m, layer, color, html) {
    const center = toLL(m.xz);
    const rings = shellDef(m.weapon, m.shell) || {}, lim = mortarReach(m);
    const entries = Object.entries(rings).filter(([ring]) => !lim || lim.ring == null || +ring === lim.ring).sort((a, b) => +a[0] - +b[0]);
    const mine = isMine(p.name);
    // (On Auto, bands instead of whole rings: see autoBandPolys.)
    // Each ring's reach (only the ring set, when there is one): with the shell's physics an outline over the real ground
    // in the mortar's wind (further downhill and downwind), labelled with its shortest and longest; otherwise the table's
    // flat circle. Plus the minimum distance. To stand out over any terrain each ring is a solid line in its own colour
    // (RING_COLORS, warm to cool outwards) on a dark outline of its own, with a faint fill, so where rings overlap the
    // fill deepens: a point inside more rings is reachable with more of them. The labels sit on the north-east diagonal,
    // clear of one another, in a pill with the ring's colour round it.
    const ringStyle = ring => {
      const c = RING_COLORS[ring] || color;
      return { casing: { color: '#080b0e', weight: mine ? 5 : 4, opacity: mine ? 0.6 : 0.4, fill: false, interactive: false },
        line: { color: c, weight: mine ? 2.4 : 1.8, opacity: mine ? 1 : 0.7, fillColor: c, fillOpacity: mine ? 0.06 : 0.03, interactive: false } };
    };
    const ringLabel = (xz, text, ring) => L.marker(toLL(xz), { interactive: false, keyboard: false,
      icon: L.divIcon({ className: '', iconSize: [0, 0],
        html: `<span class="ring-label" style="--c:${RING_COLORS[ring] || color}${mine ? '' : ';opacity:.75'}">${text}</span>` }) });
    const outline = reachOutline(m.weapon, m.shell, m.xz, m.wind);
    // On Auto only the ring the mortar would use is shown at each distance: bands (ring 3 over most of the range), each
    // out to where Auto hands over to the next ring, or to that ring's own reach over the ground and wind if that's less.
    // With a ring set, its whole reach (below).
    const bands = lim && lim.ring == null ? autoBandPolys(m.weapon, m.shell, m.xz, outline) : null;
    if (bands) {
      bands.forEach(b => {
        const st = ringStyle(b.ring), outer = b.pts.map(toLL);
        layer.addLayer(L.polygon(b.inner ? [outer, b.inner.map(toLL)] : outer, { ...st.line, stroke: false }));
        layer.addLayer(L.polygon(outer, st.casing));
        layer.addLayer(L.polygon(outer, { ...st.line, fill: false }));
        layer.addLayer(ringLabel(b.pts[Math.round(b.pts.length / 8)], `R${b.ring} to ${esc(fmtReach(b.near, b.far))}`, b.ring));
      });
    }
    (bands ? [] : entries).forEach(([ring, def]) => {
      const r = outline && outline.rings.find(o => o.ring === +ring), st = ringStyle(+ring);
      if (r) {
        layer.addLayer(L.polygon(r.pts.map(toLL), st.casing));
        layer.addLayer(L.polygon(r.pts.map(toLL), st.line));
        layer.addLayer(ringLabel(r.pts[Math.round(r.pts.length / 8)], `R${ring} ${esc(fmtReach(r.near, r.far))}`, +ring));
        return;
      }
      const max = def.table[def.table.length - 1][0], d = max * Math.SQRT1_2;
      layer.addLayer(L.circle(center, { radius: max, ...st.casing }));
      layer.addLayer(L.circle(center, { radius: max, ...st.line }));
      layer.addLayer(ringLabel([m.xz[0] + d, m.xz[1] + d], `R${ring} ${fmtDist(max)}`, +ring));
    });
    // how far away its firing is heard (the game's mortar shot sound reaches 2 km), when the viewer asks for it
    if (state.hearMortar) {
      layer.addLayer(L.circle(center, { radius: GUNS.mortar.range, color: '#b197fc', weight: 1.6, dashArray: '3 6', fillColor: '#b197fc', fillOpacity: 0.05, interactive: false }));
      layer.addLayer(L.marker(toLL([m.xz[0], m.xz[1] - GUNS.mortar.range]), { interactive: false, keyboard: false,
        icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<span class="ring-label">Heard ${fmtDist(GUNS.mortar.range)}</span>` }) }));
    }
    // the shortest distance any ring fires: a red disc, on its own dark outline like the rings
    if (lim) {
      layer.addLayer(L.circle(center, { radius: lim.min, color: '#080b0e', weight: 4.5, opacity: 0.5, fill: false, interactive: false }));
      layer.addLayer(L.circle(center, { radius: lim.min, color: '#ff6b6b', weight: 2, dashArray: '5 4', fillColor: '#ff6b6b', fillOpacity: 0.16, interactive: false }));
    }

    (m.targets || []).forEach((t, idx) => {
      const sol = solveFor(m, t);
      const ok = !!sol.best;
      layer.addLayer(L.polyline([center, toLL(t)], { color: ok ? color : '#ff6b6b', weight: 1.5, opacity: 0.8, dashArray: '2 5', interactive: false }));
      if (ok) impactZones(layer, t, sol.best.dispersion, m.shell, shellColor(m.shell), sol.best.spread);
      if (ok && state.hearMortar) layer.addLayer(L.circle(toLL(t), { radius: impactHeard(m.shell), color: '#b197fc', weight: 1.2, dashArray: '2 6', fill: false, interactive: false }));
      // The mortar's crew (its owner, or anyone showing its solutions) can drag a target to correct fire; the label
      // follows with the new solution and the move is saved for everyone on release.
      const crew = mine || state.followMortar === m.id;
      const tm = L.marker(toLL(t), { keyboard: false, draggable: crew, icon: glyphIcon('✛', ok ? color : '#ff6b6b') });
      const tLabel = s2 => esc(`T${idx + 1} · ${s2.best ? fmtSolution(s2, true) : noReach(s2)}`);
      tm.bindTooltip(tLabel(sol), { permanent: true, direction: 'right', offset: [12, 0], className: 'item-label' });
      if (crew) {
        tm.on('dragstart', () => dragStart(m.id));
        tm.on('drag', () => tm.setTooltipContent(tLabel(solveFor(m, toXZ(tm.getLatLng())))));
        tm.on('dragend', () => { dragEnd(); moveTarget(p, m, idx, toXZ(tm.getLatLng())); });
      }
      bindInfo(tm, () => targetPopup(p.name, p.items.get(m.id) || m, idx), () => t);
      layer.addLayer(tm);
    });

    const mk = L.marker(center, { keyboard: false, zIndexOffset: 500, icon: glyphIcon('⊕', color) });
    const tag = mine ? `Mortar · ${m.weapon}` : `Mortar · ${m.weapon} (${p.name})`;
    const following = !mine && state.followMortar === m.id ? ' · solutions shown' : '';
    mk.bindTooltip(esc((m.label && m.label !== 'Mortar' ? `${m.label} · ${m.weapon}` : tag) + following), { permanent: true, direction: 'right', offset: [12, 0], className: 'item-label' });
    bindInfo(mk, html, () => m.xz);
    layer.addLayer(mk);
  }

  function moveTarget(p, m, idx, xz) {
    const cur = p.items.get(m.id) || m;
    if (xz[0] < 0 || xz[1] < 0 || xz[0] > WORLD || xz[1] > WORLD || !cur.targets || idx >= cur.targets.length) {
      toast("That's off the map."); renderItem(p, cur); return;
    }
    const at = roundXZ(xz);
    if (isMine(p.name)) saveItem({ ...cur, targets: cur.targets.map((t, i) => (i === idx ? at : t)) });
    else api('/api/mortar-target', { id: state.me.id, token: state.me.token, owner: p.name, itemId: m.id, idx, xz: at }).catch(err => { toast(err.message); renderItem(p, cur); });
  }

  // Live aiming line from your mortar to the cursor.
  const mortarGhost = L.polyline([], { color: '#c8d96f', weight: 2, dashArray: '6 6', interactive: false }).addTo(map);
  const mortarGhostZones = L.layerGroup().addTo(map); // where the rounds would land, while aiming
  function updateMortarGhost() {
    const m = myMortar();
    const on = state.tool === 'mortar' && m && !state.mortarPlacing && lastCursor;
    mortarGhost.setLatLngs(on ? [toLL(m.xz), toLL(lastCursor)] : []);
    mortarGhostZones.clearLayers();
    const sol = on && TABLES && solveFor(m, lastCursor);
    if (sol && sol.best) impactZones(mortarGhostZones, lastCursor, sol.best.dispersion, m.shell, shellColor(m.shell), sol.best.spread);
  }
  function mortarLive(el) {
    const m = myMortar();
    if (!m || state.mortarPlacing || !lastCursor || !TABLES) return false;
    const sol = solveFor(m, lastCursor);
    el.textContent = fmtSolution(sol);
    el.style.color = sol.best ? '' : 'var(--danger)';
    return true;
  }

  function mortarClick(xz) {
    if (!TABLES) return toast('Firing tables are still loading.');
    const m = myMortar();
    if (!m || state.mortarPlacing) {
      state.mortarPlacing = false;
      // a second quick click before the first mortar comes back from the server moves it, rather than adding another
      if (!m && !state.newMortarId) state.newMortarId = uid();
      saveItem({
        id: m ? m.id : state.newMortarId, type: 'mortar', xz: roundXZ(xz), weapon: state.mortarWeapon, shell: state.mortarShell,
        targets: m ? m.targets : [], label: m ? m.label : 'Mortar', note: m ? m.note : '', color: m ? m.color : state.me.color,
        ...(readWindInputs() ? { wind: readWindInputs() } : {}),
        ...(state.mortarCharge != null ? { charge: state.mortarCharge } : {}),
      });
      updateHint();
      return;
    }
    if ((m.targets || []).length >= 30) return toast('Up to 30 targets per mortar. Clear some first.');
    saveItem({ ...m, targets: [...(m.targets || []), roundXZ(xz)] });
  }

  // Sidebar panel
  function fillMortarSelects() {
    if (!TABLES) return;
    const ws = $('#mortar-weapon'), ss = $('#mortar-shell');
    const short = { M252: 'M252 · US', '2B14': '2B14 · Soviet' };
    ws.innerHTML = Object.entries(TABLES.weapons).map(([k, w]) => `<option value="${k}" title="${esc(w.label)}">${esc(short[k] || w.label)}</option>`).join('');
    ws.value = state.mortarWeapon;
    const shells = Object.keys(TABLES.weapons[state.mortarWeapon].shells);
    if (!shells.includes(state.mortarShell)) state.mortarShell = shells[0];
    ss.innerHTML = shells.map(s => `<option>${esc(s)}</option>`).join('');
    ss.value = state.mortarShell;
    fillChargeSelect();
  }
  // Ring: Auto or a fixed charge, saved on your mortar like the wind. Rings the shell doesn't have are greyed out.
  state.mortarCharge = null;
  function fillChargeSelect() {
    const rings = shellDef(state.mortarWeapon, state.mortarShell) || {}, cs = $('#mortar-charge');
    cs.querySelectorAll('option[value=""] ~ option').forEach(o => { o.disabled = !rings[o.value]; });
    cs.value = state.mortarCharge != null && rings[state.mortarCharge] ? String(state.mortarCharge) : '';
  }
  $('#mortar-charge').addEventListener('change', e => {
    state.mortarCharge = e.target.value === '' ? null : +e.target.value;
    const m = myMortar();
    if (m) {
      const { charge, ...rest } = m;
      saveItem(state.mortarCharge == null ? rest : { ...rest, charge: state.mortarCharge });
    }
    updateLive();
  });
  function onMortarSelect() {
    state.mortarWeapon = $('#mortar-weapon').value;
    if (!shellDef(state.mortarWeapon, $('#mortar-shell').value)) state.mortarShell = Object.keys(TABLES.weapons[state.mortarWeapon].shells)[0];
    else state.mortarShell = $('#mortar-shell').value;
    fillMortarSelects();
    const m = myMortar();
    if (m) saveItem({ ...m, weapon: state.mortarWeapon, shell: state.mortarShell });
    updateLive();
  }
  $('#mortar-weapon').addEventListener('change', onMortarSelect);
  $('#mortar-shell').addEventListener('change', onMortarSelect);

  // Wind, as the in-game map shows it: saved on your mortar so everyone showing its solutions gets the same numbers.
  state.mortarWind = null;
  function readWindInputs() {
    const s = Math.min(Math.max(+$('#mortar-wind-s').value || 0, 0), 40), d = ((+$('#mortar-wind-d').value || 0) % 360 + 360) % 360;
    return s > 0 ? { s, d } : null;
  }
  function onWindChange() {
    state.mortarWind = readWindInputs();
    const m = myMortar();
    if (m) {
      const { wind, ...rest } = m;
      saveItem(state.mortarWind ? { ...rest, wind: state.mortarWind } : rest);
    }
    updateLive();
  }
  $('#mortar-wind-s').addEventListener('change', onWindChange);
  $('#mortar-wind-d').addEventListener('change', onWindChange);
  // Sound: how far every mortar's firing is heard (2 km) and how far its rounds landing are heard, around each target.
  // Only on this screen, remembered in this browser; switched from the Mortar panel or any mortar's popup.
  // Impacts: the shells' own loudness (Sounds/Weapons/Ammo/MortarShells: HE and practice 65, smoke 20 on the slope scale
  // a rifle shot's 76 sits on), against the background noise chosen under Sound (see REACH_M).
  const impactHeard = shell => heardAt(/^HE/.test(shell) ? 'he' : /^Practice/.test(shell) ? 'practice' : /^Smoke/.test(shell) ? 'smoke' : 'illum');
  const HEAR_KEY = 'everon-map-mortar-hear';
  state.hearMortar = (() => { try { return localStorage.getItem(HEAR_KEY) === '1'; } catch { return false; } })();
  function setHearMortar(on) {
    state.hearMortar = on;
    $('#mortar-hear').checked = on;
    try { localStorage.setItem(HEAR_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
    state.players.forEach(p => p.items.forEach(it => { if (it.type === 'mortar') renderItem(p, it); }));
  }
  $('#mortar-hear').checked = state.hearMortar;
  $('#mortar-hear').addEventListener('change', e => setHearMortar(e.target.checked));
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-act="hear-mortar"]');
    if (!b) return;
    map.closePopup();
    setHearMortar(!state.hearMortar);
  });

  function refreshMortarPanel() {
    const m = myMortar();
    if (m && TABLES && (m.weapon !== state.mortarWeapon || m.shell !== state.mortarShell)) {
      state.mortarWeapon = m.weapon; state.mortarShell = m.shell; fillMortarSelects();
    }
    // show the wind saved on your mortar, unless you're typing in the boxes
    if (m && !$('#mortar-wind').contains(document.activeElement)) {
      state.mortarWind = m.wind || null;
      $('#mortar-wind-s').value = m.wind ? m.wind.s : 0;
      $('#mortar-wind-d').value = m.wind ? m.wind.d : 0;
    }
    if (m && document.activeElement !== $('#mortar-charge')) { state.mortarCharge = chargeOf(m); fillChargeSelect(); }
    const status = $('#mortar-status');
    $('#mortar-actions').classList.toggle('hidden', !m);
    if (!m) {
      status.innerHTML = '<div class="empty"><b>Friendly ▾ → Mortar</b> (F, 9) to place one.</div>';
      $('#mortar-targets').innerHTML = '';
    } else {
      const lim = mortarReach(m), alt = heightAt(m.xz), top = lim && lim.top;
      const reachText = top ? fmtReach(top.near, top.far) : lim ? `${(lim.max / 1000).toFixed(1)} km` : '—';
      status.innerHTML = `<div class="mp-pos"><span>Mortar</span><b>${grid(m.xz)}</b><span>${alt != null ? Math.round(alt) + ' m' : '—'}</span>` +
        `<span title="How far ${lim && lim.ring != null ? `ring ${lim.ring}` : 'its longest ring'} reaches, shortest and longest direction (the ground and the wind decide)">reach ${esc(reachText)}</span></div>` +
        (m.targets.length ? '' : '<div class="empty" style="margin-top:6px">No targets yet. Click the map with the mortar tool.</div>');
      $('#mortar-targets').innerHTML = m.targets.map((t, i) => {
        const sol = solveFor(m, t), b = sol.best;
        const head = `<div class="tgt-head"><span class="id">T${i + 1}</span><span>${grid(t)}</span><span>·</span><span>${fmtDist(sol.d)}</span>` +
          `<span class="sp"></span><button data-act="del-target" data-idx="${i}" title="Remove target" aria-label="Remove target">✕</button></div>`;
        const body = b
          ? `<div class="fire-now"><div><span class="k">Ring</span><span class="v">${b.ring}</span></div>` +
            `<div><span class="k">Elevation</span><span class="v">${Math.round(b.elev)}<small>mil</small></span></div>` +
            `<div><span class="k">Azimuth</span><span class="v">${Math.round(sol.azMil)}<small>mil</small></span></div>` +
            `<div><span class="k">Time</span><span class="v">${b.tof.toFixed(1)}<small>s</small></span></div></div>` + targetSub(m.shell, b.dispersion, t, b.spread)
          : `<div class="fire-now bad">${esc(outOfRangeText(m, t))}</div>`;
        return `<li data-idx="${i}">${head}${body}</li>`;
      }).join('');
    }
    refreshFireRequests(solutionMortar());
    const has = !!solutionMortar();
    if (has && !hadMortar) mortarWanted = true; // the first mortar placed or followed opens the panel
    hadMortar = has;
    if (m) state.newMortarId = null;
    syncMortarPanel();
    if (state.tool === 'mortar') { updateHint(); updateMortarGhost(); }
  }

  function targetSub(shell, spread, xz, shape) {
    const z = impactText(shell, spread, xz, shape);
    return `<div class="fire-sub">${z.zone}</div>` +
      (z.near.length ? `<div class="fire-sub warn">Friendlies in the danger zone: ${z.near.slice(0, 3).map(x => `${esc(x.name)} ${fmtDist(x.d)}`).join(', ')}</div>` : '');
  }
  // Every fire request on the map, with a firing solution to its middle from the mortar you follow, else your own.
  // ✕ removes one request: your own, or (mission complete) anyone's that mortar can reach. + adds it to your targets.
  function refreshFireRequests(sm) {
    const m = sm && sm.it, own = !!m && m.id === myMortar()?.id;
    const reqs = allVisibleItems(isFireReq).sort((a, b) => (b.it.at || 0) - (a.it.at || 0)); // newest first
    $('#fire-requests').classList.toggle('hidden', !reqs.length);
    $('#fire-count').textContent = $('#fire-count-head').textContent = reqs.length || '';
    $('#fire-requests-from').textContent = m && !own ? `Solutions from ${m.label || 'Mortar'} (${sm.p.name})` : '';
    $('#mortar-requests').innerHTML = !m
      ? '<li class="empty">Place a mortar or follow a team mortar for solutions.</li>'
      : reqs.map(({ p, it }) => {
        const f = FIRE[it.fire] || FIRE.he, { shell, sol } = fireSolution(m, it), b = sol.best;
        const head = `<div class="tgt-head"><span class="id" style="background:${f.color};color:#111">${f.name}</span>` +
          `<span class="t">${esc(it.label || 'Fire mission')}${isMine(p.name) ? '' : ` · ${esc(p.name)}`}</span><span>${fmtDist(sol.d)}</span>` +
          `<span class="sp"></span>` +
          (isMine(p.name) || b ? `<button data-fire-clear="${esc(it.id)}" data-owner="${esc(p.name)}" title="Remove this fire request" aria-label="Remove this fire request">✕</button>` : '') + `</div>`;
        const add = own ? `<button class="req-add" data-fire-add="${esc(it.id)}" title="Add its aim point to your targets" aria-label="Add as a target">+</button>` : '';
        const body = b
          ? `<div class="fire-now"><div><span class="k">Ring</span><span class="v">${b.ring}</span></div>` +
            `<div><span class="k">Elevation</span><span class="v">${Math.round(b.elev)}<small>mil</small></span></div>` +
            `<div><span class="k">Azimuth</span><span class="v">${Math.round(sol.azMil)}<small>mil</small></span></div>` +
            `<div><span class="k">Time</span><span class="v">${b.tof.toFixed(1)}<small>s</small></span></div></div>` +
            `<div class="req-foot"><span class="fire-sub">${esc(shell)} · asked ${fmtAgo(Date.now() - (it.at || Date.now()))}</span>${add}</div>`
          : `<div class="req-foot"><span class="fire-now bad">${esc(outOfRangeText(m, fireAim(it), shell))} for ${esc(shell)}</span>${add}</div>`;
        return `<li data-req="${esc(it.id)}">${head}${body}</li>`;
      }).join('');
  }
  $('#mortar-requests').addEventListener('click', e => {
    if (e.target.closest('button')) return;
    const li = e.target.closest('li[data-req]');
    const hit = li && allVisibleItems(i => i.id === li.dataset.req)[0];
    if (hit) focusItem(hit.p, hit.it);
  });

  $('#mortar-targets').addEventListener('click', e => {
    if (e.target.closest('button')) return;
    const li = e.target.closest('li[data-idx]');
    const m = myMortar();
    if (!li || !m) return;
    const idx = +li.dataset.idx;
    flyAndOpen(m.targets[idx], () => targetPopup(state.me.name, m, idx));
  });
  $('#mortar-move').addEventListener('click', () => { setTool('mortar'); state.mortarPlacing = true; updateHint(); updateMortarGhost(); updateLive(); });
  $('#mortar-clear').addEventListener('click', () => { const m = myMortar(); if (m) saveItem({ ...m, targets: [] }); });
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-act="del-target"]');
    const m = myMortar();
    if (!b || !m) return;
    map.closePopup();
    saveItem({ ...m, targets: m.targets.filter((_, i) => i !== +b.dataset.idx) });
  });

  // ---------------------------------------------------------------------------
  // Sandbags, barbed wire, roadblocks (lines of tank traps), bunkers, checkpoints
  // ---------------------------------------------------------------------------
  function pointAlong(pts, target) {
    let run = 0;
    for (let i = 1; i < pts.length; i++) {
      const seg = dist(pts[i - 1], pts[i]);
      if (run + seg >= target) {
        const k = seg ? (target - run) / seg : 0;
        return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k];
      }
      run += seg;
    }
    return pts[pts.length - 1];
  }

  const HEDGEHOG_SVG = '<svg viewBox="0 0 24 24"><path d="M12 4l-6.5 15M12 4l6.5 15M3.5 13.5h17"/></svg>';
  const CONSTRUCT_HTML = {
    // Roadblock: a tank trap (hedgehog). New roadblocks are lines of them; this is for ones dropped as a single point.
    roadblock: `<div>${HEDGEHOG_SVG}</div>`,
    // Bunker: a dark concrete block with a firing slit
    bunker: '<div><span></span></div>',
    // Checkpoint: a red-and-white barrier arm on a post
    checkpoint: '<div><i></i><b></b></div>',
  };
  const constructIcon = kind => L.divIcon({ className: CONSTRUCT_HTML[kind] ? `${kind}-glyph` : 'construction-glyph', iconSize: [0, 0], html: CONSTRUCT_HTML[kind] || `<div>${esc(window.ConstructionCatalog[kind]?.glyph || '?')}</div>` });

  function renderConstruct(p, it, layer, html) {
    const tag = isMine(p.name) ? it.label || CONSTRUCT_NAME[it.kind] : `${it.label || CONSTRUCT_NAME[it.kind]} (${p.name})`;
    if (!it.points) { // a point construct (or a roadblock placed as a single point before they became lines)
      const m = L.marker(toLL(it.xz), { keyboard: false, riseOnHover: true, zIndexOffset: 250, icon: constructIcon(it.kind) });
      m.bindTooltip(esc(tag), { direction: 'right', offset: [16, 0], className: 'item-label' });
      bindInfo(m, html, () => it.xz);
      layer.addLayer(m);
      return;
    }
    const lls = it.points.map(toLL);
    let hit;
    if (it.kind === 'wall') {
      // Sandbags: a khaki line broken into short segments, like a row of bags
      layer.addLayer(L.polyline(lls, { color: '#0d1115', weight: 9, opacity: 0.8, lineCap: 'butt', lineJoin: 'round', interactive: false }));
      hit = L.polyline(lls, { color: LINE_STYLE.wall, weight: 5.5, opacity: 1, dashArray: '7 2', lineCap: 'butt', bubblingMouseEvents: false });
    } else if (it.kind === 'dragon-teeth') {
      hit = L.polyline(lls, { color: '#aab4bd', weight: 7, opacity: 1, dashArray: '4 5', bubblingMouseEvents: false });
    } else if (it.kind === 'roadblock') {
      // Roadblock: a steel-grey line with tank traps (hedgehogs) spaced along it (capped so long lines stay light)
      layer.addLayer(L.polyline(lls, { color: '#0d1115', weight: 6, opacity: 0.7, interactive: false }));
      hit = L.polyline(lls, { color: LINE_STYLE.roadblock, weight: 2.5, opacity: 1, dashArray: '2 4', bubblingMouseEvents: false });
      const len = pathLength(it.points), spacing = Math.max(8, len / 60);
      for (let d = spacing / 2; d < len; d += spacing) {
        layer.addLayer(L.marker(toLL(pointAlong(it.points, d)), { interactive: false, keyboard: false,
          icon: L.divIcon({ className: 'trap-x', iconSize: [0, 0], html: HEDGEHOG_SVG }) }));
      }
    } else {
      layer.addLayer(L.polyline(lls, { color: '#0d1115', weight: 4, opacity: 0.6, interactive: false }));
      hit = L.polyline(lls, { color: LINE_STYLE.wire, weight: 1.8, opacity: 1, bubblingMouseEvents: false });
      // Cross marks spaced along the wire, like a map's barbed-wire symbol (capped so long lines stay light).
      const len = pathLength(it.points), spacing = Math.max(12, len / 60);
      for (let d = spacing / 2; d < len; d += spacing) {
        layer.addLayer(L.marker(toLL(pointAlong(it.points, d)), { interactive: false, keyboard: false,
          icon: L.divIcon({ className: 'wire-x', iconSize: [0, 0], html: '<span>✕</span>' }) }));
      }
    }
    hit.bindTooltip(esc(tag), { sticky: true, className: 'item-label' });
    bindInfo(hit, html);
    layer.addLayer(hit);
  }

  // ---------------------------------------------------------------------------
  // Emplacements: MG nest + shaded field of fire. Click to place, move to aim, click to set.
  // ---------------------------------------------------------------------------
  state.arc = 60;
  let emplDraft = null; // {xz, layer, sector}

  function sectorLatLngs(xz, dir, arc, range) {
    const steps = Math.max(8, Math.round(arc / 3)), pts = [toLL(xz)];
    for (let i = 0; i <= steps; i++) {
      const b = (dir - arc / 2 + arc * i / steps) * Math.PI / 180;
      pts.push(toLL([xz[0] + range * Math.sin(b), xz[1] + range * Math.cos(b)]));
    }
    return pts;
  }
  // Line of sight across the field of fire, from the terrain heightmap only (trees and buildings aren't in it).
  // The gun sits GUN_EYE above the ground (crouched behind sandbags); a spot counts as seen when a point TARGET_H above
  // it (a standing soldier's chest) is visible. Rays are cast across the arc and marched outward: a spot is hidden once
  // nearer ground rises above the sight line.
  const GUN_EYE = 1.2, TARGET_H = 1.5, LOS_CELL = 10;
  // A nest can sit on something (a roof, a tower, sandbags on a wall): its gunner's eyes are that much higher.
  const gunEye = (height = 0) => Math.round((GUN_EYE + (height || 0)) * 10) / 10;
  state.emplHeight = 0;
  $('#empl-height').addEventListener('input', e => {
    const v = +e.target.value;
    state.emplHeight = Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0;
    updateEmplDraft();
  });
  // Trees, bushes and clutter thin the view rather than cutting it off. Each 10 m cell holds, per height band above the
  // ground, the average of every plant's measured leaves there (FOLIAGE, the same plants and see-through the retired
  // Visual model used one by one) and the share of it filled by walls, rocks and small buildings (CLUTTER). A sight line
  // crossing a cell at some height meets FOLIAGE_K (FOLIAGE_LOW_K below LOW_TOP) x that k plus CLUTTER_K x that share
  // per metre; what it keeps is T = exp(-sum): at least SEE_CLEAR counts as seen, SEE_TREES..SEE_CLEAR as seen through
  // trees, less as hidden. The rates and the two thresholds were fitted to the Visual model's results at 200 spots
  // across the island for the best F1 score over hidden, clear
  // and through-trees ground.
  // Averaging leaves over 10 m hides gaps and trunks, so they're weaker than Visual's measured rates and the
  // thresholds differ.
  // Buildings (where they fill a 10 m cell) block like the ground, and neither they nor clutter count right beside
  // the eye (it's standing there). The mortar calculator never uses this; it reads the bare terrain.
  const FOLIAGE_K = 0.55, FOLIAGE_LOW_K = 0.62, CLUTTER_K = 0.7, SEE_CLEAR = 0.7, SEE_TREES = 0.23, BUILDING_NEAR = 10;
  const LIGHT_MIN_TAU = 0.01;
  const LOW_TOP = 4; // bands up to this height (m) use FOLIAGE_LOW_K: undergrowth and trunks, not crowns
  const BAND_AT = new Uint8Array(LIGHT_BANDS[LIGHT_BANDS.length - 1]); // band for each whole metre of height
  for (let b = 0; b < LIGHT_BANDS.length - 1; b++) BAND_AT.fill(b, LIGHT_BANDS[b], LIGHT_BANDS[b + 1]);
  const TAU_CLEAR = -Math.log(SEE_CLEAR), TAU_TREES = -Math.log(SEE_TREES);
  const LOS_HIDDEN = 1, LOS_CLEAR = 2, LOS_TREES = 3;
  const LOS_RANK = [0, 1, 3, 2]; // when samples disagree about a cell: clear beats through trees beats hidden
  const losCache = new Map();
  const ground = p => Math.max(heightAt(p), 0); // the sea surface blocks nothing
  function fieldOfFireLos(xz, dir, arc, range, cache = true, eyeH = GUN_EYE) {
    return losGrid(xz, dir, arc, range, cache, eyeH, TARGET_H, false);
  }
  // Overwatch: from where around xz can a crouched observer see a standing soldier at xz? Sight lines work both
  // ways, so this is the same march run outward from the objective with the two heights swapped.
  const overwatchLos = (xz, range) => losGrid(xz, 0, 360, range, true, TARGET_H, POST_KIND.f.eye, true);
  // Rays are cast across the arc and marched outward in 5 m steps. For a target at distance r with sight-line slope t
  // (target height minus eye height, over r) the ground and buildings hide it if any nearer one has a steeper slope
  // from the eye (a running maximum). Otherwise the trees it passes add up along the line: every wooded sample before
  // the target (and half of the target's own) thins it at the height the line crosses there, until it's hidden.
  // reverse: marching out from the target (overwatch), the heights swapped; sight lines work both ways.
  // elev: [lowest, highest] angle in degrees a gun can aim (null = any).
  function lightLos(xz, dir, arc, range, cache, eyeH, targetH, reverse, elev = null) {
    if (!HEIGHT || range < 1) return null;
    const key = `${xz}|${dir}|${arc}|${Math.round(range)}|${eyeH}|${targetH}|${reverse}|${elev}|${!!FOLIAGE}`;
    if (cache && losCache.has(key)) return losCache.get(key);
    const pts = arc >= 360 ? [[xz[0] - range, xz[1] - range], [xz[0] + range, xz[1] + range]] : sectorLatLngs(xz, dir, arc, range).map(toXZ);
    // The box is snapped to the 10 m grid so results from different spots line up cell for cell.
    const minX = Math.floor(Math.min(...pts.map(p => p[0])) / LOS_CELL) * LOS_CELL, maxX = Math.max(...pts.map(p => p[0]));
    const minZ = Math.min(...pts.map(p => p[1])), maxZ = Math.ceil(Math.max(...pts.map(p => p[1])) / LOS_CELL) * LOS_CELL;
    const W = Math.max(1, Math.ceil((maxX - minX) / LOS_CELL)), H = Math.max(1, Math.ceil((maxZ - minZ) / LOS_CELL));
    const cells = new Uint8Array(W * H); // 0 outside the arc, else LOS_HIDDEN / LOS_CLEAR / LOS_TREES
    const eye = ground(xz) + eyeH, step = LOS_CELL / 2;
    const rays = Math.ceil(arc * Math.PI / 180 * range / (LOS_CELL * 0.7)) + 1;
    const [lo, hi] = elev ? elev.map(d => Math.tan(d * Math.PI / 180)) : [-Infinity, Infinity];
    const maxN = Math.ceil(range / step) + 1, NN = HN * HN;
    const hs = new Float64Array(maxN), blk = new Float64Array(maxN); // ground; ground plus any building
    const NBANDS = LIGHT_BANDS.length - 1;
    const mus = new Float64Array(maxN * NBANDS); // per sample and band: what a metre of sight line meets there
    const wooded = new Int32Array(maxN); // indices of the samples with plants or clutter, in order
    const cUnit = CLUTTER_K / 255, bandTop = BAND_AT.length;
    const fUnit = LIGHT_BANDS.slice(1).map(top => (top <= LOW_TOP ? FOLIAGE_LOW_K : FOLIAGE_K) * LIGHT_K_MAX / 255), fMax = Math.max(...fUnit);
    for (let i = 0; i <= rays; i++) {
      const b = (dir - arc / 2 + arc * i / rays) * Math.PI / 180, sx = Math.sin(b), sz = Math.cos(b);
      let n = 0, m = 0;
      for (let r = step; r <= range; r += step) {
        const x = xz[0] + r * sx, z = xz[1] + r * sz;
        if (x < 0 || z < 0 || x > WORLD || z > WORLD) break;
        const k = cellOf([x, z]);
        hs[n] = ground([x, z]);
        blk[n] = hs[n] + (BUILDINGS && k >= 0 && r > BUILDING_NEAR ? BUILDINGS[k] : 0);
        // cells whose plants and clutter could thin a sight line by more than LIGHT_MIN_TAU (skipping stray twigs)
        if (FOLIAGE && k >= 0 && (FOLIAGE_MAX[k] * fMax + CLUTTER_MAX[k] * cUnit) * step > LIGHT_MIN_TAU) {
          const near = r <= BUILDING_NEAR; // no clutter where the eye stands
          for (let b = 0; b < NBANDS; b++) mus[n * NBANDS + b] = FOLIAGE[b * NN + k] * fUnit[b] + (near ? 0 : CLUTTER[b * NN + k] * cUnit);
          wooded[m++] = n;
        }
        n++;
      }
      let maxTerrain = -Infinity; // steepest slope from the eye to any nearer ground or building
      for (let j = 0; j < n; j++) {
        const r = (j + 1) * step;
        const t = (hs[j] + targetH - eye) / r;
        let v;
        if (t < maxTerrain || t < lo || t > hi) v = LOS_HIDDEN;
        else {
          const len = step * Math.sqrt(1 + t * t); // metres of sight line per sample
          let tau = 0;
          for (let q = 0; q < m && tau <= TAU_TREES; q++) {
            const w = wooded[q];
            if (w > j) break;
            const y = eye + t * (w + 1) * step - hs[w]; // the sight line's height above the ground there
            if (y < 0 || y >= bandTop) continue;
            tau += mus[w * NBANDS + BAND_AT[Math.floor(y)]] * len * (w === j ? 0.5 : 1);
          }
          v = tau > TAU_TREES ? LOS_HIDDEN : tau > TAU_CLEAR ? LOS_TREES : LOS_CLEAR;
        }
        maxTerrain = Math.max(maxTerrain, (blk[j] - eye) / r);
        const x = xz[0] + r * sx, z = xz[1] + r * sz;
        const cx = Math.floor((x - minX) / LOS_CELL), cz = Math.floor((maxZ - z) / LOS_CELL);
        if (cx < 0 || cx >= W || cz < 0 || cz >= H) continue;
        const k = cz * W + cx;
        if (LOS_RANK[v] > LOS_RANK[cells[k]]) cells[k] = v;
      }
    }
    let clear = 0, trees = 0, total = 0;
    for (const v of cells) if (v) { total++; if (v === LOS_CLEAR) clear++; else if (v === LOS_TREES) trees++; }
    const res = { cells, W, H, minX, maxZ, cell: LOS_CELL, pct: total ? Math.round(clear / total * 100) : 100, treePct: total ? Math.round(trees / total * 100) : 0,
      bounds: L.latLngBounds(toLL([minX, maxZ - H * LOS_CELL]), toLL([minX + W * LOS_CELL, maxZ])) };
    if (cache) {
      if (losCache.size > 60) losCache.clear();
      losCache.set(key, res);
    }
    return res;
  }
  // Line of sight in the viewer's chosen detail. Measured ('profiles'): every building, wall and rock from the game at
  // 0.5 m, with every tree and bush blocking by how much of it the game draws (static/los-worker.js, in a background
  // thread). Light: the 10 m model above, instant and small. A full (0.5 m) result arrives a moment after it's asked
  // for: until then the light one stands in, and everything that shows line of sight redraws when it lands. Drafts
  // still being aimed (cache = false) stay light so they keep up with the mouse.
  const FULL_CELL = 2.5; // metres per cell of a full result's shading
  const LOS_MODE_KEY = 'everon-map-los-detail';
  const fullCache = new Map(), fullWanted = new Map(); // key -> result, key -> request id
  let losWorker = null, fullSeq = 0, fullRedraw = 0, fullError = null;
  const fullFailures = new Map();
  const fullSupported = () => typeof Worker !== 'undefined' && typeof DecompressionStream !== 'undefined';
  // Measured needs a plant list for the map (MAP.plants), so on a map whose trees haven't been baked yet only Light is
  // offered. Measured is the default on computers, Light on phones and tablets. A retired mode ('full', 'visual') still
  // saved in someone's browser isn't available, so they get the default.
  const modeAvailable = m => m === 'light' || (fullSupported() && m === 'profiles' && !!MAP.plants);
  function defaultLosMode() {
    const weak = (navigator.deviceMemory && navigator.deviceMemory < 4) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency < 4)
      || matchMedia('(pointer: coarse)').matches; // phones and tablets
    return fullSupported() && !weak && MAP.plants ? 'profiles' : 'light';
  }
  const LOS_STRENGTH_KEY = 'everon-map-los-strength';
  // How strongly the measured leaves block (1 = as photographed), for the Measured model only.
  state.losStrength = (() => {
    try { const v = parseFloat(localStorage.getItem(LOS_STRENGTH_KEY)); if (v >= 0 && v <= 1.5) return v; } catch { /* storage unavailable */ }
    return 1;
  })();
  // read again once the room's map is known (startMap)
  const savedLosMode = () => {
    try { const v = localStorage.getItem(LOS_MODE_KEY); if (modeAvailable(v)) return v; } catch { /* storage unavailable */ }
    return defaultLosMode();
  };
  state.losMode = savedLosMode();
  // What the worker needs to find this map's files.
  const workerCfg = () => ({
    size: WORLD, losDir: mapLosDir(),
    profiles: MAP.plants ? { json: MAP.foliage, plants: MAP.plants, dir: MAP.plantsDir } : null,
  });
  function losGrid(xz, dir, arc, range, cache, eyeH, targetH, reverse, elev = null) {
    if (cache && state.losMode === 'profiles' && modeAvailable(state.losMode) && HEIGHT && range >= 1) {
      const model = state.losMode, strength = state.losStrength;
      const key = `${model}@${strength}|${xz}|${dir}|${arc}|${Math.round(range)}|${eyeH}|${targetH}|${reverse}|${elev}`;
      const hit = fullCache.get(key);
      if (hit) return hit;
      if (!fullWanted.has(key)) requestFull(key, { xz, dir, arc, range, eyeH, targetH, reverse, elev, cell: FULL_CELL, model, strength, cfg: workerCfg() });
    }
    return lightLos(xz, dir, arc, range, cache, eyeH, targetH, reverse, elev);
  }
  function requestFull(key, req) {
    if (!losWorker) {
      losWorker = new Worker('los-worker.js');
      losWorker.onmessage = e => {
        const d = e.data;
        const entry = [...fullWanted].find(([, id]) => id === d.id);
        if (!entry) return;
        fullWanted.delete(entry[0]);
        if (d.error) {
          console.error('Measured line of sight:', d.error);
          if (!fullError) { fullError = d.error; toast('Measured line of sight could not load; showing Light instead.', 6000); }
          fullFailures.set(entry[0], Date.now() + 5000);
          while (fullFailures.size > 40) fullFailures.delete(fullFailures.keys().next().value);
          setTimeout(redrawLos, 5100);
        } else {
          fullError = null;
          fullFailures.delete(entry[0]);
          fullCache.set(entry[0], { ...d, bounds: L.latLngBounds(toLL([d.minX, d.maxZ - d.H * d.cell]), toLL([d.minX + d.W * d.cell, d.maxZ])) });
          while (fullCache.size > 40) fullCache.delete(fullCache.keys().next().value);
          clearTimeout(fullRedraw);
          fullRedraw = setTimeout(redrawLos, 60);
        }
        renderLosDetail();
      };
    }
    if ((fullFailures.get(key) || 0) > Date.now()) return;
    const id = ++fullSeq;
    fullWanted.set(key, id);
    losWorker.postMessage({ id, ...req });
    renderLosDetail();
  }
  // Redraw everything that shows line of sight (range cards, MG nests, AA guns, overwatch, TRPs, route exposure).
  function redrawLos() {
    state.players.forEach(p => p.items.forEach(it => renderItem(p, it)));
    refreshCoverage(true);
    refreshThreats(true);
  }
  function renderLosDetail() {
    const box = $('#los-detail');
    if (!box) return;
    box.querySelectorAll('[data-los-mode]').forEach(b => {
      const on = b.dataset.losMode === state.losMode;
      b.classList.toggle('sel', on);
      b.setAttribute('aria-checked', on);
      b.disabled = !modeAvailable(b.dataset.losMode);
      if (b.disabled && b.dataset.losMode === 'profiles' && fullSupported()) b.title = 'Needs this map’s trees, which have not been baked';
    });
    const measured = state.losMode === 'profiles';
    $('#los-strength').classList.toggle('hidden', !measured);
    $('#los-note').textContent = measured && fullError ? 'Measured could not load, so Light is shown.'
      : measured && fullWanted.size ? 'Working it out…'
      : '';
  }
  $('#los-detail').addEventListener('click', e => {
    const b = e.target.closest('[data-los-mode]');
    if (!b || b.disabled || b.dataset.losMode === state.losMode) return;
    state.losMode = b.dataset.losMode;
    try { localStorage.setItem(LOS_MODE_KEY, state.losMode); } catch { /* storage unavailable */ }
    renderLosDetail();
    redrawLos();
  });
  const strengthRange = $('#los-strength-range');
  strengthRange.value = state.losStrength;
  $('#los-strength-out').textContent = state.losStrength.toFixed(1);
  strengthRange.addEventListener('input', () => { $('#los-strength-out').textContent = (+strengthRange.value).toFixed(1); });
  strengthRange.addEventListener('change', () => {
    state.losStrength = +strengthRange.value;
    try { localStorage.setItem(LOS_STRENGTH_KEY, String(state.losStrength)); } catch { /* storage unavailable */ }
    redrawLos();
  });
  renderLosDetail();
  // Paint a LOS result: clear ground lightly tinted in the owner's colour, ground seen only through trees yellow,
  // dead ground dark.
  function losImage(los, color, darkHidden = true, clearAlpha = 62) {
    const hex = /^#([0-9a-f]{6})$/i.exec(color || '');
    const n = hex ? parseInt(hex[1], 16) : 0xc8d96f, cr = n >> 16, cg = (n >> 8) & 255, cb = n & 255;
    const c = document.createElement('canvas');
    c.width = los.W; c.height = los.H;
    const ctx = c.getContext('2d'), img = ctx.createImageData(los.W, los.H), px = img.data;
    los.cells.forEach((v, k) => {
      if (!v) return;
      const i = k * 4;
      if (v === LOS_CLEAR) { px[i] = cr; px[i + 1] = cg; px[i + 2] = cb; px[i + 3] = clearAlpha; }
      else if (v === LOS_TREES) { px[i] = 255; px[i + 1] = 222; px[i + 2] = 50; px[i + 3] = 80; }
      else if (darkHidden) { px[i] = 6; px[i + 1] = 8; px[i + 2] = 12; px[i + 3] = 150; }
    });
    ctx.putImageData(img, 0, 0);
    return c.toDataURL();
  }
  function losOverlay(los, color, darkHidden = true, clearAlpha = 62) {
    return L.imageOverlay(losImage(los, color, darkHidden, clearAlpha), los.bounds, { interactive: false, className: 'los-overlay' });
  }

  function emplIcon(color, draft = false, kind = 'mg') {
    return L.divIcon({ className: `empl-glyph${draft ? ' draft' : ''}`, iconSize: [0, 0], html: `<div style="--c:${color}">${esc(window.ConstructionCatalog[kind]?.glyph || 'MG')}</div>` });
  }

  function setArc(arc) {
    state.arc = arc;
    document.querySelectorAll('#arc-picker [data-arc]').forEach(b => {
      const on = +b.dataset.arc === arc;
      b.classList.toggle('sel', on);
      b.setAttribute('aria-checked', on);
    });
    updateEmplDraft();
    updateLive();
  }
  $('#arc-picker').addEventListener('click', e => {
    const b = e.target.closest('[data-arc]');
    if (b) setArc(+b.dataset.arc);
  });

  function emplClick(xz) {
    if (!emplDraft) {
      const layer = L.layerGroup().addTo(map);
      const sector = L.polygon([], { color: FRIENDLY, weight: 1.5, dashArray: '5 4', fillColor: FRIENDLY, fillOpacity: 0.12, interactive: false }).addTo(layer);
      L.marker(toLL(xz), { icon: emplIcon(FRIENDLY, true), interactive: false, keyboard: false }).addTo(layer);
      emplDraft = { xz, layer, sector };
      updateHint();
      return;
    }
    const range = dist(emplDraft.xz, xz);
    if (range < 10) return toast('Aim a bit further out to set the field of fire.');
    const n = [...(state.players.get(state.me.name)?.items.values() || [])].filter(i => i.type === 'emplacement').length + 1;
    saveItem({
      id: uid(), type: 'emplacement', kind: 'mg', xz: roundXZ(emplDraft.xz), dir: Math.round(bearing(emplDraft.xz, xz)) % 360,
      arc: state.arc, range: Math.round(Math.min(range, 3000)), height: state.emplHeight, label: `MG nest ${n}`, note: '', color: FRIENDLY,
    });
    cancelEmplDraft();
  }

  function updateEmplDraft() {
    if (!emplDraft) return;
    const r = lastCursor ? dist(emplDraft.xz, lastCursor) : 0;
    const dir = r >= 1 ? bearing(emplDraft.xz, lastCursor) : 0, range = Math.min(r, 3000);
    emplDraft.sector.setLatLngs(r >= 1 ? sectorLatLngs(emplDraft.xz, dir, state.arc, range) : []);
    // Live line of sight while aiming, at most once per frame.
    cancelAnimationFrame(emplDraft.raf);
    emplDraft.raf = requestAnimationFrame(() => {
      if (!emplDraft) return;
      if (emplDraft.los) { emplDraft.los.remove(); emplDraft.los = null; }
      const los = r >= 10 ? fieldOfFireLos(emplDraft.xz, dir, state.arc, range, false, gunEye(state.emplHeight)) : null;
      emplDraft.sector.setStyle({ fillOpacity: los ? 0 : 0.12 });
      if (los) emplDraft.los = losOverlay(los, FRIENDLY).addTo(emplDraft.layer);
      emplDraft.pct = los ? los.pct : null;
      emplDraft.treePct = los ? los.treePct : 0;
      updateLive();
    });
  }

  function cancelEmplDraft() {
    if (!emplDraft) return;
    cancelAnimationFrame(emplDraft.raf);
    emplDraft.layer.remove();
    emplDraft = null;
    updateHint();
    updateLive();
  }

  // ---------------------------------------------------------------------------
  // Planning: range cards with line of sight, reference points, sectors of fire, ambushes, arrows
  // ---------------------------------------------------------------------------
  state.postRange = 400;
  state.enemyView = 'e';     // enemy line of sight: a crouched soldier (e) or a vehicle's sights (v)
  state.armourRange = 400;   // friendly armour's line of sight (0 = none, a plain armour marker)
  state.posRange = 400; // reach of the range card on your own position marker (0 = none)
  state.posUnit = 'inf'; // your position is on foot (inf) or in a vehicle (arm)
  state.ambushKind = 'linear';
  state.sectorCount = 4;
  state.showLos = true;

  const visiblePlayers = () => [...state.players.values()].filter(p => isMine(p.name) || state.showOthers);
  const allVisibleItems = test => visiblePlayers().flatMap(p => [...p.items.values()].filter(test).map(it => ({ p, it })));
  const isVehicleView = it => it.side === 'v' || it.side === 'fv' || (it.type === 'marker' && it.unit === 'arm');
  const postLos = it => fieldOfFireLos(it.xz, 0, 360, it.range, true, (isVehicleView(it) ? POST_KIND.fv : POST_KIND[it.side] || POST_KIND.f).eye);
  // The line-of-sight marking a tool places: the enemy's (soldier or vehicle, picked in its options) or our armour's.
  const postSideOf = tool => (tool === 'enemy-view' ? state.enemyView : tool === 'vehicle-view-f' ? 'fv' : null);
  function losAt(los, xz) { // LOS_CLEAR / LOS_TREES / LOS_HIDDEN, or null outside the result
    const cx = Math.floor((xz[0] - los.minX) / los.cell), cz = Math.floor((los.maxZ - xz[1]) / los.cell);
    if (cx < 0 || cz < 0 || cx >= los.W || cz >= los.H) return null;
    return los.cells[cz * los.W + cx] || null;
  }

  // Option picker under the toolbar for the Plan tools; keys 1-4 pick too.
  // Who can hear it: how far away a shot (the muzzle blast, not the supersonic crack) stands out above the background noise.
  // The game only plays a shot out to the outer range of its sound setting (3.3 to 4.8 km), but long before that the shot is
  // quieter than the wind and ambience. So the range is worked out the way the game mixes it, from its own sound files:
  //  - the shot starts at the loudness its sound setting names (Sounds/_SharedData/Configs/Amplitude: rifle -15.5 LUFS, 7.62 MG
  //    -13.5, heavy -9; suppressed, mortar and impacts in proportion to their slope factor) and falls 6 dB per doubling of
  //    distance, less air absorption on the high tones;
  //  - the background is the game's wind and ambience beds (mastered to -30 LUFS, played through the -10 dB wind bus), so -40
  //    LUFS at full wind, quieter as it calms;
  //  - the shot is heard while its loudest 50 ms is above the noise in any third-octave band (Far and Mid blast layers).
  // REACH_M is that worked out for four noise levels (reforger-map-tools/audible). The game's own AI hears a
  // normal shot out to 500 m and a suppressed one to 100 m (SCR_AIDangerReaction_WeaponFired), which sits in the same range.
  const NOISE = [['still', 'Still'], ['breeze', 'Breeze'], ['windy', 'Windy'], ['storm', 'Storm']];
  const NOISE_LUFS = { still: -55, breeze: -50, windy: -45, storm: -40 };
  const REACH_M = { // metres, per background noise
    rifle: { still: 975, breeze: 555, windy: 315, storm: 175 },
    'rifle-s': { still: 545, breeze: 310, windy: 175, storm: 100 },
    mg: { still: 1215, breeze: 695, windy: 395, storm: 225 },
    hmg: { still: 1995, breeze: 1150, windy: 655, storm: 370 },
    mortar: { still: 585, breeze: 330, windy: 185, storm: 105 },
    he: { still: 835, breeze: 475, windy: 270, storm: 150 },
    smoke: { still: 260, breeze: 150, windy: 85, storm: 45 },
    illum: { still: 645, breeze: 365, windy: 205, storm: 115 },
  };
  REACH_M.launcher = REACH_M.hmg; REACH_M.gl = REACH_M.pistol = REACH_M.rifle; REACH_M.practice = REACH_M.he;
  const NOISE_KEY = 'everon-map-noise';
  state.noise = (() => { try { const v = localStorage.getItem(NOISE_KEY); return NOISE_LUFS[v] ? v : 'breeze'; } catch { return 'breeze'; } })();
  const heardAt = key => REACH_M[key][state.noise];
  const GUNS = {
    rifle: { name: 'Rifle or light MG', get range() { return heardAt('rifle'); }, of: 'M16A2, AK-74, AKS-74U, M249, RPK-74 (5.56 / 5.45 mm)' },
    'rifle-s': { name: 'Suppressed rifle', get range() { return heardAt('rifle-s'); }, of: 'M16A2, AK-74, AKS-74U with a suppressor',
      note: 'Suppressor: about −5 dB off the blast. Bullet crack not counted.' },
    mg: { name: '7.62 MG or rifle', get range() { return heardAt('mg'); }, of: 'PKM, PKT, M60, M240, UK-59, SVD, M21, vz. 58' },
    hmg: { name: 'Heavy MG or cannon', get range() { return heardAt('hmg'); }, of: 'M2 .50 cal and NSV on tripods, KPVT (BTR-70, BRDM-2), M242 25 mm (LAV-25)' },
    launcher: { name: 'RPG or LAW', get range() { return heardAt('launcher'); }, of: 'RPG-7, M72 LAW' },
    gl: { name: 'Grenade launcher', get range() { return heardAt('gl'); }, of: 'M203, GP-25' },
    pistol: { name: 'Pistol', get range() { return heardAt('pistol'); }, of: 'M9, PM' },
    mortar: { name: 'Mortar', get range() { return heardAt('mortar'); }, of: 'M252, 2B14 firing' },
  };
  function setNoise(v) {
    if (!NOISE_LUFS[v]) return;
    state.noise = v;
    try { localStorage.setItem(NOISE_KEY, v); } catch { /* storage unavailable */ }
    const sel = $('#mortar-noise'); if (sel) sel.value = v;
    state.players.forEach(p => p.items.forEach(it => { if (it.type === 'mortar' || it.type === 'audible') renderItem(p, it); }));
  }
  $('#mortar-noise').value = state.noise;
  $('#mortar-noise').addEventListener('change', e => setNoise(e.target.value));
  const REACH = [[400, '400 m'], [800, '800 m'], [1500, '1.5 km']];
  const HELI_ALTS = [[30, '30 m'], [100, '100 m'], [200, '200 m']];
  const EYES = [[0.5, 'Prone'], [1, 'Crouched'], [1.6, 'Standing'], [2.2, 'Vehicle']]; // eye height above the ground, m
  state.profFrom = 1.6; state.profTo = 1.6;
  state.rkChoice = 'RPG-7|PG-7VM'; state.rkSight = 'iron'; state.rkWind = null; // rocket launcher shots
  state.hdFoe = 's'; state.hdVeh = 'btr70'; state.hdRange = 800;
  state.hearGun = 'rifle';
  state.heliAlt = 100;
  state.routeMode = 'foot';
  state.swim = false;
  state.offroad = true;
  state.casShape = 'point';
  const PICKERS = {
    ambush: { label: 'Ambush', key: 'ambushKind', options: [['linear', 'Linear'], ['l', 'L-shaped']] },
    sectors: { label: 'Sectors', key: 'sectorCount', options: [[3, '3'], [4, '4'], [6, '6'], [8, '8']] },
    'vehicle-view-f': { label: 'Line of sight', key: 'armourRange', options: [[0, 'Off'], ...REACH] },
    'enemy-view': [{ label: 'Enemy', key: 'enemyView', options: [['e', 'Soldier'], ['v', 'Vehicle']] },
      { label: 'Reach', key: 'postRange', options: REACH }],
    ...Object.fromEntries(Object.keys(UNITS).map(t => [t, { label: 'Times out', key: 'unitTtl', options: TTL_OPTIONS }])),
    contact: { label: 'Times out', key: 'contactTtl', options: TTL_OPTIONS },
    infantry: [{ label: 'I am', key: 'posUnit', options: [['inf', 'Infantry'], ['arm', 'Armour']] },
      { label: 'My range card', key: 'posRange', options: [[0, 'Off'], ...REACH] }],
    overwatch: { label: 'Overwatch · look out to', key: 'owRange', options: REACH },
    // grenade launcher, heavy MG, launchers and mortar are kept in GUNS (old markings, mortar sound rings) but not offered
    audible: [{ label: 'Weapon', key: 'hearGun', options: ['rifle', 'rifle-s', 'mg', 'pistol'].map(k => [k, GUNS[k].name]) },
      { label: 'Background noise', key: 'noise', options: NOISE }],
    hulldown: [{ label: 'Enemy', key: 'hdFoe', options: [['s', 'Soldier'], ['v', 'Vehicle']] },
      { label: 'My vehicle', key: 'hdVeh', options: [['btr70', 'BTR-70'], ['brdm2', 'BRDM-2'], ['lav25', 'LAV-25']] },
      { label: 'Look out to', key: 'hdRange', options: REACH }],
    profile: [{ label: 'From', key: 'profFrom', options: EYES }, { label: 'To', key: 'profTo', options: EYES }],
    rocket: () => [{ label: 'Launcher', key: 'rkChoice', options: ROCKET_CHOICES.map(([l, r]) => [`${l}|${r}`, rocketName(l, r)]) },
      ...(state.rkChoice.startsWith('RPG-7|') ? [{ label: 'Sight', key: 'rkSight', options: [['iron', 'Iron'], ['pgo7', 'PGO-7']] }] : [])],
    'air-cas': { label: 'Target', key: 'casShape', options: [['point', 'Point'], ['area', 'Area']] },
    'aa-e': { label: 'Helicopter height', key: 'heliAlt', options: HELI_ALTS },
    'cover-route': () => [{ label: 'Travel', key: 'routeMode', options: [['foot', 'Foot'], ['vehicle', 'Vehicle'], ['air', 'Air']] },
      ...(state.routeMode === 'air' ? [{ label: 'Helicopter height', key: 'heliAlt', options: HELI_ALTS }]
        : state.routeMode === 'vehicle' ? [{ label: 'Off-road', key: 'offroad', options: [[true, 'Allow'], [false, 'Roads only']] }]
        : [{ label: 'Swimming', key: 'swim', options: [[false, 'Off'], [true, 'On']] }])],
    radio: { label: `Spawn radius (${RADIO_CLEAR} m)`, key: 'radioRing', options: [[true, 'Show'], [false, 'Hide']] },
    'fire-support': [
      { label: 'Request', key: 'fireShape', options: [['point', 'Point'], ['area', 'Area']] },
      { label: 'Fire', key: 'fireKind', options: Object.entries(FIRE).map(([k, f]) => [k, f.name]) },
    ],
  };
  function pickerHint() {
    const t = state.tool, d = shapeDraft;
    if (t === 'ambush') return !d ? 'Click one end of the kill zone' : d.pts.length === 1 ? 'Click the other end' : 'Click the side your squad waits on';
    if (t === 'sectors') return !d ? 'Click the centre of your position' : 'Move to set size and rotation · click to set';
    if (t === 'vehicle-view-f') return state.armourRange ? 'Click where our vehicle is' : 'Click to mark friendly armour';
    if (t === 'overwatch') return 'Click the objective to find where it can be seen from';
    if (t === 'hulldown') return 'Click the enemy · finds spots where only your turret clears the ridge';
    if (t === 'audible') return 'Click where the shooting is · shows how far away it can be heard';
    if (t === 'profile') return draw ? 'Click the target' : 'Click the start point';
    if (t === 'rocket') return draw ? 'Click the target' : 'Click where you fire from · set the wind in its popup';
    if (t === 'radio') return 'Click where the radio backpack is';
    if (t === 'air-cas') return state.casShape === 'area' ? 'Hold the mouse button and circle the target area; let go and it is sent'
      : 'Click the target and it is sent · add details later with Edit';
    if (t === 'aa-e') return aaDraft ? 'Move to aim · click to set · Esc cancels' : 'Click where the AA gun is';
    if (t === 'heli-route' || t === 'cover-route') return coverHint();
    if (t === 'fire-support') return state.fireShape === 'point' ? 'Click where you want the rounds to land'
      : 'Hold the mouse button and circle where you want the fire; let go to close it';
    if (t === 'enemy-view' && state.enemyView === 'v') return 'Click where the enemy vehicle is';
    if (t === 'infantry') return myPosition() ? 'Click to move your position' : 'Click to mark your position';
    if (UNITS[t]) return `Click to mark ${UNITS[t].toLowerCase()}`;
    if (t === 'contact') return 'Click where you saw the enemy';
    return 'Click where the enemy is watching from';
  }
  // A tool can have several rows of options; number keys run on across them (Area 1, Point 2, HE 3...).
  const pickersFor = tool => [].concat((typeof PICKERS[tool] === 'function' ? PICKERS[tool]() : PICKERS[tool]) || []);
  const pickerOptions = tool => pickersFor(tool).flatMap(pk => pk.options.map(([v]) => [pk, v]));
  function renderPicker() {
    const el = $('#opt-picker'), pks = pickersFor(state.tool);
    el.classList.toggle('hidden', !pks.length);
    if (!pks.length) return;
    el.setAttribute('aria-label', pks.map(pk => pk.label).join(', '));
    let n = 0;
    el.innerHTML = pks.map((pk, g) => `<span class="mp-label">${pk.label}</span>` + pk.options.map(([v, text]) =>
      `<button type="button" role="radio" data-g="${g}" data-v="${v}" class="${state[pk.key] === v ? 'sel' : ''}" aria-checked="${state[pk.key] === v}">${text}<kbd>${++n}</kbd></button>`).join(''))
      .join('<span class="mp-sep" aria-hidden="true"></span>') + `<span class="mp-hint">${pickerHint()}</span>`;
  }
  function setPickerValue(pk, v) {
    if (pk.key === 'noise') return setNoise(v), renderPicker();
    state[pk.key] = v;
    if (pk.key === 'routeMode') cancelCoverDraft();
    if (pk.key === 'heliAlt') { // AA coverage is worked out for the helicopter's height
      state.players.forEach(p => p.items.forEach(it => { if (it.type === 'aa') renderItem(p, it); }));
      updateAaDraft();
    }
    cancelLasso();
    isLassoTool(state.tool) ? map.dragging.disable() : map.dragging.enable();
    const pos = (pk.key === 'posRange' || pk.key === 'posUnit') && myPosition();
    if (pos && pk.key === 'posRange' && (pos.range || 0) !== v) saveItem({ ...pos, range: v }); // change your own range card straight away
    if (pos && pk.key === 'posUnit' && (pos.unit || 'inf') !== v) saveItem({ ...pos, unit: v });
    renderPicker();
    updateShapeDraft();
    updateLive();
  }
  // The toolbar stays on one row: in a narrow window it drops the key hints, then the names (icons only). The
  // options bar, hint and aim picker sit just under it, wherever it ends. Phones have their own layout.
  const toolbarEl = $('#toolbar');
  function fitToolbar() {
    toolbarEl.classList.remove('no-keys', 'icons-only');
    if (innerWidth > 720) {
      // the buttons' own widths (an open menu hangs outside the toolbar, so its scroll width can't be used)
      // plus the toolbar's padding, border and gaps, read from its style
      const tight = () => {
        const cs = getComputedStyle(toolbarEl), kids = [...toolbarEl.children];
        const extra = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth) +
          (parseFloat(cs.columnGap) || 0) * (kids.length - 1);
        return kids.reduce((w, el) => w + el.getBoundingClientRect().width, extra) > toolbarEl.getBoundingClientRect().width + 0.5;
      };
      if (tight()) toolbarEl.classList.add('no-keys');
      if (tight()) { toolbarEl.classList.remove('no-keys'); toolbarEl.classList.add('icons-only'); }
    }
    document.documentElement.style.setProperty('--below-toolbar', `${Math.round(toolbarEl.getBoundingClientRect().bottom + 8)}px`);
  }
  let fitQueued = false;
  const queueFit = () => { if (!fitQueued) { fitQueued = true; setTimeout(() => { fitQueued = false; fitToolbar(); }); } };
  new ResizeObserver(queueFit).observe(toolbarEl);
  new MutationObserver(queueFit).observe(toolbarEl, { subtree: true, childList: true, characterData: true }); // menu names change with the tool
  addEventListener('resize', queueFit);
  fitToolbar();
  $('#opt-picker').addEventListener('click', e => {
    const b = e.target.closest('[data-v]'), pk = b && pickersFor(state.tool)[+b.dataset.g];
    const opt = b && pk && pk.options.find(([v]) => String(v) === b.dataset.v);
    if (opt) setPickerValue(pk, opt[0]);
  });

  // --- Combined line of sight from every visible range card (and enemy view) -------------------------------
  // Range cards: ground seen by at least one is tinted cyan; ground inside their reach that none of them sees is
  // darkened, which is where an enemy can creep up unseen. Enemy views: ground the enemy can see is tinted red.
  const coverageLayer = L.layerGroup();
  let coverageSig = null;
  coverageLayer.on('add remove', e => {
    state.showLos = e.type === 'add';
    state.players.forEach(p => p.items.forEach(it => { if (it.type === 'emplacement' || it.type === 'overwatch' || it.type === 'hulldown') renderItem(p, it); }));
    refreshCoverage(true);
    refreshThreats(true);
  });

  function refreshCoverage(force = false) {
    const posts = allVisibleItems(it => it.type === 'post' || isPositionCard(it)).filter(({ p, it }) => it.type === 'post' || showsPosLos(p, it));
    const sig = posts.map(({ it }) => `${it.id}:${it.xz}:${it.range}:${it.side}:${it.unit}`).join('|') + `|${!!HEIGHT}|${state.showLos}`;
    if (sig === coverageSig && !force) return;
    coverageSig = sig;
    // Reference point labels measure from the nearest range card, so redraw them too.
    state.players.forEach(p => p.items.forEach(it => { if (it.type === 'marker' && it.icon === 'trp') renderItem(p, it); }));
    coverageLayer.clearLayers();
    if (!HEIGHT || !state.showLos || !posts.length) return;
    const all = posts.map(({ it }) => ({ side: it.side || 'f', los: postLos(it) })).filter(x => x.los);
    if (!all.length) return;
    // Results can be full (fine cells) or light (10 m); they're merged on the finest cell among them.
    const C = Math.min(...all.map(x => x.los.cell));
    const minX = Math.min(...all.map(x => x.los.minX)), maxZ = Math.max(...all.map(x => x.los.maxZ));
    const W = Math.round((Math.max(...all.map(x => x.los.minX + x.los.W * x.los.cell)) - minX) / C);
    const H = Math.round((maxZ - Math.min(...all.map(x => x.los.maxZ - x.los.H * x.los.cell))) / C);
    const ours = new Uint8Array(W * H), theirs = new Uint8Array(W * H);
    for (const { side, los } of all) {
      const f = Math.round(los.cell / C); // fine cells per result cell
      const ox = Math.round((los.minX - minX) / C), oz = Math.round((maxZ - los.maxZ) / C);
      const dst = OUR_SIDES.has(side) ? ours : theirs;
      for (let y = 0; y < los.H * f; y++) {
        const row = (y + oz) * W + ox, src = Math.floor(y / f) * los.W;
        if (y + oz >= H) break;
        for (let x = 0; x < los.W * f && x + ox < W; x++) {
          const v = los.cells[src + Math.floor(x / f)];
          if (LOS_RANK[v] > LOS_RANK[dst[row + x]]) dst[row + x] = v; // clear beats through trees beats hidden
        }
      }
    }
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d'), img = ctx.createImageData(W, H), px = img.data;
    for (let k = 0; k < W * H; k++) {
      const i = k * 4;
      // Same key everywhere: clear = tinted (red for the enemy, cyan for us), through trees = yellow, hidden = dark.
      if (theirs[k] === LOS_CLEAR) { px[i] = 255; px[i + 1] = 92; px[i + 2] = 92; px[i + 3] = 88; }
      else if (ours[k] === LOS_CLEAR) { px[i] = 102; px[i + 1] = 217; px[i + 2] = 232; px[i + 3] = 50; }
      else if (theirs[k] === LOS_TREES || ours[k] === LOS_TREES) { px[i] = 255; px[i + 1] = 222; px[i + 2] = 50; px[i + 3] = 80; }
      else if (ours[k] === LOS_HIDDEN) { px[i] = 6; px[i + 1] = 8; px[i + 2] = 12; px[i + 3] = 155; }
    }
    ctx.putImageData(img, 0, 0);
    const bounds = L.latLngBounds(toLL([minX, maxZ - H * C]), toLL([minX + W * C, maxZ]));
    coverageLayer.addLayer(L.imageOverlay(c.toDataURL(), bounds, { interactive: false, className: 'los-overlay' }));
  }

  // --- Range cards and enemy views -----------------------------------------------------------------------
  function postRings(range) {
    const out = [100, 200, 300, 400].filter(r => r <= range), step = range <= 800 ? 200 : 500;
    for (let r = Math.ceil(401 / step) * step; r <= range; r += step) out.push(r);
    return out;
  }
  const EYE_SVG = '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/></svg>';
  const VEHICLE_SVG = '<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="7" rx="3"/><path d="M8 11V8h7v3M15 9.5h6"/></svg>';
  const postIcon = (color, side) => side === 'fv' ? L.divIcon({ className: 'unit-glyph', iconSize: [0, 0], html: unitSvg('arm', 'f') })
    : L.divIcon({ className: 'empl-glyph post-glyph', iconSize: [0, 0],
    html: `<div style="--c:${color}">${side === 'v' || side === 'fv' ? VEHICLE_SVG : side === 'e' ? EYE_SVG : 'OP'}</div>` });

  function drawRangeRings(layer, xz, range, color, rings) {
    rings.forEach(r => {
      const outer = r === range;
      layer.addLayer(L.circle(toLL(xz), { radius: r, color, weight: outer ? 1.8 : 1.1, opacity: outer ? 0.9 : 0.75, dashArray: outer ? '7 5' : '2 5', fill: false, interactive: false }));
      layer.addLayer(L.marker(toLL([xz[0], xz[1] + r]), { interactive: false, keyboard: false,
        icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<span class="ring-label">${fmtDist(r)}</span>` }) }));
    });
  }

  function renderPost(p, it, layer, color, html) {
    const enemy = isEnemyPost(it), c = enemy ? ENEMY : it.side === 'fv' ? FRIENDLY : color, center = toLL(it.xz);
    drawRangeRings(layer, it.xz, it.range, c, enemy ? [it.range] : postRings(it.range));
    const m = L.marker(center, { icon: postIcon(c, it.side), keyboard: false, riseOnHover: true, zIndexOffset: 450 });
    const name = it.label || typeLabel(it);
    m.bindTooltip(esc(isMine(p.name) ? name : `${name} (${p.name})`), { direction: 'right', offset: [16, 0], className: 'item-label' });
    bindInfo(m, html, () => it.xz);
    layer.addLayer(m);
  }

  // --- Reference points (TRPs): labelled with distance and bearing from the nearest range card ------------
  const trpIcon = color => L.divIcon({ className: 'trp-glyph', iconSize: [0, 0],
    html: `<svg viewBox="0 0 24 24" style="--c:${color}"><path class="f" d="M12 2.5l10 18H2z"/><path d="M12 9.5v7M8.5 13h7"/></svg>` });
  function trpRef(xz) {
    let best = null;
    for (const { p, it } of allVisibleItems(isRangeCard)) {
      const d = dist(it.xz, xz);
      if (!best || d < best.d) best = { p, it, d, brg: bearing(it.xz, xz) };
    }
    return best;
  }
  function renderTrp(p, it, layer, color, html) {
    const ref = trpRef(it.xz), name = it.label || 'TRP';
    const text = `${name}${ref ? ` · ${fmtDist(ref.d)} ${pad(Math.round(ref.brg) % 360, 3)}°` : ''}`;
    const m = L.marker(toLL(it.xz), { icon: trpIcon(color), keyboard: false, riseOnHover: true, zIndexOffset: 400 });
    m.bindTooltip(esc(isMine(p.name) ? text : `${text} (${p.name})`), { permanent: true, direction: 'right', offset: [12, 0], className: 'item-label' });
    bindInfo(m, html, () => it.xz);
    layer.addLayer(m);
  }
  const trpRow = (name, from, to, los) => {
    const v = los ? losAt(los, to) : null;
    return `<tr><td>${esc(name)}</td><td>${fmtDist(dist(from, to))}</td><td>${pad(Math.round(bearing(from, to)) % 360, 3)}°</td>` +
      `<td>${v == null ? '—' : v === LOS_CLEAR ? 'Yes' : v === LOS_TREES ? '<span class="trees">Trees</span>' : '<span class="no">No</span>'}</td></tr>`;
  };

  // --- Sectors of fire ---------------------------------------------------------------------------------------
  const SECTOR_COLORS = ['#ffd43b', '#74c0fc', '#8ce99a', '#f783ac', '#ffa94d', '#b197fc', '#66d9e8', '#ff8787'];
  const SECTOR_LETTERS = 'ABCDEFGHIJKL';
  const sectorSpans = it => Array.from({ length: it.n }, (_, i) => [it.start + i * 360 / it.n, it.start + (i + 1) * 360 / it.n]);
  // What a sector holds: the ground its gun position can see (line of sight from GUN_EYE, or higher if the position
  // is raised), marked enemy positions and contacts inside it, and the TRPs in it.
  const inSector = (it, xz, a, span) => {
    const d = dist(it.xz, xz);
    return d > 0 && d <= it.radius && ((bearing(it.xz, xz) - a) % 360 + 360) % 360 <= span;
  };
  const sectorEye = it => gunEye(it.height || 0);
  const sectorLos = (it, a, span) => losGrid(it.xz, a + span / 2, span, it.radius, true, sectorEye(it), TARGET_H, false);
  const sectorFoes = (it, a, span) => allVisibleItems(i => i.type === 'marker' && !!ENEMY_WATCH[i.icon] && timeoutState(i) !== 'expired' && inSector(it, i.xz, a, span))
    .map(({ it: e }) => e).sort((x, y) => dist(it.xz, x.xz) - dist(it.xz, y.xz));
  const sectorTrps = (it, a, span) => allVisibleItems(i => isMarker(i, 'trp') && inSector(it, i.xz, a, span)).map(({ it: t }) => t);
  function renderSectorShapes(it, layer, html) {
    sectorSpans(it).forEach(([a, b], i) => {
      const col = SECTOR_COLORS[i % SECTOR_COLORS.length], span = b - a;
      const los = html && state.showLos ? sectorLos(it, a, span) : null; // dead ground inside each sector is darkened
      if (los) layer.addLayer(losOverlay(los, col, true, 38));
      const foes = html ? sectorFoes(it, a, span).length : 0;
      const poly = L.polygon(sectorLatLngs(it.xz, a + span / 2, span, it.radius), {
        color: col, weight: 1.6, opacity: 0.9, fillColor: col, fillOpacity: 0.1, interactive: !!html, bubblingMouseEvents: false });
      if (html) bindInfo(poly, html);
      layer.addLayer(poly);
      const mid = (a + span / 2) * Math.PI / 180, lp = [it.xz[0] + it.radius * 0.62 * Math.sin(mid), it.xz[1] + it.radius * 0.62 * Math.cos(mid)];
      const name = (it.names || [])[i];
      layer.addLayer(L.marker(toLL(lp), { interactive: false, keyboard: false, icon: L.divIcon({ className: 'sector-label', iconSize: [0, 0],
        html: `<span style="--c:${col}"><b>${SECTOR_LETTERS[i]}</b>${name ? ` ${esc(name)}` : ''}${foes ? ` <i class="foe" title="Enemy in this sector">${foes}</i>` : ''}</span>` }) }));
    });
  }
  function renderSectors(p, it, layer, html) {
    renderSectorShapes(it, layer, html);
    const m = L.marker(toLL(it.xz), { icon: glyphIcon('✚', '#f1f3f5'), keyboard: false, riseOnHover: true, zIndexOffset: 300 });
    const name = it.label || 'Sectors of fire';
    m.bindTooltip(esc(isMine(p.name) ? name : `${name} (${p.name})`), { direction: 'right', offset: [12, 0], className: 'item-label' });
    bindInfo(m, html, () => it.xz);
    layer.addLayer(m);
  }

  // --- Ambush templates ---------------------------------------------------------------------------------------
  // Laid out along the kill zone (from -> to). u runs along the road, v away from it towards the squad's side.
  const AMB = { kz: '#ff5c5c', assault: '#6cb8ff', support: '#ffc53d', security: '#8ce99a' };
  function ambushGeom(a) {
    const len = dist(a.from, a.to), ux = (a.to[0] - a.from[0]) / len, uz = (a.to[1] - a.from[1]) / len;
    const nx = -uz * a.side, nz = ux * a.side;
    const P = (u, v) => [a.from[0] + ux * u + nx * v, a.from[1] + uz * u + nz * v];
    const D = Math.max(35, Math.min(90, len * 0.45)), K = 15, sd = Math.max(80, len * 0.5), road = bearing(a.from, a.to);
    const g = { len, P, kz: [P(0, -K), P(len, -K), P(len, K), P(0, K)],
      security: [[P(-sd, D * 0.5), (road + 180) % 360], [P(len + sd, D * 0.5), road]] };
    if (a.kind === 'l') {
      // Long leg (assault) along the road; short leg (support MG) across the far end, firing down the kill zone.
      g.assault = [P(len * 0.1, D), P(len * 0.9, D)];
      g.support = [P(len + 30, K), P(len + 30, D)];
      g.fire = [[P(len * 0.5, D - 8), P(len * 0.5, K + 3)], [P(len + 24, (K + D) / 2), P(len * 0.45, K * 0.3)]];
    } else {
      g.support = [P(len * 0.05, D), P(len * 0.45, D)];
      g.assault = [P(len * 0.55, D), P(len * 0.95, D)];
      g.fire = [[P(len * 0.25, D - 8), P(len * 0.25, K + 3)], [P(len * 0.75, D - 8), P(len * 0.75, K + 3)]];
    }
    return g;
  }
  const arrowHead = (xz, brg, color, size = 18) => L.marker(toLL(xz), { interactive: false, keyboard: false,
    icon: L.divIcon({ className: 'arrow-head', iconSize: [0, 0],
      html: `<svg viewBox="0 0 20 20" style="width:${size}px;height:${size}px;transform:translate(-50%,-50%) rotate(${brg.toFixed(1)}deg)"><path d="M10 1L18.5 18 10 13.5 1.5 18z" fill="${color}"/></svg>` }) });

  function renderAmbushShapes(a, layer, html) {
    const g = ambushGeom(a), live = !!html;
    const tag = (xz, text, color, cls = '') => layer.addLayer(L.marker(toLL(xz), { interactive: false, keyboard: false,
      icon: L.divIcon({ className: `plan-tag ${cls}`, iconSize: [0, 0], html: `<span style="--c:${color}">${text}</span>` }) }));
    const kz = L.polygon(g.kz.map(toLL), { color: AMB.kz, weight: 2, dashArray: '6 4', fillColor: AMB.kz, fillOpacity: 0.2, interactive: live, bubblingMouseEvents: false });
    if (live) bindInfo(kz, html);
    layer.addLayer(kz);
    tag(g.P(g.len / 2, -27), 'Kill zone', AMB.kz); // on the far side of the road, clear of the drag handle
    g.fire.forEach(([s, e]) => {
      layer.addLayer(L.polyline([toLL(s), toLL(e)], { color: '#f1f3f5', weight: 1.6, opacity: 0.85, dashArray: '4 4', interactive: false }));
      layer.addLayer(arrowHead(e, bearing(s, e), '#f1f3f5', 12));
    });
    const c0 = g.P(g.len / 2, 0);
    [[g.support, AMB.support, 'Support'], [g.assault, AMB.assault, 'Assault']].forEach(([pts, color, name]) => {
      layer.addLayer(L.polyline(pts.map(toLL), { color: '#0d1115', weight: 9, opacity: 0.55, lineCap: 'round', interactive: false }));
      const line = L.polyline(pts.map(toLL), { color, weight: 5, lineCap: 'round', interactive: live, bubblingMouseEvents: false });
      if (live) bindInfo(line, html);
      layer.addLayer(line);
      // Name just outside the element, away from the kill zone
      const mid = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2], dd = dist(c0, mid) || 1;
      tag([mid[0] + (mid[0] - c0[0]) / dd * 14, mid[1] + (mid[1] - c0[1]) / dd * 14], name, color, 'mid');
    });
    g.security.forEach(([xz, brg]) => {
      layer.addLayer(L.marker(toLL(xz), { interactive: false, keyboard: false, icon: L.divIcon({ className: 'sec-glyph', iconSize: [0, 0],
        html: `<svg viewBox="0 0 40 40" style="transform:translate(-50%,-50%) rotate(${brg.toFixed(1)}deg)"><path class="look" d="M20 11V2M15.5 6.5L20 2l4.5 4.5"/><path class="d" d="M20 13l7 7-7 7-7-7z"/></svg>` }) }));
      tag(xz, 'Security', AMB.security, 'below');
    });
  }

  function renderAmbush(p, it, layer, html) {
    renderAmbushShapes(it, layer, html);
    if (isMine(p.name)) ambushHandles(p, it, layer);
  }

  // Your own ambushes get handles: the middle one moves it, the end ones stretch or turn the kill zone.
  function ambushHandles(p, it, layer) {
    const mid = [(it.from[0] + it.to[0]) / 2, (it.from[1] + it.to[1]) / 2];
    let preview = null;
    const moved = (which, xz) => which === 'move'
      ? { ...it, from: [it.from[0] + xz[0] - mid[0], it.from[1] + xz[1] - mid[1]], to: [it.to[0] + xz[0] - mid[0], it.to[1] + xz[1] - mid[1]] }
      : which === 'from' ? { ...it, from: xz } : { ...it, to: xz };
    [['move', mid], ['from', it.from], ['to', it.to]].forEach(([which, xz]) => {
      const h = L.marker(toLL(xz), { draggable: true, keyboard: false, zIndexOffset: 900,
        title: which === 'move' ? 'Drag to move the ambush' : 'Drag to stretch or turn the kill zone',
        icon: L.divIcon({ className: `drag-handle ${which === 'move' ? 'move' : 'end'}`, iconSize: [16, 16] }) });
      h.on('drag', () => {
        const a = moved(which, toXZ(h.getLatLng()));
        if (!preview) preview = L.layerGroup().addTo(map);
        preview.clearLayers();
        if (dist(a.from, a.to) >= 20) renderAmbushShapes(a, preview, null);
      });
      h.on('dragend', () => {
        if (preview) { preview.remove(); preview = null; }
        const a = moved(which, toXZ(h.getLatLng()));
        if (dist(a.from, a.to) < 20) { toast('The kill zone must be at least 20 m long.'); renderItem(p, it); return; }
        saveItem({ ...a, from: roundXZ(a.from), to: roundXZ(a.to) });
      });
      layer.addLayer(h);
    });
  }

  // Placing an ambush (3 clicks: both ends of the kill zone, then the side) or sectors of fire (centre, then size).
  let shapeDraft = null; // {tool, pts, layer}
  function shapeClick(xz) {
    const d = shapeDraft;
    if (!d) {
      shapeDraft = { tool: state.tool, pts: [xz], layer: L.layerGroup().addTo(map) };
      updateShapeDraft(); updateHint(); updateLive();
      return;
    }
    const nextN = type => issueNumber(type, [...(state.players.get(state.me.name)?.items.values() || [])].filter(i => i.type === type).length + 1);
    if (d.tool === 'sectors') {
      const radius = dist(d.pts[0], xz);
      if (radius < 20) return toast('Move further out to set the size.');
      const it = { id: uid(), type: 'sectors', xz: roundXZ(d.pts[0]), radius: Math.round(Math.min(radius, 3000)), start: Math.round(bearing(d.pts[0], xz)) % 360,
        n: state.sectorCount, names: [], label: `Sectors of fire ${nextN('sectors')}`, note: '', color: state.me.color };
      cancelShapeDraft();
      saveItem(it);
      openEditor(it, false); // straight on to who covers each sector
      return;
    }
    if (d.pts.length === 1) {
      if (dist(d.pts[0], xz) < 20) return toast('Make the kill zone at least 20 m long.');
      d.pts.push(xz);
      updateShapeDraft(); updateHint(); updateLive();
      return;
    }
    saveItem({ id: uid(), type: 'ambush', ...ambushFromDraft(d, xz), label: `Ambush ${nextN('ambush')}`, note: '', color: state.me.color });
    cancelShapeDraft();
  }
  function ambushFromDraft(d, c) {
    const [f, t] = d.pts;
    const cross = (t[0] - f[0]) * (c[1] - f[1]) - (t[1] - f[1]) * (c[0] - f[0]); // > 0: cursor is left of the road
    return { kind: state.ambushKind, from: roundXZ(f), to: roundXZ(t), side: cross >= 0 ? 1 : -1 };
  }
  function updateShapeDraft() {
    const d = shapeDraft;
    if (!d) return;
    d.layer.clearLayers();
    const c = lastCursor, o = d.pts[0];
    if (d.tool === 'sectors') {
      if (c && dist(o, c) >= 5) renderSectorShapes({ xz: o, radius: Math.min(dist(o, c), 3000), start: bearing(o, c), n: state.sectorCount, names: [] }, d.layer, null);
    } else if (d.pts.length === 1) {
      if (c) d.layer.addLayer(L.polyline([toLL(o), toLL(c)], { color: AMB.kz, weight: 3, dashArray: '6 6', interactive: false }));
    } else {
      renderAmbushShapes(c ? ambushFromDraft(d, c) : { kind: state.ambushKind, from: o, to: d.pts[1], side: 1 }, d.layer, null);
    }
    d.layer.addLayer(L.circleMarker(toLL(o), { radius: 4, color: '#000', weight: 1.5, fillColor: '#fff', fillOpacity: 1, interactive: false }));
  }
  function cancelShapeDraft() {
    if (!shapeDraft) return;
    shapeDraft.layer.remove();
    shapeDraft = null;
    updateHint();
    updateLive();
  }

  // --- Arrows: our advance, enemy approach, enemy patrol route -------------------------------------------------
  function alongWithBearing(pts, target) {
    let run = 0;
    for (let i = 1; i < pts.length; i++) {
      const seg = dist(pts[i - 1], pts[i]);
      if (run + seg >= target) {
        const k = seg ? (target - run) / seg : 0;
        return [[pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k], bearing(pts[i - 1], pts[i])];
      }
      run += seg;
    }
    return [pts[pts.length - 1], bearing(pts[pts.length - 2], pts[pts.length - 1])];
  }
  function renderArrow(p, it, layer, html) {
    const s = ARROWS[it.kind], pts = it.points, n = pts.length, lls = pts.map(toLL);
    layer.addLayer(L.polyline(lls, { color: '#0d1115', weight: s.weight + 4, opacity: 0.45, interactive: false }));
    const line = L.polyline(lls, { color: s.color, weight: s.weight, dashArray: s.dash, opacity: 0.95, bubblingMouseEvents: false });
    const name = it.label || s.name;
    line.bindTooltip(esc(isMine(p.name) ? name : `${name} (${p.name})`), { sticky: true, className: 'item-label' });
    bindInfo(line, html);
    layer.addLayer(line);
    if (it.kind === 'patrol') {
      // Chevrons along the route show which way the patrol goes.
      const len = pathLength(pts), spacing = Math.max(40, len / 14);
      for (let d = spacing; d < len - spacing / 2; d += spacing) {
        const [xz, brg] = alongWithBearing(pts, d);
        layer.addLayer(L.marker(toLL(xz), { interactive: false, keyboard: false, icon: L.divIcon({ className: 'chev', iconSize: [0, 0],
          html: `<svg viewBox="0 0 12 12" style="transform:translate(-50%,-50%) rotate(${brg.toFixed(1)}deg)"><path d="M2 9l4-5 4 5"/></svg>` }) }));
      }
    }
    layer.addLayer(arrowHead(pts[n - 1], bearing(pts[n - 2], pts[n - 1]), s.color, it.kind === 'advance' ? 26 : 22));
  }

  // ---------------------------------------------------------------------------
  // Terrain checks: overwatch finder, route check, covered route finder, landing zone check
  // ---------------------------------------------------------------------------
  // What the marked enemy can see. Enemy line-of-sight markings use their own reach; other enemy markings are
  // assumed to watch all round from where they are: soldiers crouched out to 800 m, a sniper to 1.2 km, armour from
  // its sights 2 m up to 1.5 km. Contacts and unit markers stop counting once they time out.
  const ENEMY_WATCH = {
    'unit-inf-e': { eye: POST_KIND.e.eye, reach: 800 },
    contact: { eye: POST_KIND.e.eye, reach: 800 },
    enemy: { eye: POST_KIND.e.eye, reach: 800 },
    'enemy-ambush': { eye: POST_KIND.e.eye, reach: 800 },
    sniper: { eye: POST_KIND.e.eye, reach: 1200 },
    'unit-arm-e': { eye: POST_KIND.v.eye, reach: 1500, vehicle: true },
  };
  const isWatcher = it => isEnemyPost(it) || (it.type === 'marker' && !!ENEMY_WATCH[it.icon] && timeoutState(it) !== 'expired');
  function watcherLos(it) {
    if (it.type === 'post') return postLos(it);
    const w = ENEMY_WATCH[it.icon];
    return fieldOfFireLos(it.xz, 0, 360, w.reach, true, w.eye);
  }
  const watchers = () => allVisibleItems(isWatcher).map(({ it }) => ({ name: it.label || typeLabel(it), los: watcherLos(it) })).filter(w => w.los);
  // The best view any watcher has of a spot (LOS_CLEAR, LOS_TREES or 0) and who has it.
  function watchedAt(ws, xz) {
    let best = 0, by = null;
    for (const w of ws) {
      const v = losAt(w.los, xz);
      if ((v === LOS_CLEAR || v === LOS_TREES) && LOS_RANK[v] > LOS_RANK[best]) { best = v; by = w; if (v === LOS_CLEAR) break; }
    }
    return [best, by];
  }
  // Other things a route should stay clear of
  const isRouteHazard = it => it.type === 'marker' && (!!MINES[it.icon] || ['blocked', 'bridge', 'danger'].includes(it.icon));
  const MINE_KEEP_OUT = { 'mine-at': 15, 'mine-ap': 25 }; // metres the covered route finder keeps from minefields
  // Everything that changes a route check; routes are redrawn when it does.
  const threatSig = () => allVisibleItems(it => isWatcher(it) || isEnemyArea(it) || isRouteHazard(it) || it.type === 'aa')
    .map(({ it }) => `${it.id}:${it.xz || it.points}:${it.range || ''}`).join('|') + `|${!!HEIGHT}|${!!CANOPY}`;

  function inPoly(pts, [x, z]) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, zi] = pts[i], [xj, zj] = pts[j];
      if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  }
  // Pace on foot: Arma Reforger's run (100 m in about 30 s timed in game, 3.33 m/s on the flat), slowed by the slope
  // along the direction of travel, so running along a hillside counts as flat. Soldiers in game keep most of their
  // speed on slopes, far more than a real hiker: uphill every 10% of grade costs UPHILL_COST x 10% more time, and
  // downhill is full speed until DOWNHILL_FREE, then slows the same way. Slopes over FOOT_MAX_DEG can't be crossed. m/s.
  // SWIM: Camurac's shore to Seagull Point, 508 m of water, takes 6 min 56 s in game.
  const JOG = 3.33, UPHILL_COST = 1.5, DOWNHILL_FREE = 0.3, SWIM = 508 / 416;
  const FOOT_MAX_DEG = 80, FOOT_MAX_GRADE = Math.tan(FOOT_MAX_DEG * Math.PI / 180);
  const isWater = h => h < 0.5, SWIM_MIN = 25;
  const walkSpeed = grade => JOG / (1 + UPHILL_COST * (grade > 0 ? grade : Math.max(0, -grade - DOWNHILL_FREE)));
  const DRIVE_KMH = 40;
  const fmtTime = s => s < 90 ? `${Math.max(1, Math.round(s))} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round(s / 60) % 60} min`;
  const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const compass = brg => COMPASS[Math.round(brg / 45) % 8];

  // --- Rocket calculator: which sight mark, how much hold and which bearing, for a launcher on a range line -----------
  // The flights, sights and solving are in shot-core.js, shared with the shot planner page (shot/).
  const SC = ShotCore({ ground: p => ground(p), hasGround: () => !!HEIGHT, windParts, fmtDist, dist, bearing });
  const { ROCKET_CHOICES, ROCKET_AIM, SCOPES, GUN_CHOICES, tableOf, rocketName, rocketSolve, sightPicture } = SC;
  // The measured flights (data/rockets.json, about 300 KB, and data/bullets.json) are fetched the first time something
  // needs them: the shot calculator picked, or a shot calculator marking on the map (anyone's). Most visits never do.
  let shotDataAsked = false;
  function needShotData() {
    if (shotDataAsked) return;
    shotDataAsked = true;
    fetch('data/rockets.json')
      .then(r => r.json())
      .then(d => { SC.setRockets(d); rerenderMortars(); }) // rocket shots draw their aim line once the flights are in
      .catch(err => { shotDataAsked = false; console.error(err); toast('Could not load rocket data.', 6000); });
    fetch('data/bullets.json')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!d) return; SC.setBullets(d); rerenderMortars(); })
      .catch(err => console.error(err)); // until bullettest.py has run, the guns just say their data isn't there
  }
  function rocketHtml(owner, it) {
    needShotData();
    if (!SC.rockets) return '<p class="sub">Loading rocket data…</p>';
    const mine = isMine(owner), dis = mine ? '' : ' disabled', { l, r, s } = it.rocket, wind = it.wind || { s: 0, d: 0 }, g = SCOPES[l];
    const opt = (v, t, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(t)}</option>`;
    const sel = (k, opts) => `<select data-rk="${k}" data-id="${esc(it.id)}"${dis}>${opts}</select>`;
    const group = (name, list) => `<optgroup label="${esc(name)}">${list.map(([a, b]) => opt(`${a}|${b}`, rocketName(a, b), a === l && b === r)).join('')}</optgroup>`;
    const weapons = group('Rocket launchers', ROCKET_CHOICES) +
      [...new Set(Object.values(SCOPES).map(q => q.group))].map(gr => group(gr, GUN_CHOICES.filter(([a]) => SCOPES[a].group === gr))).join('');
    let html = '<div class="rk-form">' +
      `<label>Weapon ${sel('w', weapons)}</label>` +
      (l === 'RPG-7' ? `<label>Sight ${sel('s', opt('iron', 'Iron sight', s !== 'pgo7') + opt('pgo7', 'PGO-7 scope', s === 'pgo7'))}</label>` : '') +
      (g && g.target === 'man' ? `<label>You ${sel('h1', EYES.slice(0, 3).map(([v, t]) => opt(v, t, (it.h1 ?? 1.6) === v)).join(''))}</label>` : '') +
      (!g ? `<label>You ${sel('h1', EYES.slice(0, 3).map(([v, t]) => opt(v, t, (it.h1 ?? 1.6) === v)).join(''))}</label>` +
        `<label>Target ${sel('h2', [[0.5, 'Prone'], [1, 'Vehicle hull'], [1.6, 'Standing'], [2.2, 'Vehicle top']].map(([v, t]) => opt(v, t, (it.h2 ?? 1) === v)).join(''))}</label>` : '') +
      `<label>Wind <span><input data-rk="ws" data-id="${esc(it.id)}" type="number" min="0" max="40" step="0.5" value="${wind.s || 0}"${dis}> m/s from ` +
      `<input data-rk="wd" data-id="${esc(it.id)}" type="number" min="0" max="359" step="1" value="${Math.round(wind.d || 0)}"${dis}>°</span></label></div>`;
    if (g && !tableOf(r)) return html + '<p class="sub">This weapon\'s measured flights aren\'t on the site yet (reforger-map-tools bullettest.py).</p>';
    const x = rocketSolve(it);
    if (!x) return html + '<p class="sub">Terrain still loading…</p>';
    const up = `${Math.round(x.H) >= 0 ? '+' : ''}${Math.round(x.H)} m`;
    if (x.err) return html + `<p><b class="rc-no">${esc(x.err)}</b></p><p class="sub">${fmtDist(x.D)}, target ${up}.</p>`;
    const pgo = s === 'pgo7' && l === 'RPG-7', lined = pgo || (g && g.lines);
    const latM = x.D * Math.tan(x.aimOff * Math.PI / 180); // the wind's aim-off at the target, m (+ = right)
    const small = g ? 0.1 : 0.4; // below this the hold is "on the target" (a bullet's hold matters to the decimetre)
    const holdTxt = (Math.abs(x.hold) < small ? 'on the target' : `${Math.abs(x.hold).toFixed(1)} m ${x.hold > 0 ? 'high' : 'low'}`) +
      (Math.abs(latM) >= small ? `, ${Math.abs(latM).toFixed(1)} m ${latM > 0 ? 'right' : 'left'}` : '');
    const markTxt = `${x.mark[0]} m`; // the tile's label already says Line, Zero or Sight
    const side = Math.abs(x.aimOff) < 0.05 ? 'straight at it' : `${Math.abs(x.aimOff).toFixed(1)}° ${x.aimOff > 0 ? 'right' : 'left'} of it, ` +
      `${Math.abs(x.D * Math.tan(x.aimOff * Math.PI / 180)).toFixed(1)} m`;
    // on a scope with a thousandths scale, the hold in its ticks too (up/down, and left/right for the wind)
    const ticks = g && g.mils ? ` (${[Math.abs(x.need - x.mark[1]) >= g.mils / 4 ? `${(Math.abs(x.need - x.mark[1]) / g.mils).toFixed(1)} ${x.hold > 0 ? 'up' : 'down'}` : '',
      Math.abs(x.aimOff) >= g.mils / 4 ? `${(Math.abs(x.aimOff) / g.mils).toFixed(1)} ${x.aimOff > 0 ? 'right' : 'left'}` : ''].filter(Boolean).join(', ') || 'centre'} ticks)` : '';
    html += `<div class="stats rk wrap"><div><span class="k">${lined ? 'Line' : g ? 'Zero' : 'Sight'}</span><span class="v">${markTxt}</span></div>` +
      `<div><span class="k">Hold</span><span class="v">${holdTxt}${ticks}</span></div>` +
      `<div><span class="k">Aim</span><span class="v">${x.aim.toFixed(1)}°</span></div>` +
      `<div><span class="k">Flight</span><span class="v">${x.sol.t.toFixed(1)} s</span></div></div>` +
      `<p class="sub">Target ${fmtDist(x.D)} away on ${x.az.toFixed(1)}°, ${up}. Aim ${side}` +
      (pgo && Math.abs(x.aimOff) >= 0.05 ? ` (target on the ${(Math.abs(x.aimOff) / SC.rockets.pgo7_lead_deg).toFixed(1)} mark ${x.aimOff > 0 ? 'left' : 'right'} of centre)` : '') +
      `. Needs ${x.need.toFixed(2)}° over the line of sight` + (x.past > 0 ? `, more than the top ${lined ? 'line' : g ? 'zero' : 'mark'} gives`
        : x.past < 0 ? `, less than the lowest ${lined ? 'line' : g ? 'zero' : 'mark'} gives` : `, as a ${Math.round(x.equiv / 5) * 5} m ${lined ? 'line' : g ? 'zero' : 'mark'} would`) +
      (x.sol.e < x.R.elevs[0] || x.sol.e > x.R.elevs.at(-1) ? ` (${x.sol.e.toFixed(0)}° from level: steeper than the tested shots, so less exact)` : '') + '.</p>';
    html += sightPicture(x, it);
    if (x.calm && !x.calm.err) {
      const de = x.sol.e - x.calm.e;
      html += `<p class="sub">Wind ${wind.s} m/s from ${pad(Math.round(wind.d) % 360, 3)}°: without aiming off it would land ` +
        `${Math.abs(x.sol.side).toFixed(1)} m ${x.sol.side > 0 ? 'right' : 'left'}` +
        (Math.abs(de * Math.PI / 180 * x.D) >= 0.3 ? ` and ${Math.abs(de * Math.PI / 180 * x.D).toFixed(1)} m ${de > 0 ? 'low' : 'high'}` : '') + '.' +
        (!g && x.upwind && Math.abs(x.sol.side) > 0.3 ? ' Its motor turns it into the wind while it burns, so it ends up upwind.' : '') + '</p>';
    }
    if (!g && x.R.spread > 5) html += `<p class="sub">This rocket's motor varies: about ±${Math.round(x.R.spread)} m in range from one to the next.</p>`;
    return html;
  }
  document.addEventListener('change', e => {
    const el = e.target.closest('[data-rk]');
    const it = el && state.me && state.players.get(state.me.name)?.items.get(el.dataset.id);
    if (!it || !it.rocket) return;
    const next = { ...it, rocket: { ...it.rocket } };
    const k = el.dataset.rk, v = el.value;
    if (k === 'w') {
      [next.rocket.l, next.rocket.r] = v.split('|');
      next.rocket.s = SCOPES[next.rocket.l] ? 'scope' : next.rocket.l === 'RPG-7' ? (it.rocket.s === 'pgo7' ? 'pgo7' : 'iron') : 'iron';
    }
    if (k === 's') next.rocket.s = v;
    if (k === 'h1' || k === 'h2') next[k] = +v;
    if (k === 'ws' || k === 'wd') {
      const box = el.closest('.rk-form'), ws = Math.min(Math.max(+box.querySelector('[data-rk="ws"]').value || 0, 0), 40);
      const wd = ((Math.round(+box.querySelector('[data-rk="wd"]').value || 0) % 360) + 360) % 360;
      if (ws > 0) next.wind = { s: ws, d: wd }; else delete next.wind;
      state.rkWind = next.wind || null; // new rocket shots start with the last wind entered
    }
    state.rkChoice = `${next.rocket.l}|${next.rocket.r}`;
    state.rkSight = next.rocket.s;
    state.openPopupId = it.id; // re-open with the new solution once it's saved
    saveItem(next);
  });
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-rk-add]');
    const it = b && state.me && state.players.get(state.me.name)?.items.get(b.dataset.id);
    if (!it) return;
    const [l, r] = state.rkChoice.split('|');
    state.openPopupId = it.id;
    saveItem({ ...it, rocket: { l, r, s: SCOPES[l] ? 'scope' : l === 'RPG-7' ? state.rkSight : 'iron' }, ...(state.rkWind ? { wind: state.rkWind } : {}) });
  });

  // --- Elevation profile: a side-on slice of the ground between two points, with the sight line across it ----------
  // Ground from the 10 m heights (sea at 0), trees from the canopy heights and buildings from their heights, all above
  // the ground under them. The ground alone decides the first row (a hill in the way); the line-of-sight model in the
  // viewer's chosen detail decides the second, since it also counts trees and buildings.
  function sightProfile(from, to, h1, h2) {
    const D = dist(from, to);
    if (!HEIGHT || D < 1) return null;
    const N = Math.min(300, Math.max(24, Math.round(D / 6))), pts = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N, p = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
      pts.push({ d: D * t, xz: p, g: ground(p), tree: i && i < N ? canopyTop(p) : 0, bld: i && i < N ? buildingTop(p) : 0 });
    }
    const eye = pts[0].g + h1, tgt = pts[N].g + h2, slope = (tgt - eye) / D;
    let block = null, worst = 0; // the ground that stands highest above the sight line
    for (const s of pts.slice(1, N)) if (s.g - (eye + slope * s.d) > worst) { worst = s.g - (eye + slope * s.d); block = s; }
    const los = losGrid(from, bearing(from, to), 0.02, D + 12, true, h1, h2, false);
    return { pts, D, eye, tgt, h1, h2, block, view: los ? losAt(los, to) : undefined };
  }
  function sightHtml(pr) {
    if (!pr) return '<p class="sub">Terrain still loading…</p>';
    const { pts, D, eye, tgt, block, view } = pr;
    const W = 300, H = 96;
    const lo = Math.floor(Math.min(...pts.map(s => s.g), eye, tgt) - 1);
    const hi = Math.ceil(Math.max(...pts.map(s => s.g + Math.max(s.tree, s.bld)), eye, tgt) + 2);
    const X = d => (d / D * W).toFixed(1), Y = h => (H - 2 - (h - lo) / (hi - lo) * (H - 6)).toFixed(1);
    const area = f => `<polygon points="${pts.map(s => `${X(s.d)},${Y(s.g + f(s))}`).join(' ')} ${pts.map(s => `${X(s.d)},${Y(s.g)}`).reverse().join(' ')}"/>`;
    const gline = pts.map(s => `${X(s.d)},${Y(s.g)}`).join(" ");
    const kind = block || view === LOS_HIDDEN ? 'no' : view === LOS_TREES ? 'trees' : 'ok';
    const sight = block ? `<line class="sight no" x1="0" y1="${Y(eye)}" x2="${X(block.d)}" y2="${Y(eye + (tgt - eye) * block.d / D)}"/>` +
        `<line class="sight cut" x1="${X(block.d)}" y1="${Y(eye + (tgt - eye) * block.d / D)}" x2="${W}" y2="${Y(tgt)}"/>`
      : `<line class="sight ${kind}" x1="0" y1="${Y(eye)}" x2="${W}" y2="${Y(tgt)}"/>`;
    const svgHtml = `<div class="profile prof-side"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
      `<g class="can">${area(s => s.tree)}</g><g class="bld">${area(s => s.bld)}</g>` +
      `<polygon class="fill" points="0,${H} ${gline} ${W},${H}"/><polyline class="ln" points="${gline}"/>${sight}` +
      `<line class="man" x1="0" y1="${Y(pts[0].g)}" x2="0" y2="${Y(eye)}"/><line class="man" x1="${W}" y1="${Y(pts[pts.length - 1].g)}" x2="${W}" y2="${Y(tgt)}"/></svg>` +
      `<div class="profile-scale"><span>${hi} m</span><span>${lo} m</span></div>` +
      `<div class="profile-axis"><span>Start</span><span>${fmtDist(D)}</span></div></div>`;
    const rise = pts[pts.length - 1].g - pts[0].g;
    const verdict = block ? `<b class="rc-no">Ground blocks it</b> at ${fmtDist(block.d)}, grid ${grid(block.xz)}`
      : view === LOS_CLEAR ? '<b class="rc-ok">Clear view</b>' : view === LOS_TREES ? '<b class="rc-trees">Seen through trees</b>'
      : view === LOS_HIDDEN ? '<b class="rc-no">Trees or buildings block it</b>' : '<span class="sub">Working out the view…</span>';
    const eyeName = h => (EYES.find(([v]) => v === h) || [0, `${h} m up`])[1].toLowerCase();
    return svgHtml + `<p>${verdict}</p><p class="sub">${Math.round(rise) >= 0 ? '+' : ''}${Math.round(rise)} m from start to end · ${eyeName(pr.h1)} to ${eyeName(pr.h2)}` +
      ` · ${Math.round((H - 6) / (hi - lo) / (W / D))}× height. Green: trees, grey: buildings.</p>`;
  }

  // --- Route check: height profile, time, and where marked enemies can see it -------------------------------
  const routeCache = new Map();
  function routeCheck(pts) {
    if (!HEIGHT) return null;
    const key = `${pts.join(';')}#${threatSig()}`;
    if (routeCache.has(key)) return routeCache.get(key);
    const total = pathLength(pts), step = Math.max(10, total / 500);
    const ws = watchers(), areas = allVisibleItems(isEnemyArea).map(({ it }) => it);
    const ds = [];
    for (let d = 0; d < total; d += step) ds.push(d);
    ds.push(total);
    const S = ds.map(d => {
      const xz = pointAlong(pts, d), [seen, by] = watchedAt(ws, xz);
      return { d, xz, h: heightAt(xz), seen, by };
    });
    let climb = 0, descent = 0, walk = 0, steep = 0, seenClear = 0, seenTrees = 0, swim = 0, wet = 0;
    // Swimming: runs of water at least SWIM_MIN long (shorter dips are the shoreline, walked like flat ground).
    const endWet = () => { if (wet) { walk += wet >= SWIM_MIN ? wet / SWIM : wet / JOG; if (wet >= SWIM_MIN) swim += wet; wet = 0; } };
    for (let i = 1; i < S.length; i++) {
      const a = S[i - 1], b = S[i], len = b.d - a.d;
      if (len <= 0) continue;
      if (isWater(a.h) && isWater(b.h)) {
        wet += len;
        if (b.seen === LOS_CLEAR) seenClear += len; else if (b.seen === LOS_TREES) seenTrees += len;
        continue;
      }
      endWet();
      const dh = b.h - a.h, g = dh / len;
      if (dh > 0) climb += dh; else descent -= dh;
      steep = Math.max(steep, Math.abs(g));
      walk += len / walkSpeed(g);
      if (b.seen === LOS_CLEAR) seenClear += len; else if (b.seen === LOS_TREES) seenTrees += len;
    }
    endWet();
    // Exposed stretches: runs of samples with the same view, widened by half a step at each end.
    const stretches = [];
    for (let i = 0; i < S.length; i++) {
      if (!S[i].seen) continue;
      let j = i;
      while (j + 1 < S.length && S[j + 1].seen === S[i].seen) j++;
      const from = Math.max(0, S[i].d - step / 2), to = Math.min(total, S[j].d + step / 2);
      stretches.push({ kind: S[i].seen === LOS_CLEAR ? 'clear' : 'trees', from, to, by: S[i].by.name,
        pts: [pointAlong(pts, from), ...S.slice(i, j + 1).map(s => s.xz), pointAlong(pts, to)] });
      i = j;
    }
    const crossed = areas.filter(a => S.some(s => inPoly(a.points, s.xz))).map(a => a.label || 'Enemy in area');
    const hazards = allVisibleItems(isRouteHazard).map(({ it }) => {
      let best = null;
      S.forEach(s => { const d = dist(s.xz, it.xz); if (d <= 30 && (!best || d < best.off)) best = { off: d, d: s.d }; });
      return best && { name: it.label || typeLabel(it), ...best };
    }).filter(Boolean).sort((a, b) => a.d - b.d);
    const hs = S.map(s => s.h);
    const res = { total, climb, descent, steep, walk, swim, drive: total / (DRIVE_KMH / 3.6), seenClear, seenTrees, stretches, crossed, hazards,
      watchers: ws.length, profile: S, minH: Math.min(...hs), maxH: Math.max(...hs) };
    if (routeCache.size > 40) routeCache.clear();
    routeCache.set(key, res);
    return res;
  }
  // Exposed stretches drawn as a glow under the route: red where a marked enemy sees it clearly, yellow through trees.
  function drawExposure(layer, rc) {
    rc.stretches.forEach(s => layer.addLayer(L.polyline(s.pts.map(toLL), {
      color: s.kind === 'clear' ? '#ff3b3b' : '#ffde32', weight: 13, opacity: s.kind === 'clear' ? 0.6 : 0.5, lineCap: 'round', interactive: false })));
  }
  function profileSvg(rc) {
    const W = 300, H = 70, lo = Math.floor(rc.minH), hi = Math.max(Math.ceil(rc.maxH), lo + 10), span = rc.total || 1;
    const X = d => (d / span * W).toFixed(1), Y = h => (H - 3 - (h - lo) / (hi - lo) * (H - 10)).toFixed(1);
    const line = rc.profile.map(s => `${X(s.d)},${Y(s.h)}`).join(' ');
    const bands = rc.stretches.map(s => `<rect class="${s.kind}" x="${X(s.from)}" y="0" width="${Math.max(1.5, X(s.to) - X(s.from))}" height="${H}"/>`).join('');
    return `<div class="profile"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bands}` +
      `<polygon class="fill" points="0,${H} ${line} ${W},${H}"/><polyline class="ln" points="${line}"/></svg>` +
      `<div class="profile-scale"><span>${hi} m</span><span>${lo} m</span></div>` +
      `<div class="profile-axis"><span>Start</span><span>${fmtDist(rc.total)}</span></div></div>`;
  }
  function routeCheckHtml(rc) {
    if (!rc) return '<p class="sub">Terrain still loading…</p>';
    let html = `<div class="stats wrap"><div><span class="k">On foot</span><span class="v">${fmtTime(rc.walk)}</span></div>` +
      `<div><span class="k">Vehicle</span><span class="v">${fmtTime(rc.drive)}</span></div>` +
      `<div><span class="k">Up / down</span><span class="v">${Math.round(rc.climb)} / ${Math.round(rc.descent)} m</span></div></div>` +
      profileSvg(rc) + `<p class="sub">Steepest stretch ${Math.round(rc.steep * 100)}%${rc.swim ? ` · swims ${fmtDist(rc.swim)}` : ''}.</p>`;
    if (!rc.watchers) {
      html += '<p class="sub">Mark enemies to see where it\'s exposed.</p>';
    } else if (!rc.seenClear && !rc.seenTrees) {
      html += `<p><b class="rc-ok">Out of sight</b> of all ${rc.watchers} marked enemy position${rc.watchers === 1 ? '' : 's'}.</p>`;
    } else {
      html += `<p>${rc.seenClear ? `<b class="rc-no">Seen for ${fmtDist(rc.seenClear)}</b> (${Math.round(rc.seenClear / rc.total * 100)}%)` : '<b class="rc-ok">Never seen clearly</b>'}` +
        `${rc.seenTrees ? `, <span class="rc-trees">through trees for ${fmtDist(rc.seenTrees)}</span>` : ''}</p>`;
      html += '<table class="fire trp-table"><tr><th>Along the route</th><th>Seen by</th><th>View</th></tr>' + rc.stretches.slice(0, 6).map(s =>
        `<tr><td>${fmtDist(s.from)}–${fmtDist(s.to)}</td><td>${esc(s.by)}</td><td>${s.kind === 'clear' ? '<span class="no">Clear</span>' : '<span class="trees">Trees</span>'}</td></tr>`).join('') +
        '</table>' + (rc.stretches.length > 6 ? `<p class="sub">…and ${rc.stretches.length - 6} more stretches.</p>` : '');
    }
    if (rc.crossed.length) html += `<p><b class="rc-no">Goes through</b> ${rc.crossed.map(esc).join(', ')}</p>`;
    if (rc.hazards.length) html += `<p><b class="rc-warn">Passes close to</b> ${rc.hazards.map(h => `${esc(h.name)} (${fmtDist(h.d)} along)`).join(', ')}</p>`;
    return html + '<p class="sub">Red: seen clearly · yellow: through trees</p>';
  }
  // Redraw routes when what they are checked against changes.
  let threatSigLast = null;
  function refreshThreats(force = false) {
    const sig = `${threatSig()}|${state.showLos}`;
    if (sig === threatSigLast && !force) return;
    threatSigLast = sig;
    state.players.forEach(p => p.items.forEach(it => { if (it.type === 'route' || isMarker(it, 'radio')) renderItem(p, it); }));
    replanFootRoutes();
  }
  // Your planned foot routes re-plan themselves (on your page, so everyone sees one answer) when enemies change.
  let replanTimer = null;
  function replanFootRoutes() {
    clearTimeout(replanTimer);
    replanTimer = setTimeout(() => {
      const me = state.me && state.players.get(state.me.name);
      if (!me || !HEIGHT) return;
      const ws = watchers();
      me.items.forEach(it => {
        if (it.type !== 'route' || !it.plan || !['foot', 'vehicle'].includes(it.plan.mode)) return;
        const veh = it.plan.mode === 'vehicle';
        const r = veh ? (ROADS ? findVehicleRoute(it.plan.from, it.plan.to, ws, !it.plan.roadsOnly) : null) : null;
        const pts = veh ? r?.pts : findCoveredRoute(it.plan.from, it.plan.to, ws, !!it.plan.swim);
        const steep = r?.steep?.length ? r.steep : undefined;
        if (pts && (pts.join(';') !== it.points.join(';') || (veh && JSON.stringify(steep) !== JSON.stringify(it.steep)))) {
          const next = { ...it, points: pts, plan: { ...it.plan, at: Date.now() } };
          if (steep) next.steep = steep; else delete next.steep;
          saveItem(next);
        }
      });
    }, 400);
  }

  // --- Overwatch finder: where can we see the objective from? ----------------------------------------------------
  state.owRange = 800;
  const owIcon = color => L.divIcon({ className: 'ow-glyph', iconSize: [0, 0],
    html: `<svg viewBox="0 0 24 24" style="--c:${color}"><circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2" class="f"/><path d="M12 1.5v5M12 17.5v5M1.5 12h5M17.5 12h5"/></svg>` });
  function renderOverwatch(p, it, layer, color, html) {
    const los = state.showLos ? overwatchLos(it.xz, it.range) : null;
    if (los) layer.addLayer(losOverlay(los, color, false, 95)); // ground that can't see it stays unshaded
    layer.addLayer(L.circle(toLL(it.xz), { radius: it.range, color, weight: 1.6, opacity: 0.85, dashArray: '7 5', fill: false, interactive: false }));
    const m = L.marker(toLL(it.xz), { icon: owIcon(color), keyboard: false, riseOnHover: true, zIndexOffset: 450 });
    const name = it.label || 'Overwatch';
    m.bindTooltip(esc(isMine(p.name) ? name : `${name} (${p.name})`), { direction: 'right', offset: [14, 0], className: 'item-label' });
    bindInfo(m, html, () => it.xz);
    layer.addLayer(m);
  }
  // Standout spots with a clear view, at least OW_MIN out (right on top of the objective is no overwatch):
  // the closest, and the highest.
  const OW_MIN = 150;
  function clearSpots(los, xz) {
    let near = null, high = null;
    for (let cz = 0; cz < los.H; cz++) for (let cx = 0; cx < los.W; cx++) {
      if (los.cells[cz * los.W + cx] !== LOS_CLEAR) continue;
      const c = [los.minX + (cx + 0.5) * los.cell, los.maxZ - (cz + 0.5) * los.cell], d = dist(xz, c);
      if (d < OW_MIN) continue;
      const h = heightAt(c);
      if (!near || d < near.d) near = { xz: c, d, h };
      if (!high || h > high.h) high = { xz: c, d, h };
    }
    return { near, high };
  }
  function overwatchHtml(it) {
    const los = overwatchLos(it.xz, it.range), alt = heightAt(it.xz);
    if (!los) return '<p class="sub">Terrain still loading…</p>';
    const { near, high } = clearSpots(los, it.xz);
    const spot = s => `<b>${fmtDist(s.d)} ${compass(bearing(it.xz, s.xz))}</b> of it, grid ${grid(s.xz)} (${Math.round(s.h - alt) >= 0 ? '+' : ''}${Math.round(s.h - alt)} m)`;
    return `<div class="stats"><div><span class="k">Reach</span><span class="v">${fmtDist(it.range)}</span></div>` +
      `<div><span class="k">Clear view from</span><span class="v">${los.pct}%</span></div>` +
      `<div><span class="k">Height</span><span class="v">${alt != null ? Math.round(alt) + ' m' : '—'}</span></div></div>` +
      (los.treePct ? `<p class="sub">+${los.treePct}% through trees</p>` : '') +
      (near ? `<p>Closest clear view beyond ${OW_MIN} m: ${spot(near)}</p>` +
          (high !== near && high.h - near.h >= 5 ? `<p>Highest clear view: ${spot(high)}</p>` : '')
        : `<p><b class="rc-no">Nowhere ${OW_MIN} m to ${fmtDist(it.range)} out</b> has a clear view of it.</p>`) +
      '<p class="sub">Tinted: can see it · yellow: through trees</p>';
  }

  // --- Hull-down finder: where can a vehicle see the enemy with only its turret above the ridge? ----------------------
  // From the enemy's spot, ground where the vehicle's sights (turret) are in view of the enemy while its hull is not:
  // the two line-of-sight results the overwatch finder uses, one for each height. Shaded green where the enemy can see
  // the turret clearly and the hull is hidden, yellow where the turret is only seen through trees. Water, woods and
  // ground steeper than HD_SLOPE are left out (nowhere to drive).
  // sights: the vehicle's overall height with its turret, from the real vehicle (BTR-70 2.32 m, BRDM-2 2.31 m,
  // LAV-25 2.69 m). hull: where the body ends and the turret begins, estimated; the game's own numbers aren't published.
  const HULL = {
    btr70: { name: 'BTR-70', short: 'BTR-70', hull: 1.9, sights: 2.3 },
    brdm2: { name: 'BRDM-2', short: 'BRDM-2', hull: 1.75, sights: 2.3 },
    lav25: { name: 'LAV-25', short: 'LAV-25', hull: 2.0, sights: 2.65 },
  };
  const hullOf = it => HULL[it.veh] || HULL.btr70; // older markings said "apc"; that was the BTR-70's numbers
  const HD_FOE = { s: 1.6, v: 2.0 }, HD_SLOPE = 0.5, HD_MIN = 60, HD_BACK = 30; // enemy height (m); steepest ground (rise per run); nearest to the enemy (m); how far back cover is shown (m)
  const hdCache = new Map();
  function hullDown(it) {
    const v = hullOf(it), fh = HD_FOE[it.foe] || HD_FOE.s;
    const a = losGrid(it.xz, 0, 360, it.range, true, fh, v.sights, true), b = losGrid(it.xz, 0, 360, it.range, true, fh, v.hull, true);
    if (!a || !b) return null;
    if (a.cell !== b.cell || a.W !== b.W || a.H !== b.H) return { pending: true }; // one of them is still being worked out in full
    // Ground and slope come from the engine's 1 m terrain (groundFine) where its tiles have arrived, else the 10 m heights;
    // the result is worked out again when more tiles land (afterDetail bumps detailGen).
    const key = `${it.xz}|${it.range}|${it.veh}|${it.foe}|${detailGen}`; // the vehicle name picks the heights
    const hit = hdCache.get(key);
    if (hit && hit.a === a && hit.b === b) return hit.res;
    const cells = new Uint8Array(a.W * a.H); // 0 no, 1 hull-down, 2 turret only through trees, 3 defilade
    let n = 0, total = 0;
    const spots = [];
    for (let cz = 0; cz < a.H; cz++) for (let cx = 0; cx < a.W; cx++) {
      const i = cz * a.W + cx, sees = a.cells[i], hull = b.cells[i];
      if (!sees) continue;
      const xz = [a.minX + (cx + 0.5) * a.cell, a.maxZ - (cz + 0.5) * a.cell], d = dist(xz, it.xz);
      if (d < HD_MIN) continue;
      total++;
      if (hull !== LOS_HIDDEN || sees === LOS_HIDDEN) continue;
      const h = groundFine(xz);
      if (h == null || h < 0.5 || isForest(xz)) continue;
      const dx = groundFine([xz[0] + 3, xz[1]]) - groundFine([xz[0] - 3, xz[1]]), dz = groundFine([xz[0], xz[1] + 3]) - groundFine([xz[0], xz[1] - 3]);
      if (Math.hypot(dx, dz) / 6 > HD_SLOPE) continue;
      cells[i] = sees === LOS_CLEAR ? 1 : 2;
      if (sees === LOS_CLEAR) { n++; spots.push({ xz, d, h }); }
    }
    // Defilade: drivable ground hidden from the enemy (hull and sights) within HD_BACK of a hull-down spot, where a
    // vehicle can wait out of sight and then move up.
    const r = Math.ceil(HD_BACK / a.cell);
    for (let cz = 0; cz < a.H; cz++) for (let cx = 0; cx < a.W; cx++) {
      if (cells[cz * a.W + cx] !== 1) continue;
      for (let z = Math.max(0, cz - r); z <= Math.min(a.H - 1, cz + r); z++) for (let x = Math.max(0, cx - r); x <= Math.min(a.W - 1, cx + r); x++) {
        const j = z * a.W + x;
        if (cells[j] || a.cells[j] !== LOS_HIDDEN || b.cells[j] !== LOS_HIDDEN || Math.hypot(x - cx, z - cz) * a.cell > HD_BACK) continue;
        const q = [a.minX + (x + 0.5) * a.cell, a.maxZ - (z + 0.5) * a.cell], h = groundFine(q);
        if (dist(q, it.xz) < HD_MIN || h == null || h < 0.5 || isForest(q)) continue;
        cells[j] = 3;
      }
    }
    const res = { cells, W: a.W, H: a.H, minX: a.minX, maxZ: a.maxZ, cell: a.cell, bounds: a.bounds, n, total, spots };
    if (hdCache.size > 20) hdCache.clear();
    hdCache.set(key, { a, b, res });
    return res;
  }
  function hullImage(r) {
    const c = document.createElement('canvas');
    c.width = r.W; c.height = r.H;
    const ctx = c.getContext('2d'), img = ctx.createImageData(r.W, r.H), px = img.data;
    const put = (k, rgb, a) => { const i = k * 4; px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2]; px[i + 3] = a; };
    r.cells.forEach((v, k) => { if (v === 3) put(k, [108, 184, 255], 105); });
    const grow = r.cell < 5 ? 1 : 0; // a ridge is only a cell or two wide: draw it a little fatter so it shows
    r.cells.forEach((v, k) => {
      if (v !== 1 && v !== 2) return;
      const cx = k % r.W, cz = (k - cx) / r.W, rgb = v === 1 ? [84, 255, 120] : [255, 222, 50], al = v === 1 ? 200 : 130;
      for (let z = Math.max(0, cz - grow); z <= Math.min(r.H - 1, cz + grow); z++) for (let x = Math.max(0, cx - grow); x <= Math.min(r.W - 1, cx + grow); x++) put(z * r.W + x, rgb, al);
    });
    ctx.putImageData(img, 0, 0);
    return c.toDataURL();
  }
  function renderHullDown(p, it, layer, color, html) {
    const r = state.showLos ? hullDown(it) : null;
    if (r && !r.pending) layer.addLayer(L.imageOverlay(hullImage(r), r.bounds, { interactive: false, className: 'los-overlay' }));
    layer.addLayer(L.circle(toLL(it.xz), { radius: it.range, color: '#ff5c5c', weight: 1.6, opacity: 0.75, dashArray: '7 5', fill: false, interactive: false }));
    const m = L.marker(toLL(it.xz), { icon: L.divIcon({ className: 'ow-glyph', iconSize: [0, 0],
      html: '<svg viewBox="0 0 24 24" style="--c:#ff5c5c"><circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2" class="f"/><path d="M12 1.5v5M12 17.5v5M1.5 12h5M17.5 12h5"/></svg>' }),
      keyboard: false, riseOnHover: true, zIndexOffset: 450 });
    const name = it.label || 'Hull-down';
    m.bindTooltip(esc(isMine(p.name) ? name : `${name} (${p.name})`), { direction: 'right', offset: [14, 0], className: 'item-label' });
    bindInfo(m, html, () => it.xz);
    layer.addLayer(m);
  }
  function hullDownHtml(it) {
    const r = hullDown(it), v = hullOf(it), alt = heightAt(it.xz);
    if (!r) return '<p class="sub">Terrain still loading…</p>';
    if (r.pending) return '<p class="sub">Working out the view…</p>';
    // Firing spots at least OW_MIN out, closest first, keeping each 80 m from the last one listed.
    const list = [];
    r.spots.filter(s => s.d >= OW_MIN).sort((x, y) => x.d - y.d).forEach(s => { if (list.length < 3 && list.every(o => dist(o.xz, s.xz) >= 80)) list.push(s); });
    const spot = s => `<li><b>${fmtDist(s.d)} ${compass(bearing(it.xz, s.xz))}</b> of them, grid ${grid(s.xz)} (${Math.round(s.h - alt) >= 0 ? '+' : ''}${Math.round(s.h - alt)} m)</li>`;
    return `<div class="stats"><div><span class="k">Enemy</span><span class="v">${it.foe === 'v' ? 'Vehicle' : 'Soldier'}</span></div>` +
      `<div><span class="k">Vehicle</span><span class="v">${v.name}</span></div>` +
      `<div><span class="k">Hull-down ground</span><span class="v">${r.total ? (r.n / r.total * 100).toFixed(1) : 0}%</span></div></div>` +
      (list.length ? `<p>Closest hull-down spots beyond ${OW_MIN} m:</p><ul class="hd-list">${list.map(spot).join('')}</ul>`
        : `<p><b class="rc-no">No hull-down ground</b> ${OW_MIN} m to ${fmtDist(it.range)} out.</p>`) +
      `<p class="sub">Green: turret seen, hull hidden (hull ${v.hull} m, sights ${v.sights} m) · yellow: through trees · blue: hidden, within ${HD_BACK} m of green</p>`;
  }

  // --- Route planner (foot): the quickest way on foot around marked enemies ---------------------------------------
  // A* over the 10 m grid, costed in travel time at a jog (slopes slow it down, over FOOT_MAX_DEG is impassable) and
  // multiplied where it would be seen: x10 where a marked enemy sees clearly, x2.5 through trees. Keep-out rings around
  // marked enemies (FOOT_BERTH) cost 50 times more, so the route only goes through one when there is no other way.
  // Minefields are off limits, and so is the sea unless swimming is on (at SWIM, with no slope limit). The search is
  // boxed around the start and end, at any distance.
  const FOOT_BERTH = { infantry: 300, armour: 500, aa: 500, area: 100 };
  let coverDraft = null; // {start, layer, pts}
  const airRouting = () => state.tool === 'heli-route' || (state.tool === 'cover-route' && state.routeMode === 'air');
  function coverHint() {
    if (airRouting()) {
      return !coverDraft ? 'Click the start (snaps to LZs) · avoids marked enemies and AA'
        : !coverDraft.pts ? 'Click where the flight ends' : 'Save from the popup, or click to start again';
    }
    if (state.tool === 'cover-route' && state.routeMode === 'vehicle') {
      return !coverDraft ? 'Click the start · quickest drive out of sight of marked enemies'
        : !coverDraft.pts ? 'Click where the drive ends' : 'Save from the popup, or click to start again';
    }
    return !coverDraft ? 'Click the start · quickest foot route around marked enemies'
      : !coverDraft.pts ? 'Click where the route ends' : 'Save from the popup, or click to start again';
  }
  function cancelCoverDraft() {
    if (!coverDraft) return;
    coverDraft.layer.remove();
    coverDraft = null;
    updateHint();
  }
  function coverClick(xz) {
    if (HEIGHT && heightAt(xz) < 0.5) return toast("That's in the water. Pick a spot on land.");
    if (!coverDraft || coverDraft.pts) {
      cancelCoverDraft();
      coverDraft = { start: xz, layer: L.layerGroup().addTo(map) };
      coverDraft.layer.addLayer(L.circleMarker(toLL(xz), { radius: 5, color: '#000', weight: 1.5, fillColor: state.me.color, fillOpacity: 1, interactive: false }));
      updateHint();
      return;
    }
    const from = coverDraft.start, D = dist(from, xz);
    if (D < 50) return toast('Pick an end at least 50 m from the start.');
    if (!HEIGHT) return toast('Terrain heights are still loading.');
    const ws = watchers();
    toast('Planning the route…', 1500);
    const draft = coverDraft;
    setTimeout(() => { // let the toast paint first
      if (coverDraft !== draft) return;
      const vehicle = state.routeMode === 'vehicle';
      let pts, drive = null;
      if (vehicle) {
        if (!ROADS) { toast('The road map is still loading.'); cancelCoverDraft(); return; }
        const r = findVehicleRoute(from, xz, ws, state.offroad);
        if (!r) { toast(`No way through by vehicle${state.offroad ? '' : ' (try Off-road: Allow)'}.`); cancelCoverDraft(); return; }
        pts = r.pts; drive = r;
      } else {
        pts = findCoveredRoute(from, xz, ws, state.swim);
        if (!pts) { toast(`No way through on foot${state.swim ? '' : ' (try Swimming: On)'}.`); cancelCoverDraft(); return; }
      }
      draft.swim = !vehicle && state.swim;
      draft.vehicle = vehicle; draft.drive = drive; draft.offroad = state.offroad;
      draft.pts = pts;
      showCoverResult(draft);
      updateHint();
    }, 30);
  }
  // A* over a W x H grid of `C`-metre cells (8 neighbours). edge(k, n, len) is the cost of stepping from cell k to
  // cell n (Infinity = blocked) and heur(k) a never-too-high estimate of the cost left. Returns the cells in order.
  function aStar(W, H, C, s, g, edge, heur) {
    const N = W * H, cost = new Float64Array(N).fill(Infinity), came = new Int32Array(N).fill(-1), done = new Uint8Array(N);
    // Binary heap of cells ordered by estimated total cost
    const hk = [], hf = [];
    const push = (k, f) => {
      let i = hk.length; hk.push(k); hf.push(f);
      while (i > 0) { const p = (i - 1) >> 1; if (hf[p] <= f) break; hk[i] = hk[p]; hf[i] = hf[p]; i = p; }
      hk[i] = k; hf[i] = f;
    };
    const pop = () => {
      const top = hk[0], k = hk.pop(), f = hf.pop();
      if (hk.length) {
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= hk.length) break;
          if (c + 1 < hk.length && hf[c + 1] < hf[c]) c++;
          if (hf[c] >= f) break;
          hk[i] = hk[c]; hf[i] = hf[c]; i = c;
        }
        hk[i] = k; hf[i] = f;
      }
      return top;
    };
    const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    cost[s] = 0;
    push(s, heur(s));
    while (hk.length) {
      const k = pop();
      if (done[k]) continue;
      if (k === g) break;
      done[k] = 1;
      const i = k % W, j = (k - i) / W;
      for (const [di, dj] of NB) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
        const n = nj * W + ni;
        if (done[n]) continue;
        const c = cost[k] + edge(k, n, di && dj ? C * Math.SQRT2 : C);
        if (c < cost[n]) { cost[n] = c; came[n] = k; push(n, c + heur(n)); }
      }
    }
    if (s !== g && came[g] < 0) return null;
    const path = [];
    for (let k = g; k >= 0; k = came[k]) path.push(k);
    return path.reverse();
  }
  // Searched in a box around the start and end; if nothing is found (a bay or a ridge in the way needs a long way
  // round), again in bigger boxes, up to the whole island.
  // With car set, returns {runs} (see assembleRoute) instead of points; steepOk lets it cross ground steeper than
  // CAR_MAX_GRADE when there's no other way (those stretches come back flagged steep).
  function findCoveredRoute(from, to, ws, swim = false, car = false, steepOk = false) {
    const first = Math.min(800, Math.max(250, dist(from, to) * 0.4));
    for (const pad of [first, 2000, WORLD]) {
      const pts = routeInBox(from, to, ws, swim, pad, car, steepOk);
      if (pts || pad >= WORLD) return pts;
    }
    return null;
  }
  function routeInBox(from, to, ws, swim, pad, car = false, steepOk = false) {
    const C = LOS_CELL;
    const x0 = Math.max(0, Math.floor((Math.min(from[0], to[0]) - pad) / C) * C), x1 = Math.min(WORLD, Math.ceil((Math.max(from[0], to[0]) + pad) / C) * C);
    const z0 = Math.max(0, Math.floor((Math.min(from[1], to[1]) - pad) / C) * C), z1 = Math.min(WORLD, Math.ceil((Math.max(from[1], to[1]) + pad) / C) * C);
    const W = Math.round((x1 - x0) / C), H = Math.round((z1 - z0) / C), N = W * H;
    const centre = k => [x0 + (k % W + 0.5) * C, z0 + (Math.floor(k / W) + 0.5) * C];
    const cellOf = ([x, z]) => Math.min(H - 1, Math.max(0, Math.floor((z - z0) / C))) * W + Math.min(W - 1, Math.max(0, Math.floor((x - x0) / C)));
    const hgt = new Float32Array(N), mult = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      const c = centre(k), h = heightAt(c), [seen] = watchedAt(ws, c);
      hgt[k] = h;
      mult[k] = isWater(h) && !swim && !car ? Infinity : 1 + (seen === LOS_CLEAR ? 9 : seen === LOS_TREES ? 1.5 : 0);
    }
    // Keep-out rings and minefields, only over the cells they can touch
    const each = (bx0, bz0, bx1, bz1, fn) => {
      for (let j = Math.max(0, Math.floor((bz0 - z0) / C)); j <= Math.min(H - 1, Math.floor((bz1 - z0) / C)); j++)
        for (let i = Math.max(0, Math.floor((bx0 - x0) / C)); i <= Math.min(W - 1, Math.floor((bx1 - x0) / C)); i++) fn(j * W + i);
    };
    heliThreats().forEach(t => { // the same list of marked enemies the helicopter planner uses
      const r = FOOT_BERTH[t.kind], pts = t.points || [t.xz];
      const xs = pts.map(p => p[0]), zs = pts.map(p => p[1]);
      each(Math.min(...xs) - r, Math.min(...zs) - r, Math.max(...xs) + r, Math.max(...zs) + r, k => { if (threatDist(t, centre(k)) <= r) mult[k] += 50; });
    });
    allVisibleItems(it => it.type === 'marker' && !!MINE_KEEP_OUT[it.icon]).forEach(({ it }) => {
      const r = MINE_KEEP_OUT[it.icon];
      each(it.xz[0] - r, it.xz[1] - r, it.xz[0] + r, it.xz[1] + r, k => { if (dist(centre(k), it.xz) <= r) mult[k] = Infinity; });
    });
    const s = cellOf(from), g = cellOf(to);
    mult[s] = Math.min(mult[s], 8); mult[g] = Math.min(mult[g], 8); // you're already there / you have to get there
    const gx = centre(g), vmax = car ? OFFROAD_MS : walkSpeed(-0.05);
    const path = aStar(W, H, C, s, g, (k, n, len) => {
      if (mult[n] === Infinity) return Infinity;
      if (car) { // a vehicle across country: no water, nothing steeper than CAR_MAX_GRADE (unless steepOk, at a heavy price)
        const grade = (hgt[n] - hgt[k]) / len, steep = Math.abs(grade) > CAR_MAX_GRADE;
        if (isWater(hgt[n]) || (steep && !steepOk)) return Infinity;
        return len / (OFFROAD_MS * driveFactor(grade)) * (mult[k] + mult[n]) / 2 * (steep ? STEEP_COST : 1);
      }
      if (isWater(hgt[k]) || isWater(hgt[n])) return len / SWIM * (mult[k] + mult[n]) / 2; // swimming (only when on)
      const grade = (hgt[n] - hgt[k]) / len;
      return Math.abs(grade) > FOOT_MAX_GRADE ? Infinity : len / walkSpeed(grade) * (mult[k] + mult[n]) / 2;
    }, k => dist(centre(k), gx) / vmax);
    if (!path) return null;
    const cells = path.map(centre);
    cells[0] = from; cells[cells.length - 1] = to;
    if (car) { // runs of steps that stay under the limit, and runs of steps over it
      const runs = [];
      for (let i = 0; i + 1 < path.length; i++) {
        const steep = Math.abs(hgt[path[i + 1]] - hgt[path[i]]) / dist(centre(path[i]), centre(path[i + 1])) > CAR_MAX_GRADE;
        const last = runs[runs.length - 1];
        if (last && last.steep === steep) last.pts.push(cells[i + 1]); else runs.push({ steep, pts: [cells[i], cells[i + 1]] });
      }
      if (!runs.length) runs.push({ steep: false, pts: [from, to] });
      return { runs: runs.map(r => ({ steep: r.steep, pts: simplify(r.pts, 4) })) };
    }
    let tol = 4, pts = simplify(cells, tol);
    while (pts.length > 200) pts = simplify(cells, tol *= 1.5);
    return pts.map(roundXZ);
  }

  // --- Route planner (vehicle): the quickest drive on the road network, around marked enemies ---------------------
  // Dijkstra over the game's own roads (ROADS, from reforger-map-tools' rmtlib/bake_roads.py), costed in driving time: each
  // kind of road has a speed (ROAD_KMH), slopes slow it (driveFactor) and where a marked enemy sees a stretch the time
  // is multiplied like the foot planner does. Start and end are joined to the nearest roads by short off-road legs
  // (no water, nothing steeper than CAR_MAX_GRADE). With off-road allowed, and when there's no road way or the roads
  // are far, the grid search crosses country instead. The speeds are estimates, not measured in game.
  const ROAD_KMH = [80, 60, 50, 25];   // main road, street, dirt road, foot path
  const PATH_PENALTY = 1.6;            // foot paths cost this much more than their time, so roads win unless a path saves a lot
  const OFFROAD_MS = 15 / 3.6;         // across country, on the flat
  // Off-road, a vehicle keeps to ground under 45 degrees (green). It only crosses steeper ground when there is no other
  // way through, and those stretches turn red; STEEP_COST makes the search cross as little of it as it can.
  const SLOPE_LIMIT_DEG = 45;
  const CAR_MAX_GRADE = Math.tan(SLOPE_LIMIT_DEG * Math.PI / 180);
  const STEEP_COST = 200;
  const CONNECT_M = 700, CONNECT_ROADS_ONLY_M = 250, CONNECT_EDGES = 6;
  const ROAD_WORD = ['main road', 'street', 'dirt road', 'foot path'];
  const driveFactor = grade => 1 / (1 + 4 * Math.max(0, grade - 0.06) + 2 * Math.max(0, -grade - 0.10));
  const seenMult = (ws, c) => { if (!ws.length) return 1; const [seen] = watchedAt(ws, c); return 1 + (seen === LOS_CLEAR ? 9 : seen === LOS_TREES ? 1.5 : 0); };
  // Driving time along a polyline at a kind's speed (kind 4 = off-road), in steps of at most 25 m. With pref, the cost the
  // search uses (foot paths count extra); without, the time it really takes.
  function driveTime(pts, kind, ws, pref = true) {
    const v = kind === 4 ? OFFROAD_MS : ROAD_KMH[kind] / 3.6;
    let t = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], L = dist(a, b), n = Math.max(1, Math.ceil(L / 25));
      for (let j = 0; j < n; j++) {
        const p = [a[0] + (b[0] - a[0]) * j / n, a[1] + (b[1] - a[1]) * j / n], q = [a[0] + (b[0] - a[0]) * (j + 1) / n, a[1] + (b[1] - a[1]) * (j + 1) / n];
        const step = L / n, h0 = heightAt(p) ?? 0, h1 = heightAt(q) ?? 0;
        t += step / (v * driveFactor((h1 - h0) / step)) * seenMult(ws, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
      }
    }
    return pref && kind === 3 ? t * PATH_PENALTY : t;
  }
  // The nearest point on a polyline to xz: {d, i (segment), p}
  function nearOnLine(pts, xz) {
    let best = null;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz;
      const t = L2 ? Math.max(0, Math.min(1, ((xz[0] - a[0]) * dx + (xz[1] - a[1]) * dz) / L2)) : 0;
      const p = [a[0] + t * dx, a[1] + t * dz], d = dist(p, xz);
      if (!best || d < best.d) best = { d, i, p };
    }
    return best;
  }
  // Can a vehicle cross from a to b off the road? Returns {secs, runs}: its driving cost, and the way in runs of one
  // kind ({steep, pts}: under the slope limit, or over it, which is only allowed with steepOk); null if water, or too
  // steep without steepOk.
  function offroadTime(a, b, ws, steepOk = false) {
    const L = dist(a, b), n = Math.max(1, Math.ceil(L / 10));
    let prev = heightAt(a);
    if (prev == null) return null;
    let t = 0, from = a;
    const at = j => [a[0] + (b[0] - a[0]) * j / n, a[1] + (b[1] - a[1]) * j / n], runs = [];
    for (let j = 1; j <= n; j++) {
      const p = at(j), h = heightAt(p), step = L / n, grade = (h - prev) / step, steep = Math.abs(grade) > CAR_MAX_GRADE;
      if (isWater(h) || (steep && !steepOk)) return null;
      t += step / (OFFROAD_MS * driveFactor(grade)) * seenMult(ws, p) * (steep ? STEEP_COST : 1);
      const last = runs[runs.length - 1];
      if (last && last.steep === steep) last.pts[1] = j === n ? b : p; else runs.push({ steep, pts: [from, j === n ? b : p] });
      from = p;
      prev = h;
    }
    return { secs: t, runs };
  }
  let roadAdj = null;
  function roadGraph() {
    if (roadAdj && roadAdj.src === ROADS) return roadAdj;
    const adj = ROADS.nodes.map(() => []);
    ROADS.edges.forEach((e, i) => { adj[e[0]].push({ to: e[1], e: i, fwd: true }); adj[e[1]].push({ to: e[0], e: i, fwd: false }); });
    return (roadAdj = { src: ROADS, adj });
  }
  // Route by road from `from` to `to`; returns {pts, secs, legs: {kind: metres}, roadShare} or null.
  function driveRoadRoute(from, to, ws, offroad, steepOk = false) {
    const { adj } = roadGraph(), nodes = ROADS.nodes, edges = ROADS.edges, reach = offroad ? CONNECT_M : CONNECT_ROADS_ONLY_M;
    const ncost = new Map(); // `${edge}:${dir}` -> seconds along the whole edge
    const edgeCost = (i, fwd) => {
      const key = i * 2 + (fwd ? 1 : 0);
      let c = ncost.get(key);
      if (c === undefined) { const e = edges[i]; c = driveTime(fwd ? e[3] : [...e[3]].reverse(), e[2], ws); ncost.set(key, c); }
      return c;
    };
    const extra = new Map(); // virtual node -> [{to, secs, pts, kind}]
    const add = (u, v) => { if (!extra.has(u)) extra.set(u, []); extra.get(u).push(v); };
    let nextId = nodes.length;
    const attach = (xz, isStart) => {
      // the nearest few roads, each joined by an off-road leg to its nearest point
      const cands = [];
      edges.forEach((e, k) => { const n = nearOnLine(e[3], xz); if (n.d <= reach) cands.push({ ...n, edge: k }); }); // n.i is the segment along the edge
      cands.sort((a, b) => a.d - b.d);
      const made = [];
      for (const c of cands.slice(0, CONNECT_EDGES)) {
        const leg = c.d < 1 ? { secs: 0, runs: [] } : offroadTime(isStart ? xz : c.p, isStart ? c.p : xz, ws, steepOk);
        if (leg === null) continue;
        const e = edges[c.edge], pts = e[3], id = nextId++;
        const toA = [c.p, ...pts.slice(0, c.i + 1).reverse()], toB = [c.p, ...pts.slice(c.i + 1)];
        const legRuns = leg.runs.length ? leg.runs : [{ steep: false, pts: isStart ? [xz, c.p] : [c.p, xz] }]; // in the way of travel
        made.push({ id, i: c.edge, at: c.i, p: c.p, legRuns, legSecs: leg.secs, legLen: c.d });
        // moving out of this point along the road to either end (start), or in from either end (goal)
        const secsA = driveTime(toA, e[2], ws), secsB = driveTime(toB, e[2], ws);
        if (isStart) {
          add(id, { to: e[0], secs: secsA, pts: toA, kind: e[2] });
          add(id, { to: e[1], secs: secsB, pts: toB, kind: e[2] });
        } else {
          add(e[0], { to: id, secs: driveTime([...toA].reverse(), e[2], ws), pts: [...toA].reverse(), kind: e[2] });
          add(e[1], { to: id, secs: driveTime([...toB].reverse(), e[2], ws), pts: [...toB].reverse(), kind: e[2] });
        }
      }
      return made;
    };
    const S = attach(from, true), G = attach(to, false);
    if (!S.length || !G.length) return null;
    // start and end on the same road: straight along it
    S.forEach(s => G.forEach(g => {
      if (s.i !== g.i) return;
      const e = edges[s.i], pts = e[3], fwd = s.at < g.at || (s.at === g.at && dist(pts[s.at], s.p) <= dist(pts[s.at], g.p));
      const mid = fwd ? pts.slice(s.at + 1, g.at + 1) : pts.slice(g.at + 1, s.at + 1).reverse();
      const run = [s.p, ...mid, g.p];
      add(s.id, { to: g.id, secs: driveTime(run, e[2], ws), pts: run, kind: e[2] });
    }));
    // Dijkstra from a virtual start node joined to every start candidate
    const N = nextId, dist_ = new Float64Array(N).fill(Infinity), prev = new Array(N).fill(null), done = new Uint8Array(N);
    S.forEach(s => { dist_[s.id] = s.legSecs; prev[s.id] = { from: null, s }; });
    const goalSecs = new Map(G.map(g => [g.id, g]));
    let goal = -1, best = Infinity;
    for (;;) {
      let u = -1, bd = Infinity;
      for (let k = 0; k < N; k++) if (!done[k] && dist_[k] < bd) { bd = dist_[k]; u = k; }
      if (u < 0 || bd >= best) break;
      done[u] = 1;
      if (goalSecs.has(u)) { const tot = bd + goalSecs.get(u).legSecs; if (tot < best) { best = tot; goal = u; } continue; }
      const relax = (v, secs, pts, kind) => { if (bd + secs < dist_[v]) { dist_[v] = bd + secs; prev[v] = { from: u, pts, kind }; } };
      if (u < nodes.length) adj[u].forEach(a => relax(a.to, edgeCost(a.e, a.fwd), a.fwd ? edges[a.e][3] : [...edges[a.e][3]].reverse(), edges[a.e][2]));
      (extra.get(u) || []).forEach(x => relax(x.to, x.secs, x.pts, x.kind));
    }
    if (goal < 0) return null;
    // walk back, collecting the pieces
    const pieces = [];
    for (let v = goal; v !== null;) {
      const pr = prev[v];
      if (pr.from === null) { [...pr.s.legRuns].reverse().forEach(r => pieces.push({ pts: r.pts, kind: 4, steep: r.steep })); break; }
      pieces.push({ pts: pr.pts, kind: pr.kind, steep: false });
      v = pr.from;
    }
    pieces.reverse();
    goalSecs.get(goal).legRuns.forEach(r => pieces.push({ pts: r.pts, kind: 4, steep: r.steep }));
    const pts = [], legs = {};
    pieces.forEach(pc => {
      pc.pts.forEach(p => { if (!pts.length || dist(pts[pts.length - 1], p) > 0.05) pts.push(p); });
      legs[pc.kind] = (legs[pc.kind] || 0) + pathLength(pc.pts);
    });
    // the search used costs (exposure and the foot path penalty); the time shown is the plain driving time
    const secs = pieces.reduce((t, pc) => t + driveTime(pc.pts, pc.kind, [], false), 0);
    return { pts, cost: best, secs, legs, runs: pieces.map(pc => ({ steep: pc.steep, pts: pc.pts })) };
  }
  // A drive is drawn green, and red where it crosses ground over the slope limit. `steep` is [first, last] point index
  // pairs into points (as findVehicleRoute returns, and saved routes keep).
  const DRIVE_OK = '#3ddc84', DRIVE_STEEP = '#ff3b3b';
  const steepRuns = (points, steep) => (Array.isArray(steep) ? steep : []).filter(r => Array.isArray(r) && Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] >= 0 && r[1] > r[0] && r[1] < points.length)
    .map(([a, b]) => points.slice(a, b + 1));
  const drawDrive = (layer, points, steep, opts = {}) => {
    layer.addLayer(L.polyline(points.map(toLL), { color: DRIVE_OK, weight: 4, opacity: 0.95, ...opts }));
    steepRuns(points, steep).forEach(run => layer.addLayer(L.polyline(run.map(toLL), { color: DRIVE_STEEP, weight: 4.5, opacity: 1, lineCap: 'butt', ...opts })));
  };
  // Turn runs ({steep, pts}, each starting where the last ended) into the route: neighbours of one kind are joined,
  // every run is simplified on its own (so a steep stretch stays exactly where the planner found it), and the result is
  // {pts, steep} with steep the [first, last] point index of each stretch over the slope limit.
  function assembleRoute(runs) {
    const merged = [];
    runs.forEach(r => {
      const last = merged[merged.length - 1];
      if (last && last.steep === r.steep) r.pts.forEach(p => { if (dist(last.pts[last.pts.length - 1], p) > 0.05) last.pts.push(p); });
      else merged.push({ steep: r.steep, pts: [...r.pts] });
    });
    let tol = 1.5, simple = merged.map(r => simplify(r.pts, tol));
    while (simple.reduce((n, s) => n + s.length, 0) - merged.length + 1 > 200) simple = merged.map(r => simplify(r.pts, tol *= 1.5));
    const pts = [], steep = [];
    simple.forEach((s, i) => {
      const first = pts.length ? pts.length - 1 : 0;
      s.forEach(p => { if (!pts.length || dist(pts[pts.length - 1], p) > 0.05) pts.push(p); });
      if (merged[i].steep && pts.length - 1 > first) steep.push([first, pts.length - 1]);
    });
    return { pts: pts.map(roundXZ), steep };
  }
  // Roads first; across country when allowed and there's no road way, or the road way is far longer than the direct line.
  // Returns {pts, steep, cost, secs, legs}: steep lists the [first, last] point index of each stretch over the slope
  // limit. Those only appear when there is no way through that stays under it.
  function findVehicleRoute(from, to, ws, offroad = true) {
    return planDrive(from, to, ws, offroad, false) || planDrive(from, to, ws, offroad, true);
  }
  function planDrive(from, to, ws, offroad, steepOk) {
    const road = driveRoadRoute(from, to, ws, offroad, steepOk);
    let res = road;
    const tooLong = road && offroad && pathLength(road.pts) > 4 * dist(from, to) + 500;
    if (offroad && (!road || tooLong)) {
      const direct = findCoveredRoute(from, to, ws, false, true, steepOk);
      if (direct) {
        const flat = [];
        direct.runs.forEach(r => r.pts.forEach(p => { if (!flat.length || dist(flat[flat.length - 1], p) > 0.05) flat.push(p); }));
        const cost = direct.runs.reduce((t, r) => t + driveTime(r.pts, 4, ws) * (r.steep ? STEEP_COST : 1), 0);
        if (!road || cost < road.cost) res = { pts: flat, cost, secs: driveTime(flat, 4, [], false), legs: { 4: pathLength(flat) }, runs: direct.runs };
      }
    }
    if (!res) return null;
    const { pts, steep } = assembleRoute(res.runs);
    return { ...res, pts, steep };
  }

  function showCoverResult(d) {
    d.layer.clearLayers();
    const rc = routeCheck(d.pts), straight = routeCheck([d.pts[0], d.pts[d.pts.length - 1]]);
    if (rc) drawExposure(d.layer, rc);
    const lls = d.pts.map(toLL);
    d.layer.addLayer(L.polyline(lls, { color: '#000', weight: 7, opacity: 0.45, interactive: false }));
    const line = L.polyline(lls, { color: state.me.color, weight: 4, dashArray: '8 6', bubblingMouseEvents: false }).addTo(d.layer);
    [d.pts[0], d.pts[d.pts.length - 1]].forEach(xz => d.layer.addLayer(L.circleMarker(toLL(xz), { radius: 5, color: '#000', weight: 1.5, fillColor: state.me.color, fillOpacity: 1, interactive: false })));
    const end = d.pts[d.pts.length - 1];
    if (d.vehicle && d.drive) {
      const dr = d.drive, total = rc ? rc.total : pathLength(d.pts);
      const legs = Object.entries(dr.legs).filter(([, m]) => m >= 20).sort((a, b) => b[1] - a[1])
        .map(([k, m]) => `${fmtDist(m)} ${k === '4' ? 'off-road' : ROAD_WORD[k]}`).join(' · ');
      const overM = steepRuns(d.pts, dr.steep).reduce((m, run) => m + pathLength(run), 0);
      const vhtml = () => popupHtml('Vehicle route', `${fmtDist(total)} · ${fmtTime(dr.secs)} driving`, end,
        `<p>${legs || 'Across country'}.</p>` +
        (overM ? `<p><b class="rc-no">Over ${SLOPE_LIMIT_DEG}° for ${fmtDist(overM)}</b> <span class="sub">(red) · no other way through</span></p>` : '') +
        (rc ? `<p>${rc.watchers ? `${rc.seenClear ? `<b class="rc-no">Seen for ${fmtDist(rc.seenClear)}</b>` : '<b class="rc-ok">Never seen clearly</b>'}` +
          `${rc.seenTrees ? `, <span class="rc-trees">through trees for ${fmtDist(rc.seenTrees)}</span>` : ''}.` : '<span class="sub">Mark enemies to see where it is exposed.</span>'}</p>` +
          `<p class="sub">Climbs ${Math.round(rc.climb)} m, descends ${Math.round(rc.descent)} m; steepest stretch ${Math.round(rc.steep * 100)}%.</p>` : '') +
        '<div class="row"><button data-cover="save">Save as route</button><button data-cover="discard">Discard</button></div>' +
        `<p class="sub">Speeds: main ${ROAD_KMH[0]} · street ${ROAD_KMH[1]} · dirt ${ROAD_KMH[2]} · path ${ROAD_KMH[3]} (avoided) · off-road ${Math.round(OFFROAD_MS * 3.6)} km/h, slower uphill. Red: over ${SLOPE_LIMIT_DEG}°. Re-plans when enemies change.</p>`);
      d.layer.removeLayer(line); // the foot route's dashes; a drive is drawn solid, green, and red where too steep
      const vlayer = L.layerGroup().addTo(d.layer);
      drawDrive(vlayer, d.pts, dr.steep, { bubblingMouseEvents: false, interactive: true });
      vlayer.eachLayer(l => l.on('click', e => { L.DomEvent.stop(e); popup().setLatLng(toLL(end)).setContent(vhtml()).openOn(map); }));
      popup().setLatLng(toLL(end)).setContent(vhtml()).openOn(map);
      return;
    }
    const html = () => popupHtml('Foot route', rc ? `${fmtDist(rc.total)} · ${fmtTime(rc.walk)} at a jog` : '', end,
      (rc ? `<p>${rc.watchers ? `${rc.seenClear ? `<b class="rc-no">Seen for ${fmtDist(rc.seenClear)}</b>` : '<b class="rc-ok">Never seen clearly</b>'}` +
        `${rc.seenTrees ? `, <span class="rc-trees">through trees for ${fmtDist(rc.seenTrees)}</span>` : ''}. ` : ''}` +
        `Straight across: ${fmtDist(straight.total)}, ${fmtTime(straight.walk)}${rc.watchers ? `, seen for ${fmtDist(straight.seenClear)}` : ''}.</p>` +
        `<p class="sub">Climbs ${Math.round(rc.climb)} m, descends ${Math.round(rc.descent)} m; steepest stretch ${Math.round(rc.steep * 100)}%` +
        `${rc.swim ? `; swims ${fmtDist(rc.swim)} (${fmtTime(rc.swim / SWIM)})` : ''}.</p>` : '') +
      '<div class="row"><button data-cover="save">Save as route</button><button data-cover="discard">Discard</button></div>' +
      '<p class="sub">Quickest way out of sight of marked enemies. Re-plans when they change.</p>');
    line.on('click', e => { L.DomEvent.stop(e); popup().setLatLng(toLL(end)).setContent(html()).openOn(map); });
    popup().setLatLng(toLL(end)).setContent(html()).openOn(map);
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-cover]');
    if (!b || !coverDraft || !coverDraft.pts || !state.me) return;
    if (b.dataset.cover === 'save' && coverDraft.heli) {
      const n = issueNumber('flight', [...(state.players.get(state.me.name)?.items.values() || [])].filter(i => i.type === 'arrow' && i.kind === 'flight').length + 1);
      saveItem({ id: uid(), type: 'arrow', kind: 'flight', points: coverDraft.pts, label: `Flight route ${n}`, note: '', color: ARROWS.flight.color });
    } else if (b.dataset.cover === 'save') {
      const pts = coverDraft.pts;
      const veh = coverDraft.vehicle;
      const n = issueNumber(veh ? 'drive' : 'foot', [...(state.players.get(state.me.name)?.items.values() || [])].filter(i => i.type === 'route' && i.plan && (i.plan.mode === 'vehicle') === !!veh).length + 1);
      saveItem({ id: uid(), type: 'route', points: pts, label: `${veh ? 'Vehicle' : 'Foot'} route ${n}`, note: '', color: state.me.color,
        ...(veh && coverDraft.drive?.steep?.length ? { steep: coverDraft.drive.steep } : {}),
        plan: { mode: veh ? 'vehicle' : 'foot', from: pts[0], to: pts[pts.length - 1], at: Date.now(), ...(coverDraft.swim ? { swim: true } : {}), ...(veh && !coverDraft.offroad ? { roadsOnly: true } : {}) } });
    }
    map.closePopup();
    cancelCoverDraft();
  });

  // --- Landing zone check -------------------------------------------------------------------------------------
  // Sized for the game's helicopters (the UH-1H's rotor reaches ~7.3 m from its mast, the Mi-8's ~10.7 m and its tail
  // rotor ~13 m), on the engine's own terrain (1 m) and objects (0.5 m). reforger-map-tools' rmtlib/bake_los.py uses
  // the same rules (LZ_*) for the landing shading, at every 10 m: keep the two in step.
  // - slope: the best-fit plane over LZ_SLOPE_R; over LZ_OK_DEG marginal, over LZ_MAX_DEG no-go
  // - anything LZ_SPOT_H or taller within LZ_TOUCH (the touchdown spot), or LZ_ROTOR_H or taller within LZ_R (under
  //   the rotor and tail), is no-go; trees or buildings LZ_NEAR_H or taller out to LZ_NEAR make it marginal
  // - ground rising LZ_BUMP_MAX above the landing plane within LZ_R is no-go (LZ_BUMP_OK marginal)
  // - ways in: 8 directions, each a corridor LZ_WIDE wide, clear of ground and objects on a 10 degree descent
  // Until the detail tiles arrive, a rougher check on the 10 m data stands in.
  const LZ_TOUCH = 6, LZ_SLOPE_R = 8, LZ_R = 15, LZ_NEAR = 40, LZ_APPROACH = 150, LZ_WIDE = 12;
  const LZ_SPOT_H = 1, LZ_ROTOR_H = 2, LZ_NEAR_H = 6, LZ_BUMP_OK = 0.75, LZ_BUMP_MAX = 1.5;
  const LZ_GLIDE = Math.tan(10 * Math.PI / 180), LZ_OK_DEG = 17, LZ_MAX_DEG = 22;
  const LZ_COLOR = { good: '#51cf66', marginal: '#ffc53d', nogo: '#ff5c5c' };
  const LZ_WORD = { good: 'Good', marginal: 'Marginal', nogo: 'No-go' };
  const OBJ_WORD = { 1: 'a building', 2: 'a wall, rock, pole or wreck', 3: 'a tree', 4: 'a fence' };
  function lzVerdict(h0, deg, bump, spot, rotor, near, open) {
    const nogo = [], marginal = [];
    if (h0 < 0.5) return { verdict: 'nogo', reasons: ['in the water'] };
    if (spot) nogo.push(`${OBJ_WORD[spot.kind]} on the touchdown spot (${Math.round(spot.top)} m)`);
    else if (rotor) nogo.push(`${OBJ_WORD[rotor.kind]} under the rotor (${Math.round(rotor.top)} m tall, ${Math.round(rotor.r)} m out)`);
    if (deg > LZ_MAX_DEG) nogo.push(`too steep (${Math.round(deg)}°)`); else if (deg > LZ_OK_DEG) marginal.push(`sloping (${Math.round(deg)}°)`);
    if (bump > LZ_BUMP_MAX) nogo.push(`uneven ground (${bump.toFixed(1)} m rise)`); else if (bump > LZ_BUMP_OK) marginal.push(`bumpy ground (${bump.toFixed(1)} m)`);
    if (!open.length) nogo.push('no clear approach'); else if (open.length < 3) marginal.push('few clear approaches');
    if (near && !spot && !rotor) marginal.push(`${OBJ_WORD[near.kind]} close by (${Math.round(near.top)} m tall, ${Math.round(near.r)} m out)`);
    return { verdict: nogo.length ? 'nogo' : marginal.length ? 'marginal' : 'good', reasons: [...nogo, ...marginal] };
  }
  function lzAssess(xz) {
    if (!HEIGHT) return null;
    const reach = LZ_APPROACH + LZ_WIDE;
    if (!detailReady(xz[0] - reach, xz[1] - reach, xz[0] + reach, xz[1] + reach)) return lzAssessRough(xz);
    const h0 = groundFine(xz);
    // slope: least-squares plane over the touchdown circle (1 m samples); unevenness: rise above the rotor-circle plane
    let sx = 0, sz = 0, sxx = 0, bx = 0, bz = 0, bxx = 0, bs = 0, bn = 0;
    const pts = [];
    for (let dx = -LZ_R; dx <= LZ_R; dx++) for (let dz = -LZ_R; dz <= LZ_R; dz++) {
      const r2 = dx * dx + dz * dz;
      if (r2 > LZ_R * LZ_R) continue;
      const h = groundFine([xz[0] + dx, xz[1] + dz]) - h0;
      pts.push([dx, dz, h]);
      bx += dx * h; bz += dz * h; bxx += dx * dx; bs += h; bn++;
      if (r2 <= LZ_SLOPE_R * LZ_SLOPE_R) { sx += dx * h; sz += dz * h; sxx += dx * dx; }
    }
    const deg = Math.atan(Math.hypot(sx / sxx, sz / sxx)) * 180 / Math.PI;
    const px = bx / bxx, pz = bz / bxx, p0 = bs / bn;
    let bump = 0;
    for (const [dx, dz, h] of pts) bump = Math.max(bump, h - (p0 + px * dx + pz * dz));
    // objects around it, every 0.5 m (fences count: they catch rotors)
    let spot = null, rotor = null, near = null;
    for (let dx = -LZ_NEAR; dx <= LZ_NEAR; dx += 0.5) for (let dz = -LZ_NEAR; dz <= LZ_NEAR; dz += 0.5) {
      const r = Math.hypot(dx, dz);
      if (r > LZ_NEAR) continue;
      const o = objectAt([xz[0] + dx, xz[1] + dz]);
      if (!o || o.kind === 5) continue; // bushes and low plants don't harm a helicopter
      if (r <= LZ_TOUCH && o.top >= LZ_SPOT_H && (!spot || o.top > spot.top)) spot = { ...o, r };
      else if (r <= LZ_R && o.top >= LZ_ROTOR_H && (!rotor || o.top > rotor.top)) rotor = { ...o, r };
      else if (r > LZ_R && o.top >= LZ_NEAR_H && o.kind !== 4 && (!near || r < near.r)) near = { ...o, r };
    }
    // ways in: a corridor LZ_WIDE wide in each of 8 directions, clear on a 10 degree descent
    const open = COMPASS.filter((_, i) => {
      const b = i * Math.PI / 4, sb = Math.sin(b), cb = Math.cos(b);
      for (let r = LZ_R + 2; r <= LZ_APPROACH; r += 1) {
        for (const w of [-LZ_WIDE / 2, 0, LZ_WIDE / 2]) {
          const p = [xz[0] + r * sb + w * cb, xz[1] + r * cb - w * sb];
          const o = objectAt(p);
          if ((groundFine(p) + (o && o.kind !== 5 ? o.top : 0) - h0) / r > LZ_GLIDE) return false;
        }
      }
      return true;
    });
    return { ...lzVerdict(h0, deg, bump, spot, rotor, near, open), deg, bump, spot, rotor, near, open, h0, exact: true };
  }
  // The rough stand-in on the 10 m data, while the detail loads.
  function lzAssessRough(xz) {
    const h0 = heightAt(xz);
    let sx = 0, sz = 0, sxx = 0, spot = null, near = null;
    for (let dx = -LZ_NEAR; dx <= LZ_NEAR; dx += 5) for (let dz = -LZ_NEAR; dz <= LZ_NEAR; dz += 5) {
      const r = Math.hypot(dx, dz), p = [xz[0] + dx, xz[1] + dz];
      if (r > LZ_NEAR) continue;
      if (r <= LZ_SLOPE_R) { const h = heightAt(p) - h0; sx += dx * h; sz += dz * h; sxx += dx * dx; }
      const tall = Math.max(canopyTop(p), buildingTop(p));
      if (tall >= LZ_ROTOR_H && r <= LZ_R && !spot) spot = { kind: buildingTop(p) ? 1 : 3, top: tall, r };
      else if (tall >= LZ_NEAR_H && r > LZ_R && !near) near = { kind: buildingTop(p) ? 1 : 3, top: tall, r };
    }
    const deg = sxx ? Math.atan(Math.hypot(sx / sxx, sz / sxx)) * 180 / Math.PI : 0;
    const open = COMPASS.filter((_, i) => {
      const b = i * Math.PI / 4;
      for (let r = LZ_R + 5; r <= LZ_APPROACH; r += 10) {
        const p = [xz[0] + r * Math.sin(b), xz[1] + r * Math.cos(b)];
        if ((heightAt(p) + Math.max(canopyTop(p), buildingTop(p)) - h0) / r > LZ_GLIDE) return false;
      }
      return true;
    });
    return { ...lzVerdict(h0, deg, 0, spot, null, near, open), deg, bump: 0, spot, rotor: null, near, open, h0, exact: false };
  }
  const lzCache = new Map();
  function lzCheck(xz) {
    const key = `${xz}|${!!HEIGHT}|${!!CANOPY}`;
    if (!lzCache.has(key) || !lzCache.get(key).exact) {
      if (lzCache.size > 200) lzCache.clear();
      lzCache.set(key, lzAssess(xz));
    }
    return lzCache.get(key);
  }
  // The nearest good spot within 150 m, preferring flat ground with plenty of ways in. Only spots the landing grid
  // already rates good are checked in full.
  function betterLz(xz) {
    let best = null;
    const g = lzGrid();
    for (let dx = -150; dx <= 150; dx += 10) for (let dz = -150; dz <= 150; dz += 10) {
      const r = Math.hypot(dx, dz), p = [xz[0] + dx, xz[1] + dz];
      if (r > 150 || r < 10 || heightAt(p) < 0.5) continue;
      if (g ? g[cellOf(p)] !== 1 : canopyTop(p) >= 3 || buildingTop(p)) continue;
      const c = lzAssess(p);
      if (c.verdict !== 'good') continue;
      const score = r + c.deg * 6 - c.open.length * 4;
      if (!best || score < best.score) best = { xz: roundXZ(p), r, c, score };
    }
    return best;
  }
  function renderLz(p, it, layer, html) {
    const c = lzCheck(it.xz), col = c ? LZ_COLOR[c.verdict] : '#adb5bd';
    layer.addLayer(L.circle(toLL(it.xz), { radius: LZ_R, color: col, weight: 2, dashArray: '5 4', fillColor: col, fillOpacity: 0.14, interactive: false }));
    (c ? c.open : []).forEach(dir => { // ticks showing the clear ways in
      const b = COMPASS.indexOf(dir) * Math.PI / 4, at = r => toLL([it.xz[0] + r * Math.sin(b), it.xz[1] + r * Math.cos(b)]);
      layer.addLayer(L.polyline([at(LZ_R + 6), at(LZ_R + 40)], { color: col, weight: 2.5, opacity: 0.85, dashArray: '2 5', interactive: false }));
    });
    const m = L.marker(toLL(it.xz), { icon: L.divIcon({ className: 'lz-glyph', iconSize: [0, 0], html: `<div style="--c:${col}">H</div>` }),
      keyboard: false, riseOnHover: true, zIndexOffset: 450 });
    const name = `${it.label || 'LZ'}${c ? ` · ${LZ_WORD[c.verdict]}` : ''}`;
    m.bindTooltip(esc(isMine(p.name) ? name : `${name} (${p.name})`), { permanent: true, direction: 'right', offset: [14, 0], className: 'item-label' });
    bindInfo(m, html, () => it.xz);
    layer.addLayer(m);
  }
  function lzHtml(owner, it) {
    const c = lzCheck(it.xz);
    if (!c) return '<p class="sub">Terrain still loading…</p>';
    let html = `<p class="lz-verdict" style="--c:${LZ_COLOR[c.verdict]}"><b>${LZ_WORD[c.verdict]}</b>${c.reasons.length ? `: ${c.reasons.join(', ')}` : ''}</p>` +
      `<div class="stats"><div><span class="k">Slope</span><span class="v">${Math.round(c.deg)}°</span></div>` +
      `<div><span class="k">Obstacles</span><span class="v">${c.spot ? 'On the spot' : c.rotor ? 'Under the rotor' : c.near ? 'Close by' : 'Clear'}</span></div>` +
      `<div><span class="k">Height</span><span class="v">${Math.round(c.h0)} m</span></div></div>` +
      `<p>Clear approaches: <b>${c.open.length ? c.open.join(' ') : 'none'}</b></p>`;
    if (c.verdict !== 'good') {
      const b = betterLz(it.xz);
      html += b ? `<p>Better spot <b>${fmtDist(b.r)} ${compass(bearing(it.xz, b.xz))}</b>: ${Math.round(b.c.deg)}° slope, approaches ${b.c.open.join(' ')}</p>` +
          (isMine(owner) ? `<div class="row"><button data-lz-move="${esc(it.id)}" data-x="${b.xz[0]}" data-z="${b.xz[1]}">Move the LZ there</button></div>` : '')
        : '<p class="sub">No good spot within 150 m.</p>';
    }
    return html + (c.exact
      ? '<p class="sub">Doesn\'t check power lines.</p>'
      : '<p class="sub">Rough check; detail loading.</p>');
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-lz-move]');
    const it = b && state.me && state.players.get(state.me.name)?.items.get(b.dataset.lzMove);
    if (!it) return;
    map.closePopup();
    saveItem({ ...it, xz: [+b.dataset.x, +b.dataset.z] });
  });

  // ---------------------------------------------------------------------------
  // Radio backpacks and fire support requests
  // ---------------------------------------------------------------------------
  // Distance from a point to a polygon's outline (0 if inside).
  function distToPoly(pts, xz) {
    if (inPoly(pts, xz)) return 0;
    let best = Infinity;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [ax, az] = pts[j], [bx, bz] = pts[i], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
      const t = L2 ? Math.max(0, Math.min(1, ((xz[0] - ax) * dx + (xz[1] - az) * dz) / L2)) : 0;
      best = Math.min(best, Math.hypot(xz[0] - ax - t * dx, xz[1] - az - t * dz));
    }
    return best;
  }
  // Marked enemies close enough to a radio backpack to stop players spawning on it.
  function radioBlockers(xz) {
    const out = [];
    allVisibleItems(it => (it.type === 'marker' && !!ENEMY_WATCH[it.icon] && timeoutState(it) !== 'expired') || isEnemyArea(it) || it.type === 'aa').forEach(({ it }) => {
      const d = it.type === 'area' ? distToPoly(it.points, xz) : dist(it.xz, xz);
      if (d <= RADIO_CLEAR) out.push({ name: it.label || typeLabel(it), d, xz: it.xz || xz });
    });
    return out.sort((a, b) => a.d - b.d);
  }
  const radioIcon = (color, blocked) => L.divIcon({ className: `radio-glyph${blocked ? ' blocked' : ''}`, iconSize: [0, 0],
    html: `<div style="--c:${color}"><svg viewBox="0 0 24 24">${RADIO_SVG_BODY}</svg></div>` });
  function renderRadio(p, it, layer, color, html) {
    const blocked = radioBlockers(it.xz).length > 0;
    if (it.ring) {
      const c = blocked ? ENEMY : color;
      layer.addLayer(L.circle(toLL(it.xz), { radius: RADIO_CLEAR, color: c, weight: 2, dashArray: '6 5', fillColor: c, fillOpacity: blocked ? 0.16 : 0.08, interactive: false }));
    }
    const m = L.marker(toLL(it.xz), { icon: radioIcon(color, blocked), keyboard: false, riseOnHover: true, zIndexOffset: 800 });
    const name = `${it.label || 'Radio'}${blocked ? ' · spawn blocked' : ''}`;
    m.bindTooltip(esc(isMine(p.name) ? name : `${name} (${p.name})`), { permanent: true, direction: 'right', offset: [15, 0],
      className: `item-label${blocked ? ' radio-blocked' : ''}` });
    bindInfo(m, html, () => it.xz);
    layer.addLayer(m);
  }
  function radioHtml(owner, it) {
    const b = radioBlockers(it.xz);
    let html = b.length
      ? `<p><b class="rc-no">Spawn blocked</b>: ${b.map(x => `${esc(x.name)} ${x.d < 1 ? 'on it' : `${fmtDist(x.d)} ${compass(bearing(it.xz, x.xz))}`}`).join(', ')}</p>`
      : `<p><b class="rc-ok">Spawn clear</b>: no marked enemy within ${RADIO_CLEAR} m</p>`;
    if (isMine(owner)) html += `<div class="row"><button data-radio-ring="${esc(it.id)}">${it.ring ? 'Hide' : 'Show'} the ${RADIO_CLEAR} m radius</button></div>`;
    return html;
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-radio-ring]');
    const it = b && state.me && state.players.get(state.me.name)?.items.get(b.dataset.radioRing);
    if (!it) return;
    map.closePopup();
    saveItem({ ...it, ring: !it.ring });
  });

  // Fire support request: a freehand area where the squad wants HE, smoke or illumination. Its popup gives every
  // mortar on the map a firing solution to the middle of it, using that mortar's shell of the same type.
  state.fireKind = 'he';
  state.fireShape = 'point';
  state.radioRing = true;
  function polyCentroid(pts) {
    let a = 0, cx = 0, cz = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const f = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
      a += f; cx += (pts[j][0] + pts[i][0]) * f; cz += (pts[j][1] + pts[i][1]) * f;
    }
    return a ? [cx / (3 * a), cz / (3 * a)] : pts[0];
  }
  // Firing solution from a mortar to a request's middle, with the mortar's shell of the requested type.
  function fireSolution(m, req) {
    const f = FIRE[req.fire] || FIRE.he;
    const shell = Object.keys(weaponDef(m.weapon)?.shells || {}).find(s => f.shell.test(s)) || m.shell;
    return { shell, sol: solveFor(m, fireAim(req), shell) };
  }
  const fireAim = req => (req.points ? polyCentroid(req.points) : req.xz);
  // A point request's circles (see impactZones): target zone = the mortar's spread, and the shell's kill and danger
  // zones (BLAST) beyond it. Sized for the mortar you follow or your own if it can reach, otherwise the nearest one that
  // can; with no mortar in range the spread is unknown and only one round's zones are drawn, for the worst shell of the
  // kind asked for.
  function fireSpread(req) {
    if (!TABLES) return null;
    const mine = solutionMortar()?.it;
    let best = null;
    allVisibleItems(i => i.type === 'mortar').forEach(({ p, it: m }) => {
      const r = { p, m, ...fireSolution(m, req) };
      if (!r.sol.best) return;
      if (mine && m.id === mine.id) best = { ...r, own: true };
      else if (!best || (!best.own && r.sol.d < best.sol.d)) best = r;
    });
    return best;
  }
  function fireZones(req) {
    const s = fireSpread(req), target = s ? s.sol.best.dispersion : 0;
    const shell = s ? s.shell : worstBlast((FIRE[req.fire] || FIRE.he).shell)?.shell, b = blastOf(shell);
    return { s, target, shape: s ? s.sol.best.spread : null, shell, blast: b,
      kill: b && b.kill ? target + b.kill : null, danger: b ? target + b.danger : null };
  }
  // Friendly markings a request would put in danger: inside an area or within its shell's danger distance of it, or
  // inside a point's danger zone.
  const isFriendly = it => (it.type === 'marker' && ['infantry', 'unit-inf-f', 'unit-arm-f', 'radio', 'rally'].includes(it.icon)) ||
    isOurPost(it) || it.type === 'emplacement' || it.type === 'mortar';
  function friendliesNear(req, R) {
    return allVisibleItems(isFriendly).map(({ p, it }) => ({
      name: isMarker(it, 'infantry') ? `${p.name}'s position` : it.label || typeLabel(it),
      d: req.points ? distToPoly(req.points, it.xz) : dist(req.xz, it.xz),
    })).filter(x => x.d <= R).sort((a, b) => a.d - b.d);
  }
  function renderFire(p, it, layer, html) {
    const f = FIRE[it.fire] || FIRE.he, c = fireAim(it);
    if (it.points) {
      const poly = L.polygon(it.points.map(toLL), { color: f.color, weight: 2.2, dashArray: '10 5', fillColor: f.color, fillOpacity: 0.2, bubblingMouseEvents: false });
      bindInfo(poly, html);
      layer.addLayer(poly);
    } else {
      const z = fireZones(it);
      impactZones(layer, c, z.target, z.shell, f.color, z.shape);
    }
    const m = L.marker(toLL(c), { keyboard: false, riseOnHover: true, zIndexOffset: 400, icon: L.divIcon({ className: 'fire-glyph', iconSize: [0, 0],
      html: `<svg viewBox="0 0 24 24" style="--c:${f.color}"><circle cx="12" cy="12" r="8"/><path d="M12 1v7M12 16v7M1 12h7M16 12h7"/></svg>` }) });
    const sm = TABLES && solutionMortar(), sol = sm && fireSolution(sm.it, it).sol;
    const name = `${it.label || 'Fire mission'} · ${f.name}${sol ? ` · ${sol.best ? fmtSolution(sol, true) : noReach(sol)}` : ''}`;
    m.bindTooltip(esc(isMine(p.name) ? name : `${name} (${p.name})`), { permanent: true, direction: 'right', offset: [14, 0], className: 'item-label fire-label' });
    bindInfo(m, html, () => c);
    layer.addLayer(m);
  }
  // Small moves from a solution: how elevation and azimuth change to shift the rounds NUDGE_M north, south, east or
  // west, on the same ring. {dir, elev, az} in mils, or null where that ring can't reach.
  const NUDGE_M = 50;
  function nudges(m, shell, xz, sol) {
    const circle = weaponDef(m.weapon)?.milsPerCircle || 6400, ring = sol.best.ring, d = NUDGE_M;
    return [['North', 0, d], ['South', 0, -d], ['East', d, 0], ['West', -d, 0]].map(([dir, dx, dz]) => {
      const s2 = solveFor(m, [xz[0] + dx, xz[1] + dz], shell), r = s2.rings.find(q => q.ring === ring);
      const daz = ((s2.azMil - sol.azMil + circle / 2) % circle + circle) % circle - circle / 2;
      return { dir, elev: r ? r.elev - sol.best.elev : null, az: daz };
    });
  }
  // Two rows, N / S and E / W, each cell "first / second" (e.g. elevation −6.4 / +6.4 mil).
  const nudgeTable = (rows, title) => {
    const [n, s, e, w] = rows, pair = (a, b, k) => `${signedMil(a[k])} / ${signedMil(b[k])}`;
    return `<h4 class="pop-h">${title}</h4><table class="fire trp-table"><tr><th>${NUDGE_M} m</th><th>Elevation (mil)</th><th>Azimuth (mil)</th></tr>` +
      `<tr><td>N / S</td><td>${pair(n, s, 'elev')}</td><td>${pair(n, s, 'az')}</td></tr>` +
      `<tr><td>E / W</td><td>${pair(e, w, 'elev')}</td><td>${pair(e, w, 'az')}</td></tr></table>`;
  };
  const signedMil = v => (v == null ? '—' : `${v >= 0.05 ? '+' : v <= -0.05 ? '−' : '±'}${Math.abs(v).toFixed(1)}`);
  // An area's north, south, east and west ends: where a north-south and an east-west line through its middle leave it
  // (the farthest crossing, for odd shapes), or its farthest corner that way if a line misses.
  function areaEnds(pts, c) {
    const out = {};
    for (const [name, axis, sign] of [['North', 1, 1], ['South', 1, -1], ['East', 0, 1], ['West', 0, -1]]) {
      const other = 1 - axis;
      let best = null;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if ((a[other] - c[other]) * (b[other] - c[other]) > 0 || a[other] === b[other]) continue;
        const k = (c[other] - a[other]) / (b[other] - a[other]), v = a[axis] + (b[axis] - a[axis]) * k;
        if (best == null || v * sign > best * sign) best = v;
      }
      const p = [0, 0];
      p[other] = c[other];
      p[axis] = best;
      out[name] = best != null ? p : pts.reduce((q, r) => (r[axis] * sign > q[axis] * sign ? r : q));
    }
    return out;
  }
  // Aiming details for one request, from the mortar that sizes it (the one you follow or your own if it can reach):
  // a point gets the NUDGE_M adjustments, an area a solution for its middle and for each end.
  function fireAimHtml(it, z) {
    const s = z.s;
    if (!s) return '';
    const who = `${esc(s.m.label || 'Mortar')}${isMine(s.p.name) ? '' : ` (${esc(s.p.name)})`}`;
    if (!it.points) {
      return nudgeTable(nudges(s.m, s.shell, it.xz, s.sol), `Adjust ${NUDGE_M} m · ${who}, ring ${s.sol.best.ring}`);
    }
    const c = fireAim(it), ends = areaEnds(it.points, c);
    const row = (name, xz) => {
      const sol = solveFor(s.m, xz, s.shell);
      return `<tr><td>${name}<div class="sub">${grid(xz, 4)} · ${fmtDist(sol.d)}</div></td><td>${fmtSolution(sol, true)}</td></tr>`;
    };
    return `<h4 class="pop-h">Across the area · ${who}, ${esc(s.shell)}</h4><table class="fire trp-table"><tr><th>Aim</th><th>Solution</th></tr>` +
      row('Middle', c) + Object.entries(ends).map(([name, xz]) => row(`${name} end`, xz)).join('') + '</table>';
  }
  function fireHtml(it, owner) {
    const f = FIRE[it.fire] || FIRE.he, c = fireAim(it), z = it.points ? null : fireZones(it);
    let size;
    if (it.points) {
      const xs = it.points.map(q => q[0]), zs = it.points.map(q => q[1]);
      size = ['Across', `${Math.round(Math.max(...xs) - Math.min(...xs))} × ${Math.round(Math.max(...zs) - Math.min(...zs))} m`];
    } else if (z.shape) size = ['Spread (9 in 10)', `±${z.shape.long} m long · ±${z.shape.side} m side`];
    else if (z.kill) size = [z.target ? 'Target / kill / danger' : 'Kill / danger', `${z.target ? `${z.target} / ` : ''}${z.kill} / ${z.danger} m`];
    else if (z.danger) size = [z.target ? 'Spread / danger' : 'Danger', `${z.target ? `±${z.target} / ` : ''}${z.danger} m`];
    else size = ['Spread', z.target ? `±${z.target} m` : '—'];
    let html = `<div class="stats"><div><span class="k">Fire</span><span class="v">${f.name}</span></div>` +
      `<div><span class="k">${size[0]}</span><span class="v">${size[1]}</span></div>` +
      `<div><span class="k">Asked</span><span class="v">${fmtAgo(Date.now() - (it.at || Date.now()))}</span></div></div>` +
      `<p>Aim point${it.points ? ' (middle)' : ''}: grid <b>${grid(c, 4)}</b></p>`;
    if (z) {
      const s = z.s, who = s && `${esc(s.m.label || 'Mortar')}${isMine(s.p.name) ? '' : ` (${esc(s.p.name)})`}`;
      html += s
        ? `<p class="sub">Sized for ${who}, ring ${s.sol.best.ring}</p>`
        : `<p class="sub">No mortar in range${z.blast ? `: zones for a single round of ${esc(z.shell)}` : ''}</p>`;
    }
    if (z && z.blast) html += `<p class="sub">${esc(impactText(z.shell, z.target, c, z.shape).zone)}</p>`;
    // friendlies: within a point's danger zone, or within the worst shell of this kind's danger distance of an area
    const areaBlast = it.points && worstBlast(f.shell), reach = it.points ? areaBlast && areaBlast.danger : z.danger;
    if (reach) html += friendlyWarning(friendliesNear(it, reach));
    const mortars = allVisibleItems(i => i.type === 'mortar');
    if (!TABLES) html += '<p class="sub">Firing tables are still loading.</p>';
    else if (!mortars.length) html += '<p class="sub">No mortar on the map.</p>';
    else {
      html += '<table class="fire trp-table"><tr><th>Mortar</th><th>Shell</th><th>Solution</th></tr>' + mortars.map(({ p, it: m }) => {
        const { shell, sol } = fireSolution(m, it);
        return `<tr><td>${esc(isMine(p.name) ? m.label || 'Mortar' : `${m.label || 'Mortar'} (${p.name})`)}</td><td>${esc(shell)}</td>` +
          `<td>${fmtSolution(sol, true)}</td></tr>`;
      }).join('') + '</table>';
      html += fireAimHtml(it, z || fireZones(it));
      const mine = myMortar(), sm = solutionMortar();
      const canClear = owner && !isMine(owner) && sm && fireSolution(sm.it, it).sol.best;
      if (mine || canClear) {
        html += `<div class="row">${mine ? `<button data-fire-add="${esc(it.id)}">Add as a target on my mortar</button>` : ''}` +
          (canClear ? `<button data-fire-clear="${esc(it.id)}" data-owner="${esc(owner)}">Mission complete: clear</button>` : '') + '</div>';
      }
    }
    return html;
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-fire-clear]');
    if (!b || !state.me) return;
    map.closePopup();
    api('/api/clear-fire', { id: state.me.id, token: state.me.token, owner: b.dataset.owner, itemId: b.dataset.fireClear })
      .then(() => toast('Fire request removed.')).catch(err => toast(err.message));
  });
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-follow-mortar]');
    if (!b) return;
    map.closePopup();
    setFollowMortar(b.dataset.followMortar || null);
    toast(b.dataset.followMortar ? 'Fire requests now show this mortar\'s solutions.' : 'Stopped showing that mortar\'s solutions.');
  });
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-fire-add]');
    if (!b || !state.me) return;
    const req = [...state.players.values()].map(p => p.items.get(b.dataset.fireAdd)).find(Boolean), m = myMortar();
    if (!req || !m) return;
    if ((m.targets || []).length >= 30) return toast('Your mortar already has 30 targets.');
    map.closePopup();
    saveItem({ ...m, targets: [...(m.targets || []), roundXZ(fireAim(req))] });
    toast(`Added to ${m.label || 'your mortar'}.`);
  });

  // ---------------------------------------------------------------------------
  // Helicopters: enemy AA guns, the helicopter route finder, air support requests
  // ---------------------------------------------------------------------------
  // Enemy AA gun: a 160° arc out to 1.5 km. The shading shows where it can see a helicopter flying state.heliAlt metres
  // above the ground (red), or only through trees (yellow); unshaded ground inside the arc is masked by terrain.
  // The stock game's threat to helicopters is its mounted heavy machine guns (M2 Browning, DShKM). AA_ELEV is how far
  // they can aim down and up: -10° to +70°, the DShKM tripod's limit in earlier Arma games (not confirmed for Reforger).
  const AA_ARC = 160, AA_RANGE = 1500, AA_EYE = 2, AA_ELEV = [-10, 70];
  const aaLos = it => losGrid(it.xz, it.dir, it.arc, it.range, true, AA_EYE + (it.height || 0), state.heliAlt, false, AA_ELEV);
  const aaIcon = draft => L.divIcon({ className: `empl-glyph aa-glyph${draft ? ' draft' : ''}`, iconSize: [0, 0], html: '<div style="--c:#ff5c5c">AA</div>' });
  function renderAa(p, it, layer, html) {
    const los = state.showLos ? aaLos(it) : null;
    if (los) layer.addLayer(losOverlay(los, ENEMY, false, 70));
    layer.addLayer(L.polygon(sectorLatLngs(it.xz, it.dir, it.arc, it.range), { color: ENEMY, weight: 1.5, opacity: 0.9, dashArray: '6 5', fill: false, interactive: false }));
    const m = L.marker(toLL(it.xz), { icon: aaIcon(), keyboard: false, riseOnHover: true, zIndexOffset: 600 });
    const name = it.label || 'AA gun';
    m.bindTooltip(esc(isMine(p.name) ? name : `${name} (${p.name})`), { direction: 'right', offset: [16, 0], className: 'item-label' });
    bindInfo(m, html, () => it.xz);
    layer.addLayer(m);
  }
  function aaHtml(it) {
    const los = aaLos(it);
    return `<div class="stats"><div><span class="k">Facing</span><span class="v">${pad(Math.round(it.dir) % 360, 3)}°</span></div>` +
      `<div><span class="k">Arc</span><span class="v">${it.arc}°</span></div><div><span class="k">Range</span><span class="v">${fmtDist(it.range)}</span></div></div>` +
      (los ? `<p><b class="rc-no">Sees a helicopter over ${los.pct}%</b> of its arc${los.treePct ? `, ${los.treePct}% more only through trees` : ''}</p>` : '') +
      `<p class="sub">Helicopter at ${state.heliAlt} m · unshaded = hidden from the gun</p>`;
  }
  let aaDraft = null; // {xz, layer, sector, los, raf}
  function aaClick(xz) {
    if (!aaDraft) {
      const layer = L.layerGroup().addTo(map);
      const sector = L.polygon([], { color: ENEMY, weight: 1.5, dashArray: '6 5', fill: false, interactive: false }).addTo(layer);
      L.marker(toLL(xz), { icon: aaIcon(true), interactive: false, keyboard: false }).addTo(layer);
      aaDraft = { xz, layer, sector };
      updateAaDraft();
      renderPicker();
      return;
    }
    if (dist(aaDraft.xz, xz) < 5) return;
    const n = issueNumber('aa', [...(state.players.get(state.me.name)?.items.values() || [])].filter(i => i.type === 'aa').length + 1);
    saveItem({ id: uid(), type: 'aa', side: 'e', xz: roundXZ(aaDraft.xz), dir: Math.round(bearing(aaDraft.xz, xz)) % 360, arc: AA_ARC, range: AA_RANGE,
      label: `AA gun ${n}`, note: '', color: ENEMY });
    cancelAaDraft();
  }
  function updateAaDraft() {
    const d = aaDraft;
    if (!d || !lastCursor || dist(d.xz, lastCursor) < 5) return;
    const dir = bearing(d.xz, lastCursor);
    d.sector.setLatLngs(sectorLatLngs(d.xz, dir, AA_ARC, AA_RANGE));
    cancelAnimationFrame(d.raf);
    d.raf = requestAnimationFrame(() => {
      if (aaDraft !== d) return;
      if (d.los) d.los.remove();
      const los = losGrid(d.xz, dir, AA_ARC, AA_RANGE, false, AA_EYE, state.heliAlt, false, AA_ELEV);
      d.los = los ? losOverlay(los, ENEMY, false, 70).addTo(d.layer) : null;
    });
  }
  function cancelAaDraft() {
    if (!aaDraft) return;
    cancelAnimationFrame(aaDraft.raf);
    aaDraft.layer.remove();
    aaDraft = null;
    renderPicker();
  }

  // Helicopter route finder: A* over the whole island on a 50 m grid, costed by distance with a wide berth around every
  // marked enemy. Inside a berth's inner radius counts 200 times the distance (only if there's no other way), fading
  // from 8 times at that radius to nothing at the outer one. Ground an enemy AA gun can see the helicopter over costs
  // 60 times more. Helicopters are loud and easy to see, so the berths are wide.
  const HELI_BERTH = {
    aa: { hard: 300, soft: 600 }, armour: { hard: 1000, soft: 1500 }, infantry: { hard: 600, soft: 900 }, area: { hard: 500, soft: 800 },
  };
  const HELI_KMH = 180, FLY_CELL = 50;
  function heliThreats() {
    const out = [];
    allVisibleItems(() => true).forEach(({ it }) => {
      const kind = it.type === 'aa' ? 'aa'
        : isMarker(it, 'unit-arm-e') || (it.type === 'post' && it.side === 'v') ? 'armour'
        : (it.type === 'marker' && ENEMY_WATCH[it.icon] && timeoutState(it) !== 'expired') || (it.type === 'post' && it.side === 'e') ? 'infantry'
        : isEnemyArea(it) ? 'area' : null;
      if (!kind) return;
      out.push({ kind, name: it.label || typeLabel(it), xz: it.xz, points: kind === 'area' ? it.points : null, ...HELI_BERTH[kind], los: kind === 'aa' ? aaLos(it) : null });
    });
    return out;
  }
  const threatDist = (t, xz) => (t.points ? distToPoly(t.points, xz) : dist(t.xz, xz));
  function heliPenalty(ts, xz) {
    let pen = 0;
    for (const t of ts) {
      const d = threatDist(t, xz);
      if (d < t.hard) pen += 200;
      else if (d < t.soft) pen += 8 * (1 - (d - t.hard) / (t.soft - t.hard));
      if (t.los) { const v = losAt(t.los, xz); if (v === LOS_CLEAR) pen += 60; else if (v === LOS_TREES) pen += 15; }
    }
    return pen;
  }
  function findFlightRoute(from, to) {
    const ts = heliThreats();
    if (!ts.length) return [roundXZ(from), roundXZ(to)];   // nothing to avoid: fly straight, not the grid's staircase
    const C = FLY_CELL, W = WORLD / C, pen = new Float32Array(W * W);
    const centre = k => [(k % W + 0.5) * C, (Math.floor(k / W) + 0.5) * C];
    const cellOf = ([x, z]) => Math.min(W - 1, Math.max(0, Math.floor(z / C))) * W + Math.min(W - 1, Math.max(0, Math.floor(x / C)));
    for (let k = 0; k < W * W; k++) pen[k] = heliPenalty(ts, centre(k));
    const s = cellOf(from), g = cellOf(to), gx = centre(g);
    const path = aStar(W, W, C, s, g, (k, n, len) => len * (1 + (pen[k] + pen[n]) / 2), k => dist(centre(k), gx));
    if (!path) return null;
    const cells = path.map(centre);
    cells[0] = from; cells[cells.length - 1] = to;
    let tol = 25, pts = simplify(cells, tol);
    while (pts.length > 200) pts = simplify(cells, tol *= 1.5);
    return pts.map(roundXZ);
  }
  // Flight time, how long the AA can see it, and how close it comes to each marked enemy.
  const flightCache = new Map();
  function flightCheck(pts) {
    const key = `${pts.join(';')}#${threatSig()}#${state.heliAlt}`;
    if (flightCache.has(key)) return flightCache.get(key);
    const ts = heliThreats(), total = pathLength(pts), step = Math.max(25, total / 600);
    const closest = ts.map(() => Infinity);
    let aaSeen = 0;
    for (let d = 0; d <= total; d += step) {
      const xz = pointAlong(pts, d);
      ts.forEach((t, i) => { closest[i] = Math.min(closest[i], threatDist(t, xz)); });
      if (ts.some(t => t.los && losAt(t.los, xz) === LOS_CLEAR)) aaSeen += step;
    }
    const near = ts.map((t, i) => ({ name: t.name, kind: t.kind, min: closest[i], hard: t.hard, soft: t.soft }))
      .filter(x => x.min < x.soft).sort((a, b) => a.min / a.hard - b.min / b.hard);
    const res = { total, time: total / (HELI_KMH / 3.6), aaSeen: Math.min(aaSeen, total), near, threats: ts.length };
    if (flightCache.size > 40) flightCache.clear();
    flightCache.set(key, res);
    return res;
  }
  function flightHtml(fc) {
    let html = `<div class="stats"><div><span class="k">Distance</span><span class="v">${fmtDist(fc.total)}</span></div>` +
      `<div><span class="k">Flight time</span><span class="v">${fmtTime(fc.time)}</span></div>` +
      `<div><span class="k">AA can see</span><span class="v">${fc.aaSeen ? fmtDist(fc.aaSeen) : 'none'}</span></div></div>`;
    if (!fc.threats) html += '<p class="sub">No enemies marked: straight line.</p>';
    else if (!fc.near.length) html += `<p><b class="rc-ok">Keeps a wide berth</b> of all ${fc.threats} marked enemies.</p>`;
    else {
      html += '<table class="fire trp-table"><tr><th>Passes</th><th>Closest</th><th>Berth</th></tr>' + fc.near.slice(0, 6).map(x =>
        `<tr><td>${esc(x.name)}</td><td>${x.min < x.hard ? `<span class="no">${fmtDist(x.min)}</span>` : fmtDist(x.min)}</td><td>${fmtDist(x.hard)}</td></tr>`).join('') + '</table>';
    }
    return html + `<p class="sub">${HELI_KMH} km/h, ${state.heliAlt} m up</p>`;
  }
  // Flights start and end on a landing zone or pickup request when you click near one.
  function snapHeli(xz) {
    let best = null;
    allVisibleItems(it => isMarker(it, 'lz', 'air-medevac', 'air-pickup')).forEach(({ it }) => {
      const d = dist(it.xz, xz);
      if (d < 80 && (!best || d < best.d)) best = { d, xz: it.xz };
    });
    return best ? best.xz : xz;
  }
  function heliClick(xz) {
    xz = snapHeli(xz);
    if (!coverDraft || coverDraft.pts) {
      cancelCoverDraft();
      coverDraft = { heli: true, start: xz, layer: L.layerGroup().addTo(map) };
      coverDraft.layer.addLayer(L.circleMarker(toLL(xz), { radius: 5, color: '#000', weight: 1.5, fillColor: ARROWS.flight.color, fillOpacity: 1, interactive: false }));
      updateHint();
      return;
    }
    const from = coverDraft.start;
    if (dist(from, xz) < 100) return toast('Pick an end at least 100 m from the start.');
    toast('Planning the flight…', 1500);
    const draft = coverDraft;
    setTimeout(() => {
      if (coverDraft !== draft) return;
      draft.pts = findFlightRoute(from, xz) || [from, xz];
      showFlightResult(draft);
      updateHint();
    }, 30);
  }
  function showFlightResult(d) {
    d.layer.clearLayers();
    const fc = flightCheck(d.pts), straight = flightCheck([d.pts[0], d.pts[d.pts.length - 1]]), lls = d.pts.map(toLL);
    d.layer.addLayer(L.polyline(lls, { color: '#000', weight: 7, opacity: 0.45, interactive: false }));
    const line = L.polyline(lls, { color: ARROWS.flight.color, weight: 4, dashArray: '12 7', bubblingMouseEvents: false }).addTo(d.layer);
    [d.pts[0], d.pts[d.pts.length - 1]].forEach(xz => d.layer.addLayer(L.circleMarker(toLL(xz), { radius: 5, color: '#000', weight: 1.5, fillColor: ARROWS.flight.color, fillOpacity: 1, interactive: false })));
    const end = d.pts[d.pts.length - 1];
    const html = () => popupHtml('Flight route', `${fmtDist(fc.total)} · ${fmtTime(fc.time)}`, end, flightHtml(fc) +
      `<p class="sub">Straight across would be ${fmtDist(straight.total)} (${fmtTime(straight.time)})${straight.near.some(x => x.min < x.hard) ? ', inside an enemy berth' : ''}` +
      `${straight.aaSeen ? `, seen by AA for ${fmtDist(straight.aaSeen)}` : ''}.</p>` +
      '<div class="row"><button data-cover="save">Save as flight route</button><button data-cover="discard">Discard</button></div>');
    line.on('click', e => { L.DomEvent.stop(e); popup().setLatLng(toLL(end)).setContent(html()).openOn(map); });
    popup().setLatLng(toLL(end)).setContent(html()).openOn(map);
  }

  // Air support requests (AIR, defined with the other marking kinds): pins with a short form.
  const airAim = it => (it.points ? polyCentroid(it.points) : it.xz);
  function airSummary(it) {
    const a = it.air || {}, key = airKey(it);
    if (key === 'air-medevac') return [a.patients && `${a.patients} casualt${a.patients === '1' ? 'y' : 'ies'}`, a.urgency].filter(Boolean).join(' · ');
    if (key === 'air-pickup') return [a.task, a.seats && `${a.seats} seats`].filter(Boolean).join(' · ');
    if (key === 'air-cas') return a.target || '';
    return a.needs || '';
  }
  function renderAir(p, it, layer, html) {
    const key = airKey(it), a = AIR[key], status = it.status || 'requested', c = airAim(it);
    if (it.points) {
      const poly = L.polygon(it.points.map(toLL), { color: a.color, weight: 2.2, dashArray: '10 5', fillColor: a.color, fillOpacity: 0.16, bubblingMouseEvents: false });
      bindInfo(poly, html);
      layer.addLayer(poly);
    }
    const dir = key === 'air-cas' && it.air && it.air.dir !== '' && it.air.dir != null ? +it.air.dir : null;
    if (dir != null && Number.isFinite(dir)) { // the attack run comes in from `dir`
      const b = dir * Math.PI / 180, at = r => [c[0] + r * Math.sin(b), c[1] + r * Math.cos(b)];
      layer.addLayer(L.polyline([toLL(at(400)), toLL(at(40))], { color: a.color, weight: 2.5, dashArray: '8 6', opacity: 0.9, interactive: false }));
      layer.addLayer(arrowHead(at(40), (dir + 180) % 360, a.color, 16));
    }
    const m = L.marker(toLL(c), { icon: L.divIcon({ className: `air-glyph st-${status}`, iconSize: [0, 0], html: `<div style="--c:${a.color}">${a.badge}</div>` }),
      keyboard: false, riseOnHover: true, zIndexOffset: 750 });
    const text = [it.label || a.short, airSummary(it), AIR_STATUS[status].name].filter(Boolean).join(' · ');
    m.bindTooltip(esc(isMine(p.name) ? text : `${text} (${p.name})`), { permanent: true, direction: 'right', offset: [15, 0], className: `item-label air-label st-${status}` });
    bindInfo(m, html, () => c);
    layer.addLayer(m);
  }
  function airHtml(owner, it) {
    const key = airKey(it), a = AIR[key], vals = it.air || {}, status = it.status || 'requested';
    let html = '<div class="stats wrap">' + a.fields.map(([k, label, opts]) => {
      const v = vals[k], shown = opts && opts[0] && Array.isArray(opts[0]) ? (opts.find(o => o[0] === v) || [])[1] : v;
      return `<div><span class="k">${label}</span><span class="v">${esc(shown || '—')}</span></div>`;
    }).join('') + '</div>';
    html += `<p><b>${AIR_STATUS[status].name}</b>${it.statusBy ? ` by ${esc(it.statusBy)}` : ''} · asked ${fmtAgo(Date.now() - (it.at || Date.now()))}</p>`;
    html += '<div class="row air-status">' + ['ack', 'enroute', 'done'].map(s =>
      `<button data-air-status="${s}" data-owner="${esc(owner)}" data-id="${esc(it.id)}"${status === s ? ' disabled' : ''}>${AIR_STATUS[s].name}</button>`).join('') + '</div>';
    if (a.lz) {
      const c = lzCheck(it.xz);
      if (c) html += `<p class="lz-verdict" style="--c:${LZ_COLOR[c.verdict]}">Landing spot: <b>${LZ_WORD[c.verdict]}</b>${c.reasons.length ? `: ${c.reasons.join(', ')}` : ''}` +
        ` · approaches ${c.open.length ? c.open.join(' ') : 'none'}</p>`;
    }
    if (it.points) html += `<p>Target area ${fmtArea(polyArea(it.points))}, middle at grid <b>${grid(airAim(it), 4)}</b></p>`;
    if (key === 'air-cas') html += friendlyWarning(friendliesNear(it, DANGER_CLOSE)).replace('in the danger zone', `danger close (${DANGER_CLOSE} m)`);
    return html;
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-air-status]');
    if (!b || !state.me) return;
    map.closePopup();
    api('/api/air-status', { id: state.me.id, token: state.me.token, owner: b.dataset.owner, itemId: b.dataset.id, status: b.dataset.airStatus })
      .catch(err => toast(err.message));
  });

  // ---------------------------------------------------------------------------
  // Hazards: contact reports that age out, sniper / blocked road / bridge out markers
  // ---------------------------------------------------------------------------
  // Timeouts: contact reports and unit markers can carry a ttl in minutes (0 = never). They fade once a third of
  // the time has passed and disappear at the end; the owner's page then deletes them for everyone.
  state.unitTtl = 15;
  state.contactTtl = 15;
  const ttlOf = it => (it.type !== 'marker' ? 0
    : it.icon === 'contact' ? it.ttl ?? 15 // contacts from before timeouts were adjustable used 15 min
    : UNITS[it.icon] ? it.ttl || 0 : 0);
  function timeoutState(it) {
    const ttl = ttlOf(it) * 60e3, age = Date.now() - (it.at || Date.now());
    return !ttl ? 'live' : age > ttl ? 'expired' : age > ttl / 3 ? 'stale' : 'live';
  }
  function timeoutText(it) {
    const ttl = ttlOf(it);
    if (!ttl) return 'never times out';
    const left = Math.max(0, Math.ceil(ttl - (Date.now() - (it.at || Date.now())) / 60e3));
    return `fades at ${Math.round(ttl / 3)} min, removed in ${left} min`;
  }

  const HEADING_NAME = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
  function renderContact(p, it, layer, html) {
    const age = Date.now() - (it.at || Date.now()), t = timeoutState(it);
    if (t === 'expired') return; // the owner's page removes it
    const hd = typeof it.heading === 'number'
      ? `<svg class="hd" viewBox="0 0 56 56" style="transform:translate(-50%,-50%) rotate(${it.heading}deg)"><path d="M28 16V3M22 9l6-6 6 6"/></svg>` : '';
    const cls = t === 'stale' ? ' stale' : age < 60e3 ? ' fresh' : '';
    const m = L.marker(toLL(it.xz), { icon: L.divIcon({ className: `contact-glyph${cls}`, iconSize: [0, 0], html: `${hd}<div><span>!</span></div>` }),
      keyboard: false, riseOnHover: true, zIndexOffset: 700 });
    const mins = Math.floor(age / 60e3);
    const text = [it.label || 'Contact', it.what, it.size, mins < 1 ? 'now' : `${mins} min`].filter(Boolean).join(' · ');
    if (it.trail && it.trail.length) { // where it has been: a dashed track, oldest first, ending at the contact
      const pts = [...it.trail, it.xz].map(toLL);
      layer.addLayer(L.polyline(pts, { color: '#ff5c5c', weight: 2, opacity: t === 'stale' ? 0.35 : 0.7, dashArray: '2 6', interactive: false }));
      it.trail.forEach(q => layer.addLayer(L.circleMarker(toLL(q), { radius: 3, color: '#ff5c5c', weight: 1.5, fillColor: '#0d1115', fillOpacity: 1, opacity: 0.8, interactive: false })));
    }
    m.bindTooltip(esc(isMine(p.name) ? text : `${text} (${p.name})`), { permanent: true, direction: 'right', offset: [15, 0], className: `item-label contact-label${cls}` });
    bindInfo(m, html, () => it.xz);
    layer.addLayer(m);
  }
  // Keep the fade and the minutes current; your own expired markings are removed for everyone.
  setInterval(() => {
    let any = false;
    state.players.forEach(p => p.items.forEach(it => {
      if (!ttlOf(it)) return;
      if (isMine(p.name) && timeoutState(it) === 'expired') deleteItem(it.id);
      renderItem(p, it);
      any = true;
    }));
    if (any) refreshLists();
  }, 20000);

  const HAZARD_SVG = {
    sniper: '<circle cx="12" cy="12" r="6.5"/><path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5"/>',
    blocked: '<circle cx="12" cy="12" r="8.5" class="f"/><path d="M7 12h10" class="w"/>',
    'enemy-ambush': '<path d="M12 2.5l9.5 9.5-9.5 9.5L2.5 12z" class="f"/><path d="M7 12.5h10" class="w"/><path d="M9 9l3-2 3 2" class="w"/>',
    bridge: '<path d="M3 9h6M15 9h6M3 15h6M15 15h6"/><path d="M11 5.5l2 2.5-2 2.5 2 2.5-2 2.5 2 2.5"/>',
  };
  const hazardIcon = kind => L.divIcon({ className: `hazard-glyph hz-${kind}`, iconSize: [0, 0], html: `<div><svg viewBox="0 0 24 24">${HAZARD_SVG[kind]}</svg></div>` });

  // --- Who can hear it (GUNS is defined with the tool options, above) -----------------------------------------------------
  const gunOf = it => GUNS[it.gun] || GUNS.rifle;
  const HEAR_COLOR = '#b197fc';
  function renderAudible(p, it, layer, html) {
    const g = gunOf(it);
    layer.addLayer(L.circle(toLL(it.xz), { radius: g.range, color: HEAR_COLOR, weight: 1.6, dashArray: '3 6', fillColor: HEAR_COLOR, fillOpacity: 0.05, interactive: false }));
    const m = L.marker(toLL(it.xz), { icon: glyphIcon('♪', HEAR_COLOR), keyboard: false, zIndexOffset: 300 });
    const name = it.label || g.name;
    m.bindTooltip(esc(`${name} · heard ${fmtDist(g.range)}${isMine(p.name) ? '' : ` (${p.name})`}`), { direction: 'right', offset: [12, 0], className: 'item-label' });
    bindInfo(m, html, () => it.xz);
    layer.addLayer(m);
  }
  function audibleHtml(it) {
    const g = gunOf(it);
    return `<div class="stats"><div><span class="k">Weapon</span><span class="v">${esc(g.name)}</span></div>` +
      `<div><span class="k">Heard out to</span><span class="v">${fmtDist(g.range)}</span></div></div>` +
      `<p class="sub">${esc(g.of)}.</p>` + (g.note ? `<p class="sub">${esc(g.note)}</p>` : '') +
      `<p class="sub">Muzzle blast against ${esc(NOISE.find(n => n[0] === state.noise)[1].toLowerCase())} noise (${NOISE_LUFS[state.noise]} LUFS), from the game's sound files. ` +

      `${NOISE.filter(([k]) => k !== state.noise).map(([k, n]) => `${n} ${fmtDist(REACH_M[it.gun in REACH_M ? it.gun : 'rifle'][k])}`).join(' · ')}. Ignores terrain, trees, buildings and the bullet's crack.</p>`;
  }

  // Popup details for the planning and hazard markings
  function planPopupHtml(owner, it) {
    if (it.type === 'audible') return audibleHtml(it);
    if (it.type === 'overwatch') return overwatchHtml(it);
    if (it.type === 'hulldown') return hullDownHtml(it);
    if (isMarker(it, 'lz')) return lzHtml(owner, it);
    if (it.type === 'post' || isPositionCard(it)) {
      const los = postLos(it), enemy = isEnemyPost(it), alt = heightAt(it.xz), kind = POST_KIND[it.side] || POST_KIND.f;
      let html = `<div class="stats"><div><span class="k">Reach</span><span class="v">${fmtDist(it.range)}</span></div>` +
        `<div><span class="k">${enemy ? 'Enemy sees' : 'Sees'}</span><span class="v">${los ? los.pct + '%' : '—'}</span></div>` +
        `<div><span class="k">Height</span><span class="v">${alt != null ? Math.round(alt) + ' m' : '—'}</span></div></div>`;
      if (los && los.treePct) html += `<p class="sub">+${los.treePct}% through trees</p>`;
      if (!enemy) {
        const trps = allVisibleItems(i => i.type === 'marker' && i.icon === 'trp').map(({ it: t }) => t)
          .sort((a, b) => bearing(it.xz, a.xz) - bearing(it.xz, b.xz));
        html += trps.length
          ? `<table class="fire trp-table"><tr><th>TRP</th><th>Distance</th><th>Bearing</th><th>Seen</th></tr>${trps.map(t => trpRow(t.label || 'TRP', it.xz, t.xz, los)).join('')}</table>`
          : '<p class="sub">No TRPs yet (Defend ▾ → TRP).</p>';
      }
      html += `<p class="sub">${enemy ? 'Red: seen clearly' : 'Tinted: seen'} · yellow: through trees</p>`;
      return html;
    }
    if (it.type === 'marker' && it.icon === 'trp') {
      const rows = allVisibleItems(isRangeCard).map(({ p, it: post }) => trpRow(cardName(p, post), post.xz, it.xz, postLos(post)));
      const me = myPosition();
      if (me && !isPositionCard(me)) rows.push(trpRow('My position', me.xz, it.xz, null));
      return rows.length ? `<table class="fire trp-table"><tr><th>From</th><th>Distance</th><th>Bearing</th><th>Seen</th></tr>${rows.join('')}</table>`
        : '<p class="sub">No range card to measure from.</p>';
    }
    if (it.type === 'sectors') {
      const mil = (deg, end) => pad(Math.round(deg * 6400 / 360) % 6400 || (end ? 6400 : 0), 4), degs = (deg, end) => pad(Math.round(deg) % 360 || (end ? 360 : 0), 3);
      const rows = sectorSpans(it).map(([a, b], i) => ({ a, b, i, span: b - a, los: sectorLos(it, a, b - a), foes: sectorFoes(it, a, b - a), trps: sectorTrps(it, a, b - a) }));
      const seen = r => !r.los ? '—' : `${r.los.pct}%${r.los.treePct ? ` <span class="trees">+${r.los.treePct}% trees</span>` : ''}`;
      const notes = rows.filter(r => r.foes.length || r.trps.length).map(r => `<div><span class="sec-id" style="--c:${SECTOR_COLORS[r.i % SECTOR_COLORS.length]}">${SECTOR_LETTERS[r.i]}</span> ` +
        [...r.foes.slice(0, 3).map(e => `<span class="no">${esc([e.what, e.size].filter(Boolean).join(' ') || e.label || typeLabel(e))}</span> ${fmtDist(dist(it.xz, e.xz))}`),
          ...(r.foes.length > 3 ? [`+${r.foes.length - 3} more enemy`] : []), ...r.trps.map(t => esc(t.label || 'TRP'))].join(' · ') + '</div>').join('');
      return `<div class="stats"><div><span class="k">Reach</span><span class="v">${fmtDist(it.radius)}</span></div>` +
        `<div><span class="k">Sectors</span><span class="v">${it.n}</span></div>` +
        `<div><span class="k">Gun height</span><span class="v">${sectorEye(it)} m</span></div></div>` +
        `<table class="fire trp-table"><tr><th>Sector</th><th>Bearings</th><th>Sees</th><th>Covered by</th></tr>` + rows.map(r =>
        `<tr><td><span class="sec-id" style="--c:${SECTOR_COLORS[r.i % SECTOR_COLORS.length]}">${SECTOR_LETTERS[r.i]}</span></td>` +
        `<td>${degs(r.a)}°–${degs(r.b, true)}°<br><span class="sub">${mil(r.a)}–${mil(r.b, true)} mil</span></td><td>${seen(r)}</td><td>${esc((it.names || [])[r.i] || '—')}</td></tr>`).join('') + '</table>' +
        (notes ? `<div class="sec-notes">${notes}</div>` : '') +
        '<p class="sub">Sees: % of the sector\'s ground the gunner can see.</p>' +
        (isMine(owner) ? '<p class="sub">Edit to assign gunners or raise the position.</p>' : '');
    }
    if (it.type === 'ambush') {
      return `<p><b>Kill zone ${fmtDist(dist(it.from, it.to))}</b> · road runs ${pad(Math.round(bearing(it.from, it.to)) % 360, 3)}°</p>` +
        `<div class="amb-key"><span style="--c:${AMB.kz}">Kill zone</span><span style="--c:${AMB.support}">Support (MG)</span>` +
        `<span style="--c:${AMB.assault}">Assault</span><span style="--c:${AMB.security}">Security</span></div>` +
        (isMine(owner) ? '<p class="sub">Drag the round handles to move it or stretch the kill zone.</p>' : '');
    }
    if (it.type === 'arrow') {
      const pts = it.points;
      return `<p><b>${fmtDist(pathLength(pts))}</b> · heading ${pad(Math.round(bearing(pts[pts.length - 2], pts[pts.length - 1])) % 360, 3)}° at the tip</p>`;
    }
    if (it.type === 'marker' && it.icon === 'contact') {
      const hd = typeof it.heading === 'number' ? HEADING_NAME[it.heading] || `${it.heading}°` : '—';
      const me = myPosition(), away = me ? `${fmtDist(dist(me.xz, it.xz))} ${compass(bearing(me.xz, it.xz))} of you` : '';
      const seen = `${fmtAgo(Date.now() - (it.at || Date.now()))}${typeof it.gt === 'number' ? ` (game time ${fmtGame(it.gt)})` : ''}`;
      return `<div class="stats wrap"><div><span class="k">What</span><span class="v">${esc(it.what || '?')}</span></div>` +
        `<div><span class="k">How many</span><span class="v">${esc(it.size || '?')}</span></div>` +
        `<div><span class="k">Doing</span><span class="v">${esc(it.activity || '?')}</span></div>` +
        `<div><span class="k">Heading</span><span class="v">${hd}</span></div></div>` +
        (it.kit ? `<p>Carrying <b>${esc(it.kit)}</b></p>` : '') +
        (away ? `<p>${away}</p>` : '') +
        (it.trail && it.trail.length ? `<p class="sub">Has moved ${fmtDist(pathLength([...it.trail, it.xz]))} since first seen (dotted track).</p>` : '') +
        `<p class="sub">Seen ${seen} · ${timeoutText(it)}</p>` +
        (isMine(owner) ? `<div class="row"><button data-act="contact-move" data-id="${esc(it.id)}" title="Click the map where it is now; the old spot stays as a dotted track">It moved</button></div>` : '');
    }
    if (it.type === 'marker' && HAZARDS[it.icon] && it.at) return `<p class="sub">Marked ${fmtAgo(Date.now() - it.at)}</p>`;
    return '';
  }

  // ---------------------------------------------------------------------------
  // FIA caches this game: type the coordinates, snap to the nearest known cache spot
  // ---------------------------------------------------------------------------
  const FIA_FAR = 400; // metres; further than this from any known spot and we warn about the coordinates

  // Accepts "089 028" / "089028" (100 m grid), "0890 0281" / "08900281" (10 m grid),
  // or plain metres "8908 2811" / "8908, 2811". Returns [x, z] in metres, 'off' if outside the map, or null if unreadable.
  function parseCoords(text) {
    const s = text.trim();
    let a, b;
    const pair = s.match(/^(\d{1,5})\s*[,;/\s]\s*(\d{1,5})$/);
    if (pair) { a = pair[1]; b = pair[2]; }
    else {
      const run = s.replace(/[\s-]/g, '');
      if (!/^\d+$/.test(run) || run.length % 2 || run.length < 6 || run.length > 10) return null;
      a = run.slice(0, run.length / 2); b = run.slice(run.length / 2);
    }
    const conv = str => {
      const n = +str;
      if (str.length === 3) return n * 100 + 50;               // 100 m grid square -> centre
      if (str.length === 4 && n * 10 <= WORLD) return n * 10 + 5; // 10 m grid square -> centre
      return n;                                                 // metres
    };
    const xz = [conv(a), conv(b)];
    return xz.every(v => v >= 0 && v <= WORLD) ? xz : 'off';
  }

  function nearestFia(xz) {
    let best = null, bestD = Infinity;
    for (const f of FIA_KNOWN) {
      const d = dist(f.xz, xz);
      if (d < bestD) { bestD = d; best = f; }
    }
    return best && { cache: best, d: bestD };
  }

  const myFia = () => {
    const me = state.me && state.players.get(state.me.name);
    return me ? [...me.items.values()].find(i => i.type === 'fia') : null;
  };
  // Every marked cache across visible players: name -> owner (first to mark it wins)
  function fiaMarked() {
    const out = new Map();
    state.players.forEach(p => {
      if (!isMine(p.name) && !state.showOthers) return;
      p.items.forEach(it => { if (it.type === 'fia') it.caches.forEach(n => { if (!out.has(n)) out.set(n, p.name); }); });
    });
    return out;
  }
  const fiaOwner = name => fiaMarked().get(name) || null;

  function fiaMessage(text, kind = '') {
    const el = $('#fia-msg');
    el.textContent = text;
    el.className = `fia-msg ${kind}`;
  }

  function addFiaCache(name) {
    if (!state.me) return;
    const owner = fiaOwner(name);
    if (owner) { fiaMessage(`${name} is already marked${isMine(owner) ? '' : ` by ${owner}`}.`, 'warn'); return false; }
    const mine = myFia();
    saveItem(mine
      ? { ...mine, caches: [...mine.caches, name] }
      : { id: uid(), type: 'fia', caches: [name], label: 'FIA caches', note: '', color: state.me.color });
    if (!map.hasLayer(refLayers.fiaGame)) {
      refLayers.fiaGame.addTo(map);
      const cb = document.querySelector('#fiaGame-n')?.closest('.layer')?.querySelector('input');
      if (cb) cb.checked = true;
    }
    return true;
  }

  function removeFiaCache(name) {
    const mine = myFia();
    if (!mine) return;
    const caches = mine.caches.filter(n => n !== name);
    caches.length ? saveItem({ ...mine, caches }) : deleteItem(mine.id);
  }

  // A pasted list of cache coordinates: one or more per line (list numbering like "1." or "-" is ignored). Each line's
  // numbers pair up as grid or X/Z values ("089 028 091 030"), or a run of digits splits in half ("089028").
  // Returns [{text, xz}] with xz null for anything unreadable, or 'off' off the map.
  function parseCoordList(text) {
    const out = [];
    for (const raw of text.split(/[\n;]+/)) {
      const line = raw.replace(/^\s*(\d{1,2}[.)]|[-*•])\s+/, '').trim();
      if (!line) continue;
      const nums = line.match(/\d+/g) || [];
      if (nums.length >= 2 && nums.length % 2 === 0 && nums.every(n => n.length >= 3 && n.length <= 5)) {
        for (let i = 0; i < nums.length; i += 2) out.push({ text: `${nums[i]} ${nums[i + 1]}`, xz: parseCoords(`${nums[i]} ${nums[i + 1]}`) });
      } else if (nums.length > 1 && nums.every(n => n.length >= 6 && n.length <= 10)) {
        nums.forEach(n => out.push({ text: n, xz: parseCoords(n) }));
      } else out.push({ text: line, xz: parseCoords(line) });
    }
    return out;
  }
  // Mark several caches in one save; returns {added, already}.
  function addFiaCaches(names) {
    const marked = fiaMarked(), added = [], already = [];
    for (const n of names) {
      if (added.includes(n) || already.includes(n)) continue; // listed twice
      (marked.has(n) ? already : added).push(n);
    }
    if (added.length && state.me) {
      const mine = myFia();
      saveItem(mine ? { ...mine, caches: [...mine.caches, ...added] }
        : { id: uid(), type: 'fia', caches: added, label: 'FIA caches', note: '', color: state.me.color });
      if (!map.hasLayer(refLayers.fiaGame)) {
        refLayers.fiaGame.addTo(map);
        const cb = document.querySelector('#fiaGame-n')?.closest('.layer')?.querySelector('input');
        if (cb) cb.checked = true;
      }
    }
    return { added, already };
  }
  const fiaInput = $('#fia-input');
  const fitFiaInput = () => { fiaInput.style.height = 'auto'; fiaInput.style.height = `${Math.min(fiaInput.scrollHeight + 2, 180)}px`; };
  fiaInput.addEventListener('input', fitFiaInput);
  fiaInput.addEventListener('keydown', e => { // Enter adds; Shift+Enter starts a new line
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#fia-form').requestSubmit(); }
  });
  $('#fia-form').addEventListener('submit', e => {
    e.preventDefault();
    const input = $('#fia-input');
    if (!FIA_KNOWN.length) return fiaMessage('Cache locations are still loading.', 'err');
    const entries = parseCoordList(input.value);
    if (entries.length > 1) return addFiaList(entries);
    const xz = parseCoords(input.value);
    if (!xz) return fiaMessage('Couldn\'t read that. Try "089 028".', 'err');
    if (xz === 'off') return fiaMessage(`Those coordinates are off the map. ${MAP.name} grids run from 000 to ${Math.floor(WORLD / 100)}.`, 'err');
    const hit = nearestFia(xz);
    const where = `${hit.cache.name} (${grid(hit.cache.xz)})`;
    if (!addFiaCache(hit.cache.name)) return;
    input.value = '';
    fitFiaInput();
    if (hit.d > FIA_FAR) fiaMessage(`Snapped to ${where}, but it's ${fmtDist(hit.d)} from what you typed. Double-check the coordinates.`, 'warn');
    else fiaMessage(`Snapped to ${where}, ${fmtDist(hit.d)} from your coordinates.`, 'ok');
    flyAndOpen(hit.cache.xz, () => fiaPopup(hit.cache));
  });

  // Several coordinates at once: snap each to its nearest cache and mark them all in one go.
  function addFiaList(entries) {
    const bad = [], off = [], far = [], names = [];
    for (const { text, xz } of entries) {
      if (!xz) { bad.push(text); continue; }
      if (xz === 'off') { off.push(text); continue; }
      const hit = nearestFia(xz);
      names.push(hit.cache.name);
      if (hit.d > FIA_FAR) far.push(`${text} → ${hit.cache.name} (${fmtDist(hit.d)} away)`);
    }
    const { added, already } = addFiaCaches(names);
    const parts = [];
    if (added.length) parts.push(`Marked ${added.length} cache${added.length === 1 ? '' : 's'}: ${added.join(', ')}.`);
    if (already.length) parts.push(`Already marked: ${already.join(', ')}.`);
    if (far.length) parts.push(`Far from any known spot, double-check: ${far.join('; ')}.`);
    if (off.length) parts.push(`Off the map: ${off.join(', ')}.`);
    if (bad.length) parts.push(`Couldn't read: ${bad.map(t => `"${t}"`).join(', ')}.`);
    fiaMessage(parts.join(' ') || 'Nothing to add.', bad.length || off.length ? 'err' : far.length || !added.length ? 'warn' : 'ok');
    // keep only what couldn't be read in the box, to fix and add again
    $('#fia-input').value = [...bad, ...off].join('\n');
    fitFiaInput();
    const pts = added.map(n => FIA_KNOWN.find(k => k.name === n)?.xz).filter(Boolean);
    if (pts.length) map.flyToBounds(L.latLngBounds(pts.map(toLL)).pad(0.3), { maxZoom: 3, duration: 0.8 });
  }

  function fiaPopup(f) {
    const owner = fiaOwner(f.name);
    const btn = owner && isMine(owner) ? `<div class="row"><button class="danger" data-act="fia-remove" data-name="${esc(f.name)}">Unmark</button></div>` : '';
    return popupHtml(`FIA cache: ${f.name}`, owner ? `This game's cache · marked by ${owner}${isMine(owner) ? ' (you)' : ''}` : 'Possible cache spot', f.xz, btn);
  }

  // Redraw the "this game" layer and sidebar list from everyone's shared lists.
  function refreshFia() {
    const layer = refLayers.fiaGame;
    const marked = fiaMarked();
    if (layer) {
      layer.clearLayers();
      marked.forEach((owner, name) => {
        const f = FIA_KNOWN.find(k => k.name === name);
        if (!f) return;
        const m = L.marker(toLL(f.xz), { icon: glyphIcon('◆', C.fia, 'fia-live'), keyboard: false, zIndexOffset: 800 });
        m.bindTooltip(esc(name), { permanent: true, direction: 'right', offset: [16, 0], className: 'fia-label' });
        bindInfo(m, () => fiaPopup(f), () => f.xz);
        layer.addLayer(m);
      });
    }
    const n = $('#fiaGame-n');
    if (n) n.textContent = marked.size;
    $('#fia-count').textContent = marked.size || '';
    $('#fia-list').innerHTML = [...marked].map(([name, owner]) => {
      const f = FIA_KNOWN.find(k => k.name === name);
      return `<li data-name="${esc(name)}"><span class="lg-live">◆</span><span class="t">${esc(name)}</span>` +
        `<span class="g">${f ? grid(f.xz) : ''}</span>` +
        (isMine(owner) ? `<button data-act="fia-remove" data-name="${esc(name)}" title="Unmark" aria-label="Unmark ${esc(name)}">✕</button>`
          : `<span class="d">${esc(owner)}</span>`) + `</li>`;
    }).join('');
  }

  $('#fia-list').addEventListener('click', e => {
    if (e.target.closest('button')) return;
    const li = e.target.closest('li[data-name]');
    const f = li && FIA_KNOWN.find(k => k.name === li.dataset.name);
    if (f) flyAndOpen(f.xz, () => fiaPopup(f));
  });
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-act="fia-add"], [data-act="fia-remove"]');
    if (!b || !state.me) return;
    map.closePopup();
    if (b.dataset.act === 'fia-add') { if (addFiaCache(b.dataset.name)) fiaMessage(`Marked ${b.dataset.name}.`, 'ok'); }
    else removeFiaCache(b.dataset.name);
  });

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------
  let results = [];
  function runSearch() {
    const q = norm($('#search').value.trim());
    const ul = $('#results');
    if (!q) { ul.classList.add('hidden'); results = []; return; }
    const dynamic = [];
    state.players.forEach(p => {
      if (!isMine(p.name) && !state.showOthers) return;
      p.items.forEach(it => {
        const name = it.label || typeLabel(it);
        dynamic.push({ name, sub: `${typeLabel(it)} · ${p.name}`, key: norm(`${name} ${p.name} ${it.note || ''}`), item: it, player: p });
      });
    });
    const all = searchIndex.concat(dynamic);
    results = all
      .map(r => ({ r, i: r.key.indexOf(q), s: norm(r.name).startsWith(q) ? 0 : 1 }))
      .filter(x => x.i >= 0)
      .sort((a, b) => a.s - b.s || a.r.name.localeCompare(b.r.name))
      .slice(0, 40).map(x => x.r);
    ul.innerHTML = results.length
      ? results.map((r, i) => `<li data-i="${i}"><span class="t">${esc(r.name)}</span><span class="d">${esc(r.sub)}</span></li>`).join('')
      : '<li><span class="d">No matches</span></li>';
    ul.classList.remove('hidden');
  }
  function openResult(r) {
    if (!r) return;
    if (r.item) return focusItem(r.player, r.item);
    flyAndOpen(r.xz, r.html);
  }
  $('#search').addEventListener('input', runSearch);
  $('#search').addEventListener('keydown', e => { if (e.key === 'Enter') openResult(results[0]); });
  $('#results').addEventListener('click', e => {
    const li = e.target.closest('li[data-i]');
    if (li) openResult(results[+li.dataset.i]);
  });

  // ---------------------------------------------------------------------------
  // Export / import
  // ---------------------------------------------------------------------------
  $('#export').addEventListener('click', () => {
    const me = state.players.get(state.me.name);
    const items = me ? [...me.items.values()] : [];
    if (!items.length) return toast('You have no markings to export yet.');
    const blob = new Blob([JSON.stringify({ app: 'everon-field-map', version: 1, exportedAt: new Date().toISOString(), items }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `everon-plan-${state.me.name.replace(/[^\w-]+/g, '_')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const items = PlanSync.read(await file.text());
      const result = await PlanSync.importItems(items, { uid, save: saveItem,
        existing: type => type === 'mortar' ? myMortar() : type === 'fia' ? myFia() : null });
      if (result.imported < result.total) {
        toast(`Import stopped: ${result.imported} of ${result.total} markings imported. The remaining markings were not saved.`, 8000);
      } else toast(`Imported ${result.imported} marking${result.imported === 1 ? '' : 's'}.`);
    } catch (err) {
      toast(err.message.startsWith('No') ? err.message : 'That file is not a valid plan.');
    }
  });

  // ---------------------------------------------------------------------------
  // Sidebar collapse
  // ---------------------------------------------------------------------------
  $('#collapse').addEventListener('click', () => {
    const sb = $('#sidebar');
    sb.classList.toggle('collapsed');
    $('#collapse').textContent = sb.classList.contains('collapsed') ? '⟩' : '⟨';
  });
  if (window.innerWidth < 720) { $('#sidebar').classList.add('collapsed'); $('#collapse').textContent = '⟩'; }

  // The mortar panel on the right: closed to a tab until you open it or pick the mortar tool; remembered in this browser.
  const MORTAR_PANEL_KEY = 'everon-map-mortar-panel';
  // There is nothing in it until you have a mortar or follow a team's, so the tab and panel stay hidden until then;
  // the first mortar you place or follow opens the panel.
  let mortarWanted = (() => { try { return localStorage.getItem(MORTAR_PANEL_KEY) === 'open'; } catch { return false; } })();
  let hadMortar = false;
  function syncMortarPanel() {
    const has = !!solutionMortar(), open = has && mortarWanted;
    $('#mortar-panel').classList.toggle('hidden', !open);
    $('#mortar-tab').classList.toggle('hidden', open || !has);
    $('#mortar-tab').setAttribute('aria-expanded', open);
  }
  function setMortarPanel(open) {
    mortarWanted = open;
    syncMortarPanel();
    try { localStorage.setItem(MORTAR_PANEL_KEY, open ? 'open' : 'closed'); } catch { /* storage unavailable */ }
  }
  $('#mortar-tab').addEventListener('click', () => setMortarPanel(true));
  $('#mortar-close').addEventListener('click', () => setMortarPanel(false));
  syncMortarPanel();

  // Squad pop-out (bottom right): players and the briefing, one tab at a time. Folds to a tab showing the player count
  // (and a dot when the briefing changed); open or closed and which tab are remembered in this browser.
  const SQUAD_KEY = 'everon-map-squad';
  const squad = (() => { try { return { open: false, tab: 'players', ...JSON.parse(localStorage.getItem(SQUAD_KEY) || '{}') }; } catch { return { open: false, tab: 'players' }; } })();
  const squadShowing = tab => squad.open && squad.tab === tab;
  function setSquad(open, tab = squad.tab) {
    squad.open = open; squad.tab = ['briefing', 'contacts'].includes(tab) ? tab : 'players';
    $('#squad-panel').classList.toggle('hidden', !open);
    $('#squad-tab').classList.toggle('hidden', open);
    $('#squad-tab').setAttribute('aria-expanded', open);
    document.querySelectorAll('.sq-tab').forEach(b => { const on = b.dataset.sq === squad.tab; b.classList.toggle('sel', on); b.setAttribute('aria-selected', on); });
    document.querySelectorAll('[data-sq-pane]').forEach(el => el.classList.toggle('hidden', el.dataset.sqPane !== squad.tab));
    if (squadShowing('briefing')) { $('#briefing-dot').classList.add('hidden'); $('#squad-tab-dot').classList.add('hidden'); }
    try { localStorage.setItem(SQUAD_KEY, JSON.stringify(squad)); } catch { /* storage unavailable */ }
  }
  $('#squad-tab').addEventListener('click', () => setSquad(true));
  $('#squad-close').addEventListener('click', () => setSquad(false));
  document.querySelectorAll('.sq-tab').forEach(b => b.addEventListener('click', () => setSquad(true, b.dataset.sq)));
  setSquad(squad.open, squad.tab);

  // Sidebar sections: one column, each opened and closed from its heading. Which are closed is remembered in this
  // browser (safe to lose); the FIA section starts closed.
  const SEC_KEY = 'everon-map-closed-sections';
  const SECTIONS = {
    markings: 'My markings', fia: 'FIA caches this game', layers: 'Map layers',
  };
  let closedSections;
  try { closedSections = new Set(JSON.parse(localStorage.getItem(SEC_KEY) || '["fia"]')); } catch { closedSections = new Set(['fia']); }
  const sectionEl = name => document.querySelector(`.acc[data-sec="${name}"]`);
  const sectionOpen = name => !closedSections.has(name);
  function setSection(name, open) {
    const el = sectionEl(name);
    open ? closedSections.delete(name) : closedSections.add(name);
    el.classList.toggle('closed', !open);
    el.querySelector('.acc-head').setAttribute('aria-expanded', open);
    try { localStorage.setItem(SEC_KEY, JSON.stringify([...closedSections])); } catch { /* storage unavailable */ }
  }
  function showSection(name, reveal = true) { // open a section and scroll to it (reveal: open the sidebar too)
    document.querySelector(`.inspector-tabs [data-inspector="${name}"]`)?.click();
    const sb = $('#sidebar');
    if (reveal && sb.classList.contains('collapsed')) $('#collapse').click();
    setSection(name, true);
    sectionEl(name).scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  $('#panels').addEventListener('click', e => {
    const h = e.target.closest('.acc-head');
    if (h) setSection(h.closest('.acc').dataset.sec, h.getAttribute('aria-expanded') !== 'true');
  });
  Object.keys(SECTIONS).forEach(name => setSection(name, sectionOpen(name)));

  // ---------------------------------------------------------------------------
  // Shared briefing: one text per room that anyone in it can edit
  // ---------------------------------------------------------------------------
  let briefing = null; // {text, by, at}
  const BRIEFING_TEMPLATE = [
    'SITUATION: ', 'MISSION: ', 'PLAN:', '  Phase 1 – ', '  Phase 2 – ', 'ROLES: ', 'RADIO: ', 'RALLY POINT: ',
    'IF CONTACT: ', 'FALLBACK: ',
  ].join('\n');
  const briefingOpen = () => !$('#briefing-form').classList.contains('hidden');

  // Text with "HEADING:" lines picked out
  const briefingHtml = text => esc(text).split('\n')
    .map(line => line.replace(/^([A-Z][A-Z &/]{1,24}:)/, '<b>$1</b>')).join('\n'); // shown with white-space: pre-wrap

  function renderBriefing() {
    const b = briefing, has = !!(b && b.text.trim());
    $('#briefing-text').innerHTML = has ? briefingHtml(b.text)
      : '<div class="empty">No briefing yet.</div>';
    $('#briefing-meta').textContent = has ? `Updated by ${b.by}${isMine(b.by) ? ' (you)' : ''}, ${fmtAgo(Date.now() - b.at)}` : '';
    $('#briefing-edit').textContent = has ? 'Edit briefing' : 'Write a briefing';
  }
  function setBriefing(b, live) {
    briefing = b;
    renderBriefing();
    if (!live || !b || isMine(b.by)) return;
    if (briefingOpen()) {
      const clash = $('#briefing-clash');
      clash.textContent = `${b.by} changed the briefing while you were editing. Saving will replace their version.`;
      clash.classList.remove('hidden');
    }
    if (!squadShowing('briefing')) { $('#briefing-dot').classList.remove('hidden'); $('#squad-tab-dot').classList.remove('hidden'); }
    toast(`${b.by} updated the briefing`);
  }
  function editBriefing() {
    setSquad(true, 'briefing');
    $('#briefing-input').value = briefing ? briefing.text : '';
    $('#briefing-clash').classList.add('hidden');
    $('#briefing-view').classList.add('hidden');
    $('#briefing-form').classList.remove('hidden');
    $('#briefing-input').focus();
  }
  function closeBriefingEditor() {
    $('#briefing-form').classList.add('hidden');
    $('#briefing-view').classList.remove('hidden');
  }
  $('#briefing-edit').addEventListener('click', editBriefing);
  $('#briefing-cancel').addEventListener('click', closeBriefingEditor);
  $('#briefing-template').addEventListener('click', () => {
    const ta = $('#briefing-input');
    ta.value = ta.value.trim() ? `${ta.value.replace(/\s+$/, '')}\n\n${BRIEFING_TEMPLATE}` : BRIEFING_TEMPLATE;
    ta.focus();
  });
  $('#briefing-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('/api/briefing', { id: state.me.id, token: state.me.token, text: $('#briefing-input').value.replace(/\s+$/, '') });
      closeBriefingEditor();
    } catch (err) { toast(err.message); }
  });
  $('#briefing-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#briefing-form').requestSubmit(); }
    if (e.key === 'Escape') { e.stopPropagation(); closeBriefingEditor(); }
  });
  setInterval(() => { if (!briefingOpen()) renderBriefing(); }, 30000); // keep "x min ago" current
  renderBriefing();

  // ---------------------------------------------------------------------------
  // Game clock: one per room. Whoever reads the watch in game sets the time; everyone's page then keeps it running
  // (at the speed picked) and works out the sun and moon for it (static/sky.js). The server stamps the moment it was
  // set, so players' own clocks don't matter.
  // ---------------------------------------------------------------------------
  const CLOCK_RATES = [[0, 'Paused'], [1, '1×'], [2, '2×'], [3, '3×'], [4, '4×'], [6, '6×'], [8, '8×'], [12, '12×'], [24, '24×'], [48, '48×']];
  const CLOCK_DEFAULT = { year: 2035, month: 6, day: 21, lat: 49, rate: 1 };
  let clock = null, clockSkew = 0; // the room's clock {game, rate, year, month, day, lat, at, by}; server time minus ours
  $('#clock-rate').innerHTML = CLOCK_RATES.map(([v, n]) => `<option value="${v}">${n}</option>`).join('');
  // Game seconds since midnight of the clock's date at real time ms (default: now); null until a time is set.
  const gameAt = (ms = Date.now()) => clock ? clock.game + (ms + clockSkew - clock.at) / 1000 * clock.rate : null;
  const fmtGame = (S, secs = false) => {
    const t = Math.floor(((S % 86400) + 86400) % 86400), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60);
    return `${pad(h, 2)}:${pad(m, 2)}${secs ? ':' + pad(t % 60, 2) : ''}`;
  };
  const fmtSpan = s => { // a stretch of real time
    s = Math.max(0, Math.round(s));
    return s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round(s % 3600 / 60)} min` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`;
  };
  function setClock(c, serverNow) {
    clock = c || null;
    if (c && serverNow) clockSkew = serverNow - Date.now();
    if (!$('#clock-form').contains(document.activeElement)) clockFill(); // Map settings shows the room's clock
    renderClock();
  }
  function clockFill() { // the form starts from what the clock shows
    const c = clock || { ...CLOCK_DEFAULT, game: 0 };
    $('#clock-rate').value = String(c.rate);
    $('#clock-year').value = c.year; $('#clock-month').value = c.month; $('#clock-day').value = c.day; $('#clock-lat').value = c.lat;
    $('#clock-in').value = clock ? fmtGame(gameAt()) : '';
  }
  function renderClock() {
    const tab = $('#clock-tab'), glyph = $('#clock-glyph');
    if (!clock) {
      $('#clock-time').textContent = 'Set time';
      $('#clock-sky').textContent = '';
      glyph.className = 'clock-glyph none';
      $('#clock-read').innerHTML = '<p class="sub">Enter your in-game watch time to track the sun and moon.</p>';
      settingsSummary();
      return;
    }
    const S = gameAt(), b = Sky.bodies(S, clock), lt = Sky.light(b);
    $('#clock-time').textContent = fmtGame(S);
    $('#clock-sky').textContent = clock.rate === 0 ? 'paused' : clock.rate > 1 ? `${clock.rate}×` : '';
    glyph.className = `clock-glyph l${lt.level}`;
    tab.title = `${lt.name}. Game time, sun and moon`;
    settingsSummary();
    if (!$('#map-settings').open) return;
    const ev = Sky.events(S, clock, 26), rate = clock.rate;
    const next = name => ev.find(e => e.name === name);
    const when = e => e ? `${fmtGame(e.t)}${rate ? ` <span class="sub">in ${fmtSpan((e.t - S) / rate)}</span>` : ''}` : '—';
    const sun = next(b.sun.el > -0.833 ? 'Sunset' : 'Sunrise'), edge = next(b.sun.el > -6 ? 'Last light' : 'First light');
    // A 24 h bar from the last midnight to the next, shaded by how light the sun makes it, with the moon's time above
    // the horizon along the bottom and a white line for now.
    const day0 = Math.floor(S / 86400) * 86400, cols = [];
    for (let i = 0; i < 96; i++) {
      const l = Sky.light(Sky.bodies(day0 + (i + 0.5) * 900, clock)).level;
      cols.push(`<i style="left:${i / 96 * 100}%;width:${100 / 96 + 0.2}%;background:${['#0b1020', '#1a2140', '#2b3a75', '#c2588a', '#f0a04b', '#ffe066'][l]}"></i>`);
      if (Sky.bodies(day0 + (i + 0.5) * 900, clock).moon.el > 0) cols.push(`<i class="moonbar" style="left:${i / 96 * 100}%;width:${100 / 96 + 0.2}%"></i>`);
    }
    $('#clock-read').innerHTML = `<div class="clock-big"><b>${fmtGame(S, true)}</b><span>${clock.year}-${pad(clock.month, 2)}-${pad(clock.day, 2)}${Math.floor(S / 86400) ? ` +${Math.floor(S / 86400)} d` : ''}</span></div>` +
      `<div class="clock-light">${lt.name}</div>` +
      `<div class="clock-bar">${cols.join('')}<i class="now" style="left:${(S - day0) / 864}%"></i></div>` +
      '<div class="clock-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>' +
      '<dl class="clock-rows">' +
      `<dt>Sun</dt><dd>${b.sun.el >= 0 ? `${Math.round(b.sun.el)}° up, ${pad(Math.round(b.sun.az) % 360, 3)}° ${compass(b.sun.az)}` : 'below the horizon'}</dd>` +
      `<dt>${b.sun.el > -0.833 ? 'Sunset' : 'Sunrise'}</dt><dd>${when(sun)}</dd>` +
      `<dt>${b.sun.el > -6 ? 'Last light' : 'First light'}</dt><dd>${when(edge)}</dd>` +
      `<dt>Moon</dt><dd>${b.moon.phase}, ${Math.round(b.moon.illum * 100)}%</dd>` +
      `<dt>Moon ${b.moon.el > -0.5 ? 'up' : 'down'}</dt><dd>${b.moon.el > -0.5 ? `${Math.round(b.moon.el)}° ${compass(b.moon.az)}, sets ${when(next('Moonset'))}` : `rises ${when(next('Moonrise'))}`}</dd>` +
      '</dl>';
  }
  // The time is set in Map settings (the sidebar dropdown); the clock on the map is its readout and opens it.
  function setClockPanel(open) {
    if (!open) { $('#map-settings').open = false; return; }
    openSettings();
    $('#clock-set').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (!clock) $('#clock-in').focus();
  }
  $('#clock-tab').addEventListener('click', () => setClockPanel(true));
  $('#clock-form').addEventListener('focusin', () => { if (!$('#clock-in').value) clockFill(); });
  $('#clock-form').addEventListener('submit', async e => {
    e.preventDefault();
    const m = /^(\d{1,2})[:.]?(\d{2})$/.exec($('#clock-in').value.trim());
    if (!m || +m[1] > 23 || +m[2] > 59) return toast('Type the time as hours and minutes, like 06:42.');
    const c = { game: +m[1] * 3600 + +m[2] * 60, rate: +$('#clock-rate').value, year: +$('#clock-year').value, month: +$('#clock-month').value,
      day: +$('#clock-day').value, lat: +$('#clock-lat').value };
    if (!(c.year >= 1900 && c.year <= 2200 && c.month >= 1 && c.month <= 12 && c.day >= 1 && c.day <= 31 && c.lat >= -66 && c.lat <= 66)) return toast('Check the date and latitude.');
    try { await api('/api/clock', { id: state.me.id, token: state.me.token, clock: c }); } catch (err) { toast(err.message); }
  });
  setInterval(renderClock, 1000);
  renderClock();

  // ---------------------------------------------------------------------------
  // Map settings: the sidebar dropdown with the base map, line of sight, wind, game time and the 3D view. Its summary
  // line shows the game time and wind while it is folded away. Open or shut is remembered in this browser.
  // ---------------------------------------------------------------------------
  const SETTINGS_OPEN_KEY = 'everon-map-settings-open';
  function settingsSummary() {
    const w = state.wind, parts = [];
    if (clock) parts.push($('#clock-time').textContent);
    if (w) parts.push(`${w.s} m/s from ${pad(Math.round(w.d) % 360, 3)}°`);
    $('#settings-sum').textContent = parts.join(' · ');
  }
  function openSettings() {
    if ($('#sidebar').classList.contains('collapsed')) $('#collapse').click();
    $('#map-settings').open = true;
  }
  $('#map-settings').addEventListener('toggle', () => {
    const open = $('#map-settings').open;
    if (open) { if (!$('#clock-form').contains(document.activeElement)) clockFill(); renderClock(); }
    try { localStorage.setItem(SETTINGS_OPEN_KEY, open ? '1' : '0'); } catch { /* storage unavailable */ }
  });
  try { if (localStorage.getItem(SETTINGS_OPEN_KEY) === '1') $('#map-settings').open = true; } catch { /* storage unavailable */ }

  // The room's wind, as the in-game map shows it (m/s, direction it comes from): one per room, like the game clock, so
  // the map, the mortar page and the shot planner all show the same (server /api/wind, the 'wind' event). Setting it
  // here sends it to the room; it comes back to everyone (this page too) and sets your mortar's wind (saved on the
  // mortar, so its solutions stay shared) and the wind new shot calculations start with. Winds entered on a mortar or a
  // shot itself stay theirs. Before joining a room it is this page's alone (nothing is kept in the browser).
  const cleanWind = w => (w && +w.s > 0 ? { s: Math.min(+w.s, 40), d: ((Math.round(+w.d || 0) % 360) + 360) % 360 } : null);
  state.wind = null;
  try { localStorage.removeItem('everon-map-wind'); } catch { /* storage unavailable */ } // (an earlier version kept it)
  function showWind() {
    const w = state.wind;
    if (!$('.ms-wind').contains(document.activeElement)) { $('#wind-s').value = w ? w.s : 0; $('#wind-d').value = w ? w.d : 0; }
    $('#wind-g').setAttribute('transform', `rotate(${w ? w.d : 0})`);
    $('#wind-g').style.opacity = w ? 1 : 0.3;
    settingsSummary();
  }
  // the wind in effect here: from the room, or set on this page before joining one
  function setWind(w) {
    const next = cleanWind(w), same = JSON.stringify(next) === JSON.stringify(state.wind);
    state.wind = next;
    state.rkWind = state.wind;
    $('#mortar-wind-s').value = state.wind ? state.wind.s : 0;
    $('#mortar-wind-d').value = state.wind ? state.wind.d : 0;
    const m = myMortar(), mw = m && m.wind && m.wind.s > 0 ? { s: m.wind.s, d: m.wind.d } : null;
    if (!same || JSON.stringify(mw) !== JSON.stringify(state.wind)) onWindChange(); // saves it on your mortar, if you have one
    showWind();
  }
  // the room's wind arrived or changed (snapshot or 'wind' event)
  function setRoomWind(w, by) {
    setWind(w ? { s: w.s, d: w.d } : null);
    if (by && !isMine(by)) toast(`${by} set the wind to ${w && w.s > 0 ? `${w.s} m/s from ${pad(Math.round(w.d) % 360, 3)}°` : 'still air'}`);
  }
  async function readSharedWind() {
    const w = { s: Math.min(Math.max(+$('#wind-s').value || 0, 0), 40), d: ((Math.round(+$('#wind-d').value || 0) % 360) + 360) % 360 };
    if (!state.me) return setWind(w);
    try { await api('/api/wind', { id: state.me.id, token: state.me.token, wind: w }); } // comes back as the 'wind' event
    catch (err) { toast(err.message); showWind(); }
  }
  $('#wind-s').addEventListener('change', readSharedWind);
  $('#wind-d').addEventListener('change', readSharedWind);
  showWind();

  // ---------------------------------------------------------------------------
  // Room codes
  // ---------------------------------------------------------------------------
  const ROOM_WORDS = ['viper', 'hawk', 'wolf', 'fox', 'raven', 'cobra', 'bravo', 'delta', 'ghost', 'iron', 'stone', 'storm'];
  // The room code is all that keeps a room private, so it's random enough (12 million codes) that guessing is hopeless.
  const newRoomCode = () => {
    const r = crypto.getRandomValues(new Uint32Array(2));
    return `${ROOM_WORDS[r[0] % ROOM_WORDS.length]}-${String(r[1] % 1e6).padStart(6, '0')}`;
  };
  const roomFromHash = () => { const m = /[#&]room=([^&]+)/.exec(location.hash); return m ? decodeURIComponent(m[1]) : ''; };
  $('#join-room').value = roomFromHash();
  $('#join-room').addEventListener('input', e => { e.target.value = e.target.value.toLowerCase().replace(/\s+/g, '-'); });
  $('#join-new-room').addEventListener('click', () => { $('#join-room').value = newRoomCode(); $('#join-name').focus(); });
  $('#room-copy').addEventListener('click', async () => {
    const link = `${location.origin}${location.pathname}#room=${encodeURIComponent(state.me.room)}`;
    try { await navigator.clipboard.writeText(link); toast('Invite link copied. Send it to your squad.'); }
    catch { toast(link, 8000); }
  });
  // Keep plan: the server keeps this room (markings, briefing, game time) after everyone has left, saved on disk for
  // 24 hours without a visit, so the squad can plan one day and play another. Rejoin under the same name to get your
  // own markings back. Anyone in the room can switch it on or off.
  function setKeep(on) {
    state.keep = on;
    const b = $('#room-keep');
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('on', on);
    b.textContent = on ? 'Kept' : 'Keep';
    b.title = on ? 'This room keeps its plan after everyone leaves (until 24 hours pass with nobody in it). Click to stop keeping it.'
      : 'Keep this room\'s markings, briefing and game time after everyone leaves, so you can plan today and play another day';
  }
  $('#room-keep').addEventListener('click', async () => {
    const on = !state.keep;
    if (!on && !confirm('Stop keeping this room? Markings of players who have left go straight away, and the room ends when the last player leaves.')) return;
    try {
      await api('/api/keep', { id: state.me.id, token: state.me.token, keep: on });
      toast(on ? 'This room now keeps its plan. Come back with the same room code and name to pick it up again.' : 'This room no longer keeps its plan.', 7000);
    } catch (e) { toast(e.message); }
  });
  // The 3D view (static/3d/, served at /3d/ by the same server; its button is in Map settings): this map,
  // joined to this room under your name (after the #, so neither reaches the server's logs). It shows the room's
  // markings; drawing stays here.
  const open3d = () => {
    if (!state.me) return;
    const hash = `room=${encodeURIComponent(state.me.room)}&name=${encodeURIComponent(state.me.name)}`;
    window.open(`/3d/?map=${encodeURIComponent(MAP.id)}#${hash}`, '_blank', 'noopener');
  };
  $('#open-3d').addEventListener('click', open3d);
  // The mortar page (static/mortar.html): this tab, in the same room. The session is already kept in sessionStorage and
  // your markings in the 5-minute copy (below), so the page joins by itself and the map gets them back on return.
  $('#open-mortar').addEventListener('click', () => {
    location.href = '/mortar.html' + (state.me ? `#room=${encodeURIComponent(state.me.room)}&name=${encodeURIComponent(state.me.name)}` : '');
  });
  // The shot planner (static/shot.html): the same, for the shot calculator
  $('#open-shot').addEventListener('click', () => {
    location.href = '/shot.html' + (state.me ? `#room=${encodeURIComponent(state.me.room)}&name=${encodeURIComponent(state.me.name)}` : '');
  });
  // The base design page (static/base.html): the same, for laying out a base's defences (its button is off for now)
  $('#open-base')?.addEventListener('click', () => {
    location.href = '/base.html' + (state.me ? `#room=${encodeURIComponent(state.me.room)}&name=${encodeURIComponent(state.me.name)}` : '');
  });

  // ---------------------------------------------------------------------------
  // Tool finder (Ctrl+K): every tool, layer switch and sidebar action, searchable by name
  // ---------------------------------------------------------------------------
  let paletteItems = [], paletteSel = 0;
  function paletteEntries() {
    const out = [];
    out.push({ name: 'Select', sub: 'Tool', key: 'Q', icon: $('#toolbar [data-tool="pan"] svg').outerHTML, run: () => setTool('pan') });
    Object.values(TOOL).forEach(t => out.push({ name: t.name, sub: `${t.group.name} menu`, key: toolKeys(t.tool), icon: t.icon, run: () => setTool(t.tool) }));
    Object.entries(SECTIONS).forEach(([sec, name]) => out.push({ name, sub: 'Sidebar section', run: () => showSection(sec) }));
    [['players', 'Players'], ['contacts', 'Contacts'], ['briefing', 'Briefing']].forEach(([tab, name]) => out.push({ name, sub: 'Squad panel', run: () => setSquad(true, tab) }));
    const toggle = (cb, name, sub) => out.push({ name: `${cb.checked ? 'Hide' : 'Show'} ${name}`, sub,
      run: () => { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); } });
    document.querySelectorAll('#panels .layer').forEach(row => toggle(row.querySelector('input'), row.querySelector('.lbl').textContent.toLowerCase(), 'Map layer'));
    toggle($('#show-grid'), 'grid lines', 'Map layer');
    toggle($('#show-others'), "other players' markings", 'Players');
    out.push(
      { name: 'Set the game time', sub: 'Clock, sun and moon', run: () => setClockPanel(true) },
      { name: briefing && briefing.text.trim() ? 'Edit the briefing' : 'Write a briefing', sub: 'Briefing', run: editBriefing },
      { name: 'Copy invite link', sub: `Room ${state.me.room}`, run: () => $('#room-copy').click() },
      { name: 'Open in 3D', sub: `${MAP.name}, room ${state.me.room}`, run: open3d },
      { name: 'Search places, bases and markings', sub: 'Sidebar', run: () => { $('#sidebar').classList.remove('collapsed'); $('#search').focus(); } },
      { name: 'Export plan', sub: 'My markings', run: () => $('#export').click() },
      { name: 'Import plan', sub: 'My markings', run: () => $('#import').click() },
    );
    return out;
  }
  function renderPalette() {
    const q = norm($('#palette-input').value.trim());
    const all = paletteEntries();
    paletteItems = !q ? all : all
      .map(e => ({ e, i: norm(`${e.name} ${e.sub}`).indexOf(q), s: norm(e.name).startsWith(q) ? 0 : norm(e.name).split(/\s+/).some(w => w.startsWith(q)) ? 1 : 2 }))
      .filter(x => x.i >= 0).sort((a, b) => a.s - b.s).map(x => x.e);
    paletteSel = Math.min(paletteSel, Math.max(0, paletteItems.length - 1));
    $('#palette-list').innerHTML = paletteItems.length ? paletteItems.map((e, i) =>
      `<li role="option" data-i="${i}" class="${i === paletteSel ? 'sel' : ''}" aria-selected="${i === paletteSel}">` +
      `<span class="pi">${e.icon || ''}</span><span class="pn">${esc(e.name)}</span><span class="ps">${esc(e.sub)}</span>` +
      `${e.key ? `<kbd>${esc(e.key)}</kbd>` : ''}</li>`).join('')
      : '<li class="none">Nothing matches</li>';
    $('#palette-list .sel')?.scrollIntoView({ block: 'nearest' });
  }
  const paletteOpen = () => !$('#palette').classList.contains('hidden');
  function openPalette() {
    if (!state.me) return;
    closeMenus();
    paletteSel = 0;
    $('#palette-input').value = '';
    $('#palette').classList.remove('hidden');
    renderPalette();
    $('#palette-input').focus();
  }
  function closePalette() {
    $('#palette').classList.add('hidden');
    document.activeElement?.blur();
  }
  function runPalette(i) {
    const e = paletteItems[i];
    if (!e) return;
    closePalette();
    e.run();
  }
  $('#palette-open').addEventListener('click', openPalette);
  $('#palette-input').addEventListener('input', () => { paletteSel = 0; renderPalette(); });
  $('#palette-input').addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = paletteItems.length;
      if (n) paletteSel = (paletteSel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      renderPalette();
    } else if (e.key === 'Enter') { e.preventDefault(); runPalette(paletteSel); }
    else if (e.key === 'Escape') { e.stopPropagation(); closePalette(); }
  });
  $('#palette-list').addEventListener('click', e => { const li = e.target.closest('li[data-i]'); if (li) runPalette(+li.dataset.i); });
  $('#palette').addEventListener('mousedown', e => { if (e.target.id === 'palette') closePalette(); });
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      paletteOpen() ? closePalette() : openPalette();
    }
  });

  // ---------------------------------------------------------------------------
  // Session: username prompt every visit. Only this tab remembers who you were (sessionStorage), so a reload puts you
  // straight back in the room; closing the tab forgets it.
  // ---------------------------------------------------------------------------
  const SESSION_KEY = 'everon-session';
  function showJoin(message) {
    if (state.es) { state.es.close(); state.es = null; }
    state.me = null;
    state.loadedSession = null;
    state.restore = null;
    state.restoring = false;
    [...state.players.keys()].forEach(removePlayer);
    refreshLists();
    $('#identity').classList.add('hidden');
    closeBriefingEditor();
    $('#join-error').textContent = message || '';
    $('#join').classList.remove('hidden');
    setTimeout(() => $('#join-name').focus(), 0);
  }

  async function joinRoom(name, room, mapId) {
    if (!DEFAULT_MAP) await loadMaps();
    const me = await api('/api/join', { name, room, map: mapId });
    state.me = me;
    state.loadedSession = null;
    state.restoring = true; // nothing loaded yet: don't let a leave overwrite the kept copy
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ name: me.name, room: me.room, map: me.map })); } catch { /* storage unavailable */ }
    // The room code goes in the address (after #, so it never reaches the server's logs): a reload or an
    // invite link fills it in again.
    history.replaceState(null, '', `#room=${encodeURIComponent(me.room)}`);
    // the room's map, which may not be the one picked (a room that's already open keeps its own)
    if (!startMap(me.map)) return;
    // Markings this browser kept from your last visit to this room go back up once the room has loaded.
    state.restore = keptMine(me);
    planBackup.begin(me, state.restore || []);
    state.restoring = !!state.restore;
    $('#join-map').value = MAP.id;
    $('#room-map').textContent = MAP.name;
    $('#me-avatar').style.background = me.color;
    $('#me-avatar').textContent = [...me.name][0].toUpperCase();
    $('#me-name').textContent = me.name;
    $('#room-code').textContent = me.room;
    $('#identity').classList.remove('hidden');
    $('#join').classList.add('hidden');
    document.activeElement?.blur(); // so tool hotkeys work straight away
    connect();
  }

  async function submitJoin(retries = 0) {
    const btn = $('#join-form').querySelector('button[type=submit], button:not([type])');
    if (btn) btn.disabled = true;
    $('#join-error').textContent = '';
    try {
      await joinRoom($('#join-name').value, $('#join-room').value, $('#join-map').value);
    } catch (err) {
      // After a reload the old session may not have left yet; give it a moment.
      if (err.status === 409 && retries > 0) { setTimeout(() => submitJoin(retries - 1), 1500); return; }
      $('#join-error').textContent = err.message === 'Failed to fetch' ? 'Cannot reach the map server. Is it running?' : err.message;
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  $('#join-form').addEventListener('submit', e => { e.preventDefault(); submitJoin(); });

  // The server forgot this session (it restarted, or the connection was gone too long, e.g. a phone that slept):
  // join the same room again under the same name, and your kept markings go back up.
  async function rejoin(old, attempts = 10) {
    try {
      await joinRoom(old.name, old.room, old.map);
      toast('Reconnected to the room.');
    } catch (err) {
      if (err.status === 409 && attempts > 1) { setTimeout(() => { if (state.me === old) rejoin(old, attempts - 1); }, 1500); return; }
      $('#join-name').value = old.name;
      $('#join-room').value = old.room;
      showJoin(err.message === 'Failed to fetch' ? 'Lost connection to the map server. Press Join to try again.' : err.message);
    }
  }

  function connect() {
    const { id, token } = state.me;
    const es = new RoomEvents('/api/events', { id, token });
    state.es = es;
    es.onmessage = m => { try { onEvent(JSON.parse(m.data)); } catch (err) { console.error(err); } };
    es.addEventListener('bye', m => {
      if (left) return; // our own leave on the way out, not a removal
      let reason = '';
      try { reason = JSON.parse(m.data).reason || ''; } catch { /* older server */ }
      // Removed by the admin: don't bring this room's markings back next time.
      if (state.me) forgetMine(state.me);
      try { sessionStorage.removeItem(SESSION_KEY); } catch { /* storage unavailable */ }
      showJoin(reason || 'Your session ended. Enter a username to rejoin.');
    });
    es.onerror = () => {
      if (es.readyState !== RoomEvents.CLOSED || state.es !== es) return;
      const old = state.me;
      es.close();
      state.es = null;
      if (old) rejoin(old);
      else showJoin('Lost connection to the map server. Enter a username to rejoin.');
    };
  }

  // ---------------------------------------------------------------------------
  // Kept markings: this browser keeps a copy of your own markings per map, room and name (localStorage, nothing on the
  // server), so a reload, a crash, a tab the phone put to sleep or a server restart doesn't lose them. Rejoining the
  // room puts them back. A copy last touched more than KEEP_MINUTES ago is dropped; while you're in the room it is
  // touched every minute, so the time counts from when you left or lost the connection.
  // ---------------------------------------------------------------------------
  const KEEP_PREFIX = 'everon-kept:';
  const planBackup = PlanSync.backup();
  const KEEP_MINUTES = 5;
  // the name too, so two players sharing a browser (two tabs) never get each other's markings
  const keepKey = me => `${KEEP_PREFIX}${me.map}:${me.room}:${me.name.toLowerCase()}`;
  let keepTimer = null;
  function writeKept() {
    clearTimeout(keepTimer);
    keepTimer = null;
    const me = state.me;
    if (!me) return; // pending restores and submitted items are retained by planBackup
    const mine = state.loadedSession === me && state.players.get(me.name);
    const items = planBackup.items(me, mine ? [...mine.items.values()] : []);
    try {
      if (items.length) localStorage.setItem(keepKey(me), JSON.stringify({ at: Date.now(), items }));
      else localStorage.removeItem(keepKey(me));
    } catch { /* storage unavailable or full */ }
  }
  setInterval(writeKept, 60e3);
  function keepMine() {
    if (!keepTimer) keepTimer = setTimeout(writeKept, 500);
  }
  function keptMine(me) {
    try {
      const kept = JSON.parse(localStorage.getItem(keepKey(me)) || 'null');
      if (kept && Array.isArray(kept.items) && kept.items.length && Date.now() - kept.at < KEEP_MINUTES * 60e3) return kept.items;
    } catch { /* storage unavailable or damaged */ }
    return null;
  }
  function forgetMine(me) {
    clearTimeout(keepTimer);
    keepTimer = null;
    try { localStorage.removeItem(keepKey(me)); } catch { /* storage unavailable */ }
  }
  // Old copies (other rooms, other days) go at startup so they don't fill the browser's storage.
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(KEEP_PREFIX)) continue;
      let at = 0;
      try { at = JSON.parse(localStorage.getItem(k)).at || 0; } catch { /* damaged: drop it */ }
      if (Date.now() - at >= KEEP_MINUTES * 60e3) localStorage.removeItem(k);
    }
  } catch { /* storage unavailable */ }

  // Upload the kept markings the server doesn't have, one at a time (waiting out the rate limit if there are many).
  async function restoreMine(items) {
    const me = state.me;
    const result = await PlanSync.restore(items, {
      current: () => state.players.get(me.name)?.items || new Map(), active: () => state.me === me,
      deleted: id => planBackup.deleted(me, id),
      remove: itemId => itemWrites(me, itemId, () => api('/api/delete', { id: me.id, token: me.token, itemId })),
      upload: item => itemWrites(me, item.id, () => api('/api/item', { id: me.id, token: me.token, item })),
    });
    if (result.cancelled || state.me !== me) return;
    state.restoring = false;
    writeKept();
    if (result.failed || result.expired) toast('Some markings could not be restored. Their browser backup is kept; rejoin to retry.', 8000);
    else if (result.uploaded) toast(`Put back ${result.uploaded} of your marking${result.uploaded === 1 ? '' : 's'}.`);
  }

  // Closing the tab removes your markings from the room right away (this browser keeps its copy); if this signal is
  // lost the server drops you after 15 s.
  let left = false;
  function leave() {
    if (!state.me || left) return;
    left = true;
    writeKept();
    if (state.es) { state.es.close(); state.es = null; } // the server's goodbye must not reach the page now
    const body = JSON.stringify({ id: state.me.id, token: state.me.token });
    if (!navigator.sendBeacon('/api/leave', body)) {
      fetch('/api/leave', { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'application/json' } }).catch(() => {});
    }
  }
  window.addEventListener('pagehide', leave);
  window.addEventListener('beforeunload', leave);
  window.addEventListener('pageshow', e => {
    if (!e.persisted) return;
    const me = state.me;
    left = false;
    if (me) rejoin(me);
  });

  // ---------------------------------------------------------------------------
  // Roads: the game's own road network (reforger-map-tools, rmtlib/bake_roads.py). {nodes: [[x, z]], edges: [[a, b, kind, pts]]}
  // with kind 0 main road, 1 street, 2 dirt road, 3 foot path. Roads and foot paths are separate layers; the vehicle
  // route planner runs on all of it.
  // ---------------------------------------------------------------------------
  const ROAD_STYLE = [{ color: '#ffd43b', weight: 5 }, { color: '#fff3bf', weight: 3.5 }, { color: '#d9a066', weight: 3 }, { color: '#e9ecef', weight: 2, dash: '5 4' }];
  let ROADS = null;
  function loadRoads() {
    fetch(`${MAP.dir}/roads.json`).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }).then(d => {
      ROADS = d;
      // dark casing first so every kind reads on top of any map, then the colours, main roads last (on top)
      const line = (e, w, color, dash) => L.polyline(e[3].map(toLL), { color, weight: w, opacity: 0.95, lineCap: 'round', lineJoin: 'round', dashArray: dash, interactive: false });
      const layerOf = k => (k === 3 ? refLayers.paths : refLayers.roads);
      d.edges.forEach(e => layerOf(e[2]).addLayer(line(e, ROAD_STYLE[e[2]].weight + 2, '#11171c')));
      [3, 2, 1, 0].forEach(k => d.edges.forEach(e => { if (e[2] === k) layerOf(k).addLayer(line(e, ROAD_STYLE[k].weight, ROAD_STYLE[k].color, ROAD_STYLE[k].dash)); }));
    }).catch(err => console.error('roads', err));
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  // The reference layers (Conflict bases, caches, supplies) exist for Everon only so far; another map starts from this
  // empty set, and buildReference leaves out the layers that stay empty. Towns, landmarks and fuel stations come from
  // every map's places.json.
  const emptyReference = () => ({ towns: [], landmarks: [], caves: [], conflict: [], mob: [], supplies: [], vehicles: [], refuel: [], repair: [], fia: [], fuelStations: [] });
  // Everything that depends on the room's map, loaded once it is known (after joining). A page only ever shows one map:
  // joining a room on another map afterwards reloads it. Returns false when it does.
  let startedMap = null;
  function startMap(id) {
    const def = MAPS[id] || MAPS[DEFAULT_MAP];
    if (startedMap) {
      if (startedMap === def.id) return true;
      toast(`Switching to ${def.name}…`);
      setTimeout(() => location.reload(), 300);
      return false;
    }
    startedMap = def.id;
    if (MAP !== def || !tileLayer) { MAP = def; showMapBase(); }
    state.losMode = savedLosMode();
    renderLosDetail();
    // Town and landmark names come from the game's map descriptors (places.json); a map with a reference file of its own
    // (Everon's bases, caves, supplies...) adds everything else from it.
    Promise.all([
      def.poi ? fetch(def.poi).then(r => r.json()) : Promise.resolve({}),
      fetch(`${def.dir}/places.json`).then(r => r.json()).catch(() => null),
    ]).then(([ref, places]) => ({ ...emptyReference(), ...ref, towns: places?.towns || [], landmarks: places?.landmarks || [],
      // a station drawn with one symbol per pump shows once
      fuelStations: (places?.pois || []).filter(p => p.type === 'Fuel station')
        .filter((p, i, all) => !all.slice(0, i).some(q => q.type === p.type && dist(q.xz, p.xz) < 50)) }))
      .then(d => { buildReference(d); refreshFia(); loadRoads(); })
      .catch(err => { console.error(err); toast('Could not load reference data.', 6000); });
    // the line-of-sight index says how big the 10 m grids are, so it comes first
    loadDetailIndex().then(ix => {
      if (ix && ix.light) HN = ix.light.cols;
      loadLight(def);
    });
    return true;
  }
  // Mortars, MG nests and the terrain checks depend on the tables, heightmap and trees, so redraw them once those load.
  const rerenderMortars = () => state.players.forEach(p => p.items.forEach(it => {
    if (['mortar', 'emplacement', 'overwatch', 'hulldown', 'route', 'aa'].includes(it.type) || isMarker(it, 'lz') || (it.type === 'range' && it.rocket)) renderItem(p, it);
  }));
  fetch('data/mortar-tables.json')
    .then(r => r.json())
    .then(t => { TABLES = t; fillMortarSelects(); rerenderMortars(); refreshLists(); updateHint(); })
    .catch(err => { console.error(err); toast('Could not load mortar firing tables.', 6000); });
  // Map data is cached by browsers for a week: the 10 m files carry los/index.json's version (new on every bake), and
  // DATA_V only until that index has loaded.
  const DATA_V = 4;
  // The 10 m data files are gzipped (about a seventh of the download) and unpacked here.
  // name: height, forest, canopy, buildings, lz (every map), foliage, clutter (Everon's own files only).
  function lightBin(name) {
    const url = `${MAP.dir}/light/${name}.bin.gz?v=${detailV || DATA_V}`;
    return fetch(url).then(r => {
      if (!r.ok) throw new Error(`${name}: ${r.status}`);
      return new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    });
  }
  function loadLight(def) {
    // Trees and buildings: line of sight worked out before they arrived is redone with them.
    Promise.all(['forest', 'canopy', 'buildings', 'foliage', 'clutter'].map(lightBin))
      .then(([forest, canopy, buildings, foliage, clutter]) => {
        FOREST = new Uint8Array(forest); CANOPY = new Uint8Array(canopy); BUILDINGS = new Uint8Array(buildings);
        if (foliage) {
          const nn = HN * HN, f = new Uint8Array(foliage), c = new Uint8Array(clutter), fm = new Uint8Array(nn), cm = new Uint8Array(nn);
          for (let i = 0; i < f.length; i++) { const k = i % nn; if (f[i] > fm[k]) fm[k] = f[i]; if (c[i] > cm[k]) cm[k] = c[i]; }
          FOLIAGE = f; CLUTTER = c; FOLIAGE_MAX = fm; CLUTTER_MAX = cm;
        }
        forestLayer.redraw();
        lzCache.clear();
        losCache.clear();
        state.players.forEach(p => p.items.forEach(it => renderItem(p, it)));
        refreshCoverage(true);
        refreshThreats(true);
      })
      .catch(err => { console.error('Trees and buildings not loaded', err); toast('Could not load trees and buildings - line of sight uses the bare terrain.', 6000); });
    lightBin('height')
      .then(buf => { HEIGHT = new Int16Array(buf); Mortar.invalidateTerrain(); rerenderMortars(); refreshLists(); contourLayer.redraw(); hillshadeLayer.redraw(); lzShadeLayer.redraw(); })
      .catch(err => { console.error(err); toast('Could not load terrain heights - mortar solutions ignore elevation.', 6000); });
  }
  // Until a room's map is known the join screen shows the one picked in its list (the server's first map to begin with).
  let mapsLoading = null;
  function loadMaps() {
    mapsLoading = mapsLoading || fetch('/api/maps').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }).then(d => {
      MAPS = Object.fromEntries(Object.entries(d.maps).map(([id, m]) => [id, mapDef(id, m)]));
      DEFAULT_MAP = MAPS[d.default] ? d.default : Object.keys(MAPS)[0];
      if (!DEFAULT_MAP) throw new Error('no maps');
      $('#join-map').replaceChildren(...Object.values(MAPS).map(m => new Option(m.name, m.id)));
      if (!startedMap) { MAP = MAPS[DEFAULT_MAP]; showMapBase(); }
    }).catch(err => { mapsLoading = null; throw err; });
    return mapsLoading;
  }
  showMapBase();
  loadMaps().catch(err => { console.error('maps', err); $('#join-error').textContent = 'Could not load the map list. Is the map server running?'; });
  $('#join-map').addEventListener('change', e => {
    if (startedMap || !MAPS[e.target.value]) return;
    MAP = MAPS[e.target.value];
    showMapBase();
  });
  // A reload of a tab that was in a room goes straight back in.
  const last = (() => { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; } })();
  if (last && last.room && last.room === roomFromHash()) {
    $('#join-name').value = last.name || '';
    loadMaps().then(() => {
      if (MAPS[last.map] && !startedMap) { $('#join-map').value = last.map; MAP = MAPS[last.map]; showMapBase(); }
      submitJoin(2);
    }).catch(() => { /* the join screen already says the map list didn't load */ });
  } else {
    $('#join-name').focus();
  }
})();

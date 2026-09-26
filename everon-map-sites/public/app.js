/* Everon Field Map - client */
(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Coordinates. Game X runs east, game Z runs north, both in metres (0..12800).
  // Tiles and CRS follow the EnfusionMapMaker convention (1 unit = 1 m, 50 m tile offset).
  // ---------------------------------------------------------------------------
  const OFFSET = 50;
  const SCALE = 12.501;
  const WORLD = 12800;
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
  const worldBounds = L.latLngBounds(toLL([0, 0]), toLL([WORLD, WORLD]));
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
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  const EveronTiles = L.TileLayer.extend({
    getTileUrl(c) { return `/tiles/${5 - c.z}/${c.x}/${-(c.y + 1)}.jpg`; },
  });
  new EveronTiles('', { minZoom: -1, maxZoom: 7, minNativeZoom: 0, maxNativeZoom: 5, bounds: worldBounds, keepBuffer: 3 }).addTo(map);

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

  // Estimated tree cover (tools/build_forest.py): one bit per 10 m cell, row 0 = south edge. Drawn as a green
  // diagonal hatch so the imagery underneath stays visible for checking it.
  let FOREST = null; // Uint8Array of packed bits
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

  // Helicopter landing suitability for every 10 m cell, from the same slope and tree limits as the landing zone check
  // (LZ_OK_DEG / LZ_MAX_DEG, trees within LZ_R or LZ_NEAR). Worked out once for the whole map when first drawn.
  // It leaves out the approach directions, which are too slow to check everywhere; hover or drop an LZ for those.
  let LZ_GRID = null; // Uint8Array: 0 water, 1 good, 2 marginal, 3 no-go
  function lzGrid() {
    if (LZ_GRID || !HEIGHT) return LZ_GRID;
    const N = HN, h = k => HEIGHT[k] / 10, slope = new Float32Array(N * N), tree = new Uint8Array(N * N);
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      const k = r * N + c;
      const dx = h(r * N + Math.min(c + 1, N - 1)) - h(r * N + Math.max(c - 1, 0));
      const dz = h(Math.min(r + 1, N - 1) * N + c) - h(Math.max(r - 1, 0) * N + c);
      slope[k] = Math.atan(Math.hypot(dx, dz) / (2 * HCELL)) * 180 / Math.PI;
      tree[k] = FOREST ? (FOREST[k >> 3] >> (7 - (k & 7))) & 1 : 0;
    }
    // Square max filter, separable: the highest value within `rad` cells
    const maxFilter = (src, rad) => {
      const tmp = new src.constructor(N * N), out = new src.constructor(N * N);
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        let m = 0;
        for (let d = Math.max(0, c - rad); d <= Math.min(N - 1, c + rad); d++) m = Math.max(m, src[r * N + d]);
        tmp[r * N + c] = m;
      }
      for (let c = 0; c < N; c++) for (let r = 0; r < N; r++) {
        let m = 0;
        for (let d = Math.max(0, r - rad); d <= Math.min(N - 1, r + rad); d++) m = Math.max(m, tmp[d * N + c]);
        out[r * N + c] = m;
      }
      return out;
    };
    const cells = Math.round(LZ_R / HCELL), near = Math.round(LZ_NEAR / HCELL);
    const s2 = maxFilter(slope, cells), t2 = maxFilter(tree, cells), t4 = maxFilter(tree, near);
    LZ_GRID = new Uint8Array(N * N);
    for (let k = 0; k < N * N; k++) {
      LZ_GRID[k] = h(k) < 0.5 ? 0 : t2[k] || s2[k] > LZ_MAX_DEG ? 3 : t4[k] || s2[k] > LZ_OK_DEG ? 2 : 1;
    }
    return LZ_GRID;
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
  const labelIcon = (text, cls) => L.divIcon({ className: `map-label ${cls}`, iconSize: [0, 0], html: `<span>${esc(text)}</span>` });

  // Popups pan into the part of the map not covered by the sidebar and toolbar.
  function popup() {
    const sb = $('#sidebar');
    const left = window.innerWidth > 720 && !sb.classList.contains('collapsed') ? sb.getBoundingClientRect().right + 16 : 16;
    return L.popup({ maxWidth: 300, autoPanPaddingTopLeft: [left, 80], autoPanPaddingBottomRight: [60, 70] });
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
    { key: 'mob', label: 'HQ start positions', on: false, icon: badge('⚑', C.mob) },
    { group: 'Terrain', key: 'forest', label: 'Forest (estimate)', on: false, icon: '<span class="lg-forest"></span>', countText: '', legendHtml:
      '<div class="legend-key one"><div>Worked out from the satellite colours. Line of sight treats it as 8 m tall trees.</div></div>' },
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
    { key: 'vehicles', label: 'Vehicle spawns', on: false, icon: `<span class="lg-dot" style="--c:${C.vehicle}"></span>` },
    { key: 'refuel', label: 'Refuel points', on: false, icon: `<span class="lg-dot" style="--c:${C.fuel}"></span>` },
    { key: 'repair', label: 'Repair points', on: false, icon: `<span class="lg-dot" style="--c:${C.repair}"></span>` },
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

    const towns = g('towns');
    d.towns.forEach(t => {
      const big = t.type === 'Town' || t.type === 'City';
      L.marker(toLL(t.xz), { icon: labelIcon(t.name, `lbl-town${big ? ' big' : ''}`), interactive: false, keyboard: false }).addTo(towns);
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
      const html = () => popupHtml(c.name, sub, c.xz, radioSummary(idx) + zoneToggles(idx));
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

    const mob = g('mob');
    d.mob.forEach(m => {
      const html = () => popupHtml(m.name, 'Possible HQ / MOB start position', m.xz);
      glyphMarker(m.xz, '⚑', C.mob, 'poi', html).addTo(mob);
      addSearch(m.name, 'Conflict · HQ start position', m.xz, html);
    });

    const sup = g('supplies');
    d.supplies.forEach(s => dot(s.xz, C.supply, 5, () => popupHtml('Supply stash', `${s.amount} supplies · ${s.access} access`, s.xz)).addTo(sup));
    const veh = g('vehicles');
    d.vehicles.forEach(v => dot(v.xz, C.vehicle, 4.5, () => popupHtml('Vehicle spawn', '', v.xz)).addTo(veh));
    const fuel = g('refuel');
    d.refuel.forEach(v => dot(v.xz, C.fuel, 6, () => popupHtml('Refuel point', '', v.xz)).addTo(fuel));
    const rep = g('repair');
    d.repair.forEach(v => dot(v.xz, C.repair, 6, () => popupHtml('Repair point', '', v.xz)).addTo(rep));

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
    g('fiaGame');
    d.fiaGame = []; // counted live in the layer list
    refLayers.contours = contourLayer;
    refLayers.hillshade = hillshadeLayer;
    refLayers.forest = forestLayer;
    refLayers.lzs = { addTo() { lzShadeOn = true; syncLzShade(); }, remove() { lzShadeOn = false; syncLzShade(); } };
    refLayers.coverage = coverageLayer;

    // Layer checkboxes, each showing the icon it puts on the map
    LAYER_DEFS.forEach(def => {
      const box = $(def.box || '#layers');
      if (def.group) box.insertAdjacentHTML('beforeend', `<div class="layer-group-title">${def.group}</div>`);
      const row = document.createElement('label');
      row.className = 'layer';
      row.innerHTML = `<input type="checkbox" ${def.on ? 'checked' : ''}><span class="lg">${def.icon}</span><span class="lbl">${def.label}</span>` +
        `<span class="n"${def.dynamic ? ` id="${def.key}-n"` : ''}>${def.countText ?? d[def.key].length}</span>`;
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
    es: null, // the live-worker.js background worker while joined
  };

  const TYPE_NAME = { marker: 'Marker', route: 'Route', range: 'Range line', mortar: 'Mortar', fia: 'FIA caches', emplacement: 'MG nest', construct: 'Construct',
    arrow: 'Arrow', ambush: 'Ambush', post: 'Range card', sectors: 'Sectors of fire', overwatch: 'Overwatch', aa: 'Enemy AA gun' };
  // "wall" is the sandbag line (the original name, kept so older exported plans still import).
  const CONSTRUCT_NAME = { wall: 'Sandbags', wire: 'Barbed wire', roadblock: 'Roadblock', bunker: 'Bunker', checkpoint: 'Checkpoint' };
  const POINT_CONSTRUCTS = ['bunker', 'checkpoint']; // one click drops them
  const LINE_CONSTRUCTS = ['wall', 'wire', 'roadblock']; // drawn point by point (roadblock = a line of tank traps)
  const typeLabel = it => (it.type === 'construct' ? CONSTRUCT_NAME[it.kind]
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
    { cat: 'plan', name: 'Flight routes', test: it => it.type === 'arrow' && it.kind === 'flight' },
    { cat: 'plan', name: 'Landing zones', test: it => isMarker(it, 'lz') },
    { cat: 'support', name: 'Fire support requests', test: isFireReq },
    { cat: 'support', name: 'Air support requests', test: it => !!airKey(it) },
    { cat: 'defend', name: 'Range cards', test: it => isOurPost(it) && it.side !== 'fv' },
    { cat: 'defend', name: 'Reference points', test: it => isMarker(it, 'trp') },
    { cat: 'defend', name: 'Sectors of fire', test: it => it.type === 'sectors' },
    { cat: 'defend', name: 'MG nests', test: it => it.type === 'emplacement' },
    { cat: 'defend', name: 'Fortifications', test: it => it.type === 'construct' },
    { cat: 'hazards', name: 'Minefields', test: it => isMarker(it, 'mine-at', 'mine-ap') },
    { cat: 'hazards', name: 'Hazards', test: it => isMarker(it, 'blocked', 'bridge', 'danger') },
    { cat: 'intel', name: 'FIA caches', test: it => it.type === 'fia' },
  ];
  const CAT_COLOR = { friendly: '#6cb8ff', enemy: '#ff6b6b', plan: '#c8d96f', defend: '#c8b27c', hazards: '#ffc53d', support: '#ff922b', intel: '#f783ac' };

  async function api(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }
  const saveItem = item => api('/api/item', { id: state.me.id, token: state.me.token, item }).catch(e => toast(e.message));
  const deleteItem = itemId => api('/api/delete', { id: state.me.id, token: state.me.token, itemId }).catch(e => toast(e.message));

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
    if (isMarker(it, 'lz')) { const c = lzCheck(it.xz); return c ? LZ_WORD[c.verdict] : grid(it.xz); }
    if (it.type === 'range') return `${fmtDist(dist(it.from, it.to))} · ${pad(Math.round(bearing(it.from, it.to)) % 360, 3)}°`;
    if (it.type === 'mortar') return `${it.weapon} · ${(it.targets || []).length} target${(it.targets || []).length === 1 ? '' : 's'}`;
    if (it.type === 'fia') return `${it.caches.length} cache${it.caches.length === 1 ? '' : 's'}`;
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
    if (it.type === 'post' || it.type === 'sectors' || it.type === 'overwatch' || it.type === 'aa') return it.xz;
    if (it.type === 'construct') return it.points ? it.points[0] : it.xz;
    if (it.type === 'area') return it.points[0];
    if (it.type === 'fia') return (FIA_KNOWN.find(f => f.name === it.caches[0]) || { xz: [6400, 6400] }).xz;
    return it.type === 'marker' || it.type === 'mortar' || it.type === 'emplacement' ? it.xz : it.type === 'range' ? it.from : it.points[0];
  }

  function itemPopup(owner, it) {
    let extra = '';
    if (it.type === 'route') {
      const legs = it.points.slice(1).map((p, i) => `<div>Leg ${i + 1}: ${fmtDist(dist(it.points[i], p))} · ${fmtBearing(bearing(it.points[i], p))}</div>`).join('');
      if (it.plan) extra += `<p class="sub">Planned on foot by the route planner, ${fmtAgo(Date.now() - (it.plan.at || Date.now()))}. ` +
        `${isMine(owner) ? 'It re-plans itself' : "It re-plans itself on its owner's page"} when enemy markings change.</p>`;
      extra += `<p><b>${fmtDist(pathLength(it.points))}</b> over ${it.points.length - 1} leg${it.points.length > 2 ? 's' : ''}</p>` +
        routeCheckHtml(routeCheck(it.points)) + `<details class="legs"><summary>Legs</summary><div class="sub">${legs}</div></details>`;
    }
    if (it.type === 'range') {
      extra += `<p><b>${fmtDist(dist(it.from, it.to))}</b> · ${fmtBearing(bearing(it.from, it.to))}</p><div class="sub">To grid ${grid(it.to)}</div>`;
    }
    if (it.type === 'mortar') extra += mortarInfoHtml(it);
    if (it.type === 'marker' && it.icon === 'infantry' && it.at) extra += `<p class="sub">Updated ${fmtAgo(Date.now() - it.at)}</p>`;
    if (it.type === 'marker' && UNITS[it.icon] && it.at) extra += `<p class="sub">Marked ${fmtAgo(Date.now() - it.at)} · ${timeoutText(it)}</p>`;
    if (isFireReq(it)) extra += fireHtml(it);
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
      if (it.height) extra += `<p class="sub">Raised ${it.height} m above the ground (e.g. on a roof or tower)</p>`;
      if (los) extra += `<p><b>Sees ${los.pct}%</b> of its field of fire${los.treePct ? `, ${los.treePct}% more only through trees` : ''}</p>` +
        `<p class="sub">Dark shading is dead ground: the gun (${gunEye(it.height)} m up) can't see a standing soldier's chest (${TARGET_H} m) there. ` +
        `Yellow is ground seen only through trees: up to ${TREE_BLOCK} m of woods (${TREE_H} m tall) in the way; more hides it. Buildings aren't included.</p>`;
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

  function renderItem(p, it) {
    try { drawItem(p, it); } catch (err) { console.warn('Could not draw a marking', it && it.id, err); }
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
      const line = L.polyline(lls, { color, weight: 3.5, opacity: 0.95, bubblingMouseEvents: false });
      layer.addLayer(casing).addLayer(line);
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
      const m = L.marker(toLL(it.xz), { icon: emplIcon(FRIENDLY), keyboard: false, riseOnHover: true, zIndexOffset: 300 });
      const name = it.label || 'MG nest';
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
    }
    if (isMine(p.name) && it.xz) enableDrag(p, it, layer);
    p.layers.set(it.id, layer);
    p.group.addLayer(layer);
  }

  // Your own point markings can be dragged to a new spot; whatever hangs off them (a field of fire, range rings,
  // sectors, a mortar's reach) moves with them once the move is saved. Mortar targets stay where they are.
  function enableDrag(p, it, layer) {
    const at = toLL(it.xz);
    const m = layer.getLayers().find(l => l instanceof L.Marker && l.options.interactive !== false && !l.options.draggable && l.getLatLng().equals(at));
    if (!m) return;
    m.options.draggable = true;
    m.on('dragstart', () => map.closePopup());
    m.on('dragend', () => {
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
        [...state.players.keys()].forEach(removePlayer);
        ev.players.forEach(pl => {
          const p = getPlayer(pl.name, pl.color);
          pl.items.forEach(it => { p.items.set(it.id, it); renderItem(p, it); });
        });
        setBriefing(ev.briefing || null, false);
        break;
      case 'briefing':
        setBriefing(ev.briefing, true);
        return;
      case 'join':
        getPlayer(ev.player.name, ev.player.color);
        if (!isMine(ev.player.name)) toast(`${ev.player.name} joined`);
        break;
      case 'leave':
        removePlayer(ev.name);
        toast(`${ev.name} left - their markings were removed`);
        break;
      case 'item': {
        const p = getPlayer(ev.owner);
        const isNew = !p.items.has(ev.item.id), before = p.items.get(ev.item.id);
        p.items.set(ev.item.id, ev.item);
        const air = airKey(ev.item) && AIR[airKey(ev.item)];
        if (air && isNew && !isMine(ev.owner)) toast(`${air.name} requested by ${ev.owner}${airSummary(ev.item) ? `: ${airSummary(ev.item)}` : ''}`, 8000);
        if (air && !isNew && before && before.status !== ev.item.status && ev.item.statusBy && !isMine(ev.item.statusBy)) {
          toast(`${ev.item.label || air.short}: ${AIR_STATUS[ev.item.status || 'requested'].name} by ${ev.item.statusBy}`, 8000);
        }
        const m = isNew && isFireReq(ev.item) && !isMine(ev.owner) && TABLES && myMortar();
        if (m) {
          const { sol } = fireSolution(m, ev.item);
          toast(`${(FIRE[ev.item.fire] || FIRE.he).name} requested by ${ev.owner}: ${sol.best ? fmtSolution(sol, true) : 'out of range'}`, 8000);
        }
        renderItem(p, ev.item);
        break;
      }
      case 'delete': {
        const p = state.players.get(ev.owner);
        if (p) { p.items.delete(ev.id); unrenderItem(p, ev.id); }
        map.closePopup();
        break;
      }
    }
    refreshLists();
  }

  function refreshLists() {
    // players
    const ul = $('#players');
    const players = [...state.players.values()].sort((a, b) => isMine(b.name) - isMine(a.name) || a.name.localeCompare(b.name));
    ul.innerHTML = players.map(p => `<li data-name="${esc(p.name)}" class="${positionOf(p) ? 'has-pos' : ''}"${positionOf(p) ? ' title="Show on map"' : ''}>` +
      `<span class="avatar" style="background:${p.color}">${esc([...p.name][0].toUpperCase())}</span>` +
      `<span class="n">${esc(p.name)}${isMine(p.name) ? ' <span class="you">(you)</span>' : ''}</span>` +
      `<span class="c">${p.items.size || 'no'} marking${p.items.size === 1 ? '' : 's'}</span>` +
      (isPositionCard(positionOf(p) || {}) ? `<button type="button" class="los-tog${losOff.has(p.name) ? '' : ' on'}" data-act="los" ` +
        `aria-pressed="${!losOff.has(p.name)}" title="${losOff.has(p.name) ? 'Show' : 'Hide'} ${esc(p.name)}'s line of sight">${EYE_ICON}</button>` : '') +
      (positionOf(p) ? `<span class="pos${positionOf(p).unit === 'arm' ? ' arm' : ''}" aria-label="has a position marker"></span>` : '') + `</li>`).join('');
    $('#player-count').textContent = players.length || '';
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
    refreshMortarPanel();
    refreshFia();
    refreshCoverage();
    refreshThreats();
    refreshFireLabels();
  }
  let fireSigLast = null;
  function refreshFireLabels() {
    const sig = allVisibleItems(i => i.type === 'mortar').map(({ it: m }) => `${m.id}:${m.xz}:${m.weapon}`).join('|') +
      `|${myMortar()?.id}|${!!TABLES}|${!!HEIGHT}`;
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
  });

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
    $('#ed-height-row').classList.toggle('hidden', item.type !== 'emplacement');
    if (item.type === 'emplacement') $('#ed-height').value = item.height || 0;
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
      it.size = $('#ed-size').value;
      it.activity = $('#ed-activity').value;
      it.kit = $('#ed-kit').value.trim();
      it.heading = $('#ed-heading').value === '' ? null : +$('#ed-heading').value;
    }
    if (it.type === 'sectors') it.names = [...$('#ed-sector-rows').querySelectorAll('input')].map(i => i.value.trim());
    if (airKey(it)) it.air = Object.fromEntries([...$('#ed-air').querySelectorAll('[data-air]')].map(el => [el.dataset.air, el.value.trim()]));
    // A changed timeout counts from now
    if (!$('#ed-ttl-row').classList.contains('hidden') && $('#ed-ttl').value !== editing.ttl) { it.ttl = +$('#ed-ttl').value; it.at = Date.now(); }
    if (it.type === 'emplacement') it.height = Math.min(100, Math.max(0, Math.round((+$('#ed-height').value || 0) * 10) / 10));
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
    { id: 'friendly', name: 'Friendly', key: 'F', color: '#6cb8ff', title: 'Your squad: positions, units and where you are going',
      icon: svg('<rect x="3" y="6" width="18" height="12" rx="1"/><path d="M3 6l18 12M21 6L3 18"/>'),
      items: [
        { tool: 'infantry', name: 'My position', icon: unitSvg('inf', 'f', true) },
        { tool: 'unit-inf-f', name: 'Friendly infantry', short: 'Infantry', icon: unitSvg('inf', 'f') },
        { tool: 'vehicle-view-f', name: 'Friendly armour', short: 'Armour', icon: unitSvg('arm', 'f') },
        '-',
        { tool: 'advance', name: 'Advance arrow', short: 'Advance', icon: svg('<path d="M3 18L17 7" stroke-width="3"/><path d="M12 5.5l7-.5-.5 7z" fill="currentColor"/>', 'color:#4dabf7'),
          hint: `Click along the way you are moving; the arrowhead goes on the last point · ${FINISH}` },
        { tool: 'rally', name: 'Rally point', icon: svg('<path d="M6 21V4"/><path d="M6 4h11l-2.5 4L17 12H6z" fill="rgba(108,184,255,.3)"/>', 'color:#6cb8ff'),
          hint: 'Click to drop a rally point' },
        { tool: 'objective', name: 'Objective', icon: svg('<path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6l-5.4 2.9 1.2-6-4.5-4.2 6.1-.7z"/>', 'color:#ffd43b'),
          hint: 'Click to drop an objective' },
        { tool: 'radio', name: 'Radio backpack', short: 'Radio', icon: svg(RADIO_SVG_BODY, 'color:#6cb8ff') },
        { tool: 'aa-f', name: 'AA gun', icon: '<span class="mi-badge" style="--c:#6cb8ff">AA</span>', hint: 'Click to mark a friendly AA gun' },
        { tool: 'mortar', name: 'Mortar', icon: svg('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.5"/><path d="M12 2v4.5M12 17.5V22M2 12h4.5M17.5 12H22"/>') },
      ] },
    { id: 'enemy', name: 'Enemy', key: 'E', color: '#ff6b6b', title: 'What you know about the enemy: sightings, units, positions, movement and what they can see',
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
          hint: `Click along the way you expect the enemy to come; the arrowhead goes on the last point · ${FINISH}` },
        { tool: 'patrol', name: 'Patrol route', short: 'Patrol', icon: svg('<path d="M3 17c4-8 10 2 16-8" stroke-dasharray="2.5 3"/><path d="M15 8.5l4.5.5-.8 4.4"/>', 'color:#ffa94d'),
          hint: `Click along the enemy patrol route · ${FINISH}` },
        '-',
        { tool: 'enemy-view', name: 'Enemy line of sight', short: 'Enemy LOS', icon: svg('<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>', 'color:#ff5c5c') },
        '-',
        { tool: 'aa-e', name: 'AA gun', short: 'Enemy AA', icon: '<span class="mi-badge" style="--c:#ff5c5c">AA</span>' },
      ] },
    { id: 'plan', name: 'Plan', key: 'P', color: '#c8d96f', title: 'Markers, routes, ambushes, range lines, route planning and landing zones',
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
        '-',
        { tool: 'overwatch', name: 'Overwatch finder', short: 'Overwatch', icon: svg('<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>', 'color:#8ce99a') },
        { tool: 'cover-route', name: 'Route planner', short: 'Route planner', icon: svg('<circle cx="4.5" cy="19" r="2"/><circle cx="19.5" cy="5" r="2"/><path d="M6 17.5c3-1 2-6 6-6s3-5 6-5" stroke-dasharray="3 2.5"/><path d="M3 9c3-3 6-3 8 0" style="color:#ff6b6b"/>', 'color:#8ce99a') },
        { tool: 'lz', name: 'Landing zone check', short: 'LZ check', icon: svg('<circle cx="12" cy="12" r="9"/><path d="M8.5 7.5v9M15.5 7.5v9M8.5 12h7" stroke-width="2.2"/>', 'color:#8ce99a'),
          hint: 'Move over the map to check a spot · click to mark a landing zone · green, amber and red shading show good, marginal and no-go ground' },
      ] },
    { id: 'support', name: 'Support', key: 'S', color: '#ff922b', title: 'Ask for support: mortar fire missions, gun runs, medevac, pickups and resupply',
      icon: svg('<circle cx="12" cy="12" r="7.5"/><path d="M12 2v6M12 16v6M2 12h6M16 12h6"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>', 'color:#ff922b'),
      items: [
        { tool: 'fire-support', name: 'Fire support request', short: 'Fire request', icon: '<svg class="area-ico fire" viewBox="0 0 24 24"><path d="M4 8l7-5 9 4-1.5 11L8 21 3 15z"/><path class="x" d="M8 8l8 8M16 8l-8 8"/></svg>' },
        '-',
        ...Object.entries(AIR).map(([tool, a]) => ({ tool, name: a.name, short: a.short, icon: `<span class="mi-badge" style="--c:${a.color}">${a.badge}</span>`,
          hint: tool === 'air-cas' ? null : `Click where the ${a.where}, then fill in the request` })),
      ] },
    { id: 'defend', name: 'Defend', key: 'D', color: '#c8b27c', title: 'Holding a position: reference points, sectors of fire and fortifications',
      icon: svg('<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/>'),
      items: [
        { tool: 'trp', name: 'Target reference point', short: 'TRP', icon: svg('<path d="M12 3l9.5 17h-19z"/><path d="M12 10v6M9 13h6"/>'),
          hint: 'Click to drop a TRP · its distance and bearing are measured from the nearest range card (a position or armour)' },
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
    { id: 'hazards', name: 'Hazards', key: 'H', color: '#ffc53d', title: 'Dangers to everyone: minefields, blocked roads, bridges out',
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
    else showSection('mortar', false);
    updateHint();
    map.closePopup();
    updateLive();
    updateMortarGhost();
  }
  function updateHint() {
    const text = state.tool === 'mortar' ? mortarHint() : state.tool === 'heli-route' ? coverHint() : TOOL[state.tool]?.hint || '';
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
    } else if (tool === 'range') {
      if (!draw) startDraw('range', xz);
      else {
        const from = draw.points[0];
        draw.layer.remove(); draw = null;
        if (dist(from, xz) >= 1) {
          const n = [...(state.players.get(state.me.name)?.items.values() || [])].filter(i => i.type === 'range').length + 1;
          saveItem({ id: uid(), type: 'range', from: roundXZ(from), to: roundXZ(xz), label: `Range line ${n}`, note: '', color: state.me.color });
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
        size: '', activity: '', kit: '', heading: null, ttl: state.contactTtl }, true);
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
  const HN = 1280, HCELL = 10;   // 1280 x 1280 grid, 10 m cells, row 0 = south edge
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

  const weaponDef = w => TABLES && TABLES.weapons[w];
  const shellDef = (w, s) => weaponDef(w) && weaponDef(w).shells[s];

  function shellLimits(w, s) {
    const rings = Object.values(shellDef(w, s) || {});
    if (!rings.length) return null;
    return { min: Math.min(...rings.map(r => r.table[0][0])), max: Math.max(...rings.map(r => r.table[r.table.length - 1][0])) };
  }

  // Firing solution from mortar to target for every ring that can reach it.
  // Table rows: [range m, elevation mil, time of flight s, elevation change in mil per 100 m of height difference].
  function solve(w, s, from, to) {
    const W = weaponDef(w), rings = shellDef(w, s);
    const d = dist(from, to);
    const hFrom = heightAt(from), hTo = heightAt(to);
    const dh = hFrom != null && hTo != null ? hTo - hFrom : 0;   // + means target is higher
    const az = bearing(from, to);
    const out = { d, az, azMil: az * (W ? W.milsPerCircle : 6400) / 360, hFrom, hTo, dh, rings: [] };
    if (!rings) return out;
    for (const [ring, def] of Object.entries(rings)) {
      const t = def.table;
      if (d < t[0][0] || d > t[t.length - 1][0]) continue;
      let i = t.findIndex(row => row[0] >= d);
      const a = t[Math.max(i - 1, 0)], b = t[i];
      const k = b[0] === a[0] ? 0 : (d - a[0]) / (b[0] - a[0]);
      const lerp = j => a[j] + (b[j] - a[j]) * k;
      // Higher target -> lower elevation (flatter shot); lower target -> higher elevation.
      const elev = lerp(1) - dh * lerp(3) / 100;
      out.rings.push({ ring: +ring, elev, tof: lerp(2), dispersion: def.dispersion });
    }
    out.rings.sort((x, y) => x.ring - y.ring);
    out.best = out.rings[0] || null; // lowest ring that reaches = tightest dispersion
    return out;
  }

  const myMortar = () => {
    const me = state.me && state.players.get(state.me.name);
    return me ? [...me.items.values()].find(i => i.type === 'mortar') : null;
  };

  function mortarHint() {
    if (!TABLES) return 'Loading firing tables…';
    if (!myMortar() || state.mortarPlacing) return 'Click the map to place your mortar';
    return 'Click a target for a firing solution · move the mouse for a live solution';
  }

  function fmtSolution(sol, short = false) {
    const az = `${pad(Math.round(sol.az) % 360, 3)}° / ${Math.round(sol.azMil)} mil`;
    const dh = `${sol.dh >= 0 ? '+' : '−'}${Math.abs(Math.round(sol.dh))} m`;
    if (!sol.best) return `Out of range · ${fmtDist(sol.d)}`;
    const b = sol.best;
    return short
      ? `Ring ${b.ring} · ${Math.round(b.elev)} mil · Az ${Math.round(sol.azMil)}`
      : `Ring ${b.ring} · Elev ${Math.round(b.elev)} mil · Az ${az} · ${fmtDist(sol.d)} · Δh ${dh} · ${b.tof.toFixed(1)} s`;
  }

  function solutionTable(sol) {
    if (!sol.rings.length) return '';
    return `<table class="fire"><tr><th>Ring</th><th>Elev</th><th>Time</th><th>Spread</th></tr>` +
      sol.rings.map(r => `<tr class="${r === sol.best ? 'best' : ''}"><td>${r.ring}</td><td>${Math.round(r.elev)} mil</td><td>${r.tof.toFixed(1)} s</td><td>±${r.dispersion} m</td></tr>`).join('') +
      `</table>`;
  }

  function mortarInfoHtml(m) {
    const W = weaponDef(m.weapon), lim = shellLimits(m.weapon, m.shell), alt = heightAt(m.xz);
    let html = `<p><b>${esc(W ? W.label : m.weapon)}</b> · ${esc(m.shell)}</p>`;
    if (alt != null) html += `<div class="sub">Altitude ${Math.round(alt)} m</div>`;
    if (lim) html += `<div class="sub">Reach ${fmtDist(lim.min)} – ${fmtDist(lim.max)}</div>`;
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

  // Where rounds land around an aim point: the spread (the range table's average dispersion for the ring used) shaded
  // as the kill zone, and for HE a dashed danger zone KILL_RADIUS further out. Smoke, illumination and practice rounds
  // aren't lethal, so they show only the spread, in their own colour.
  const isLethal = shell => /^HE/.test(shell || '');
  const shellColor = shell => (/^Smoke/.test(shell) ? FIRE.smoke.color : /^Illum/.test(shell) ? FIRE.illum.color : '#adb5bd');
  function impactZones(layer, xz, spread, lethal, color) {
    if (lethal) {
      layer.addLayer(L.circle(toLL(xz), { radius: spread + KILL_RADIUS, color: '#ff5c5c', weight: 1.8, dashArray: '6 5', fillColor: '#ff5c5c', fillOpacity: 0.1, interactive: false }));
      if (spread) layer.addLayer(L.circle(toLL(xz), { radius: spread, color: '#ff2b2b', weight: 2, fillColor: '#ff2b2b', fillOpacity: 0.35, interactive: false }));
    } else if (spread) {
      layer.addLayer(L.circle(toLL(xz), { radius: spread, color, weight: 1.8, dashArray: '5 4', fillColor: color, fillOpacity: 0.16, interactive: false }));
    }
  }
  // "Kill zone 24 m · danger zone 44 m" (or the spread for other shells), and any friendlies inside the danger zone.
  function impactText(shell, spread, xz) {
    if (!isLethal(shell)) return { zone: `Rounds land within about ${spread} m`, near: [] };
    return { zone: `Kill zone ${spread} m · danger zone ${spread + KILL_RADIUS} m`, near: friendliesNear({ xz }, spread + KILL_RADIUS) };
  }
  const friendlyWarning = near => (near.length
    ? `<p><b class="rc-no">Friendlies in the danger zone</b>: ${near.slice(0, 6).map(x => `${esc(x.name)} ${x.d < 1 ? '(inside)' : fmtDist(x.d)}`).join(', ')}</p>` : '');

  function targetPopup(owner, m, idx) {
    const t = m.targets[idx];
    const sol = solve(m.weapon, m.shell, m.xz, t);
    const W = weaponDef(m.weapon);
    const dh = sol.hTo != null ? `${sol.dh >= 0 ? '+' : '−'}${Math.abs(Math.round(sol.dh))} m` : '—';
    let extra = `<div class="stats">` +
      `<div><span class="k">Distance</span><span class="v">${fmtDist(sol.d)}</span></div>` +
      `<div><span class="k">Azimuth</span><span class="v">${Math.round(sol.azMil)} mil</span></div>` +
      `<div><span class="k">Height Δ</span><span class="v">${dh}</span></div></div>` +
      `<div class="sub" style="margin-top:5px">${pad(Math.round(sol.az) % 360, 3)}° · ${W ? W.milsPerCircle : 6400}-mil scale` +
      (sol.hTo != null ? ` · target ${Math.round(sol.hTo)} m, mortar ${Math.round(sol.hFrom)} m` : '') + `</div>`;
    if (sol.best) {
      const z = impactText(m.shell, sol.best.dispersion, t);
      extra += `<p>${z.zone}</p>${friendlyWarning(z.near)}`;
    }
    extra += sol.rings.length ? solutionTable(sol) : `<p style="color:var(--danger)">Out of range for ${esc(m.shell)}</p>`;
    if (isMine(owner)) extra += `<div class="row"><button class="danger" data-act="del-target" data-idx="${idx}">Remove target</button></div>`;
    return popupHtml(`Target ${idx + 1}`, `${m.weapon} ${m.shell} · by ${owner}${isMine(owner) ? ' (you)' : ''}`, t, extra);
  }

  function renderMortar(p, m, layer, color, html) {
    const center = toLL(m.xz);
    const rings = shellDef(m.weapon, m.shell) || {};
    const entries = Object.entries(rings).sort((a, b) => +a[0] - +b[0]);
    const mine = isMine(p.name);
    // Each ring's maximum reach, plus the overall minimum distance.
    entries.forEach(([ring, def]) => {
      const max = def.table[def.table.length - 1][0];
      layer.addLayer(L.circle(center, { radius: max, color, weight: 1.2, opacity: mine ? 0.75 : 0.45, dashArray: '4 6', fill: false, interactive: false }));
      layer.addLayer(L.marker(toLL([m.xz[0], m.xz[1] + max]), { interactive: false, keyboard: false,
        icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<span class="ring-label">R${ring} ${fmtDist(max)}</span>` }) }));
    });
    const lim = shellLimits(m.weapon, m.shell);
    if (lim) layer.addLayer(L.circle(center, { radius: lim.min, color: '#ff6b6b', weight: 1.2, dashArray: '2 4', fill: true, fillOpacity: 0.08, interactive: false }));

    (m.targets || []).forEach((t, idx) => {
      const sol = solve(m.weapon, m.shell, m.xz, t);
      const ok = !!sol.best;
      layer.addLayer(L.polyline([center, toLL(t)], { color: ok ? color : '#ff6b6b', weight: 1.5, opacity: 0.8, dashArray: '2 5', interactive: false }));
      if (ok) impactZones(layer, t, sol.best.dispersion, isLethal(m.shell), shellColor(m.shell));
      const tm = L.marker(toLL(t), { keyboard: false, icon: glyphIcon('✛', ok ? color : '#ff6b6b') });
      tm.bindTooltip(esc(`T${idx + 1} · ${ok ? fmtSolution(sol, true) : 'out of range'}`), { permanent: true, direction: 'right', offset: [12, 0], className: 'item-label' });
      bindInfo(tm, () => targetPopup(p.name, p.items.get(m.id) || m, idx), () => t);
      layer.addLayer(tm);
    });

    const mk = L.marker(center, { keyboard: false, zIndexOffset: 500, icon: glyphIcon('⊕', color) });
    const tag = mine ? `Mortar · ${m.weapon}` : `Mortar · ${m.weapon} (${p.name})`;
    mk.bindTooltip(esc(m.label && m.label !== 'Mortar' ? `${m.label} · ${m.weapon}` : tag), { permanent: true, direction: 'right', offset: [12, 0], className: 'item-label' });
    bindInfo(mk, html, () => m.xz);
    layer.addLayer(mk);
  }

  // Live aiming line from your mortar to the cursor.
  const mortarGhost = L.polyline([], { color: '#c8d96f', weight: 2, dashArray: '6 6', interactive: false }).addTo(map);
  const mortarGhostZones = L.layerGroup().addTo(map); // where the rounds would land, while aiming
  function updateMortarGhost() {
    const m = myMortar();
    const on = state.tool === 'mortar' && m && !state.mortarPlacing && lastCursor;
    mortarGhost.setLatLngs(on ? [toLL(m.xz), toLL(lastCursor)] : []);
    mortarGhostZones.clearLayers();
    const sol = on && TABLES && solve(m.weapon, m.shell, m.xz, lastCursor);
    if (sol && sol.best) impactZones(mortarGhostZones, lastCursor, sol.best.dispersion, isLethal(m.shell), shellColor(m.shell));
  }
  function mortarLive(el) {
    const m = myMortar();
    if (!m || state.mortarPlacing || !lastCursor || !TABLES) return false;
    const sol = solve(m.weapon, m.shell, m.xz, lastCursor);
    el.textContent = fmtSolution(sol);
    el.style.color = sol.best ? '' : 'var(--danger)';
    return true;
  }

  function mortarClick(xz) {
    if (!TABLES) return toast('Firing tables are still loading.');
    const m = myMortar();
    if (!m || state.mortarPlacing) {
      state.mortarPlacing = false;
      saveItem({
        id: m ? m.id : uid(), type: 'mortar', xz: roundXZ(xz), weapon: state.mortarWeapon, shell: state.mortarShell,
        targets: m ? m.targets : [], label: m ? m.label : 'Mortar', note: m ? m.note : '', color: m ? m.color : state.me.color,
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
  }
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

  function refreshMortarPanel() {
    const m = myMortar();
    if (m && TABLES && (m.weapon !== state.mortarWeapon || m.shell !== state.mortarShell)) {
      state.mortarWeapon = m.weapon; state.mortarShell = m.shell; fillMortarSelects();
    }
    const status = $('#mortar-status');
    $('#mortar-actions').classList.toggle('hidden', !m);
    if (!m) {
      status.innerHTML = '<div class="empty">Choose <b>Friendly ▾ → Mortar</b> (F then 9), then click the map to place your mortar.</div>';
      $('#mortar-targets').innerHTML = '';
    } else {
      const lim = shellLimits(m.weapon, m.shell), alt = heightAt(m.xz);
      status.innerHTML = `<div class="stats">` +
        `<div><span class="k">Position</span><span class="v">${grid(m.xz)}</span></div>` +
        `<div><span class="k">Altitude</span><span class="v">${alt != null ? Math.round(alt) + ' m' : '—'}</span></div>` +
        `<div><span class="k">Reach</span><span class="v">${lim ? `${(lim.max / 1000).toFixed(1)} km` : '—'}</span></div></div>` +
        (m.targets.length ? '' : '<div class="empty" style="margin-top:8px">Click the map with the Mortar tool to add targets.</div>');
      $('#mortar-targets').innerHTML = m.targets.map((t, i) => {
        const sol = solve(m.weapon, m.shell, m.xz, t), b = sol.best;
        const head = `<div class="tgt-head"><span class="id">T${i + 1}</span><span>${grid(t)}</span><span>·</span><span>${fmtDist(sol.d)}</span>` +
          `<span class="sp"></span><button data-act="del-target" data-idx="${i}" title="Remove target" aria-label="Remove target">✕</button></div>`;
        const body = b
          ? `<div class="fire-now"><div><span class="k">Ring</span><span class="v">${b.ring}</span></div>` +
            `<div><span class="k">Elevation</span><span class="v">${Math.round(b.elev)}<small>mil</small></span></div>` +
            `<div><span class="k">Azimuth</span><span class="v">${Math.round(sol.azMil)}<small>mil</small></span></div></div>` + targetSub(m.shell, b.dispersion, t)
          : `<div class="fire-now bad">Out of range (max ${fmtDist(lim ? lim.max : 0)})</div>`;
        return `<li data-idx="${i}">${head}${body}</li>`;
      }).join('');
    }
    refreshFireRequests(m);
    if (state.tool === 'mortar') { updateHint(); updateMortarGhost(); }
  }

  function targetSub(shell, spread, xz) {
    const z = impactText(shell, spread, xz);
    return `<div class="fire-sub">${z.zone}</div>` +
      (z.near.length ? `<div class="fire-sub warn">Friendlies in the danger zone: ${z.near.slice(0, 3).map(x => `${esc(x.name)} ${fmtDist(x.d)}`).join(', ')}</div>` : '');
  }
  // Every fire request on the map, with a firing solution from your mortar to its middle once you have one down.
  function refreshFireRequests(m) {
    const reqs = allVisibleItems(isFireReq).sort((a, b) => (b.it.at || 0) - (a.it.at || 0)); // newest first
    $('#fire-requests').classList.toggle('hidden', !reqs.length);
    $('#fire-count').textContent = reqs.length || '';
    $('#mortar-requests').innerHTML = !m
      ? `<li class="empty">Place your mortar to get a firing solution for ${reqs.length === 1 ? 'this request' : `these ${reqs.length} requests`}.</li>`
      : reqs.map(({ p, it }) => {
        const f = FIRE[it.fire] || FIRE.he, { shell, sol } = fireSolution(m, it), b = sol.best, lim = shellLimits(m.weapon, shell);
        const head = `<div class="tgt-head"><span class="id" style="background:${f.color};color:#111">${f.name}</span>` +
          `<span class="t">${esc(it.label || 'Fire mission')}${isMine(p.name) ? '' : ` · ${esc(p.name)}`}</span><span>${fmtDist(sol.d)}</span>` +
          `<span class="sp"></span><button data-fire-add="${esc(it.id)}" title="Add its aim point to your targets" aria-label="Add as a target">+</button></div>`;
        const body = b
          ? `<div class="fire-now"><div><span class="k">Ring</span><span class="v">${b.ring}</span></div>` +
            `<div><span class="k">Elevation</span><span class="v">${Math.round(b.elev)}<small>mil</small></span></div>` +
            `<div><span class="k">Azimuth</span><span class="v">${Math.round(sol.azMil)}<small>mil</small></span></div></div>` +
            `<div class="fire-sub">${esc(shell)} · ${b.tof.toFixed(1)} s · asked ${fmtAgo(Date.now() - (it.at || Date.now()))}</div>`
          : `<div class="fire-now bad">Out of range for ${esc(shell)}${lim ? ` (${fmtDist(lim.min)}–${fmtDist(lim.max)})` : ''}</div>`;
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
  $('#mortar-remove').addEventListener('click', () => { const m = myMortar(); if (m) deleteItem(m.id); });
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
  const constructIcon = kind => L.divIcon({ className: `${kind}-glyph`, iconSize: [0, 0], html: CONSTRUCT_HTML[kind] });

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
  // Trees: forest squares (the Forest estimate layer) are TREE_H tall. What matters is how far a sight line runs
  // through canopy (below the treetops): up to TREE_BLOCK of it and the target is seen only "through trees", more
  // and it is hidden, as a belt of woods that deep blocks the view. Trees within TREE_CLEAR (TREE_CLEAR_VEHICLE) of a
  // soldier (vehicle) don't count, so someone in or at the edge of a wood can still see out; AA guns get no such
  // allowance, since they can't see up through the canopy they sit under.
  // The mortar calculator never uses this; it reads the bare terrain.
  const TREE_H = 8, TREE_BLOCK = 50, TREE_CLEAR = 35, TREE_CLEAR_VEHICLE = 15; // metres
  const LOS_HIDDEN = 1, LOS_CLEAR = 2, LOS_TREES = 3;
  const LOS_RANK = [0, 1, 3, 2]; // when samples disagree about a cell: clear beats through trees beats hidden
  const losCache = new Map();
  const ground = p => Math.max(heightAt(p), 0); // the sea surface blocks nothing
  function fieldOfFireLos(xz, dir, arc, range, cache = true, eyeH = GUN_EYE, treeClear = TREE_CLEAR) {
    return losGrid(xz, dir, arc, range, cache, eyeH, TARGET_H, treeClear, false);
  }
  // Overwatch: from where around xz can a crouched observer see a standing soldier at xz? Sight lines work both
  // ways, so this is the same march run outward from the objective with the two heights swapped. The trees an
  // observer can see through are the ones near the observer, so in this reverse march the tree allowance applies at
  // the far end of each sight line instead of the near end.
  const overwatchLos = (xz, range) => losGrid(xz, 0, 360, range, true, TARGET_H, POST_KIND.f.eye, TREE_CLEAR, true);
  // Sorted-array searches: the first index whose value is >= v (lowerBound) or > v (upperBound).
  function lowerBound(a, v) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; } return lo; }
  function upperBound(a, v) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= v) lo = m + 1; else hi = m; } return lo; }
  // Rays are cast across the arc and marched outward in 5 m steps. For a target at distance r with sight-line slope t
  // (target height minus eye height, over r): the terrain hides it if any nearer ground has a steeper slope from the
  // eye (a running maximum). The sight line is inside the canopy at a nearer forest sample exactly when that sample's
  // treetop slope is steeper than t, so the depth of trees it passes through is 5 m x the number of such samples.
  // Counting them with a Fenwick tree over the ray's sorted treetop slopes keeps each ray O(n log n).
  // elev: [lowest, highest] angle in degrees a gun can aim (null = any).
  function losGrid(xz, dir, arc, range, cache, eyeH, targetH, treeClear, reverse, elev = null) {
    if (!HEIGHT || range < 1) return null;
    const key = `${xz}|${dir}|${arc}|${Math.round(range)}|${eyeH}|${targetH}|${treeClear}|${reverse}|${elev}|${!!FOREST}`;
    if (cache && losCache.has(key)) return losCache.get(key);
    const pts = arc >= 360 ? [[xz[0] - range, xz[1] - range], [xz[0] + range, xz[1] + range]] : sectorLatLngs(xz, dir, arc, range).map(toXZ);
    // The box is snapped to the 10 m grid so results from different spots line up cell for cell.
    const minX = Math.floor(Math.min(...pts.map(p => p[0])) / LOS_CELL) * LOS_CELL, maxX = Math.max(...pts.map(p => p[0]));
    const minZ = Math.min(...pts.map(p => p[1])), maxZ = Math.ceil(Math.max(...pts.map(p => p[1])) / LOS_CELL) * LOS_CELL;
    const W = Math.max(1, Math.ceil((maxX - minX) / LOS_CELL)), H = Math.max(1, Math.ceil((maxZ - minZ) / LOS_CELL));
    const cells = new Uint8Array(W * H); // 0 outside the arc, else LOS_HIDDEN / LOS_CLEAR / LOS_TREES
    const eye = ground(xz) + eyeH, step = LOS_CELL / 2;
    const rays = Math.ceil(arc * Math.PI / 180 * range / (LOS_CELL * 0.7)) + 1;
    // Forward: trees within treeClear of the eye don't count. Reverse (overwatch, marching out from the target):
    // trees within treeClear of the far end don't count, so a sample's canopy is added `lag` steps later.
    const lag = Math.floor(treeClear / step) + 1;
    const [lo, hi] = elev ? elev.map(d => Math.tan(d * Math.PI / 180)) : [-Infinity, Infinity];
    const maxN = Math.ceil(range / step) + 1;
    const hs = new Float64Array(maxN), tops = new Float64Array(maxN), fs = new Uint8Array(maxN), sorted = new Float64Array(maxN), bit = new Int32Array(maxN + 1);
    for (let i = 0; i <= rays; i++) {
      const b = (dir - arc / 2 + arc * i / rays) * Math.PI / 180, sx = Math.sin(b), sz = Math.cos(b);
      // Heights and treetop slopes along the ray
      let n = 0, m = 0;
      for (let r = step; r <= range; r += step) {
        const x = xz[0] + r * sx, z = xz[1] + r * sz;
        if (x < 0 || z < 0 || x > WORLD || z > WORLD) break;
        hs[n] = ground([x, z]);
        fs[n] = isForest([x, z]);
        if (fs[n]) sorted[m++] = tops[n] = (hs[n] + TREE_H - eye) / r;
        n++;
      }
      const srt = sorted.subarray(0, m).sort();
      bit.fill(0, 0, m + 1);
      let inCanopy = 0; // forest samples counted so far
      const addTree = k => { inCanopy++; for (let p = lowerBound(srt, tops[k]) + 1; p <= m; p += p & -p) bit[p]++; };
      const treesBelow = t => { let c = 0; for (let p = upperBound(srt, t); p > 0; p -= p & -p) c += bit[p]; return c; };
      let maxTerrain = -Infinity; // steepest slope from the eye to any nearer ground
      for (let j = 0; j < n; j++) {
        const r = (j + 1) * step;
        if (reverse && j >= lag && fs[j - lag]) addTree(j - lag);
        const t = (hs[j] + targetH - eye) / r;
        let v;
        if (t < maxTerrain || t < lo || t > hi) v = LOS_HIDDEN;
        else {
          const depth = (inCanopy - treesBelow(t)) * step; // canopy samples whose treetops the sight line passes under
          v = depth > TREE_BLOCK ? LOS_HIDDEN : depth > 0 ? LOS_TREES : LOS_CLEAR;
        }
        maxTerrain = Math.max(maxTerrain, (hs[j] - eye) / r);
        if (!reverse && fs[j] && r > treeClear) addTree(j);
        const x = xz[0] + r * sx, z = xz[1] + r * sz;
        const cx = Math.floor((x - minX) / LOS_CELL), cz = Math.floor((maxZ - z) / LOS_CELL);
        if (cx < 0 || cx >= W || cz < 0 || cz >= H) continue;
        const k = cz * W + cx;
        if (LOS_RANK[v] > LOS_RANK[cells[k]]) cells[k] = v;
      }
    }
    let clear = 0, trees = 0, total = 0;
    for (const v of cells) if (v) { total++; if (v === LOS_CLEAR) clear++; else if (v === LOS_TREES) trees++; }
    const res = { cells, W, H, minX, maxZ, pct: total ? Math.round(clear / total * 100) : 100, treePct: total ? Math.round(trees / total * 100) : 0,
      bounds: L.latLngBounds(toLL([minX, maxZ - H * LOS_CELL]), toLL([minX + W * LOS_CELL, maxZ])) };
    if (cache) {
      if (losCache.size > 60) losCache.clear();
      losCache.set(key, res);
    }
    return res;
  }
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

  function emplIcon(color, draft = false) {
    return L.divIcon({ className: `empl-glyph${draft ? ' draft' : ''}`, iconSize: [0, 0], html: `<div style="--c:${color}">MG</div>` });
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
  const postLos = it => fieldOfFireLos(it.xz, 0, 360, it.range, true,
    (isVehicleView(it) ? POST_KIND.fv : POST_KIND[it.side] || POST_KIND.f).eye, isVehicleView(it) ? TREE_CLEAR_VEHICLE : TREE_CLEAR);
  // The line-of-sight marking a tool places: the enemy's (soldier or vehicle, picked in its options) or our armour's.
  const postSideOf = tool => (tool === 'enemy-view' ? state.enemyView : tool === 'vehicle-view-f' ? 'fv' : null);
  function losAt(los, xz) { // LOS_CLEAR / LOS_TREES / LOS_HIDDEN, or null outside the result
    const cx = Math.floor((xz[0] - los.minX) / LOS_CELL), cz = Math.floor((los.maxZ - xz[1]) / LOS_CELL);
    if (cx < 0 || cz < 0 || cx >= los.W || cz >= los.H) return null;
    return los.cells[cz * los.W + cx] || null;
  }

  // Option picker under the toolbar for the Plan tools; keys 1-4 pick too.
  const REACH = [[400, '400 m'], [800, '800 m'], [1500, '1.5 km']];
  const HELI_ALTS = [[30, '30 m'], [100, '100 m'], [200, '200 m']];
  state.heliAlt = 100;
  state.routeMode = 'foot';
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
    'air-cas': { label: 'Target', key: 'casShape', options: [['point', 'Point'], ['area', 'Area']] },
    'aa-e': { label: 'Helicopter height', key: 'heliAlt', options: HELI_ALTS },
    'cover-route': () => [{ label: 'Travel', key: 'routeMode', options: [['foot', 'Foot'], ['air', 'Air']] },
      ...(state.routeMode === 'air' ? [{ label: 'Helicopter height', key: 'heliAlt', options: HELI_ALTS }] : [])],
    radio: { label: `Spawn radius (${RADIO_CLEAR} m)`, key: 'radioRing', options: [[true, 'Show'], [false, 'Hide']] },
    'fire-support': [
      { label: 'Request', key: 'fireShape', options: [['area', 'Area'], ['point', 'Point']] },
      { label: 'Fire', key: 'fireKind', options: Object.entries(FIRE).map(([k, f]) => [k, f.name]) },
    ],
  };
  function pickerHint() {
    const t = state.tool, d = shapeDraft;
    if (t === 'ambush') return !d ? 'Click one end of the kill zone' : d.pts.length === 1 ? 'Click the other end' : 'Click the side your squad waits on';
    if (t === 'sectors') return !d ? 'Click the centre of your position' : 'Move to set size and rotation · click to set';
    if (t === 'vehicle-view-f') return state.armourRange ? 'Click where our vehicle is' : 'Click to mark friendly armour';
    if (t === 'overwatch') return 'Click the objective to find where it can be seen from';
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
    state.players.forEach(p => p.items.forEach(it => { if (it.type === 'emplacement' || it.type === 'overwatch') renderItem(p, it); }));
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
    const minX = Math.min(...all.map(x => x.los.minX)), maxZ = Math.max(...all.map(x => x.los.maxZ));
    const W = Math.round((Math.max(...all.map(x => x.los.minX + x.los.W * LOS_CELL)) - minX) / LOS_CELL);
    const H = Math.round((maxZ - Math.min(...all.map(x => x.los.maxZ - x.los.H * LOS_CELL))) / LOS_CELL);
    const ours = new Uint8Array(W * H), theirs = new Uint8Array(W * H);
    for (const { side, los } of all) {
      const ox = Math.round((los.minX - minX) / LOS_CELL), oz = Math.round((maxZ - los.maxZ) / LOS_CELL);
      const dst = OUR_SIDES.has(side) ? ours : theirs;
      for (let y = 0; y < los.H; y++) {
        const row = (y + oz) * W + ox;
        for (let x = 0; x < los.W; x++) {
          const v = los.cells[y * los.W + x];
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
    const bounds = L.latLngBounds(toLL([minX, maxZ - H * LOS_CELL]), toLL([minX + W * LOS_CELL, maxZ]));
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
  function renderSectorShapes(it, layer, html) {
    sectorSpans(it).forEach(([a, b], i) => {
      const col = SECTOR_COLORS[i % SECTOR_COLORS.length], span = b - a;
      const poly = L.polygon(sectorLatLngs(it.xz, a + span / 2, span, it.radius), {
        color: col, weight: 1.6, opacity: 0.9, fillColor: col, fillOpacity: 0.1, interactive: !!html, bubblingMouseEvents: false });
      if (html) bindInfo(poly, html);
      layer.addLayer(poly);
      const mid = (a + span / 2) * Math.PI / 180, lp = [it.xz[0] + it.radius * 0.62 * Math.sin(mid), it.xz[1] + it.radius * 0.62 * Math.cos(mid)];
      const name = (it.names || [])[i];
      layer.addLayer(L.marker(toLL(lp), { interactive: false, keyboard: false, icon: L.divIcon({ className: 'sector-label', iconSize: [0, 0],
        html: `<span style="--c:${col}"><b>${SECTOR_LETTERS[i]}</b>${name ? ` ${esc(name)}` : ''}</span>` }) }));
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
    return fieldOfFireLos(it.xz, 0, 360, w.reach, true, w.eye, w.vehicle ? TREE_CLEAR_VEHICLE : TREE_CLEAR);
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
    .map(({ it }) => `${it.id}:${it.xz || it.points}:${it.range || ''}`).join('|') + `|${!!HEIGHT}|${!!FOREST}`;

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
  const JOG = 3.33, UPHILL_COST = 1.5, DOWNHILL_FREE = 0.3;
  const FOOT_MAX_DEG = 60, FOOT_MAX_GRADE = Math.tan(FOOT_MAX_DEG * Math.PI / 180);
  const walkSpeed = grade => JOG / (1 + UPHILL_COST * (grade > 0 ? grade : Math.max(0, -grade - DOWNHILL_FREE)));
  const DRIVE_KMH = 40;
  const fmtTime = s => s < 90 ? `${Math.max(1, Math.round(s))} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round(s / 60) % 60} min`;
  const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const compass = brg => COMPASS[Math.round(brg / 45) % 8];

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
    let climb = 0, descent = 0, walk = 0, steep = 0, seenClear = 0, seenTrees = 0;
    for (let i = 1; i < S.length; i++) {
      const a = S[i - 1], b = S[i], len = b.d - a.d;
      if (len <= 0) continue;
      const dh = b.h - a.h, g = dh / len;
      if (dh > 0) climb += dh; else descent -= dh;
      steep = Math.max(steep, Math.abs(g));
      walk += len / walkSpeed(g);
      if (b.seen === LOS_CLEAR) seenClear += len; else if (b.seen === LOS_TREES) seenTrees += len;
    }
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
    const res = { total, climb, descent, steep, walk, drive: total / (DRIVE_KMH / 3.6), seenClear, seenTrees, stretches, crossed, hazards,
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
    if (!rc) return '<p class="sub">The route check needs the terrain heights, which are still loading.</p>';
    let html = `<div class="stats wrap"><div><span class="k">On foot</span><span class="v">${fmtTime(rc.walk)}</span></div>` +
      `<div><span class="k">Vehicle</span><span class="v">${fmtTime(rc.drive)}</span></div>` +
      `<div><span class="k">Up / down</span><span class="v">${Math.round(rc.climb)} / ${Math.round(rc.descent)} m</span></div></div>` +
      profileSvg(rc) + `<p class="sub">Steepest stretch ${Math.round(rc.steep * 100)}%.</p>`;
    if (!rc.watchers) {
      html += '<p class="sub">Mark enemy positions (Enemy menu: units, sniper, contact or line of sight) to see where this route is exposed.</p>';
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
    return html + `<p class="sub">On foot is a jog (${JOG} m/s on the flat), slowed by slopes; the vehicle time assumes ${DRIVE_KMH} km/h. On the map, red shows where a marked ` +
      `enemy sees the route clearly and yellow where it sees it only through trees. Enemy soldiers are assumed to see ${fmtDist(ENEMY_WATCH['unit-inf-e'].reach)} ` +
      `from a crouch, snipers ${fmtDist(ENEMY_WATCH.sniper.reach)}, armour ${fmtDist(ENEMY_WATCH['unit-arm-e'].reach)}.</p>`;
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
        if (it.type !== 'route' || !it.plan || it.plan.mode !== 'foot') return;
        const pts = findCoveredRoute(it.plan.from, it.plan.to, ws);
        if (pts && pts.join(';') !== it.points.join(';')) saveItem({ ...it, points: pts, plan: { ...it.plan, at: Date.now() } });
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
      const c = [los.minX + (cx + 0.5) * LOS_CELL, los.maxZ - (cz + 0.5) * LOS_CELL], d = dist(xz, c);
      if (d < OW_MIN) continue;
      const h = heightAt(c);
      if (!near || d < near.d) near = { xz: c, d, h };
      if (!high || h > high.h) high = { xz: c, d, h };
    }
    return { near, high };
  }
  function overwatchHtml(it) {
    const los = overwatchLos(it.xz, it.range), alt = heightAt(it.xz);
    if (!los) return '<p class="sub">The overwatch finder needs the terrain heights, which are still loading.</p>';
    const { near, high } = clearSpots(los, it.xz);
    const spot = s => `<b>${fmtDist(s.d)} ${compass(bearing(it.xz, s.xz))}</b> of it, grid ${grid(s.xz)} (${Math.round(s.h - alt) >= 0 ? '+' : ''}${Math.round(s.h - alt)} m)`;
    return `<div class="stats"><div><span class="k">Reach</span><span class="v">${fmtDist(it.range)}</span></div>` +
      `<div><span class="k">Clear view from</span><span class="v">${los.pct}%</span></div>` +
      `<div><span class="k">Height</span><span class="v">${alt != null ? Math.round(alt) + ' m' : '—'}</span></div></div>` +
      (los.treePct ? `<p class="sub">Plus ${los.treePct}% that sees it only through trees</p>` : '') +
      (near ? `<p>Closest clear view beyond ${OW_MIN} m: ${spot(near)}</p>` +
          (high !== near && high.h - near.h >= 5 ? `<p>Highest clear view: ${spot(high)}</p>` : '')
        : `<p><b class="rc-no">Nowhere ${OW_MIN} m to ${fmtDist(it.range)} out</b> has a clear view of it.</p>`) +
      `<p class="sub">Tinted ground is where a crouched observer (${POST_KIND.f.eye} m) can see a standing soldier (${TARGET_H} m) here; ` +
      `yellow sees it only through up to ${TREE_BLOCK} m of trees; unshaded ground can't see it. Trees are ${TREE_H} m tall; buildings aren't included.</p>`;
  }

  // --- Route planner (foot): the quickest way on foot around marked enemies ---------------------------------------
  // A* over the 10 m grid, costed in travel time at a jog (slopes slow it down, over FOOT_MAX_DEG is impassable) and
  // multiplied where it would be seen: x10 where a marked enemy sees clearly, x2.5 through trees. Keep-out rings around
  // marked enemies (FOOT_BERTH) cost 50 times more, so the route only goes through one when there is no other way.
  // The sea and minefields are off limits. The search is boxed around the start and end, at any distance.
  const FOOT_BERTH = { infantry: 300, armour: 500, aa: 500, area: 100 };
  let coverDraft = null; // {start, layer, pts}
  const airRouting = () => state.tool === 'heli-route' || (state.tool === 'cover-route' && state.routeMode === 'air');
  function coverHint() {
    if (airRouting()) {
      return !coverDraft ? 'Click where the flight starts (snaps to landing zones) · it keeps a wide berth of marked enemies and AA'
        : !coverDraft.pts ? 'Click where the flight ends' : 'Save it from its popup, or click to start another';
    }
    return !coverDraft ? 'Click where the route starts · the quickest way on foot around marked enemies'
      : !coverDraft.pts ? 'Click where the route ends' : 'Save it from its popup, or click to start another';
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
      const pts = findCoveredRoute(from, xz, ws);
      if (!pts) { toast(`No way through on foot: the sea, minefields or slopes over ${FOOT_MAX_DEG}° block it.`); cancelCoverDraft(); return; }
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
  function findCoveredRoute(from, to, ws) {
    const C = LOS_CELL, pad = Math.min(800, Math.max(250, dist(from, to) * 0.4));
    const x0 = Math.max(0, Math.floor((Math.min(from[0], to[0]) - pad) / C) * C), x1 = Math.min(WORLD, Math.ceil((Math.max(from[0], to[0]) + pad) / C) * C);
    const z0 = Math.max(0, Math.floor((Math.min(from[1], to[1]) - pad) / C) * C), z1 = Math.min(WORLD, Math.ceil((Math.max(from[1], to[1]) + pad) / C) * C);
    const W = Math.round((x1 - x0) / C), H = Math.round((z1 - z0) / C), N = W * H;
    const centre = k => [x0 + (k % W + 0.5) * C, z0 + (Math.floor(k / W) + 0.5) * C];
    const cellOf = ([x, z]) => Math.min(H - 1, Math.max(0, Math.floor((z - z0) / C))) * W + Math.min(W - 1, Math.max(0, Math.floor((x - x0) / C)));
    const hgt = new Float32Array(N), mult = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      const c = centre(k), h = heightAt(c), [seen] = watchedAt(ws, c);
      hgt[k] = h;
      mult[k] = h < 0.5 ? Infinity : 1 + (seen === LOS_CLEAR ? 9 : seen === LOS_TREES ? 1.5 : 0);
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
    const gx = centre(g), vmax = walkSpeed(-0.05);
    const path = aStar(W, H, C, s, g, (k, n, len) => {
      const grade = (hgt[n] - hgt[k]) / len;
      return mult[n] === Infinity || Math.abs(grade) > FOOT_MAX_GRADE ? Infinity : len / walkSpeed(grade) * (mult[k] + mult[n]) / 2;
    }, k => dist(centre(k), gx) / vmax);
    if (!path) return null;
    const cells = path.map(centre);
    cells[0] = from; cells[cells.length - 1] = to;
    let tol = 4, pts = simplify(cells, tol);
    while (pts.length > 200) pts = simplify(cells, tol *= 1.5);
    return pts.map(roundXZ);
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
    const html = () => popupHtml('Foot route', rc ? `${fmtDist(rc.total)} · ${fmtTime(rc.walk)} at a jog` : '', end,
      (rc ? `<p>${rc.watchers ? `${rc.seenClear ? `<b class="rc-no">Seen for ${fmtDist(rc.seenClear)}</b>` : '<b class="rc-ok">Never seen clearly</b>'}` +
        `${rc.seenTrees ? `, <span class="rc-trees">through trees for ${fmtDist(rc.seenTrees)}</span>` : ''}. ` : ''}` +
        `Straight across: ${fmtDist(straight.total)}, ${fmtTime(straight.walk)}${rc.watchers ? `, seen for ${fmtDist(straight.seenClear)}` : ''}.</p>` +
        `<p class="sub">Climbs ${Math.round(rc.climb)} m, descends ${Math.round(rc.descent)} m; steepest stretch ${Math.round(rc.steep * 100)}%.</p>` : '') +
      '<div class="row"><button data-cover="save">Save as route</button><button data-cover="discard">Discard</button></div>' +
      `<p class="sub">The quickest way at a jog (${JOG} m/s on the flat, slower on slopes, nothing over ${FOOT_MAX_DEG}°) that keeps out of sight of marked ` +
      `enemies and ${FOOT_BERTH.infantry} m from soldiers (${FOOT_BERTH.armour} m from armour and AA), off the sea and minefields. Saved, it re-plans itself ` +
      'when enemy markings change. Only as good as the enemies marked; the tree cover is an estimate.</p>');
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
      const n = issueNumber('foot', [...(state.players.get(state.me.name)?.items.values() || [])].filter(i => i.type === 'route' && i.plan).length + 1);
      saveItem({ id: uid(), type: 'route', points: pts, label: `Foot route ${n}`, note: '', color: state.me.color,
        plan: { mode: 'foot', from: pts[0], to: pts[pts.length - 1], at: Date.now() } });
    }
    map.closePopup();
    cancelCoverDraft();
  });

  // --- Landing zone check -------------------------------------------------------------------------------------
  // A spot passes if a 40 m circle is free of trees and gentle enough, and a helicopter can come in over trees and
  // high ground on a 10° descent from at least a few directions. Heights come from the 10 m heightmap and trees from
  // the Forest estimate; buildings, fences, power lines and wrecks aren't in either.
  const LZ_R = 20, LZ_NEAR = 40, LZ_APPROACH = 150, LZ_GLIDE = Math.tan(10 * Math.PI / 180), LZ_OK_DEG = 12, LZ_MAX_DEG = 17;
  const LZ_COLOR = { good: '#51cf66', marginal: '#ffc53d', nogo: '#ff5c5c' };
  const LZ_WORD = { good: 'Good', marginal: 'Marginal', nogo: 'No-go' };
  function lzAssess(xz) {
    if (!HEIGHT) return null;
    const h0 = heightAt(xz);
    let slope = 0, treesIn = false, treesNear = false;
    for (let dx = -LZ_NEAR; dx <= LZ_NEAR; dx += 5) for (let dz = -LZ_NEAR; dz <= LZ_NEAR; dz += 5) {
      const r = Math.hypot(dx, dz), p = [xz[0] + dx, xz[1] + dz];
      if (r > LZ_NEAR) continue;
      if (r <= LZ_R) {
        slope = Math.max(slope, Math.hypot(heightAt([p[0] + 5, p[1]]) - heightAt([p[0] - 5, p[1]]), heightAt([p[0], p[1] + 5]) - heightAt([p[0], p[1] - 5])) / 10);
        if (isForest(p)) treesIn = true;
      } else if (isForest(p)) treesNear = true;
    }
    const open = COMPASS.filter((_, i) => {
      const b = i * Math.PI / 4;
      for (let r = LZ_R + 5; r <= LZ_APPROACH; r += 10) {
        const p = [xz[0] + r * Math.sin(b), xz[1] + r * Math.cos(b)];
        if ((heightAt(p) + (isForest(p) ? TREE_H : 0) - h0) / r > LZ_GLIDE) return false;
      }
      return true;
    });
    const deg = Math.atan(slope) * 180 / Math.PI, nogo = [], marginal = [];
    if (h0 < 0.5) return { verdict: 'nogo', reasons: ['in the water'], deg, treesIn, treesNear, open, h0 };
    if (treesIn) nogo.push('trees on the spot');
    if (deg > LZ_MAX_DEG) nogo.push(`too steep (${Math.round(deg)}°)`); else if (deg > LZ_OK_DEG) marginal.push(`sloping (${Math.round(deg)}°)`);
    if (!open.length) nogo.push('no clear approach'); else if (open.length < 3) marginal.push('few clear approaches');
    if (treesNear && !treesIn) marginal.push('trees close to the edge');
    return { verdict: nogo.length ? 'nogo' : marginal.length ? 'marginal' : 'good', reasons: [...nogo, ...marginal], deg, treesIn, treesNear, open, h0 };
  }
  const lzCache = new Map();
  function lzCheck(xz) {
    const key = `${xz}|${!!HEIGHT}|${!!FOREST}`;
    if (!lzCache.has(key)) {
      if (lzCache.size > 200) lzCache.clear();
      lzCache.set(key, lzAssess(xz));
    }
    return lzCache.get(key);
  }
  // The nearest good spot within 150 m, preferring flat ground with plenty of ways in.
  function betterLz(xz) {
    let best = null;
    for (let dx = -150; dx <= 150; dx += 10) for (let dz = -150; dz <= 150; dz += 10) {
      const r = Math.hypot(dx, dz), p = [xz[0] + dx, xz[1] + dz];
      if (r > 150 || r < 10 || isForest(p) || heightAt(p) < 0.5) continue;
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
    if (!c) return '<p class="sub">The landing zone check needs the terrain heights, which are still loading.</p>';
    let html = `<p class="lz-verdict" style="--c:${LZ_COLOR[c.verdict]}"><b>${LZ_WORD[c.verdict]}</b>${c.reasons.length ? `: ${c.reasons.join(', ')}` : ''}</p>` +
      `<div class="stats"><div><span class="k">Slope</span><span class="v">${Math.round(c.deg)}°</span></div>` +
      `<div><span class="k">Trees</span><span class="v">${c.treesIn ? 'On the spot' : c.treesNear ? 'Near' : 'Clear'}</span></div>` +
      `<div><span class="k">Height</span><span class="v">${Math.round(c.h0)} m</span></div></div>` +
      `<p>Clear approaches: <b>${c.open.length ? c.open.join(' ') : 'none'}</b></p>`;
    if (c.verdict !== 'good') {
      const b = betterLz(it.xz);
      html += b ? `<p>Better spot <b>${fmtDist(b.r)} ${compass(bearing(it.xz, b.xz))}</b>: ${Math.round(b.c.deg)}° slope, approaches ${b.c.open.join(' ')}</p>` +
          (isMine(owner) ? `<div class="row"><button data-lz-move="${esc(it.id)}" data-x="${b.xz[0]}" data-z="${b.xz[1]}">Move the LZ there</button></div>` : '')
        : '<p class="sub">No good spot within 150 m.</p>';
    }
    return html + `<p class="sub">Checks a ${LZ_R * 2} m circle for slope and trees, and which directions a helicopter can come in on a 10° descent ` +
      `over trees (${TREE_H} m) and high ground. Buildings, fences, power lines and wrecks aren't in the data, so look before you land.</p>`;
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
    return html + `<p class="sub">Players can spawn on the radio backpack only while no enemy is within ${RADIO_CLEAR} m. This only knows about enemies ` +
      'marked on the map (units, contacts, snipers and enemy-in-area shapes).</p>';
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
  state.fireShape = 'area';
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
    return { shell, sol: solve(m.weapon, shell, m.xz, fireAim(req)) };
  }
  const fireAim = req => (req.points ? polyCentroid(req.points) : req.xz);
  // A point request's circles. Rounds land within the mortar's spread (the range table's average dispersion for the
  // ring it would use), and every HE round kills within KILL_RADIUS of where it lands. So the spread circle is the
  // kill zone, and KILL_RADIUS further out is the danger zone. Sized for your mortar if it can reach, otherwise the
  // nearest one that can; with no mortar in range the spread is unknown and only one round's radius is drawn.
  const KILL_RADIUS = 20;
  function fireSpread(req) {
    if (!TABLES) return null;
    const mine = myMortar();
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
    const s = fireSpread(req), kill = s ? s.sol.best.dispersion : 0;
    return { s, kill, danger: kill + KILL_RADIUS };
  }
  // Friendly markings a request would put in danger: inside an area or within KILL_RADIUS of it, or inside a point's
  // danger zone.
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
      impactZones(layer, c, fireZones(it).kill, f === FIRE.he, f.color);
    }
    const m = L.marker(toLL(c), { keyboard: false, riseOnHover: true, zIndexOffset: 400, icon: L.divIcon({ className: 'fire-glyph', iconSize: [0, 0],
      html: `<svg viewBox="0 0 24 24" style="--c:${f.color}"><circle cx="12" cy="12" r="8"/><path d="M12 1v7M12 16v7M1 12h7M16 12h7"/></svg>` }) });
    const mine = TABLES && myMortar(), sol = mine && fireSolution(mine, it).sol;
    const name = `${it.label || 'Fire mission'} · ${f.name}${sol ? ` · ${sol.best ? fmtSolution(sol, true) : 'out of range'}` : ''}`;
    m.bindTooltip(esc(isMine(p.name) ? name : `${name} (${p.name})`), { permanent: true, direction: 'right', offset: [14, 0], className: 'item-label fire-label' });
    bindInfo(m, html, () => c);
    layer.addLayer(m);
  }
  function fireHtml(it) {
    const f = FIRE[it.fire] || FIRE.he, c = fireAim(it), he = f === FIRE.he, z = it.points ? null : fireZones(it);
    let size;
    if (it.points) {
      const xs = it.points.map(q => q[0]), zs = it.points.map(q => q[1]);
      size = ['Across', `${Math.round(Math.max(...xs) - Math.min(...xs))} × ${Math.round(Math.max(...zs) - Math.min(...zs))} m`];
    } else size = he ? ['Kill / danger', `${z.kill ? `${z.kill} / ` : ''}${z.danger} m`] : ['Spread', z.kill ? `±${z.kill} m` : '—'];
    let html = `<div class="stats"><div><span class="k">Fire</span><span class="v">${f.name}</span></div>` +
      `<div><span class="k">${size[0]}</span><span class="v">${size[1]}</span></div>` +
      `<div><span class="k">Asked</span><span class="v">${fmtAgo(Date.now() - (it.at || Date.now()))}</span></div></div>` +
      `<p>Aim point${it.points ? ' (middle)' : ''}: grid <b>${grid(c, 4)}</b></p>`;
    if (z) {
      const s = z.s, who = s && `${esc(s.m.label || 'Mortar')}${isMine(s.p.name) ? '' : ` (${esc(s.p.name)})`}`;
      html += s
        ? `<p class="sub">Sized for ${who} on ring ${s.sol.best.ring} with ${esc(s.shell)}: rounds land within about ${z.kill} m of the aim point (the range ` +
          `table's average dispersion)${he ? `, and each round kills within about ${KILL_RADIUS} m of where it lands. Shaded red is the kill zone; the dashed ` +
          `circle ${KILL_RADIUS} m further out is the danger zone.` : '.'}</p>`
        : `<p class="sub">No mortar in range yet, so the spread is unknown${he ? `: the circle shows one round's ${KILL_RADIUS} m kill radius only` : ''}. ` +
          'It is sized automatically once a mortar that can reach it is on the map.</p>';
    }
    if (he) {
      const near = friendliesNear(it, it.points ? KILL_RADIUS : z.danger);
      html += friendlyWarning(near);
    }
    const mortars = allVisibleItems(i => i.type === 'mortar');
    if (!TABLES) html += '<p class="sub">Firing tables are still loading.</p>';
    else if (!mortars.length) html += '<p class="sub">No mortar on the map yet. Place one (Friendly ▾ → Mortar) to get a firing solution here.</p>';
    else {
      html += '<table class="fire trp-table"><tr><th>Mortar</th><th>Shell</th><th>Solution</th></tr>' + mortars.map(({ p, it: m }) => {
        const { shell, sol } = fireSolution(m, it);
        return `<tr><td>${esc(isMine(p.name) ? m.label || 'Mortar' : `${m.label || 'Mortar'} (${p.name})`)}</td><td>${esc(shell)}</td>` +
          `<td>${fmtSolution(sol, true)}</td></tr>`;
      }).join('') + '</table>';
      const mine = myMortar();
      if (mine) html += `<div class="row"><button data-fire-add="${esc(it.id)}">Add as a target on my mortar</button></div>`;
    }
    return html + (it.points ? `<p class="sub">Solutions aim at the middle of the area; walk the rounds across it for anything bigger than the shell's spread.</p>` : '');
  }
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
  const aaLos = it => losGrid(it.xz, it.dir, it.arc, it.range, true, AA_EYE + (it.height || 0), state.heliAlt, 0, false, AA_ELEV);
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
      `<p class="sub">For a helicopter ${state.heliAlt} m above the ground (change it in the options of Enemy ▾ → AA gun or Plan ▾ → Route planner, Air). ` +
      `Unshaded ground inside the arc is hidden from the gun by terrain or more than ${TREE_BLOCK} m of trees; fly low through it. ` +
      `The gun can aim from ${AA_ELEV[0]}° to +${AA_ELEV[1]}°, and a gun inside a wood can't see up through the canopy over it.</p>`;
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
      const los = losGrid(d.xz, dir, AA_ARC, AA_RANGE, false, AA_EYE, state.heliAlt, 0, false, AA_ELEV);
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
    const C = FLY_CELL, W = WORLD / C, ts = heliThreats(), pen = new Float32Array(W * W);
    const centre = k => [(k % W + 0.5) * C, (Math.floor(k / W) + 0.5) * C];
    const cellOf = ([x, z]) => Math.min(W - 1, Math.max(0, Math.floor(z / C))) * W + Math.min(W - 1, Math.max(0, Math.floor(x / C)));
    if (ts.length) for (let k = 0; k < W * W; k++) pen[k] = heliPenalty(ts, centre(k));
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
    if (!fc.threats) html += '<p class="sub">No enemies marked, so this is simply the straight line. Mark AA guns, vehicles and positions first.</p>';
    else if (!fc.near.length) html += `<p><b class="rc-ok">Keeps a wide berth</b> of all ${fc.threats} marked enemies.</p>`;
    else {
      html += '<table class="fire trp-table"><tr><th>Passes</th><th>Closest</th><th>Berth</th></tr>' + fc.near.slice(0, 6).map(x =>
        `<tr><td>${esc(x.name)}</td><td>${x.min < x.hard ? `<span class="no">${fmtDist(x.min)}</span>` : fmtDist(x.min)}</td><td>${fmtDist(x.hard)}</td></tr>`).join('') + '</table>';
    }
    return html + `<p class="sub">At ${HELI_KMH} km/h, ${state.heliAlt} m above the ground. Berths: AA guns ${fmtDist(HELI_BERTH.aa.hard)} plus all they can see, ` +
      `armour and enemy vehicles ${fmtDist(HELI_BERTH.armour.hard)}, soldiers and contacts ${fmtDist(HELI_BERTH.infantry.hard)}, enemy-in-area shapes ` +
      `${fmtDist(HELI_BERTH.area.hard)}. Only as good as the enemies marked on the map.</p>`;
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
    return html + '<p class="sub">Anyone in the room can move the request on with the buttons above.</p>';
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
    const text = [it.label || 'Contact', it.size, mins < 1 ? 'now' : `${mins} min`].filter(Boolean).join(' · ');
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

  // Popup details for the planning and hazard markings
  function planPopupHtml(owner, it) {
    if (it.type === 'overwatch') return overwatchHtml(it);
    if (isMarker(it, 'lz')) return lzHtml(owner, it);
    if (it.type === 'post' || isPositionCard(it)) {
      const los = postLos(it), enemy = isEnemyPost(it), alt = heightAt(it.xz), kind = POST_KIND[it.side] || POST_KIND.f;
      let html = `<div class="stats"><div><span class="k">Reach</span><span class="v">${fmtDist(it.range)}</span></div>` +
        `<div><span class="k">${enemy ? 'Enemy sees' : 'Sees'}</span><span class="v">${los ? los.pct + '%' : '—'}</span></div>` +
        `<div><span class="k">Height</span><span class="v">${alt != null ? Math.round(alt) + ' m' : '—'}</span></div></div>`;
      if (los && los.treePct) html += `<p class="sub">Plus ${los.treePct}% only through trees</p>`;
      if (!enemy) {
        const trps = allVisibleItems(i => i.type === 'marker' && i.icon === 'trp').map(({ it: t }) => t)
          .sort((a, b) => bearing(it.xz, a.xz) - bearing(it.xz, b.xz));
        html += trps.length
          ? `<table class="fire trp-table"><tr><th>TRP</th><th>Distance</th><th>Bearing</th><th>Seen</th></tr>${trps.map(t => trpRow(t.label || 'TRP', it.xz, t.xz, los)).join('')}</table>`
          : '<p class="sub">Add target reference points with Defend ▾ → TRP (D then 1) to get their distance and bearing from here.</p>';
      }
      html += `<p class="sub">${enemy ? `Red shading is ground ${kind.who} here can see clearly; yellow only through trees. Keep out of both.`
        : 'Tinted ground is seen from here, yellow only through trees; dark ground is hidden from every range card.'} ` +
        `Seen from ${kind.eye} m up (${kind.who}), looking for a standing soldier's chest (${TARGET_H} m). Trees are ${TREE_H} m tall; more than ${TREE_BLOCK} m of woods in the way hides the ground completely. Buildings aren't included.</p>`;
      return html;
    }
    if (it.type === 'marker' && it.icon === 'trp') {
      const rows = allVisibleItems(isRangeCard).map(({ p, it: post }) => trpRow(cardName(p, post), post.xz, it.xz, postLos(post)));
      const me = myPosition();
      if (me && !isPositionCard(me)) rows.push(trpRow('My position', me.xz, it.xz, null));
      return rows.length ? `<table class="fire trp-table"><tr><th>From</th><th>Distance</th><th>Bearing</th><th>Seen</th></tr>${rows.join('')}</table>`
        : '<p class="sub">Give your position a range card (Friendly ▾ → My position, then pick its reach) or place friendly armour with line of sight to get the distance and bearing to this point.</p>';
    }
    if (it.type === 'sectors') {
      return `<table class="fire trp-table"><tr><th>Sector</th><th>Bearings</th><th>Covered by</th></tr>` + sectorSpans(it).map(([a, b], i) =>
        `<tr><td><span class="sec-id" style="--c:${SECTOR_COLORS[i % SECTOR_COLORS.length]}">${SECTOR_LETTERS[i]}</span></td>` +
        `<td>${pad(Math.round(a) % 360, 3)}°–${pad(Math.round(b) % 360, 3)}°</td><td>${esc((it.names || [])[i] || '—')}</td></tr>`).join('') + '</table>' +
        (isMine(owner) ? '<p class="sub">Edit to assign who covers each sector.</p>' : '');
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
      return `<div class="stats wrap"><div><span class="k">How many</span><span class="v">${esc(it.size || '?')}</span></div>` +
        `<div><span class="k">Doing</span><span class="v">${esc(it.activity || '?')}</span></div>` +
        `<div><span class="k">Heading</span><span class="v">${hd}</span></div></div>` +
        (it.kit ? `<p>Carrying <b>${esc(it.kit)}</b></p>` : '') +
        `<p class="sub">Seen ${fmtAgo(Date.now() - (it.at || Date.now()))} · ${timeoutText(it)}</p>`;
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

  $('#fia-form').addEventListener('submit', e => {
    e.preventDefault();
    const input = $('#fia-input');
    if (!FIA_KNOWN.length) return fiaMessage('Cache locations are still loading.', 'err');
    const xz = parseCoords(input.value);
    if (!xz) return fiaMessage('Could not read that. Try a grid like "089 028" or "0890 0281", or X/Z metres like "8908 2811".', 'err');
    if (xz === 'off') return fiaMessage("Those coordinates are off the map. Everon grids run from 000 to 128.", 'err');
    const hit = nearestFia(xz);
    const where = `${hit.cache.name} (${grid(hit.cache.xz)})`;
    if (!addFiaCache(hit.cache.name)) return;
    input.value = '';
    if (hit.d > FIA_FAR) fiaMessage(`Snapped to ${where}, but it's ${fmtDist(hit.d)} from what you typed. Double-check the coordinates.`, 'warn');
    else fiaMessage(`Snapped to ${where}, ${fmtDist(hit.d)} from your coordinates.`, 'ok');
    flyAndOpen(hit.cache.xz, () => fiaPopup(hit.cache));
  });

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
      const data = JSON.parse(await file.text());
      const items = (Array.isArray(data) ? data : data.items || []).filter(it => it && ['marker', 'route', 'range', 'mortar', 'fia', 'emplacement', 'construct', 'area', 'arrow', 'ambush', 'post', 'sectors', 'overwatch', 'aa'].includes(it.type));
      if (!items.length) throw new Error('No markings found in that file.');
      for (const it of items) {
        // One mortar and one FIA list per player: imported ones replace (mortar) or merge into (FIA) yours.
        const existing = it.type === 'mortar' ? myMortar() : it.type === 'fia' ? myFia() : null;
        const extra = it.type === 'fia' && existing ? { caches: [...new Set([...existing.caches, ...(it.caches || [])])] } : {};
        await saveItem({ ...it, ...extra, id: existing ? existing.id : uid() });
      }
      toast(`Imported ${items.length} marking${items.length === 1 ? '' : 's'}.`);
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

  // Sidebar sections: one column, each opened and closed from its heading. Which are closed is remembered in this
  // browser (safe to lose); the mortar and FIA sections start closed.
  const SEC_KEY = 'everon-map-closed-sections';
  const SECTIONS = {
    players: 'Players', briefing: 'Briefing', markings: 'My markings', mortar: 'Mortar', fia: 'FIA caches this game', layers: 'Map layers',
  };
  let closedSections;
  try { closedSections = new Set(JSON.parse(localStorage.getItem(SEC_KEY) || '["mortar","fia"]')); } catch { closedSections = new Set(['mortar', 'fia']); }
  const sectionEl = name => document.querySelector(`.acc[data-sec="${name}"]`);
  const sectionOpen = name => !closedSections.has(name);
  function setSection(name, open) {
    const el = sectionEl(name);
    open ? closedSections.delete(name) : closedSections.add(name);
    el.classList.toggle('closed', !open);
    el.querySelector('.acc-head').setAttribute('aria-expanded', open);
    if (open && name === 'briefing') $('#briefing-dot').classList.add('hidden');
    try { localStorage.setItem(SEC_KEY, JSON.stringify([...closedSections])); } catch { /* storage unavailable */ }
  }
  function showSection(name, reveal = true) { // open a section and scroll to it (reveal: open the sidebar too)
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
      : '<div class="empty">No briefing yet. Anyone in the room can write one: the plan, radio channels, rally points and who does what.</div>';
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
    if (!sectionOpen('briefing') || $('#sidebar').classList.contains('collapsed')) $('#briefing-dot').classList.remove('hidden');
    toast(`${b.by} updated the briefing`);
  }
  function editBriefing() {
    showSection('briefing');
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

  // ---------------------------------------------------------------------------
  // Tool finder (Ctrl+K): every tool, layer switch and sidebar action, searchable by name
  // ---------------------------------------------------------------------------
  let paletteItems = [], paletteSel = 0;
  function paletteEntries() {
    const out = [];
    out.push({ name: 'Select', sub: 'Tool', key: 'Q', icon: $('#toolbar [data-tool="pan"] svg').outerHTML, run: () => setTool('pan') });
    Object.values(TOOL).forEach(t => out.push({ name: t.name, sub: `${t.group.name} menu`, key: toolKeys(t.tool), icon: t.icon, run: () => setTool(t.tool) }));
    Object.entries(SECTIONS).forEach(([sec, name]) => out.push({ name, sub: 'Sidebar section', run: () => showSection(sec) }));
    const toggle = (cb, name, sub) => out.push({ name: `${cb.checked ? 'Hide' : 'Show'} ${name}`, sub,
      run: () => { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); } });
    document.querySelectorAll('#panels .layer').forEach(row => toggle(row.querySelector('input'), row.querySelector('.lbl').textContent.toLowerCase(), 'Map layer'));
    toggle($('#show-grid'), 'grid lines', 'Map layer');
    toggle($('#show-others'), "other players' markings", 'Players');
    out.push(
      { name: briefing && briefing.text.trim() ? 'Edit the briefing' : 'Write a briefing', sub: 'Briefing', run: editBriefing },
      { name: 'Copy invite link', sub: `Room ${state.me.room}`, run: () => $('#room-copy').click() },
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
  // Session: username prompt every visit, nothing remembered
  // ---------------------------------------------------------------------------
  function showJoin(message) {
    if (state.es) { state.es.terminate(); state.es = null; }
    state.me = null;
    [...state.players.keys()].forEach(removePlayer);
    refreshLists();
    $('#identity').classList.add('hidden');
    closeBriefingEditor();
    $('#join-error').textContent = message || '';
    $('#join').classList.remove('hidden');
    setTimeout(() => $('#join-name').focus(), 0);
  }

  $('#join-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    $('#join-error').textContent = '';
    try {
      const me = await api('/api/join', { name: $('#join-name').value, room: $('#join-room').value });
      state.me = me;
      $('#me-avatar').style.background = me.color;
      $('#me-avatar').textContent = [...me.name][0].toUpperCase();
      $('#me-name').textContent = me.name;
      // The room code goes in the address (after #, so it never reaches the server's logs): a reload or an
      // invite link fills it in again.
      history.replaceState(null, '', `#room=${encodeURIComponent(me.room)}`);
      $('#room-code').textContent = me.room;
      $('#identity').classList.remove('hidden');
      $('#join').classList.add('hidden');
      document.activeElement?.blur(); // so tool hotkeys work straight away
      connect();
    } catch (err) {
      $('#join-error').textContent = err.message === 'Failed to fetch' ? 'Cannot reach the map server. Check your connection and try again.' : err.message;
    } finally {
      btn.disabled = false;
    }
  });

  // Updates arrive through live-worker.js, which checks in with the server about once a second.
  function connect() {
    const { id, token } = state.me;
    const live = new Worker('live-worker.js');
    state.es = live;
    live.onmessage = ({ data: m }) => {
      if (state.es !== live) return;
      if (m.type === 'events') m.events.forEach(ev => { try { onEvent(ev); } catch (err) { console.error(err); } });
      else if (m.type === 'bye') showJoin(m.reason || 'Your session ended. Enter a username to rejoin.');
      else if (m.type === 'closed') showJoin('Lost connection to the map server. Enter a username to rejoin.');
    };
    live.postMessage({ type: 'start', id, token });
  }

  // Closing the tab removes your markings right away; if this signal is lost the server drops you after 15 s.
  let left = false;
  function leave() {
    if (!state.me || left) return;
    left = true;
    const body = JSON.stringify({ id: state.me.id, token: state.me.token });
    if (!navigator.sendBeacon('/api/leave', body)) {
      fetch('/api/leave', { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'application/json' } }).catch(() => {});
    }
  }
  window.addEventListener('pagehide', leave);
  window.addEventListener('beforeunload', leave);

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  fetch('data/everon.json')
    .then(r => r.json())
    .then(d => { buildReference(d); refreshFia(); })
    .catch(err => { console.error(err); toast('Could not load reference data.', 6000); });
  // Mortars, MG nests and the terrain checks depend on the tables, heightmap and trees, so redraw them once those load.
  const rerenderMortars = () => state.players.forEach(p => p.items.forEach(it => {
    if (['mortar', 'emplacement', 'overwatch', 'route', 'aa'].includes(it.type) || isMarker(it, 'lz')) renderItem(p, it);
  }));
  fetch('data/mortar-tables.json')
    .then(r => r.json())
    .then(t => { TABLES = t; fillMortarSelects(); rerenderMortars(); refreshLists(); updateHint(); })
    .catch(err => { console.error(err); toast('Could not load mortar firing tables.', 6000); });
  fetch('data/everon-forest.bin')
    .then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
    .then(buf => {
      FOREST = new Uint8Array(buf);
      forestLayer.redraw();
      LZ_GRID = null; lzShadeLayer.redraw();
      losCache.clear(); // line of sight worked out before the trees arrived is redone with them
      rerenderMortars();
      refreshCoverage(true);
    })
    .catch(err => console.error('Forest estimate not loaded', err));
  fetch('data/everon-height.bin')
    .then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
    .then(buf => { HEIGHT = new Int16Array(buf); LZ_GRID = null; rerenderMortars(); refreshLists(); contourLayer.redraw(); hillshadeLayer.redraw(); lzShadeLayer.redraw(); })
    .catch(err => { console.error(err); toast('Could not load terrain heights - mortar solutions ignore elevation.', 6000); });
  $('#join-name').focus();
})();

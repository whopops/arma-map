// Everon 3D: fly or walk around Everon, drawn from the game's own terrain and objects.
//
// Near the camera, each 500 m tile is drawn from the detailed export (terrain every 1 m, objects every 0.5 m), at
// less detail further out. Beyond that, the whole island is one coarse mesh from the 10 m heights, with forests and
// towns raised to their height so the horizon still looks right. Meshes are built in background workers.
//
// Game coordinates: X runs east, Z runs north, Y is up, in metres (0..12800). Rendering is done relative to the
// camera so positions stay precise, and Z is flipped on the way to the GPU (the game's axes are left-handed).
(async () => {
  'use strict';

  // The map (maps.json beside this page, written by reforger-map-tools' `rmt.py fieldmap`): ?map=<name> picks one. Its
  // size, chunk grid, light-grid size and the metres per terrain step (0.01 for most, 0.02 where the hills are too high
  // for centimetres) come from there. Everything else is the field map's own data for that map (/data/maps/<name>/:
  // los/, light/, plants/, foliage/, places.json, roads.json), plus the shaped trees (trees/) only this view draws.
  const $ = s => document.querySelector(s);
  let CFG;
  try { CFG = await fetch('maps.json', { cache: 'no-cache' }).then(r => r.json()); }
  catch (err) { $('#start').textContent = `Couldn't read maps.json: ${err.message}`; return; }
  const MAP_NAME = CFG.maps[new URLSearchParams(location.search).get('map')] ? new URLSearchParams(location.search).get('map') : CFG.default;
  const MAP = CFG.maps[MAP_NAME], DIR = `/data/maps/${MAP_NAME}/`;
  const WORLD = MAP.world, TILE = MAP.tile, NT = Math.max(MAP.cols, MAP.rows), LN = MAP.lightCols, LCELL = MAP.lightCell;
  const UNIT = MAP.unit;                     // metres per terrain step
  document.title = `${MAP.title} 3D`;
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } },
  };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const rad = d => d * Math.PI / 180;

  const canvas = $('#gl');
  const gl = canvas.getContext('webgl2', { antialias: true, powerPreference: 'high-performance' });
  if (!gl) { $('#start').textContent = 'This needs a browser with WebGL 2 (Chrome, Edge or Firefox).'; return; }

  // ---------------------------------------------------------------------------
  // Shaders
  // ---------------------------------------------------------------------------
  const LIGHT = `
    uniform vec3 uSun, uFog; uniform float uFogD;
    vec3 shade(vec3 col, vec3 n, vec3 w) {
      float d = max(dot(n, uSun), 0.0);
      vec3 c = col * (0.30 + 0.22 * (0.5 + 0.5 * n.y) + 0.62 * d);
      float r = length(w) / uFogD;
      return mix(c, uFog, 1.0 - exp(-r * r));
    }`;

  // terrain tiles (mode 0), the whole-island mesh (mode 1) and the sea (mode 2)
  const GROUND_VS = `#version 300 es
    layout(location=0) in vec4 aPos; layout(location=1) in vec4 aNrm; layout(location=2) in vec4 aCol;
    uniform mat4 uVP; uniform vec3 uOff, uScale;
    out vec3 vW, vN, vCol;
    void main() {
      vec3 w = aPos.xyz * uScale + uOff;
      vW = w; vN = aNrm.xyz; vCol = aCol.rgb;
      gl_Position = uVP * vec4(w.x, w.y, -w.z, 1.0);
    }`;
  const GROUND_FS = `#version 300 es
    precision highp float;
    in vec3 vW, vN, vCol; out vec4 o;
    uniform int uMode, uNT; uniform vec3 uCam; uniform highp sampler2D uMask;
    // the room's markings painted on the ground: three pictures, finest first (the first two follow the camera, the
    // last is the whole map), each placed by (x0, z0, size) in metres
    uniform bool uOv; uniform sampler2D uOv0, uOv1, uOv2; uniform vec3 uOvP0, uOvP1, uOvP2;
    ${LIGHT}
    void main() {
      vec3 wp = vW + uCam;
      if (uMode != 2 && wp.y < 0.04) discard;           // sea: the water surface shows instead
      if (uMode == 1) {                                   // island mesh: hidden where a detailed tile is drawn
        ivec2 t = ivec2(floor(wp.xz / 500.0));
        if (t.x >= 0 && t.y >= 0 && t.x < uNT && t.y < uNT && texelFetch(uMask, t, 0).r > 0.5) discard;
      }
      vec3 n = normalize(vN), col = vCol;
      if (uMode == 2) {
        n = vec3(0.0, 1.0, 0.0);
        col = vec3(0.22, 0.35, 0.45);
      }
      if (uOv) {
        vec2 u0 = (wp.xz - uOvP0.xy) / uOvP0.z, u1 = (wp.xz - uOvP1.xy) / uOvP1.z, u2 = (wp.xz - uOvP2.xy) / uOvP2.z;
        vec4 a0 = texture(uOv0, u0), a1 = texture(uOv1, u1), a2 = texture(uOv2, u2);
        bool in0 = all(greaterThan(u0, vec2(0.002))) && all(lessThan(u0, vec2(0.998)));
        bool in1 = all(greaterThan(u1, vec2(0.002))) && all(lessThan(u1, vec2(0.998)));
        vec4 ov = in0 ? a0 : in1 ? a1 : a2;
        col = mix(col, ov.rgb, ov.a);
      }
      vec3 c = shade(col, n, vW);
      if (uMode == 2) {
        vec3 v = normalize(-vW), h = normalize(v + uSun);
        float glint = pow(max(dot(n, h), 0.0), 160.0) * 0.7;
        float r = length(vW) / uFogD;
        c += vec3(1.0, 0.95, 0.85) * glint * exp(-r * r);
      }
      o = vec4(c, 1.0);
    }`;

  // objects: one box per cell, from its underside to its top
  const BOX_VS = `#version 300 es
    layout(location=0) in vec3 aCorner; layout(location=1) in vec3 aFN;
    layout(location=2) in vec4 aInst; layout(location=3) in vec4 aInfo;
    uniform mat4 uVP; uniform vec3 uOff; uniform float uCell;
    out vec3 vW, vN; out float vRel, vUp; flat out int vKind; flat out float vTrunk, vVar, vEave;
    void main() {
      float yB = aInst.z * 0.02, yT = aInst.w * 0.02;
      vec3 p = vec3(aInst.x * 0.5 + aCorner.x * uCell, mix(yB, yT, aCorner.y), aInst.y * 0.5 + aCorner.z * uCell);
      vec3 w = p + uOff;
      vW = w; vN = aFN; vRel = aCorner.y;
      vUp = p.y - (yB + 0.3);                             // height above the ground (buildings sit 0.3 m into it)
      vKind = int(aInfo.x + 0.5); vTrunk = aInfo.y; vEave = aInfo.z * 0.25; vVar = 0.92 + 0.16 * aInfo.w / 255.0;
      gl_Position = uVP * vec4(w.x, w.y, -w.z, 1.0);
    }`;
  const BOX_FS = `#version 300 es
    precision highp float;
    in vec3 vW, vN; in float vRel, vUp; flat in int vKind; flat in float vTrunk, vVar, vEave; out vec4 o;
    uniform bool uTrees;
    ${LIGHT}
    void main() {
      if (!uTrees && (vKind == 3 || vKind == 5)) discard;   // trees off: no trees, bushes or stumps
      float r = vRel;
      vec3 c;
      if (vKind == 1) {                                   // buildings: warm plaster walls up to the eave, red roofs
        float k = clamp(vUp / max(vEave, 2.5), 0.0, 1.0);
        c = vec3(172.0 + 38.0 * k, 122.0 + 24.0 * k, 96.0 + 14.0 * k);
        if (vN.y > 0.5 || (vEave > 0.0 && vUp > vEave + 0.15)) c = vec3(150.0, 70.0, 55.0);
      } else if (vKind == 2) {                            // walls, rocks, poles, wrecks
        c = vec3(196.0 + 22.0 * r);
      } else if (vKind == 3) {                            // trees, trunk low down
        c = vec3(40.0 + 50.0 * r, 95.0 + 80.0 * r, 45.0 + 40.0 * r);
        if (vTrunk > 0.5 && r < 0.45) c = vec3(95.0, 70.0, 50.0);
      } else {                                            // bushes and low plants
        c = vec3(62.0 + 50.0 * r, 108.0 + 62.0 * r, 42.0 + 30.0 * r);
      }
      c = c / 255.0 * vVar;
      o = vec4(shade(c, vN, vW), 1.0);
    }`;

  // trees and bushes: a lathe of 7 rings (trunk bottom, trunk top, 5 up the crown) per instance. Each species' rings
  // (height, and radius as a fraction of the tree's own crown radius, or of its height for the two trunk rings) come from the uProf texture, its bark and
  // leaf colours from uCol.
  const TREE_VS = `#version 300 es
    layout(location=0) in vec2 aV;                        // ring, side
    layout(location=1) in vec3 aP;                        // base: x cm, y 2 cm, z cm
    layout(location=2) in vec4 aI;                        // species, yaw, height (0.25 m), crown radius (0.1 m)
    layout(location=3) in vec2 aVar;
    uniform mat4 uVP; uniform vec3 uOff; uniform float uSides;
    uniform highp sampler2D uProf; uniform highp sampler2D uCol;
    out vec3 vW, vN, vCol;
    float h1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
    void main() {
      int sp = int(aI.x + 0.5), ring = int(aV.x + 0.5);
      float H = aI.z * 0.25, R = aI.w * 0.1, v = aVar.x / 255.0;
      float th = (aV.y / uSides + v) * 6.2831853;
      vec2 p0 = texelFetch(uProf, ivec2(ring, sp), 0).rg;
      vec2 pa = texelFetch(uProf, ivec2(max(ring - 1, 0), sp), 0).rg;
      vec2 pb = texelFetch(uProf, ivec2(min(ring + 1, 6), sp), 0).rg;
      float wob = 1.0 + 0.16 * (h1(aV.y * 7.0 + v * 91.0 + float(ring) * 3.1) - 0.5);
      float rr = p0.y * (ring < 2 ? H : R) * wob;             // the trunk's radius is a fraction of the height
      vec3 l = vec3(cos(th) * rr * (0.9 + 0.2 * v), p0.x * H - (ring == 0 ? 0.4 : 0.0), sin(th) * rr * (1.1 - 0.2 * v));
      float ra = pa.y * (max(ring - 1, 0) < 2 ? H : R), rb = pb.y * (min(ring + 1, 6) < 2 ? H : R);
      float dy = max((pb.x - pa.x) * H, 0.05), dr = rb - ra;
      vN = normalize(normalize(vec3(cos(th) * dy, -dr, sin(th) * dy)) + vec3(0.0, 0.25, 0.0));
      vec3 tc = texelFetch(uCol, ivec2(0, sp), 0).rgb, cc = texelFetch(uCol, ivec2(1, sp), 0).rgb;
      vCol = mix(tc, cc, step(1.5, float(ring))) * (0.85 + 0.3 * v);
      vec3 w = vec3(aP.x * 0.01, aP.y * 0.02, aP.z * 0.01) + l + uOff;
      vW = w;
      gl_Position = uVP * vec4(w.x, w.y, -w.z, 1.0);
    }`;
  const TREE_FS = `#version 300 es
    precision highp float;
    in vec3 vW, vN, vCol; out vec4 o;
    ${LIGHT}
    void main() { o = vec4(shade(vCol * 1.25, normalize(vN), vW), 1.0); }`;

  // measured tree shapes (the map's plants/ and foliage.json, as the field map has them): per plant a stepped lathe of 21 rings, two per tenth
  // of its height (bottom and top of that layer at the layer's measured half-width) and a point on top. Ring heights,
  // radii and how densely each layer blocks sight come from the uShape texture (one row per kind); flat-shaded.
  const PLANT_VS = `#version 300 es
    layout(location=0) in vec2 aV;                        // ring, side
    layout(location=1) in vec3 aP;                        // base: x, ground y, z (m, from the tile's corner)
    layout(location=2) in vec4 aI;                        // kind, scale (1/100), variation, bush flag
    uniform mat4 uVP; uniform vec3 uOff; uniform float uSides;
    uniform highp sampler2D uShape;
    out vec3 vW; out float vDens, vAlpha; flat out float vBush;
    void main() {
      int kind = int(aI.x + 0.5), ring = int(aV.x + 0.5);
      float s = aI.y / 100.0, v = aI.z / 255.0;
      vec4 p = texelFetch(uShape, ivec2(ring, kind), 0);   // y (m at scale 1), r (m), k (per m)
      float th = (aV.y / uSides + v) * 6.2831853;
      vec3 w = aP + vec3(cos(th) * p.y * s, p.x * s, sin(th) * p.y * s) + uOff;
      vW = w; vDens = clamp(p.z / s / 0.6, 0.0, 1.0); vBush = aI.w;
      // what a sight line straight through this layer loses: 1 - e^(-k x its width); the scale cancels (k / s x 2 r s).
      // It crosses two faces of the shape (front and back), so each face gets 1 - sqrt(1 - that).
      float blocked = 1.0 - exp(-p.z * 2.0 * p.y);
      vAlpha = 1.0 - sqrt(max(1.0 - blocked, 0.0));
      gl_Position = uVP * vec4(w.x, w.y, -w.z, 1.0);
    }`;
  const PLANT_FS = `#version 300 es
    precision highp float;
    in vec3 vW; in float vDens, vAlpha; flat in float vBush; out vec4 o;
    uniform bool uSeeThrough;
    ${LIGHT}
    void main() {
      vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
      n.z = -n.z;                                         // derivatives are in game axes except z, flipped for the GPU
      if (n.y < -0.2) n = -n;
      vec3 c = vBush > 0.5 ? vec3(120.0, 160.0, 70.0) : vec3(60.0, 110.0, 60.0);
      if (uSeeThrough) { o = vec4(shade(c / 255.0, n, vW), vAlpha); return; }   // opacity is the measure, not the shade
      c = c / 255.0 * (0.5 + 0.5 * vDens);
      o = vec4(shade(c, n, vW), 1.0);
    }`;

  // roads and foot paths: flat ribbons on the terrain (built in the worker), coloured by kind
  const ROAD_VS = `#version 300 es
    layout(location=0) in vec3 aPos; layout(location=1) in float aKind;
    uniform mat4 uVP; uniform vec3 uOff;
    out vec3 vW; flat out int vKind;
    void main() {
      vec3 w = aPos + uOff;
      vW = w; vKind = int(aKind + 0.5);
      gl_Position = uVP * vec4(w.x, w.y, -w.z, 1.0);
    }`;
  const ROAD_FS = `#version 300 es
    precision highp float;
    in vec3 vW; flat in int vKind; out vec4 o;
    ${LIGHT}
    void main() {
      vec3 c = vKind == 0 ? vec3(62.0, 62.0, 66.0) : vKind == 1 ? vec3(92.0, 92.0, 95.0)
             : vKind == 2 ? vec3(142.0, 118.0, 86.0) : vec3(160.0, 140.0, 104.0);
      o = vec4(shade(c / 255.0, vec3(0.0, 1.0, 0.0), vW), 1.0);
    }`;

  // the room's markings (see "Room markings" below): plain coloured boxes, turned about the vertical. Instance: bottom
  // centre (game metres, absolute), size (along, up, across), turn (radians, from east towards north) and colour
  // (0xRRGGBB, exact in a float).
  const PROP_VS = `#version 300 es
    layout(location=0) in vec3 aCorner; layout(location=1) in vec3 aFN;
    layout(location=2) in vec3 aAt; layout(location=3) in vec3 aSize; layout(location=4) in vec2 aTurnCol;
    uniform mat4 uVP; uniform vec3 uCam;
    out vec3 vW, vN, vCol;
    void main() {
      float c = cos(aTurnCol.x), s = sin(aTurnCol.x);
      vec3 l = (aCorner - vec3(0.5, 0.0, 0.5)) * aSize;
      vec3 w = aAt - uCam + vec3(l.x * c - l.z * s, l.y, l.x * s + l.z * c);
      vW = w; vN = vec3(aFN.x * c - aFN.z * s, aFN.y, aFN.x * s + aFN.z * c);
      vCol = vec3(floor(aTurnCol.y / 65536.0), mod(floor(aTurnCol.y / 256.0), 256.0), mod(aTurnCol.y, 256.0)) / 255.0;
      gl_Position = uVP * vec4(w.x, w.y, -w.z, 1.0);
    }`;
  const PROP_FS = `#version 300 es
    precision highp float;
    in vec3 vW, vN, vCol; out vec4 o;
    ${LIGHT}
    void main() { o = vec4(shade(vCol, normalize(vN), vW), 1.0); }`;

  const SKY_VS =`#version 300 es
    const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
    out vec2 vP;
    void main() { vP = P[gl_VertexID]; gl_Position = vec4(vP, 0.0, 1.0); }`;
  const SKY_FS = `#version 300 es
    precision highp float;
    in vec2 vP; out vec4 o;
    uniform mat4 uInv; uniform vec3 uFog, uSunGL;
    void main() {
      vec4 q = uInv * vec4(vP, 1.0, 1.0);
      vec3 d = normalize(q.xyz / q.w);
      vec3 zen = vec3(0.40, 0.58, 0.80);
      vec3 c = mix(uFog, zen, smoothstep(0.0, 0.45, d.y));
      float s = max(dot(d, uSunGL), 0.0);
      c += vec3(1.0, 0.92, 0.75) * (pow(s, 900.0) * 1.2 + pow(s, 12.0) * 0.18);
      o = vec4(c, 1.0);
    }`;

  function program(vs, fs) {
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
    return { p, u };
  }
  const groundProg = program(GROUND_VS, GROUND_FS);
  const boxProg = program(BOX_VS, BOX_FS);
  const skyProg = program(SKY_VS, SKY_FS);
  const treeProg = program(TREE_VS, TREE_FS);
  const plantProg = program(PLANT_VS, PLANT_FS);
  const roadProg = program(ROAD_VS, ROAD_FS);
  const propProg = program(PROP_VS, PROP_FS);

  // ---------------------------------------------------------------------------
  // Matrices (column-major)
  // ---------------------------------------------------------------------------
  function perspective(fovy, aspect, near, far) {
    const t = 1 / Math.tan(fovy / 2), o = new Float32Array(16);
    o[0] = t / aspect; o[5] = t; o[10] = (far + near) / (near - far); o[11] = -1; o[14] = 2 * far * near / (near - far);
    return o;
  }
  function viewDir(f) { // eye at the origin looking along f, +Y up
    let s = [f[1] * 0 - f[2] * 1, f[2] * 0 - f[0] * 0, f[0] * 1 - f[1] * 0]; // f x up
    const L = Math.hypot(...s); s = s.map(v => v / L);
    const u = [s[1] * f[2] - s[2] * f[1], s[2] * f[0] - s[0] * f[2], s[0] * f[1] - s[1] * f[0]];
    const o = new Float32Array(16);
    o[0] = s[0]; o[4] = s[1]; o[8] = s[2];
    o[1] = u[0]; o[5] = u[1]; o[9] = u[2];
    o[2] = -f[0]; o[6] = -f[1]; o[10] = -f[2];
    o[15] = 1;
    return o;
  }
  function mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  }
  function invert(a) {
    const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = a;
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    const det = 1 / (b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06);
    return new Float32Array([
      (a11 * b11 - a12 * b10 + a13 * b09) * det, (a02 * b10 - a01 * b11 - a03 * b09) * det,
      (a31 * b05 - a32 * b04 + a33 * b03) * det, (a22 * b04 - a21 * b05 - a23 * b03) * det,
      (a12 * b08 - a10 * b11 - a13 * b07) * det, (a00 * b11 - a02 * b08 + a03 * b07) * det,
      (a32 * b02 - a30 * b05 - a33 * b01) * det, (a20 * b05 - a22 * b02 + a23 * b01) * det,
      (a10 * b10 - a11 * b08 + a13 * b06) * det, (a01 * b08 - a00 * b10 - a03 * b06) * det,
      (a30 * b04 - a31 * b02 + a33 * b00) * det, (a21 * b02 - a20 * b04 - a23 * b00) * det,
      (a11 * b07 - a10 * b09 - a12 * b06) * det, (a00 * b09 - a01 * b07 + a02 * b06) * det,
      (a31 * b01 - a30 * b03 - a32 * b00) * det, (a20 * b03 - a21 * b01 + a22 * b00) * det,
    ]);
  }

  // ---------------------------------------------------------------------------
  // Settings and camera
  // ---------------------------------------------------------------------------
  const settings = {
    detail: store.get('e3d-detail', 'normal'),
    range: +store.get('e3d-range', '2000'),
    sun: +store.get('e3d-sun', '220'),
    names: store.get('e3d-names', '1') === '1',
    trees: store.get('e3d-trees', '1') === '1',
    roads: store.get('e3d-roads', '1') === '1',
    marks: store.get('e3d-marks', '1') === '1',     // the room's markings
    los: store.get('e3d-los', '1') === '1',         // ...and their line of sight
    smooth: store.get('e3d-smooth', '1') === '1',   // trees as shapes; off = the game's 0.5 m scan as boxes
    measured: store.get('e3d-measured', '0') === '1', // trees as their kind's measured 10-layer shape (data/plants)
    seeThrough: store.get('e3d-see', '0') === '1',     // ...drawn as see-through as they were measured
  };
  const cam = { x: MAP.start[0], z: MAP.start[1], y: NaN, yaw: 40, pitch: -14, walk: false, speed: 40 };
  (() => { // a position saved in the address (#x,z,y,yaw,pitch,walk) wins
    const p = location.hash.slice(1).split(',').map(Number);
    if (p.length >= 5 && p.every(Number.isFinite)) {
      [cam.x, cam.z, cam.y, cam.yaw, cam.pitch] = p;
      cam.walk = p[5] === 1;
    }
  })();

  // ---------------------------------------------------------------------------
  // The whole island, coarse (10 m heights, canopy and building heights)
  // ---------------------------------------------------------------------------
  let HEIGHT = null, CANOPY = null, BLD = null;
  function farHeight(x, z) {
    if (!HEIGHT) return 0;
    const fx = clamp(x / LCELL - 0.5, 0, LN - 1), fz = clamp(z / LCELL - 0.5, 0, LN - 1);
    const c0 = Math.floor(fx), r0 = Math.floor(fz), c1 = Math.min(c0 + 1, LN - 1), r1 = Math.min(r0 + 1, LN - 1);
    const tx = fx - c0, tz = fz - r0, H = i => HEIGHT[i] / 10;
    return (H(r0 * LN + c0) * (1 - tx) + H(r0 * LN + c1) * tx) * (1 - tz) + (H(r1 * LN + c0) * (1 - tx) + H(r1 * LN + c1) * tx) * tz;
  }

  // the same soft patchiness as the worker's tiles
  function hash(x, z) {
    let h = (Math.imul(x, 374761393) + Math.imul(z, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function vnoise(x, z) {
    const xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi;
    const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
    const a = hash(xi, zi), b = hash(xi + 1, zi), c = hash(xi, zi + 1), d = hash(xi + 1, zi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function groundColour(x, z, h, ny, out) {
    const n = 0.9 + 0.14 * vnoise(x / 70, z / 70) + 0.06 * vnoise(x / 13, z / 13);
    let r = 95, g = 118, b = 70;
    const rock = clamp((0.82 - ny) / 0.22, 0, 1);
    r += (128 - r) * rock; g += (120 - g) * rock; b += (102 - b) * rock;
    const sand = clamp((1.6 - h) / 1.2, 0, 1);
    r += (176 - r) * sand; g += (165 - g) * sand; b += (122 - b) * sand;
    out[0] = Math.min(255, r * n); out[1] = Math.min(255, g * n); out[2] = Math.min(255, b * n);
  }

  let far = null, farBare = null;   // the island with its forests raised, and bare ground (for trees off)
  function buildFar(bare) {
    const N = Math.round(WORLD / 20) + 1, S = WORLD / (N - 1), P = LN * LN;   // a point about every 20 m, to the world's edge
    const y = new Float32Array(N * N), tree = new Float32Array(N * N), bld = new Float32Array(N * N);
    const g = new Float32Array(N * N);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i, X = i * S, Z = j * S;
        g[k] = farHeight(X, Z);
        // the four 10 m cells meeting at this point
        let tr = 0, b = 0, bf = 0;
        for (const [dc, dr] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
          const c = clamp(X / LCELL + dc, 0, LN - 1), r = clamp(Z / LCELL + dr, 0, LN - 1), idx = r * LN + c;
          tr += CANOPY[idx] * Math.min(1, CANOPY[3 * P + idx] / 255 * 1.4);
          b += BLD[idx]; if (BLD[idx]) bf++;
        }
        tree[k] = tr / 4; bld[k] = bf / 4;
        y[k] = g[k] + Math.max(bare ? 0 : tree[k], b / 4 * 0.7) * 0.9;
      }
    }
    const buf = new ArrayBuffer(N * N * 20), f32 = new Float32Array(buf), i8 = new Int8Array(buf), u8 = new Uint8Array(buf);
    const col = [0, 0, 0];
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i, o = k * 20;
        const il = Math.max(i - 1, 0), ir = Math.min(i + 1, N - 1), jd = Math.max(j - 1, 0), ju = Math.min(j + 1, N - 1);
        let nx = -(y[j * N + ir] - y[j * N + il]) / ((ir - il) * S), nz = -(y[ju * N + i] - y[jd * N + i]) / ((ju - jd) * S), ny = 1;
        const L = Math.hypot(nx, ny, nz); nx /= L; ny /= L; nz /= L;
        f32[o / 4] = i * S; f32[o / 4 + 1] = g[k] < 0.04 && y[k] === g[k] ? 0 : Math.max(y[k], 0.05); f32[o / 4 + 2] = j * S;
        i8[o + 12] = Math.round(nx * 127); i8[o + 13] = Math.round(ny * 127); i8[o + 14] = Math.round(nz * 127);
        groundColour(i * S, j * S, g[k], ny, col);
        const t = bare ? 0 : clamp(tree[k] / 12, 0, 1), bb = bld[k] * 0.8;
        for (let c = 0; c < 3; c++) {
          let v = col[c] + ([62, 128, 60][c] - col[c]) * t;
          v += ([150, 70, 55][c] - v) * bb;
          u8[o + 16 + c] = v;
        }
        u8[o + 19] = 255;
      }
    }
    const idx = new Uint32Array((N - 1) * (N - 1) * 6);
    let n = 0;
    for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
      const a = j * N + i;
      idx[n++] = a; idx[n++] = a + 1; idx[n++] = a + N; idx[n++] = a + 1; idx[n++] = a + N + 1; idx[n++] = a + N;
    }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, buf, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.BYTE, true, 20, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 20, 16);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    if (bare) farBare = { vao, count: n }; else far = { vao, count: n };
  }

  // the sea: one big square at the water line
  const sea = (() => {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vb = gl.createBuffer(), E = 60000;
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-E, 0, -E, E, 0, -E, -E, 0, E, E, 0, E]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.vertexAttrib4f(1, 0, 1, 0, 0); gl.vertexAttrib4f(2, 0, 0, 0, 1);
    gl.bindVertexArray(null);
    return vao;
  })();

  // which tiles are drawn in detail (the island mesh hides itself there)
  const maskData = new Uint8Array(NT * NT);
  let maskDirty = true;
  const maskTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, maskTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, NT, NT, 0, gl.RED, gl.UNSIGNED_BYTE, maskData);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  // ---------------------------------------------------------------------------
  // Detailed tiles, built by workers
  // ---------------------------------------------------------------------------
  const box = (() => {
    const F = [
      [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1], [1, 0, 0]], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0], [-1, 0, 0]],
      [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], [0, -1, 0]],
      [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]], [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0], [0, 0, -1]],
    ];
    const v = [], idx = [];
    F.forEach((f, i) => {
      for (let k = 0; k < 4; k++) v.push(...f[k], ...f[4]);
      idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
    });
    const vb = gl.createBuffer(), ib = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
    return { vb, ib };
  })();

  // Tree crowns: a 7-ring lathe with 10 sides up close, 5 further out; the rings themselves come from the species table.
  const treeMesh = [10, 5].map(S => {
    const v = [], idx = [];
    for (let r = 0; r < 7; r++) for (let a = 0; a < S; a++) v.push(r, a);
    for (let r = 0; r < 6; r++) for (let a = 0; a < S; a++) {
      const i0 = r * S + a, i1 = r * S + (a + 1) % S, j0 = i0 + S, j1 = i1 + S;
      idx.push(i0, i1, j1, i0, j1, j0);
    }
    const vb = gl.createBuffer(), ib = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
    return { S, vb, ib, count: idx.length };
  });
  const TREE_FORMAT = 2;          // must match FORMAT in reforger-map-tools' rmtlib/trees.py
  let treeTex = null;              // { prof, col } once data/trees/species.json has loaded
  function makeTreeTextures(species) {
    const n = species.length, prof = new Float32Array(7 * n * 2), col = new Uint8Array(2 * n * 4);
    species.forEach((sp, i) => {
      sp.ring.forEach(([y, r], k) => { prof[(i * 7 + k) * 2] = y; prof[(i * 7 + k) * 2 + 1] = r; });
      col.set([...sp.trunk, 255, ...sp.crown, 255], i * 8);
    });
    const tex = (fmt, ifmt, type, w, data) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, n, 0, fmt, type, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return t;
    };
    treeTex = { prof: tex(gl.RG, gl.RG32F, gl.FLOAT, 7, prof), col: tex(gl.RGBA, gl.RGBA8, gl.UNSIGNED_BYTE, 2, col) };
  }

  // Measured tree shapes: a stepped lathe (see PLANT_VS), 12 sides; its rings come from each kind's row of uShape.
  const PLANT_RINGS = 21, PLANT_SIDES = 12;
  const plantMesh = (() => {
    const v = [], idx = [];
    for (let r = 0; r < PLANT_RINGS; r++) for (let a = 0; a < PLANT_SIDES; a++) v.push(r, a);
    for (let r = 0; r < PLANT_RINGS - 1; r++) for (let a = 0; a < PLANT_SIDES; a++) {
      const i0 = r * PLANT_SIDES + a, i1 = r * PLANT_SIDES + (a + 1) % PLANT_SIDES, j0 = i0 + PLANT_SIDES, j1 = i1 + PLANT_SIDES;
      idx.push(i0, i1, j1, i0, j1, j0);
    }
    const vb = gl.createBuffer(), ib = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
    return { vb, ib, count: idx.length };
  })();
  let plantInfo = null;            // the map's foliage.json once loaded, plus the shape texture
  const plantTiles = new Map();    // name -> { vao, vb, count } or { loading } / { none }
  function makePlantShapes(fol) {
    const n = fol.plants.length, shape = new Float32Array(PLANT_RINGS * n * 4);
    fol.plants.forEach((p, i) => {
      for (let r = 0; r < PLANT_RINGS; r++) {
        const j = Math.min(r >> 1, 9), top = r === PLANT_RINGS - 1;
        const y = top ? p.h : (j + (r & 1)) * p.h / fol.bins;
        const o = (i * PLANT_RINGS + r) * 4;
        shape[o] = y; shape[o + 1] = top ? 0 : p.hw[j]; shape[o + 2] = p.k[j];
      }
    });
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, PLANT_RINGS, n, 0, gl.RGBA, gl.FLOAT, shape);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const bush = fol.prefabs.map(p => (/\/Bush\//.test(p) ? 1 : 0));
    plantInfo = { ...fol, tex: t, bush, tiles: new Set(fol.tiles) };
  }
  // one tile's plants (those standing in it), as instances: Float32 x, ground y, z (m from the tile's corner);
  // Uint8 kind, scale (1/100), variation, bush flag
  async function loadPlantTile(name) {
    plantTiles.set(name, { loading: true });
    try {
      const raw = new Uint8Array(await fetchGz(`${DIR}plants/${name}.bin.gz`));
      const dv = new DataView(raw.buffer), n = dv.getUint32(0, true), m = plantInfo.margin, unit = plantInfo.baseUnit;
      const out = new ArrayBuffer(n * 16), f32 = new Float32Array(out), u8 = new Uint8Array(out);
      let k = 0;
      for (let i = 0; i < n; i++) {
        const x = dv.getUint16(4 + 2 * i, true) / 100 - m, z = dv.getUint16(4 + 2 * n + 2 * i, true) / 100 - m;
        const y = dv.getUint16(4 + 4 * n + 2 * i, true) * unit;
        if (x < 0 || x >= TILE || z < 0 || z >= TILE || y < 0.1) continue;   // listed with its own tile, or in the water
        const kind = raw[4 + 6 * n + i];
        f32[k * 4] = x; f32[k * 4 + 1] = y; f32[k * 4 + 2] = z;
        u8[k * 16 + 12] = kind; u8[k * 16 + 13] = raw[4 + 7 * n + i];
        u8[k * 16 + 14] = hash(Math.round(x * 100) + 31, Math.round(z * 100) + 17) * 255; u8[k * 16 + 15] = plantInfo.bush[kind];
        k++;
      }
      if (!plantTiles.has(name)) return;                  // dropped while loading
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, plantMesh.vb);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, plantMesh.ib);
      const vb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, out.slice(0, k * 16), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 16, 0); gl.vertexAttribDivisor(1, 1);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, false, 16, 12); gl.vertexAttribDivisor(2, 1);
      gl.bindVertexArray(null);
      plantTiles.set(name, { vao, vb, count: k });
    } catch (err) {
      lastError = String(err.message || err);
      plantTiles.set(name, { none: true });
    }
  }
  function freePlantTile(name) {
    const p = plantTiles.get(name);
    if (p && p.vao) { gl.deleteVertexArray(p.vao); gl.deleteBuffer(p.vb); }
    plantTiles.delete(name);
  }

  let land = null;                 // names of the tiles that have land
  const tiles = new Map();         // name -> record
  const NW = clamp((navigator.hardwareConcurrency || 4) - 1, 1, 4);
  const workers = Array.from({ length: NW }, () => {
    const w = new Worker('worker.js');
    w.postMessage({ type: 'config', maxTiles: Math.ceil(40 / NW) + 4, dir: DIR });
    w.onmessage = e => onWorker(e.data);
    return w;
  });
  let genCounter = 0, lastError = '';

  function lodFor(d) {
    const T = settings.detail === 'high'
      ? [[150, 1, 0.5], [450, 1, 1], [1000, 2, 2], [2200, 5, 4]]
      : [[300, 1, 1], [700, 2, 2], [1600, 5, 4]];
    for (const [lim, t, o] of T) if (d < lim) return [t, o];
    return [10, 4];
  }

  function freeTile(rec) {
    for (const k of ['tVao', 'oVao', 'trVao', 'rVao']) if (rec[k]) gl.deleteVertexArray(rec[k]);
    for (const k of ['tVb', 'tIb', 'oVb', 'trVb', 'rVb', 'rIb']) if (rec[k]) gl.deleteBuffer(rec[k]);
    rec.tVao = rec.oVao = rec.trVao = rec.rVao = rec.tVb = rec.tIb = rec.oVb = rec.trVb = rec.rVb = rec.rIb = null;
  }

  function onWorker(m) {
    const rec = tiles.get(m.name);
    if (m.type === 'error') {
      lastError = m.error;
      if (rec && rec.gen === m.gen) rec.retryAt = performance.now() + 4000;
      return;
    }
    if (!rec || rec.gen !== m.gen) return;
    rec.lod = `${m.t}|${m.o}|${m.smooth ? 1 : 0}`;
    if (m.sea) { rec.sea = true; return; }
    if (m.ter) { rec.ter = new Uint16Array(m.ter); if (markings.me) propsDirty = true; }   // markings sit on this ground
    freeTile(rec);
    // terrain
    rec.tVao = gl.createVertexArray();
    gl.bindVertexArray(rec.tVao);
    rec.tVb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, rec.tVb);
    gl.bufferData(gl.ARRAY_BUFFER, m.tv, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.UNSIGNED_SHORT, false, 16, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.BYTE, true, 16, 8);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 16, 12);
    rec.tIb = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, rec.tIb);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.ti, gl.STATIC_DRAW);
    rec.tCount = m.tCount;
    // objects
    rec.oCount = m.iCount; rec.cell = m.o;
    if (m.iCount) {
      rec.oVao = gl.createVertexArray();
      gl.bindVertexArray(rec.oVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, box.vb);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, box.ib);
      rec.oVb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, rec.oVb);
      gl.bufferData(gl.ARRAY_BUFFER, m.inst, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.UNSIGNED_SHORT, false, 12, 0);
      gl.vertexAttribDivisor(2, 1);
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, false, 12, 8);
      gl.vertexAttribDivisor(3, 1);
    }
    // trees
    rec.trCount = m.trCount || 0;
    if (rec.trCount && treeTex) {
      const mesh = treeMesh[m.o >= 2 ? 1 : 0];
      rec.trMesh = mesh;
      rec.trVao = gl.createVertexArray();
      gl.bindVertexArray(rec.trVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vb);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ib);
      rec.trVb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, rec.trVb);
      gl.bufferData(gl.ARRAY_BUFFER, m.tinst, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.UNSIGNED_SHORT, false, 12, 0); gl.vertexAttribDivisor(1, 1);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, false, 12, 6); gl.vertexAttribDivisor(2, 1);
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 2, gl.UNSIGNED_BYTE, false, 12, 10); gl.vertexAttribDivisor(3, 1);
    }
    // roads and foot paths
    rec.rCount = m.rCount || 0;
    if (rec.rCount) {
      rec.rVao = gl.createVertexArray();
      gl.bindVertexArray(rec.rVao);
      rec.rVb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, rec.rVb);
      gl.bufferData(gl.ARRAY_BUFFER, m.rv, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);
      rec.rIb = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, rec.rIb);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.ri, gl.STATIC_DRAW);
    }
    gl.bindVertexArray(null);
    rec.ymin = m.ymin - 1; rec.ymax = m.ymax + 1;
    maskData[rec.tz * NT + rec.tx] = 255; maskDirty = true;   // R8 texture: 255 reads as 1.0 in the shader
  }

  // Which tiles we want, at what detail; runs a few times a second.
  function updateTiles() {
    if (!land) return;
    const hag = Math.max(0, cam.y - groundAt(cam.x, cam.z));
    const now = performance.now();
    const jobs = workers.map(() => []);
    let wanted = 0, ready = 0;
    for (let tz = 0; tz < NT; tz++) {
      for (let tx = 0; tx < NT; tx++) {
        const name = `${tx}_${tz}`;
        if (!land.has(name)) continue;
        const x0 = tx * TILE, z0 = tz * TILE;
        const dx = Math.max(x0 - cam.x, 0, cam.x - x0 - TILE), dz = Math.max(z0 - cam.z, 0, cam.z - z0 - TILE);
        const d = Math.hypot(dx, dz, hag * 0.7);
        let rec = tiles.get(name);
        if (d > settings.range + (rec ? 250 : 0)) {
          if (rec) { freeTile(rec); tiles.delete(name); maskData[tz * NT + tx] = 0; maskDirty = true; }
          if (plantTiles.has(name)) freePlantTile(name);
          continue;
        }
        // measured shapes: loaded for the tiles within 1.2 km while the toggle is on
        if (settings.measured && plantInfo && d < 1200 && plantInfo.tiles.has(name) && !plantTiles.has(name)) loadPlantTile(name);
        if ((!settings.measured || d > 1400) && plantTiles.has(name) && !plantTiles.get(name).loading) freePlantTile(name);
        if (!rec) { rec = { name, tx, tz, gen: ++genCounter, lod: null, ter: null }; tiles.set(name, rec); }
        const [t, o] = lodFor(d), smooth = settings.smooth, want = `${t}|${o}|${smooth ? 1 : 0}`;
        wanted++;
        if (rec.lod) ready++;
        if (rec.lod === want || (rec.retryAt && now < rec.retryAt)) continue;
        jobs[(tx * 31 + tz) % NW].push({ d, key: `${name}|${want}|${rec.gen}`, gen: rec.gen, name, t, o, smooth, wantTer: !rec.ter });
      }
    }
    workers.forEach((w, i) => {
      jobs[i].sort((a, b) => a.d - b.d);
      w.postMessage({ type: 'jobs', jobs: jobs[i] });
    });
    const busy = jobs.reduce((s, j) => s + j.length, 0);
    const sightNote = settings.los && markings.me && sight.working ? ` · working out line of sight (${sight.working})` : '';
    $('#hud-load').textContent = lastError ? `Tile problem: ${lastError}`
      : (busy ? `Loading detail… ${ready}/${wanted} tiles` : `${wanted} tiles in detail`) + sightNote;
  }

  function groundAt(x, z) {
    const tx = Math.floor(x / TILE), tz = Math.floor(z / TILE), rec = tiles.get(`${tx}_${tz}`);
    if (rec && rec.ter) {
      const T = rec.ter, lx = clamp(x - tx * TILE, 0, 499.999), lz = clamp(z - tz * TILE, 0, 499.999);
      const c = Math.floor(lx), r = Math.floor(lz), fx = lx - c, fz = lz - r;
      const a = T[r * 501 + c], b = T[r * 501 + c + 1], d = T[(r + 1) * 501 + c], e = T[(r + 1) * 501 + c + 1];
      return ((a + (b - a) * fx) * (1 - fz) + (d + (e - d) * fx) * fz) * UNIT;
    }
    if (rec && rec.sea) return 0;
    return Math.max(0, farHeight(x, z));
  }

  // ---------------------------------------------------------------------------
  // Room markings: everything players have drawn on the field map (room.js), looking as marks.js says. What stands up
  // is drawn as boxes (PROP_VS); what lies on the ground is painted into three pictures the terrain is tinted with
  // (GROUND_FS): half a metre a pixel for the nearest 500 m or so, 2 m a pixel out to 2 km (both following the camera)
  // and one of the whole map. All of it is rebuilt when the markings change, as detailed tiles load (their ground is
  // more exact), and every 20 s while some markings can time out.
  // ---------------------------------------------------------------------------
  const PROP_FLOATS = 8;                      // x, y, z, along, up, across, turn, colour
  let props = { vao: null, vb: null, count: 0 }, propsDirty = false, propsBuiltAt = 0;
  let structLabels = [];                      // { xz, y, text, color, dim, el }
  let fieldSpots = null;                      // the map's reference file (MAP.poi): the FIA cache spots and Conflict points, by name
  let mortarTables = null;                    // /data/mortar-tables.json: the mortars' firing tables (mortar.js)
  let FOREST = null;                          // <map>/light/forest.bin.gz: 10 m cells in a forest, packed bits
  const inForest = (x, z) => {
    if (!FOREST || x < 0 || z < 0 || x >= LN * LCELL || z >= LN * LCELL) return false;
    const k = Math.floor(z / LCELL) * LN + Math.floor(x / LCELL);
    return !!((FOREST[k >> 3] >> (7 - (k & 7))) & 1);
  };
  // line of sight, worked out in the background (los.js); each answer redraws the markings
  const sight = Los({
    size: WORLD, losDir: `${DIR}los`,
    profiles: { json: `${DIR}foliage/foliage_profiles.json`, plants: `${DIR}foliage.json`, dir: `${DIR}plants` },
  }, () => { propsDirty = true; });
  const marksEnv = () => ({ ground: groundAt, field: fieldSpots, tables: mortarTables, los: settings.los ? sight.grid : null, forest: inForest });
  const markings = Room(CFG.rooms || '/api', {
    onChange: () => { propsDirty = true; },
    onStatus: (state, text, removed) => roomStatus(state, text, removed),
  });

  const OV = 2048;                            // pixels a side
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');   // keeps the paint sharp when seen at a low angle
  function makeOverlay(size) {
    const c = document.createElement('canvas');
    c.width = c.height = OV;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    return { c, ctx: c.getContext('2d'), tex, x0: 0, z0: 0, size, follows: size < WORLD, fresh: false };
  }
  const overlay = { levels: [makeOverlay(1024), makeOverlay(4096), makeOverlay(WORLD)], any: false };
  if (new URLSearchParams(location.search).has('debug')) window.e3d = { overlay, cam, markings };   // for the console
  // Paints the markings into a picture of the square (x0, z0)-(x0 + size, z0 + size): canvas x is game x, canvas y is
  // game z (so the shader reads it straight off the ground position).
  function paintOverlay(o, x0, z0, size) {
    o.x0 = x0; o.z0 = z0; o.size = size;
    const s = size / OV, ctx = o.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, OV, OV);
    ctx.setTransform(1 / s, 0, 0, 1 / s, -x0 / s, -z0 / s);
    Marks.paint(ctx, markings.players, marksEnv(), s);
    gl.bindTexture(gl.TEXTURE_2D, o.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, o.c);
    gl.generateMipmap(gl.TEXTURE_2D);
  }
  // The finer pictures follow the camera, each repainted once the camera is a quarter of the way to its edge (at most
  // one a frame). With `all`, every picture is repainted (the markings changed).
  function updateOverlays(all = false) {
    if (all) for (const o of overlay.levels) o.fresh = false;
    if (!overlay.any || !settings.marks) return;
    for (const o of overlay.levels) {
      if (!o.follows) { if (!o.fresh) { paintOverlay(o, 0, 0, o.size); o.fresh = true; } continue; }
      const cx = o.x0 + o.size / 2, cz = o.z0 + o.size / 2;
      if (o.fresh && Math.abs(cam.x - cx) < o.size / 4 && Math.abs(cam.z - cz) < o.size / 4) continue;
      const snap = v => Math.round(v / (o.size / 16)) * (o.size / 16) - o.size / 2;
      paintOverlay(o, snap(cam.x), snap(cam.z), o.size);
      o.fresh = true;
      if (!all) return;
    }
  }

  function buildProps() {
    const { boxes, labels } = Marks.build(markings.players, marksEnv());
    const data = new Float32Array(boxes);
    if (!props.vao) {
      props.vao = gl.createVertexArray();
      gl.bindVertexArray(props.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, box.vb);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, box.ib);
      props.vb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, props.vb);
      const S = PROP_FLOATS * 4;
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, S, 0); gl.vertexAttribDivisor(2, 1);
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 3, gl.FLOAT, false, S, 12); gl.vertexAttribDivisor(3, 1);
      gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 2, gl.FLOAT, false, S, 24); gl.vertexAttribDivisor(4, 1);
      gl.bindVertexArray(null);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, props.vb);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    props.count = data.length / PROP_FLOATS;

    // the pictures on the ground
    overlay.any = [...markings.players.values()].some(p => p.items.size);
    updateOverlays(true);

    // their labels: the name the player gave it, in the player's colour (or the colour of what it is)
    for (const l of structLabels) l.el.remove();
    const lab = $('#labels');
    structLabels = labels.map(l => {
      const el = document.createElement('div');
      el.className = 'label mark';
      el.textContent = l.text;
      el.style.color = l.color;
      el.title = `Marked by ${l.owner}`;
      lab.appendChild(el);
      return { ...l, y: groundAt(l.xz[0], l.xz[1]) + l.h, el };
    });
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------
  const keys = new Set();
  const typing = e => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox';
  addEventListener('keydown', e => {
    if (typing(e)) return;
    keys.add(e.code);
    if (e.code === 'KeyF') setWalk(!cam.walk);
    if (e.code === 'KeyM') $('#mini').classList.toggle('big');
    if (e.code === 'KeyH') $('#help').classList.toggle('hidden');
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  });
  addEventListener('keyup', e => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());
  canvas.addEventListener('click', () => { if (document.pointerLockElement !== canvas) canvas.requestPointerLock(); });
  addEventListener('mousemove', e => {
    if (document.pointerLockElement !== canvas) return;
    cam.yaw = (cam.yaw + e.movementX * 0.12 + 360) % 360;
    cam.pitch = clamp(cam.pitch - e.movementY * 0.12, -89, 89);
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    cam.speed = clamp(cam.speed * (e.deltaY > 0 ? 1 / 1.25 : 1.25), 3, 800);
  }, { passive: false });

  function setWalk(on) {
    cam.walk = on;
    $('#mode').textContent = on ? 'Fly' : 'Walk';
    if (on) cam.pitch = clamp(cam.pitch, -60, 60);
  }

  function move(dt) {
    const fast = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    const s = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    const u = (keys.has('Space') || keys.has('KeyE') ? 1 : 0) - (keys.has('KeyC') || keys.has('KeyQ') ? 1 : 0);
    const sy = Math.sin(rad(cam.yaw)), cy = Math.cos(rad(cam.yaw)), cp = Math.cos(rad(cam.pitch)), sp = Math.sin(rad(cam.pitch));
    if (cam.walk) {
      const v = (fast ? 6.5 : 3.5) * dt, L = Math.hypot(f, s) || 1;
      cam.x += (sy * f + cy * s) / L * v;
      cam.z += (cy * f - sy * s) / L * v;
      const target = groundAt(cam.x, cam.z) + 1.7;
      cam.y += (target - cam.y) * Math.min(1, dt * 12);
    } else {
      const v = cam.speed * (fast ? 4 : 1) * dt;
      cam.x += (sy * cp * f + cy * s) * v;
      cam.z += (cy * cp * f - sy * s) * v;
      cam.y += (sp * f + u) * v;
      cam.y = Math.max(cam.y, groundAt(cam.x, cam.z) + 1.2);
      cam.y = Math.min(cam.y, 6000);
    }
    cam.x = clamp(cam.x, -3000, WORLD + 3000);
    cam.z = clamp(cam.z, -3000, WORLD + 3000);
  }

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------
  const FOG = [185 / 255, 200 / 255, 215 / 255];
  let VP = null, lastW = 0, lastH = 0;

  function sunVec() {
    const az = rad(settings.sun), alt = rad(42);
    return [Math.sin(az) * Math.cos(alt), Math.sin(alt), Math.cos(az) * Math.cos(alt)];
  }

  // Is a box (relative to the camera, game axes) at least partly on screen?
  function onScreen(x0, y0, z0, x1, y1, z1) {
    const out = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 8; i++) {
      const x = i & 1 ? x1 : x0, y = i & 2 ? y1 : y0, z = -(i & 4 ? z1 : z0);
      const cx = VP[0] * x + VP[4] * y + VP[8] * z + VP[12], cy = VP[1] * x + VP[5] * y + VP[9] * z + VP[13];
      const cz = VP[2] * x + VP[6] * y + VP[10] * z + VP[14], w = VP[3] * x + VP[7] * y + VP[11] * z + VP[15];
      if (cx < -w) out[0]++; if (cx > w) out[1]++; if (cy < -w) out[2]++; if (cy > w) out[3]++;
      if (cz < -w) out[4]++; if (cz > w) out[5]++;
    }
    return out.every(n => n < 8);
  }

  let drawn = 0;
  function render() {
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    const W = Math.round(innerWidth * dpr), H = Math.round(innerHeight * dpr);
    if (W !== lastW || H !== lastH) { canvas.width = W; canvas.height = H; lastW = W; lastH = H; }
    gl.viewport(0, 0, W, H);

    const hag = Math.max(0, cam.y - groundAt(cam.x, cam.z));
    const near = clamp(hag * 0.03, 0.2, 6), fogD = 3500 + settings.range * 1.6;
    const cp = Math.cos(rad(cam.pitch));
    const f = [Math.sin(rad(cam.yaw)) * cp, Math.sin(rad(cam.pitch)), -Math.cos(rad(cam.yaw)) * cp];
    VP = mul(perspective(rad(62), W / H, near, 60000), viewDir(f));
    const sun = sunVec(), sunGL = [sun[0], sun[1], -sun[2]];

    // sky
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.useProgram(skyProg.p);
    gl.uniformMatrix4fv(skyProg.u.uInv, false, invert(VP));
    gl.uniform3fv(skyProg.u.uFog, FOG);
    gl.uniform3fv(skyProg.u.uSunGL, sunGL);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);

    const common = (P) => {
      gl.useProgram(P.p);
      gl.uniformMatrix4fv(P.u.uVP, false, VP);
      gl.uniform3fv(P.u.uSun, sun);
      gl.uniform3fv(P.u.uFog, FOG);
      gl.uniform1f(P.u.uFogD, fogD);
    };

    // detailed tiles
    common(groundProg);
    gl.uniform3f(groundProg.u.uCam, cam.x, cam.y, cam.z);
    gl.uniform1i(groundProg.u.uOv, overlay.any && settings.marks ? 1 : 0);
    overlay.levels.forEach((o, i) => {
      gl.activeTexture(gl.TEXTURE3 + i);
      gl.bindTexture(gl.TEXTURE_2D, o.tex);
      gl.uniform1i(groundProg.u[`uOv${i}`], 3 + i);
      gl.uniform3f(groundProg.u[`uOvP${i}`], o.x0, o.z0, o.size);
    });
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform3f(groundProg.u.uScale, 0.01, 0.02, 0.01);
    gl.uniform1i(groundProg.u.uMode, 0);
    const vis = [];
    for (const rec of tiles.values()) {
      if (!rec.tVao) continue;
      const x0 = rec.tx * TILE - cam.x, z0 = rec.tz * TILE - cam.z;
      if (!onScreen(x0, rec.ymin - cam.y, z0, x0 + TILE, rec.ymax - cam.y, z0 + TILE)) continue;
      vis.push(rec);
      gl.uniform3f(groundProg.u.uOff, x0, -cam.y, z0);
      gl.bindVertexArray(rec.tVao);
      gl.drawElements(gl.TRIANGLES, rec.tCount, gl.UNSIGNED_INT, 0);
    }

    // the rest of the island, and the sea
    if (maskDirty) {
      gl.bindTexture(gl.TEXTURE_2D, maskTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, NT, NT, gl.RED, gl.UNSIGNED_BYTE, maskData);
      maskDirty = false;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, maskTex);
    gl.uniform1i(groundProg.u.uMask, 0);
    gl.uniform1i(groundProg.u.uNT, NT);
    gl.uniform3f(groundProg.u.uScale, 1, 1, 1);
    gl.uniform3f(groundProg.u.uOff, -cam.x, -cam.y, -cam.z);
    const island = settings.trees ? far : farBare || far;
    if (island) {
      gl.uniform1i(groundProg.u.uMode, 1);
      gl.bindVertexArray(island.vao);
      gl.drawElements(gl.TRIANGLES, island.count, gl.UNSIGNED_INT, 0);
    }
    gl.uniform1i(groundProg.u.uMode, 2);
    gl.bindVertexArray(sea);
    gl.vertexAttrib4f(1, 0, 1, 0, 0);
    gl.vertexAttrib4f(2, 0, 0, 0, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // roads and foot paths, just above the ground they lie on
    if (settings.roads) {
      common(roadProg);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-2, -2);
      for (const rec of vis) {
        if (!rec.rVao) continue;
        gl.uniform3f(roadProg.u.uOff, rec.tx * TILE - cam.x, -cam.y, rec.tz * TILE - cam.z);
        gl.bindVertexArray(rec.rVao);
        gl.drawElements(gl.TRIANGLES, rec.rCount, gl.UNSIGNED_INT, 0);
      }
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }

    // objects
    const measured = settings.trees && settings.measured && plantInfo;
    common(boxProg);
    gl.uniform1i(boxProg.u.uTrees, settings.trees && !measured ? 1 : 0);   // measured shapes replace the tree boxes
    drawn = 0;
    for (const rec of vis) {
      if (!rec.oVao) continue;
      gl.uniform3f(boxProg.u.uOff, rec.tx * TILE - cam.x, -cam.y, rec.tz * TILE - cam.z);
      gl.uniform1f(boxProg.u.uCell, rec.cell);
      gl.bindVertexArray(rec.oVao);
      gl.drawElementsInstanced(gl.TRIANGLES, 36, gl.UNSIGNED_SHORT, 0, rec.oCount);
      drawn += rec.oCount;
    }

    // the room's markings
    if (settings.marks && props.count) {
      common(propProg);
      gl.uniform3f(propProg.u.uCam, cam.x, cam.y, cam.z);
      gl.bindVertexArray(props.vao);
      gl.drawElementsInstanced(gl.TRIANGLES, 36, gl.UNSIGNED_SHORT, 0, props.count);
    }

    // trees and bushes as their measured shapes
    if (measured) {
      common(plantProg);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, plantInfo.tex);
      gl.uniform1i(plantProg.u.uShape, 1);
      gl.uniform1f(plantProg.u.uSides, PLANT_SIDES);
      // see-through: blended over what's already drawn, not hiding what's behind (plants aren't sorted, so where
      // several overlap the order of blending isn't exact; the total opacity is)
      const see = settings.seeThrough;
      gl.uniform1i(plantProg.u.uSeeThrough, see ? 1 : 0);
      if (see) { gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false); }
      for (const rec of vis) {
        const p = plantTiles.get(rec.name);
        if (!p || !p.vao) continue;
        gl.uniform3f(plantProg.u.uOff, rec.tx * TILE - cam.x, -cam.y, rec.tz * TILE - cam.z);
        gl.bindVertexArray(p.vao);
        gl.drawElementsInstanced(gl.TRIANGLES, plantMesh.count, gl.UNSIGNED_SHORT, 0, p.count);
        drawn += p.count;
      }
      if (see) { gl.disable(gl.BLEND); gl.depthMask(true); }
      gl.activeTexture(gl.TEXTURE0);
    }

    // trees and bushes
    if (treeTex && settings.trees && !measured) {
      common(treeProg);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, treeTex.prof);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, treeTex.col);
      gl.uniform1i(treeProg.u.uProf, 1);
      gl.uniform1i(treeProg.u.uCol, 2);
      for (const rec of vis) {
        if (!rec.trVao) continue;
        gl.uniform3f(treeProg.u.uOff, rec.tx * TILE - cam.x, -cam.y, rec.tz * TILE - cam.z);
        gl.uniform1f(treeProg.u.uSides, rec.trMesh.S);
        gl.bindVertexArray(rec.trVao);
        gl.drawElementsInstanced(gl.TRIANGLES, rec.trMesh.count, gl.UNSIGNED_SHORT, 0, rec.trCount);
        drawn += rec.trCount;
      }
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.bindVertexArray(null);
  }

  // ---------------------------------------------------------------------------
  // Place names
  // ---------------------------------------------------------------------------
  let places = [];
  // a point in game metres on screen (CSS pixels), or null when it's behind the camera, off screen or over maxD away
  function project(px, py, pz, maxD) {
    const x = px - cam.x, z = -(pz - cam.z), y = py - cam.y, d = Math.hypot(x, y, z);
    const cx = VP[0] * x + VP[4] * y + VP[8] * z + VP[12], cy = VP[1] * x + VP[5] * y + VP[9] * z + VP[13];
    const w = VP[3] * x + VP[7] * y + VP[11] * z + VP[15];
    if (w <= 0 || d > maxD || Math.abs(cx / w) > 1.1 || Math.abs(cy / w) > 1.1) return null;
    return { x: (cx / w * 0.5 + 0.5) * innerWidth, y: (0.5 - cy / w * 0.5) * innerHeight, d };
  }
  function updateLabels() {
    // the room's markings, named out to 1 km (faded when a unit or contact report is getting old)
    for (const l of structLabels) {
      const s = settings.marks && VP && project(l.xz[0], l.y, l.xz[1], 1000);
      if (!s) { l.el.style.display = 'none'; continue; }
      l.el.style.display = '';
      l.el.style.left = `${s.x}px`; l.el.style.top = `${s.y}px`;
      l.el.style.opacity = String(clamp(1.3 - s.d / 1000, 0.45, 1) * (l.dim ? 0.55 : 1));
    }
    const show = settings.names && VP;
    for (const p of places) {
      if (!show) { p.el.style.display = 'none'; continue; }
      const x = p.xz[0] - cam.x, z = -(p.xz[1] - cam.z), y = p.y + 30 - cam.y;
      const d = Math.hypot(x, y, z);
      const cx = VP[0] * x + VP[4] * y + VP[8] * z + VP[12], cy = VP[1] * x + VP[5] * y + VP[9] * z + VP[13];
      const w = VP[3] * x + VP[7] * y + VP[11] * z + VP[15];
      if (w <= 0 || d > 6000 || Math.abs(cx / w) > 1.1 || Math.abs(cy / w) > 1.1) { p.el.style.display = 'none'; continue; }
      p.el.style.display = '';
      p.el.style.left = `${(cx / w * 0.5 + 0.5) * innerWidth}px`;
      p.el.style.top = `${(0.5 - cy / w * 0.5) * innerHeight}px`;
      p.el.style.opacity = String(clamp(1.3 - d / 5000, 0.35, 1));
      p.el.style.fontSize = `${Math.round(clamp(20 - d / 400, 11, 18))}px`;
    }
  }

  // ---------------------------------------------------------------------------
  // Map (bottom right; M makes it big, click to go somewhere)
  // ---------------------------------------------------------------------------
  const mini = $('#mini'), mctx = mini.getContext('2d');
  let miniBase = null;
  function buildMiniBase() {
    const N = 640, c = document.createElement('canvas');
    c.width = c.height = N;
    const ctx = c.getContext('2d'), img = ctx.createImageData(N, N), px = img.data, P = LN * LN;
    const step = WORLD / N / LCELL;                  // light cells per minimap pixel (2 on Everon, 0.64 on Arland)
    for (let y = 0; y < N; y++) {
      const r = Math.min(LN - 1, Math.floor((N - 1 - y) * step));
      for (let x = 0; x < N; x++) {
        const cI = Math.min(LN - 1, Math.floor(x * step)), i = r * LN + cI, o = (y * N + x) * 4;
        const h = HEIGHT[i] / 10;
        if (h <= 0.05) { px[o] = 59; px[o + 1] = 90; px[o + 2] = 110; px[o + 3] = 255; continue; }
        const d = Math.max(1, Math.round(step));
        const hx = HEIGHT[r * LN + Math.min(cI + d, LN - 1)] / 10 - h, hz = HEIGHT[Math.min(r + d, LN - 1) * LN + cI] / 10 - h;
        const sh = clamp(0.85 + (-hx * 0.7 + hz * 0.7) / 20, 0.5, 1.25);
        let col = [120, 138, 88];
        if (CANOPY[3 * P + i] > 90) col = [58, 100, 55];
        if (BLD[i]) col = [168, 92, 72];
        px[o] = col[0] * sh; px[o + 1] = col[1] * sh; px[o + 2] = col[2] * sh; px[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    miniBase = c;
  }
  function drawMini() {
    if (!miniBase) return;
    const S = mini.width;
    mctx.imageSmoothingEnabled = true;
    mctx.drawImage(miniBase, 0, 0, S, S);
    // tiles in detail
    mctx.strokeStyle = 'rgba(255,255,255,0.18)';
    mctx.lineWidth = 1;
    for (const rec of tiles.values()) {
      if (rec.tVao) mctx.strokeRect(rec.tx * TILE / WORLD * S, S - (rec.tz + 1) * TILE / WORLD * S, TILE / WORLD * S, TILE / WORLD * S);
    }
    const x = cam.x / WORLD * S, y = S - cam.z / WORLD * S, a = rad(cam.yaw);
    mctx.save();
    mctx.translate(x, y);
    mctx.rotate(a);
    mctx.fillStyle = 'rgba(255,255,255,0.18)';
    mctx.beginPath(); mctx.moveTo(0, 0); mctx.arc(0, 0, S * 0.12, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55); mctx.closePath(); mctx.fill();
    mctx.fillStyle = '#ffdd55'; mctx.strokeStyle = '#000'; mctx.lineWidth = 1.5;
    mctx.beginPath(); mctx.moveTo(0, -9); mctx.lineTo(6, 7); mctx.lineTo(0, 3); mctx.lineTo(-6, 7); mctx.closePath();
    mctx.fill(); mctx.stroke();
    mctx.restore();
  }
  mini.addEventListener('click', e => {
    const r = mini.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * WORLD, z = (1 - (e.clientY - r.top) / r.height) * WORLD;
    teleport(x, z);
    mini.classList.remove('big');
  });

  function teleport(x, z, look) {
    const hag = cam.walk ? 1.7 : Math.max(cam.y - groundAt(cam.x, cam.z), 60);
    cam.x = x; cam.z = z;
    cam.y = Math.max(0, farHeight(x, z)) + hag;
    if (look) { cam.yaw = look.yaw; cam.pitch = look.pitch; }
  }

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------
  const mapSel = $('#map');
  for (const [name, m] of Object.entries(CFG.maps)) {
    const o = document.createElement('option'); o.value = name; o.textContent = m.title; mapSel.appendChild(o);
  }
  mapSel.value = MAP_NAME;
  mapSel.addEventListener('change', e => { location.href = `?map=${e.target.value}`; });   // a fresh start on the other map
  document.querySelector('#hud .title').textContent = `${MAP.title} 3D`;
  $('#detail').value = settings.detail;
  $('#range').value = String(settings.range);
  $('#sun').value = String(settings.sun);
  $('#names').checked = settings.names;
  $('#trees').checked = settings.trees;
  $('#smooth').checked = settings.smooth;
  $('#los').checked = settings.los;
  $('#los').addEventListener('change', e => { settings.los = e.target.checked; store.set('e3d-los', e.target.checked ? '1' : '0'); propsDirty = true; e.target.blur(); });
  $('#marks').checked = settings.marks;
  $('#marks').addEventListener('change', e => { settings.marks = e.target.checked; store.set('e3d-marks', e.target.checked ? '1' : '0'); e.target.blur(); });

  // Room: the same name and room code as on the field map. The name gets " 3D" on the end, so it doesn't clash with
  // your own name there and the others can see who is watching in 3D. Like the field map, the room code isn't kept
  // after the tab closes; an invite link (…#room=<code>) fills it in. While the tab is open it is kept (sessionStorage),
  // so a reload, or a switch to the room's map (a room keeps the map it was opened on), joins again by itself.
  const REJOIN = 'e3d-room';
  const session = {
    get() { try { return JSON.parse(sessionStorage.getItem(REJOIN) || 'null'); } catch { return null; } },
    set(v) { try { if (v) sessionStorage.setItem(REJOIN, JSON.stringify(v)); else sessionStorage.removeItem(REJOIN); } catch { /* private window */ } },
  };
  // (the room stays remembered when the connection drops, which it also does as the page unloads; it's forgotten on
  // Leave, when the server puts us out, and when joining fails)
  function roomStatus(state, text, removed = false) {
    $('#room-status').textContent = text;
    $('#room-join').textContent = state === 'on' ? 'Leave' : 'Join';
    $('#room-join').disabled = state === 'joining';
    for (const id of ['#room-name', '#room-code']) $(id).disabled = state !== 'off';
    if (removed) session.set(null);
  }
  // `again`: rejoining after a reload, when this tab's last session may still be in the room for 15-25 s (the page's
  // goodbye doesn't always get through, and then the server waits 15 s after its stream closes), so a name in use is
  // waited out rather than refused
  async function joinRoom(name, code, again = false) {
    store.set('e3d-name', name);
    let me = null;
    for (let tries = again ? 10 : 1; !me; tries--) {
      try { me = await markings.join(`${name.slice(0, 17)} 3D`, code.trim().toLowerCase(), MAP_NAME); }
      catch (err) {
        if (tries <= 1 || !/in use/.test(err.message)) { session.set(null); return; }
        roomStatus('joining', 'Waiting for your last session to end…');
        await new Promise(r => setTimeout(r, 4000));
      }
    }
    if (me.map !== MAP_NAME) {
      markings.leave();
      if (!CFG.maps[me.map]) { session.set(null); roomStatus('off', `That room is on ${me.map}, which this viewer doesn't have.`); return; }
      session.set({ name, code: me.room });
      location.href = `?map=${me.map}`;
      return;
    }
    session.set({ name, code: me.room });
    markings.listen();
  }
  $('#room-name').value = store.get('e3d-name', '');
  $('#room-form').addEventListener('submit', e => {
    e.preventDefault();
    document.activeElement?.blur();
    if (markings.me) { markings.leave(); session.set(null); return; }
    const name = $('#room-name').value.trim(), code = $('#room-code').value.trim();
    if (!name || !code) { roomStatus('off', 'Enter your name and the room code.'); return; }
    joinRoom(name, code);
  });
  addEventListener('pagehide', () => markings.leave());   // the room is still remembered, for a reload
  // An invite link (…#room=<code>) fills in the code; the field map's 3D button (…#room=<code>&name=<name>) also gives
  // the name, and joins straight away.
  (() => {
    const q = new URLSearchParams(location.hash.slice(1)), code = q.get('room'), name = q.get('name');
    const fromLink = code && /^[A-Za-z0-9_-]{3,32}$/.test(code);
    if (fromLink) {
      $('#room-code').value = code;
      if (name) $('#room-name').value = name.slice(0, 17);
      history.replaceState(null, '', location.pathname + location.search);
    }
    const s = session.get();
    roomStatus('off', '');
    if (fromLink && name) joinRoom(name, code, !!(s && s.code === code.toLowerCase()));
    else if (s) { $('#room-name').value = s.name; $('#room-code').value = s.code; joinRoom(s.name, s.code, true); }
  })();
  // back to the field map, in the same room
  const toMap = $('#to-map');
  toMap.addEventListener('click', () => {
    const me = markings.me;
    toMap.href = `/map${me ? `#room=${encodeURIComponent(me.room)}` : ''}`;
  });

  $('#roads').checked = settings.roads;
  $('#roads').addEventListener('change', e => { settings.roads = e.target.checked; store.set('e3d-roads', e.target.checked ? '1' : '0'); e.target.blur(); });
  $('#detail').addEventListener('change', e => { settings.detail = e.target.value; store.set('e3d-detail', settings.detail); e.target.blur(); });
  $('#range').addEventListener('change', e => { settings.range = +e.target.value; store.set('e3d-range', e.target.value); e.target.blur(); });
  $('#sun').addEventListener('input', e => { settings.sun = +e.target.value; store.set('e3d-sun', e.target.value); });
  $('#sun').addEventListener('change', e => e.target.blur());
  $('#trees').addEventListener('change', e => {
    settings.trees = e.target.checked; store.set('e3d-trees', e.target.checked ? '1' : '0');
    if (!settings.trees && !farBare && HEIGHT) buildFar(true);
    e.target.blur();
  });
  $('#smooth').addEventListener('change', e => {
    settings.smooth = e.target.checked; store.set('e3d-smooth', e.target.checked ? '1' : '0');
    updateTiles();                                          // the tiles are rebuilt with or without shaped trees
    e.target.blur();
  });
  $('#measured').checked = settings.measured;
  $('#measured').addEventListener('change', e => {
    settings.measured = e.target.checked; store.set('e3d-measured', e.target.checked ? '1' : '0');
    if (settings.measured && !plantInfo) $('#hud-load').textContent = 'No measured shapes for this map';
    updateTiles();
    e.target.blur();
  });
  $('#see').checked = settings.seeThrough;
  $('#see').addEventListener('change', e => {
    settings.seeThrough = e.target.checked; store.set('e3d-see', e.target.checked ? '1' : '0');
    if (settings.seeThrough && !settings.measured) $('#measured').click();   // it's a way of drawing the measured shapes
    e.target.blur();
  });
  $('#names').addEventListener('change', e => { settings.names = e.target.checked; store.set('e3d-names', e.target.checked ? '1' : '0'); e.target.blur(); });
  $('#mode').addEventListener('click', e => { setWalk(!cam.walk); e.target.blur(); });
  $('#goto').addEventListener('change', e => {
    const p = places[+e.target.value];
    e.target.value = '';
    e.target.blur();
    if (!p) return;
    // stand off to the south-west, looking at it
    if (cam.walk) teleport(p.xz[0], p.xz[1], { yaw: cam.yaw, pitch: 0 });
    else {
      cam.x = p.xz[0] - 280; cam.z = p.xz[1] - 280;
      cam.y = Math.max(0, farHeight(cam.x, cam.z)) + 1;
      cam.y = Math.max(cam.y + 60, p.y + 110);
      cam.yaw = 45; cam.pitch = -Math.atan2(cam.y - p.y, 396) * 180 / Math.PI;
    }
  });

  // ---------------------------------------------------------------------------
  // HUD
  // ---------------------------------------------------------------------------
  const pad = (n, w) => String(Math.max(0, Math.floor(n))).padStart(w, '0');
  const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  let fps = 0, frames = 0, fpsT = performance.now();
  function updateHud() {
    const g = groundAt(cam.x, cam.z);
    $('#hud-pos').textContent = `Grid ${pad(cam.x / 100, 3)} ${pad(cam.z / 100, 3)} · ${pad(cam.yaw, 3)}° ${COMPASS[Math.round(cam.yaw / 45) % 8]}`;
    $('#hud-alt').textContent = `${Math.round(cam.y)} m above sea · ${Math.round(cam.y - g)} m above ground`;
    $('#hud-mode').textContent = cam.walk ? `Walking · ${fps} fps` : `Flying ${Math.round(cam.speed)} m/s · ${fps} fps · ${(drawn / 1000).toFixed(0)}k objects`;
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------
  // The page's own files are relative (it lives at /3d/); the map data is the field map's, at /data/. The .gz files
  // are served as they are (no Content-Encoding), so they're unpacked here, like the worker does with the tiles.
  async function fetchGz(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  (async () => {
    try {
      const idx = await fetch(`${DIR}los/index.json`, { cache: 'no-cache' }).then(r => r.json());
      const v = `?v=${idx.version}`;
      const [h, c, b, placeFile] = await Promise.all([
        fetchGz(`${DIR}light/height.bin.gz${v}`), fetchGz(`${DIR}light/canopy.bin.gz${v}`),
        fetchGz(`${DIR}light/buildings.bin.gz${v}`),
        fetch(`${DIR}places.json${v}`).then(r => r.json()).catch(() => ({})),
      ]);
      // the field map's place names: towns, then landmarks (its points of interest aren't labelled here)
      const pl = [...(placeFile.towns || []), ...(placeFile.landmarks || [])].map(p => ({ name: p.name, xz: p.xz }));
      // shaped trees are an extra: without the table the map still draws its boxes
      // always checked with the server: the table and the tree files change without the terrain changing
      try {
        const t = await fetch(`${DIR}trees/species.json`, { cache: 'no-cache' }).then(r => r.json());
        if (t.format !== TREE_FORMAT) throw new Error(`tree table format ${t.format}, this page reads ${TREE_FORMAT}`);
        makeTreeTextures(t.species);
      }
      catch (err) { console.warn('No tree shapes', err); }
      // measured shapes (the toggle): also an extra
      try {
        const r = await fetch(`${DIR}foliage.json`, { cache: 'no-cache' });
        if (r.ok) makePlantShapes(await r.json());
      }
      catch (err) { console.warn('No measured tree shapes', err); }
      HEIGHT = new Int16Array(h); CANOPY = new Uint8Array(c); BLD = new Uint8Array(b);
      land = new Set(idx.tiles);
      buildFar(false);
      if (!settings.trees) buildFar(true);
      buildMiniBase();
      places = pl.map(p => ({ ...p, y: Math.max(0, farHeight(p.xz[0], p.xz[1])) }));
      const sel = $('#goto');
      places.map((p, i) => [p.name, i]).sort((a, b) => a[0].localeCompare(b[0])).forEach(([name, i]) => {
        const o = document.createElement('option'); o.value = String(i); o.textContent = name; sel.appendChild(o);
      });
      const lab = $('#labels');
      for (const p of places) { p.el = document.createElement('div'); p.el.className = 'label'; p.el.textContent = p.name; lab.appendChild(p.el); }
      const g0 = Math.max(0, farHeight(cam.x, cam.z));
      if (!Number.isFinite(cam.y)) cam.y = g0 + 70;
      cam.y = cam.walk ? g0 + 1.7 : Math.max(cam.y, g0 + 1.2);
      setWalk(cam.walk);
      $('#start').textContent = 'Click the view to look around';
      if (!MAP.hasTrees) { $('#smooth').parentElement.title = 'No tree shapes for this map'; }
      setTimeout(() => $('#start').classList.add('hidden'), 4000);
      updateTiles();
      setInterval(updateTiles, 250);
      // where the room's FIA caches and point control refer to: the field map's reference file (only Everon has one)
      if (MAP.poi) {
        fetch(MAP.poi).then(r => (r.ok ? r.json() : null)).catch(() => null)
          .then(f => { fieldSpots = f && { fia: f.fia || [], conflict: f.conflict || [] }; propsDirty = true; });
      }
      fetch('/data/mortar-tables.json').then(r => (r.ok ? r.json() : null)).catch(() => null)
        .then(t => { mortarTables = t; propsDirty = true; });
      fetchGz(`${DIR}light/forest.bin.gz${v}`).then(f => { FOREST = new Uint8Array(f); propsDirty = true; }).catch(() => {});
      // contact reports and unit markings fade, then go: look again now and then
      setInterval(() => { if (markings.me && Marks.hasTimeouts(markings.players)) propsDirty = true; }, 20000);
      setInterval(() => {
        updateHud();
        const s = [cam.x, cam.z, cam.y].map(v => v.toFixed(1)).concat([cam.yaw.toFixed(1), cam.pitch.toFixed(1), cam.walk ? 1 : 0]);
        history.replaceState(null, '', `#${s.join(',')}`);
      }, 250);
      document.addEventListener('pointerlockchange', () => $('#start').classList.add('hidden'));
      // at most 45 frames a second: a frame is skipped until it's due (on a 60 Hz screen, three drawn in every four)
      const FRAME_MS = 1000 / 45;
      let last = performance.now(), due = 0;
      const frame = now => {
        if (now < due - 1) { requestAnimationFrame(frame); return; }
        due = now - due > FRAME_MS ? now + FRAME_MS : due + FRAME_MS;
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        move(dt);
        if (propsDirty && now - propsBuiltAt > 300) { propsDirty = false; propsBuiltAt = now; buildProps(); }
        else updateOverlays();
        render();
        updateLabels();
        drawMini();
        frames++;
        if (now - fpsT > 1000) { fps = Math.round(frames * 1000 / (now - fpsT)); frames = 0; fpsT = now; }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    } catch (err) {
      $('#start').textContent = `Couldn't load the map data: ${err.message}`;
      console.error(err);
    }
  })();
})();

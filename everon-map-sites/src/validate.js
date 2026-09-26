// Checks every marking before it is shared, the same rules as validate_item() in the original server.py.

export const MAX_ITEM_BYTES = 20_000;
export const ITEM_TYPES = new Set(['marker', 'route', 'range', 'mortar', 'fia', 'emplacement', 'construct', 'area',
  'arrow', 'ambush', 'post', 'sectors', 'overwatch', 'aa']);
export const AIR_STATUSES = new Set(['requested', 'ack', 'enroute', 'done']);
const MORTAR_WEAPONS = new Set(['M252', '2B14']);
const MAX_MORTAR_TARGETS = 30;
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SHELL_RE = /^[A-Za-z0-9 ._()/+-]{1,40}$/;
const ID_RE = /^[A-Za-z0-9_-]{4,40}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isStr = v => typeof v === 'string';
// Length in code points, as Python's len() counts a string.
const clen = s => { let n = 0; for (const _ of s) n++; return n; };

const isPoint = v => Array.isArray(v) && v.length === 2 && v.every(n => isNum(n) && n >= -2000 && n <= 15000);
const isPoints = (v, min) => Array.isArray(v) && v.length >= min && v.length <= 200 && v.every(isPoint);

// True if v nests no deeper than limit lists/objects.
function depthOk(v, limit = 6) {
  if (v !== null && typeof v === 'object') {
    if (limit <= 0) return false;
    return Object.values(v).every(x => depthOk(x, limit - 1));
  }
  return true;
}

// The size Python's json.dumps() gives (", " and ": " separators, non-ASCII escaped), so the limits match the original.
export function pyJsonSize(v) {
  if (v === null) return 4;
  if (typeof v === 'boolean') return v ? 4 : 5;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v).length : JSON.stringify(v).length;
  if (typeof v === 'string') {
    let n = 2;
    for (const ch of JSON.stringify(v).slice(1, -1)) n += ch.charCodeAt(0) > 126 ? 6 : 1;
    return n;
  }
  if (Array.isArray(v)) return v.length ? 2 + v.reduce((s, x) => s + pyJsonSize(x), 0) + 2 * (v.length - 1) : 2;
  const keys = Object.keys(v);
  if (!keys.length) return 2;
  return 2 + keys.reduce((s, k) => s + pyJsonSize(k) + 2 + pyJsonSize(v[k]), 0) + 2 * (keys.length - 1);
}

export function validateItem(item) {
  if (!isObj(item)) return 'Bad item.';
  const keys = Object.keys(item);
  if (keys.length > 40 || !keys.every(k => clen(k) <= 20) || !depthOk(item)) return 'Bad item.';
  if (pyJsonSize(item) > MAX_ITEM_BYTES) return 'Item too large.';
  const has = k => Object.prototype.hasOwnProperty.call(item, k);
  // Names the map looks things up by: lower-case words and dashes, never a JavaScript built-in like "constructor"
  for (const k of ['icon', 'kind', 'fire', 'unit']) {
    if (has(k) && (!isStr(item[k]) || clen(item[k]) > 24 || !NAME_RE.test(item[k]) || item[k] === 'constructor')) return `Bad ${k}.`;
  }
  if (!isStr(item.id) || !ID_RE.test(item.id)) return 'Bad item id.';
  const t = item.type;
  if (!ITEM_TYPES.has(t)) return 'Unknown item type.';
  for (const k of ['label', 'note']) {
    if (has(k) && (!isStr(item[k]) || clen(item[k]) > 500)) return `Bad ${k}.`;
  }
  if (has('color') && !(isStr(item.color) && COLOR_RE.test(item.color))) return 'Bad color.';
  const num = (k, lo, hi) => isNum(item[k]) && item[k] >= lo && item[k] <= hi;
  // Air support request details and status (pins, and gun-run target areas)
  const air = item.air;
  if (air !== undefined && air !== null && (!isObj(air) || Object.keys(air).length > 8 ||
      !Object.entries(air).every(([k, v]) => clen(k) <= 20 && isStr(v) && clen(v) <= 60))) return 'Bad air support request.';
  if (has('status') && !AIR_STATUSES.has(item.status)) return 'Bad request status.';
  if (has('statusBy') && (!isStr(item.statusBy) || clen(item.statusBy) > 40)) return 'Bad request status.';
  if (t === 'marker') {
    if (!isPoint(item.xz)) return 'Bad marker position.';
    // Contact report details (all optional)
    for (const k of ['size', 'activity', 'kit']) {
      if (has(k) && (!isStr(item[k]) || clen(item[k]) > 60)) return 'Bad contact report.';
    }
    if (item.heading !== undefined && item.heading !== null && !num('heading', 0, 360)) return 'Bad contact heading.';
    if (has('ttl') && !num('ttl', 0, 1440)) return 'Bad timeout.';
    if (has('range') && !num('range', 0, 2000)) return 'Bad range card reach.';
    if (has('unit') && !['inf', 'arm'].includes(item.unit)) return 'Bad position type.';
    if (has('ring') && typeof item.ring !== 'boolean') return 'Bad radius toggle.';
    if (has('fire') && !['he', 'smoke', 'illum'].includes(item.fire)) return 'Bad fire request.';
  }
  if (t === 'arrow') {
    if (!['advance', 'enemy', 'patrol', 'flight'].includes(item.kind)) return 'Unknown arrow.';
    if (!isPoints(item.points, 2)) return 'Bad arrow.';
  }
  if (t === 'ambush') {
    if (!['linear', 'l'].includes(item.kind) || ![1, -1].includes(item.side)) return 'Bad ambush.';
    if (!(isPoint(item.from) && isPoint(item.to))) return 'Bad ambush position.';
  }
  if (t === 'post') {
    if (!['f', 'e', 'v', 'fv'].includes(item.side) || !isPoint(item.xz) || !num('range', 50, 2000)) return 'Bad range card.';
  }
  if (t === 'aa') {
    if (item.side !== 'e' || !isPoint(item.xz)) return 'Bad AA gun.';
    if (!(num('dir', 0, 360) && num('arc', 5, 360) && num('range', 100, 3000))) return 'Bad AA field of fire.';
    if (has('height') && !num('height', 0, 100)) return 'Bad AA height.';
  }
  if (t === 'overwatch' && !(isPoint(item.xz) && num('range', 50, 2000))) return 'Bad overwatch.';
  if (t === 'sectors') {
    const names = has('names') ? item.names : [];
    if (!isPoint(item.xz) || !num('radius', 20, 3000) || !num('start', 0, 360)) return 'Bad sectors of fire.';
    if (!Number.isInteger(item.n) || item.n < 2 || item.n > 12) return 'Bad number of sectors.';
    if (!Array.isArray(names) || names.length > 12 || !names.every(s => isStr(s) && clen(s) <= 40)) return 'Bad sector names.';
  }
  if (t === 'route') {
    if (!isPoints(item.points, 2)) return 'Bad route.';
    const plan = item.plan;
    if (plan !== undefined && plan !== null && !(isObj(plan) && plan.mode === 'foot' && isPoint(plan.from) && isPoint(plan.to) &&
        (plan.at === undefined || isNum(plan.at)))) return 'Bad route plan.';
  }
  if (t === 'range' && !(isPoint(item.from) && isPoint(item.to))) return 'Bad range line.';
  if (t === 'mortar') {
    const targets = has('targets') ? item.targets : [];
    if (!isPoint(item.xz) || !MORTAR_WEAPONS.has(item.weapon)) return 'Bad mortar.';
    if (!isStr(item.shell) || !SHELL_RE.test(item.shell)) return 'Bad mortar shell.';
    if (!Array.isArray(targets) || targets.length > MAX_MORTAR_TARGETS || !targets.every(isPoint)) return 'Bad mortar targets.';
  }
  if (t === 'emplacement') {
    if (!isPoint(item.xz) || item.kind !== 'mg') return 'Bad emplacement.';
    if (!(num('dir', 0, 360) && num('arc', 5, 360) && num('range', 10, 3000))) return 'Bad field of fire.';
    if (has('height') && !num('height', 0, 100)) return 'Bad emplacement height.';
  }
  if (t === 'area') {
    if (!['enemy', 'fire', 'cas'].includes(item.kind) || !isPoints(item.points, 3)) return 'Bad area.';
    if (item.kind === 'fire' && !['he', 'smoke', 'illum'].includes(item.fire)) return 'Bad fire request.';
  }
  if (t === 'construct') {
    const kind = item.kind;
    // "wall" is the sandbag line; a roadblock is a line of tank traps (older plans may hold single-point ones)
    if (kind === 'bunker' || kind === 'checkpoint' || (kind === 'roadblock' && !has('points'))) {
      if (!isPoint(item.xz)) return 'Bad construct position.';
    } else if (['wall', 'wire', 'roadblock'].includes(kind)) {
      if (!isPoints(item.points, 2)) return 'Bad sandbag, wire or roadblock line.';
    } else {
      return 'Unknown construct.';
    }
  }
  if (t === 'fia') {
    const caches = item.caches;
    if (!Array.isArray(caches) || caches.length > 40 || !caches.every(c => isStr(c) && c.length > 0 && clen(c) <= 60)) return 'Bad FIA cache list.';
  }
  return null;
}

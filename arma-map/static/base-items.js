// Item creation and classification shared by the base page and regression checks.
'use strict';

const BaseItems = ({ catalog, state, uid, nextLabel, myColor, roundXZ, bearing, dist, friendly }) => {
  const TOOLS = { ...catalog,
    post: { name: 'Watch post', kind: 'point', glyph: 'OP', group: 'Planning' },
    sectors: { name: 'Sectors of fire', kind: 'aim', glyph: '◎', group: 'Planning' },
    trp: { name: 'TRP', kind: 'point', glyph: '✛', group: 'Planning' },
  };
  const isGun = t => TOOLS[t]?.type === 'emplacement';
  function toolOf(it) {
    if (it.type === 'construct' && TOOLS[it.kind]?.type === 'construct') return it.kind;
    if (it.type === 'emplacement') return it.kind === 'mg' ? 'lmg' : isGun(it.kind) ? it.kind : null;
    if (it.type === 'sectors') return 'sectors';
    if (it.type === 'marker' && it.icon === 'trp') return 'trp';
    if (it.type === 'post' && it.side === 'f') return 'post';
    return null;
  }
  function makeItem(t, a, b) {
    const base0 = { id: uid(), label: nextLabel(t), note: '', color: myColor() };
    if (TOOLS[t].type === 'construct' && TOOLS[t].kind === 'point') return { ...base0, type: 'construct', kind: t, xz: roundXZ(a) };
    if (TOOLS[t].kind === 'line') return { ...base0, type: 'construct', kind: t, points: a.map(roundXZ) };
    if (t === 'trp') return { ...base0, type: 'marker', icon: 'trp', xz: roundXZ(a) };
    if (t === 'post') return { ...base0, type: 'post', side: 'f', xz: roundXZ(a), range: state().postRange };
    if (isGun(t)) return { ...base0, type: 'emplacement', kind: t, xz: roundXZ(a), dir: Math.round(bearing(a, b)) % 360, arc: state().arc,
      range: Math.round(Math.min(Math.max(dist(a, b), 10), 3000)), height: 0, color: friendly };
    if (t === 'sectors') return { ...base0, type: 'sectors', xz: roundXZ(a), radius: Math.round(Math.min(Math.max(dist(a, b), 20), 3000)),
      start: Math.round(bearing(a, b)) % 360, n: state().sectorCount, names: [] };
    return null;
  }
  return { TOOLS, isGun, toolOf, makeItem };
};

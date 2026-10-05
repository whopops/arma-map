/* Shared construction names and placement modes; see CONSTRUCTION_CATALOG.md for game sources. */
(() => {
  'use strict';
  window.ConstructionCatalog = Object.freeze({
    "headquarters": {"name": "Headquarters", "kind": "point", "glyph": "HQ", "group": "Services", "type": "construct"},
    "player-hub": {"name": "Deployment point", "kind": "point", "glyph": "DP", "group": "Services", "type": "construct"},
    "antenna": {"name": "Radio relay", "kind": "point", "glyph": "RAD", "group": "Services", "type": "construct"},
    "armory": {"name": "Armory", "kind": "point", "glyph": "ARM", "group": "Services", "type": "construct"},
    "supply": {"name": "Supply storage", "kind": "point", "glyph": "SUP", "group": "Services", "type": "construct"},
    "living": {"name": "Living quarters", "kind": "point", "glyph": "LQ", "group": "Services", "type": "construct"},
    "hospital": {"name": "Field hospital", "kind": "point", "glyph": "MED", "group": "Services", "type": "construct"},
    "light-depot": {"name": "Light vehicle depot", "kind": "point", "glyph": "LVD", "group": "Services", "type": "construct"},
    "heavy-depot": {"name": "Heavy vehicle depot", "kind": "point", "glyph": "HVD", "group": "Services", "type": "construct"},
    "helipad": {"name": "Helipad", "kind": "point", "glyph": "H", "group": "Services", "type": "construct"},
    "fuel": {"name": "Fuel storage", "kind": "point", "glyph": "FUEL", "group": "Services", "type": "construct"},
    "floodlight": {"name": "Floodlight generator", "kind": "point", "glyph": "FL", "group": "Services", "type": "construct"},
    "bunker": {"name": "Bunker", "kind": "point", "glyph": "BK", "group": "Fortifications", "type": "construct"},
    "sandbag-position": {"name": "Sandbag fighting position", "kind": "point", "glyph": "SP", "group": "Fortifications", "type": "construct"},
    "camo-net": {"name": "Camouflage net", "kind": "point", "glyph": "NET", "group": "Fortifications", "type": "construct"},
    "guard-tower": {"name": "Guard tower", "kind": "point", "glyph": "GT", "group": "Fortifications", "type": "construct"},
    "barricade": {"name": "Roadblock", "kind": "point", "glyph": "RB", "group": "Fortifications", "type": "construct"},
    "checkpoint": {"name": "Checkpoint", "kind": "point", "glyph": "CP", "group": "Fortifications", "type": "construct"},
    "wall": {"name": "Sandbags", "kind": "line", "glyph": null, "group": "Obstacles", "type": "construct"},
    "wire": {"name": "Barbed wire", "kind": "line", "glyph": null, "group": "Obstacles", "type": "construct"},
    "roadblock": {"name": "Tank traps", "kind": "line", "glyph": null, "group": "Obstacles", "type": "construct"},
    "dragon-teeth": {"name": "Dragon’s teeth", "kind": "line", "glyph": null, "group": "Obstacles", "type": "construct"},
    "lmg": {"name": "LMG emplacement", "kind": "aim", "glyph": "LMG", "group": "Weapons", "type": "emplacement"},
    "hmg": {"name": "HMG emplacement", "kind": "aim", "glyph": "HMG", "group": "Weapons", "type": "emplacement"},
    "aa-mg": {"name": "AA HMG emplacement", "kind": "aim", "glyph": "AA", "group": "Weapons", "type": "emplacement"},
    "mortar-pit": {"name": "Mortar placement", "kind": "point", "glyph": "MOR", "group": "Weapons", "type": "construct"},
  });
})();

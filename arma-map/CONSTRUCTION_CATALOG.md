# Base construction catalog sources

Checked on 2026-10-04 against the installed vanilla Arma Reforger Steam build **24903726**.
The source is the game's `data007.pak`, read with the existing tools repo's read-only `rmtlib.pak` reader.
No game files or tools were modified. This catalog is a snapshot of that build, not a claim about every mod or future release.

Construction registries inspected:

- `Configs/Editor/PlaceableEntities/Compositions/Compositions_FreeRoamBuilding.conf`
- `Configs/Editor/PlaceableEntities/Compositions/Compositions_FreeRoamBuilding_HQC.conf`

Their union contains **104 prefab entries**, collapsed into **26 construction roles** in `static/construction.js`.
All prefab families in both registries are represented; faction skins, sizes, heights, scope variants and nest layouts
are combined. Light/heavy depots and LMG/HMG remain separate because they serve different roles.

The three roadblock sizes are `Barricade_S/M/L`, represented by one **Roadblock** (`barricade`). Steel Czech hedgehogs
and concrete dragon's teeth remain distinct obstacles. The older site key `roadblock` already means tank traps and
retains that meaning for compatibility. Sandbag lines and fighting positions remain separate placement shapes.

The US machine-gun nest `_01` prefab references `Sandbag_MG_US_01_M60`; `_02` references
`Sandbag_MG_US_01_M2HB`. Standalone M60/PKM placements join the LMG role, M2HB/NSV/scoped NSV placements join HMG,
and the dedicated AA mounts join AA HMG. The builder uses the user's requested **LMG** label for the M60/PKM class.
`PlayerHub_S_US_01` contains a `SCR_SpawnPoint` using `E_SpawnPoint_US_Supplies`, represented as **Deployment point**.
Vehicle-maintenance small/medium prefabs identify their icons as `LightVehicleDepot` and `HeavyVehicleDepot`.

Public cross-checks: [Bohemia's Conflict documentation](https://community.bohemia.net/wiki/Arma_Reforger%3AConflict)
explains construction and service depots; [Dev Report #22](https://reforger.armaplatform.com/news/dev-report-22)
confirms both standalone and composition mortar construction. The installed registries, rather than third-party
build guides or mod lists, determine membership.

These are planning symbols with schematic 3D shapes. They do not simulate building costs, rank unlocks, placed-object
collision or changes to baked line of sight. The aiming click sets an emplacement's planning reach. AA HMG visibility
is ground coverage; mortar placement is a construction symbol, not a firing-solution mortar marking.

## Complete registry-to-planner mapping

| Builder role | Game prefab | Registry |
|---|---|---|
| AA HMG emplacement (`aa-mg`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_Emplacement_AA_MG_FIA_NSV_SPP.et` | Conflict, HQC |
| AA HMG emplacement (`aa-mg`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_Emplacement_AA_MG_USSR_NSV_SPP.et` | Conflict, HQC |
| AA HMG emplacement (`aa-mg`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_Emplacement_AA_MG_US_M2HB.et` | Conflict, HQC |
| Radio relay (`antenna`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_Antenna_S_FIA_01.et` | Conflict, HQC |
| Radio relay (`antenna`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_Antenna_S_USSR_01.et` | Conflict, HQC |
| Radio relay (`antenna`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_Antenna_S_US_01.et` | Conflict, HQC |
| Armory (`armory`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_AmmoStorage_S_FIA_01.et` | Conflict, HQC |
| Armory (`armory`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_AmmoStorage_S_USSR_01.et` | Conflict, HQC |
| Armory (`armory`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_AmmoStorage_S_US_01.et` | Conflict, HQC |
| Roadblock (`barricade`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotRoadLarge/E_Barricade_L_USSR_01.et` | HQC |
| Roadblock (`barricade`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotRoadLarge/E_Barricade_L_US_01.et` | HQC |
| Roadblock (`barricade`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotRoadMedium/E_Barricade_M_USSR_01.et` | Conflict, HQC |
| Roadblock (`barricade`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotRoadMedium/E_Barricade_M_US_01.et` | Conflict, HQC |
| Roadblock (`barricade`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotRoadSmall/E_Barricade_S_USSR_01.et` | Conflict, HQC |
| Roadblock (`barricade`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotRoadSmall/E_Barricade_S_US_01.et` | Conflict, HQC |
| Bunker (`bunker`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_Bunker_S_FIA_01.et` | Conflict, HQC |
| Bunker (`bunker`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_Bunker_S_USSR_01.et` | Conflict, HQC |
| Bunker (`bunker`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_Bunker_S_US_01.et` | Conflict, HQC |
| Camouflage net (`camo-net`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_CamoNetLarge_M_FIA_01.et` | Conflict, HQC |
| Camouflage net (`camo-net`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_CamoNetLarge_M_USSR_01.et` | Conflict, HQC |
| Camouflage net (`camo-net`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_CamoNetLarge_M_US_01.et` | Conflict, HQC |
| Camouflage net (`camo-net`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_CamoNetMedium_S_FIA_01.et` | Conflict, HQC |
| Camouflage net (`camo-net`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_CamoNetMedium_S_USSR_01.et` | Conflict, HQC |
| Camouflage net (`camo-net`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_CamoNetMedium_S_US_01.et` | Conflict, HQC |
| Camouflage net (`camo-net`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_CamoNetSmall_S_FIA_01.et` | Conflict, HQC |
| Camouflage net (`camo-net`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_CamoNetSmall_S_USSR_01.et` | Conflict, HQC |
| Camouflage net (`camo-net`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_CamoNetSmall_S_US_01.et` | Conflict, HQC |
| Checkpoint (`checkpoint`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotRoadLarge/E_Checkpoint_L_USSR_01.et` | HQC |
| Checkpoint (`checkpoint`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotRoadLarge/E_Checkpoint_L_US_01.et` | HQC |
| Checkpoint (`checkpoint`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotRoadMedium/E_Checkpoint_M_USSR_01.et` | HQC |
| Checkpoint (`checkpoint`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotRoadMedium/E_Checkpoint_M_US_01.et` | HQC |
| Checkpoint (`checkpoint`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotRoadSmall/E_Checkpoint_S_USSR_01.et` | HQC |
| Checkpoint (`checkpoint`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotRoadSmall/E_Checkpoint_S_US_01.et` | HQC |
| Dragon’s teeth (`dragon-teeth`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_Dragonsteeth_S_US_01.et` | Conflict, HQC |
| Floodlight generator (`floodlight`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_FloodlightGenerator_S_USSR_01.et` | Conflict, HQC |
| Floodlight generator (`floodlight`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_FloodlightGenerator_S_US_01.et` | Conflict, HQC |
| Fuel storage (`fuel`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_FuelStorage_S_FIA_01.et` | Conflict, HQC |
| Fuel storage (`fuel`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_FuelStorage_S_USSR_01.et` | Conflict, HQC |
| Fuel storage (`fuel`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_FuelStorage_S_US_01.et` | Conflict, HQC |
| Guard tower (`guard-tower`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_GuardTower_S_USSR_01.et` | Conflict, HQC |
| Guard tower (`guard-tower`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_GuardTower_S_US_01.et` | Conflict, HQC |
| Headquarters (`headquarters`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_Headquarters_S_Conflict_FIA_01.et` | Conflict |
| Headquarters (`headquarters`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_Headquarters_S_Conflict_USSR_01.et` | Conflict, HQC |
| Headquarters (`headquarters`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_Headquarters_S_Conflict_US_01.et` | Conflict, HQC |
| Heavy vehicle depot (`heavy-depot`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatMedium/E_VehicleMaintenance_M_Conflict_USSR_01.et` | Conflict, HQC |
| Heavy vehicle depot (`heavy-depot`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatMedium/E_VehicleMaintenance_M_Conflict_US_01.et` | Conflict, HQC |
| Helipad (`helipad`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatLarge/E_Helipad_L_Conflict_USSR_01.et` | Conflict, HQC |
| Helipad (`helipad`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatLarge/E_Helipad_L_Conflict_US_01.et` | Conflict, HQC |
| HMG emplacement (`hmg`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_Emplacement_MG_USSR_01_NSV.et` | Conflict, HQC |
| HMG emplacement (`hmg`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_Emplacement_MG_USSR_01_NSV_SPP.et` | Conflict, HQC |
| HMG emplacement (`hmg`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_Emplacement_MG_US_01_M2HB.et` | Conflict, HQC |
| HMG emplacement (`hmg`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_MachineGunNest_S_FIA_02.et` | Conflict, HQC |
| HMG emplacement (`hmg`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_MachineGunNest_S_USSR_02.et` | Conflict, HQC |
| HMG emplacement (`hmg`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_MachineGunNest_S_US_02.et` | Conflict, HQC |
| HMG emplacement (`hmg`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_MachineGunNest_Scoped_S_FIA_01.et` | Conflict, HQC |
| HMG emplacement (`hmg`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_MachineGunNest_Scoped_S_USSR_01.et` | Conflict, HQC |
| Field hospital (`hospital`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatMedium/E_FieldHospital_M_Conflict_USSR_01.et` | Conflict, HQC |
| Field hospital (`hospital`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatMedium/E_FieldHospital_M_Conflict_US_01.et` | Conflict, HQC |
| Field hospital (`hospital`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatMedium/E_FieldHospital_M_FIA_01.et` | Conflict, HQC |
| Light vehicle depot (`light-depot`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_VehicleMaintenance_S_Conflict_USSR_01.et` | Conflict, HQC |
| Light vehicle depot (`light-depot`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_VehicleMaintenance_S_Conflict_US_01.et` | Conflict, HQC |
| Light vehicle depot (`light-depot`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_VehicleMaintenance_S_FIA_01.et` | Conflict, HQC |
| Living quarters (`living`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatLarge/E_LivingArea_L_Conflict_USSR_01.et` | Conflict, HQC |
| Living quarters (`living`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatLarge/E_LivingArea_L_Conflict_US_01.et` | Conflict, HQC |
| Living quarters (`living`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_LivingArea_S_Conflict_USSR_01.et` | Conflict, HQC |
| Living quarters (`living`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_LivingArea_S_Conflict_US_01.et` | Conflict, HQC |
| Living quarters (`living`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_LivingArea_S_FIA_01.et` | Conflict, HQC |
| LMG emplacement (`lmg`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_Emplacement_M60_S_US_01.et` | Conflict, HQC |
| LMG emplacement (`lmg`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_Emplacement_MG_USSR_01_PKM.et` | Conflict, HQC |
| LMG emplacement (`lmg`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_MachineGunNest_S_USSR_01.et` | Conflict, HQC |
| LMG emplacement (`lmg`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_MachineGunNest_S_US_01.et` | Conflict, HQC |
| Mortar placement (`mortar-pit`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_MortarPlacement_S_FIA_01.et` | Conflict, HQC |
| Mortar placement (`mortar-pit`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_MortarPlacement_S_USSR_01.et` | Conflict, HQC |
| Mortar placement (`mortar-pit`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_MortarPlacement_S_US_01.et` | Conflict, HQC |
| Deployment point (`player-hub`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_PlayerHub_S_FIA_01.et` | Conflict, HQC |
| Deployment point (`player-hub`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_PlayerHub_S_USSR_01.et` | Conflict, HQC |
| Deployment point (`player-hub`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_PlayerHub_S_US_01.et` | Conflict, HQC |
| Tank traps (`roadblock`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_CzechHedgehog_S_01_painted.et` | Conflict, HQC |
| Sandbag fighting position (`sandbag-position`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_SandbagRoundBurlap_S_USSR_01.et` | Conflict, HQC |
| Sandbag fighting position (`sandbag-position`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_SandbagRoundHighBurlap_S_USSR_01.et` | Conflict, HQC |
| Sandbag fighting position (`sandbag-position`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_SandbagRoundHighPlastic_S_US_01.et` | Conflict, HQC |
| Sandbag fighting position (`sandbag-position`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_SandbagRoundPlastic_S_US_01.et` | Conflict, HQC |
| Sandbag fighting position (`sandbag-position`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_SandbagPosition_S_FIA_01.et` | HQC |
| Sandbag fighting position (`sandbag-position`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_SandbagPosition_S_USSR_01.et` | HQC |
| Sandbag fighting position (`sandbag-position`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_SandbagPosition_S_USSR_02.et` | HQC |
| Sandbag fighting position (`sandbag-position`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_SandbagPosition_S_USSR_03.et` | Conflict, HQC |
| Sandbag fighting position (`sandbag-position`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_SandbagPosition_S_USSR_04.et` | Conflict, HQC |
| Sandbag fighting position (`sandbag-position`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_SandbagPosition_S_US_01.et` | HQC |
| Sandbag fighting position (`sandbag-position`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_SandbagPosition_S_US_02.et` | HQC |
| Sandbag fighting position (`sandbag-position`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_SandbagPosition_S_US_03.et` | Conflict, HQC |
| Sandbag fighting position (`sandbag-position`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_SandbagPosition_S_US_04.et` | Conflict, HQC |
| Supply storage (`supply`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_SupplyCache_S_FIA_03_Empty.et` | Conflict, HQC |
| Supply storage (`supply`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_SupplyCache_S_USSR_01.et` | Conflict, HQC |
| Supply storage (`supply`) | `PrefabsEditable/Auto/Compositions/Slotted/SlotFlatSmall/E_SupplyCache_S_US_01.et` | Conflict, HQC |
| Sandbags (`wall`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_SandbagLongBurlap_S_USSR_01.et` | Conflict, HQC |
| Sandbags (`wall`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_SandbagLongHighBurlap_S_USSR_01.et` | Conflict, HQC |
| Sandbags (`wall`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_SandbagLongHighPlastic_S_US_01.et` | Conflict, HQC |
| Sandbags (`wall`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_SandbagLongPlastic_S_US_01.et` | Conflict, HQC |
| Sandbags (`wall`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_SandbagWallBurlap_S_USSR_01.et` | Conflict, HQC |
| Sandbags (`wall`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_SandbagWallPlastic_S_US_01.et` | Conflict, HQC |
| Sandbags (`wall`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_SandbagWallSolidBurlap_S_USSR_01.et` | Conflict, HQC |
| Sandbags (`wall`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_SandbagWallSolidPlastic_S_US_01.et` | Conflict, HQC |
| Barbed wire (`wire`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_BarbedTapeKnifeRest_S_US_01.et` | Conflict, HQC |
| Barbed wire (`wire`) | `PrefabsEditable/Auto/Compositions/Misc/FreeRoamBuilding/E_BarbedTapeTriple_S_USSR_01.et` | Conflict, HQC |

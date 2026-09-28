// Everon LOS Export - a World Editor tool that pulls line-of-sight data out of the open world.
//
// Step 1 (this file): a go/no-go test on a small area.
//   "Count objects"   lists every entity in the area by class and writes objects.csv
//                     (class, prefab, position, yaw, scale, world bounding box).
//   "Export terrain"  samples the engine's own terrain height on a grid and writes terrain.csv. At 0.5 m it
//                     also reveals the engine's native terrain grid (heights run straight between its points).
//   "Probe objects"   fires straight-down rays across trees, bushes, buildings and walls (up to N of each)
//                     to see what stops rays: roofs, walls, canopies or only trunks.
//
// Island export (step 2): "Island: objects", "Island: terrain" and "Island: surfaces" cover the whole map tile by
// tile into objects/, terrain/ and surface/ folders. They skip tiles already written, so they can be stopped
// (or crash) and continue where they left off.
// Output goes to the Workbench profile folder: Documents\My Games\ArmaReforgerWorkbench\profile\everon_los
//
// Entity query and file writing follow nickludlam/EnfusionMapMaker (APL-SA). The ray probe uses
// BaseWorld.TraceMove; its flag and layer names are the least certain part, so if the script fails
// to compile, the error will most likely point there.

[WorkbenchToolAttribute(name: "Everon LOS Export", description: "Dump objects and terrain heights for the Everon Field Map line of sight", wbModules: {"WorldEditor"}, awesomeFontCode: 0xf06e)]
class EveronLOSExportTool : WorldEditorTool
{
	[Attribute("4450 0 6700", UIWidgets.Coords, "South-west corner of the area (X, ignored, Z) in metres", category: "Area")]
	vector m_vAreaMin;

	[Attribute("4950 0 7200", UIWidgets.Coords, "North-east corner of the area (X, ignored, Z) in metres", category: "Area")]
	vector m_vAreaMax;

	[Attribute("0.5", UIWidgets.EditBox, "Terrain sample spacing in metres (finer than the engine's own grid shows where its grid points are)", category: "Terrain")]
	float m_fHeightStep;

	[Attribute("20", UIWidgets.EditBox, "How many of each kind (trees, bushes, buildings, walls) to probe", category: "Probe")]
	int m_iTreeProbes;

	[Attribute("$profile:everon_los", UIWidgets.EditBox, "Output folder", category: "Output")]
	string m_sOutDir;

	[Attribute("12800", UIWidgets.EditBox, "Size of the island square to export, in metres (Everon is 12800)", category: "Island export")]
	float m_fIslandSize;

	[Attribute("500", UIWidgets.EditBox, "Tile size in metres; each tile is its own file, and finished tiles are skipped when you run again", category: "Island export")]
	float m_fTile;

	[Attribute("1", UIWidgets.EditBox, "Island terrain spacing in metres (the engine's grid is 2 m; 1 m captures its triangles)", category: "Island export")]
	float m_fIslandTerrainStep;

	[Attribute("0.5", UIWidgets.EditBox, "Surface scan spacing in metres (rays over every building, wall, tree and bush)", category: "Island export")]
	float m_fScanStep;

	[Attribute("0", UIWidgets.EditBox, "Stop after this many new tiles per click (0 = do them all); run again to continue", category: "Island export")]
	int m_iMaxTiles;

	[Attribute("20000", UIWidgets.EditBox, "How many random sight lines the accuracy check fires", category: "Accuracy check")]
	int m_iCheckPairs;

	protected BaseWorld m_World;
	protected ref array<IEntity> m_aFound = new array<IEntity>();

	//------------------------------------------------------------------------------------------------
	protected bool GetWorld()
	{
		WorldEditor worldEditor = Workbench.GetModule(WorldEditor);
		if (!worldEditor)
			return false;
		WorldEditorAPI api = worldEditor.GetApi();
		if (!api)
			return false;
		m_World = api.GetWorld();
		return m_World != null;
	}

	//------------------------------------------------------------------------------------------------
	protected bool AddEntity(IEntity e)
	{
		m_aFound.Insert(e);
		return true; // keep going
	}

	//------------------------------------------------------------------------------------------------
	protected FileHandle OpenOut(string name)
	{
		FileIO.MakeDirectory(m_sOutDir);
		string path = m_sOutDir + "/" + name;
		FileHandle f = FileIO.OpenFile(path, FileMode.WRITE);
		if (!f)
			Print("Everon LOS Export: could not open " + path, LogLevel.ERROR);
		else
			Print("Everon LOS Export: writing " + path, LogLevel.NORMAL);
		return f;
	}

	//------------------------------------------------------------------------------------------------
	protected void QueryArea()
	{
		m_aFound.Clear();
		vector mins = Vector(m_vAreaMin[0], -500, m_vAreaMin[2]);
		vector maxs = Vector(m_vAreaMax[0], 2000, m_vAreaMax[2]);
		m_World.QueryEntitiesByAABB(mins, maxs, AddEntity);
	}

	//------------------------------------------------------------------------------------------------
	[ButtonAttribute("Count objects")]
	void CountObjects()
	{
		if (!GetWorld())
		{
			Print("Everon LOS Export: open Everon in the World Editor first", LogLevel.ERROR);
			return;
		}
		QueryArea();

		FileHandle f = OpenOut("objects.csv");
		if (!f)
			return;
		f.Write("class,prefab,x,y,z,yaw,scale,minx,miny,minz,maxx,maxy,maxz\n");

		map<string, int> counts = new map<string, int>();
		int written = 0;
		foreach (IEntity e : m_aFound)
		{
			vector wmin, wmax;
			e.GetWorldBounds(wmin, wmax);
			// Skip things far bigger than any building (the terrain itself, area triggers, the ocean)
			if (wmax[0] - wmin[0] > 400 || wmax[2] - wmin[2] > 400)
				continue;

			string cls = e.ClassName();
			counts.Set(cls, counts.Get(cls) + 1);

			string prefab = "";
			EntityPrefabData pd = e.GetPrefabData();
			if (pd)
				prefab = pd.GetPrefabName();

			vector o = e.GetOrigin();
			vector ypr = e.GetYawPitchRoll();
			string line = string.Format("%1,%2,%3,%4,%5,%6,%7,", cls, prefab, o[0], o[1], o[2], ypr[0], e.GetScale());
			line += string.Format("%1,%2,%3,%4,%5,%6\n", wmin[0], wmin[1], wmin[2], wmax[0], wmax[1], wmax[2]);
			f.Write(line);
			written++;
		}
		f.Close();

		Print(string.Format("Everon LOS Export: %1 entities in the area, %2 written", m_aFound.Count(), written), LogLevel.NORMAL);
		for (int i = 0; i < counts.Count(); i++)
			Print(string.Format("  %1: %2", counts.GetKey(i), counts.GetElement(i)), LogLevel.NORMAL);
	}

	//------------------------------------------------------------------------------------------------
	[ButtonAttribute("Export terrain")]
	void ExportTerrain()
	{
		if (!GetWorld())
		{
			Print("Everon LOS Export: open Everon in the World Editor first", LogLevel.ERROR);
			return;
		}
		if (m_fHeightStep < 0.25)
			m_fHeightStep = 0.25;

		FileHandle f = OpenOut("terrain.csv");
		if (!f)
			return;
		// First line: x0, z0, step, columns, rows. Then one line of heights per row, south to north.
		int cols = Math.Floor((m_vAreaMax[0] - m_vAreaMin[0]) / m_fHeightStep) + 1;
		int rows = Math.Floor((m_vAreaMax[2] - m_vAreaMin[2]) / m_fHeightStep) + 1;
		f.Write(string.Format("%1,%2,%3,%4,%5\n", m_vAreaMin[0], m_vAreaMin[2], m_fHeightStep, cols, rows));
		for (int r = 0; r < rows; r++)
		{
			float z = m_vAreaMin[2] + r * m_fHeightStep;
			string line = "";
			for (int c = 0; c < cols; c++)
			{
				float x = m_vAreaMin[0] + c * m_fHeightStep;
				if (c > 0)
					line += ",";
				line += m_World.GetSurfaceY(x, z).ToString();
			}
			f.Write(line + "\n");
		}
		f.Close();
		Print(string.Format("Everon LOS Export: terrain %1 x %2 samples at %3 m", cols, rows, m_fHeightStep), LogLevel.NORMAL);
	}

	//------------------------------------------------------------------------------------------------
	// Which kind of object an entity is, for the probe: tree, bush, building, wall or "" (not probed).
	protected string ProbeKind(IEntity e, string prefab)
	{
		if (prefab.Contains("/Vegetation/Tree/"))
			return "tree";
		if (prefab.Contains("/Vegetation/Bush/"))
			return "bush";
		if (prefab.Contains("/Walls/") || prefab.Contains("/Fences/"))
			return "wall";
		string cls = e.ClassName();
		if (cls.Contains("Building") || prefab.Contains("/Structures/Houses/") || prefab.Contains("/Buildings/"))
			return "building";
		return "";
	}

	//------------------------------------------------------------------------------------------------
	// Fires straight-down rays over a 5 x 5 grid across each probed object's footprint, twice: once with
	// the bullet layer mask and once hitting every layer. Records how high each ray stopped and what it hit,
	// which shows whether roofs, walls and tree canopies stop rays, and which mask to use for the full export.
	[ButtonAttribute("Probe objects")]
	void ProbeObjects()
	{
		if (!GetWorld())
		{
			Print("Everon LOS Export: open Everon in the World Editor first", LogLevel.ERROR);
			return;
		}
		QueryArea();

		FileHandle f = OpenOut("probe.csv");
		if (!f)
			return;
		f.Write("kind,prefab,mask,gx,gz,x,z,ground,obj_height,hit_height,hit_self,hit_class,hit_prefab\n");

		map<string, int> done = new map<string, int>();
		int rays = 0;
		foreach (IEntity e : m_aFound)
		{
			string prefab = "";
			EntityPrefabData pd = e.GetPrefabData();
			if (pd)
				prefab = pd.GetPrefabName();
			string kind = ProbeKind(e, prefab);
			if (kind == "" || done.Get(kind) >= m_iTreeProbes)
				continue;
			done.Set(kind, done.Get(kind) + 1);

			vector wmin, wmax;
			e.GetWorldBounds(wmin, wmax);
			vector o = e.GetOrigin();
			float ground = m_World.GetSurfaceY(o[0], o[2]);
			float objH = wmax[1] - ground;

			for (int gx = 0; gx < 5; gx++)
			{
				for (int gz = 0; gz < 5; gz++)
				{
					float x = wmin[0] + (wmax[0] - wmin[0]) * (gx + 0.5) / 5;
					float z = wmin[2] + (wmax[2] - wmin[2]) * (gz + 0.5) / 5;
					float g = m_World.GetSurfaceY(x, z);
					for (int m = 0; m < 2; m++)
					{
						TraceParam p = new TraceParam();
						p.Start = Vector(x, wmax[1] + 20, z);
						p.End = Vector(x, g - 2, z);
						p.Flags = TraceFlags.WORLD | TraceFlags.ENTS;
						if (m == 0)
							p.LayerMask = EPhysicsLayerPresets.Projectile;
						else
							p.LayerMask = 0xFFFFFFFF;
						float frac = m_World.TraceMove(p, null);
						float hitY = p.Start[1] + (p.End[1] - p.Start[1]) * frac;

						string hitCls = "";
						string hitPrefab = "";
						int self = 0;
						IEntity hit = p.TraceEnt;
						if (hit)
						{
							hitCls = hit.ClassName();
							EntityPrefabData hpd = hit.GetPrefabData();
							if (hpd)
								hitPrefab = hpd.GetPrefabName();
							if (hit == e || hit.GetParent() == e)
								self = 1;
						}
						string mask = "projectile";
						if (m == 1)
							mask = "all";
						string line = string.Format("%1,%2,%3,%4,%5,%6,%7,%8,", kind, prefab, mask, gx, gz, x, z, g);
						line += string.Format("%1,%2,%3,%4,%5\n", objH, hitY - g, self, hitCls, hitPrefab);
						f.Write(line);
						rays++;
					}
				}
			}
		}
		f.Close();
		Print(string.Format("Everon LOS Export: probed %1 trees, %2 bushes, %3 buildings, %4 walls with %5 rays",
			done.Get("tree"), done.Get("bush"), done.Get("building"), done.Get("wall"), rays), LogLevel.NORMAL);
	}

	//------------------------------------------------------------------------------------------------
	// ISLAND EXPORT. Each of the three buttons works tile by tile and writes one file per tile, so a crash or
	// a stop loses at most one tile: click the button again and it carries on from the first missing file.
	//------------------------------------------------------------------------------------------------
	protected int TileCount()
	{
		return Math.Ceil(m_fIslandSize / m_fTile);
	}

	protected string TilePath(string dir, string prefix, int tx, int tz)
	{
		return string.Format("%1/%2/%3_%4_%5.csv", m_sOutDir, dir, prefix, tx, tz);
	}

	// Entities overlapping a box, without the huge ones (terrain, ocean, area triggers).
	protected void QueryBox(float x0, float z0, float x1, float z1)
	{
		m_aFound.Clear();
		m_World.QueryEntitiesByAABB(Vector(x0, -500, z0), Vector(x1, 3000, z1), AddEntity);
	}

	protected bool Skippable(IEntity e)
	{
		string cls = e.ClassName();
		if (cls == "DecalEntity" || cls == "LightEntity" || cls == "GameEnvironmentProbeEntity" || cls == "ProbeVolume"
			|| cls == "RoadEntity" || cls == "PowerlineEntity" || cls == "SCR_PrefabSpawnPoint" || cls == "EntityEditIcon")
			return true;
		vector wmin, wmax;
		e.GetWorldBounds(wmin, wmax);
		return wmax[0] - wmin[0] > 400 || wmax[2] - wmin[2] > 400;
	}

	//------------------------------------------------------------------------------------------------
	[ButtonAttribute("Island: objects")]
	void IslandObjects()
	{
		if (!GetWorld())
			return;
		FileIO.MakeDirectory(m_sOutDir);
		FileIO.MakeDirectory(m_sOutDir + "/objects");
		int n = TileCount();
		int made = 0;
		int total = 0;
		for (int tz = 0; tz < n; tz++)
		{
			for (int tx = 0; tx < n; tx++)
			{
				string path = TilePath("objects", "o", tx, tz);
				if (FileIO.FileExists(path))
					continue;
				if (m_iMaxTiles > 0 && made >= m_iMaxTiles)
				{
					Print(string.Format("Everon LOS Export: stopped after %1 tiles; click again to continue", made), LogLevel.NORMAL);
					return;
				}
				float x0 = tx * m_fTile;
				float z0 = tz * m_fTile;
				QueryBox(x0, z0, x0 + m_fTile, z0 + m_fTile);
				FileHandle f = FileIO.OpenFile(path, FileMode.WRITE);
				if (!f)
				{
					Print("Everon LOS Export: could not write " + path, LogLevel.ERROR);
					return;
				}
				f.Write("class,prefab,x,y,z,yaw,pitch,roll,scale,minx,miny,minz,maxx,maxy,maxz\n");
				int count = 0;
				foreach (IEntity e : m_aFound)
				{
					vector o = e.GetOrigin();
					// each entity once: in the tile holding its origin
					if (o[0] < x0 || o[0] >= x0 + m_fTile || o[2] < z0 || o[2] >= z0 + m_fTile || Skippable(e))
						continue;
					string prefab = "";
					EntityPrefabData pd = e.GetPrefabData();
					if (pd)
						prefab = pd.GetPrefabName();
					vector wmin, wmax;
					e.GetWorldBounds(wmin, wmax);
					vector ypr = e.GetYawPitchRoll();
					string line = string.Format("%1,%2,%3,%4,%5,%6,%7,%8,", e.ClassName(), prefab, o[0], o[1], o[2], ypr[0], ypr[1], ypr[2]);
					line += string.Format("%1,%2,%3,%4,%5,%6,%7\n", e.GetScale(), wmin[0], wmin[1], wmin[2], wmax[0], wmax[1], wmax[2]);
					f.Write(line);
					count++;
				}
				f.Close();
				made++;
				total += count;
				Print(string.Format("Everon LOS Export: objects tile %1,%2 - %3 objects", tx, tz, count), LogLevel.NORMAL);
			}
		}
		Print(string.Format("Everon LOS Export: island objects done (%1 new tiles, %2 objects)", made, total), LogLevel.NORMAL);
	}

	//------------------------------------------------------------------------------------------------
	[ButtonAttribute("Island: terrain")]
	void IslandTerrain()
	{
		if (!GetWorld())
			return;
		FileIO.MakeDirectory(m_sOutDir);
		FileIO.MakeDirectory(m_sOutDir + "/terrain");
		int n = TileCount();
		int made = 0;
		int per = Math.Round(m_fTile / m_fIslandTerrainStep); // samples per tile side; the next tile repeats the edge
		for (int tz = 0; tz < n; tz++)
		{
			for (int tx = 0; tx < n; tx++)
			{
				string path = TilePath("terrain", "t", tx, tz);
				if (FileIO.FileExists(path))
					continue;
				if (m_iMaxTiles > 0 && made >= m_iMaxTiles)
				{
					Print(string.Format("Everon LOS Export: stopped after %1 tiles; click again to continue", made), LogLevel.NORMAL);
					return;
				}
				FileHandle f = FileIO.OpenFile(path, FileMode.WRITE);
				if (!f)
				{
					Print("Everon LOS Export: could not write " + path, LogLevel.ERROR);
					return;
				}
				float x0 = tx * m_fTile;
				float z0 = tz * m_fTile;
				// Header: x0, z0, step, columns, rows. Heights in centimetres, one row per line, south to north.
				f.Write(string.Format("%1,%2,%3,%4,%5\n", x0, z0, m_fIslandTerrainStep, per + 1, per + 1));
				for (int r = 0; r <= per; r++)
				{
					float z = z0 + r * m_fIslandTerrainStep;
					string line = "";
					for (int c = 0; c <= per; c++)
					{
						int cm = Math.Round(m_World.GetSurfaceY(x0 + c * m_fIslandTerrainStep, z) * 100);
						if (c > 0)
							line += ",";
						line += cm.ToString();
					}
					f.Write(line + "\n");
				}
				f.Close();
				made++;
				Print(string.Format("Everon LOS Export: terrain tile %1,%2", tx, tz), LogLevel.NORMAL);
			}
		}
		Print(string.Format("Everon LOS Export: island terrain done (%1 new tiles)", made), LogLevel.NORMAL);
	}

	//------------------------------------------------------------------------------------------------
	// What a ray hit: 1 building, 2 other solid (walls, fences, rocks, props), 3 vegetation, 0 nothing / water.
	protected int HitKind(IEntity hit)
	{
		if (!hit)
			return 0;
		string cls = hit.ClassName();
		if (cls == "Tree")
			return 3;
		if (cls.Contains("Lake") || cls.Contains("Ocean") || cls.Contains("Terrain") || cls.Contains("River"))
			return 0;
		if (cls.Contains("Building"))
			return 1;
		return 2;
	}

	protected float Trace(vector from, vector to, int mask, out IEntity hit)
	{
		TraceParam p = new TraceParam();
		p.Start = from;
		p.End = to;
		p.Flags = TraceFlags.WORLD | TraceFlags.ENTS;
		p.LayerMask = mask;
		float frac = m_World.TraceMove(p, null);
		hit = p.TraceEnt;
		return frac;
	}

	// Rays over every spot an object covers. For each spot it writes (all heights in decimetres above the ground):
	//   col,row,top,bottom,kind,cover
	// top    - where a straight-down ray that hits everything stops (roof, wall top, canopy top)
	// bottom - for vegetation, where a ray going up from 0.3 m first hits (canopy underside; 0 for a trunk or a bush)
	// kind   - 1 building, 2 other solid, 3 vegetation
	// cover  - where a straight-down bullet ray stops (what stops rounds: roofs, walls, trunks; 0 if nothing)
	[ButtonAttribute("Island: surfaces")]
	void IslandSurfaces()
	{
		if (!GetWorld())
			return;
		FileIO.MakeDirectory(m_sOutDir);
		FileIO.MakeDirectory(m_sOutDir + "/surface");
		int n = TileCount();
		int made = 0;
		int per = Math.Round(m_fTile / m_fScanStep);
		array<int> occ = new array<int>();
		occ.Resize(per * per);
		for (int tz = 0; tz < n; tz++)
		{
			for (int tx = 0; tx < n; tx++)
			{
				string path = TilePath("surface", "s", tx, tz);
				if (FileIO.FileExists(path))
					continue;
				if (m_iMaxTiles > 0 && made >= m_iMaxTiles)
				{
					Print(string.Format("Everon LOS Export: stopped after %1 tiles; click again to continue", made), LogLevel.NORMAL);
					return;
				}
				float x0 = tx * m_fTile;
				float z0 = tz * m_fTile;

				// Mark the spots any object's footprint covers (objects reaching in from next door included).
				for (int i = 0; i < per * per; i++)
					occ[i] = 0;
				QueryBox(x0 - 50, z0 - 50, x0 + m_fTile + 50, z0 + m_fTile + 50);
				foreach (IEntity e : m_aFound)
				{
					if (Skippable(e))
						continue;
					vector wmin, wmax;
					e.GetWorldBounds(wmin, wmax);
					int c0 = Math.Max(0, Math.Floor((wmin[0] - x0) / m_fScanStep));
					int c1 = Math.Min(per - 1, Math.Floor((wmax[0] - x0) / m_fScanStep));
					int r0 = Math.Max(0, Math.Floor((wmin[2] - z0) / m_fScanStep));
					int r1 = Math.Min(per - 1, Math.Floor((wmax[2] - z0) / m_fScanStep));
					for (int rr = r0; rr <= r1; rr++)
						for (int cc = c0; cc <= c1; cc++)
							occ[rr * per + cc] = 1;
				}

				FileHandle f = FileIO.OpenFile(path, FileMode.WRITE);
				if (!f)
				{
					Print("Everon LOS Export: could not write " + path, LogLevel.ERROR);
					return;
				}
				f.Write(string.Format("%1,%2,%3,%4,%5\n", x0, z0, m_fScanStep, per, per));
				int spots = 0;
				int written = 0;
				for (int r = 0; r < per; r++)
				{
					string block = "";
					for (int c = 0; c < per; c++)
					{
						if (occ[r * per + c] == 0)
							continue;
						spots++;
						float x = x0 + (c + 0.5) * m_fScanStep;
						float z = z0 + (r + 0.5) * m_fScanStep;
						float g = m_World.GetSurfaceY(x, z);
						IEntity hit;
						float frac = Trace(Vector(x, g + 150, z), Vector(x, g - 1, z), 0xFFFFFFFF, hit);
						float top = 151 * (1 - frac) - 1; // metres above the ground where it stopped
						int kind = HitKind(hit);
						if (kind == 0 || top < 0.2)
							continue;
						float bottom = 0;
						if (kind == 3)
						{
							IEntity up;
							float fu = Trace(Vector(x, g + 0.3, z), Vector(x, g + top + 0.5, z), 0xFFFFFFFF, up);
							if (fu < 1)
								bottom = 0.3 + (top + 0.2) * fu;
							else
								bottom = top;
						}
						IEntity bhit;
						float fb = Trace(Vector(x, g + 150, z), Vector(x, g - 1, z), EPhysicsLayerPresets.Projectile, bhit);
						float cover = 151 * (1 - fb) - 1;
						if (HitKind(bhit) == 0 || cover < 0.2)
							cover = 0;
						int topDm = Math.Round(top * 10);
						int botDm = Math.Round(bottom * 10);
						int covDm = Math.Round(cover * 10);
						block += string.Format("%1,%2,%3,%4,%5,%6\n", c, r, topDm, botDm, kind, covDm);
						written++;
					}
					if (block != "")
						f.Write(block);
				}
				f.Close();
				made++;
				Print(string.Format("Everon LOS Export: surface tile %1,%2 - %3 spots scanned, %4 blocked", tx, tz, spots, written), LogLevel.NORMAL);
			}
		}
		Print(string.Format("Everon LOS Export: island surfaces done (%1 new tiles)", made), LogLevel.NORMAL);
	}

	//------------------------------------------------------------------------------------------------
	// ACCURACY CHECK: random sight lines across the island, fired by the engine itself, so the map's line of sight can
	// be scored against the game. Observers crouch (eyes 1 m up) or sit in a vehicle (2 m); targets stand (chest 1.5 m);
	// 10 m to 1 km apart (evenly spread on a log scale), both on land. Two rays each: one that stops on anything
	// (sight, as the scan measured it) and one that stops only what stops bullets.
	// check.csv: ox,oz,og,eye,tx,tz,tg,target,dist,frac_all,hit_all,frac_bullet
	[ButtonAttribute("Check: sight lines")]
	void CheckSightLines()
	{
		if (!GetWorld())
			return;
		FileHandle f = OpenOut("check.csv");
		if (!f)
			return;
		f.Write("ox,oz,og,eye,tx,tz,tg,target,dist,frac_all,hit_all,frac_bullet\n");
		Math.Randomize(12345);
		int made = 0;
		int tries = 0;
		while (made < m_iCheckPairs && tries < m_iCheckPairs * 20)
		{
			tries++;
			float ox = Math.RandomFloat(200, m_fIslandSize - 200);
			float oz = Math.RandomFloat(200, m_fIslandSize - 200);
			float og = m_World.GetSurfaceY(ox, oz);
			if (og < 1)
				continue;
			float dist = Math.Pow(10, Math.RandomFloat(1, 3));
			float ang = Math.RandomFloat(0, Math.PI2);
			float tx = ox + Math.Sin(ang) * dist;
			float tz = oz + Math.Cos(ang) * dist;
			if (tx < 0 || tz < 0 || tx > m_fIslandSize || tz > m_fIslandSize)
				continue;
			float tg = m_World.GetSurfaceY(tx, tz);
			if (tg < 1)
				continue;
			float eye = 1;
			if (Math.RandomFloat01() < 0.3)
				eye = 2;
			float target = 1.5;
			vector from = Vector(ox, og + eye, oz);
			vector to = Vector(tx, tg + target, tz);
			IEntity hit;
			float fa = Trace(from, to, 0xFFFFFFFF, hit);
			string hitCls = "";
			if (hit)
				hitCls = hit.ClassName();
			IEntity bhit;
			float fb = Trace(from, to, EPhysicsLayerPresets.Projectile, bhit);
			string line = string.Format("%1,%2,%3,%4,%5,%6,%7,%8,", ox, oz, og, eye, tx, tz, tg, target);
			line += string.Format("%1,%2,%3,%4\n", dist, fa, hitCls, fb);
			f.Write(line);
			made++;
		}
		f.Close();
		Print(string.Format("Everon LOS Export: accuracy check - %1 sight lines written", made), LogLevel.NORMAL);
	}
}

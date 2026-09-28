// Everon Foliage Measure - a World Editor tool that photographs trees and bushes to measure how much you can see
// through them, for the Everon Field Map's line of sight.
//
// The line-of-sight export measures plants with the engine's physics rays, which stop on a plant's solid collision
// shape, so the map treats foliage as more solid than it looks in game. This tool measures what is actually drawn:
// it places one plant of each kind on its own in an empty world, points the camera at it from a few sides and takes
// two screenshots from exactly the same spot, one with the plant and one with it hidden. The pixels that differ are
// where the plant blocks the view. tools/measure_foliage.py turns the pairs into how much of the view each 0.5 m of
// height blocks.
//
// Photographing plants where they grow on Everon didn't work: fences, walls, reed beds and other plants kept getting
// between the camera and the plant. Alone in an empty world nothing is in the way and every kind is shot the same way.
//
// The plant floats m_fLift above the ground, so its shadow falls well below it, and the camera sits m_fCamHeight
// above the plant's base looking up at it, so most of the plant is seen against the sky. The camera always looks the
// way it faced when you clicked; the plant is turned for each side instead, so every shot has the same background.
// Don't shoot over the sea: its waves change between the two pictures and count as plant.
//
// Steps:
//   1. Open Everon and click "1. Save plant list (Everon open)" - writes plants.csv: every kind of standing tree and
//      bush on the island (not stumps, fallen trunks or branches), how many there are and their average size.
//   2. Open an empty world with sky and sunlight, e.g. EmptyEden (Everon's terrain with nothing on it), fly the
//      camera to open, flat, bare ground and face it level across land. Each plant goes 20 m in front of the camera
//      (or at m_vSpot if set).
//   3. Click "2. Test: one tree and one bush" and check the four screenshots: in each pair the plant should be in the
//      middle of the "_a" picture and gone from the "_b" one, all else the same.
//   4. Click "3. Measure all plants". Finished kinds are skipped, so it can be stopped and run again.
//   "Stop" stops after the current shot (Esc does the same while the viewport has focus).
//
// Each plant is added to the world, photographed and deleted again. Don't save the empty world while it runs.
// For consistent screenshots, make the viewport full screen (F11) straight after clicking a button, as with
// EnfusionMapMaker's capture tool, whose camera and screenshot calls this follows.
// Output goes to Documents\My Games\ArmaReforgerWorkbench\profile\everon_los\foliage: <id>_a.png (plant shown),
// <id>_b.png (plant hidden), shots.csv (where each plant and camera were) and plants.csv (the plant list).

[WorkbenchToolAttribute(name: "Everon Foliage Measure", description: "Photograph trees and bushes to measure how see-through they are", wbModules: {"WorldEditor"}, awesomeFontCode: 0xf1bb)]
class EveronFoliageMeasureTool : WorldEditorTool
{
	[Attribute("0 0 0", UIWidgets.Coords, "South-west corner of the area to list plants from (X, ignored, Z)", category: "Plant list")]
	vector m_vAreaMin;

	[Attribute("12800 0 12800", UIWidgets.Coords, "North-east corner of the area to list plants from (X, ignored, Z)", category: "Plant list")]
	vector m_vAreaMax;

	[Attribute("0 0 0", UIWidgets.Coords, "Where in the empty world to put each plant (X, ignored, Z); 0 0 0 = 20 m in front of the camera when you click", category: "Measure")]
	vector m_vSpot;

	[Attribute("16", UIWidgets.EditBox, "How many sides of each plant to photograph (the plant is turned between them)", category: "Measure")]
	int m_iSides;

	[Attribute("0", UIWidgets.EditBox, "Stop after this many kinds of plant per click (0 = all); click again to continue", category: "Measure")]
	int m_iMaxKinds;

	[Attribute("40", UIWidgets.EditBox, "Camera vertical field of view in degrees", category: "Camera")]
	float m_fFov;

	[Attribute("2", UIWidgets.EditBox, "Height of the plant's base above the ground or water in metres", category: "Measure")]
	float m_fLift;

	[Attribute("0.5", UIWidgets.EditBox, "Camera height above the plant's base in metres", category: "Camera")]
	float m_fCamHeight;

	[Attribute("-1", UIWidgets.EditBox, "Fixed exposure (-1 = the editor's automatic exposure)", category: "Camera")]
	float m_fExposure;

	[Attribute("5000", UIWidgets.EditBox, "Wait before starting (ms), to make the viewport full screen (F11)", category: "Timing")]
	int m_iStartSleep;

	[Attribute("3000", UIWidgets.EditBox, "Wait after adding a plant (ms), so its model and textures load", category: "Timing")]
	int m_iLoadSleep;

	[Attribute("500", UIWidgets.EditBox, "Wait after moving the camera (ms), so the plant's full detail loads", category: "Timing")]
	int m_iMoveSleep;

	[Attribute("200", UIWidgets.EditBox, "Wait after hiding, showing or turning the plant (ms)", category: "Timing")]
	int m_iHideSleep;

	[Attribute("300", UIWidgets.EditBox, "Wait after each screenshot (ms), so it finishes writing", category: "Timing")]
	int m_iShotSleep;

	[Attribute("$profile:everon_los/foliage", UIWidgets.EditBox, "Output folder", category: "Output")]
	string m_sOutDir;

	protected BaseWorld m_World;
	protected WorldEditorAPI m_WeApi;
	protected ref map<string, int> m_mCount = new map<string, int>();
	protected ref map<string, float> m_mScaleSum = new map<string, float>();
	protected vector m_vUseSpot;
	protected float m_fHeading; // the way the camera looks, degrees clockwise from north
	protected bool m_bRunning;
	protected bool m_bStop;

	//------------------------------------------------------------------------------------------------
	protected bool Setup()
	{
		WorldEditor worldEditor = Workbench.GetModule(WorldEditor);
		if (!worldEditor)
			return false;
		m_WeApi = worldEditor.GetApi();
		if (!m_WeApi)
			return false;
		m_World = m_WeApi.GetWorld();
		return m_World != null;
	}

	//------------------------------------------------------------------------------------------------
	// True for standing trees and bushes: not fallen trunks, stumps or branches lying on the ground.
	protected bool IsStandingPlant(string prefab)
	{
		if (!prefab.Contains("/Vegetation/Tree/") && !prefab.Contains("/Vegetation/Bush/"))
			return false;
		string lower = prefab;
		lower.ToLower();
		if (lower.Contains("/debris/") || lower.Contains("_stump") || lower.Contains("_branch") || lower.Contains("_fallen"))
			return false;
		return true;
	}

	//------------------------------------------------------------------------------------------------
	// Query callback: counts every standing tree and bush and adds up their sizes.
	protected bool AddPlant(IEntity e)
	{
		EntityPrefabData pd = e.GetPrefabData();
		if (!pd)
			return true;
		string prefab = pd.GetPrefabName();
		if (!IsStandingPlant(prefab))
			return true;
		m_mCount.Set(prefab, m_mCount.Get(prefab) + 1);
		m_mScaleSum.Set(prefab, m_mScaleSum.Get(prefab) + e.GetScale());
		return true;
	}

	//------------------------------------------------------------------------------------------------
	// A short, file-name-safe name for a prefab: its file name plus its resource ID.
	protected string PrefabKey(string prefab)
	{
		string guid = "";
		int close = prefab.IndexOf("}");
		if (prefab.IndexOf("{") == 0 && close > 1)
			guid = prefab.Substring(1, close - 1);
		string file = prefab;
		int slash = prefab.LastIndexOf("/");
		if (slash >= 0)
			file = prefab.Substring(slash + 1, prefab.Length() - slash - 1);
		int dot = file.LastIndexOf(".");
		if (dot > 0)
			file = file.Substring(0, dot);
		if (guid != "")
			return file + "_" + guid;
		return file;
	}

	//------------------------------------------------------------------------------------------------
	protected string KindOf(string prefab)
	{
		if (prefab.Contains("/Vegetation/Tree/"))
			return "tree";
		return "bush";
	}

	//------------------------------------------------------------------------------------------------
	protected void ApplyCamera()
	{
		int camId = m_World.GetCurrentCameraId();
		m_World.SetCameraVerticalFOV(camId, m_fFov);
		m_World.SetCameraHDRBrightness(camId, m_fExposure);
	}

	//------------------------------------------------------------------------------------------------
	// Photographs plant e looking along bearing (degrees clockwise from north). gy is the ground under the plant.
	protected bool ShootSide(IEntity e, float gy, string prefab, string kind, string id, float bearing, FileHandle csv)
	{
		vector wmin, wmax;
		e.GetWorldBounds(wmin, wmax);
		float cx = (wmin[0] + wmax[0]) * 0.5;
		float cz = (wmin[2] + wmax[2]) * 0.5;
		float h = wmax[1] - gy;
		if (h < 0.3 || h > 60)
		{
			Print(string.Format("Everon Foliage Measure: %1 is %2 m tall - skipped", id, h), LogLevel.WARNING);
			return false;
		}
		float halfW = Math.Max(wmax[0] - wmin[0], wmax[2] - wmin[2]) * 0.5;

		float rad = bearing * Math.DEG2RAD;
		float dx = Math.Sin(rad);
		float dz = Math.Cos(rad);

		// Back off until the whole plant fits in the frame, with a margin (the frame is assumed at least 4:3).
		float vHalf = m_fFov * 0.5 * Math.DEG2RAD;
		float hHalf = Math.Atan2(Math.Tan(vHalf) * 1.33, 1);
		float dist = Math.Max(3, halfW + 1);
		float camY = 0;
		float pitch = 0;
		bool fits = false;
		for (int tries = 0; tries < 40 && !fits; tries++)
		{
			camY = gy + m_fCamHeight;
			float aTop = Math.Atan2(gy + h - camY, dist);
			float aBase = Math.Atan2(gy - camY, dist);
			float aSide = Math.Atan2(halfW, dist - halfW);
			pitch = (aTop + aBase) * 0.5;
			if (aTop - aBase < vHalf * 2 * 0.85 && aSide < hHalf * 0.85)
				fits = true;
			else
				dist = dist * 1.12;
		}
		if (!fits)
			return false;
		vector cam = Vector(cx - dx * dist, camY, cz - dz * dist);

		// Point the camera at the plant, pitched to centre it. SetCamera takes a look direction, not angles.
		float cp = Math.Cos(pitch);
		vector look = Vector(dx * cp, Math.Sin(pitch), dz * cp);
		float pitchDeg = pitch * Math.RAD2DEG;
		ApplyCamera();
		m_WeApi.SetCamera(cam, look);
		ApplyCamera();
		Sleep(m_iMoveSleep);

		string path = m_sOutDir + "/" + id;
		if (!System.MakeScreenshot(path + "_a"))
		{
			Print("Everon Foliage Measure: screenshot failed - " + path, LogLevel.ERROR);
			m_bStop = true;
			return false;
		}
		Sleep(m_iShotSleep);
		e.ClearFlags(EntityFlags.VISIBLE, true);
		Sleep(m_iHideSleep);
		bool shot = System.MakeScreenshot(path + "_b");
		Sleep(m_iShotSleep);
		e.SetFlags(EntityFlags.VISIBLE, true);
		Sleep(m_iHideSleep);
		if (!shot)
		{
			Print("Everon Foliage Measure: screenshot failed - " + path, LogLevel.ERROR);
			m_bStop = true;
			return false;
		}

		string line = string.Format("%1,%2,%3,%4,%5,%6,%7,", id, prefab, kind, cx, cz, gy, h);
		line += string.Format("%1,%2,%3,%4,%5,%6,", wmin[0], wmin[1], wmin[2], wmax[0], wmax[1], wmax[2]);
		line += string.Format("%1,%2,%3,%4,%5,", cam[0], cam[1], cam[2], dx, dz);
		line += string.Format("%1,%2,%3,%4\n", bearing, pitchDeg, m_fFov, dist);
		csv.Write(line);
		Print(string.Format("Everon Foliage Measure: %1 (%2 m tall) from %3 deg", id, h, Math.Round(bearing)), LogLevel.NORMAL);
		return true;
	}

	//------------------------------------------------------------------------------------------------
	// Adds one plant of this kind at m_vSpot, photographs it from every side not yet done, then deletes it.
	// Returns how many new shots were taken.
	protected int ShootPrefab(string prefab, int sides, FileHandle csv)
	{
		string key = PrefabKey(prefab);
		string kind = KindOf(prefab);
		bool anyMissing = false;
		for (int s = 0; s < sides; s++)
		{
			if (!FileIO.FileExists(m_sOutDir + "/" + key + "_0_" + s + "_b.png"))
				anyMissing = true;
		}
		if (!anyMissing)
			return 0;

		// The plant's base goes m_fLift above the ground or the sea, whichever is higher. Plants' heights in the World
		// Editor are relative to the ground.
		float terrainY = m_World.GetSurfaceY(m_vUseSpot[0], m_vUseSpot[2]);
		float surfaceY = terrainY;
		if (m_World.IsOcean())
			surfaceY = Math.Max(surfaceY, m_World.GetOceanBaseHeight());
		float gy = surfaceY + m_fLift;
		vector pos = Vector(m_vUseSpot[0], gy - terrainY, m_vUseSpot[2]);
		m_WeApi.BeginEntityAction("Everon Foliage Measure");
		IEntitySource src = m_WeApi.CreateEntity(prefab, "", m_WeApi.GetCurrentEntityLayerId(), null, pos, vector.Zero);
		m_WeApi.EndEntityAction("Everon Foliage Measure");
		if (!src)
		{
			Print("Everon Foliage Measure: could not add " + prefab, LogLevel.WARNING);
			return 0;
		}
		IEntity e = m_WeApi.SourceToEntity(src);
		int shots = 0;
		if (e)
		{
			// Measure from the plant's own base, and say so if it didn't land at the height asked for.
			vector origin = e.GetOrigin();
			float baseY = origin[1];
			if (Math.AbsFloat(baseY - gy) > 0.3)
				Print(string.Format("Everon Foliage Measure: %1 is %2 m above the ground or water, not %3", key, baseY - surfaceY, m_fLift), LogLevel.WARNING);
			gy = baseY;
			Sleep(m_iLoadSleep);
			for (int side = 0; side < sides && !m_bStop; side++)
			{
				string id = key + "_0_" + side;
				if (FileIO.FileExists(m_sOutDir + "/" + id + "_b.png"))
					continue;
				// Turn the plant, not the camera, so every shot has the same background.
				e.SetYawPitchRoll(Vector(side * 360.0 / sides, 0, 0));
				e.Update();
				Sleep(m_iHideSleep);
				if (ShootSide(e, gy, prefab, kind, id, m_fHeading, csv))
					shots++;
			}
		}
		else
			Print("Everon Foliage Measure: no entity for " + prefab, LogLevel.WARNING);

		m_WeApi.BeginEntityAction("Everon Foliage Measure");
		m_WeApi.DeleteEntity(src);
		m_WeApi.EndEntityAction("Everon Foliage Measure");
		return shots;
	}

	//------------------------------------------------------------------------------------------------
	// Reads plants.csv: prefabs, kinds and counts, in file order.
	protected bool LoadPlantList(array<string> prefabs, array<string> kinds, array<int> counts)
	{
		string listPath = m_sOutDir + "/plants.csv";
		FileHandle f = FileIO.OpenFile(listPath, FileMode.READ);
		if (!f)
		{
			Print("Everon Foliage Measure: no plant list - open Everon and click \"1. Save plant list\" first", LogLevel.ERROR);
			return false;
		}
		string row;
		bool header = true;
		while (f.ReadLine(row) >= 0)
		{
			if (header)
			{
				header = false;
				continue;
			}
			array<string> cols = new array<string>();
			row.Split(",", cols, false);
			if (cols.Count() < 3)
				continue;
			prefabs.Insert(cols[0]);
			kinds.Insert(cols[1]);
			counts.Insert(cols[2].ToInt());
		}
		f.Close();
		return prefabs.Count() > 0;
	}

	//------------------------------------------------------------------------------------------------
	protected void Run(bool test)
	{
		if (m_bRunning)
		{
			Print("Everon Foliage Measure: already running", LogLevel.WARNING);
			return;
		}
		if (!Setup())
		{
			Print("Everon Foliage Measure: open the empty world in the World Editor first", LogLevel.ERROR);
			return;
		}
		array<string> prefabs = new array<string>();
		array<string> kinds = new array<string>();
		array<int> counts = new array<int>();
		if (!LoadPlantList(prefabs, kinds, counts))
			return;

		// The test uses the most common tree and the most common bush, from two sides each.
		array<string> todo = new array<string>();
		int sides = m_iSides;
		if (test)
		{
			sides = 2;
			int bestTree = -1;
			int bestBush = -1;
			for (int i = 0; i < prefabs.Count(); i++)
			{
				if (kinds[i] == "tree" && (bestTree < 0 || counts[i] > counts[bestTree]))
					bestTree = i;
				if (kinds[i] == "bush" && (bestBush < 0 || counts[i] > counts[bestBush]))
					bestBush = i;
			}
			if (bestTree >= 0)
				todo.Insert(prefabs[bestTree]);
			if (bestBush >= 0)
				todo.Insert(prefabs[bestBush]);
		}
		else
			todo.Copy(prefabs);

		// Every shot looks the way the camera faces when you click, so pick a view with still ground behind (no sea:
		// its waves change between the two pictures). The plants go m_vSpot, or 20 m in front of the camera.
		vector camMat[4];
		m_World.GetCurrentCamera(camMat);
		vector camDir = camMat[2];
		vector fwd = Vector(camDir[0], 0, camDir[2]);
		if (fwd.Length() < 0.01)
			fwd = Vector(0, 0, 1);
		fwd.Normalize();
		m_fHeading = Math.Atan2(fwd[0], fwd[2]) * Math.RAD2DEG;
		m_vUseSpot = m_vSpot;
		if (m_vSpot[0] == 0 && m_vSpot[2] == 0)
			m_vUseSpot = camMat[3] + fwd * 20;
		Print(string.Format("Everon Foliage Measure: plants go at %1 %2, camera facing %3 deg", m_vUseSpot[0], m_vUseSpot[2], Math.Round(m_fHeading)), LogLevel.NORMAL);

		m_bRunning = true;
		m_bStop = false;
		FileIO.MakeDirectory("$profile:everon_los");
		FileIO.MakeDirectory(m_sOutDir);
		string csvPath = m_sOutDir + "/shots.csv";
		bool isNew = !FileIO.FileExists(csvPath);
		FileHandle csv = FileIO.OpenFile(csvPath, FileMode.APPEND);
		if (!csv)
		{
			Print("Everon Foliage Measure: could not write " + csvPath, LogLevel.ERROR);
			m_bRunning = false;
			return;
		}
		if (isNew)
			csv.Write("id,prefab,kind,x,z,ground,height,minx,miny,minz,maxx,maxy,maxz,camx,camy,camz,dirx,dirz,yaw,pitch,fov,dist\n");

		Print(string.Format("Everon Foliage Measure: %1 kinds of plant to photograph - starting in %2 s, press F11 now", todo.Count(), m_iStartSleep / 1000), LogLevel.NORMAL);
		Sleep(m_iStartSleep);
		int kindsDone = 0;
		int shots = 0;
		foreach (string prefab : todo)
		{
			if (m_bStop)
				break;
			if (m_iMaxKinds > 0 && kindsDone >= m_iMaxKinds)
			{
				Print(string.Format("Everon Foliage Measure: stopped after %1 kinds; click again to continue", kindsDone), LogLevel.NORMAL);
				break;
			}
			int got = ShootPrefab(prefab, sides, csv);
			if (got > 0)
				kindsDone++;
			shots += got;
		}
		csv.Close();
		m_World.SetCameraHDRBrightness(m_World.GetCurrentCameraId(), -1);
		m_bRunning = false;
		Print(string.Format("Everon Foliage Measure: done - %1 new shots in %2", shots, m_sOutDir), LogLevel.NORMAL);
	}

	//------------------------------------------------------------------------------------------------
	[ButtonAttribute("1. Save plant list (Everon open)")]
	void SavePlantList()
	{
		if (!Setup())
		{
			Print("Everon Foliage Measure: open Everon in the World Editor first", LogLevel.ERROR);
			return;
		}
		m_mCount.Clear();
		m_mScaleSum.Clear();
		for (float qz = m_vAreaMin[2]; qz < m_vAreaMax[2]; qz += 500)
		{
			for (float qx = m_vAreaMin[0]; qx < m_vAreaMax[0]; qx += 500)
			{
				vector qmin = Vector(qx, -500, qz);
				vector qmax = Vector(Math.Min(qx + 500, m_vAreaMax[0]), 3000, Math.Min(qz + 500, m_vAreaMax[2]));
				m_World.QueryEntitiesByAABB(qmin, qmax, AddPlant);
			}
		}
		array<string> prefabs = new array<string>();
		for (int k = 0; k < m_mCount.Count(); k++)
			prefabs.Insert(m_mCount.GetKey(k));
		prefabs.Sort();
		if (prefabs.Count() == 0)
		{
			Print("Everon Foliage Measure: no trees or bushes found - is Everon open? Plant list not saved", LogLevel.ERROR);
			return;
		}

		FileIO.MakeDirectory("$profile:everon_los");
		FileIO.MakeDirectory(m_sOutDir);
		string listPath = m_sOutDir + "/plants.csv";
		FileHandle f = FileIO.OpenFile(listPath, FileMode.WRITE);
		if (!f)
		{
			Print("Everon Foliage Measure: could not write " + listPath, LogLevel.ERROR);
			return;
		}
		f.Write("prefab,kind,count,mean_scale\n");
		foreach (string prefab : prefabs)
		{
			int n = m_mCount.Get(prefab);
			f.Write(string.Format("%1,%2,%3,%4\n", prefab, KindOf(prefab), n, m_mScaleSum.Get(prefab) / n));
		}
		f.Close();
		Print(string.Format("Everon Foliage Measure: %1 kinds of tree and bush saved to %2", prefabs.Count(), listPath), LogLevel.NORMAL);
	}

	[ButtonAttribute("2. Test: one tree and one bush")]
	void TestOne()
	{
		Run(true);
	}

	[ButtonAttribute("3. Measure all plants")]
	void MeasurePlants()
	{
		Run(false);
	}

	[ButtonAttribute("Stop")]
	void StopRun()
	{
		if (m_bRunning)
		{
			m_bStop = true;
			Print("Everon Foliage Measure: stopping after this shot", LogLevel.NORMAL);
		}
	}

	override void OnKeyPressEvent(KeyCode key, bool isAutoRepeat)
	{
		if (key == KeyCode.KC_ESCAPE && !isAutoRepeat && m_bRunning)
			m_bStop = true;
	}

	override void OnDeActivate()
	{
		m_bStop = true;
	}
}

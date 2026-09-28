// Everon Foliage Measure - a World Editor tool that photographs trees and bushes to measure how much you can see
// through them, for the Everon Field Map's line of sight.
//
// The line-of-sight export measures plants with the engine's physics rays, which stop on a plant's solid collision
// shape, so the map treats foliage as more solid than it looks in game. This tool measures what is actually drawn:
// for each kind of tree and bush it finds a real one on the island, points the camera at it from a few sides and
// takes two screenshots from exactly the same spot, one with the plant and one with it hidden. The pixels that
// differ are where the plant blocks the view, whatever is behind it. tools/measure_foliage.py turns the pairs into
// how much of the view each 0.5 m of height blocks.
//
// The camera sits low (m_fCamHeight above the ground) and looks up at the plant, so most of the plant is seen
// against the sky and distant land rather than the ground right behind it, where its own shadow would fall.
//
// Buttons:
//   "Test: one tree and one bush" - photographs one tree and one bush in the test area, from one side each. Run this
//                                   first and check the four screenshots: in each pair the plant should be in
//                                   the middle of the "_a" picture and gone from the "_b" one, all else the same.
//   "Measure plants"              - every kind of tree and bush in the area, m_iPerPrefab plants each, m_iSides
//                                   sides each. Finished shots are skipped, so it can be stopped and run again.
//   "Stop"                        - stops after the current shot (Esc does the same while the viewport has focus).
//
// For consistent screenshots, make the viewport full screen (F11) straight after clicking a button, as with
// EnfusionMapMaker's capture tool, whose camera and screenshot calls this follows.
// Output goes to Documents\My Games\ArmaReforgerWorkbench\profile\everon_los\foliage: <id>_a.png (plant shown),
// <id>_b.png (plant hidden) and shots.csv (where each plant and camera were).

[WorkbenchToolAttribute(name: "Everon Foliage Measure", description: "Photograph trees and bushes to measure how see-through they are", wbModules: {"WorldEditor"}, awesomeFontCode: 0xf1bb)]
class EveronFoliageMeasureTool : WorldEditorTool
{
	[Attribute("0 0 0", UIWidgets.Coords, "South-west corner of the area to look for plants in (X, ignored, Z)", category: "Area")]
	vector m_vAreaMin;

	[Attribute("12800 0 12800", UIWidgets.Coords, "North-east corner of the area to look for plants in (X, ignored, Z)", category: "Area")]
	vector m_vAreaMax;

	[Attribute("4450 0 6700", UIWidgets.Coords, "South-west corner of the area the test uses", category: "Area")]
	vector m_vTestMin;

	[Attribute("4950 0 7200", UIWidgets.Coords, "North-east corner of the area the test uses", category: "Area")]
	vector m_vTestMax;

	[Attribute("2", UIWidgets.EditBox, "How many plants of each kind to photograph", category: "Measure")]
	int m_iPerPrefab;

	[Attribute("4", UIWidgets.EditBox, "How many sides of each plant to photograph", category: "Measure")]
	int m_iSides;

	[Attribute("0", UIWidgets.EditBox, "Stop after this many kinds of plant per click (0 = all); click again to continue", category: "Measure")]
	int m_iMaxKinds;

	[Attribute("40", UIWidgets.EditBox, "Camera vertical field of view in degrees", category: "Camera")]
	float m_fFov;

	[Attribute("0.5", UIWidgets.EditBox, "Camera height above the ground in metres", category: "Camera")]
	float m_fCamHeight;

	[Attribute("-1", UIWidgets.EditBox, "Fixed exposure (-1 = the editor's automatic exposure)", category: "Camera")]
	float m_fExposure;

	[Attribute("1500", UIWidgets.EditBox, "Wait after moving the camera (ms), so the plant's full detail loads", category: "Timing")]
	int m_iMoveSleep;

	[Attribute("400", UIWidgets.EditBox, "Wait after hiding or showing the plant (ms)", category: "Timing")]
	int m_iHideSleep;

	[Attribute("600", UIWidgets.EditBox, "Wait after each screenshot (ms), so it finishes writing", category: "Timing")]
	int m_iShotSleep;

	[Attribute("$profile:everon_los/foliage", UIWidgets.EditBox, "Output folder", category: "Output")]
	string m_sOutDir;

	protected BaseWorld m_World;
	protected WorldEditorAPI m_WeApi;
	protected ref map<string, ref array<IEntity>> m_mPlants = new map<string, ref array<IEntity>>();
	protected int m_iKeep;
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
	// Query callback: keeps a few candidates of every kind of tree and bush.
	protected bool AddPlant(IEntity e)
	{
		EntityPrefabData pd = e.GetPrefabData();
		if (!pd)
			return true;
		string prefab = pd.GetPrefabName();
		if (!prefab.Contains("/Vegetation/Tree/") && !prefab.Contains("/Vegetation/Bush/"))
			return true;
		array<IEntity> list = m_mPlants.Get(prefab);
		if (!list)
		{
			list = new array<IEntity>();
			m_mPlants.Insert(prefab, list);
		}
		if (list.Count() < m_iKeep)
			list.Insert(e);
		return true;
	}

	//------------------------------------------------------------------------------------------------
	protected void Collect(vector areaMin, vector areaMax, int perPrefab)
	{
		m_mPlants.Clear();
		m_iKeep = Math.Max(6, perPrefab * 6); // spares, for plants with something in the way
		for (float qz = areaMin[2]; qz < areaMax[2]; qz += 500)
		{
			for (float qx = areaMin[0]; qx < areaMax[0]; qx += 500)
			{
				vector qmin = Vector(qx, -500, qz);
				vector qmax = Vector(Math.Min(qx + 500, areaMax[0]), 3000, Math.Min(qz + 500, areaMax[2]));
				m_World.QueryEntitiesByAABB(qmin, qmax, AddPlant);
			}
		}
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
	// True if nothing but the target (or its parts) stands between from and to.
	protected bool ClearView(vector from, vector to, IEntity target)
	{
		TraceParam p = new TraceParam();
		p.Start = from;
		p.End = to;
		p.Flags = TraceFlags.WORLD | TraceFlags.ENTS;
		p.LayerMask = 0xFFFFFFFF;
		float frac = m_World.TraceMove(p, null);
		if (frac >= 1)
			return true;
		IEntity hit = p.TraceEnt;
		while (hit)
		{
			if (hit == target)
				return true;
			hit = hit.GetParent();
		}
		return false; // another object, or the ground
	}

	//------------------------------------------------------------------------------------------------
	protected void ApplyCamera()
	{
		int camId = m_World.GetCurrentCameraId();
		m_World.SetCameraVerticalFOV(camId, m_fFov);
		m_World.SetCameraHDRBrightness(camId, m_fExposure);
	}

	//------------------------------------------------------------------------------------------------
	// Photographs plant e looking along bearing (degrees clockwise from north). False if something is in the way or
	// the camera can't be placed.
	protected bool ShootSide(IEntity e, string prefab, string kind, string id, float bearing, FileHandle csv)
	{
		vector wmin, wmax;
		e.GetWorldBounds(wmin, wmax);
		float cx = (wmin[0] + wmax[0]) * 0.5;
		float cz = (wmin[2] + wmax[2]) * 0.5;
		float gy = m_World.GetSurfaceY(cx, cz);
		float h = wmax[1] - gy;
		if (h < 0.3 || h > 60)
			return false;
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
			float camX = cx - dx * dist;
			float camZ = cz - dz * dist;
			camY = m_World.GetSurfaceY(camX, camZ) + m_fCamHeight;
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

		// Nothing else may stand in front of the plant: check its middle, top, bottom and both sides.
		vector right = Vector(dz, 0, -dx);
		float midY = gy + h * 0.5;
		if (!ClearView(cam, Vector(cx, midY, cz), e) || !ClearView(cam, Vector(cx, gy + h * 0.85, cz), e)
			|| !ClearView(cam, Vector(cx, gy + Math.Min(0.5, h * 0.3), cz), e)
			|| !ClearView(cam, Vector(cx, midY, cz) + right * (halfW * 0.7), e)
			|| !ClearView(cam, Vector(cx, midY, cz) - right * (halfW * 0.7), e))
			return false;

		// Point the camera: the engine's own yaw for this direction, and the pitch that centres the plant.
		vector look = Vector(dx, 0, dz);
		vector ang = look.VectorToAngles();
		float pitchDeg = pitch * Math.RAD2DEG;
		ApplyCamera();
		m_WeApi.SetCamera(cam, Vector(ang[0], pitchDeg, 0));
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
		line += string.Format("%1,%2,%3,%4\n", ang[0], pitchDeg, m_fFov, dist);
		csv.Write(line);
		Print(string.Format("Everon Foliage Measure: %1 (%2 m tall) from %3 deg", id, h, Math.Round(bearing)), LogLevel.NORMAL);
		return true;
	}

	//------------------------------------------------------------------------------------------------
	protected void Run(vector areaMin, vector areaMax, int perPrefab, int sides, bool test)
	{
		if (m_bRunning)
		{
			Print("Everon Foliage Measure: already running", LogLevel.WARNING);
			return;
		}
		if (!Setup())
		{
			Print("Everon Foliage Measure: open Everon in the World Editor first", LogLevel.ERROR);
			return;
		}
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

		Print("Everon Foliage Measure: looking for trees and bushes...", LogLevel.NORMAL);
		Collect(areaMin, areaMax, perPrefab);
		array<string> prefabs = new array<string>();
		for (int k = 0; k < m_mPlants.Count(); k++)
			prefabs.Insert(m_mPlants.GetKey(k));
		prefabs.Sort();
		Print(string.Format("Everon Foliage Measure: %1 kinds of tree and bush found", prefabs.Count()), LogLevel.NORMAL);

		int kindsDone = 0;
		int shots = 0;
		bool gotTree = false;
		bool gotBush = false;
		foreach (string prefab : prefabs)
		{
			if (m_bStop)
				break;
			if (m_iMaxKinds > 0 && kindsDone >= m_iMaxKinds)
			{
				Print(string.Format("Everon Foliage Measure: stopped after %1 kinds; click again to continue", kindsDone), LogLevel.NORMAL);
				break;
			}
			string kind = "bush";
			if (prefab.Contains("/Vegetation/Tree/"))
				kind = "tree";
			if (test && ((kind == "tree" && gotTree) || (kind == "bush" && gotBush)))
				continue;

			string key = PrefabKey(prefab);
			array<IEntity> list = m_mPlants.Get(prefab);
			int plantsDone = 0;
			bool tookNew = false;
			foreach (IEntity e : list)
			{
				if (plantsDone >= perPrefab || m_bStop)
					break;
				int sidesDone = 0;
				// Evenly spaced sides first, then the ones in between if something was in the way.
				for (int pass = 0; pass < 3 && sidesDone < sides && !m_bStop; pass++)
				{
					for (int s = 0; s < sides && sidesDone < sides && !m_bStop; s++)
					{
						string id = string.Format("%1_%2_%3", key, plantsDone, sidesDone);
						if (FileIO.FileExists(m_sOutDir + "/" + id + "_b.png"))
						{
							sidesDone++;
							continue;
						}
						float bearing = (s * 3 + pass) * 360.0 / (sides * 3);
						if (ShootSide(e, prefab, kind, id, bearing, csv))
						{
							sidesDone++;
							shots++;
							tookNew = true;
						}
					}
				}
				if (sidesDone > 0)
					plantsDone++;
			}
			if (plantsDone == 0)
				Print("Everon Foliage Measure: no clear view of any " + key, LogLevel.WARNING);
			else
			{
				if (kind == "tree")
					gotTree = true;
				else
					gotBush = true;
			}
			if (tookNew)
				kindsDone++;
			if (test && gotTree && gotBush)
				break;
		}
		csv.Close();
		m_World.SetCameraHDRBrightness(m_World.GetCurrentCameraId(), -1);
		m_bRunning = false;
		Print(string.Format("Everon Foliage Measure: done - %1 new shots in %2", shots, m_sOutDir), LogLevel.NORMAL);
	}

	//------------------------------------------------------------------------------------------------
	[ButtonAttribute("Test: one tree and one bush")]
	void TestOne()
	{
		Run(m_vTestMin, m_vTestMax, 1, 1, true);
	}

	[ButtonAttribute("Measure plants")]
	void MeasurePlants()
	{
		Run(m_vAreaMin, m_vAreaMax, m_iPerPrefab, m_iSides, false);
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

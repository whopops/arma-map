// Everon Road Export - a World Editor tool that writes out every road on the island exactly as the game has it, for
// the Everon Field Map's roads layer and vehicle route planner (tools/import_game_roads.py reads the files).
//
// Open Everon in the World Editor, pick this tool, and click "Export roads". It writes to
// Documents\My Games\ArmaReforgerWorkbench\profile\everon_los\roads\:
//
//   roadentities.csv  every finished road piece (RoadEntity, 2370 on Everon): its spline points in world metres,
//                     with its surface material, width and road type. The same system paints decals (beach debris,
//                     flower beds, runway markings); tools/import_game_roads.py leaves those out by material:
//                       road,which,material,width,type,point,x,y,z      (which = ctrl: a spline point)
//   roadboxes.csv     each road piece's origin and world box
//   splines.csv,      the few roads still kept as editable spline shapes with a road generator (6 on Everon), as a
//   controls.csv      smooth curve and as their control points
//   summary.txt       what was found, and every class of entity in the world with its count
//   inspect.txt       how a road piece stores its line (for when a game update changes it)
//
// Everon's roads are almost all finished RoadEntity pieces: their SplinePoints are a list of objects, each with a
// Position (local to the piece) and Data. "Points" can't be read from script.

[WorkbenchToolAttribute(name: "Everon Road Export", description: "Write every road on the island for the Everon Field Map", wbModules: {"WorldEditor"}, awesomeFontCode: 0xf018)]
class EveronRoadExportTool : WorldEditorTool
{
	[Attribute("$profile:everon_los/roads", UIWidgets.EditBox, "Output folder", category: "Output")]
	string m_sOutDir;

	protected int m_iInspected;
	protected int m_iDataInspected;
	protected int m_iShapeNoted;

	//------------------------------------------------------------------------------------------------
	protected FileHandle OpenOut(string name)
	{
		FileIO.MakeDirectory("$profile:everon_los");
		FileIO.MakeDirectory(m_sOutDir);
		FileHandle f = FileIO.OpenFile(m_sOutDir + "/" + name, FileMode.WRITE);
		if (!f)
			Print("Everon Road Export: could not write " + m_sOutDir + "/" + name, LogLevel.ERROR);
		return f;
	}

	//------------------------------------------------------------------------------------------------
	// The prefab a source was placed from ("" if none)
	protected string PrefabOf(IEntitySource src)
	{
		BaseContainer anc = src.GetAncestor();
		if (!anc)
			return "";
		return anc.GetResourceName(); // API?
	}

	//------------------------------------------------------------------------------------------------
	// The road generator on a shape, if it has one: its prefab (or class name), else ""
	protected string RoadGeneratorOf(IEntitySource src)
	{
		int n = src.GetNumChildren();
		for (int i = 0; i < n; i++)
		{
			IEntitySource child = src.GetChild(i);
			if (!child)
				continue;
			string cls = child.GetClassName();
			if (cls.Contains("RoadGenerator"))
			{
				string prefab = PrefabOf(child);
				if (prefab == "")
					return cls;
				return prefab;
			}
		}
		return "";
	}

	//------------------------------------------------------------------------------------------------
	// The names of a container's properties, for inspect.txt
	protected void WriteVars(FileHandle f, string title, BaseContainer bc)
	{
		f.Write(title + ":");
		int n = bc.GetNumVars(); // API?
		for (int v = 0; v < n; v++)
			f.Write(" " + bc.GetVarName(v)); // API?
		f.Write("\n");
	}

	//------------------------------------------------------------------------------------------------
	// One finished road (RoadEntity): its box always, and its points if it keeps them under "Points". The first few are
	// also described in inspect.txt (their property names), to see where the road's line is kept. Returns its points.
	protected int ExportRoadEntity(WorldEditorAPI api, IEntitySource src, int id, FileHandle fr, FileHandle fb, FileHandle fi)
	{
		string prefab = PrefabOf(src);
		string parent = "";
		IEntitySource par = src.GetParent();
		if (par)
			parent = par.GetClassName();
		IEntity ent = api.SourceToEntity(src);
		if (ent)
		{
			vector wmin, wmax;
			ent.GetWorldBounds(wmin, wmax);
			vector o = ent.GetOrigin();
			string line = string.Format("%1,%2,%3,%4,%5,%6,", id, prefab, parent, o[0], o[1], o[2]);
			line += string.Format("%1,%2,%3,%4,%5,%6\n", wmin[0], wmin[1], wmin[2], wmax[0], wmax[1], wmax[2]);
			fb.Write(line);
		}
		if (!ent)
			return 0;
		// what the road is: its surface material, width and type
		string material;
		src.Get("Material", material);
		// describe the first few real roads (not the decals built the same way) in inspect.txt
		if (m_iInspected < 4 && !material.Contains("Decals"))
		{
			m_iInspected++;
			fi.Write(string.Format("road entity %1, material %2\n", id, material));
			InspectPoints(fi, src, "Points");
			InspectPoints(fi, src, "SplinePoints");
		}
		float width;
		src.Get("Width", width);
		int type;
		src.Get("Type", type);
		vector mat[4];
		ent.GetWorldTransform(mat);
		// its line, two ways:
		// "curve": if the road is a shape, the smooth curve the game builds it along
		// "ctrl":  the spline points placed in the editor (SplinePoints: each a Position and its Data)
		int written = 0;
		ShapeEntity shape = ShapeEntity.Cast(ent);
		if (shape)
		{
			array<vector> curve = {};
			shape.GenerateTesselatedShape(curve);
			for (int p = 0; p < curve.Count(); p++)
			{
				vector w = curve[p].Multiply4(mat);
				fr.Write(string.Format("%1,curve,%2,%3,%4,%5,%6,%7,%8\n", id, material, width, type, p, w[0], w[1], w[2]));
				written++;
			}
		}
		BaseContainerList spl = src.GetObjectArray("SplinePoints");
		if (spl)
		{
			for (int q = 0; q < spl.Count(); q++)
			{
				BaseContainer sp = spl.Get(q);
				vector local;
				sp.Get("Position", local);
				vector ws = local.Multiply4(mat);
				fr.Write(string.Format("%1,ctrl,%2,%3,%4,%5,%6,%7,%8\n", id, material, width, type, q, ws[0], ws[1], ws[2]));
				if (!shape)
					written++;
				if (m_iDataInspected < 2)
				{
					m_iDataInspected++;
					InspectData(fi, sp);
				}
			}
		}
		if (m_iShapeNoted == 0)
		{
			m_iShapeNoted = 1;
			if (shape)
				fi.Write("road entities are shapes: the smooth curve is exported (curve)\n");
			else
				fi.Write("road entities are not shapes: only their spline points are exported (ctrl)\n");
		}
		return written;
	}

	//------------------------------------------------------------------------------------------------
	// What a spline point's Data holds (tangents, most likely), for inspect.txt
	protected void InspectData(FileHandle fi, BaseContainer sp)
	{
		WriteVars(fi, "  a spline point has", sp);
		BaseContainer data = sp.GetObject("Data"); // API?
		if (data)
		{
			WriteVars(fi, "  its Data has", data);
			fi.Write("  Data class: " + data.GetClassName() + "\n");
		}
		else
		{
			BaseContainerList datas = sp.GetObjectArray("Data");
			if (datas && datas.Count() > 0)
			{
				fi.Write(string.Format("  Data is a list of %1\n", datas.Count()));
				WriteVars(fi, "  a Data item has", datas.Get(0));
				fi.Write("  Data item class: " + datas.Get(0).GetClassName() + "\n");
			}
			else
				fi.Write("  Data: nothing readable\n");
		}
	}

	//------------------------------------------------------------------------------------------------
	// How a road's point list is stored: its type, and what comes back read as numbers or as a list of objects
	protected void InspectPoints(FileHandle fi, IEntitySource src, string name)
	{
		int n = src.GetNumVars();
		for (int v = 0; v < n; v++)
		{
			if (src.GetVarName(v) != name)
				continue;
			fi.Write(string.Format("  %1: type %2\n", name, src.GetDataVarType(v))); // API?
		}
		array<float> nums = {};
		src.Get(name, nums);
		if (nums)
		{
			string first = "";
			for (int i = 0; i < nums.Count() && i < 9; i++)
				first += " " + nums[i].ToString();
			fi.Write(string.Format("  %1 as numbers: %2 values:%3\n", name, nums.Count(), first));
		}
		else
			fi.Write(string.Format("  %1 as numbers: nothing\n", name));
		BaseContainerList objs = src.GetObjectArray(name);
		if (objs)
		{
			fi.Write(string.Format("  %1 as objects: %2\n", name, objs.Count()));
			if (objs.Count() > 0)
				WriteVars(fi, "    an object has", objs.Get(0));
		}
		else
			fi.Write(string.Format("  %1 as objects: nothing\n", name));
	}

	//------------------------------------------------------------------------------------------------
	[ButtonAttribute("Export roads")]
	void ExportRoads()
	{
		WorldEditor worldEditor = Workbench.GetModule(WorldEditor);
		if (!worldEditor)
			return;
		WorldEditorAPI api = worldEditor.GetApi();
		if (!api)
		{
			Print("Everon Road Export: open Everon in the World Editor first", LogLevel.ERROR);
			return;
		}

		FileHandle fs = OpenOut("splines.csv");
		FileHandle fc = OpenOut("controls.csv");
		if (!fs || !fc)
			return;
		fs.Write("road,shape,generator,point,x,y,z\n");
		fc.Write("road,point,x,y,z\n");

		// Finished roads (RoadEntity): their prefab, box, and their points if they keep them under "Points"
		FileHandle fr = OpenOut("roadentities.csv");
		FileHandle fb = OpenOut("roadboxes.csv");
		FileHandle fi = OpenOut("inspect.txt");
		if (!fr || !fb || !fi)
			return;
		fr.Write("road,which,material,width,type,point,x,y,z\n");
		fb.Write("road,prefab,parent,x,y,z,minx,miny,minz,maxx,maxy,maxz\n");
		map<string, int> classes = new map<string, int>();
		m_iInspected = 0;
		m_iDataInspected = 0;
		m_iShapeNoted = 0;
		int roadEnts = 0;
		int roadEntPoints = 0;

		map<string, int> kinds = new map<string, int>();
		int shapes = 0;
		int roads = 0;
		int points = 0;
		int count = api.GetEditorEntityCount();
		for (int i = 0; i < count; i++)
		{
			IEntitySource src = api.GetEditorEntity(i);
			if (!src)
				continue;
			string shapeCls = src.GetClassName();
			classes.Set(shapeCls, classes.Get(shapeCls) + 1);
			if (shapeCls.Contains("RoadEntity"))
			{
				roadEntPoints += ExportRoadEntity(api, src, roadEnts, fr, fb, fi);
				roadEnts++;
				continue;
			}
			if (!shapeCls.Contains("ShapeEntity"))
				continue;
			shapes++;
			string gen = RoadGeneratorOf(src);
			if (gen == "")
				continue;
			ShapeEntity shape = ShapeEntity.Cast(api.SourceToEntity(src));
			if (!shape)
				continue;
			kinds.Set(gen, kinds.Get(gen) + 1);

			vector mat[4];
			shape.GetWorldTransform(mat);

			// the smooth curve the road is built along
			array<vector> curve = {};
			shape.GenerateTesselatedShape(curve); // API?
			for (int p = 0; p < curve.Count(); p++)
			{
				vector w = curve[p].Multiply4(mat);
				fs.Write(string.Format("%1,%2,%3,%4,%5,%6,%7\n", roads, shapeCls, gen, p, w[0], w[1], w[2]));
				points++;
			}

			// the control points placed in the editor
			BaseContainerList ctrl = src.GetObjectArray("Points"); // API?
			if (ctrl)
			{
				for (int c = 0; c < ctrl.Count(); c++)
				{
					BaseContainer pt = ctrl.Get(c);
					vector local;
					pt.Get("Position", local);
					vector wc = local.Multiply4(mat);
					fc.Write(string.Format("%1,%2,%3,%4,%5\n", roads, c, wc[0], wc[1], wc[2]));
				}
			}
			roads++;
		}
		fs.Close();
		fc.Close();
		fr.Close();
		fb.Close();
		fi.Close();

		FileHandle fsum = OpenOut("summary.txt");
		if (fsum)
		{
			fsum.Write(string.Format("editor entities %1, shapes %2, roads %3, points %4\n", count, shapes, roads, points));
			fsum.Write(string.Format("road entities %1, with %2 points\n", roadEnts, roadEntPoints));
			for (int k = 0; k < kinds.Count(); k++)
				fsum.Write(string.Format("%1  %2\n", kinds.GetElement(k), kinds.GetKey(k)));
			fsum.Write("\nentity classes:\n");
			for (int c2 = 0; c2 < classes.Count(); c2++)
				fsum.Write(string.Format("%1  %2\n", classes.GetElement(c2), classes.GetKey(c2)));
			fsum.Close();
		}
		Print(string.Format("Everon Road Export: %1 road shapes (%2 points), %3 road entities (%4 points). Written to %5",
			roads, points, roadEnts, roadEntPoints, m_sOutDir), LogLevel.NORMAL);
		for (int k2 = 0; k2 < kinds.Count(); k2++)
			Print(string.Format("  %1 x %2", kinds.GetElement(k2), kinds.GetKey(k2)), LogLevel.NORMAL);
	}

}

/* Local multi-base workbench. Calculations use the existing detailed LOS worker unchanged. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const colors = ['#6cb8ff','#ff9278','#c4e875','#da99ff','#ffd36a','#65dfcc'];
  const labels = {1:'Hidden',2:'Clear',3:'Through foliage',pending:'Calculating…',error:'Data unavailable',outside:'Outside range'};
  const toLL = p => L.latLng(p[1] + 50, p[0] + 50), toXZ = p => [p.lng - 50,p.lat - 50];
  const grid = p => p.map(v => String(Math.floor(v / 100)).padStart(3,'0')).join(' ');
  const uid = () => Math.random().toString(36).slice(2,10);
  const crs = L.Util.extend({}, L.CRS, {projection:L.Projection.LonLat, transformation:new L.Transformation(1/12.501,0,-1/12.501,0),scale:z=>2**z,zoom:s=>Math.log2(s),infinite:true,distance:(a,b)=>Math.hypot(a.lng-b.lng,a.lat-b.lat)});
  const map = L.map('map',{crs,center:toLL([6400,6400]),zoom:0,minZoom:-1,maxZoom:7,zoomSnap:0.5,attributionControl:false});
  map.zoomControl.setPosition('bottomright');
  map.createPane('shade').style.zIndex = 350;
  map.getPane('shade').style.pointerEvents = 'none';
  const marks = L.layerGroup().addTo(map), references = L.layerGroup().addTo(map);
  let maps = {}, mapId = '', world = 12800, bases = [], tile = null, overlay = null, worker = null, generation = 0, seq = 0, ready = false;
  let plan = {bases:[], observers:[], checks:[]}, runs = [], pending = new Map(), results = new Map(), tool = '', inspectPoint = null, drawTimer = 0;
  const blank = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const Tiles = L.TileLayer.extend({getTileUrl(c) {
    const z = 5-c.z, n = 2**(7-z), y = -(c.y+1);
    return c.x < 0 || y < 0 || c.x >= n || y >= n ? blank : this.options.url.replace('{z}',z).replace('{x}',c.x).replace('{y}',y);
  }});
  const selected = () => plan.bases.map(b => ({...b, base:bases.find(x => x.name === b.name)})).filter(b => b.base);
  const active = () => selected().filter(b => !$('focus').value || $('focus').value === b.name);
  const setting = id => Number($(id).value);
  const validPoint = p => Array.isArray(p) && p.length === 2 && p.every(v => Number.isFinite(v) && v >= 0 && v < world);
  function save() {
    if (!mapId || !ready) return;
    try { sessionStorage.setItem('operations-los-map',mapId); sessionStorage.setItem(`operations-los-${mapId}`,JSON.stringify({plan,reach:$('reach').value,samples:$('samples').value,eye:$('eye').value,target:$('target').value,model:$('model').value,view:$('view').value,focus:$('focus').value})); } catch { /* storage optional */ }
  }
  function setTool(value) {
    tool = value;
    for (const [id,v] of [['place-observer','observer'],['place-check','check']]) {
      $(id).setAttribute('aria-pressed',String(tool === v)); $(id).classList.toggle('sel',tool === v);
    }
    $('map').classList.toggle('placing',!!tool);
    $('hint').textContent = tool ? `Click to place multiple ${tool === 'observer' ? 'observation positions for the selected base' : 'check points'}. Escape stops placement.` : 'Drag positions to move them. Hover to compare visibility; click to inspect.';
  }
  function addBase(name) {
    if (!bases.some(b => b.name === name) || plan.bases.some(b => b.name === name)) return;
    if (plan.bases.length >= 6) { $('hint').textContent = 'Six bases maximum. Remove a base to add another.'; return; }
    const slot = colors.findIndex((_,i) => !plan.bases.some(b => b.slot === i));
    plan.bases.push({name,slot,dead:true,enemy:true}); render(); calculate(); fit();
  }
  function options(el, values, empty) {
    const prev = el.value;
    el.innerHTML = (empty ? '<option value="">All bases</option>' : '') + values.map(b => `<option value="${esc(b.name)}">B${b.slot+1} · ${esc(b.name)}</option>`).join('');
    if ([...el.options].some(o => o.value === prev)) el.value = prev;
  }
  function render() {
    const list = selected();
    $('bases').innerHTML = list.map(b => `<article class="base-entry" style="--base-color:${colors[b.slot]}"><header><span class="base-id">B${b.slot+1}</span><b>${esc(b.name)}</b><button data-zoom="${esc(b.name)}" aria-label="Zoom to ${esc(b.name)}">↗</button><button data-remove="${esc(b.name)}" aria-label="Remove ${esc(b.name)}">×</button></header><label><input type="checkbox" data-dead="${esc(b.name)}" ${b.dead?'checked':''}>Dead ground</label><label><input type="checkbox" data-enemy="${esc(b.name)}" ${b.enemy?'checked':''}>Enemy view</label></article>`).join('');
    options($('owner'),list,false); options($('focus'),list,true);
    $('place-observer').disabled = !list.length; $('place-check').disabled = !list.length;
    $('add-base').disabled = list.length >= 6 || !bases.length;
    marks.clearLayers();
    const icon = (text,color,check=false) => L.divIcon({className:`los-marker${check?' check-marker':''}`,html:esc(text),iconSize:[34,28],iconAnchor:[17,14]});
    for (const b of list) {
      L.marker(toLL(b.base.xz),{icon:icon(`B${b.slot+1}`,colors[b.slot])}).addTo(marks).bindTooltip(esc(b.name));
      L.circle(toLL(b.base.xz),{radius:setting('reach'),color:colors[b.slot],fill:false,weight:1,dashArray:'6 6',interactive:false}).addTo(marks);
      LosAnalysis.around(b.base.xz,setting('samples'),world).forEach(p => L.circleMarker(toLL(p),{radius:2,color:colors[b.slot],weight:1,fillOpacity:1,interactive:false}).addTo(marks));
    }
    for (const [kind,items] of [['observer',plan.observers],['check',plan.checks]]) for (const p of items) {
      const b = list.find(b => b.name === p.base), color = b ? colors[b.slot] : '#ffffff';
      const marker = L.marker(toLL(p.xz),{icon:icon(p.label,color,kind === 'check'),draggable:true}).addTo(marks).bindTooltip(esc(`${p.label} · ${p.base || 'Check'} · ${grid(p.xz)}`));
      marker.on('click',() => { inspectPoint = p.xz; inspect(); });
      marker.on('dragend',() => {
        const xz = toXZ(marker.getLatLng()).map(v => Math.max(0,Math.min(world-0.1,Math.round(v*10)/10)));
        p.xz = xz; inspectPoint = xz; render(); if (kind === 'observer') calculate(); else { save(); refreshChecks(); inspect(); }
      });
    }
    $('positions').innerHTML = [...plan.observers,...plan.checks].map(p => `<div class="position-row"><span>${esc(p.label)} · ${grid(p.xz)}${p.base ? ' · '+esc(p.base):''}</span><button data-position="${p.id}" aria-label="Remove ${esc(p.label)}">×</button></div>`).join('');
    refreshChecks(); inspect(); save(); scheduleDraw();
  }
  function calculate(retry=false) {
    if (!worker) return;
    save(); generation++;
    for (const id of pending.keys()) worker.postMessage({cancel:id});
    pending.clear(); runs = [];
    if (retry) results.clear();
    const reach = setting('reach'), model = $('model').value, dir = `/data/maps/${mapId}`, foliage = model === 'mesh' ? `${dir}/foliage-mesh` : dir;
    const cfg = {size:world,losDir:`${dir}/los`,profiles:{json:`${foliage}/foliage/foliage_profiles.json`,plants:`${foliage}/foliage.json`,dir:`${foliage}/plants`}};
    for (const b of selected()) {
      const positions = [...LosAnalysis.around(b.base.xz,setting('samples'),world).map((xz,i) => ({xz,label:`B${b.slot+1}.${i+1}`})),...plan.observers.filter(p => p.base === b.name)];
      for (const kind of ['dead','enemy']) for (const p of positions) {
        // Calculate both sets so the inspector can compare independently of display toggles.
        const req = {xz:p.xz,dir:0,arc:360,range:reach,eyeH:kind === 'enemy'?1.7:setting('eye'),targetH:kind === 'enemy'?1.7:setting('target'),reverse:false,elev:null,cell:2.5,model,strength:1,cfg};
        const key = JSON.stringify(req), run = {base:b.name,kind,label:p.label,xz:p.xz,key};
        run.result = results.get(key); runs.push(run);
        if (!run.result && ![...pending.values()].some(v => v.key === key)) { const id = ++seq; pending.set(id,{key,gen:generation}); worker.postMessage({id,...req}); }
      }
    }
    const wanted = new Set(runs.map(r=>r.key));
    for (const key of results.keys()) if (!wanted.has(key)) results.delete(key);
    progress(); refreshChecks(); inspect(); scheduleDraw();
  }
  function progress() {
    const failed = runs.some(r=>r.failed);
    $('status').textContent = !runs.length ? 'Add a base to start.' : pending.size ? `Calculating ${pending.size} remaining views. Unknown areas stay unshaded.` : failed ? 'Some views could not load. Use Recalculate / retry.' : `${selected().length} bases · ${plan.observers.length} added observers · ready (2.5 m LOS cells).`;
  }
  function verdict(b,kind,p) { return LosAnalysis.verdict(runs.filter(r => r.base === b.name && r.kind === kind),p,setting('reach')); }
  function summary(b,p,details=false) {
    const friendly = verdict(b,'dead',p), enemy = verdict(b,'enemy',p);
    return `<div class="verdict" style="--base-color:${colors[b.slot]}"><b>B${b.slot+1} · ${esc(b.name)}</b>Friendly: ${labels[friendly.value]}<br>Enemy sees base: ${labels[enemy.value]}${details ? `<small>Friendly positions: ${friendly.positions.map(v=>`${esc(v.label)}: ${labels[v.value]}`).join(' · ') || 'none in range'}<br>Enemy target positions: ${enemy.positions.map(v=>`${esc(v.label)}: ${labels[v.value]}`).join(' · ') || 'none in range'}</small>`:''}</div>`;
  }
  function inspect() {
    if (!inspectPoint) return;
    $('inspect-title').textContent = `Grid ${grid(inspectPoint)}`;
    $('inspect').innerHTML = selected().map(b=>summary(b,inspectPoint,true)).join('') || 'Add a base first.';
  }
  function refreshChecks() {
    $('checks').innerHTML = plan.checks.map(p=>`<article class="check-card"><button data-check="${p.id}">${esc(p.label)} · ${grid(p.xz)}</button>${selected().map(b=>summary(b,p.xz)).join('')}</article>`).join('') || '<p class="note">Choose Place check points, then click several locations on the map.</p>';
  }
  function scheduleDraw() { clearTimeout(drawTimer); drawTimer = setTimeout(draw,100); }
  function draw() {
    if (overlay) { overlay.remove(); overlay = null; }
    const list = active(), bounds = map.getBounds(), size = map.getSize();
    if (!list.length || !size.x || !size.y) return;
    // Rasterize only the viewport, keeping redraw cost bounded even with distant bases.
    const w = Math.min(650,Math.ceil(size.x/2)), h = Math.min(650,Math.ceil(size.y/2));
    const canvas = document.createElement('canvas'); canvas.width=w; canvas.height=h;
    const ctx = canvas.getContext('2d'), img = ctx.createImageData(w,h), view = $('view').value, range = setting('reach');
    const west = bounds.getWest()-50, north = bounds.getNorth()-50, dx = (bounds.getEast()-bounds.getWest())/w, dz = (bounds.getNorth()-bounds.getSouth())/h;
    const grouped = list.map(b=>({b,dead:runs.filter(r=>r.base === b.name && r.kind === 'dead'),enemy:runs.filter(r=>r.base === b.name && r.kind === 'enemy'),rgb:colors[b.slot].match(/\w\w/g).map(v=>parseInt(v,16))}));
    for (let j=0;j<h;j++) for (let i=0;i<w;i++) {
      const p=[west+(i+0.5)*dx,north-(j+0.5)*dz]; if (!validPoint(p)) continue;
      const hits=[];
      for (const g of grouped) {
        const f = LosAnalysis.verdict(g.dead,p,range,false).value, e = LosAnalysis.verdict(g.enemy,p,range,false).value;
        if ((view === 'coverage' && (f===2||f===3)) || ((view==='enemy'||view==='combined')&&g.b.enemy&&(e===2||e===3))) hits.push({g,value:view==='coverage'?f:e});
        if ((view==='dead'||view==='combined')&&g.b.dead&&f===1) hits.push({g,value:1});
      }
      if (!hits.length) continue;
      // Separate colored bands preserve ownership instead of blending unrelated base colors.
      const hit=hits[Math.floor((i+j)/4)%hits.length], k=(j*w+i)*4;
      const dark=hit.value===1, foliage=hit.value===3;
      if (dark && (i+j)%6<2) continue;
      const factor=dark?0.55:1;
      img.data[k]=hit.g.rgb[0]*factor; img.data[k+1]=hit.g.rgb[1]*factor; img.data[k+2]=hit.g.rgb[2]*factor;
      img.data[k+3]=dark?155:foliage?((i%3===0&&j%3===0)?185:45):115;
    }
    ctx.putImageData(img,0,0); overlay=L.imageOverlay(canvas.toDataURL(),bounds,{pane:'shade',interactive:false,opacity:1}).addTo(map);
  }
  function fit() {
    const points = [...selected().map(b=>b.base.xz),...plan.observers.map(p=>p.xz),...plan.checks.map(p=>p.xz)];
    if (!points.length) return;
    const r=setting('reach'); map.fitBounds(L.latLngBounds(points.flatMap(p=>[toLL([p[0]-r,p[1]-r]),toLL([p[0]+r,p[1]+r])])),{padding:[35,70]});
  }
  async function setMap(id) {
    save(); ready=false; mapId=id; world=maps[id].world; generation++; const gen=generation;
    if (worker) worker.terminate(); worker=null; pending.clear(); results.clear(); runs=[]; bases=[]; plan={bases:[],observers:[],checks:[]}; inspectPoint=null;
    $('inspect-title').textContent='Hover over the map'; $('inspect').textContent='Place check points to keep comparisons below.';
    setTool(''); references.clearLayers(); marks.clearLayers(); if (overlay) overlay.remove();
    if (tile) tile.remove();
    const bounds=L.latLngBounds(toLL([0,0]),toLL([world,world]));
    tile=new Tiles('',{url:maps[id].tiles,bounds,minZoom:-1,maxZoom:7,minNativeZoom:0,maxNativeZoom:5,errorTileUrl:blank}).addTo(map); tile.bringToBack();
    map.setMaxBounds(bounds.pad(0.2)); map.fitBounds(bounds);
    $('status').textContent='Loading bases…'; $('base-pick').innerHTML=''; $('add-base').disabled=true;
    try {
      const response=maps[id].poi ? await fetch(maps[id].poi) : null;
      if (response && !response.ok) throw new Error('Base data unavailable');
      const data=response ? await response.json() : {};
      if (gen!==generation) return;
      bases=(data.conflict||[]).filter(b=>b.name&&validPoint(b.xz)).sort((a,b)=>a.name.localeCompare(b.name));
      $('base-pick').innerHTML=bases.map(b=>`<option>${esc(b.name)}</option>`).join('');
      for (const b of bases) L.circleMarker(toLL(b.xz),{radius:4,color:'#ccc',weight:1,fillOpacity:0.5}).addTo(references).bindTooltip(esc(b.name)).on('click',()=>addBase(b.name));
      let saved=null; try { saved=JSON.parse(sessionStorage.getItem(`operations-los-${id}`)||'null'); } catch { /* optional */ }
      if (saved) {
        for (const key of ['reach','samples','model','view']) if ([...$(key).options].some(o=>o.value===saved[key])) $(key).value=saved[key];
        for (const key of ['eye','target']) if (+saved[key]>=0.2&&+saved[key]<=30) $(key).value=saved[key];
        const used=new Set();
        plan.bases=(saved.plan?.bases||[]).filter(b=>bases.some(x=>x.name===b.name)&&Number.isInteger(b.slot)&&b.slot>=0&&b.slot<6&&!used.has(b.slot)&&used.add(b.slot)).slice(0,6);
        for (const kind of ['observers','checks']) plan[kind]=(saved.plan?.[kind]||[]).filter(p=>typeof p.id==='string'&&typeof p.label==='string'&&validPoint(p.xz)&&(kind==='checks'||plan.bases.some(b=>b.name===p.base))).slice(0,24);
      }
      $('model').querySelector('[value=mesh]').disabled=!maps[id].hasMeshFoliage;
      if ($('model').value==='mesh'&&!maps[id].hasMeshFoliage) $('model').value='profiles';
      if (typeof Worker==='undefined'||typeof DecompressionStream==='undefined') throw new Error('This browser needs Worker and DecompressionStream support');
      worker=new Worker('/los-worker.js');
      worker.onmessage=e=>{
        const entry=pending.get(e.data.id); if (!entry||entry.gen!==generation) return;
        pending.delete(e.data.id);
        if (!e.data.error) results.set(entry.key,e.data);
        for (const r of runs) if (r.key===entry.key) { r.result=e.data.error?null:e.data; r.failed=!!e.data.error; }
        progress(); refreshChecks(); inspect(); scheduleDraw();
      };
      worker.onerror=()=>{ for (const r of runs) if (!r.result) r.failed=true; pending.clear(); progress(); refreshChecks(); inspect(); scheduleDraw(); };
      // Do not save an empty plan while map data is still loading; a fast navigation could erase its backup.
      render();
      if (saved?.focus && plan.bases.some(b=>b.name===saved.focus)) $('focus').value=saved.focus;
      ready=true; calculate(); if (plan.bases.length) fit();
    } catch (err) { if (gen===generation) $('status').textContent=`Could not load this map: ${err.message}. Reload to retry.`; }
  }
  $('add-base').onclick=()=>addBase($('base-pick').value);
  $('bases').onclick=e=>{ const button=e.target.closest('button'); if (!button) return; if (button.dataset.zoom) { const b=bases.find(b=>b.name===button.dataset.zoom); map.setView(toLL(b.xz),3); } else if (button.dataset.remove) { const name=button.dataset.remove; plan.bases=plan.bases.filter(b=>b.name!==name); plan.observers=plan.observers.filter(p=>p.base!==name); setTool(''); render(); calculate(); } };
  $('bases').onchange=e=>{ const name=e.target.dataset.dead||e.target.dataset.enemy,b=plan.bases.find(b=>b.name===name); if (b) { b[e.target.dataset.dead?'dead':'enemy']=e.target.checked; save(); scheduleDraw(); } };
  $('positions').onclick=e=>{ const id=e.target.closest('[data-position]')?.dataset.position; if (!id) return; const observer=plan.observers.some(p=>p.id===id); plan.observers=plan.observers.filter(p=>p.id!==id); plan.checks=plan.checks.filter(p=>p.id!==id); render(); if(observer) calculate(); };
  $('checks').onclick=e=>{ const p=plan.checks.find(p=>p.id===e.target.closest('[data-check]')?.dataset.check); if(p) { inspectPoint=p.xz; map.panTo(toLL(p.xz)); inspect(); } };
  $('place-observer').onclick=()=>setTool(tool==='observer'?'':'observer'); $('place-check').onclick=()=>setTool(tool==='check'?'':'check');
  document.addEventListener('keydown',e=>{if(e.key==='Escape') setTool('');});
  map.on('click',e=>{ const p=toXZ(e.latlng); if (!validPoint(p)) return; inspectPoint=p; inspect(); if(!tool) return;
    const items=tool==='observer'?plan.observers:plan.checks;
    if(items.length>=24) { $('hint').textContent='24 positions maximum. Remove a position to add another.'; return; }
    if(tool==='observer'&&!$('owner').value) return;
    const prefix=tool==='observer'?'P':'C'; let n=1; while(items.some(p=>p.label===prefix+n)) n++;
    items.push({id:uid(),label:prefix+n,xz:p.map(v=>Math.round(v*10)/10),...(tool==='observer'?{base:$('owner').value}:{})}); render(); if(tool==='observer') calculate();
  });
  let hoverAt=0; map.on('mousemove',e=>{if(Date.now()-hoverAt<120)return;hoverAt=Date.now();inspectPoint=toXZ(e.latlng);inspect();});
  map.on('moveend zoomend',scheduleDraw);
  for(const id of ['reach','samples','model','eye','target']) $(id).onchange=()=>{if(!$(id).checkValidity()) { $(id).value=id==='eye'?'1.6':'1'; } render(); calculate();};
  for(const id of ['view','focus']) $(id).onchange=()=>{save();scheduleDraw();};
  $('retry').onclick=()=>calculate(true); $('fit').onclick=fit; $('map-pick').onchange=()=>setMap($('map-pick').value);
  addEventListener('resize',()=>map.invalidateSize()); addEventListener('pagehide',save);
  fetch('/api/maps').then(r=>{if(!r.ok)throw new Error(r.status);return r.json();}).then(data=>{maps=data.maps;$('map-pick').innerHTML=Object.entries(maps).map(([id,m])=>`<option value="${esc(id)}">${esc(m.title||id)}</option>`).join('');let remembered='';try{remembered=sessionStorage.getItem('operations-los-map');}catch{/* optional */}const id=maps[remembered]?remembered:data.default||Object.keys(maps)[0];$('map-pick').value=id;return setMap(id);}).catch(err=>{$('status').textContent=`Could not load maps: ${err.message}`;});
})();

/* Shared operations navigation. Native pages retain their proven room handoff and solvers. */
(() => {
  'use strict';
  const mode = document.body.dataset.workspace;
  if (!mode) return;
  const views = [['map', '/', 'Tactical map', '01'], ['mortar', '/mortar.html', 'Mortar', '02'],
    ['shot', '/shot.html', 'Shot planner', '03'], ['base', '/base.html', 'Base planning', '04']];
  const header = document.createElement('header');
  header.className = 'workspace-bar';
  header.innerHTML = `<a class="workspace-brand" href="/" aria-label="Field Operations tactical map"><span class="workspace-symbol">⊕</span><span>FIELD<span class="brand-light"> / OPERATIONS</span></span></a>
    <nav aria-label="Operations workspace">${views.map(([key, url, title, number]) => `<a href="${url}" data-view="${key}" ${mode === key ? 'aria-current="page"' : ''}><small>${number}</small>${title}</a>`).join('')}</nav>
    <div class="workspace-context"><span class="connection-dot"></span><span id="workspace-status">Local planning</span></div>`;
  document.body.prepend(header);
  function context() {
    let session = null;
    try { session = JSON.parse(sessionStorage.getItem('everon-session') || 'null'); } catch { /* storage unavailable */ }
    const params = new URLSearchParams(location.hash.slice(1));
    const room = session?.room || params.get('room');
    const name = session?.name || params.get('name');
    const suffix = room ? `#room=${encodeURIComponent(room)}${name ? `&name=${encodeURIComponent(name)}` : ''}` : '';
    header.querySelectorAll('[data-view]').forEach(a => {
      const view = views.find(v => v[0] === a.dataset.view);
      a.href = view[1] + suffix;
    });
    header.querySelector('.workspace-brand').href = '/' + suffix;
    const status = document.getElementById('room-status');
    const identity = document.getElementById('identity');
    const connected = status ? document.getElementById('room-join')?.textContent === 'Leave' : identity && !identity.classList.contains('hidden');
    document.getElementById('workspace-status').textContent = connected && room ? `${name || 'Crew'} / ${room}` : 'Local planning';
    header.classList.toggle('connected', !!connected);
  }
  context();
  const status = document.getElementById('room-status') || document.getElementById('identity');
  if (status) new MutationObserver(context).observe(status, { subtree: true, childList: true, characterData: true, attributes: true });
  addEventListener('hashchange', context);
  header.querySelector('nav').addEventListener('click', context);
  // Existing navigation actions use the same room-preserving routes.
  document.querySelectorAll('.pages').forEach(nav => { nav.hidden = true; });
  if (mode === 'shot') {
    const result = document.getElementById('result').closest('section');
    const answer = document.createElement('section');
    answer.id = 'shot-workspace';
    answer.innerHTML = '<div class="workspace-heading"><div><span class="eyebrow">DIRECT FIRE</span><h1>Firing solution</h1></div><span class="workspace-tag">Sight • hold • flight</span></div>';
    answer.append(result);
    const shared = document.getElementById('shots-card');
    if (shared) answer.append(shared);
    document.getElementById('side').after(answer);
  }
  if (mode === 'mortar') {
    const side = document.getElementById('side');
    const setup = document.createElement('details');
    setup.className = 'mobile-setup';
    const summary = document.createElement('summary');
    summary.innerHTML = '<span>Gun setup / room / wind</span><span class="setup-summary-stat"></span>';
    const content = document.createElement('div');
    content.className = 'mobile-setup-body';
    while (side.firstChild) content.append(side.firstChild);
    setup.append(summary,content); side.append(setup);
    const narrow = matchMedia('(max-width:640px)');
    const fitSetup = () => { setup.open = !narrow.matches; };
    fitSetup(); narrow.addEventListener('change',fitSetup);
    function setupSummary() {
      summary.querySelector('.setup-summary-stat').textContent = `${document.getElementById('weapon').value || 'Set gun'} / ${document.getElementById('shell').value || 'Select shell'}`;
    }
    side.addEventListener('change',setupSummary);
    new MutationObserver(setupSummary).observe(document.getElementById('weapon'),{childList:true});
    setupSummary();
    const toggle = document.getElementById('toggle-map');
    toggle.addEventListener('click', () => {
      const hidden = document.body.classList.toggle('reference-hidden');
      toggle.setAttribute('aria-pressed', String(hidden));
      toggle.textContent = hidden ? 'Show reference map' : 'Hide reference map';
      try { localStorage.setItem('operations-reference-hidden',String(hidden)); } catch { /* preference optional */ }
      dispatchEvent(new Event('resize'));
    });
    try { if (localStorage.getItem('operations-reference-hidden') === 'true') toggle.click(); } catch { /* preference optional */ }
  }
  if (mode === 'map') {
    const sidebar = document.getElementById('sidebar');
    const tabs = document.createElement('div');
    tabs.className = 'inspector-tabs';
    tabs.setAttribute('role','tablist');
    tabs.setAttribute('aria-label','Map inspector');
    tabs.innerHTML = [['markings','Plan'],['layers','Layers'],['fia','Caches']].map(([key,label]) => `<button type="button" id="inspector-${key}" role="tab" data-inspector="${key}" aria-controls="sec-${key}">${label}</button>`).join('');
    sidebar.insertBefore(tabs, document.getElementById('panels'));
    function selectInspector(key) {
      document.querySelectorAll('#panels .acc').forEach(section => {
        section.hidden = section.dataset.sec !== key;
        if (!section.hidden && section.querySelector('.acc-head').getAttribute('aria-expanded') !== 'true') section.querySelector('.acc-head').click();
      });
      tabs.querySelectorAll('button').forEach(button => {
        const selected = button.dataset.inspector === key;
        button.setAttribute('aria-selected',String(selected));
        button.tabIndex = selected ? 0 : -1;
        const panel = document.getElementById(`sec-${button.dataset.inspector}`);
        panel.setAttribute('role','tabpanel');
        panel.setAttribute('aria-labelledby',button.id);
      });
      try { localStorage.setItem('operations-inspector',key); } catch { /* preference optional */ }
    }
    tabs.addEventListener('click', e => { if (e.target.dataset.inspector) selectInspector(e.target.dataset.inspector); });
    tabs.addEventListener('keydown', e => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
      e.preventDefault();
      const buttons = [...tabs.querySelectorAll('button:not(:disabled)')];
      const current = buttons.indexOf(document.activeElement);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (current + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].click(); buttons[next].focus();
    });
    let selected = 'markings';
    try { selected = localStorage.getItem('operations-inspector') || selected; } catch { /* preference optional */ }
    selectInspector(['markings','layers','fia'].includes(selected) ? selected : 'markings');
    const caches = document.querySelector('.acc[data-sec="fia"]');
    function cacheAvailability() {
      const available = !caches.classList.contains('hidden');
      const button = tabs.querySelector('[data-inspector="fia"]');
      button.disabled = !available;
      button.title = available ? 'FIA caches this game' : 'No FIA cache data for this map';
      if (!available && button.getAttribute('aria-selected') === 'true') selectInspector('markings');
    }
    new MutationObserver(cacheAvailability).observe(caches,{attributes:true,attributeFilter:['class']});
    cacheAvailability();
    // Expose the squad roster on first use, while retaining the user's later choice.
    try { if (!localStorage.getItem('operations-squad-initialized')) { document.getElementById('squad-tab').click(); localStorage.setItem('operations-squad-initialized','1'); } } catch { /* preference optional */ }
  }
  if (mode === 'base') {
    const inspector = document.createElement('aside');
    inspector.id = 'base-inspector';
    inspector.setAttribute('aria-label','Base plan and visibility');
    inspector.innerHTML = '<div class="workspace-heading"><div><span class="eyebrow">CONSTRUCTION / COVERAGE</span><h1>Base plan</h1></div></div><section class="card" id="base-plan-list"><h2>Placed objects <span id="defence-count"></span></h2></section>';
    const list = inspector.querySelector('#base-plan-list');
    list.append(document.getElementById('items'),document.getElementById('items-actions'));
    inspector.append(document.querySelector('section[aria-label="What can be seen"]'));
    document.getElementById('app').append(inspector);
    const count = () => {
      const n = document.querySelectorAll('#items .item').length;
      document.getElementById('defence-count').textContent = `/ ${n}`;
      inspector.classList.toggle('no-defences',n === 0);
    };
    new MutationObserver(count).observe(document.getElementById('items'),{childList:true});
    count();
  }
  // Panel preferences belong to this browser, independently of the shared room.
  const layoutKey = `operations-layout-${mode}`;
  let sizes = {};
  try { sizes = JSON.parse(localStorage.getItem(layoutKey) || '{}') || {}; } catch { /* defaults */ }
  const app = document.getElementById('app');
  const wide = matchMedia('(min-width:1101px)');
  const left = document.getElementById(mode === 'map' ? 'sidebar' : 'side');
  const right = mode === 'base' ? document.getElementById('base-inspector') : document.getElementById('stage');
  const reference = mode === 'mortar' ? document.querySelector('.reference-map') : null;
  const clamp = (n, min, max) => Math.max(min, Math.min(n, Math.max(min,max)));
  function applySizes() {
    if (mode === 'map') {
      if (Number.isFinite(sizes.left)) document.body.style.setProperty('--inspector-width', `${clamp(sizes.left,220,Math.min(480,innerWidth-80))}px`);
    } else if (wide.matches && Number.isFinite(sizes.left) && Number.isFinite(sizes.right)) {
      const width = app.clientWidth;
      const l = clamp(sizes.left,180,Math.min(480,width-600));
      const r = clamp(sizes.right,240,width-l-360);
      app.style.gridTemplateColumns = `${l}px minmax(0,1fr) ${r}px`;
    } else app?.style.removeProperty('grid-template-columns');
    if (reference && Number.isFinite(sizes.height)) {
      reference.style.height = `${clamp(sizes.height,220,Math.max(440,innerHeight-120))}px`;
      reference.style.minHeight = '220px';
    }
  }
  const handles = [];
  function divider(label, axis, panel, edge, active, change) {
    if (!panel) return;
    const handle = document.createElement('div');
    handle.className = `panel-divider ${axis}`;
    handle.tabIndex = 0;
    handle.setAttribute('role','separator');
    handle.setAttribute('aria-label',label);
    handle.setAttribute('aria-orientation',axis === 'horizontal' ? 'horizontal' : 'vertical');
    handle.title = `${label} — drag or use arrow keys; double-click to reset layout`;
    document.body.append(handle);
    const position = () => {
      const rect = panel.getBoundingClientRect();
      handle.hidden = !active() || !rect.width || !rect.height;
      if (handle.hidden) return;
      if (axis === 'vertical') {
        handle.style.left = `${rect[edge]-4}px`; handle.style.top = `${rect.top}px`;
        handle.style.height = `${rect.height}px`;
      } else {
        handle.style.left = `${rect.left}px`; handle.style.top = `${rect.bottom-4}px`;
        handle.style.width = `${rect.width}px`;
      }
      const value = Math.round(axis === 'vertical' ? rect.width : rect.height);
      handle.setAttribute('aria-valuemin','0');
      handle.setAttribute('aria-valuemax',String(Math.ceil(Math.max(innerWidth,innerHeight,value))));
      handle.setAttribute('aria-valuenow',String(value));
      handle.setAttribute('aria-valuetext',`${value} pixels`);
    };
    function update(delta) {
      change(delta); applySizes();
      try { localStorage.setItem(layoutKey,JSON.stringify(sizes)); } catch { /* preference optional */ }
      dispatchEvent(new Event('resize'));
    }
    let last = null;
    handle.addEventListener('pointerdown',e => {
      if (e.button !== 0) return;
      e.preventDefault(); handle.focus(); handle.setPointerCapture(e.pointerId);
      last = axis === 'vertical' ? e.clientX : e.clientY;
      document.body.classList.add(`resizing-${axis}`);
    });
    handle.addEventListener('pointermove',e => {
      if (last === null) return;
      const next = axis === 'vertical' ? e.clientX : e.clientY;
      update(next-last); last = next;
    });
    const stop = () => { last = null; document.body.classList.remove(`resizing-${axis}`); };
    handle.addEventListener('lostpointercapture',stop);
    handle.addEventListener('pointerup',stop);
    handle.addEventListener('pointercancel',stop);
    handle.addEventListener('keydown',e => {
      const keys = axis === 'vertical' ? ['ArrowLeft','ArrowRight'] : ['ArrowUp','ArrowDown'];
      if (!keys.includes(e.key)) return;
      e.preventDefault(); update((e.key === keys[0] ? -1 : 1) * (e.shiftKey ? 40 : 10));
    });
    handle.addEventListener('dblclick',resetLayout);
    handles.push(position);
    new ResizeObserver(position).observe(panel);
    new MutationObserver(position).observe(panel,{attributes:true,attributeFilter:['class']});
  }
  function columnChange(side, delta) {
    const l = left.getBoundingClientRect().width;
    const r = right?.getBoundingClientRect().width;
    if (mode === 'map') sizes.left = clamp(l+delta,220,Math.min(480,innerWidth-80));
    else {
      sizes.left = side === 'left' ? clamp(l+delta,180,Math.min(480,app.clientWidth-r-360)) : l;
      sizes.right = side === 'right' ? clamp(r-delta,240,app.clientWidth-l-360) : r;
    }
  }
  divider(mode === 'map' ? 'Resize inspector panel' : 'Resize setup panel','vertical',left,'right',() => mode === 'map' ? innerWidth > 720 && !left.classList.contains('collapsed') : wide.matches,delta => columnChange('left',delta));
  if (mode !== 'map') divider('Resize map or plan panel','vertical',right,'left',() => wide.matches,delta => columnChange('right',delta));
  divider('Resize reference map height','horizontal',reference,'bottom',() => !document.body.classList.contains('reference-hidden'),delta => {
    sizes.height = clamp(reference.getBoundingClientRect().height+delta,220,Math.max(440,innerHeight-120));
  });
  const reset = document.createElement('button');
  reset.className = 'layout-reset'; reset.type = 'button'; reset.textContent = 'Reset layout';
  reset.title = 'Restore default panel sizes for this view';
  header.append(reset);
  function resetLayout() {
    sizes = {};
    try { localStorage.removeItem(layoutKey); } catch { /* preference optional */ }
    document.body.style.removeProperty('--inspector-width');
    app?.style.removeProperty('grid-template-columns');
    reference?.style.removeProperty('height'); reference?.style.removeProperty('min-height');
    dispatchEvent(new Event('resize'));
  }
  reset.addEventListener('click',resetLayout);
  addEventListener('resize',() => { applySizes(); handles.forEach(position => position()); });
  addEventListener('scroll',() => handles.forEach(position => position()),true);
  applySizes();
  dispatchEvent(new Event('resize'));
})();

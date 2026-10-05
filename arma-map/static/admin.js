(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ago = ms => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
  };
  let token = null, timer = null, lastOk = 0, lastYou = ''; // the session token lives only in this page

  async function refresh() {
    try {
      const r = await fetch('/api/admin/rooms', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      if (r.status === 401) return signOut('Your admin session ended. Sign in again.');
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
      lastYou = d.you;
      render(d);
      lastOk = Date.now();
      $('#status').className = 'status';
      $('#status').textContent = 'Live · updates every 4 s';
    } catch {
      $('#status').className = 'status bad';
      $('#status').textContent = lastOk ? `Can't reach the server (last update ${ago(Date.now() - lastOk)} ago)` : "Can't reach the server";
    }
  }

  function render(d) {
    $('#n-rooms').textContent = d.rooms.length;
    $('#n-players').textContent = d.totalPlayers;
    $('#n-marks').textContent = d.rooms.reduce((s, r) => s + r.players.reduce((t, p) => t + p.markings, 0), 0);
    $('#rooms').innerHTML = d.rooms.length ? d.rooms.map(room => {
      const b = room.briefing;
      // a kept room ("keep the plan") stays after everyone leaves, holding the markings of those who left ("away")
      const kept = room.kept ? `<span class="kept" title="Kept: the plan stays after everyone leaves, until 24 hours pass with nobody in it">Kept</span>` : '';
      const away = room.away ? ` · ${room.away} away (markings kept)` : '';
      return `<section class="room"><header><span class="code">${esc(room.room)}</span>${kept}` +
        `<span class="meta"><b>${room.players.length}</b> player${room.players.length === 1 ? '' : 's'}${away} · open for ${ago(d.now - room.created)}` +
        ` · ${b ? `briefing by ${esc(b.by)}, ${ago(d.now - b.at)} ago (${b.chars} chars)` : 'no briefing'}</span>` +
        `<span class="sp"></span><button class="danger" data-act="close-room" data-room="${esc(room.room)}">Close room</button></header>` +
        `<table><thead><tr><th>Player</th><th>IP address</th><th>Status</th><th>Joined</th><th>Markings</th><th></th></tr></thead><tbody>` +
        room.players.map(p => `<tr><td><span class="who"><span class="avatar" style="background:${esc(p.color)}">${esc([...p.name][0].toUpperCase())}</span>${esc(p.name)}</span></td>` +
          `<td class="ip">${esc(p.ip)}${p.key === d.you ? '<span class="me" title="The same address you are using now">you</span>' : ''}</td>` +
          `<td>${p.connected ? '<span class="dot"></span>Connected' : `<span class="dot away"></span>Reconnecting (${p.awaySeconds} s)`}</td>` +
          `<td>${ago(d.now - p.joined)} ago</td><td class="num">${p.markings}</td>` +
          `<td><span class="acts">` +
          `<button data-act="kick" data-player="${esc(p.id)}" data-name="${esc(p.name)}" title="Remove from the map; they can rejoin">Kick</button>` +
          `<button class="danger" data-act="ban24" data-player="${esc(p.id)}" data-name="${esc(p.name)}" data-ip="${esc(p.key)}" title="Ban this IP address for 24 hours">Ban 24 h</button>` +
          `<button class="danger" data-act="ban" data-player="${esc(p.id)}" data-name="${esc(p.name)}" data-ip="${esc(p.key)}" title="Ban this IP address until you lift it">Ban</button>` +
          `</span></td></tr>`).join('') +
        (room.players.length ? '' : `<tr><td colspan="6" class="empty-row">Nobody here right now. The room is kept, so its plan waits for them.</td></tr>`) +
        `</tbody></table></section>`;
    }).join('') : '<div class="empty">No active rooms. Rooms appear here as soon as someone joins one, and disappear when the last player leaves (unless the room is kept).</div>';
    $('#bans').innerHTML = d.bans.length
      ? `<div class="bans"><table><thead><tr><th>IP address</th><th>Names used</th><th>Banned</th><th>Until</th><th></th></tr></thead><tbody>` +
        d.bans.map(b => `<tr><td>${esc(b.ip)}</td><td>${esc((b.names || []).join(', '))}</td><td>${ago(d.now - b.at)} ago</td>` +
          `<td>${b.until ? `${new Date(b.until).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })} (in ${ago(b.until - d.now)})` : '<span class="perm">Permanent</span>'}</td>` +
          `<td><span class="acts"><button data-act="unban" data-ip="${esc(b.ip)}">Lift ban</button></span></td></tr>`).join('') +
        `</tbody></table></div>`
      : '<div class="empty">No banned addresses.</div>';
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
  }
  async function adminPost(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) { signOut('Your admin session ended. Sign in again.'); throw new Error(''); }
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
  }

  // Kick / ban / close room / lift ban, each confirmed first
  document.addEventListener('click', async e => {
    const b = e.target.closest('button[data-act]');
    if (!b || !token) return;
    const { act, player, name, ip, room } = b.dataset;
    const self = ip && ip === lastYou ? '\n\nThis is the address you are using now, so you would be banned from the map too.' : '';
    const ask = {
      kick: `Kick ${name}? Their markings are removed. They can rejoin straight away.`,
      ban24: `Ban ${name} for 24 hours? Everyone on ${ip} is removed and blocked until then.${self}`,
      ban: `Ban ${name} permanently? Everyone on ${ip} is removed and blocked until you lift the ban.${self}`,
      'close-room': `Close room ${room}? Everyone in it is removed along with their markings and the briefing.`,
      unban: `Lift the ban on ${ip}?`,
    }[act];
    if (!ask || !confirm(ask)) return;
    b.disabled = true;
    try {
      if (act === 'kick') { await adminPost('/api/admin/kick', { player }); toast(`Kicked ${name}.`); }
      if (act === 'ban24' || act === 'ban') {
        const r = await adminPost('/api/admin/ban', { player, hours: act === 'ban24' ? 24 : null });
        toast(`Banned ${ip}${act === 'ban24' ? ' for 24 hours' : ''}. Removed: ${r.removed.join(', ')}.`);
      }
      if (act === 'close-room') { const r = await adminPost('/api/admin/close-room', { room }); toast(`Closed ${room}; ${r.removed} player${r.removed === 1 ? '' : 's'} removed.`); }
      if (act === 'unban') { await adminPost('/api/admin/unban', { ip }); toast(`Lifted the ban on ${ip}.`); }
    } catch (err) { if (err.message) toast(err.message); }
    b.disabled = false;
    refresh();
  });

  function signOut(message) {
    if (token) fetch('/api/admin/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' }).catch(() => {});
    token = null;
    clearInterval(timer);
    $('#dash').classList.add('hidden');
    $('#login').classList.remove('hidden');
    $('#login-error').textContent = message || '';
    $('#password').value = '';
    $('#password').focus();
  }

  $('#login').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    $('#login-error').textContent = '';
    try {
      const r = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#password').value }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `Sign-in failed (${r.status})`);
      token = data.token;
      $('#password').value = '';
      $('#login').classList.add('hidden');
      $('#dash').classList.remove('hidden');
      await refresh();
      timer = setInterval(refresh, 4000);
    } catch (err) {
      $('#login-error').textContent = err.message === 'Failed to fetch' ? 'Cannot reach the map server. Is it running?' : err.message;
    } finally {
      btn.disabled = false;
    }
  });
  $('#signout').addEventListener('click', () => signOut());
  window.addEventListener('pagehide', () => {
    if (token) fetch('/api/admin/logout', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' }).catch(() => {});
  });
  $('#password').focus();
})();

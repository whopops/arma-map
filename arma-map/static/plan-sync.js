// Plan transfer without losing the browser backup when the server rejects an upload.
'use strict';

const PlanSync = (() => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const types = new Set(['marker', 'route', 'range', 'mortar', 'fia', 'emplacement', 'construct', 'area',
    'arrow', 'ambush', 'post', 'sectors', 'overwatch', 'hulldown', 'aa', 'control', 'audible']);

  // Live items win over the backup, including edits made after restoration started.
  function merge(live, pending) {
    return [...new Map([...pending, ...live].map(it => [it.id, it])).values()];
  }

  function backup() {
    let owner = null, pending = [], staged = new Map(), deleted = new Set();
    const acknowledge = (session, live) => {
      if (session !== owner) return;
      pending = pending.filter(it => !live.has(it.id));
      for (const [id, item] of staged) if (JSON.stringify(live.get(id)) === JSON.stringify(item)) staged.delete(id);
    };
    return {
      begin(session, items) { owner = session; pending = items.slice(); staged = new Map(); deleted = new Set(); },
      acknowledge,
      stage(session, item) { if (session === owner) { staged.set(item.id, JSON.parse(JSON.stringify(item))); deleted.delete(item.id); } },
      remove(session, id) { if (session === owner) { deleted.add(id); staged.delete(id); pending = pending.filter(it => it.id !== id); } },
      deleted(session, id) { return session === owner && deleted.has(id); },
      items(session, live) {
        acknowledge(session, new Map(live.map(it => [it.id, it])));
        if (session !== owner) return live;
        return merge([...live, ...staged.values()], pending).filter(it => !deleted.has(it.id));
      },
    };
  }

  // Writes to one marking stay in order, including a delete following an unfinished create.
  function writer() {
    const sessions = new WeakMap();
    return (session, id, task) => {
      if (!sessions.has(session)) sessions.set(session, new Map());
      const lanes = sessions.get(session), previous = lanes.get(id) || Promise.resolve();
      const next = previous.catch(() => {}).then(task);
      lanes.set(id, next);
      const clean = () => { if (lanes.get(id) === next) lanes.delete(id); };
      next.then(clean, clean);
      return next;
    };
  }

  async function restore(items, { current, active, upload, remove = async () => {}, deleted = () => false, wait = sleep, attempts = 20 }) {
    const pending = new Map(items.map(it => [it.id, it]));
    let uploaded = 0, failed = 0;
    for (const item of pending.values()) {
      if (!active()) return { cancelled: true };
      if (deleted(item.id) || current().has(item.id)) continue;
      let accepted = false;
      for (let tries = 0; tries < attempts; tries++) {
        if (!active()) return { cancelled: true };
        if (deleted(item.id)) { accepted = true; break; }
        try {
          await upload(item);
          if (deleted(item.id) && active()) await remove(item.id);
          else uploaded++;
          accepted = true; break;
        }
        catch (err) {
          if (err.status === 401) return { cancelled: !active(), pending: [...pending.values()], uploaded, failed: failed + 1, expired: true };
          if ([429, 503].includes(err.status) && tries + 1 < attempts) { await wait(1000); continue; }
          break;
        }
      }
      if (!accepted) failed++;
    }
    if (!active()) return { cancelled: true };
    // A successful POST can precede its SSE acknowledgement. Keep that item until it appears in current().
    const live = current();
    return { cancelled: false, pending: [...pending.values()].filter(it => !deleted(it.id) && !live.has(it.id)), uploaded, failed };
  }

  function read(text) {
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('That file is not a valid plan.'); }
    const list = Array.isArray(data) ? data : data && data.items;
    if (!Array.isArray(list)) throw new Error('That file is not a valid plan.');
    const items = list.filter(it => it && types.has(it.type));
    if (!items.length) throw new Error('No markings found in that file.');
    return items;
  }

  async function importItems(items, { existing, uid, save, wait = sleep }) {
    let imported = 0;
    for (const item of items) {
      const old = existing(item.type);
      const extra = item.type === 'fia' && old ? { caches: [...new Set([...old.caches, ...(item.caches || [])])] } : {};
      if (!await save({ ...item, ...extra, id: old ? old.id : uid() })) break;
      imported++;
      await wait(60);
    }
    return { imported, total: items.length };
  }

  return { merge, backup, writer, restore, read, importItems };
})();

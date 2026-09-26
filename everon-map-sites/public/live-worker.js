// Asks the map server for new events about once a second and passes them to the page.
//
// It runs as a background worker rather than on the page because browsers slow a hidden tab's timers down to
// once a minute, and a player who doesn't check in for 15 s is taken off the map with their markings.
//
// Messages from the page:  {type: 'start', id, token}  |  {type: 'stop'}
// Messages to the page:    {type: 'events', events}  |  {type: 'bye', reason}  |  {type: 'closed'}
'use strict';

const POLL_MS = 1000;      // between check-ins
const RETRY_MS = 2000;     // after a failed one
const GIVE_UP_MS = 12000;  // failing this long means the server has dropped us already

let session = null, cursor = null, timer = 0, failingSince = 0;

onmessage = e => {
  const m = e.data || {};
  clearTimeout(timer);
  if (m.type === 'start') {
    session = { id: m.id, token: m.token };
    cursor = null;
    failingSince = 0;
    poll();
  } else if (m.type === 'stop') {
    session = null;
  }
};

function end(msg) {
  session = null;
  postMessage(msg);
}

async function poll() {
  const s = session;
  if (!s) return;
  const q = `id=${encodeURIComponent(s.id)}&token=${encodeURIComponent(s.token)}` + (cursor === null ? '' : `&since=${cursor}`);
  try {
    const res = await fetch(`/api/events?${q}`, { cache: 'no-store' });
    if (s !== session) return;
    if (res.status === 401) return end({ type: 'closed' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (s !== session) return;
    if (typeof data.bye === 'string') return end({ type: 'bye', reason: data.bye });
    failingSince = 0;
    cursor = data.cursor;
    if (data.events.length) postMessage({ type: 'events', events: data.events });
    timer = setTimeout(poll, POLL_MS);
  } catch {
    if (s !== session) return;
    if (!failingSince) failingSince = Date.now();
    if (Date.now() - failingSince > GIVE_UP_MS) return end({ type: 'closed' });
    timer = setTimeout(poll, RETRY_MS);
  }
}

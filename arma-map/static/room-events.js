// SSE over POST keeps session credentials out of URLs and reverse-proxy access logs.
'use strict';
class RoomEvents {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  constructor(url, session) {
    this.url = url;
    this.body = JSON.stringify({ id: session.id, token: session.token });
    this.readyState = RoomEvents.CONNECTING;
    this.retry = 1000;
    this.listeners = new Map();
    this.run();
  }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
  emit(type, data) {
    const event = { type, data };
    for (const callback of [this['on' + type], ...(this.listeners.get(type) || [])]) {
      if (callback) { try { callback(event); } catch (err) { console.error(err); } }
    }
  }
  frame(text) {
    let type = 'message';
    const data = [];
    for (const line of text.split(/\r?\n/)) {
      const colon = line.indexOf(':');
      const key = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (key === 'event') type = value;
      if (key === 'data') data.push(value);
      if (key === 'retry' && /^\d+$/.test(value)) this.retry = Math.min(30000, Math.max(250, +value));
    }
    if (data.length) this.emit(type, data.join('\n'));
  }
  close() {
    this.readyState = RoomEvents.CLOSED;
    this.controller?.abort();
    clearTimeout(this.timer);
    this.resume?.();
  }
  async run() {
    while (this.readyState !== RoomEvents.CLOSED) {
      this.controller = new AbortController();
      let reader;
      try {
        const response = await fetch(this.url, { method: 'POST', cache: 'no-store',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: this.body, signal: this.controller.signal });
        if (this.readyState === RoomEvents.CLOSED) break;
        if ([400, 401, 403, 404, 405].includes(response.status)) {
          this.close(); this.emit('error'); break;
        }
        if (!response.ok) throw new Error('Room stream unavailable');
        if (!response.body || !response.headers.get('Content-Type')?.startsWith('text/event-stream')) {
          this.close(); this.emit('error'); break;
        }
        this.readyState = RoomEvents.OPEN;
        this.emit('open');
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (this.readyState !== RoomEvents.CLOSED) {
          const part = await reader.read();
          if (part.done) break;
          buffer += decoder.decode(part.value, { stream: true });
          if (buffer.length > 4 * 1024 * 1024) throw new Error('Room event too large');
          let boundary;
          while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
            this.frame(buffer.slice(0, boundary.index));
            buffer = buffer.slice(boundary.index + boundary[0].length);
            if (this.readyState === RoomEvents.CLOSED) break;
          }
        }
      } catch (err) {
        // Network failures reconnect. Closing the page or receiving bye cancels without retrying.
      } finally {
        if (reader) { try { await reader.cancel(); } catch { /* disconnected */ } reader.releaseLock(); }
        this.controller.abort();
      }
      if (this.readyState === RoomEvents.CLOSED) break;
      this.readyState = RoomEvents.CONNECTING;
      this.emit('error');
      if (this.readyState === RoomEvents.CLOSED) break;
      await new Promise(resolve => { this.resume = resolve; this.timer = setTimeout(resolve, this.retry); });
      this.resume = null;
    }
  }
}

"""Isolated browser smoke server: python -B test_browser_server.py --port 8767.

Visit /__test__/ to toggle simulated marking-upload failures. All room state
is in memory or a temporary directory; production rooms and bans are untouched.
"""
import argparse
import html
import os
import tempfile
import threading
import time

import server


class TestHandler(server.Handler):
    fail_items = False
    delay_items = 0

    def do_GET(self):
        if self.path == "/__test__/rooms":
            with server.HUB.lock:
                sections = []
                for room in server.HUB.rooms:
                    entries = []
                    for player in server.HUB._in_room(room, observers=True):
                        entries.append(f'<li>{html.escape(player.name)} ({"observer" if player.observer else "player"})<ul>' +
                                       ''.join(f'<li>{html.escape(item["type"])} {html.escape(item["id"])} {html.escape(item.get("label", ""))}</li>'
                                               for item in player.items.values()) + '</ul></li>')
                    sections.append(f'<h2>{html.escape(room)}</h2><ul>{"".join(entries)}</ul>')
            return self.send_bytes(200, ('<!doctype html><title>Isolated test rooms</title><h1>Isolated test rooms</h1>' +
                                       ''.join(sections)).encode(), "text/html", "no-store")
        if self.path == "/__test__/controls.js":
            script = b'''async function mode(fail, delay = 0) {
const r = await fetch('/__test__/uploads', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fail,delay})});
if (r.ok) document.querySelector('#status').textContent = fail ? 'Marking uploads fail with 503' : delay ? 'Marking uploads delayed 5 seconds' : 'Marking uploads succeed';
}
document.querySelector('#fail').addEventListener('click', () => mode(true));
document.querySelector('#delay').addEventListener('click', () => mode(false, 5));
document.querySelector('#allow').addEventListener('click', () => mode(false));'''
            return self.send_bytes(200, script, "application/javascript", "no-store")
        if self.path == "/__test__/":
            body = b'''<!doctype html><html><head><title>Browser smoke controls</title></head><body>
<h1>Isolated browser smoke test</h1>
<p id="status">Marking uploads succeed</p>
<button id="fail">Fail uploads (503)</button>
<button id="allow">Allow uploads</button>
<button id="delay">Delay uploads (5 s)</button>
<p><a href="/__test__/rooms">Inspect isolated rooms</a></p>
<p><a href="/">Tactical map</a> | <a href="/mortar">Mortar</a> |
<a href="/shot">Shot planner</a> | <a href="/base.html">Base planning</a></p>
<script src="/__test__/controls.js"></script></body></html>'''
            return self.send_bytes(200, body, "text/html", "no-store")
        return super().do_GET()

    def do_POST(self):
        if self.path == "/__test__/uploads":
            body = self.read_json()
            if not isinstance(body, dict) or not isinstance(body.get("fail"), bool):
                return self.send_json(400, {"error": "Expected a boolean fail value."})
            TestHandler.fail_items = body["fail"]
            delay = body.get("delay", 0)
            if not isinstance(delay, (int, float)) or not 0 <= delay <= 10:
                return self.send_json(400, {"error": "Delay must be 0-10 seconds."})
            TestHandler.delay_items = delay
            return self.send_json(200, {"ok": True})
        if self.path == "/api/item" and TestHandler.fail_items:
            self.read_json()  # consume the body before reusing this connection
            return self.send_json(503, {"error": "Simulated temporary upload failure."})
        if self.path == "/api/item" and TestHandler.delay_items:
            time.sleep(TestHandler.delay_items)
        return super().do_POST()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8767)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as state:
        server.ROOMS_FILE = os.path.join(state, "rooms.json")
        server.BANS = server.Bans(os.path.join(state, "bans.json"))
        server.HUB = server.Hub()
        threading.Thread(target=server.HUB.reap, daemon=True).start()
        httpd = server.Server(("127.0.0.1", args.port), TestHandler)
        print(f"Browser smoke controls: http://127.0.0.1:{args.port}/__test__/", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            httpd.server_close()


if __name__ == "__main__":
    main()

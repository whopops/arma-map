"""Regression checks; run with python -B -m unittest test_server.py."""
import concurrent.futures
import io
import ipaddress
import json
import os
from pathlib import Path
import queue
import tempfile
import threading
import unittest
from unittest.mock import patch

import server

UPSTREAM = "https://tiles.example/{z}/{x}/{y}.jpg"


class ServerTests(unittest.TestCase):
    @staticmethod
    def player(hub, name="Viper", room="room"):
        p = server.Player(name, "#ff6b6b", room, "127.0.0.1")
        hub.players[p.id] = p
        hub.rooms.setdefault(room, {})
        return p

    def test_base_construction_catalog_payloads_roundtrip_and_validate(self):
        # Test real client-created payloads, so new palette entries cannot silently fail when shared.
        import subprocess
        import shutil
        node = shutil.which("node")
        if not node:
            node = str(Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe")
        result = subprocess.run([node, str(Path(__file__).parent / "test_client.cjs"), "--construction-items"],
                                capture_output=True, text=True, check=True, encoding="utf-8")
        items = json.loads(next(line for line in result.stdout.splitlines() if line.startswith('[{')))
        hub = server.Hub()
        p = self.player(hub)
        for i, item in enumerate(items):
            with self.subTest(kind=item["kind"]):
                item["id"] = f"construction-{i}"
                self.assertIsNone(server.validate_item(item))
                self.assertEqual(hub.upsert(p.id, p.token, item)[0], 200)
                self.assertEqual(p.items[item["id"]], item)
                broken = dict(item)
                if item["type"] == "emplacement":
                    broken["range"] = -10
                elif "points" in item:
                    broken["points"] = [[100, 100]]
                else:
                    broken["xz"] = [float("nan"), 100]
                self.assertIsNotNone(server.validate_item(broken))
        self.assertIsNotNone(server.validate_item({"id": "unknown-kind", "type": "construct", "kind": "unknown", "xz": [100, 100]}))
        self.assertIsNone(server.validate_item({"id": "old-trap", "type": "construct", "kind": "roadblock", "xz": [100, 100]}))
        self.assertIsNone(server.validate_item({"id": "old-gun", "type": "emplacement", "kind": "mg", "xz": [100, 100], "dir": 90, "arc": 60, "range": 400}))

    def test_json_rejects_numeric_overflow_at_any_depth(self):
        for raw in [b'{"at":1e309}', b'{"extra":[{"value":-1e309}]}', b'{"at":NaN}']:
            req = type("Request", (), {"headers": {"Content-Length": str(len(raw))}, "rfile": io.BytesIO(raw)})()
            self.assertIsNone(server.Handler.read_json(req))
        raw = b'{"at":1.5}'
        req = type("Request", (), {"headers": {"Content-Length": str(len(raw))}, "rfile": io.BytesIO(raw)})()
        self.assertEqual(server.Handler.read_json(req), {"at": 1.5})

    def test_direct_upsert_rejects_nested_nonfinite_numbers(self):
        hub = server.Hub(); p = self.player(hub)
        item = {"id": "test123", "type": "marker", "xz": [100, 100], "extra": {"at": float("inf")}}
        self.assertEqual(hub.upsert(p.id, p.token, item)[0], 400)
        self.assertEqual(p.items, {})

    def test_slow_stream_is_dropped_at_byte_budget(self):
        hub = server.Hub(); p = self.player(hub)
        _, q = hub.open_stream(p.id, p.token)
        q.get_nowait()
        with patch.object(server, "MAX_QUEUED_BYTES", 128):
            hub._broadcast(p.room, {"type": "item", "note": "x" * 80})
            hub._broadcast(p.room, {"type": "item", "note": "x" * 80})
            self.assertEqual(q.bytes, 0)
            self.assertEqual(q.get_nowait(), ("drop", ""))
            self.assertTrue(q.closed)
            hub._broadcast(p.room, {"type": "item"})
            self.assertEqual(q.get_nowait(), ("drop", ""))

    def test_snapshots_share_body_and_invalidate_after_room_edit(self):
        hub = server.Hub(); a = self.player(hub); b = self.player(hub, "Bravo")
        _, qa = hub.open_stream(a.id, a.token)
        _, qb = hub.open_stream(b.id, b.token)
        sa = qa.get_nowait(); sb = qb.get_nowait()
        self.assertIs(sa.body, sb.body)
        data = json.loads(sa.body + sa.tail)
        self.assertEqual(data["you"], a.name)
        self.assertEqual(len(data["players"]), 2)
        item = {"id": "test123", "type": "marker", "xz": [100, 100]}
        self.assertEqual(hub.upsert(a.id, a.token, item)[0], 200)
        hub.close_stream(a, qa)
        _, qc = hub.open_stream(a.id, a.token)
        sc = qc.get_nowait()
        self.assertIsNot(sc.body, sa.body)
        data = json.loads(sc.body + sc.tail)
        self.assertEqual(data["players"][0]["items"], [item])

    def test_saved_markings_obey_player_room_and_server_budgets(self):
        item = {"id": "test123", "type": "marker", "xz": [100, 100]}
        size = len(json.dumps(item))
        for budget in ("MAX_PLAYER_BYTES", "MAX_ROOM_BYTES", "MAX_STATE_BYTES"):
            hub = server.Hub(); p = self.player(hub)
            with patch.object(server, budget, size - 1):
                self.assertEqual(hub.upsert(p.id, p.token, item)[0], 400)
                self.assertFalse(p.items)
            self.assertEqual(hub.upsert(p.id, p.token, item)[0], 200)
            # Replacing the same item at the exact limit does not count twice.
            with patch.object(server, budget, size):
                self.assertEqual(hub.upsert(p.id, p.token, item)[0], 200)

    def test_room_and_global_limits_include_other_players(self):
        item = {"id": "test123", "type": "marker", "xz": [100, 100]}
        size = len(json.dumps(item))
        hub = server.Hub(); a = self.player(hub); b = self.player(hub, "Bravo")
        c = self.player(hub, "Charlie", "another-room")
        hub.upsert(a.id, a.token, item)
        with patch.object(server, "MAX_ROOM_BYTES", size):
            self.assertEqual(hub.upsert(b.id, b.token, item)[0], 400)
            self.assertEqual(hub.upsert(c.id, c.token, item)[0], 200)
        with patch.object(server, "MAX_STATE_BYTES", 2 * size):
            self.assertEqual(hub.upsert(b.id, b.token, item)[0], 400)
        hub.delete(c.id, c.token, item["id"])
        with patch.object(server, "MAX_STATE_BYTES", 2 * size):
            self.assertEqual(hub.upsert(b.id, b.token, item)[0], 200)

    def test_streams_per_player_are_bounded_and_close_releases_payloads(self):
        hub = server.Hub(); p = self.player(hub)
        streams = [hub.open_stream(p.id, p.token)[1] for _ in range(server.MAX_STREAMS_PER_PLAYER)]
        self.assertEqual(hub.open_stream(p.id, p.token), (None, None))
        hub.close_stream(p, streams[0])
        self.assertIsNone(streams[0].snapshot)
        self.assertIsNotNone(hub.open_stream(p.id, p.token)[1])

    def test_concurrent_compression_runs_once_and_preserves_content(self):
        body = b'{"profile":' + b'1,' * 10000 + b'1}'
        with tempfile.TemporaryDirectory() as folder:
            src = Path(folder, "profile.json"); src.write_bytes(body)
            with patch.object(server, "COMPRESSED_CACHE", str(Path(folder, "cache"))), \
                    patch.object(server, "_gzip_cache", server.collections.OrderedDict()), \
                    patch.object(server.shutil, "copyfileobj", wraps=server.shutil.copyfileobj) as copies:
                with concurrent.futures.ThreadPoolExecutor(16) as pool:
                    paths = list(pool.map(server.compressed_file, [str(src)] * 16))
                self.assertEqual(len(set(paths)), 1)
                self.assertEqual(copies.call_count, 1)
                self.assertEqual(server.gzip.decompress(Path(paths[0]).read_bytes()), body)
                src.write_bytes(body.replace(b'1', b'2'))
                os.utime(src, ns=(src.stat().st_atime_ns, src.stat().st_mtime_ns + 1_000_000))
                fresh = server.compressed_file(str(src))
                self.assertNotEqual(fresh, paths[0])
                self.assertEqual(server.gzip.decompress(Path(fresh).read_bytes()), src.read_bytes())

    def test_static_cache_hit_does_not_open_original_file(self):
        class Request:
            headers = {"Accept-Encoding": "gzip"}
            def send_file(self, *args): self.response = args
        with tempfile.TemporaryDirectory() as folder:
            src = Path(folder, "large.json"); src.write_bytes(b'"' + b'x' * 4000 + b'"')
            with patch.object(server, "STATIC", folder), \
                    patch.object(server, "COMPRESSED_CACHE", str(Path(folder, "cache"))), \
                    patch.object(server, "_gzip_cache", server.collections.OrderedDict()):
                req = Request(); server.Handler.static(req, "/large.json")
                with patch("builtins.open", side_effect=AssertionError("cache hit opened original")):
                    server.Handler.static(req, "/large.json")
                self.assertTrue(req.response[-1])

    def test_readonly_compression_cache_falls_back_to_streaming_original(self):
        class Request:
            headers = {"Accept-Encoding": "gzip"}
            def send_file(self, *args): self.response = args
        with tempfile.TemporaryDirectory() as folder:
            src = Path(folder, "large.json"); src.write_bytes(b'"' + b'x' * 4000 + b'"')
            with patch.object(server, "STATIC", folder), \
                    patch.object(server, "compressed_file", side_effect=PermissionError("read-only cache")):
                req = Request(); server.Handler.static(req, "/large.json")
                self.assertEqual(req.response[0], str(src))
                self.assertFalse(req.response[-1])

    def test_file_send_writes_bounded_chunks(self):
        class Writer:
            def __init__(self): self.sizes = []
            def write(self, data): self.sizes.append(len(data))
        class Request:
            wfile = Writer()
            def send_response(self, code): self.code = code
            def send_header(self, *args): pass
            def end_headers(self): pass
        with tempfile.TemporaryDirectory() as folder:
            src = Path(folder, "body.bin"); src.write_bytes(b'x' * (3 * server.FILE_CHUNK_BYTES + 7))
            req = Request()
            server.Handler.send_file(req, str(src), "application/octet-stream", "no-cache")
            self.assertEqual(sum(req.wfile.sizes), src.stat().st_size)
            self.assertLessEqual(max(req.wfile.sizes), server.FILE_CHUNK_BYTES)

    def test_gzip_quality_zero_is_respected(self):
        self.assertFalse(server.accepts_gzip("gzip;q=0, br"))
        self.assertFalse(server.accepts_gzip("gzip;q=0, *;q=1"))
        self.assertTrue(server.accepts_gzip("gzip;q=0.5"))

    def test_snapshot_wire_format_and_disconnects_release_stream_and_slot(self):
        for failure in (None, "headers", "snapshot"):
            with self.subTest(failure=failure):
                hub = server.Hub(); p = self.player(hub)
                slots = threading.BoundedSemaphore(2)
                original_open = hub.open_stream
                def open_stream(*args):
                    player, q = original_open(*args)
                    q.put_nowait(("drop", ""))  # finish immediately after the initial snapshot
                    return player, q
                class Writer(io.BytesIO):
                    def write(self, data):
                        if failure == "snapshot": raise BrokenPipeError("disconnected")
                        return super().write(data)
                class Request:
                    wfile = Writer()
                    connection = object()
                    def limited(self, *_): return False
                    def send_response(self, *_): pass
                    def send_header(self, *_): pass
                    def end_headers(self):
                        if failure == "headers": raise BrokenPipeError("disconnected")
                req = Request()
                with patch.object(server, "HUB", hub), patch.object(server, "_snapshot_slots", slots), \
                        patch.object(hub, "open_stream", side_effect=open_stream):
                    server.Handler.events(req, {"id": [p.id], "token": [p.token]})
                self.assertFalse(p.queues)
                self.assertTrue(slots.acquire(blocking=False))
                self.assertTrue(slots.acquire(blocking=False))
                self.assertFalse(slots.acquire(blocking=False))
                if failure is None:
                    wire = req.wfile.getvalue()
                    self.assertTrue(wire.startswith(b"data: "))
                    self.assertTrue(wire.endswith(b"\n\n"))
                    data = json.loads(wire[6:-2])
                    self.assertEqual(data["type"], "snapshot")
                    self.assertEqual(data["you"], p.name)
                    self.assertIsInstance(data["now"], int)

    def test_gzip_metadata_cache_is_bounded(self):
        with tempfile.TemporaryDirectory() as folder, \
                patch.object(server, "COMPRESSED_CACHE", str(Path(folder,"cache"))), \
                patch.object(server, "_gzip_cache", server.collections.OrderedDict()), \
                patch.object(server, "MAX_GZIP_ENTRIES", 2):
            for i in range(3):
                src = Path(folder, f"{i}.json"); src.write_bytes(b'x' * 2000)
                server.compressed_file(str(src))
            self.assertEqual(len(server._gzip_cache), 2)

    def test_busy_snapshot_slots_preserve_session_and_request_automatic_retry(self):
        hub = server.Hub(); p = self.player(hub)
        p.gone_since = 0
        class Request:
            wfile = io.BytesIO()
            headers = {}
            def limited(self, *_): return False
            def send_response(self, code): self.code = code
            def send_header(self, key, value): self.headers[key] = value
            def end_headers(self): pass
        req = Request()
        with patch.object(server, "HUB", hub), patch.object(server, "_snapshot_slots") as slots:
            slots.acquire.return_value = False
            server.Handler.events(req, {"id": [p.id], "token": [p.token]})
            slots.release.assert_not_called()
        self.assertEqual(req.code, 200)
        self.assertEqual(req.headers["Content-Type"], "text/event-stream")
        self.assertIn(b"retry: 1000", req.wfile.getvalue())
        self.assertTrue(req.close_connection)
        self.assertGreater(p.gone_since, 0)
        self.assertFalse(p.queues)

    def test_http_compressed_files_and_live_room_messages(self):
        import http.client
        hub = server.Hub()
        with tempfile.TemporaryDirectory() as folder:
            static = Path(folder, "static"); (static / "data").mkdir(parents=True)
            body = json.dumps({"data": "x" * 10000}).encode()
            (static / "data" / "test.json").write_bytes(body)
            with patch.object(server, "STATIC", str(static)), \
                    patch.object(server, "COMPRESSED_CACHE", str(Path(folder, "cache"))), \
                    patch.object(server, "_gzip_cache", server.collections.OrderedDict()), \
                    patch.object(server, "HUB", hub), patch.object(server, "LIMITS", server.RateLimiter()):
                srv = server.Server(("127.0.0.1", 0), server.Handler)
                thread = threading.Thread(target=srv.serve_forever, daemon=True); thread.start()
                address = ("127.0.0.1", srv.server_port)
                stream = None
                def post(path, value, raw=False):
                    connection = http.client.HTTPConnection(*address, timeout=3)
                    try:
                        connection.request("POST", path, value if raw else json.dumps(value), {"Content-Type": "application/json"})
                        response = connection.getresponse()
                        return response.status, json.loads(response.read())
                    finally:
                        connection.close()
                try:
                    for encoding in ("gzip", "gzip;q=0"):
                        connection = http.client.HTTPConnection(*address, timeout=3)
                        connection.request("GET", "/data/test.json", headers={"Accept-Encoding": encoding})
                        response = connection.getresponse(); received = response.read()
                        self.assertEqual(response.status, 200)
                        if encoding == "gzip":
                            self.assertEqual(response.getheader("Content-Encoding"), "gzip")
                            received = server.gzip.decompress(received)
                        else:
                            self.assertIsNone(response.getheader("Content-Encoding"))
                        self.assertEqual(received, body)
                        connection.close()
                    code, me = post("/api/join", {"name": "Viper", "room": "test-room"})
                    self.assertEqual(code, 200)
                    stream = http.client.HTTPConnection(*address, timeout=3)
                    stream.request("POST", '/api/events', json.dumps({"id": me["id"], "token": me["token"]}),
                                   {"Content-Type": "application/json"})
                    response = stream.getresponse()
                    self.assertEqual(response.status, 200)
                    snapshot = json.loads(response.fp.readline()[6:]); response.fp.readline()
                    self.assertEqual(snapshot["you"], me["name"])
                    payload = {"id": me["id"], "token": me["token"], "item":
                               {"id": "test123", "type": "marker", "xz": [100,100], "at": 1.0}}
                    self.assertEqual(post("/api/item", payload)[0], 200)
                    event = json.loads(response.fp.readline()[6:]); response.fp.readline()
                    self.assertEqual(event["item"], payload["item"])
                    bad = json.dumps(payload).replace('"at": 1.0', '"at": 1e309')
                    self.assertEqual(post("/api/item", bad, raw=True)[0], 400)
                    self.assertEqual(hub.players[me["id"]].items["test123"]["at"], 1.0)
                    hub.kick(me["id"])
                    self.assertEqual(response.fp.readline(), b"event: bye\n")
                    self.assertTrue(json.loads(response.fp.readline()[6:])["reason"])
                finally:
                    if stream: stream.close()
                    srv.shutdown(); srv.server_close(); thread.join(timeout=3)

    def test_removing_player_with_full_stream_does_not_hold_hub_lock(self):
        hub = server.Hub()
        player = server.Player("Viper", "#ff6b6b", "room", "127.0.0.1")
        stream = queue.Queue(2)
        stream.put_nowait("old event")
        stream.put_nowait("old event")
        player.queues.add(stream)
        hub.players[player.id] = player
        hub.rooms[player.room] = {}

        thread = threading.Thread(target=lambda: hub.kick(player.id), daemon=True)
        thread.start()
        thread.join(timeout=1)
        blocked = thread.is_alive()
        if blocked:  # Clean up even if this test is run against the old bug.
            stream.get_nowait()
            thread.join(timeout=1)
        self.assertFalse(blocked, "removal blocked on the full event queue")
        self.assertNotIn(player.id, hub.players)
        self.assertNotIn(player.room, hub.rooms)
        self.assertEqual(stream.get_nowait(), ("bye", "You were removed from the map by the admin."))
        self.assertTrue(stream.empty())
        self.assertTrue(hub.lock.acquire(blocking=False))
        hub.lock.release()

    def test_concurrent_downloads_of_same_tile_use_separate_temp_files(self):
        body = b"\xff\xd8test JPEG"
        downloads = threading.Barrier(2)
        writes = threading.Barrier(2)
        replace = os.replace
        fdopen = os.fdopen
        temporary_paths = []

        def upstream(*args, **kwargs):
            downloads.wait(timeout=3)  # Both requests miss the cache.
            return io.BytesIO(body)

        def publish(src, dst):
            temporary_paths.append(src)
            replace(src, dst)

        class WritingFile:
            def __init__(self, fd, mode):
                self.file = fdopen(fd, mode)

            def __enter__(self):
                return self.file

            def __exit__(self, *args):
                self.file.close()
                writes.wait(timeout=3)  # Both files are closed before publication.

        class Request:
            def send_bytes(self, *args):
                self.response = args

        with tempfile.TemporaryDirectory() as cache:
            with patch.object(server, "_missing_tiles", set()), \
                    patch.object(server.urllib.request.OpenerDirector, "open", side_effect=upstream), \
                    patch.object(server.os, "fdopen", side_effect=WritingFile), \
                    patch.object(server.os, "replace", side_effect=publish):
                requests = [Request(), Request()]
                with concurrent.futures.ThreadPoolExecutor(2) as pool:
                    futures = [pool.submit(server.Handler.upstream_tile, req, UPSTREAM, cache, 0, 1, 1) for req in requests]
                    for future in futures:
                        future.result(timeout=5)
            self.assertEqual(len(set(temporary_paths)), 2)
            self.assertEqual(Path(cache, "0", "1", "1.jpg").read_bytes(), body)
            self.assertEqual(list(Path(cache).rglob("*.part")), [])
            for req in requests:
                self.assertEqual(req.response[:2], (200, body))

    def test_failed_tile_publish_cleans_up_temp_file(self):
        class Request:
            def send_bytes(self, *args):
                raise AssertionError("failed publish must not report success")

        with tempfile.TemporaryDirectory() as cache:
            with patch.object(server, "_missing_tiles", set()), \
                    patch.object(server.urllib.request.OpenerDirector, "open", return_value=io.BytesIO(b"\xff\xd8test")), \
                    patch.object(server.os, "replace", side_effect=OSError("publish failed")):
                with self.assertRaisesRegex(OSError, "publish failed"):
                    server.Handler.upstream_tile(Request(), UPSTREAM, cache, 0, 1, 1)
            self.assertEqual(list(Path(cache).rglob("*.part")), [])


class MapListTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.maps = Path(self.tmp.name, "maps")
        for p in [patch.object(server, "MAPS_DIR", str(self.maps)), patch.object(server, "STATIC", self.tmp.name),
                  patch.object(server, "ROOT", self.tmp.name), patch.object(server, "_maps_cache", {"key": None, "maps": {}})]:
            p.start()
            self.addCleanup(p.stop)

    def add(self, map_id, **info):
        d = self.maps / map_id
        d.mkdir(parents=True, exist_ok=True)
        (d / "map.json").write_text(json.dumps(info), encoding="utf8")
        return d

    def test_every_folder_with_a_map_json_is_listed_in_order(self):
        self.add("zeta", title="Zeta", world=4096)
        self.add("alpha", title="Alpha", world=12800, order=2, upstream={"url": "https://x/{z}/{x}/{y}.jpg"})
        self.add("beta", title="Beta", world=12800, order=1)
        (self.add("beta2", world=12800) / "foliage.json").write_text("{}")
        (self.maps / "nojson").mkdir()
        self.add("broken", title="Broken")  # no world size
        self.add("Bad Name", world=1)
        Path(self.tmp.name, "data").mkdir()
        Path(self.tmp.name, "data", "alpha.json").write_text("{}")
        listed = server.public_maps()
        self.assertEqual(list(listed["maps"]), ["beta", "alpha", "beta2", "zeta"])
        self.assertEqual(listed["default"], "beta")
        self.assertEqual(server.default_map(), "beta")
        alpha = listed["maps"]["alpha"]
        self.assertNotIn("upstream", alpha)
        self.assertEqual(alpha["tiles"], "/maptiles/alpha/{z}/{x}/{y}.jpg")
        self.assertEqual(alpha["poi"], "/data/alpha.json")
        self.assertNotIn("poi", listed["maps"]["zeta"])
        self.assertEqual(listed["maps"]["beta2"]["title"], "Beta2")
        self.assertTrue(listed["maps"]["beta2"]["hasPlants"])
        self.assertFalse(listed["maps"]["zeta"]["hasPlants"])

    def test_a_new_or_changed_map_json_is_picked_up(self):
        self.add("one", world=100)
        self.assertEqual(list(server.load_maps()), ["one"])
        self.add("two", world=100, order=0)
        self.assertEqual(list(server.load_maps()), ["two", "one"])

    def test_join_accepts_only_listed_maps(self):
        self.add("isle", world=100)
        hub = server.Hub()
        code, me = hub.join("alice", "room1", ipaddress.ip_address("10.0.0.1"))
        self.assertEqual((code, me["map"]), (200, "isle"))
        self.assertEqual(hub.join("bob", "room2", ipaddress.ip_address("10.0.0.2"), "nowhere")[0], 400)

    def tile_request(self, map_id):
        class Request:
            def send_bytes(self, *args):
                self.response = ("bytes",) + args

            def send_file(self, *args):
                self.response = ("file",) + args

            def upstream_tile(self, *args):
                self.response = ("upstream",) + args
        req = Request()
        server.Handler.map_tile(req, map_id, "0", "1", "1")
        return req.response

    def test_tiles_come_from_the_folder_then_the_upstream(self):
        own = self.add("own", world=100)
        (own / "tiles" / "0" / "1").mkdir(parents=True)
        (own / "tiles" / "0" / "1" / "1.jpg").write_bytes(b"\xff\xd8")
        self.add("up", world=100, upstream={"url": UPSTREAM, "cache": "tile_cache"})
        self.add("sneaky", world=100, upstream={"url": UPSTREAM, "cache": "../outside"})
        self.assertEqual(self.tile_request("own")[0], "file")
        self.assertEqual(self.tile_request("up"), ("upstream", UPSTREAM, os.path.join(self.tmp.name, "tile_cache"), "0", "1", "1"))
        self.assertEqual(self.tile_request("sneaky")[:2], ("bytes", 404))
        self.assertEqual(self.tile_request("own2")[:2], ("bytes", 404))


class KeptRoomTests(unittest.TestCase):
    """Rooms switched to keep their plan hold markings after their owners leave, and come back after a restart."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        for target, value in [("ROOMS_FILE", os.path.join(self.tmp.name, "rooms.json")),
                              ("load_maps", lambda: {"everon": {}, "arland": {}})]:
            p = patch.object(server, target, value)
            p.start()
            self.addCleanup(p.stop)
        self.hub = server.Hub()

    def join(self, name, room="squad-1", map_id="everon", hub=None):
        code, me = (hub or self.hub).join(name, room, "127.0.0.1", map_id)
        self.assertEqual(code, 200, me)
        return me

    def mark(self, me, item_id="mark1"):
        item = {"id": item_id, "type": "marker", "xz": [100, 200]}
        self.assertEqual(self.hub.upsert(me["id"], me["token"], item)[0], 200)

    def test_room_and_kept_room_limits_preserve_existing_plans(self):
        with patch.object(server, "MAX_ROOMS", 2), patch.object(server, "MAX_KEPT_ROOMS", 1):
            a = self.join("Viper", "room-one")
            self.mark(a)
            self.assertEqual(self.hub.set_keep(a["id"], a["token"], True)[0], 200)
            self.hub.leave(a["id"], a["token"])
            b = self.join("Ghost", "room-two")
            self.assertEqual(self.hub.set_keep(b["id"], b["token"], True)[0], 503)
            self.assertEqual(self.hub.join("Third", "room-three", "127.0.0.1")[0], 503)
            returned = self.join("Viper", "room-one")
            self.assertIn("mark1", self.hub.players[returned["id"]].items)
            self.assertEqual(self.hub.set_keep(returned["id"], returned["token"], False)[0], 200)
            self.assertEqual(self.hub.set_keep(b["id"], b["token"], True)[0], 200)
            self.hub.leave(returned["id"], returned["token"])
            self.join("Third", "room-three")

    def test_saved_owners_count_toward_room_slots_and_can_rejoin(self):
        with patch.object(server, "MAX_ROOM_PLAYERS", 2):
            a = self.join("Viper")
            self.mark(a)
            self.hub.set_keep(a["id"], a["token"], True)
            self.hub.leave(a["id"], a["token"])
            b = self.join("Ghost")
            self.assertEqual(self.hub.join("Third", "squad-1", "127.0.0.1")[0], 403)
            returned = self.join("viper")
            self.assertIn("mark1", self.hub.players[returned["id"]].items)
            self.hub.set_keep(b["id"], b["token"], False)
            self.hub.leave(returned["id"], returned["token"])
            self.join("Third")

    def test_load_enforces_room_owner_and_marking_budgets(self):
        import time
        item = {"id": "mark1", "type": "marker", "xz": [100, 200]}
        size = len(json.dumps(item))
        data = {f"room-{i}": {"seen": time.time(), "owners": {
            name: {"items": [item, {**item, "id": "mark2"}]} for name in ("Viper", "Ghost")}}
            for i in range(3)}
        Path(server.ROOMS_FILE).write_text(json.dumps(data), encoding="utf-8")
        with patch.object(server, "MAX_KEPT_ROOMS", 1), patch.object(server, "MAX_ROOM_PLAYERS", 1), patch.object(server, "MAX_PLAYER_BYTES", size):
            self.hub.load()
        self.assertEqual(len(self.hub.rooms), 1)
        self.assertEqual(len(self.hub._away()), 1)
        self.assertEqual(list(self.hub._away()[0].items), ["mark1"])
        for budget in ("MAX_ROOM_BYTES", "MAX_STATE_BYTES"):
            hub = server.Hub()
            with patch.object(server, budget, size):
                hub.load()
            expected = size * len(hub.rooms) if budget == "MAX_ROOM_BYTES" else size
            self.assertEqual(sum(sum(o.item_bytes.values()) for o in hub._away()), expected)

    def test_load_rejects_oversized_and_malformed_files(self):
        for raw in ('{"room-one":{"seen":NaN}}', '{"room-one":{"owners":[]}}', '{"room-one":{"owners":{"Viper":{"items":{}}},"clock":{"rate":[]}}}'):
            Path(server.ROOMS_FILE).write_text(raw, encoding="utf-8")
            server.Hub().load()  # invalid shapes must not crash startup
        Path(server.ROOMS_FILE).write_text('{}' + ' ' * 100, encoding="utf-8")
        with patch.object(server, "MAX_ROOMS_FILE_BYTES", 10):
            self.hub.load()
        self.assertFalse(self.hub.rooms)

    def test_client_scope_catalog_matches_live_server_validation(self):
        import subprocess
        import shutil
        node = shutil.which("node") or str(Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe")
        result = subprocess.run([node, str(Path(__file__).parent / "test_client.cjs"), "--scoped-guns"],
                                capture_output=True, text=True, check=True, encoding="utf-8")
        scopes = json.loads(next(line for line in result.stdout.splitlines() if line.startswith('{"')))
        self.assertEqual(scopes, server.SCOPED_GUNS)

    def test_unkept_room_still_forgets_markings(self):
        a = self.join("Viper")
        self.mark(a)
        self.hub.leave(a["id"], a["token"])
        self.assertNotIn("squad-1", self.hub.rooms)

    def test_kept_room_survives_leaving_and_rejoining(self):
        a = self.join("Viper", map_id="arland")
        self.mark(a)
        self.hub.set_briefing(a["id"], a["token"], "Hit the radio tower at dawn.")
        self.assertEqual(self.hub.set_keep(a["id"], a["token"], True)[0], 200)
        self.hub.leave(a["id"], a["token"])
        self.assertIn("squad-1", self.hub.rooms)
        b = self.join("Ghost", map_id="everon")
        self.assertEqual(b["map"], "arland")  # the room keeps its map while empty
        p, q = self.hub.open_stream(b["id"], b["token"])
        snap = json.loads(q.get_nowait().body + b"}")
        self.assertTrue(snap["keep"])
        self.assertEqual(snap["briefing"]["text"], "Hit the radio tower at dawn.")
        viper = next(o for o in snap["players"] if o["name"] == "Viper")
        self.assertTrue(viper["away"])
        self.assertEqual([i["id"] for i in viper["items"]], ["mark1"])
        a2 = self.join("viper")  # same name, any capitals: the markings come back
        self.assertEqual(list(self.hub.players[a2["id"]].items), ["mark1"])
        self.assertEqual(self.hub._away("squad-1"), [])

    def test_room_wind_is_shared_checked_and_kept(self):
        a = self.join("Viper")
        b = self.join("Ghost")
        _, q = self.hub.open_stream(b["id"], b["token"])
        q.get_nowait()  # the snapshot
        self.assertEqual(self.hub.set_wind(a["id"], a["token"], {"s": 7.5, "d": 225})[0], 200)
        # the wind goes to everyone in the room as a 'wind' event and into the next snapshot
        ev = json.loads(q.get_nowait())
        self.assertEqual((ev["type"], ev["wind"]["s"], ev["wind"]["d"], ev["wind"]["by"]), ("wind", 7.5, 225, "Viper"))
        self.assertEqual(self.hub.rooms["squad-1"]["wind"]["s"], 7.5)
        self.assertEqual(self.hub.rooms["squad-1"]["wind"]["by"], "Viper")
        _, q2 = self.hub.open_stream(a["id"], a["token"])
        snap = json.loads(q2.get_nowait().body + b"}")
        self.assertEqual((snap["wind"]["s"], snap["wind"]["d"]), (7.5, 225))
        for bad in (None, {"s": -1, "d": 0}, {"s": 41, "d": 0}, {"s": 5, "d": 400}, {"s": "5", "d": 0}, {"s": 5, "d": 0, "x": 1}):
            self.assertEqual(self.hub.set_wind(a["id"], a["token"], bad)[0], 400, bad)
        self.assertEqual(self.hub.set_wind("nobody", "nothing", {"s": 1, "d": 1})[0], 401)
        # a kept room keeps its wind through a restart
        self.hub.set_keep(a["id"], a["token"], True)
        self.hub.save(force=True)
        hub2 = server.Hub()
        hub2.load()
        self.assertEqual((hub2.rooms["squad-1"]["wind"]["s"], hub2.rooms["squad-1"]["wind"]["d"]), (7.5, 225))

    def test_kept_room_is_saved_and_loaded(self):
        a = self.join("Viper")
        self.mark(a)
        self.hub.set_keep(a["id"], a["token"], True)
        self.hub.leave(a["id"], a["token"])
        self.hub.save()
        hub2 = server.Hub()
        hub2.load()
        self.assertTrue(hub2.rooms["squad-1"]["keep"])
        a2 = self.join("Viper", hub=hub2)
        self.assertEqual(list(hub2.players[a2["id"]].items), ["mark1"])

    def test_turning_keep_off_drops_away_markings(self):
        a, b = self.join("Viper"), self.join("Ghost")
        self.mark(a)
        self.hub.set_keep(a["id"], a["token"], True)
        self.hub.leave(a["id"], a["token"])
        self.assertEqual(len(self.hub._away("squad-1")), 1)
        self.hub.set_keep(b["id"], b["token"], False)
        self.assertEqual(self.hub._away("squad-1"), [])
        self.hub.leave(b["id"], b["token"])
        self.assertNotIn("squad-1", self.hub.rooms)
        self.hub.save()
        with open(server.ROOMS_FILE, encoding="utf8") as f:
            self.assertEqual(json.load(f), {})

    def test_others_can_clear_an_away_players_fire_request(self):
        a, b = self.join("Viper"), self.join("Ghost")
        self.assertEqual(self.hub.upsert(a["id"], a["token"], {"id": "fire1", "type": "marker", "xz": [1, 2], "icon": "fire-point"})[0], 200)
        self.hub.set_keep(a["id"], a["token"], True)
        self.hub.leave(a["id"], a["token"])
        self.assertEqual(self.hub.clear_fire(b["id"], b["token"], "Viper", "fire1")[0], 200)


class SecurityTests(unittest.TestCase):
    def test_malformed_enum_fields_return_validation_errors(self):
        samples = [
            {"id": "test123", "type": "marker", "xz": [1, 2]},
            {"id": "test123", "type": "post", "side": "f", "xz": [1, 2], "range": 100},
            {"id": "test123", "type": "range", "from": [1, 2], "to": [3, 4],
             "rocket": {"l": "RPG-7", "r": "PG-7VM", "s": "iron"}},
            {"id": "test123", "type": "route", "points": [[1, 2], [3, 4]],
             "plan": {"mode": "foot", "from": [1, 2], "to": [3, 4]}},
        ]
        for field in ("type", "status", "veh", "foe", "weapon", "gun", "kind", "icon", "fire", "unit"):
            for bad in ([], {}, True, 10):
                with self.subTest(field=field, bad=bad):
                    self.assertIsNotNone(server.validate_item({**samples[0], field: bad}))
        self.assertIsNotNone(server.validate_item({**samples[1], "side": []}))
        for field in ("l", "r", "s"):
            self.assertIsNotNone(server.validate_item({**samples[2], "rocket": {**samples[2]["rocket"], field: []}}))
        self.assertIsNotNone(server.validate_item({**samples[3], "plan": {**samples[3]["plan"], "mode": []}}))

    def test_only_configured_proxy_peers_can_supply_client_ip(self):
        class Request:
            headers = {"X-Forwarded-For": "192.0.2.1, 203.0.113.2"}
        with patch.object(server, "TRUST_PROXY", True), patch.object(server, "TRUSTED_PROXIES",
                [ipaddress.ip_network("127.0.0.1/32"), ipaddress.ip_network("::1/128")]):
            for peer, expected in [("127.0.0.1", "203.0.113.2"), ("::ffff:127.0.0.1", "203.0.113.2"),
                                   ("10.0.0.3", "10.0.0.3"), ("203.0.113.3", "203.0.113.3")]:
                req = Request(); req.client_address = (peer, 1234)
                self.assertEqual(server.Handler.client_ip(req), expected)
            req.headers = {"X-Forwarded-For": "not-an-ip"}; req.client_address = ("127.0.0.1", 1234)
            self.assertEqual(server.Handler.client_ip(req), "127.0.0.1")
        with patch.object(server, "TRUST_PROXY", False):
            req = Request(); req.client_address = ("127.0.0.1", 1234)
            self.assertEqual(server.Handler.client_ip(req), "127.0.0.1")

    def test_global_login_failures_do_not_block_correct_password(self):
        import time
        admin = server.Admin(); admin.set_password("review-password-12345")
        admin.recent.extend([time.time()] * server.ADMIN_GLOBAL_MAX_FAILURES)
        self.assertEqual(admin.login("203.0.113.7", "wrong")[0], 429)
        code, answer = admin.login("203.0.113.7", "review-password-12345")
        self.assertEqual(code, 200)
        self.assertTrue(admin.check(answer["token"], "203.0.113.7"))
        self.assertFalse(admin.check(answer["token"], "203.0.113.8"))
        # Address-specific protection and session expiration still apply.
        admin.recent.clear()
        with patch.object(server, "audit"):
            for _ in range(server.ADMIN_MAX_FAILURES):
                self.assertEqual(admin.login("192.0.2.8", "wrong")[0], 401)
            self.assertEqual(admin.login("192.0.2.8", "wrong")[0], 429)

    def test_http_validation_stream_auth_and_https_headers(self):
        import http.client
        hub = server.Hub()
        with patch.object(server, "HUB", hub), patch.object(server, "LIMITS", server.RateLimiter()), \
                patch.object(server, "load_maps", lambda: {"everon": {"world": 12800, "upstream": {"url": UPSTREAM}}}), patch.object(server, "TRUST_PROXY", False):
            httpd = server.Server(("127.0.0.1", 0), server.Handler)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True); thread.start()
            def request(method, url, body=None, headers=None):
                connection = http.client.HTTPConnection(*httpd.server_address, timeout=3)
                connection.request(method, url, json.dumps(body) if body is not None else None,
                                   {"Content-Type": "application/json", **(headers or {})})
                response = connection.getresponse(); data = response.read()
                result = response.status, dict(response.getheaders()), data
                connection.close()
                return result
            try:
                for bad in ([], {}, True, 123):
                    self.assertEqual(request("POST", "/api/join", {"name": "Review", "room": "review-room", "map": bad})[0], 400)
                self.assertEqual(request("POST", "/api/air-status", {"status": []})[0], 400)
                self.assertEqual(request("POST", "/api/events", {})[0], 401)
                self.assertEqual(request("GET", "/api/events?id=invalid&token=invalid")[0], 405)
                for url in ("/api/maps", "/data/maps/everon/map.json", "/data/maps/everon/./map.json"):
                    code, _, body = request("GET", url)
                    self.assertEqual(code, 200)
                    self.assertNotIn("upstream", json.loads(body).get("maps", {}).get("everon", json.loads(body)))
                self.assertFalse(hub.players)
                _, _, joined = request("POST", "/api/join", {"name": "Review", "room": "review-room"})
                me = json.loads(joined)
                self.assertEqual(request("POST", "/api/events", {"id": me["id"], "token": "\ud800"})[0], 401)
                code, headers, _ = request("GET", "/api/maps", headers={"X-Forwarded-Proto": "https"})
                self.assertEqual(code, 200)
                self.assertNotIn("Strict-Transport-Security", headers)
                with patch.object(server, "TRUST_PROXY", True):
                    _, headers, _ = request("GET", "/api/maps", headers={"X-Forwarded-Proto": "https"})
                    self.assertEqual(headers["Strict-Transport-Security"], "max-age=31536000")
                    self.assertIn("script-src 'self'", headers["Content-Security-Policy"])
            finally:
                httpd.shutdown(); httpd.server_close(); thread.join(timeout=3)


class ConcurrencyRegressionTests(unittest.TestCase):
    def test_ban_catches_join_paused_after_initial_check(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(server, "load_maps", lambda: {"everon": {}}):
            bans = server.Bans(str(Path(folder, "bans.json")))
            with patch.object(server, "BANS", bans):
                hub = server.Hub()
                _, owner = hub.join("Owner", "race-room", "203.0.113.1", "everon")
                checked, resume = threading.Event(), threading.Event()
                def maps():
                    if threading.current_thread().name == "late-join":
                        checked.set(); self.assertTrue(resume.wait(3))
                    return {"everon": {}}
                with patch.object(server, "load_maps", maps), concurrent.futures.ThreadPoolExecutor(1, thread_name_prefix="unused") as pool:
                    def join():
                        threading.current_thread().name = "late-join"
                        return hub.join("Late", "race-room", "203.0.113.1", "everon")
                    future = pool.submit(join)
                    try:
                        self.assertTrue(checked.wait(3))
                        self.assertEqual(hub.ban(owner["id"], 1)[0], 200)
                    finally:
                        resume.set()
                    self.assertEqual(future.result(timeout=3)[0], 403)
                self.assertEqual(hub.players, {})

    def test_overlapping_saves_publish_the_newest_snapshot(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(server, "ROOMS_FILE", str(Path(folder, "rooms.json"))):
            hub = server.Hub()
            p = server.Player("Owner", "#ffffff", "race-room", "127.0.0.1")
            p.items = {"m": {"id": "m", "type": "marker", "xz": [1, 2], "label": "old"}}
            hub.players[p.id] = p; hub.rooms[p.room] = {"keep": True, "map": "everon"}; hub.dirty = True
            writing, resume = threading.Event(), threading.Event()
            replace = server.os.replace
            def publish(src, dst):
                if threading.current_thread().name == "old-save":
                    writing.set(); self.assertTrue(resume.wait(3))
                replace(src, dst)
            def old():
                threading.current_thread().name = "old-save"; hub.save()
            with patch.object(server.os, "replace", publish), concurrent.futures.ThreadPoolExecutor(2) as pool:
                first = pool.submit(old)
                try:
                    self.assertTrue(writing.wait(3))
                    with hub.lock:
                        p.items["m"] = {**p.items["m"], "label": "new"}; hub.dirty = True
                    second = pool.submit(hub.save)
                finally:
                    resume.set()
                first.result(timeout=3); second.result(timeout=3)
            data = json.loads(Path(server.ROOMS_FILE).read_text())
            self.assertEqual(data[p.room]["owners"][p.name]["items"][0]["label"], "new")
            self.assertFalse(hub.dirty)

    def test_observers_have_separate_capacity_and_cannot_write(self):
        with patch.object(server, "load_maps", lambda: {"everon": {}}), patch.object(server, "MAX_ROOM_PLAYERS", 1), \
                patch.object(server, "MAX_ROOM_OBSERVERS", 2):
            hub = server.Hub()
            _, owner = hub.join("Owner", "view-room", "203.0.113.1", "everon")
            views = [hub.join("Owner", "view-room", f"203.0.113.{i}", "everon", True) for i in (2, 3)]
            self.assertTrue(all(code == 200 for code, _ in views))
            self.assertEqual(hub.join("Owner", "view-room", "203.0.113.4", "everon", True)[0], 403)
            self.assertEqual(hub.join("Other", "view-room", "203.0.113.4", "everon")[0], 403)
            viewer = views[0][1]
            self.assertEqual(hub.upsert(viewer["id"], viewer["token"], {"id": "m", "type": "marker", "xz": [1, 2]})[0], 401)
            self.assertEqual(hub.set_wind(viewer["id"], viewer["token"], {"s": 1, "d": 0})[0], 401)
            p, events = hub.open_stream(viewer["id"], viewer["token"])
            self.assertIsNotNone(p)
            hub.close_stream(p, events)
            hub.leave(viewer["id"], viewer["token"])
            self.assertNotIn(viewer["id"], hub.players)
            self.assertEqual(len(hub._in_room("view-room")), 1)
            hub.set_keep(owner["id"], owner["token"], True)
            hub.leave(owner["id"], owner["token"])
            with tempfile.TemporaryDirectory() as folder, patch.object(server, "ROOMS_FILE", str(Path(folder, "rooms.json"))), \
                    patch.object(server.time, "time", return_value=1234567890):
                hub.save(force=True)
                saved = json.loads(Path(folder, "rooms.json").read_text())
                self.assertEqual(saved["view-room"]["seen"], 1234567890)
                self.assertFalse(saved["view-room"]["owners"])
            hub.close_room("view-room")
            self.assertFalse(hub.players)

    def test_bad_bans_and_boolean_points_are_rejected(self):
        self.assertFalse(server._is_point([True, False]))
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder, "bans.json")
            path.write_text(json.dumps({"bad": {"until": "tomorrow"}, "bool": {"until": True},
                                        "nan": {"until": float("nan")}, "valid": {"until": None}}))
            bans = server.Bans(str(path)); bans.load()
            self.assertEqual(set(bans.bans), {"valid"})
            self.assertIsNone(bans.active("bad"))
            bans.add("valid", 1, "Owner")
            path.write_text("[]"); bans.load(); self.assertFalse(bans.bans)

    def test_limiter_bounds_fresh_addresses_and_recovers_after_idle(self):
        limiter = server.RateLimiter(); limiter.max_buckets = 2
        with patch.object(server.time, "time", return_value=1000):
            self.assertTrue(limiter.allow("a", "join")); self.assertTrue(limiter.allow("b", "join"))
            for i in range(100): self.assertFalse(limiter.allow(str(i), "join"))
            self.assertEqual(len(limiter.buckets), 2)
            self.assertTrue(limiter.allow("a", "join"))
        with patch.object(server.time, "time", return_value=1601):
            self.assertTrue(limiter.allow("new", "join")); self.assertEqual(len(limiter.buckets), 1)

    def test_tile_redirects_stay_on_the_configured_https_origin(self):
        origin = server.https_origin("https://tiles.example/{z}/{x}/{y}.jpg")
        handler = server.TileRedirect(origin)
        request = server.urllib.request.Request("https://tiles.example/old.jpg")
        for url in ("http://tiles.example/new.jpg", "https://other.example/new.jpg", "https://tiles.example:444/new.jpg"):
            with self.assertRaises(server.urllib.error.URLError):
                handler.redirect_request(request, None, 302, "Found", {}, url)
        redirected = handler.redirect_request(request, None, 302, "Found", {}, "https://tiles.example/new.jpg")
        self.assertEqual(redirected.full_url, "https://tiles.example/new.jpg")
        with self.assertRaises(ValueError): server.https_origin("http://tiles.example/tile.jpg")


if __name__ == "__main__":
    unittest.main()

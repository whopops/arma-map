"""Regression checks; run with python -B -m unittest test_server.py."""
import concurrent.futures
import io
import json
import os
from pathlib import Path
import queue
import tempfile
import threading
import unittest
from unittest.mock import patch

import server
import build_release


class ServerTests(unittest.TestCase):
    @staticmethod
    def player(hub, name="Viper", room="room"):
        p = server.Player(name, "#ff6b6b", room, "127.0.0.1")
        hub.players[p.id] = p
        hub.rooms.setdefault(room, {})
        return p

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
                    stream.request("GET", f'/api/events?id={me["id"]}&token={me["token"]}')
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

    def test_production_archive_excludes_runtime_state_and_precompresses_text(self):
        import tarfile
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder, "source"); (root / "static").mkdir(parents=True)
            (root / "server.py").write_text("pass")
            src = root / "static" / "large.json"; src.write_bytes(b'"' + b'x' * 4000 + b'"')
            (root / "bans.json").write_text("private")
            (root / ".git").mkdir(); (root / ".git" / "pack").write_text("git history")
            output = build_release.build(Path(folder, "release.tar.gz"), root)
            with tarfile.open(output) as archive:
                self.assertEqual(set(archive.getnames()), {"server.py", "static/large.json", "static/large.json.gz"})
                self.assertEqual(server.gzip.decompress(archive.extractfile("static/large.json.gz").read()), src.read_bytes())
                self.assertEqual(archive.getmember("static/large.json").mtime, archive.getmember("static/large.json.gz").mtime)

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
            with patch.object(server, "TILE_CACHE", cache), \
                    patch.object(server, "_missing_tiles", set()), \
                    patch.object(server.urllib.request, "urlopen", side_effect=upstream), \
                    patch.object(server.os, "fdopen", side_effect=WritingFile), \
                    patch.object(server.os, "replace", side_effect=publish):
                requests = [Request(), Request()]
                with concurrent.futures.ThreadPoolExecutor(2) as pool:
                    futures = [pool.submit(server.Handler.tile, req, 0, 1, 1) for req in requests]
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
            with patch.object(server, "TILE_CACHE", cache), \
                    patch.object(server, "_missing_tiles", set()), \
                    patch.object(server.urllib.request, "urlopen", return_value=io.BytesIO(b"\xff\xd8test")), \
                    patch.object(server.os, "replace", side_effect=OSError("publish failed")):
                with self.assertRaisesRegex(OSError, "publish failed"):
                    server.Handler.tile(Request(), 0, 1, 1)
            self.assertEqual(list(Path(cache).rglob("*.part")), [])


if __name__ == "__main__":
    unittest.main()

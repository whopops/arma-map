"""Everon Field Map - local server.

Serves the web app, caches map tiles on disk, and relays shared markings
between connected players in the same room. Nothing about players is stored:
a player's markings exist only while their browser tab is connected, and a
room (with its briefing) disappears when its last player leaves.

Run:  python server.py [--port 8765] [--host 0.0.0.0] [--admin-password PASSWORD]

The admin view (/admin) lists every active room and who is in it, and can kick
players, ban their IP address (for 24 hours or for good) and close rooms. Its
password comes from --admin-password or the EVERON_ADMIN_PASSWORD environment
variable; if neither is set, a random one is made up and printed at startup.
Bans are kept in bans.json next to this file so they survive a restart.

Behind a reverse proxy, start with --behind-proxy so players' real addresses are
read from the X-Forwarded-For header (otherwise everyone shares the proxy's).
--admin-allow limits the admin view to some addresses (e.g. 127.0.0.1 or your
home IP); from anywhere else it doesn't exist. Admin actions are logged to the console.
"""

import argparse
import collections
import hashlib
import ipaddress
import json
import math
import mimetypes
import os
import queue
import re
import secrets
import select
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")
TILE_CACHE = os.path.join(ROOT, "tile_cache")
BANS_FILE = os.path.join(ROOT, "bans.json")
TRUST_PROXY = False  # set by --behind-proxy
ADMIN_ALLOW = None   # set by --admin-allow: networks the admin view answers to (None = everywhere)
TILE_UPSTREAM = "https://reforger.recoil.org/map-tiles/everon/{z}/{x}/{y}/tile.jpg"

GRACE_SECONDS = 15          # how long a dropped connection may reconnect before its markings vanish
KEEPALIVE_SECONDS = 5
MAX_ITEMS_PER_PLAYER = 500
MAX_ITEM_BYTES = 20_000
MAX_PLAYER_BYTES = 2_000_000   # all of one player's markings together
MAX_BODY_BYTES = 100_000
MAX_PLAYERS = 1000             # on the whole server
MAX_ROOM_PLAYERS = 60
MAX_PLAYERS_PER_IP = 12        # a LAN party or a household behind one address still fits
MAX_CONNECTIONS = 600          # open sockets (each event stream holds one)
MAX_QUEUED_EVENTS = 5000       # an event stream this far behind is dropped; the browser reconnects and resyncs
SOCKET_TIMEOUT = 60            # seconds a connection may sit silent mid-request
MAX_TILE_FETCHES = 6           # upstream tile downloads at once
# Requests per address: a bucket of `burst` that refills at `rate` per second.
RATE_LIMITS = {"post": (20, 120), "join": (0.2, 10), "tile": (60, 600), "static": (20, 200)}
USERNAME_RE = re.compile(r"^[A-Za-z0-9 _\-\.\[\]]{1,20}$")
ROOM_RE = re.compile(r"^[a-z0-9_-]{3,32}$")
ADMIN_SESSION_SECONDS = 12 * 3600  # a sign-in lasts at most this long
ADMIN_IDLE_SECONDS = 30 * 60       # ...and ends after this long without the admin page open
ADMIN_MAX_SESSIONS = 10
ADMIN_MAX_FAILURES = 5              # wrong passwords from one address before it is locked out
ADMIN_LOCKOUT_SECONDS = 300
# Wrong passwords from all addresses together before sign-in pauses for everyone, so guessing from many
# addresses at once gets nowhere either. Admins already signed in carry on.
ADMIN_GLOBAL_MAX_FAILURES = 30
ADMIN_GLOBAL_WINDOW = 15 * 60
ADMIN_MIN_PASSWORD = 12
MAX_BRIEFING_CHARS = 6000
CLOCK_RATES = {0, 1, 2, 3, 4, 6, 8, 12, 24, 48}  # game seconds per real second the room can pick
ITEM_TYPES = {"marker", "route", "range", "mortar", "fia", "emplacement", "construct", "area",
              "arrow", "ambush", "post", "sectors", "overwatch", "aa"}
AIR_STATUSES = {"requested", "ack", "enroute", "done"}
MORTAR_WEAPONS = {"M252", "2B14"}
MAX_MORTAR_TARGETS = 30
COLORS = ["#ff6b6b", "#4dabf7", "#51cf66", "#fcc419", "#cc5de8", "#ff922b",
          "#22b8cf", "#f06595", "#94d82d", "#845ef7", "#20c997", "#e8590c"]

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/json", ".json")


class Player:
    def __init__(self, name, color, room, ip):
        self.id = secrets.token_hex(8)
        self.room = room
        self.ip = ip
        self.key = addr_key(ip)
        self.joined = time.time()
        self.token = secrets.token_hex(16)
        self.name = name
        self.color = color
        self.items = {}
        self.item_bytes = {}         # item id -> size, for MAX_PLAYER_BYTES
        self.queues = set()          # open event streams
        self.gone_since = time.time()  # not yet connected

    def public(self):
        return {"name": self.name, "color": self.color, "items": list(self.items.values())}


class Hub:
    def __init__(self):
        self.lock = threading.Lock()
        self.players = {}  # id -> Player
        self.rooms = {}    # room code -> {"briefing": {"text", "by", "at"} or None}

    # --- helpers (call with lock held) -------------------------------------
    def _in_room(self, room):
        return [p for p in self.players.values() if p.room == room]

    def _broadcast(self, room, event, skip=None):
        data = json.dumps(event, separators=(",", ":"))
        for p in self._in_room(room):
            if p is skip:
                continue
            for q in p.queues:
                try:
                    q.put_nowait(data)
                except queue.Full:
                    with q.mutex:
                        q.queue.clear()
                    q.put_nowait(("drop", ""))

    def _auth(self, pid, token):
        if not isinstance(pid, str) or not isinstance(token, str):
            return None
        p = self.players.get(pid)
        if not p or not secrets.compare_digest(p.token.encode(), token.encode()):
            return None
        return p

    def _remove(self, p, reason=""):
        if self.players.pop(p.id, None):
            for q in p.queues:
                q.put(("bye", reason))  # ends the player's event stream with this message
            self._broadcast(p.room, {"type": "leave", "name": p.name})
            if not self._in_room(p.room):
                self.rooms.pop(p.room, None)  # last one out: forget the room and its briefing

    # --- API ---------------------------------------------------------------
    def join(self, name, room, ip):
        ban = BANS.active(addr_key(ip))
        if ban:
            return 403, {"error": ban_message(ban)}
        name = (name if isinstance(name, str) else "").strip()
        room = (room if isinstance(room, str) else "").strip().lower()
        if not USERNAME_RE.match(name):
            return 400, {"error": "Use 1-20 letters, numbers, spaces, - _ . [ ]"}
        if not ROOM_RE.match(room):
            return 400, {"error": "Room codes are 3-32 letters, numbers, - or _."}
        with self.lock:
            others = self._in_room(room)
            if len(self.players) >= MAX_PLAYERS:
                return 503, {"error": "The map server is full right now. Try again later."}
            if len(others) >= MAX_ROOM_PLAYERS:
                return 403, {"error": f"This room is full ({MAX_ROOM_PLAYERS} players)."}
            if sum(1 for p in self.players.values() if p.key == addr_key(ip)) >= MAX_PLAYERS_PER_IP:
                return 429, {"error": "Too many players from your address are on the map already."}
            if any(p.name.lower() == name.lower() for p in others):
                return 409, {"error": "That username is in use in this room right now. Pick another."}
            used = {p.color for p in others}
            color = next((c for c in COLORS if c not in used), COLORS[len(others) % len(COLORS)])
            p = Player(name, color, room, ip)
            self.players[p.id] = p
            self.rooms.setdefault(room, {"briefing": None, "created": time.time()})
            self._broadcast(room, {"type": "join", "player": p.public()}, skip=p)
        return 200, {"id": p.id, "token": p.token, "name": p.name, "color": p.color, "room": room}

    def open_stream(self, pid, token):
        with self.lock:
            p = self._auth(pid, token)
            if not p:
                return None, None
            q = queue.Queue(MAX_QUEUED_EVENTS)
            p.queues.add(q)
            p.gone_since = None
            snapshot = {"type": "snapshot", "you": p.name, "room": p.room,
                        "players": [o.public() for o in self._in_room(p.room)],
                        "briefing": self.rooms.get(p.room, {}).get("briefing"),
                        "clock": self.rooms.get(p.room, {}).get("clock"), "now": int(time.time() * 1000)}
            q.put(json.dumps(snapshot, separators=(",", ":")))
            return p, q

    def close_stream(self, p, q):
        with self.lock:
            p.queues.discard(q)
            if not p.queues and p.id in self.players:
                p.gone_since = time.time()

    def upsert(self, pid, token, item):
        with self.lock:
            p = self._auth(pid, token)
            if not p:
                return 401, {"error": "Session expired. Reload the page."}
            err = validate_item(item)
            if err:
                return 400, {"error": err}
            if item["id"] not in p.items and len(p.items) >= MAX_ITEMS_PER_PLAYER:
                return 400, {"error": f"Limit of {MAX_ITEMS_PER_PLAYER} markings reached."}
            size = len(json.dumps(item))
            if sum(p.item_bytes.values()) - p.item_bytes.get(item["id"], 0) + size > MAX_PLAYER_BYTES:
                return 400, {"error": "Your markings are too big altogether. Delete some first."}
            p.items[item["id"]] = item
            p.item_bytes[item["id"]] = size
            self._broadcast(p.room, {"type": "item", "owner": p.name, "item": item})
        return 200, {"ok": True}

    def set_air_status(self, pid, token, owner, item_id, status):
        if status not in AIR_STATUSES or not isinstance(owner, str) or not isinstance(item_id, str):
            return 400, {"error": "Bad request status."}
        with self.lock:
            p = self._auth(pid, token)
            if not p:
                return 401, {"error": "Session expired. Reload the page."}
            o = next((q for q in self.players.values() if q.room == p.room and q.name == owner), None)
            it = o.items.get(item_id) if o else None
            is_request = it and ((it.get("type") == "marker" and str(it.get("icon", "")).startswith("air-"))
                                 or (it.get("type") == "area" and it.get("kind") == "cas"))
            if not is_request:
                return 404, {"error": "That request has gone."}
            it = {**it, "status": status, "statusBy": p.name}
            o.items[item_id] = it
            self._broadcast(p.room, {"type": "item", "owner": o.name, "item": it})
        return 200, {"ok": True}

    def clear_fire(self, pid, token, owner, item_id):
        """Anyone in the room may clear someone's mortar fire request once the mission is done (the page offers it to
        the crew of a mortar that can reach it)."""
        if not isinstance(owner, str) or not isinstance(item_id, str):
            return 400, {"error": "Bad fire request."}
        with self.lock:
            p = self._auth(pid, token)
            if not p:
                return 401, {"error": "Session expired. Reload the page."}
            o = next((q for q in self.players.values() if q.room == p.room and q.name == owner), None)
            it = o.items.get(item_id) if o else None
            is_fire = it and ((it.get("type") == "marker" and it.get("icon") == "fire-point")
                              or (it.get("type") == "area" and it.get("kind") == "fire"))
            if not is_fire:
                return 404, {"error": "That fire request has gone."}
            o.item_bytes.pop(item_id, None)
            o.items.pop(item_id, None)
            self._broadcast(p.room, {"type": "delete", "owner": o.name, "id": item_id, "by": p.name})
        return 200, {"ok": True}

    def move_mortar_target(self, pid, token, owner, item_id, idx, xz):
        """Move one of someone's mortar targets, to correct fire (the page offers it to the mortar's crew)."""
        if not isinstance(owner, str) or not isinstance(item_id, str) or not isinstance(idx, int) or isinstance(idx, bool) or not _is_point(xz):
            return 400, {"error": "Bad target."}
        with self.lock:
            p = self._auth(pid, token)
            if not p:
                return 401, {"error": "Session expired. Reload the page."}
            o = next((q for q in self.players.values() if q.room == p.room and q.name == owner), None)
            it = o.items.get(item_id) if o else None
            if not it or it.get("type") != "mortar" or not 0 <= idx < len(it.get("targets", [])):
                return 404, {"error": "That target has gone."}
            targets = list(it["targets"])
            targets[idx] = xz
            it = {**it, "targets": targets}
            o.items[item_id] = it
            o.item_bytes[item_id] = len(json.dumps(it))
            self._broadcast(p.room, {"type": "item", "owner": o.name, "item": it})
        return 200, {"ok": True}

    def delete(self, pid, token, item_id):
        with self.lock:
            p = self._auth(pid, token)
            if not p:
                return 401, {"error": "Session expired. Reload the page."}
            if not isinstance(item_id, str):
                return 400, {"error": "Bad item id."}
            p.item_bytes.pop(item_id, None)
            if p.items.pop(item_id, None) is not None:
                self._broadcast(p.room, {"type": "delete", "owner": p.name, "id": item_id})
        return 200, {"ok": True}

    def set_briefing(self, pid, token, text):
        if not isinstance(text, str) or len(text) > MAX_BRIEFING_CHARS:
            return 400, {"error": f"The briefing is limited to {MAX_BRIEFING_CHARS} characters."}
        with self.lock:
            p = self._auth(pid, token)
            if not p:
                return 401, {"error": "Session expired. Reload the page."}
            briefing = {"text": text, "by": p.name, "at": int(time.time() * 1000)}
            self.rooms.setdefault(p.room, {})["briefing"] = briefing
            self._broadcast(p.room, {"type": "briefing", "briefing": briefing})
        return 200, {"ok": True}

    def set_clock(self, pid, token, clock):
        """The room's game clock: the game time (seconds into the day) it showed at the moment it was set, how fast it
        runs, and the date and latitude the sun and moon are worked out for. The server stamps the moment, so players'
        own clocks don't matter."""
        if not isinstance(clock, dict):
            return 400, {"error": "Bad clock."}
        num = lambda k, lo, hi: isinstance(clock.get(k), (int, float)) and not isinstance(clock.get(k), bool) and lo <= clock[k] <= hi
        if not (num("game", 0, 86399) and clock.get("rate") in CLOCK_RATES and num("year", 1900, 2200)
                and isinstance(clock.get("month"), int) and 1 <= clock["month"] <= 12
                and isinstance(clock.get("day"), int) and 1 <= clock["day"] <= 31 and num("lat", -66, 66)):
            return 400, {"error": "Bad clock."}
        with self.lock:
            p = self._auth(pid, token)
            if not p:
                return 401, {"error": "Session expired. Reload the page."}
            c = {"game": clock["game"], "rate": clock["rate"], "year": clock["year"], "month": clock["month"], "day": clock["day"],
                 "lat": clock["lat"], "at": int(time.time() * 1000), "by": p.name}
            self.rooms.setdefault(p.room, {})["clock"] = c
            self._broadcast(p.room, {"type": "clock", "clock": c, "now": c["at"]})
        return 200, {"ok": True}

    def leave(self, pid, token):
        with self.lock:
            p = self._auth(pid, token)
            if p:
                self._remove(p)
        return 200, {"ok": True}

    def admin_snapshot(self):
        """Every active room and who is in it, for the admin view."""
        now = time.time()
        with self.lock:
            out = []
            for code, info in self.rooms.items():
                players = sorted(self._in_room(code), key=lambda p: p.joined)
                if not players:
                    continue
                b = info.get("briefing")
                out.append({
                    "room": code,
                    "created": int(info.get("created", now) * 1000),
                    "briefing": {"by": b["by"], "at": b["at"], "chars": len(b["text"])} if b and b["text"].strip() else None,
                    "players": [{
                        "id": p.id, "ip": p.ip, "key": p.key,
                        "name": p.name, "color": p.color, "joined": int(p.joined * 1000),
                        "connected": p.gone_since is None,
                        "awaySeconds": 0 if p.gone_since is None else int(now - p.gone_since),
                        "markings": len(p.items),
                    } for p in players],
                })
            out.sort(key=lambda r: (-len(r["players"]), r["room"]))
            return {"now": int(now * 1000), "rooms": out, "bans": BANS.list(),
                    "totalPlayers": sum(len(r["players"]) for r in out)}

    # --- moderation (admin only) -------------------------------------------
    def kick(self, pid):
        with self.lock:
            p = self.players.get(pid) if isinstance(pid, str) else None
            if not p:
                return 404, {"error": "That player has already left."}
            self._remove(p, "You were removed from the map by the admin.")
        return 200, {"ok": True, "name": p.name}

    def ban(self, pid, hours):
        if hours is not None and not (isinstance(hours, (int, float)) and 0 < hours <= 24 * 365):
            return 400, {"error": "Bad ban length."}
        with self.lock:
            p = self.players.get(pid) if isinstance(pid, str) else None
            if not p:
                return 404, {"error": "That player has already left."}
            ban = BANS.add(p.key, hours, p.name)
            # Everyone on that address goes, whichever room they are in.
            gone = [o for o in self.players.values() if o.key == p.key]
            for o in gone:
                self._remove(o, ban_message(ban))
        return 200, {"ok": True, "removed": [o.name for o in gone], "name": p.name, "ip": p.key}

    def close_room(self, room):
        if not isinstance(room, str):
            return 404, {"error": "That room is already empty."}
        with self.lock:
            players = self._in_room(room)
            if not players:
                return 404, {"error": "That room is already empty."}
            for p in players:
                self._remove(p, "The admin closed this room.")
            self.rooms.pop(room, None)
        return 200, {"ok": True, "removed": len(players)}

    def reap(self):
        while True:
            time.sleep(2)
            now = time.time()
            with self.lock:
                for p in list(self.players.values()):
                    if p.gone_since is not None and now - p.gone_since > GRACE_SECONDS:
                        self._remove(p)


def _is_point(v):
    return (isinstance(v, list) and len(v) == 2 and all(isinstance(n, (int, float)) for n in v)
            and all(-2000 <= n <= 15000 for n in v))


NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
SHELL_RE = re.compile(r"^[A-Za-z0-9 ._()/+-]{1,40}$")


def _depth(v, limit=6):
    """True if v nests no deeper than limit lists/dicts."""
    if isinstance(v, (list, dict)):
        if limit <= 0:
            return False
        return all(_depth(x, limit - 1) for x in (v.values() if isinstance(v, dict) else v))
    return True


def validate_item(item):
    if not isinstance(item, dict):
        return "Bad item."
    if len(item) > 40 or not all(isinstance(k, str) and len(k) <= 20 for k in item) or not _depth(item):
        return "Bad item."
    if len(json.dumps(item)) > MAX_ITEM_BYTES:
        return "Item too large."
    # Names the map looks things up by: lower-case words and dashes, never a JavaScript built-in like "constructor"
    for k in ("icon", "kind", "fire", "unit"):
        if k in item and (not isinstance(item[k], str) or len(item[k]) > 24 or not NAME_RE.match(item[k])
                          or item[k] == "constructor"):
            return f"Bad {k}."
    if not isinstance(item.get("id"), str) or not re.match(r"^[A-Za-z0-9_-]{4,40}$", item["id"]):
        return "Bad item id."
    t = item.get("type")
    if t not in ITEM_TYPES:
        return "Unknown item type."
    for k in ("label", "note"):
        if k in item and (not isinstance(item[k], str) or len(item[k]) > 500):
            return f"Bad {k}."
    if "color" in item and not (isinstance(item["color"], str) and re.match(r"^#[0-9a-fA-F]{6}$", item["color"])):
        return "Bad color."
    num = lambda k, lo, hi: isinstance(item.get(k), (int, float)) and not isinstance(item.get(k), bool) and lo <= item[k] <= hi
    # Air support request details and status (pins, and gun-run target areas)
    air = item.get("air")
    if air is not None and (not isinstance(air, dict) or len(air) > 8 or not all(
            isinstance(k, str) and len(k) <= 20 and isinstance(v, str) and len(v) <= 60 for k, v in air.items())):
        return "Bad air support request."
    if "status" in item and item["status"] not in AIR_STATUSES:
        return "Bad request status."
    if "statusBy" in item and (not isinstance(item["statusBy"], str) or len(item["statusBy"]) > 40):
        return "Bad request status."
    if t == "marker":
        if not _is_point(item.get("xz")):
            return "Bad marker position."
        # Contact report details (all optional)
        for k in ("size", "activity", "kit"):
            if k in item and (not isinstance(item[k], str) or len(item[k]) > 60):
                return "Bad contact report."
        if item.get("heading") is not None and not num("heading", 0, 360):
            return "Bad contact heading."
        if "ttl" in item and not num("ttl", 0, 1440):
            return "Bad timeout."
        if "range" in item and not num("range", 0, 2000):
            return "Bad range card reach."
        if "unit" in item and item["unit"] not in {"inf", "arm"}:
            return "Bad position type."
        if "ring" in item and not isinstance(item["ring"], bool):
            return "Bad radius toggle."
        if "fire" in item and item["fire"] not in {"he", "smoke", "illum"}:
            return "Bad fire request."
    if t == "arrow":
        pts = item.get("points")
        if item.get("kind") not in {"advance", "enemy", "patrol", "flight"}:
            return "Unknown arrow."
        if not isinstance(pts, list) or not 2 <= len(pts) <= 200 or not all(_is_point(p) for p in pts):
            return "Bad arrow."
    if t == "ambush":
        if item.get("kind") not in {"linear", "l"} or item.get("side") not in (1, -1):
            return "Bad ambush."
        if not (_is_point(item.get("from")) and _is_point(item.get("to"))):
            return "Bad ambush position."
    if t == "post":
        if item.get("side") not in {"f", "e", "v", "fv"} or not _is_point(item.get("xz")) or not num("range", 50, 2000):
            return "Bad range card."
    if t == "aa":
        if item.get("side") != "e" or not _is_point(item.get("xz")):
            return "Bad AA gun."
        if not (num("dir", 0, 360) and num("arc", 5, 360) and num("range", 100, 3000)):
            return "Bad AA field of fire."
        if "height" in item and not num("height", 0, 100):
            return "Bad AA height."
    if t == "overwatch" and not (_is_point(item.get("xz")) and num("range", 50, 2000)):
        return "Bad overwatch."
    if t == "sectors":
        names = item.get("names", [])
        if not _is_point(item.get("xz")) or not num("radius", 20, 3000) or not num("start", 0, 360):
            return "Bad sectors of fire."
        if not isinstance(item.get("n"), int) or not 2 <= item["n"] <= 12:
            return "Bad number of sectors."
        if not isinstance(names, list) or len(names) > 12 or not all(isinstance(s, str) and len(s) <= 40 for s in names):
            return "Bad sector names."
    if t == "route":
        pts = item.get("points")
        if not isinstance(pts, list) or not 2 <= len(pts) <= 200 or not all(_is_point(p) for p in pts):
            return "Bad route."
        plan = item.get("plan")
        if plan is not None and not (isinstance(plan, dict) and plan.get("mode") == "foot" and _is_point(plan.get("from"))
                                     and _is_point(plan.get("to")) and isinstance(plan.get("at", 0), (int, float))):
            return "Bad route plan."
    if t == "range" and not (_is_point(item.get("from")) and _is_point(item.get("to"))):
        return "Bad range line."
    if t == "mortar":
        targets = item.get("targets", [])
        if not _is_point(item.get("xz")) or item.get("weapon") not in MORTAR_WEAPONS:
            return "Bad mortar."
        if not isinstance(item.get("shell"), str) or not SHELL_RE.match(item["shell"]):
            return "Bad mortar shell."
        if not isinstance(targets, list) or len(targets) > MAX_MORTAR_TARGETS or not all(_is_point(p) for p in targets):
            return "Bad mortar targets."
    if t == "emplacement":
        if not _is_point(item.get("xz")) or item.get("kind") not in {"mg"}:
            return "Bad emplacement."
        if not (num("dir", 0, 360) and num("arc", 5, 360) and num("range", 10, 3000)):
            return "Bad field of fire."
        if "height" in item and not num("height", 0, 100):
            return "Bad emplacement height."
    if t == "area":
        pts = item.get("points")
        if item.get("kind") not in {"enemy", "fire", "cas"} or not isinstance(pts, list) or not 3 <= len(pts) <= 200 or not all(_is_point(p) for p in pts):
            return "Bad area."
        if item["kind"] == "fire" and item.get("fire") not in {"he", "smoke", "illum"}:
            return "Bad fire request."
    if t == "construct":
        kind = item.get("kind")
        # "wall" is the sandbag line; a roadblock is a line of tank traps (older plans may hold single-point ones)
        if kind in {"bunker", "checkpoint"} or (kind == "roadblock" and "points" not in item):
            if not _is_point(item.get("xz")):
                return "Bad construct position."
        elif kind in {"wall", "wire", "roadblock"}:
            pts = item.get("points")
            if not isinstance(pts, list) or not 2 <= len(pts) <= 200 or not all(_is_point(p) for p in pts):
                return "Bad sandbag, wire or roadblock line."
        else:
            return "Unknown construct."
    if t == "fia":
        caches = item.get("caches")
        if not isinstance(caches, list) or len(caches) > 40 or not all(isinstance(c, str) and 0 < len(c) <= 60 for c in caches):
            return "Bad FIA cache list."
    return None


def peer_closed(sock):
    """True once the browser has closed an event stream (it never sends anything, so readable means EOF)."""
    try:
        readable, _, _ = select.select([sock], [], [], 0)
        return bool(readable) and sock.recv(1, socket.MSG_PEEK) == b""
    except OSError:
        return True


def ban_message(ban):
    if not ban.get("until"):
        return "You have been banned from this map."
    left_min = math.ceil(max(0, ban["until"] / 1000 - time.time()) / 60)
    hours, mins = divmod(left_min, 60)
    left = f"{hours} h {mins} min" if hours and mins else f"{hours} h" if hours else f"{mins} min"
    return f"You have been banned from this map for another {left}."


class Bans:
    """IP bans: {ip: {"until": ms or None for permanent, "names": [...], "at": ms}}, saved to bans.json."""

    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.bans = {}

    def load(self):
        try:
            with open(self.path, encoding="utf8") as f:
                data = json.load(f)
            self.bans = {ip: b for ip, b in data.items() if isinstance(b, dict)}
        except FileNotFoundError:
            self.bans = {}
        except (OSError, ValueError) as e:
            print(f"Could not read {self.path}: {e}; starting with no bans.", flush=True)
            self.bans = {}

    def _save(self):  # call with lock held
        tmp = self.path + ".part"
        with open(tmp, "w", encoding="utf8") as f:
            json.dump(self.bans, f, indent=1)
        os.replace(tmp, self.path)

    def _purge(self):  # call with lock held; drops expired bans
        now = time.time() * 1000
        expired = [ip for ip, b in self.bans.items() if b.get("until") and b["until"] <= now]
        for ip in expired:
            del self.bans[ip]
        if expired:
            self._save()

    def active(self, ip):
        with self.lock:
            self._purge()
            return self.bans.get(ip)

    def add(self, ip, hours, name):
        with self.lock:
            now = time.time() * 1000
            b = self.bans.get(ip) or {"names": []}
            b["at"] = int(now)
            b["until"] = int(now + hours * 3600 * 1000) if hours else None
            if name not in b["names"]:
                b["names"] = (b["names"] + [name])[-10:]
            self.bans[ip] = b
            self._save()
            return dict(b)

    def remove(self, ip):
        if not isinstance(ip, str):
            return 404, {"error": "That address isn't banned."}
        with self.lock:
            if self.bans.pop(ip, None) is None:
                return 404, {"error": "That address isn't banned."}
            self._save()
        return 200, {"ok": True}

    def list(self):
        with self.lock:
            self._purge()
            return sorted(({"ip": ip, **b} for ip, b in self.bans.items()), key=lambda b: -b.get("at", 0))


class RateLimiter:
    """Token buckets per (address, kind); see RATE_LIMITS."""

    def __init__(self):
        self.lock = threading.Lock()
        self.buckets = {}  # (ip, kind) -> [tokens, last time]

    def allow(self, ip, kind):
        rate, burst = RATE_LIMITS[kind]
        now = time.time()
        with self.lock:
            if len(self.buckets) > 50_000:  # forget idle addresses
                self.buckets = {k: b for k, b in self.buckets.items() if now - b[1] < 600}
            b = self.buckets.get((ip, kind))
            if b is None:
                b = self.buckets[(ip, kind)] = [burst, now]
            b[0] = min(burst, b[0] + (now - b[1]) * rate)
            b[1] = now
            if b[0] < 1:
                return False
            b[0] -= 1
            return True


def _digest(s):
    return hashlib.sha256(s.encode("utf8", "surrogatepass")).digest()


def audit(msg):
    """One line in the console for everything that happens in the admin view."""
    print(time.strftime("%Y-%m-%d %H:%M:%S"), "[admin]", msg, flush=True)


class Admin:
    """Password check for the admin view. A correct password gets a session token, kept in memory only, tied to
    the address that signed in, ending after ADMIN_IDLE_SECONDS unused or ADMIN_SESSION_SECONDS in all. Wrong
    passwords lock out the address after ADMIN_MAX_FAILURES, and pause sign-in for everyone after
    ADMIN_GLOBAL_MAX_FAILURES from all addresses together."""

    def __init__(self):
        self.digest = _digest(secrets.token_urlsafe(32))
        self.lock = threading.Lock()
        self.sessions = {}   # token -> {"until", "seen", "key"}
        self.failures = {}   # address -> [count, first failure time, locked until]
        self.recent = collections.deque()  # times of wrong passwords from anywhere

    def set_password(self, password):
        self.digest = _digest(password)  # only the hash is kept

    def login(self, addr, password):
        now = time.time()
        key = addr_key(addr)
        with self.lock:
            if len(self.failures) > 10_000:  # forget old failures
                self.failures = {a: f for a, f in self.failures.items() if now - f[1] < ADMIN_LOCKOUT_SECONDS or f[2] > now}
            while self.recent and now - self.recent[0] > ADMIN_GLOBAL_WINDOW:
                self.recent.popleft()
            f = self.failures.get(key)
            if f and f[2] > now:
                return 429, {"error": f"Too many wrong passwords. Try again in {int(f[2] - now) // 60 + 1} min."}
            if len(self.recent) >= ADMIN_GLOBAL_MAX_FAILURES:
                wait = int(ADMIN_GLOBAL_WINDOW - (now - self.recent[0])) // 60 + 1
                return 429, {"error": f"Admin sign-in is paused after many wrong passwords. Try again in {wait} min."}
            # Both sides hashed first, so the comparison takes the same time whatever the password's length.
            ok = isinstance(password, str) and len(password) <= 1000 and secrets.compare_digest(_digest(password), self.digest)
            if not ok:
                if not f or now - f[1] > ADMIN_LOCKOUT_SECONDS:
                    f = [0, now, 0]
                f[0] += 1
                self.recent.append(now)
                if f[0] >= ADMIN_MAX_FAILURES:
                    f[2] = now + ADMIN_LOCKOUT_SECONDS
                    audit(f"{addr} locked out for {ADMIN_LOCKOUT_SECONDS // 60} min after {f[0]} wrong passwords")
                else:
                    audit(f"wrong password from {addr}")
                if len(self.recent) == ADMIN_GLOBAL_MAX_FAILURES:
                    audit(f"sign-in paused for everyone: {len(self.recent)} wrong passwords in {ADMIN_GLOBAL_WINDOW // 60} min")
                self.failures[key] = f
                return 401, {"error": "Wrong password."}
            self.failures.pop(key, None)
            self.sessions = {t: s for t, s in self.sessions.items() if self._live(s, now)}
            while len(self.sessions) >= ADMIN_MAX_SESSIONS:  # the oldest sign-in makes way
                self.sessions.pop(min(self.sessions, key=lambda t: self.sessions[t]["seen"]))
            token = secrets.token_urlsafe(32)
            self.sessions[token] = {"until": now + ADMIN_SESSION_SECONDS, "seen": now, "key": key}
            audit(f"signed in from {addr}")
            return 200, {"token": token}

    @staticmethod
    def _live(s, now):
        return now < s["until"] and now - s["seen"] < ADMIN_IDLE_SECONDS

    def check(self, token, addr):
        """True if token is a live session from this address; using it keeps it alive."""
        if not isinstance(token, str) or not token:
            return False
        now = time.time()
        with self.lock:
            s = self.sessions.get(token)
            if not s or not self._live(s, now):
                self.sessions.pop(token, None)
                return False
            if s["key"] != addr_key(addr):  # a token copied to another address is useless there
                return False
            s["seen"] = now
            return True

    def logout(self, token):
        with self.lock:
            if isinstance(token, str) and self.sessions.pop(token, None):
                audit("signed out")
        return 200, {"ok": True}


HUB = Hub()
ADMIN = Admin()
BANS = Bans(BANS_FILE)
LIMITS = RateLimiter()
_missing_tiles = set()
_tile_fetches = threading.BoundedSemaphore(MAX_TILE_FETCHES)

# Sent with every response. The page runs only its own scripts (no inline ones), talks only to this server,
# and can't be framed by another site.
SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                               "img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; "
                               "form-action 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "EveronFieldMap"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    timeout = SOCKET_TIMEOUT  # a silent or half-sent request is dropped instead of holding a thread forever

    def end_headers(self):
        for k, v in SECURITY_HEADERS.items():
            self.send_header(k, v)
        super().end_headers()

    def limited(self, kind):
        """True (and a 429 sent) when this address is over its rate for this kind of request."""
        if LIMITS.allow(addr_key(self.client_ip()), kind):
            return False
        self.send_json(429, {"error": "Slow down a little - too many requests."})
        return True

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionError, TimeoutError, socket.timeout):
            self.close_connection = True
        except Exception as e:  # never show a traceback to the browser; keep one line in the console
            print(f"Error handling {getattr(self, 'command', '?')} {getattr(self, 'path', '?')}: {e!r}", flush=True)
            self.close_connection = True
            try:
                self.send_json(500, {"error": "Server error."})
            except OSError:
                pass

    def log_message(self, fmt, *args):  # keep the console quiet except for errors
        pass

    # --- responses ---------------------------------------------------------
    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_bytes(self, code, body, ctype, cache="no-cache"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = -1
        if n <= 0 or n > MAX_BODY_BYTES:
            self.close_connection = True  # the unread body would otherwise be taken for the next request
            return None
        try:
            # NaN and Infinity aren't JSON; a browser receiving one in an event couldn't read the room any more.
            return json.loads(self.rfile.read(n), parse_constant=_reject_constant)
        except (ValueError, UnicodeDecodeError, RecursionError):
            return None

    def client_ip(self):
        peer = self.client_address[0]
        # Only a proxy on this machine or the private network may say who the player is; anyone reaching the
        # server directly could otherwise claim any address. The proxy appends the address it saw to whatever the
        # browser sent, so only the last entry is trustworthy; the first is whatever the player wants.
        if TRUST_PROXY and _is_private(peer):
            fwd = (self.headers.get("X-Forwarded-For") or "").split(",")[-1].strip()
            try:
                return str(ipaddress.ip_address(fwd))
            except ValueError:
                pass
        return peer

    def admin_allowed(self):
        if ADMIN_ALLOW is None:
            return True
        try:
            ip = ipaddress.ip_address(self.client_ip())
        except ValueError:
            return False
        ip = ip.ipv4_mapped or ip if ip.version == 6 else ip
        return any(ip in net for net in ADMIN_ALLOW)

    def bearer(self):
        auth = self.headers.get("Authorization") or ""
        return auth[7:] if auth.startswith("Bearer ") else ""

    # --- routing -----------------------------------------------------------
    def do_GET(self):
        url = urlparse(self.path)
        path = url.path
        if path == "/api/events":
            return self.events(parse_qs(url.query))
        if path in ADMIN_PAGES or path.startswith("/api/admin/"):
            if not self.admin_allowed():  # outside --admin-allow the admin view doesn't exist
                return self.send_bytes(404, b"Not found", "text/plain")
        if path == "/api/admin/rooms":
            if self.limited("post"):
                return
            if not ADMIN.check(self.bearer(), self.client_ip()):
                return self.send_json(401, {"error": "Please sign in again."})
            return self.send_json(200, {**HUB.admin_snapshot(), "you": addr_key(self.client_ip())})
        if path == "/admin":
            path = "/admin.html"
        m = re.match(r"^/tiles/([0-5])/(\d{1,3})/(\d{1,3})\.jpg$", path)
        if m:
            if self.limited("tile"):
                return
            return self.tile(*m.groups())
        if self.limited("static"):
            return
        return self.static(path)

    def do_POST(self):
        path = urlparse(self.path).path
        if self.limited("post"):
            self.close_connection = True
            return
        body = self.read_json()
        if body is None or not isinstance(body, dict):
            return self.send_json(400, {"error": "Bad request."})
        if path.startswith("/api/admin/"):
            if not self.admin_allowed():
                return self.send_bytes(404, b"Not found", "text/plain")
            return self.admin_post(path, body)
        if path == "/api/join":
            if self.limited("join"):
                return
            return self.send_json(*HUB.join(body.get("name"), body.get("room"), self.client_ip()))
        pid, token = body.get("id"), body.get("token")
        if path == "/api/item":
            return self.send_json(*HUB.upsert(pid, token, body.get("item")))
        if path == "/api/air-status":
            return self.send_json(*HUB.set_air_status(pid, token, body.get("owner"), body.get("itemId"), body.get("status")))
        if path == "/api/delete":
            return self.send_json(*HUB.delete(pid, token, body.get("itemId")))
        if path == "/api/mortar-target":
            return self.send_json(*HUB.move_mortar_target(pid, token, body.get("owner"), body.get("itemId"), body.get("idx"), body.get("xz")))
        if path == "/api/clear-fire":
            return self.send_json(*HUB.clear_fire(pid, token, body.get("owner"), body.get("itemId")))
        if path == "/api/briefing":
            return self.send_json(*HUB.set_briefing(pid, token, body.get("text")))
        if path == "/api/clock":
            return self.send_json(*HUB.set_clock(pid, token, body.get("clock")))
        if path == "/api/leave":
            return self.send_json(*HUB.leave(pid, token))
        self.send_json(404, {"error": "Not found."})

    def admin_post(self, path, body):
        ip = self.client_ip()
        if path == "/api/admin/login":
            return self.send_json(*ADMIN.login(ip, body.get("password")))
        if path == "/api/admin/logout":
            return self.send_json(*ADMIN.logout(self.bearer()))
        if not ADMIN.check(self.bearer(), ip):
            return self.send_json(401, {"error": "Please sign in again."})
        if path == "/api/admin/kick":
            code, res = HUB.kick(body.get("player"))
            if code == 200:
                audit(f"{ip} kicked {res['name']}")
        elif path == "/api/admin/ban":
            code, res = HUB.ban(body.get("player"), body.get("hours"))
            if code == 200:
                length = f"{body['hours']} h" if body.get("hours") else "permanently"
                audit(f"{ip} banned {res['name']} ({res['ip']}) {length}; removed {', '.join(res['removed'])}")
        elif path == "/api/admin/unban":
            code, res = BANS.remove(body.get("ip"))
            if code == 200:
                audit(f"{ip} lifted the ban on {body['ip']}")
        elif path == "/api/admin/close-room":
            code, res = HUB.close_room(body.get("room"))
            if code == 200:
                audit(f"{ip} closed room {body['room']} ({res['removed']} removed)")
        else:
            code, res = 404, {"error": "Not found."}
        return self.send_json(code, res)

    # --- handlers ----------------------------------------------------------
    def static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        full = os.path.normpath(os.path.join(STATIC, path.lstrip("/")))
        if not full.startswith(STATIC + os.sep) or not os.path.isfile(full):
            return self.send_bytes(404, b"Not found", "text/plain")
        with open(full, "rb") as f:
            body = f.read()
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        # Map data changes only when it is re-baked (tile URLs carry a version), so browsers keep it for a week.
        cache = "no-store" if path in ADMIN_PAGES else "public, max-age=604800" if path.startswith("/data/") else "no-cache"
        self.send_bytes(200, body, ctype, cache)

    def tile(self, z, x, y):
        n = 2 ** (7 - int(z))  # tiles per side at this zoom
        if int(x) >= n or int(y) >= n:
            return self.send_bytes(404, b"", "image/jpeg")
        z, x, y = str(int(z)), str(int(x)), str(int(y))  # one spelling per tile ("007" is "7")
        key = (z, x, y)
        path = os.path.join(TILE_CACHE, z, x, f"{y}.jpg")
        if os.path.isfile(path):
            with open(path, "rb") as f:
                return self.send_bytes(200, f.read(), "image/jpeg", "public, max-age=604800")
        if key in _missing_tiles:
            return self.send_bytes(404, b"", "image/jpeg")
        req = urllib.request.Request(TILE_UPSTREAM.format(z=z, x=x, y=y),
                                     headers={"User-Agent": "EveronFieldMap/1.0 (personal tile cache)"})
        if not _tile_fetches.acquire(timeout=20):
            return self.send_bytes(503, b"", "image/jpeg")
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                data = r.read(5_000_000)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                _missing_tiles.add(key)
            return self.send_bytes(404, b"", "image/jpeg")
        except (urllib.error.URLError, TimeoutError, OSError):
            return self.send_bytes(502, b"", "image/jpeg")
        finally:
            _tile_fetches.release()
        if not data.startswith(b"\xff\xd8"):  # only ever cache JPEGs
            return self.send_bytes(502, b"", "image/jpeg")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".part"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
        self.send_bytes(200, data, "image/jpeg", "public, max-age=604800")

    def events(self, qs):
        if self.limited("post"):
            return
        p, q = HUB.open_stream((qs.get("id") or [""])[0], (qs.get("token") or [""])[0])
        if not p:
            return self.send_json(401, {"error": "Unknown session."})
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        sock = self.connection
        idle = 0.0
        try:
            while True:
                try:
                    msg = q.get(timeout=1)
                except queue.Empty:
                    if peer_closed(sock):
                        break
                    idle += 1
                    if idle >= KEEPALIVE_SECONDS:
                        idle = 0
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
                    continue
                if isinstance(msg, tuple) and msg[0] == "drop":  # fell too far behind: close, the browser reconnects
                    break
                if isinstance(msg, tuple):  # ("bye", reason): the player was removed
                    reason = json.dumps({"reason": msg[1]})
                    self.wfile.write(f"event: bye\ndata: {reason}\n\n".encode())
                    self.wfile.flush()
                    break
                self.wfile.write(f"data: {msg}\n\n".encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        finally:
            HUB.close_stream(p, q)


ADMIN_PAGES = {"/admin", "/admin.html", "/admin.js"}


def _is_private(ip):
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    a = a.ipv4_mapped or a if a.version == 6 else a
    return a.is_loopback or a.is_private


def addr_key(ip):
    """What bans, rate limits and lockouts count by: the address, or for IPv6 its /64, since one home or
    phone gets a whole /64 and can pick any address in it."""
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return str(ip)
    if a.version == 6:
        if a.ipv4_mapped:
            return str(a.ipv4_mapped)
        return str(ipaddress.ip_network(f"{a}/64", strict=False))
    return str(a)


def _reject_constant(name):
    raise ValueError(f"{name} is not allowed")


class Server(ThreadingHTTPServer):
    """A thread per connection, up to MAX_CONNECTIONS; past that new connections are closed straight away."""
    daemon_threads = True
    request_queue_size = 128

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.slots = threading.BoundedSemaphore(MAX_CONNECTIONS)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


def main():
    ap = argparse.ArgumentParser(description="Everon Field Map server")
    ap.add_argument("--host", default="127.0.0.1", help="use 0.0.0.0 to let others on your network connect")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--admin-password", default=os.environ.get("EVERON_ADMIN_PASSWORD", ""),
                    help="password for the admin view at /admin (default: $EVERON_ADMIN_PASSWORD, else a random one)")
    ap.add_argument("--behind-proxy", action="store_true",
                    help="read players' addresses from X-Forwarded-For (only when a reverse proxy sets it)")
    ap.add_argument("--admin-allow", default=os.environ.get("EVERON_ADMIN_ALLOW", ""),
                    help="comma-separated addresses or networks allowed to use the admin view, e.g. 127.0.0.1,203.0.113.7 "
                         "(default: $EVERON_ADMIN_ALLOW, else anywhere)")
    args = ap.parse_args()
    global TRUST_PROXY, ADMIN_ALLOW
    TRUST_PROXY = args.behind_proxy
    if args.admin_allow.strip():
        try:
            ADMIN_ALLOW = [ipaddress.ip_network(n.strip(), strict=False) for n in args.admin_allow.split(",") if n.strip()]
        except ValueError as e:
            sys.exit(f"--admin-allow: {e}")
    if args.admin_password and len(args.admin_password) < ADMIN_MIN_PASSWORD:
        sys.exit(f"The admin password must be at least {ADMIN_MIN_PASSWORD} characters. Leave it out to get a random one.")
    password = args.admin_password or secrets.token_urlsafe(12)
    ADMIN.set_password(password)
    BANS.load()
    threading.Thread(target=HUB.reap, daemon=True).start()
    srv = Server((args.host, args.port), Handler)
    shown = "localhost" if args.host in ("127.0.0.1", "0.0.0.0") else args.host
    print(f"Everon Field Map running at http://{shown}:{args.port}/  (Ctrl+C to stop)", flush=True)
    where = f"  (only from {args.admin_allow})" if ADMIN_ALLOW else ""
    if args.admin_password:
        print(f"Admin view: http://{shown}:{args.port}/admin  (password from --admin-password / EVERON_ADMIN_PASSWORD){where}", flush=True)
    else:
        print(f"Admin view: http://{shown}:{args.port}/admin  password for this run: {password}{where}", flush=True)
    del password
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

"""Arma Reforger Maps - local server.

Serves the web app (the field map at / and /map, the 3D view at /3d/, both reading the same map data under /data/),
caches map tiles on disk, and relays shared markings between connected players in the same room. Nothing about players is stored:
a player's markings exist only while their browser tab is connected, and a
room (with its briefing) disappears when its last player leaves. (The page keeps a copy of
the player's own markings in their browser and uploads them again when they rejoin.)

The exception is a room someone has switched to "keep the plan" (/api/keep): there markings stay when their owners
leave, the room outlives its last player, and it is saved to rooms.json next to this file, so a squad can plan one
day and play the next, even across a restart. Rejoining under the same name gets your markings back. A kept room
is forgotten after KEEP_HOURS without a visit, when the switch is turned off, or when the admin closes it.

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
import gzip
import json
import math
import mimetypes
import os
import queue
import re
import secrets
import select
import shutil
import socket
import sys
import threading
import tempfile
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")
BANS_FILE = os.path.join(ROOT, "bans.json")
# Rooms someone switched to "keep the plan": their markings, briefing and clock stay after everyone leaves, saved here
# so they also survive a restart, until nobody has visited for KEEP_HOURS.
ROOMS_FILE = os.path.join(ROOT, "rooms.json")
KEEP_HOURS = 24
SAVE_SECONDS = 5               # how often changes to kept rooms are written to ROOMS_FILE
TRUST_PROXY = False  # set by --behind-proxy
TRUSTED_PROXIES = [ipaddress.ip_network("127.0.0.1/32"), ipaddress.ip_network("::1/128")]
ADMIN_ALLOW = None   # set by --admin-allow: networks the admin view answers to (None = everywhere)
# The maps a room can be opened on: every static/data/maps/<map>/ folder with a map.json (see load_maps). A new map
# needs only its folder, as reforger-map-tools' `rmt.py fieldmap` installs it.
MAPS_DIR = os.path.join(STATIC, "data", "maps")
MAP_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
GZIP_TYPES = {"text/html", "text/css", "application/javascript", "application/json"}
COMPRESSED_CACHE = os.path.join(ROOT, "compressed_cache")
_gzip_cache = collections.OrderedDict()  # metadata only; compressed bodies live on disk
_gzip_lock = threading.Lock()
MAX_GZIP_ENTRIES = 128
FILE_CHUNK_BYTES = 64 * 1024

GRACE_SECONDS = 15          # how long a dropped connection may reconnect before its markings vanish
KEEPALIVE_SECONDS = 5
MAX_ITEMS_PER_PLAYER = 500
MAX_ITEM_BYTES = 20_000
MAX_PLAYER_BYTES = 500_000     # serialized markings; parsed objects use more RAM
MAX_ROOM_BYTES = 2_000_000
MAX_STATE_BYTES = 16_000_000   # all rooms' serialized markings together
MAX_BODY_BYTES = 100_000
MAX_PLAYERS = 1000             # on the whole server
MAX_ROOM_PLAYERS = 60
MAX_ROOM_OBSERVERS = 20       # read-only viewers have separate room capacity
MAX_ROOMS = 128                # includes empty kept rooms and their settings
MAX_KEPT_ROOMS = 64
MAX_ROOMS_FILE_BYTES = 24_000_000  # bound parsing before loading saved plans
MAX_PLAYERS_PER_IP = 12        # a LAN party or a household behind one address still fits
MAX_CONNECTIONS = 600          # open sockets (each event stream holds one)
MAX_QUEUED_EVENTS = 1000
MAX_QUEUED_BYTES = 256 * 1024   # slow streams reconnect instead of retaining large update backlogs
MAX_STREAMS_PER_PLAYER = 2
_snapshot_slots = threading.BoundedSemaphore(2)  # bound simultaneous initial snapshot writes
SOCKET_TIMEOUT = 60            # seconds a connection may sit silent mid-request
MAX_TILE_FETCHES = 6           # upstream tile downloads at once
# Requests per address: a bucket of `burst` that refills at `rate` per second.
RATE_LIMITS = {"post": (20, 120), "join": (0.2, 10), "tile": (60, 600), "data": (60, 600), "static": (20, 200)}
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
              "arrow", "ambush", "post", "sectors", "overwatch", "hulldown", "aa", "control", "audible"}
HEARD_GUNS = {"rifle", "rifle-s", "mg", "hmg", "launcher", "gl", "pistol", "mortar"}
AIR_STATUSES = {"requested", "ack", "enroute", "done"}
MORTAR_WEAPONS = {"M252", "2B14"}
MAX_MORTAR_TARGETS = 30
COLORS = ["#ff6b6b", "#4dabf7", "#51cf66", "#fcc419", "#cc5de8", "#ff922b",
          "#22b8cf", "#f06595", "#94d82d", "#845ef7", "#20c997", "#e8590c"]

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/json", ".json")


class Snapshot:
    """Share the room body; only the tiny clock/session suffix differs per stream."""
    def __init__(self, body, name):
        self.body = body
        self.tail = (',"you":' + json.dumps(name) + ',"now":' + str(int(time.time() * 1000)) + '}').encode()


class EventQueue(queue.Queue):
    """Bound updates by bytes; the initial, shared room snapshot is tracked separately."""
    def __init__(self, snapshot):
        self.bytes = 0
        self.closed = False
        self.snapshot = snapshot
        super().__init__(MAX_QUEUED_EVENTS)
        with self.mutex:
            self.queue.append(snapshot)

    def _put(self, item):
        size = len(item) if isinstance(item, str) else 0  # serialized JSON is ASCII
        if self.closed or self.bytes + size > MAX_QUEUED_BYTES:
            raise queue.Full
        self.bytes += size
        super()._put(item)

    def _get(self):
        item = super()._get()
        if isinstance(item, str):
            self.bytes -= len(item)
        if item is self.snapshot:
            self.snapshot = None
        return item

    def replace(self, control):
        with self.not_empty:
            self.queue.clear()
            self.snapshot = None
            self.bytes = 0
            self.closed = True
            self.queue.append(control)
            self.not_empty.notify()


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
        self.observer = False
        self.queues = set()          # open event streams
        self.gone_since = time.time()  # not yet connected

    def public(self):
        return {"name": self.name, "color": self.color, "items": list(self.items.values())}


class Away:
    """The markings of someone who has left a kept room, waiting for someone using their name to come back."""
    def __init__(self, name, color, items, item_bytes):
        self.name = name
        self.color = color
        self.items = items
        self.item_bytes = item_bytes

    def public(self):
        return {"name": self.name, "color": self.color, "items": list(self.items.values()), "away": True}


class Hub:
    def __init__(self):
        self.lock = threading.Lock()
        self.players = {}  # id -> Player
        self.rooms = {}    # room code -> {"briefing": {"text", "by", "at"} or None}
        self.snapshots = {}  # room -> shared JSON bytes, invalidated by room changes
        self.dirty = False   # a kept room changed since ROOMS_FILE was last written
        self.save_lock = threading.Lock()

    # --- helpers (call with lock held) -------------------------------------
    def _in_room(self, room, observers=False):
        return [p for p in self.players.values() if p.room == room and (observers or not p.observer)]

    def _away(self, room=None):
        """Owners who left kept rooms (one room, or all of them)."""
        infos = [self.rooms.get(room, {})] if room is not None else self.rooms.values()
        return [a for info in infos for a in info.get("away", {}).values()]

    def _owner(self, room, name):
        """Whoever owns markings in the room under this name: a player there now, or one who left a kept room."""
        o = next((q for q in self.players.values() if q.room == room and q.name == name and not q.observer), None)
        if o is None and isinstance(name, str):
            a = self.rooms.get(room, {}).get("away", {}).get(name.lower())
            o = a if a and a.name == name else None
        return o

    def _broadcast(self, room, event, skip=None):
        self.snapshots.pop(room, None)
        if self.rooms.get(room, {}).get("keep"):
            self.dirty = True
        data = json.dumps(event, separators=(",", ":"), allow_nan=False)
        for p in self._in_room(room, observers=True):
            if p is skip:
                continue
            for q in p.queues:
                try:
                    q.put_nowait(data)
                except queue.Full:
                    if isinstance(q, EventQueue):
                        q.replace(("drop", ""))
                    else:
                        with q.mutex:
                            q.queue.clear()
                        q.put_nowait(("drop", ""))

    def _auth(self, pid, token, write=True):
        if not isinstance(pid, str) or not isinstance(token, str) or not re.fullmatch(r"[0-9a-f]{32}", token):
            return None
        p = self.players.get(pid)
        if not p or (write and p.observer) or not secrets.compare_digest(p.token.encode(), token.encode()):
            return None
        return p

    def _remove(self, p, reason="", keep=True):
        """Take a player out of their room. In a kept room their markings stay behind (unless keep is False: a ban)."""
        if self.players.pop(p.id, None):
            for q in p.queues:
                if isinstance(q, EventQueue):
                    q.replace(("bye", reason))
                    continue
                try:
                    q.put_nowait(("bye", reason))
                except queue.Full:
                    # A stalled stream must not hold the room lock. Discard its
                    # stale events so removal is the next message it receives.
                    while True:
                        try:
                            q.get_nowait()
                        except queue.Empty:
                            break
                    q.put_nowait(("bye", reason))
            info = self.rooms.get(p.room)
            kept = bool(keep and info and info.get("keep") and p.items)
            if kept:
                info.setdefault("away", {})[p.name.lower()] = Away(p.name, p.color, p.items, p.item_bytes)
            if not p.observer:
                self._broadcast(p.room, {"type": "leave", "name": p.name, **({"kept": True} if kept else {})})
            if not self._in_room(p.room, observers=True):
                if info and info.get("keep"):
                    info["seen"] = time.time()  # kept rooms wait KEEP_HOURS from here
                else:
                    self.rooms.pop(p.room, None)  # last one out: forget the room and its briefing

    # --- API ---------------------------------------------------------------
    def join(self, name, room, ip, map_id=None, observer=False):
        ban = BANS.active(addr_key(ip))
        if ban:
            return 403, {"error": ban_message(ban)}
        name = (name if isinstance(name, str) else "").strip()
        room = (room if isinstance(room, str) else "").strip().lower()
        if not USERNAME_RE.match(name):
            return 400, {"error": "Use 1-20 letters, numbers, spaces, - _ . [ ]"}
        if not ROOM_RE.match(room):
            return 400, {"error": "Room codes are 3-32 letters, numbers, - or _."}
        if map_id is None:
            map_id = default_map()
        if not isinstance(map_id, str) or map_id not in load_maps():
            return 400, {"error": "Unknown map."}
        with self.lock:
            # Banning holds this same lock: a join that passed the earlier check cannot slip past its sweep.
            ban = BANS.active(addr_key(ip))
            if ban:
                return 403, {"error": ban_message(ban)}
            if not isinstance(observer, bool):
                return 400, {"error": "Bad observer setting."}
            others = self._in_room(room)
            info = self.rooms.get(room)
            if info is None and len(self.rooms) >= MAX_ROOMS:
                return 503, {"error": "The map server's room storage is full. Try again later."}
            # The map belongs to the room: whoever opens it picks, everyone who joins later gets the same one (a kept
            # room keeps it while empty too, unless that map has since been removed).
            if info and (self._in_room(room, observers=True) or info.get("keep")):
                map_id = info.get("map") if info.get("map") in load_maps() else default_map()
            if len(self.players) >= MAX_PLAYERS:
                return 503, {"error": "The map server is full right now. Try again later."}
            if not observer and len(others) >= MAX_ROOM_PLAYERS:
                return 403, {"error": f"This room is full ({MAX_ROOM_PLAYERS} players)."}
            if sum(1 for p in self.players.values() if p.key == addr_key(ip)) >= MAX_PLAYERS_PER_IP:
                return 429, {"error": "Too many players from your address are on the map already."}
            if observer and sum(p.observer for p in self._in_room(room, observers=True)) >= MAX_ROOM_OBSERVERS:
                return 403, {"error": "This room's viewer slots are full."}
            if not observer and any(p.name.lower() == name.lower() for p in others):
                return 409, {"error": "That username is in use in this room right now. Pick another."}
            away_names = info.get("away", {}) if info else {}
            if not observer and name.lower() not in away_names and len(others) + len(away_names) >= MAX_ROOM_PLAYERS:
                return 403, {"error": "This room's player and saved-owner slots are full. Rejoin with an existing name or use another room."}
            used = {p.color for p in others}
            # Back in a kept room under the same name: your markings (and colour, if still free) are waiting.
            away = info.get("away", {}).pop(name.lower(), None) if info and not observer else None
            color = away.color if away and away.color not in used else \
                next((c for c in COLORS if c not in used), COLORS[len(others) % len(COLORS)])
            p = Player(name, color, room, ip)
            p.observer = observer
            if away:
                p.items, p.item_bytes = away.items, away.item_bytes
                if away.name != name:  # same name, other capitals: the old entry goes
                    self._broadcast(room, {"type": "leave", "name": away.name})
            self.players[p.id] = p
            self.rooms.setdefault(room, {"briefing": None, "created": time.time(), "map": map_id})
            if not observer:
                self._broadcast(room, {"type": "join", "player": p.public()}, skip=p)
        return 200, {"id": p.id, "token": p.token, "name": p.name, "color": p.color, "room": room, "map": map_id}

    def open_stream(self, pid, token):
        with self.lock:
            p = self._auth(pid, token, write=False)
            if not p or len(p.queues) >= MAX_STREAMS_PER_PLAYER:
                return None, None
            body = self.snapshots.get(p.room)
            if body is None:
                info = self.rooms.get(p.room, {})
                snapshot = {"type": "snapshot", "room": p.room, "map": info.get("map") or default_map(),
                            # players here now, then (in a kept room) the markings of those who left, marked "away"
                            "players": [o.public() for o in self._in_room(p.room)] + [a.public() for a in self._away(p.room)],
                            "briefing": info.get("briefing"),
                            "clock": info.get("clock"),
                            "wind": info.get("wind"),
                            "keep": bool(info.get("keep"))}
                body = json.dumps(snapshot, separators=(",", ":"), allow_nan=False)[:-1].encode()
                self.snapshots[p.room] = body
            q = EventQueue(Snapshot(body, p.name))
            p.queues.add(q)
            p.gone_since = None
            return p, q

    def close_stream(self, p, q):
        with self.lock:
            p.queues.discard(q)
            if not p.queues and p.id in self.players:
                p.gone_since = time.time()
            if isinstance(q, EventQueue):
                q.replace(("drop", ""))

    def _size_error(self, p, item_id, size):
        if size > MAX_ITEM_BYTES:
            return "Item too large."
        delta = size - p.item_bytes.get(item_id, 0)
        if sum(p.item_bytes.values()) + delta > MAX_PLAYER_BYTES:
            return "Your markings are too big altogether. Delete some first."
        room = p.room if isinstance(p, Player) else next((c for c, i in self.rooms.items() if p in i.get("away", {}).values()), None)
        if sum(sum(o.item_bytes.values()) for o in self._in_room(room) + self._away(room)) + delta > MAX_ROOM_BYTES:
            return "This room's markings are too big altogether. Delete some first."
        if sum(sum(o.item_bytes.values()) for o in list(self.players.values()) + self._away()) + delta > MAX_STATE_BYTES:
            return "The map server's marking storage is full. Delete some markings or try later."
        return None

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
            size = len(json.dumps(item, allow_nan=False))
            err = self._size_error(p, item["id"], size)
            if err:
                return 400, {"error": err}
            p.items[item["id"]] = item
            p.item_bytes[item["id"]] = size
            self._broadcast(p.room, {"type": "item", "owner": p.name, "item": item})
        return 200, {"ok": True}

    def set_air_status(self, pid, token, owner, item_id, status):
        if not isinstance(status, str) or status not in AIR_STATUSES or not isinstance(owner, str) or not isinstance(item_id, str):
            return 400, {"error": "Bad request status."}
        with self.lock:
            p = self._auth(pid, token)
            if not p:
                return 401, {"error": "Session expired. Reload the page."}
            o = self._owner(p.room, owner)
            it = o.items.get(item_id) if o else None
            is_request = it and ((it.get("type") == "marker" and str(it.get("icon", "")).startswith("air-"))
                                 or (it.get("type") == "area" and it.get("kind") == "cas"))
            if not is_request:
                return 404, {"error": "That request has gone."}
            it = {**it, "status": status, "statusBy": p.name}
            size = len(json.dumps(it, allow_nan=False))
            err = self._size_error(o, item_id, size)
            if err:
                return 400, {"error": err}
            o.items[item_id] = it
            o.item_bytes[item_id] = size
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
            o = self._owner(p.room, owner)
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
            o = self._owner(p.room, owner)
            it = o.items.get(item_id) if o else None
            if not it or it.get("type") != "mortar" or not 0 <= idx < len(it.get("targets", [])):
                return 404, {"error": "That target has gone."}
            targets = list(it["targets"])
            targets[idx] = xz
            it = {**it, "targets": targets}
            size = len(json.dumps(it, allow_nan=False))
            err = self._size_error(o, item_id, size)
            if err:
                return 400, {"error": err}
            o.items[item_id] = it
            o.item_bytes[item_id] = size
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
        if not _is_clock(clock):
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

    def set_wind(self, pid, token, wind):
        """The room's wind, as the in-game map shows it: speed (m/s, 0 for still air) and the direction it blows from
        (degrees). One per room, like the clock: the field map, the mortar page and the shot planner all read it."""
        if wind is None or not _is_wind(wind):
            return 400, {"error": "Bad wind."}
        with self.lock:
            p = self._auth(pid, token)
            if not p:
                return 401, {"error": "Session expired. Reload the page."}
            w = {"s": round(float(wind["s"]), 1), "d": round(float(wind["d"]) % 360, 1), "at": int(time.time() * 1000), "by": p.name}
            self.rooms.setdefault(p.room, {})["wind"] = w
            self._broadcast(p.room, {"type": "wind", "wind": w})
        return 200, {"ok": True}

    def set_keep(self, pid, token, keep):
        """Anyone in the room can switch "keep the plan" on (markings stay when their owners leave, and the room is
        saved to disk) or off (markings of those who have left go at once, and the room ends with its last player)."""
        if not isinstance(keep, bool):
            return 400, {"error": "Bad request."}
        with self.lock:
            p = self._auth(pid, token)
            if not p:
                return 401, {"error": "Session expired. Reload the page."}
            info = self.rooms.setdefault(p.room, {"briefing": None, "created": time.time(), "map": default_map()})
            if keep and not info.get("keep") and sum(bool(i.get("keep")) for i in self.rooms.values()) >= MAX_KEPT_ROOMS:
                return 503, {"error": "The map server's kept-room storage is full. Turn off keep for another room first."}
            if bool(info.get("keep")) != keep:
                if not keep:
                    for a in info.pop("away", {}).values():
                        self._broadcast(p.room, {"type": "leave", "name": a.name})
                    self.dirty = True  # so the room comes out of ROOMS_FILE
                info["keep"] = keep
                self._broadcast(p.room, {"type": "keep", "keep": keep, "by": p.name})
        return 200, {"ok": True}

    def leave(self, pid, token):
        with self.lock:
            p = self._auth(pid, token, write=False)
            if p:
                self._remove(p)
        return 200, {"ok": True}

    def admin_snapshot(self):
        """Every active room and who is in it, for the admin view."""
        now = time.time()
        with self.lock:
            out = []
            for code, info in self.rooms.items():
                players = sorted(self._in_room(code, observers=True), key=lambda p: p.joined)
                if not players and not info.get("keep"):
                    continue
                b = info.get("briefing")
                out.append({
                    "room": code,
                    "kept": bool(info.get("keep")),
                    "away": len(info.get("away", {})),
                    "map": info.get("map") or default_map(),
                    "created": int(info.get("created", now) * 1000),
                    "briefing": {"by": b["by"], "at": b["at"], "chars": len(b["text"])} if b and b["text"].strip() else None,
                    "players": [{
                        "id": p.id, "ip": p.ip, "key": p.key,
                        "name": p.name + (" (3D viewer)" if p.observer else ""), "color": p.color, "joined": int(p.joined * 1000),
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
            # Everyone on that address goes, whichever room they are in, and so do their markings.
            gone = [o for o in self.players.values() if o.key == p.key]
            for o in gone:
                self._remove(o, ban_message(ban), keep=False)
        return 200, {"ok": True, "removed": [o.name for o in gone], "name": p.name, "ip": p.key}

    def close_room(self, room):
        if not isinstance(room, str):
            return 404, {"error": "That room is already empty."}
        with self.lock:
            players = self._in_room(room, observers=True)
            kept = self.rooms.get(room, {}).get("keep")
            if not players and not kept:
                return 404, {"error": "That room is already empty."}
            for p in players:
                self._remove(p, "The admin closed this room.", keep=False)
            self.rooms.pop(room, None)  # a kept room's plan goes too
            self.snapshots.pop(room, None)
            if kept:
                self.dirty = True
        return 200, {"ok": True, "removed": len(players)}

    def reap(self):
        while True:
            time.sleep(2)
            now = time.time()
            with self.lock:
                for p in list(self.players.values()):
                    if p.gone_since is not None and now - p.gone_since > GRACE_SECONDS:
                        self._remove(p)
                for code, info in list(self.rooms.items()):  # kept rooms nobody has visited for KEEP_HOURS
                    if info.get("keep") and not self._in_room(code, observers=True) and now - info.get("seen", now) > KEEP_HOURS * 3600:
                        self.rooms.pop(code, None)
                        self.snapshots.pop(code, None)
                        self.dirty = True

    # --- kept rooms on disk ------------------------------------------------
    def save(self, force=False):
        # Acquire the disk writer before snapshotting: snapshots cannot reach disk out of order.
        with self.save_lock:
            self._save_rooms(force)

    def _save_rooms(self, force=False):
        """Write every kept room to ROOMS_FILE if anything changed (or force)."""
        with self.lock:
            if not (self.dirty or force):
                return
            self.dirty = False
            now = time.time()
            data = {}
            for code, info in self.rooms.items():
                if not info.get("keep"):
                    continue
                here = self._in_room(code)
                owners = {o.name: {"color": o.color, "items": list(o.items.values())}
                          for o in self._away(code) + here if o.items}
                data[code] = {"map": info.get("map"), "created": info.get("created", now),
                              "seen": now if self._in_room(code, observers=True) else info.get("seen", now),
                              "briefing": info.get("briefing"), "clock": info.get("clock"), "wind": info.get("wind"),
                              "owners": owners}
            text = json.dumps(data, separators=(",", ":"), allow_nan=False)
        try:
            tmp = ROOMS_FILE + ".part"
            with open(tmp, "w", encoding="utf8") as f:
                f.write(text)
            os.replace(tmp, ROOMS_FILE)
        except OSError as e:
            print(f"Could not save kept rooms to {ROOMS_FILE}: {e}", flush=True)
            with self.lock:
                self.dirty = True

    def save_loop(self):
        while True:
            time.sleep(SAVE_SECONDS)
            self.save()

    def load(self):
        """Read kept rooms with the same room, owner and marking budgets as live edits."""
        try:
            with open(ROOMS_FILE, "rb") as f:
                raw = f.read(MAX_ROOMS_FILE_BYTES + 1)
            if len(raw) > MAX_ROOMS_FILE_BYTES:
                raise ValueError("saved room file exceeds the storage limit")
            data = json.loads(raw, parse_constant=_reject_constant, parse_float=_finite_float)
        except FileNotFoundError:
            return
        except (OSError, ValueError, RecursionError) as e:
            print(f"Could not read {ROOMS_FILE}: {e}; starting with no kept rooms.", flush=True)
            return
        num = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and -1e15 <= v <= 1e15
        skipped = 0
        for code, r in (data.items() if isinstance(data, dict) else []):
            if not ROOM_RE.fullmatch(code) or not isinstance(r, dict):
                skipped += 1
                continue
            seen = r.get("seen") if num(r.get("seen")) else time.time()
            if time.time() - seen > KEEP_HOURS * 3600:
                continue
            if len(self.rooms) >= MAX_ROOMS or sum(bool(i.get("keep")) for i in self.rooms.values()) >= MAX_KEPT_ROOMS:
                skipped += 1
                continue
            b = r.get("briefing")
            ok_b = (isinstance(b, dict) and isinstance(b.get("text"), str) and len(b["text"]) <= MAX_BRIEFING_CHARS
                    and isinstance(b.get("by"), str) and len(b["by"]) <= 20 and num(b.get("at")))
            self.rooms[code] = {"keep": True, "map": r.get("map") if isinstance(r.get("map"), str) and MAP_ID_RE.fullmatch(r["map"]) else None,
                                "created": r["created"] if num(r.get("created")) else time.time(), "seen": seen,
                                "briefing": {k: b[k] for k in ("text", "by", "at")} if ok_b else None,
                                "clock": None, "wind": None, "away": {}}
            # Saved settings use the live validators and retain only recognized fields.
            clock = r.get("clock")
            if _is_clock(clock):
                fields = ("game", "rate", "year", "month", "day", "lat")
                self.rooms[code]["clock"] = {k: clock[k] for k in fields}
            wind = r.get("wind")
            if isinstance(wind, dict) and _is_wind({k: wind.get(k) for k in ("s", "d")}):
                self.rooms[code]["wind"] = {k: wind[k] for k in ("s", "d")}
            for key in ("clock", "wind"):
                setting = self.rooms[code][key]
                value = r.get(key)
                if setting is not None:
                    setting["at"] = value["at"] if num(value.get("at")) else int(time.time() * 1000)
                    setting["by"] = value["by"] if isinstance(value.get("by"), str) and len(value["by"]) <= 20 else "saved"
            owners = r.get("owners")
            for name, o in (owners.items() if isinstance(owners, dict) else []):
                if not isinstance(o, dict) or not USERNAME_RE.fullmatch(name):
                    skipped += 1
                    continue
                away = self.rooms[code]["away"]
                if name.lower() in away or len(away) >= MAX_ROOM_PLAYERS:
                    skipped += 1
                    continue
                color = o.get("color") if o.get("color") in COLORS else COLORS[len(away) % len(COLORS)]
                owner = Away(name, color, {}, {})
                away[name.lower()] = owner
                items = o.get("items")
                for it in (items if isinstance(items, list) else []):
                    if validate_item(it) is not None:
                        skipped += 1
                        continue
                    size = len(json.dumps(it, allow_nan=False))
                    if (len(owner.items) >= MAX_ITEMS_PER_PLAYER and it["id"] not in owner.items
                            or self._size_error(owner, it["id"], size)):
                        skipped += 1
                        continue
                    owner.items[it["id"]] = it
                    owner.item_bytes[it["id"]] = size
                if not owner.items:
                    away.pop(name.lower())
        if self.rooms:
            print(f"Kept rooms: {len(self.rooms)} loaded from {os.path.basename(ROOMS_FILE)}", flush=True)
        if skipped:
            print(f"Saved room entries skipped (invalid or over storage limits): {skipped}", flush=True)


def _is_clock(clock):
    if not isinstance(clock, dict):
        return False
    num = lambda k, lo, hi: isinstance(clock.get(k), (int, float)) and not isinstance(clock.get(k), bool) and lo <= clock[k] <= hi
    return (num("game", 0, 86399) and isinstance(clock.get("rate"), (int, float)) and not isinstance(clock["rate"], bool)
            and clock["rate"] in CLOCK_RATES and num("year", 1900, 2200)
            and isinstance(clock.get("month"), int) and not isinstance(clock["month"], bool) and 1 <= clock["month"] <= 12
            and isinstance(clock.get("day"), int) and not isinstance(clock["day"], bool) and 1 <= clock["day"] <= 31 and num("lat", -66, 66))


def _is_point(v):
    return (isinstance(v, list) and len(v) == 2 and all(isinstance(n, (int, float)) and not isinstance(n, bool) for n in v)
            and all(-2000 <= n <= 15000 for n in v))


NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
SHELL_RE = re.compile(r"^[A-Za-z0-9 ._()/+-]{1,40}$")
# Launchers and the rockets they fire, as static/data/rockets.json names them
ROCKET_LAUNCHERS = {"RPG-7": ("PG-7VM", "PG-7VL", "PG-7VR"), "M72A3": ("M72A3",), "RPG-22": ("PG-22",), "RPG-75": ("RPG-75",)}
# Scoped rifles, machine guns and vehicle guns and their rounds, as static/data/bullets.json names them (SCOPES in app.js)
SCOPED_GUNS = {
    "SVD": "7N1 (SVD)", "M21": "M118 (M21)", "M16A2": "M855 (M16A2)", "M16A2 carbine": "M855 (M16A2 carbine)",
    "AK-74N": "7N6 (AK-74)", "AKS-74UN": "7N6 (AKS-74U)", "RPK-74N": "7N6 (RPK-74)", "PKMN": "57N323S (PKM, UK59)",
    "UK59": "57N323S (PKM, UK59)", "NSV": "B32 (NSV)", "BTR-70 KPVT": "BZ (KPVT)", "BTR-70 PKT": "57N323S (PKT)",
    "BRDM-2 KPVT": "BZ (KPVT)", "BRDM-2 PKT": "57N323S (PKT)", "LAV-25 M242 HE": "M792 HEI-T (M242)",
    "LAV-25 M242 AP": "M791 APDS-T (M242)",
}


def _is_wind(wind):
    """Wind read off the in-game map: speed in m/s and the compass direction it blows from (None = still air)."""
    return wind is None or (isinstance(wind, dict) and set(wind) <= {"s", "d"} and all(
        isinstance(wind.get(k), (int, float)) and not isinstance(wind.get(k), bool) for k in ("s", "d"))
        and 0 <= wind["s"] <= 40 and 0 <= wind["d"] <= 360)


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
    try:
        size = len(json.dumps(item, allow_nan=False))
    except (ValueError, TypeError, OverflowError):
        return "Bad item: numbers must be finite."
    if size > MAX_ITEM_BYTES:
        return "Item too large."
    # These fields are used as dictionary/set keys below. JSON arrays/objects must be rejected first.
    for k in ("type", "status", "veh", "foe", "weapon", "gun"):
        if k in item and not isinstance(item[k], str):
            return f"Bad {k}."
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
        for k in ("what", "size", "activity", "kit"):
            if k in item and (not isinstance(item[k], str) or len(item[k]) > 60):
                return "Bad contact report."
        if item.get("heading") is not None and not num("heading", 0, 360):
            return "Bad contact heading."
        if "ttl" in item and not num("ttl", 0, 1440):
            return "Bad timeout."
        if "gt" in item and not num("gt", 0, 86400):
            return "Bad game time."
        if "trail" in item and not (isinstance(item["trail"], list) and len(item["trail"]) <= 8
                                    and all(_is_point(q) for q in item["trail"])):
            return "Bad contact track."
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
        if not isinstance(item.get("side"), str) or item.get("side") not in {"f", "e", "v", "fv"} or not _is_point(item.get("xz")) or not num("range", 50, 2000):
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
    if t == "hulldown":
        if not (_is_point(item.get("xz")) and num("range", 50, 2000) and item.get("veh") in {"btr70", "brdm2", "lav25", "apc", "car"}
                and item.get("foe") in {"s", "v"}):
            return "Bad hull-down finder."
    if t == "sectors":
        names = item.get("names", [])
        if not _is_point(item.get("xz")) or not num("radius", 20, 3000) or not num("start", 0, 360):
            return "Bad sectors of fire."
        if not isinstance(item.get("n"), int) or not 2 <= item["n"] <= 12:
            return "Bad number of sectors."
        if not isinstance(names, list) or len(names) > 12 or not all(isinstance(s, str) and len(s) <= 40 for s in names):
            return "Bad sector names."
        if "height" in item and not num("height", 0, 100):
            return "Bad sectors height."
    if t == "route":
        pts = item.get("points")
        if not isinstance(pts, list) or not 2 <= len(pts) <= 200 or not all(_is_point(p) for p in pts):
            return "Bad route."
        plan = item.get("plan")
        if plan is not None and not (isinstance(plan, dict) and isinstance(plan.get("mode"), str) and plan.get("mode") in {"foot", "vehicle"} and _is_point(plan.get("from"))
                                     and _is_point(plan.get("to")) and isinstance(plan.get("at", 0), (int, float))):
            return "Bad route plan."
    if t == "range" and not (_is_point(item.get("from")) and _is_point(item.get("to"))):
        return "Bad range line."
    if t == "range" and any(k in item and not num(k, 0, 100) for k in ("h1", "h2")):
        return "Bad profile height."
    if t == "range" and "rocket" in item:
        # The rocket calculator on a range line: launcher, its rocket and sight (static/data/rockets.json), and the wind
        rk = item["rocket"]
        if not isinstance(rk, dict) or not all(isinstance(rk.get(k), str) for k in ("l", "r", "s")):
            return "Bad weapon."
        launcher = (isinstance(rk, dict) and set(rk) <= {"l", "r", "s"} and rk.get("r") in ROCKET_LAUNCHERS.get(rk.get("l"), ())
                    and rk.get("s") in {"iron", "pgo7"} and (rk["s"] == "iron" or rk["l"] == "RPG-7"))
        gun = (isinstance(rk, dict) and set(rk) <= {"l", "r", "s"} and rk.get("l") in SCOPED_GUNS
               and rk.get("r") == SCOPED_GUNS[rk["l"]] and rk.get("s") == "scope")
        if not (launcher or gun):
            return "Bad weapon."
        if not _is_wind(item.get("wind")):
            return "Bad wind."
    if t == "mortar":
        targets = item.get("targets", [])
        if not _is_point(item.get("xz")) or item.get("weapon") not in MORTAR_WEAPONS:
            return "Bad mortar."
        if not isinstance(item.get("shell"), str) or not SHELL_RE.match(item["shell"]):
            return "Bad mortar shell."
        if not isinstance(targets, list) or len(targets) > MAX_MORTAR_TARGETS or not all(_is_point(p) for p in targets):
            return "Bad mortar targets."
        # The charge ring the crew fires with (left out = the map picks one per target)
        if "charge" in item and not (isinstance(item["charge"], int) and not isinstance(item["charge"], bool) and 0 <= item["charge"] <= 4):
            return "Bad charge ring."
        # Wind the crew has read off the in-game map: speed in m/s and the compass direction it blows from
        if not _is_wind(item.get("wind")):
            return "Bad wind."
    if t == "emplacement":
        if not _is_point(item.get("xz")) or item.get("kind") not in {"mg", "lmg", "hmg", "aa-mg"}:
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
        if kind in {"headquarters", "player-hub", "antenna", "armory", "supply", "living", "hospital",
                    "light-depot", "heavy-depot", "helipad", "fuel", "floodlight", "bunker",
                    "sandbag-position", "camo-net", "guard-tower", "barricade", "checkpoint", "mortar-pit"} or (kind == "roadblock" and "points" not in item):
            if not _is_point(item.get("xz")):
                return "Bad construct position."
        elif kind in {'wall', 'dragon-teeth', 'wire', 'roadblock'}:
            pts = item.get("points")
            if not isinstance(pts, list) or not 2 <= len(pts) <= 200 or not all(_is_point(p) for p in pts):
                return "Bad obstacle line."
        else:
            return "Unknown construct."
    if t == "fia":
        caches = item.get("caches")
        if not isinstance(caches, list) or len(caches) > 40 or not all(isinstance(c, str) and 0 < len(c) <= 60 for c in caches):
            return "Bad FIA cache list."
    if t == "audible":
        if not _is_point(item.get("xz")) or item.get("gun") not in HEARD_GUNS:
            return "Bad gunfire marking."
    if t == "control":
        # Which side holds each Conflict point: {point name: {"s": "nato" | "ussr", "at": when it was marked}}
        marks = item.get("marks")
        if not isinstance(marks, dict) or len(marks) > 60 or not all(
                isinstance(k, str) and 0 < len(k) <= 60 and isinstance(v, dict) and v.get("s") in ("nato", "ussr")
                and isinstance(v.get("at"), (int, float)) and not isinstance(v.get("at"), bool)
                for k, v in marks.items()):
            return "Bad point control list."
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
            if not isinstance(data, dict):
                raise ValueError("ban file must be an object")
            self.bans = {ip: {**b, "names": b.get("names", [])} for ip, b in data.items() if isinstance(ip, str) and isinstance(b, dict)
                         and (b.get("until") is None or (isinstance(b["until"], (int, float))
                              and not isinstance(b["until"], bool) and 0 <= b["until"] <= 1e15))
                         and isinstance(b.get("at", 0), (int, float)) and not isinstance(b.get("at", 0), bool)
                         and -1e15 <= b.get("at", 0) <= 1e15 and isinstance(b.get("names", []), list)
                         and all(isinstance(n, str) for n in b.get("names", []))}
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
        self.buckets = collections.OrderedDict()  # oldest last-use first; cleanup never scans the whole table
        self.max_buckets = 50_000

    def allow(self, ip, kind):
        rate, burst = RATE_LIMITS[kind]
        now = time.time()
        with self.lock:
            for _ in range(16):
                if not self.buckets or now - next(iter(self.buckets.values()))[1] < 600:
                    break
                self.buckets.popitem(last=False)
            b = self.buckets.get((ip, kind))
            if b is None:
                if len(self.buckets) >= self.max_buckets:
                    return False  # preserve existing buckets instead of resetting their limits through eviction
                b = self.buckets[(ip, kind)] = [burst, now]
            self.buckets.move_to_end((ip, kind))
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
            # Distributed failures must not lock out an admin who knows the password.
            ok = isinstance(password, str) and len(password) <= 1000 and secrets.compare_digest(_digest(password), self.digest)
            if len(self.recent) >= ADMIN_GLOBAL_MAX_FAILURES and not ok:
                wait = int(ADMIN_GLOBAL_WINDOW - (now - self.recent[0])) // 60 + 1
                return 429, {"error": f"Admin sign-in is paused after many wrong passwords. Try again in {wait} min."}
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
_missing_tiles = set()  # (upstream address, z, x, y) the upstream said it doesn't have
_tile_fetches = threading.BoundedSemaphore(MAX_TILE_FETCHES)
_tile_cache_lock = threading.Lock()  # Windows readers and replacements must not overlap
_maps_lock = threading.Lock()
_maps_cache = {"key": None, "maps": {}}


def load_maps():
    """{map id: its map.json} for every static/data/maps/<id>/map.json, in their "order" (then by title).

    map.json says what the 2D and 3D views need to know about a map (title, size in metres, the 500 m grid, where the 3D
    camera starts...), as reforger-map-tools' `rmt.py fieldmap` writes it; "upstream" ({url, cache}) is for the
    server alone. The files are read again when one is added, removed or changed."""
    found = []
    try:
        names = sorted(os.listdir(MAPS_DIR))
    except OSError:
        names = []
    for name in names:
        if MAP_ID_RE.match(name):
            try:
                found.append((name, os.stat(os.path.join(MAPS_DIR, name, "map.json")).st_mtime_ns))
            except OSError:
                pass
    key = tuple(found)
    with _maps_lock:
        if key == _maps_cache["key"]:
            return _maps_cache["maps"]
    maps = []
    for name, _ in found:
        try:
            with open(os.path.join(MAPS_DIR, name, "map.json"), encoding="utf8") as f:
                info = json.load(f)
            if not isinstance(info, dict) or not isinstance(info.get("world"), (int, float)):
                raise ValueError("no world size")
        except (OSError, ValueError) as e:
            print(f"maps: {name}/map.json skipped ({e})", file=sys.stderr)
            continue
        info["id"] = name
        if not isinstance(info.get("title"), str) or not info["title"]:
            info["title"] = name.title()
        order = info.get("order")
        maps.append((order if isinstance(order, (int, float)) else float("inf"), info["title"].lower(), info))
    maps.sort(key=lambda m: m[:2])
    result = {m[2]["id"]: m[2] for m in maps}
    with _maps_lock:
        _maps_cache.update(key=key, maps=result)
    return result


def default_map():
    """The first map in the list: what a room opens on when nobody picked one."""
    return next(iter(load_maps()), None)


def public_maps():
    """The map list as the 2D and 3D views read it (/api/maps, /3d/maps.json): each map.json without the server's own
    settings, plus its tile address, whether it has a plant list (Measured line of sight) and its reference file of
    bases and caches (static/data/<id>.json) when there is one."""
    out = {}
    for map_id, info in load_maps().items():
        entry = {k: v for k, v in info.items() if k != "upstream"}
        entry["tiles"] = f"/maptiles/{map_id}/{{z}}/{{x}}/{{y}}.jpg"
        entry["hasPlants"] = os.path.isfile(os.path.join(MAPS_DIR, map_id, "foliage.json"))
        entry["hasMeshFoliage"] = all(os.path.isfile(os.path.join(MAPS_DIR, map_id, "foliage-mesh", part))
                                      for part in ("foliage.json", "foliage/foliage_profiles.json", "light/foliage.bin.gz"))
        if "poi" not in entry and os.path.isfile(os.path.join(STATIC, "data", f"{map_id}.json")):
            entry["poi"] = f"/data/{map_id}.json"
        out[map_id] = entry
    return {"default": next(iter(out), None), "maps": out}

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


def https_origin(url):
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Tile upstream must use HTTPS without embedded credentials.")
    return parsed.hostname.lower(), parsed.port or 443


class TileRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, origin):
        self.origin = origin

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        try:
            allowed = https_origin(newurl) == self.origin
        except ValueError:
            allowed = False
        if not allowed:
            raise urllib.error.URLError("Tile redirect left its configured HTTPS origin.")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class Handler(BaseHTTPRequestHandler):
    server_version = "EveronFieldMap"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    timeout = SOCKET_TIMEOUT  # a silent or half-sent request is dropped instead of holding a thread forever

    def end_headers(self):
        for k, v in SECURITY_HEADERS.items():
            self.send_header(k, v)
        if TRUST_PROXY and _is_trusted_proxy(self.client_address[0]) and self.headers.get("X-Forwarded-Proto") == "https":
            self.send_header("Strict-Transport-Security", "max-age=31536000")
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
        body = json.dumps(obj, allow_nan=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_bytes(self, code, body, ctype, cache="no-cache", gzipped=False):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        if gzipped:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, ctype, cache, gzipped=False):
        # Opening before sending headers also pins one file version across replacements.
        with open(path, "rb") as f:
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            if gzipped:
                self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
            self.send_header("Content-Length", str(os.fstat(f.fileno()).st_size))
            self.send_header("Cache-Control", cache)
            self.end_headers()
            shutil.copyfileobj(f, self.wfile, FILE_CHUNK_BYTES)

    def send_redirect(self, location):
        self.send_response(308)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

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
            return json.loads(self.rfile.read(n), parse_constant=_reject_constant, parse_float=_finite_float)
        except (ValueError, UnicodeDecodeError, RecursionError):
            return None

    def client_ip(self):
        peer = self.client_address[0]
        # Only an explicitly trusted proxy may say who the player is; anyone reaching the
        # server directly could otherwise claim any address. The proxy appends the address it saw to whatever the
        # browser sent, so only the last entry is trustworthy; the first is whatever the player wants.
        if TRUST_PROXY and _is_trusted_proxy(peer):
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
            return self.send_json(405, {"error": "Use POST for room events."})
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
        if path == "/map":  # the field map's public address (Caddy sends /map here as /); the same page locally
            path = "/index.html"
        if path in ("/mortar", "/shot"):  # the stand-alone pages (static/mortar.html, shot.html)
            path += ".html"
        if path == "/3d":  # the 3D view's own files are relative to its folder, so it needs the slash
            q = f"?{url.query}" if url.query else ""
            return self.send_redirect("/3d/" + q)
        if path in ("/api/maps", "/3d/maps.json"):  # the 3D view reads the same list as maps.json beside its page
            if self.limited("static"):
                return
            return self.send_json(200, public_maps())
        metadata = re.fullmatch(r"/data/maps/([a-z0-9][a-z0-9_-]{0,31})/map\.json", path)
        if metadata:
            if self.limited("data"):
                return
            info = load_maps().get(metadata[1])
            if info is None:
                return self.send_bytes(404, b"Not found", "text/plain")
            return self.send_json(200, {k: v for k, v in info.items() if k != "upstream"})
        m = re.match(r"^/maptiles/([a-z0-9][a-z0-9_-]{0,31})/([0-5])/(\d{1,3})/(\d{1,3})\.jpg$", path)
        if m:
            if self.limited("tile"):
                return
            return self.map_tile(*m.groups())
        # Map data comes in bursts (the 3D view streams terrain, objects and trees as you move), so it gets the tiles'
        # allowance rather than the page files'.
        if self.limited("data" if path.startswith("/data/") else "static"):
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
        if path == "/api/events":
            return self.events({"id": [body.get("id")], "token": [body.get("token")]})
        if path.startswith("/api/admin/"):
            if not self.admin_allowed():
                return self.send_bytes(404, b"Not found", "text/plain")
            return self.admin_post(path, body)
        if path == "/api/join":
            if self.limited("join"):
                return
            return self.send_json(*HUB.join(body.get("name"), body.get("room"), self.client_ip(), body.get("map"), body.get("observer", False)))
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
        if path == "/api/wind":
            return self.send_json(*HUB.set_wind(pid, token, body.get("wind")))
        if path == "/api/keep":
            return self.send_json(*HUB.set_keep(pid, token, body.get("keep")))
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
        elif path.endswith("/"):  # a folder's page: /3d/ is the 3D view
            path += "index.html"
        full = os.path.normpath(os.path.join(STATIC, path.lstrip("/")))
        if not full.startswith(STATIC + os.sep) or not os.path.isfile(full):
            return self.send_bytes(404, b"Not found", "text/plain")
        relative = os.path.relpath(full, STATIC).replace(os.sep, "/")
        metadata = re.fullmatch(r"data/maps/([a-z0-9][a-z0-9_-]{0,31})/map\.json", relative)
        if metadata:
            info = load_maps().get(metadata[1])
            if info is None:
                return self.send_bytes(404, b"Not found", "text/plain")
            return self.send_json(200, {k: v for k, v in info.items() if k != "upstream"})
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        # Map data changes only when it is re-baked (tile URLs carry a version), so browsers keep it for a week.
        cache = "no-store" if path in ADMIN_PAGES else "public, max-age=604800" if path.startswith("/data/") else "no-cache"
        # Text (pages, scripts, styles, JSON) is sent gzipped to browsers that accept it; .gz data and JPEGs already are.
        gz = ctype in GZIP_TYPES and os.path.getsize(full) > 1000 and accepts_gzip(self.headers.get("Accept-Encoding", ""))
        if gz:
            try:
                full = compressed_file(full)
            except OSError:
                # A read-only deployment or full cache disk must still serve the app.
                gz = False
        self.send_file(full, ctype, cache, gz)

    def map_tile(self, map_id, z, x, y):
        # A map's tiles are baked files (static/data/maps/<map>/tiles/). One that isn't there is open sea, unless the
        # map's map.json names an upstream to fetch it from (Everon until its own tiles are installed).
        info = load_maps().get(map_id)
        if not info:
            return self.send_bytes(404, b"", "image/jpeg")
        path = os.path.join(MAPS_DIR, map_id, "tiles", str(int(z)), str(int(x)), f"{int(y)}.jpg")
        if os.path.isfile(path):
            return self.send_file(path, "image/jpeg", "public, max-age=604800")
        upstream = info.get("upstream")
        if isinstance(upstream, dict) and isinstance(upstream.get("url"), str):
            cache = os.path.normpath(os.path.join(ROOT, str(upstream.get("cache") or os.path.join("tile_cache", map_id))))
            if cache.startswith(ROOT + os.sep):
                return self.upstream_tile(upstream["url"], cache, z, x, y)
        self.send_bytes(404, b"", "image/jpeg", "public, max-age=604800")

    def upstream_tile(self, url, cache, z, x, y):
        """A tile from another site, kept in the folder `cache` (z/x/y.jpg) after the first fetch."""
        n = 2 ** (7 - int(z))  # tiles per side at this zoom
        if int(x) >= n or int(y) >= n:
            return self.send_bytes(404, b"", "image/jpeg")
        z, x, y = str(int(z)), str(int(x)), str(int(y))  # one spelling per tile ("007" is "7")
        key = (url, z, x, y)
        path = os.path.join(cache, z, x, f"{y}.jpg")
        cached = None
        with _tile_cache_lock:
            if os.path.isfile(path):
                with open(path, "rb") as f:
                    cached = f.read()
        if cached is not None:
            return self.send_bytes(200, cached, "image/jpeg", "public, max-age=604800")
        if key in _missing_tiles:
            return self.send_bytes(404, b"", "image/jpeg")
        try:
            origin = https_origin(url)
        except ValueError:
            return self.send_bytes(502, b"", "image/jpeg")
        req = urllib.request.Request(url.format(z=z, x=x, y=y),
                                     headers={"User-Agent": "EveronFieldMap/1.0 (personal tile cache)"})
        if not _tile_fetches.acquire(timeout=20):
            return self.send_bytes(503, b"", "image/jpeg")
        try:
            with urllib.request.build_opener(TileRedirect(origin)).open(req, timeout=15) as r:
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
        # Each request owns its temporary file, even when several fetch the
        # same tile. Close it before replacing the cache entry on Windows.
        fd, tmp = tempfile.mkstemp(prefix=os.path.basename(path) + ".", suffix=".part",
                                   dir=os.path.dirname(path))
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            with _tile_cache_lock:
                os.replace(tmp, path)
        finally:
            try:
                os.unlink(tmp)
            except FileNotFoundError:
                pass
        self.send_bytes(200, data, "image/jpeg", "public, max-age=604800")

    def events(self, qs):
        pid, token = (qs.get("id") or [""])[0], (qs.get("token") or [""])[0]
        with HUB.lock:
            p = HUB._auth(pid, token, write=False)
            if p and not p.queues:
                p.gone_since = time.time()  # keep a pending reconnect alive while sync slots are busy
        if not p:
            return self.send_json(401, {"error": "Unknown session."})
        if not _snapshot_slots.acquire(timeout=1):
            # A short SSE response asks RoomEvents to reconnect after a join burst.
            self.close_connection = True
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(b": waiting to sync\nretry: 1000\n\n")
                self.wfile.flush()
            except OSError:
                pass
            return
        snapshot_slot = True
        try:
            p, q = HUB.open_stream(pid, token)
        except Exception:
            _snapshot_slots.release()
            raise
        if not p:
            _snapshot_slots.release()
            return self.send_json(401, {"error": "Unknown session or too many streams for this session."})
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            sock = self.connection
            idle = 0.0
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
                if isinstance(msg, Snapshot):
                    self.wfile.write(b"data: ")
                    # Avoid another whole-room copy when encoding/framing the event.
                    view = memoryview(msg.body)
                    for start in range(0, len(view), FILE_CHUNK_BYTES):
                        self.wfile.write(view[start:start + FILE_CHUNK_BYTES])
                    self.wfile.write(msg.tail + b"\n\n")
                    self.wfile.flush()
                    del view, msg
                    _snapshot_slots.release()
                    snapshot_slot = False
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
            if snapshot_slot:
                _snapshot_slots.release()


def accepts_gzip(header):
    qualities = {}
    for entry in header.lower().split(","):
        coding, *params = entry.strip().split(";")
        quality = 1.0
        for param in params:
            if param.strip().startswith("q="):
                try:
                    quality = float(param.strip()[2:])
                except ValueError:
                    quality = 0.0
        qualities[coding.strip()] = quality
    return qualities.get("gzip", qualities.get("*", 0)) > 0


def compressed_file(full):
    """Use build-time compression, or compress once to disk with bounded buffers."""
    st = os.stat(full)
    stamp = (st.st_mtime_ns, st.st_size)
    sidecar = full + ".gz"
    if os.path.isfile(sidecar) and os.stat(sidecar).st_mtime_ns == st.st_mtime_ns:
        return sidecar
    with _gzip_lock:  # one cold compression at a time, including requests for the same file
        hit = _gzip_cache.get(full)
        if hit and hit[0] == stamp and os.path.isfile(hit[1]):
            _gzip_cache.move_to_end(full)
            return hit[1]
        os.makedirs(COMPRESSED_CACHE, exist_ok=True)
        prefix = hashlib.sha256(full.encode()).hexdigest()
        dest = os.path.join(COMPRESSED_CACHE, f"{prefix}-{stamp[0]}-{stamp[1]}.gz")
        if not os.path.isfile(dest):
            fd, tmp = tempfile.mkstemp(dir=COMPRESSED_CACHE, suffix=".part")
            try:
                with os.fdopen(fd, "wb") as out, open(full, "rb") as src:
                    with gzip.GzipFile(filename="", fileobj=out, mode="wb", compresslevel=6, mtime=0) as gz:
                        shutil.copyfileobj(src, gz, FILE_CHUNK_BYTES)
                os.replace(tmp, dest)
            finally:
                if os.path.exists(tmp):
                    os.unlink(tmp)
        # Versioned paths keep concurrent responses safe when an asset is replaced.
        # This disposable directory may be cleared while the server is stopped.
        _gzip_cache[full] = (stamp, dest)
        _gzip_cache.move_to_end(full)
        while len(_gzip_cache) > MAX_GZIP_ENTRIES:
            _gzip_cache.popitem(last=False)
        return dest


def _finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("JSON numbers must be finite")
    return number


ADMIN_PAGES = {"/admin", "/admin.html", "/admin.js"}


def _is_trusted_proxy(ip):
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    a = a.ipv4_mapped or a if a.version == 6 else a
    return any(a in net for net in TRUSTED_PROXIES)


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
    ap = argparse.ArgumentParser(description="Arma Reforger Maps server")
    ap.add_argument("--host", default="127.0.0.1", help="use 0.0.0.0 to let others on your network connect")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--admin-password", default=os.environ.get("EVERON_ADMIN_PASSWORD", ""),
                    help="password for the admin view at /admin (default: $EVERON_ADMIN_PASSWORD, else a random one)")
    ap.add_argument("--behind-proxy", action="store_true",
                    help="read players' addresses from X-Forwarded-For (only when a reverse proxy sets it)")
    ap.add_argument("--trusted-proxies", default=os.environ.get("EVERON_TRUSTED_PROXIES", "127.0.0.1/32,::1/128"),
                    help="comma-separated proxy addresses/networks allowed to supply forwarding headers (default: loopback only)")
    ap.add_argument("--admin-allow", default=os.environ.get("EVERON_ADMIN_ALLOW", ""),
                    help="comma-separated addresses or networks allowed to use the admin view, e.g. 127.0.0.1,203.0.113.7 "
                         "(default: $EVERON_ADMIN_ALLOW, else anywhere)")
    args = ap.parse_args()
    global TRUST_PROXY, TRUSTED_PROXIES, ADMIN_ALLOW
    TRUST_PROXY = args.behind_proxy
    try:
        TRUSTED_PROXIES = [ipaddress.ip_network(n.strip(), strict=False) for n in args.trusted_proxies.split(",") if n.strip()]
    except ValueError as e:
        sys.exit(f"--trusted-proxies: {e}")
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
    HUB.load()
    threading.Thread(target=HUB.reap, daemon=True).start()
    threading.Thread(target=HUB.save_loop, daemon=True).start()
    srv = Server((args.host, args.port), Handler)
    shown = "localhost" if args.host in ("127.0.0.1", "0.0.0.0") else args.host
    print(f"Arma Reforger Maps running at http://{shown}:{args.port}/  (Ctrl+C to stop)", flush=True)
    print(f"3D view: http://{shown}:{args.port}/3d/", flush=True)
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
    finally:
        HUB.save()  # the last few seconds of changes to kept rooms


if __name__ == "__main__":
    main()

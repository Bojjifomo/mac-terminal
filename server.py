"""Mac Remote: control this Mac from a phone. Screen on top, MacBook keyboard + trackpad below.

    python3 server.py              run (port 8787), prints the link to open on the phone
    python3 server.py --doctor     check permissions and the screen capture
    python3 server.py --demo       a pretend Mac (any OS), to try the app
    python3 server.py --new-token  make a new token (old links stop working)

Every request needs the token (in the link the server prints). Use it over Tailscale (or your home Wi-Fi):
the page and the screen are plain HTTP, Tailscale encrypts them.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import secrets
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from control import Controller  # noqa: E402
import ws as wslib  # noqa: E402

WEB = HERE / "web"
CONFIG = Path(os.environ.get("MAC_REMOTE_HOME", Path.home() / ".mac-remote")) / "config.json"
# where files from the phone go: the Mac's Downloads (the demo keeps them next to its config)
DOWNLOADS = lambda: Path(os.environ["MAC_REMOTE_DOWNLOADS"]) if os.environ.get("MAC_REMOTE_DOWNLOADS") else Path.home() / "Downloads"
VERSION = "1.3"
STATIC = {"/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/style.css": "style.css",
          "/manifest.webmanifest": "manifest.webmanifest", "/icon.svg": "icon.svg", "/icon-180.png": "icon-180.png",
          "/icon-512.png": "icon-512.png"}
CTYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
          ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png"}


# ---------------------------------------------------------------- config
def load_config(new_token: bool = False) -> dict:
    try:
        cfg = json.loads(CONFIG.read_text())
    except (OSError, ValueError):
        cfg = {}
    if new_token or not cfg.get("token"):
        cfg["token"] = secrets.token_urlsafe(18)
        CONFIG.parent.mkdir(parents=True, exist_ok=True)
        CONFIG.write_text(json.dumps(cfg, indent=1))
        os.chmod(CONFIG, 0o600)
    return cfg


def computer_name() -> str:
    try:
        return subprocess.run(["scutil", "--get", "ComputerName"], capture_output=True, text=True, timeout=3).stdout.strip() or socket.gethostname()
    except (OSError, subprocess.SubprocessError):
        return socket.gethostname().split(".")[0]


def addresses(port: int) -> list[str]:
    """Where the phone can reach this Mac: Tailscale name first, then the LAN."""
    out = []
    for exe in ("tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"):
        try:
            st = json.loads(subprocess.run([exe, "status", "--json"], capture_output=True, text=True, timeout=4).stdout)
            dns = (st.get("Self") or {}).get("DNSName", "").rstrip(".")
            if dns:
                out.append(f"http://{dns.split('.')[0]}:{port}")
                ips = (st.get("Self") or {}).get("TailscaleIPs") or []
                if ips:
                    out.append(f"http://{ips[0]}:{port}")
                break
        except (OSError, ValueError, subprocess.SubprocessError):
            continue
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        out.append(f"http://{s.getsockname()[0]}:{port}")
        s.close()
    except OSError:
        pass
    out.append(f"http://{socket.gethostname().split('.')[0]}.local:{port}")
    return list(dict.fromkeys(out))


# ---------------------------------------------------------------- frames
class FrameSource:
    """One capture at a time; viewers asking within `share_s` of each other get the same picture."""

    def __init__(self, capture, displays, share_s: float = 0.03):
        self.capture = capture
        self.displays = displays
        self.lock = threading.Lock()
        self.rlock = threading.Lock()                   # magnifier pieces: their own lock, never wait for a frame
        self.share_s = share_s
        self.last: dict = {}

    def region(self, display_id: int, x: float, y: float, side: float, out_px: int, quality: float) -> bytes:
        with self.rlock:
            return self.capture.grab_region(display_id, x, y, side, out_px, quality)

    def frame(self, display: int, width: int, quality: float) -> dict:
        ds = self.displays()
        d = ds[min(max(display, 0), len(ds) - 1)]
        key = (d["id"], width, round(quality, 2))
        with self.lock:
            hit = self.last.get(key)
            if hit and time.monotonic() - hit["t"] < self.share_s:
                return hit
            data, w, h = self.capture.grab(d["id"], width, quality)
            f = {"t": time.monotonic(), "data": data, "w": w, "h": h, "etag": hashlib.blake2s(data, digest_size=8).hexdigest(),
                 "display": d}
            self.last = {key: f}
            return f


# ---------------------------------------------------------------- live session (WebSocket)
PRESETS = {"low": (960, 0.45), "mid": (1280, 0.55), "high": (1920, 0.65)}
MAX_IN_FLIGHT = 2                     # frames sent but not yet shown on the phone: more = old pictures queue up


class Session:
    """One phone, one socket. The Mac pushes a picture as soon as there is a new one and the phone has shown the
    previous ones (MAX_IN_FLIGHT); a picture that did not change is not sent again. Input comes back on the socket."""

    def __init__(self, sock: "wslib.WebSocket", handler_cls):
        self.ws = sock
        self.H = handler_cls
        self.cfg = {"w": 1280, "q": 0.55, "fps": 30, "d": 0}
        self.in_flight = 0
        self.cond = threading.Condition()
        self.running = True
        self.last_etag = ""
        self.last_cursor = None
        self.ready = False                    # the phone said what size it wants (first "cfg"): send nothing before
        self.zoom = {"on": False, "side": 120.0, "px": 360}   # magnifier: piece of screen around the pointer
        self.zoom_in_flight = 0
        # adaptive quality ("auto", for a slow link away from home): how long the phone takes to show a picture
        # (sent -> ack, same clock) decides how big the next ones are
        self.auto = True
        self.scale = 1.0
        self.sent_at: list[float] = []
        self.lag_ms = 0.0
        self.good_since = time.monotonic()
        self.lock_on_leave = False

    # ---- frames out
    def sender(self):
        try:
            while self.running:
                with self.cond:
                    while self.running and (not self.ready or self.in_flight >= MAX_IN_FLIGHT):
                        self.cond.wait(0.5)
                    cfg = dict(self.cfg)
                if not self.running:
                    break
                t0 = time.monotonic()
                w, q = int(cfg["w"]), float(cfg["q"])
                if self.auto:
                    w = max(480, int(w * self.scale))
                    q = max(0.35, min(q, 0.35 + 0.3 * self.scale))
                f = self.H.frames.frame(int(cfg["d"]), w, q)
                d = f["display"]
                cx, cy = self.H.controller.b.pos()
                cur = [round((cx - d["x"]) / d["w"], 5), round((cy - d["y"]) / d["h"], 5)]
                if f["etag"] != self.last_etag:
                    head = json.dumps({"t": "frame", "w": f["w"], "h": f["h"], "sw": d["w"], "sh": d["h"], "c": cur,
                                       "id": f["etag"], "kb": round(len(f["data"]) / 1024), "lag": round(self.lag_ms),
                                       "auto": self.auto}).encode()
                    with self.cond:
                        self.in_flight += 1
                        self.sent_at.append(time.monotonic())
                    self.ws.send_bytes(len(head).to_bytes(4, "big") + head + f["data"])
                    self.last_etag, self.last_cursor = f["etag"], cur
                elif cur != self.last_cursor:                  # screen still, pointer moved (mouse at the Mac)
                    self.ws.send_text(json.dumps({"t": "cursor", "c": cur}))
                    self.last_cursor = cur
                wait = 1.0 / max(1, min(60, float(cfg["fps"]))) - (time.monotonic() - t0)
                if wait > 0:
                    time.sleep(wait)
        except wslib.Closed:
            pass
        except Exception as exc:                            # noqa: BLE001 - tell the phone, then stop
            try:
                self.ws.send_text(json.dumps({"t": "error", "error": str(exc)[:300]}))
            except wslib.Closed:
                pass
        finally:
            self.running = False

    # ---- magnifier out: a sharp piece around the pointer, on its own track so the main picture never waits for it
    def zoom_sender(self):
        region = getattr(self.H.frames.capture, "grab_region", None)
        last = None
        try:
            while self.running:
                with self.cond:
                    while self.running and (not self.zoom["on"] or self.zoom_in_flight >= 1):
                        self.cond.wait(0.5)
                    z = dict(self.zoom)
                    cfg = dict(self.cfg)
                if not self.running:
                    break
                t0 = time.monotonic()
                ds = self.H.controller.b.displays()
                d = ds[min(max(int(cfg["d"]), 0), len(ds) - 1)]
                cx, cy = self.H.controller.b.pos()
                side = min(max(float(z["side"]), 16.0), min(d["w"], d["h"]))
                # centred on the pointer, kept inside the screen
                x = min(max(cx - d["x"] - side / 2, 0.0), d["w"] - side)
                y = min(max(cy - d["y"] - side / 2, 0.0), d["h"] - side)
                key = (round(x), round(y), round(side), self.last_etag)
                if key != last or time.monotonic() - getattr(self, "_zoom_t", 0) > 0.5:
                    data = self.H.frames.region(d["id"], x, y, side, int(z["px"]), 0.7)
                    head = json.dumps({"t": "zoom", "r": [x / d["w"], y / d["h"], side / d["w"], side / d["h"]]}).encode()
                    with self.cond:
                        self.zoom_in_flight += 1
                    self.ws.send_bytes(len(head).to_bytes(4, "big") + head + data)
                    last, self._zoom_t = key, time.monotonic()
                wait = 1 / 20 - (time.monotonic() - t0)          # up to 20 a second
                if wait > 0:
                    time.sleep(wait)
        except wslib.Closed:
            pass
        except Exception as exc:                                    # noqa: BLE001 - the phone falls back to the stream
            try:
                self.ws.send_text(json.dumps({"t": "zoomoff", "error": str(exc)[:200]}))
            except wslib.Closed:
                pass

    def _adapt(self, lag_ms: float) -> None:
        """Smaller pictures when the phone is slow to show them (bad signal), bigger again when it keeps up."""
        self.lag_ms = lag_ms if not self.lag_ms else self.lag_ms * 0.7 + lag_ms * 0.3
        now = time.monotonic()
        if self.lag_ms > 450:
            self.scale = max(0.4, self.scale * 0.8)
            self.good_since = now
        elif self.lag_ms > 250:
            self.good_since = now
        elif now - self.good_since > 2.5 and self.scale < 1.0:
            self.scale = min(1.0, self.scale * 1.15)
            self.good_since = now

    # ---- the Mac's clipboard and the app in front, sent when they change (Touch Bar row, copy to the phone)
    def watcher(self):
        b = self.H.controller.b
        clip = getattr(b, "clipboard", None)
        front = getattr(b, "front_app", None)
        last_count = None
        last_app = None
        self.own_clip = None
        try:
            while self.running:
                if clip:
                    try:
                        count, text = clip()
                        if last_count is None:
                            last_count = count                     # what was there before: not news
                        elif count != last_count:
                            last_count = count
                            if count != self.own_clip and text:    # not the text the phone itself just put there
                                self.ws.send_text(json.dumps({"t": "clip", "s": text[:262144]}))
                    except wslib.Closed:
                        raise
                    except Exception:                               # noqa: BLE001
                        clip = None
                if front:
                    try:
                        app = front()
                        if app != last_app:
                            last_app = app
                            self.ws.send_text(json.dumps({"t": "app", **app}))
                    except wslib.Closed:
                        raise
                    except Exception:                               # noqa: BLE001
                        front = None
                time.sleep(0.6)
        except wslib.Closed:
            pass

    # ---- messages in
    def on_message(self, msg):
        if not isinstance(msg, str):
            return
        m = json.loads(msg)
        t = m.get("t")
        if t == "ack":
            with self.cond:
                self.in_flight = max(0, self.in_flight - 1)
                sent = self.sent_at.pop(0) if self.sent_at else None
                self.cond.notify()
            if sent is not None:
                self._adapt((time.monotonic() - sent) * 1000)
        elif t == "cfg":
            with self.cond:
                quality = m.get("quality")
                preset = PRESETS.get(quality)
                if preset:
                    self.cfg["w"], self.cfg["q"] = preset
                if quality:
                    self.auto = quality == "auto"
                    if self.auto:
                        self.cfg["q"] = 0.6
                if "lockOnLeave" in m:
                    self.lock_on_leave = bool(m["lockOnLeave"])
                if m.get("w"):
                    self.cfg["w"] = min(max(int(m["w"]), 160), 3200)
                if m.get("fps"):
                    self.cfg["fps"] = min(max(float(m["fps"]), 1), 60)
                if "d" in m:
                    self.cfg["d"] = int(m["d"])
                self.in_flight = 0
                self.sent_at = []
                self.ready = True
                self.last_etag = ""                            # new size or screen: send a picture right away
                self.cond.notify()
        elif t == "zack":
            with self.cond:
                self.zoom_in_flight = 0
                self.cond.notify_all()
        elif t == "zoom":
            with self.cond:
                self.zoom["on"] = bool(m.get("on"))
                if m.get("side"):
                    self.zoom["side"] = float(m["side"])
                if m.get("px"):
                    self.zoom["px"] = min(max(int(m["px"]), 64), 720)
                self.zoom_in_flight = 0
                self.cond.notify_all()
        elif t == "input":
            with self.H.input_lock:
                self.H.controller.handle_all(list(m.get("ev") or [])[:500])
                self.H.last_input[0] = time.monotonic()
        elif t == "ping":
            self.ws.send_text(json.dumps({"t": "pong", "ts": m.get("ts")}))
        elif t == "clipset":
            # text from the phone onto the Mac's clipboard; paste=True also presses ⌘V where the Mac's cursor is
            setter = getattr(self.H.controller.b, "set_clipboard", None)
            if setter is None:
                raise ValueError("clipboard not available")
            self.own_clip = setter(str(m.get("s", ""))[:262144])
            if m.get("paste"):
                with self.H.input_lock:
                    self.H.controller.handle({"t": "action", "a": "paste"})

    def run(self):
        try:
            self.ws.send_text(json.dumps({"t": "info", "name": self.H.name, "version": VERSION,
                                          "displays": self.H.controller.b.displays(),
                                          "zoom": hasattr(self.H.frames.capture, "grab_region")}))
            threading.Thread(target=self.sender, daemon=True).start()
            threading.Thread(target=self.watcher, daemon=True).start()
            if hasattr(self.H.frames.capture, "grab_region"):
                threading.Thread(target=self.zoom_sender, daemon=True).start()
            while self.running:
                msg = self.ws.recv()
                try:
                    self.on_message(msg)
                except (ValueError, KeyError, TypeError) as exc:
                    self.ws.send_text(json.dumps({"t": "error", "error": str(exc)[:200]}))
        except wslib.Closed:
            pass
        finally:
            self.running = False
            with self.cond:
                self.cond.notify_all()
            with self.H.input_lock:
                self.H.controller.release_all()            # phone gone mid-drag / with ⌘ held
            self.H.session_ended(lock=self.lock_on_leave)


# ---------------------------------------------------------------- http
class Handler(BaseHTTPRequestHandler):
    token = ""
    name = ""
    controller: Controller = None
    frames: FrameSource = None
    cursor_in_image = True
    input_lock = threading.Lock()
    last_input = [0.0]
    server_version = "MacRemote/" + VERSION

    def log_message(self, fmt, *args):                 # quiet
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Expose-Headers", "X-Frame, X-Cursor, X-Screen")
        self.send_header("Cache-Control", "no-store")

    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _json(self, obj, code: int = 200):
        self._send(code, json.dumps(obj).encode(), "application/json")

    def _authed(self, q: dict) -> bool:
        return hmac.compare_digest(str(q.get("token", "")), self.token)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if u.path in STATIC:
            f = WEB / STATIC[u.path]
            try:
                return self._send(200, f.read_bytes(), CTYPES.get(f.suffix, "application/octet-stream"))
            except OSError:
                return self._send(404, b"not found", "text/plain")
        if not u.path.startswith("/api/"):
            return self._send(404, b"not found", "text/plain")
        if not self._authed(q):
            return self._json({"ok": False, "error": "token salah: buka lagi link dari Mac"}, 401)
        if u.path == "/api/ws":
            return self._websocket()
        try:
            if u.path == "/api/info":
                return self._json({"ok": True, "name": self.name, "version": VERSION, "displays": self.controller.b.displays(),
                                   "cursorInImage": self.cursor_in_image})
            if u.path == "/api/frame":
                width = min(max(int(q.get("w", 1280)), 160), 3200)
                quality = min(max(float(q.get("q", 0.6)), 0.2), 0.95)
                f = self.frames.frame(int(q.get("d", 0)), width, quality)
                cx, cy = self.controller.b.pos()
                d = f["display"]
                extra = {"X-Frame": f["etag"], "X-Screen": f"{d['w']:.0f}x{d['h']:.0f}",
                         "X-Cursor": f"{(cx - d['x']) / d['w']:.5f},{(cy - d['y']) / d['h']:.5f}"}
                if q.get("since") == f["etag"]:
                    return self._send(204, b"", "image/jpeg", extra)
                return self._send(200, f["data"], "image/jpeg", extra)
        except PermissionError as exc:
            return self._json({"ok": False, "error": f"izin Screen Recording belum dikasih: {exc}"}, 403)
        except Exception as exc:                        # noqa: BLE001
            return self._json({"ok": False, "error": str(exc)[:300]}, 500)
        return self._json({"ok": False, "error": "not found"}, 404)

    sessions = [0]
    sessions_lock = threading.Lock()

    @classmethod
    def session_ended(cls, lock: bool = False):
        with cls.sessions_lock:
            cls.sessions[0] -= 1
            idle = cls.sessions[0] <= 0
        if idle and lock:
            # away from home: the last phone left, lock the Mac so nobody at the desk sees or uses the session
            with cls.input_lock:
                try:
                    cls.controller.handle({"t": "action", "a": "lock"})
                except Exception:                               # noqa: BLE001
                    pass
        stop = getattr(cls.frames.capture, "idle", None)
        if idle and stop:
            stop()                                          # nobody watching: stop the screen stream

    def _websocket(self):
        key = self.headers.get("Sec-WebSocket-Key")
        if (self.headers.get("Upgrade") or "").lower() != "websocket" or not key:
            return self._json({"ok": False, "error": "expected a WebSocket"}, 400)
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", wslib.accept_key(key))
        self.end_headers()
        self.wfile.flush()
        self.close_connection = True
        try:
            self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)    # taps go out at once
        except OSError:
            pass
        with Handler.sessions_lock:
            Handler.sessions[0] += 1
        Session(wslib.WebSocket(self.rfile, self.wfile), Handler).run()

    MAX_UPLOAD = 4 << 30

    def _upload(self, q: dict):
        """A file from the phone into the Mac's Downloads folder (a name that is taken gets " (2)")."""
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > self.MAX_UPLOAD:
            return self._json({"ok": False, "error": "ukuran file nggak valid (maks 4 GB)"}, 400)
        name = os.path.basename(str(q.get("name") or "file")).strip().lstrip(".") or "file"
        name = "".join(c for c in name if c not in '\\/:\0')[:200] or "file"
        folder = DOWNLOADS()
        folder.mkdir(parents=True, exist_ok=True)
        stem, ext = os.path.splitext(name)
        dest, i = folder / name, 2
        while dest.exists():
            dest, i = folder / f"{stem} ({i}){ext}", i + 1
        part = dest.with_name(dest.name + ".part")
        left = n
        try:
            with open(part, "wb") as f:
                while left > 0:
                    chunk = self.rfile.read(min(left, 1 << 20))
                    if not chunk:
                        raise ConnectionError("upload terputus")
                    f.write(chunk)
                    left -= len(chunk)
            part.rename(dest)
        except (OSError, ConnectionError) as exc:
            try:
                part.unlink()
            except OSError:
                pass
            return self._json({"ok": False, "error": str(exc)[:200]}, 500)
        return self._json({"ok": True, "name": dest.name, "path": str(dest), "bytes": n})

    def do_POST(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if not self._authed(q):
            return self._json({"ok": False, "error": "token salah"}, 401)
        if u.path == "/api/upload":
            return self._upload(q)
        if u.path != "/api/input":
            return self._json({"ok": False, "error": "not found"}, 404)
        try:
            n = int(self.headers.get("Content-Length") or 0)
            events = json.loads(self.rfile.read(min(n, 256_000)) or b"[]")
            if isinstance(events, dict):
                events = [events]
            with self.input_lock:
                done = self.controller.handle_all(events[:500])
                self.last_input[0] = time.monotonic()
            return self._json({"ok": True, "n": done})
        except (ValueError, KeyError, TypeError) as exc:
            return self._json({"ok": False, "error": str(exc)[:200]}, 400)


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        import sys as _sys
        if isinstance(_sys.exc_info()[1], (BrokenPipeError, ConnectionResetError, wslib.Closed)):
            return                                      # the phone left mid-picture: nothing to report
        super().handle_error(request, client_address)


def watchdog(controller: Controller, idle_s: float = 8.0):
    """Phone went away with a button or a modifier held: let it go after a few quiet seconds."""
    while True:
        time.sleep(2)
        if (controller.held_button or controller.held_mods) and time.monotonic() - Handler.last_input[0] > idle_s:
            with Handler.input_lock:
                controller.release_all()


def build(demo: bool):
    if demo:
        from demo import DemoCapture, DemoInput
        inp = DemoInput()
        return inp, DemoCapture(inp), "Demo Mac"
    import macbackend
    return macbackend.MacInput(), macbackend.make_capture(), computer_name()


def serve(port: int, demo: bool, host: str = "0.0.0.0"):
    cfg = load_config()
    if demo and not os.environ.get("MAC_REMOTE_DOWNLOADS"):
        os.environ["MAC_REMOTE_DOWNLOADS"] = str(CONFIG.parent / "Downloads")      # the demo never writes to ~/Downloads
    inp, cap, name = build(demo)
    Handler.token = cfg["token"]
    Handler.name = name
    Handler.controller = Controller(inp)
    Handler.frames = FrameSource(cap, inp.displays)
    Handler.cursor_in_image = bool(getattr(cap, "cursor_in_image", True))
    threading.Thread(target=watchdog, args=(Handler.controller,), daemon=True).start()
    srv = Server((host, port), Handler)
    print(f"Mac Remote · {name} · port {port}")
    print("Buka di HP (salah satu, yang nyambung):")
    for a in addresses(port):
        print(f"  {a}/?token={cfg['token']}")
    print("Biarin jendela ini kebuka. Ctrl+C buat berhenti.", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


def main(argv=None):
    ap = argparse.ArgumentParser(description="Mac Remote server")
    ap.add_argument("--port", type=int, default=int(os.environ.get("MAC_REMOTE_PORT", 8787)))
    ap.add_argument("--demo", action="store_true", help="pretend Mac, no macOS needed")
    ap.add_argument("--doctor", action="store_true", help="check permissions and capture")
    ap.add_argument("--new-token", action="store_true", help="make a new token (old links stop working)")
    a = ap.parse_args(argv)
    if a.new_token:
        print("token baru:", load_config(new_token=True)["token"])
        return
    if a.doctor:
        try:
            import macbackend
        except ImportError as exc:
            sys.exit(f"pyobjc belum ada ({exc}). Jalanin: pip3 install -r {HERE / 'requirements.txt'}")
        bad = 0
        for name, ok, note in macbackend.doctor():
            print(f"{'✓' if ok else '✗'} {name}{(' · ' + note) if note else ''}")
            bad += not ok
        sys.exit(1 if bad else 0)
    if not a.demo and sys.platform != "darwin":
        sys.exit("ini buat macOS. Mau coba di sini: python3 server.py --demo")
    serve(a.port, a.demo)


if __name__ == "__main__":
    main()

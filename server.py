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

WEB = HERE / "web"
CONFIG = Path(os.environ.get("MAC_REMOTE_HOME", Path.home() / ".mac-remote")) / "config.json"
VERSION = "1.0"
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
        self.share_s = share_s
        self.last: dict = {}

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

    def do_POST(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if not self._authed(q):
            return self._json({"ok": False, "error": "token salah"}, 401)
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
    inp, cap, name = build(demo)
    Handler.token = cfg["token"]
    Handler.name = name
    Handler.controller = Controller(inp)
    Handler.frames = FrameSource(cap, inp.displays)
    Handler.cursor_in_image = bool(getattr(cap, "cursor_in_image", True))
    threading.Thread(target=watchdog, args=(Handler.controller,), daemon=True).start()
    srv = ThreadingHTTPServer((host, port), Handler)
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

import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
os.environ["MAC_REMOTE_HOME"] = tempfile.mkdtemp()

import control  # noqa: E402
import keys  # noqa: E402
import server  # noqa: E402
from demo import DemoCapture, DemoInput  # noqa: E402


class Clock:
    t = 100.0

    def __call__(self):
        return self.t


class KeysTest(unittest.TestCase):
    def test_resolve(self):
        self.assertEqual(keys.resolve("c"), (8, []))
        self.assertEqual(keys.resolve("C"), (8, ["shift"]))
        self.assertEqual(keys.resolve("!"), (18, ["shift"]))
        self.assertEqual(keys.resolve("return"), (36, []))
        with self.assertRaises(KeyError):
            keys.resolve("nope")

    def test_flags(self):
        self.assertEqual(keys.flags_for(["command", "shift"]), 0x100000 | 0x20000)
        with self.assertRaises(ValueError):
            keys.flags_for(["hyper"])


class ControllerTest(unittest.TestCase):
    def setUp(self):
        self.inp = DemoInput()
        self.clock = Clock()
        self.c = control.Controller(self.inp, clock=self.clock)

    def buttons(self):
        return [r for r in self.inp.log if r[0] == "button"]

    def test_move_is_clamped_to_the_screen(self):
        self.c.handle({"t": "move", "dx": 99999, "dy": -99999})
        self.assertEqual((self.inp.x, self.inp.y), (1511, 0))

    def test_move_to_is_relative_to_the_display(self):
        self.c.handle({"t": "moveTo", "x": 0.5, "y": 0.25, "d": 0})
        self.assertEqual((self.inp.x, self.inp.y), (756, 245.5))

    def test_two_quick_taps_make_a_double_click(self):
        self.c.handle({"t": "click"})
        self.clock.t += 0.2
        self.c.handle({"t": "click"})
        self.assertEqual([r[3] for r in self.buttons()], [1, 1, 2, 2])     # click counts of down/up pairs
        self.clock.t += 1.0
        self.c.handle({"t": "click"})
        self.assertEqual(self.buttons()[-1][3], 1)

    def test_drag_holds_the_button(self):
        self.c.handle({"t": "down", "b": "left"})
        self.c.handle({"t": "move", "dx": 10, "dy": 0})
        self.c.handle({"t": "up", "b": "left"})
        moves = [r for r in self.inp.log if r[0] == "move"]
        self.assertEqual(moves[-1][3], "left")
        self.assertIsNone(self.c.held_button)

    def test_key_with_modifiers(self):
        self.c.handle({"t": "key", "k": "c", "mods": ["command"]})
        keys_ = [r for r in self.inp.log if r[0] == "key"]
        self.assertEqual(keys_, [("key", 8, True, 0x100000), ("key", 8, False, 0x100000)])

    def test_locked_modifier_is_held_on_the_mac(self):
        self.c.handle({"t": "mod", "k": "command", "down": True})
        self.c.handle({"t": "key", "k": "tab"})
        self.assertEqual(self.inp.log[0], ("key", 55, True, 0x100000))
        self.assertEqual(self.inp.log[1], ("key", 48, True, 0x100000))
        self.c.release_all()
        self.assertEqual(self.inp.log[-1], ("key", 55, False, 0))

    def test_actions(self):
        self.c.handle({"t": "action", "a": "mission"})
        self.assertEqual(self.inp.log[0], ("key", 126, True, 0x40000))
        self.c.handle({"t": "action", "a": "volup"})
        self.assertEqual(self.inp.log[-1], ("action", "volup"))
        with self.assertRaises(ValueError):
            self.c.handle({"t": "action", "a": "selfdestruct"})

    def test_text(self):
        self.c.handle({"t": "text", "s": "halo 👋"})
        self.assertTrue(self.inp.text_buf.endswith("halo 👋"))

    def test_unknown_event(self):
        with self.assertRaises(ValueError):
            self.c.handle({"t": "explode"})


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cfg = server.load_config()
        cls.token = cfg["token"]
        cls.inp = DemoInput()
        server.Handler.token = cls.token
        server.Handler.name = "Test Mac"
        server.Handler.controller = control.Controller(cls.inp)
        server.Handler.frames = server.FrameSource(DemoCapture(cls.inp, clock=False), cls.inp.displays, share_s=0)
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def get(self, path, token=True):
        sep = "&" if "?" in path else "?"
        url = self.base + path + (f"{sep}token={self.token}" if token else "")
        try:
            with urllib.request.urlopen(url) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def test_needs_the_token(self):
        self.assertEqual(self.get("/api/info", token=False)[0], 401)

    def test_page_is_served(self):
        st, h, body = self.get("/", token=False)
        self.assertEqual(st, 200)
        self.assertIn(b"Mac Remote", body)

    def test_info(self):
        st, h, body = self.get("/api/info")
        j = json.loads(body)
        self.assertEqual((st, j["name"]), (200, "Test Mac"))
        self.assertEqual(h["Access-Control-Allow-Origin"], "*")

    def test_frame_then_unchanged(self):
        st, h, body = self.get("/api/frame?w=400&q=0.5")
        self.assertEqual(st, 200)
        self.assertEqual(body[:2], b"\xff\xd8")                       # a JPEG
        self.assertIn("X-Cursor", h)
        st2, _, _ = self.get(f"/api/frame?w=400&q=0.5&since={h['X-Frame']}")
        self.assertIn(st2, (200, 204))                                # 204 when the picture did not change

    def test_input(self):
        req = urllib.request.Request(f"{self.base}/api/input?token={self.token}", method="POST",
                                     data=json.dumps([{"t": "text", "s": "dari test"}, {"t": "key", "k": "return"}]).encode(),
                                     headers={"Content-Type": "text/plain"})
        with urllib.request.urlopen(req) as r:
            self.assertEqual(json.loads(r.read()), {"ok": True, "n": 2})
        self.assertTrue(self.inp.text_buf.endswith("dari test\n"))

    def test_bad_input_is_400(self):
        req = urllib.request.Request(f"{self.base}/api/input?token={self.token}", method="POST",
                                     data=b'[{"t": "key", "k": "nope"}]')
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req)
        self.assertEqual(ctx.exception.code, 400)


class WebSocketTest(unittest.TestCase):
    """The live connection: pictures pushed by the Mac, input on the same socket."""

    @classmethod
    def setUpClass(cls):
        cls.inp = DemoInput()
        server.Handler.token = "tok"
        server.Handler.name = "WS Mac"
        server.Handler.controller = control.Controller(cls.inp)
        server.Handler.frames = server.FrameSource(DemoCapture(cls.inp, clock=False), cls.inp.displays, share_s=0)
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def connect(self, token="tok"):
        import base64
        import socket
        s = socket.create_connection(self.srv.server_address)
        s.settimeout(5)
        key = base64.b64encode(os.urandom(16)).decode()
        s.sendall(f"GET /api/ws?token={token} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                  f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n".encode())
        f = s.makefile("rb")
        status = f.readline()
        headers = {}
        while True:
            line = f.readline()
            if line in (b"\r\n", b""):
                break
            k, _, v = line.decode().partition(":")
            headers[k.strip().lower()] = v.strip()
        self.addCleanup(s.close)
        return s, f, status, headers, key

    def tx(self, s, obj):
        import ws as W
        s.sendall(W.encode(json.dumps(obj).encode(), 0x1, os.urandom(4)))   # a browser always masks

    def rx(self, f):
        import ws as W
        return W.WebSocket(f, None).recv()

    def frame(self, f):
        m = self.rx(f)
        while isinstance(m, str):
            m = self.rx(f)
        n = int.from_bytes(m[:4], "big")
        return json.loads(m[4:4 + n]), m[4 + n:]

    def test_handshake_and_wrong_token(self):
        import ws as W
        _, _, status, headers, key = self.connect()
        self.assertIn(b"101", status)
        self.assertEqual(headers["sec-websocket-accept"], W.accept_key(key))
        _, _, status, _, _ = self.connect(token="wrong")
        self.assertIn(b"401", status)

    def test_frames_are_pushed_and_input_arrives(self):
        s, f, *_ = self.connect()
        info = json.loads(self.rx(f))
        self.assertEqual((info["t"], info["name"]), ("info", "WS Mac"))
        self.tx(s, {"t": "cfg", "w": 480, "q": 0.5, "fps": 60})
        head, jpeg = self.frame(f)
        self.assertEqual(jpeg[:2], b"\xff\xd8")
        self.assertEqual(head["w"], 480)
        self.assertEqual(len(head["c"]), 2)
        self.tx(s, {"t": "ack"})
        self.tx(s, {"t": "input", "ev": [{"t": "text", "s": "lewat socket"}]})
        head2, _ = self.frame(f)                                         # the screen changed: a new picture
        self.assertNotEqual(head2["id"], head["id"])
        self.assertTrue(self.inp.text_buf.endswith("lewat socket"))

    def test_no_new_picture_while_the_screen_is_still(self):
        s, f, *_ = self.connect()
        self.rx(f)
        self.tx(s, {"t": "cfg", "w": 320, "q": 0.5, "fps": 60})
        self.frame(f)
        self.tx(s, {"t": "ack"})
        s.settimeout(0.6)
        import socket
        with self.assertRaises(socket.timeout):
            m = self.rx(f)
            while isinstance(m, str):                                     # cursor notes are fine, pictures are not
                m = self.rx(f)

    def test_bad_event_is_reported_not_fatal(self):
        s, f, *_ = self.connect()
        self.rx(f)
        self.tx(s, {"t": "input", "ev": [{"t": "key", "k": "nope"}]})
        m = self.rx(f)
        while not (isinstance(m, str) and json.loads(m)["t"] == "error"):
            m = self.rx(f)
        self.tx(s, {"t": "input", "ev": [{"t": "text", "s": "masih hidup"}]})
        import time
        time.sleep(0.2)
        self.assertTrue(self.inp.text_buf.endswith("masih hidup"))

    def test_magnifier_sends_a_sharp_piece_around_the_pointer(self):
        s, f, *_ = self.connect()
        info = json.loads(self.rx(f))
        self.assertTrue(info["zoom"])
        self.inp.x, self.inp.y = 300.0, 200.0
        self.tx(s, {"t": "cfg", "w": 320, "q": 0.5, "fps": 30})
        self.tx(s, {"t": "zoom", "on": True, "side": 100, "px": 200})
        for _ in range(10):
            head, jpeg = self.frame(f)
            if head["t"] == "zoom":
                break
            self.tx(s, {"t": "ack"})
        self.assertEqual(head["t"], "zoom")
        self.assertEqual(jpeg[:2], b"\xff\xd8")
        x, y, w, h = head["r"]
        self.assertAlmostEqual(x, (300 - 50) / 1512, places=4)      # centred on the pointer
        self.assertAlmostEqual(y, (200 - 50) / 982, places=4)
        from PIL import Image
        import io
        self.assertEqual(Image.open(io.BytesIO(jpeg)).size, (200, 200))

    def test_magnifier_stays_inside_the_screen(self):
        s, f, *_ = self.connect()
        self.rx(f)
        self.inp.x, self.inp.y = 2.0, 2.0                               # top-left corner
        self.tx(s, {"t": "cfg", "w": 320, "q": 0.5, "fps": 30})
        self.tx(s, {"t": "zoom", "on": True, "side": 100, "px": 128})
        for _ in range(10):
            head, _ = self.frame(f)
            if head["t"] == "zoom":
                break
            self.tx(s, {"t": "ack"})
        self.assertEqual(head["r"][:2], [0.0, 0.0])

    def test_clipboard_both_ways_and_front_app(self):
        s, f, *_ = self.connect()
        self.rx(f)
        self.tx(s, {"t": "cfg", "w": 320, "q": 0.5, "fps": 30})
        got = {}
        import time as _t
        deadline = _t.time() + 4
        _t.sleep(0.8)                                                   # the server reads what was there first
        self.inp.set_clipboard("baru di-copy di Mac")                  # a copy on the Mac reaches the phone
        while _t.time() < deadline and not ("clip" in got and "app" in got):
            m = self.rx(f)
            if isinstance(m, str):
                j = json.loads(m)
                got[j["t"]] = j
            else:
                self.tx(s, {"t": "ack"})
        self.assertEqual(got["app"]["name"], "Notes")
        self.assertEqual(got["clip"]["s"], "baru di-copy di Mac")
        before = len(self.inp.log)
        self.tx(s, {"t": "clipset", "s": "dari HP", "paste": True})    # and back: onto the Mac, then ⌘V
        _t.sleep(0.3)
        self.assertEqual(self.inp.clip[1], "dari HP")
        self.assertIn(("key", 9, True, 0x100000), self.inp.log[before:])

    def test_upload_lands_in_downloads(self):
        import tempfile as _tf
        d = _tf.mkdtemp()
        os.environ["MAC_REMOTE_DOWNLOADS"] = d
        self.addCleanup(os.environ.pop, "MAC_REMOTE_DOWNLOADS", None)
        base = f"http://127.0.0.1:{self.srv.server_address[1]}/api/upload?token=tok&name="
        for _ in range(2):
            req = urllib.request.Request(base + "../foto%20liburan.jpg", data=b"\xff\xd8hello", method="POST",
                                         headers={"Content-Type": "application/octet-stream"})
            with urllib.request.urlopen(req) as r:
                j = json.loads(r.read())
            self.assertTrue(j["ok"])
        self.assertEqual(sorted(os.listdir(d)), ["foto liburan (2).jpg", "foto liburan.jpg"])   # never outside, never over
        with open(os.path.join(d, "foto liburan.jpg"), "rb") as fh:
            self.assertEqual(fh.read(), b"\xff\xd8hello")


class AdaptiveTest(unittest.TestCase):
    def test_slow_phone_gets_smaller_pictures_then_bigger_again(self):
        sess = server.Session(None, server.Handler)
        for _ in range(6):
            sess._adapt(900)                                            # 0.9 s to show each picture: bad signal
        self.assertLess(sess.scale, 0.5)
        low = sess.scale
        import time as _t
        for _ in range(40):
            sess.good_since -= 3                                        # pretend time passes
            sess._adapt(60)
        self.assertGreater(sess.scale, low)
        self.assertLessEqual(sess.scale, 1.0)

    def test_lock_when_the_last_phone_leaves(self):
        inp = DemoInput()
        server.Handler.controller = control.Controller(inp)
        server.Handler.sessions[0] = 1
        server.Handler.frames = server.FrameSource(DemoCapture(inp, clock=False), inp.displays)
        server.Handler.session_ended(lock=True)
        self.assertEqual(inp.log[0], ("key", 12, True, 0x40000 | 0x100000))   # ⌃⌘Q


if __name__ == "__main__":
    unittest.main()

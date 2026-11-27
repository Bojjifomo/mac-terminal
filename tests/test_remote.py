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
        server.Handler.frames = server.FrameSource(DemoCapture(cls.inp), cls.inp.displays, share_s=0)
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


if __name__ == "__main__":
    unittest.main()

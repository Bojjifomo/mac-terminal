"""A pretend Mac for trying the app without one (`python3 server.py --demo`) and for the tests.

The screen is drawn with Pillow: a desktop, a notes window that shows what you type, and the pointer.
"""
from __future__ import annotations

import io
import threading
import time

W, H = 1512, 982                                      # a 14" MacBook Pro, in points


class DemoInput:
    def __init__(self):
        self.x, self.y = W / 2, H / 2
        self.text_buf = "Ketik dari HP, muncul di sini.\n"
        self.log: list[tuple] = []
        self.lock = threading.Lock()
        self.changed = time.monotonic()

    def _touch(self, *row):
        with self.lock:
            self.log.append(row)
            self.log = self.log[-200:]
            self.changed = time.monotonic()

    def pos(self):
        return self.x, self.y

    def displays(self):
        return [{"id": 1, "x": 0.0, "y": 0.0, "w": float(W), "h": float(H)}]

    def move(self, x, y, held):
        self.x, self.y = x, y
        self._touch("move", round(x), round(y), held)

    def button(self, name, down, x, y, clicks, flags):
        self._touch("button", name, down, clicks, flags)

    def scroll(self, dx, dy):
        self._touch("scroll", dx, dy)

    def key(self, code, down, flags):
        if down:
            from keys import KEYCODES
            name = next((k for k, v in KEYCODES.items() if v == code), str(code))
            if name == "delete":
                self.text_buf = self.text_buf[:-1]
            elif name == "return":
                self.text_buf += "\n"
            elif name == "space":
                self.text_buf += " "
            elif len(name) == 1 and not flags & 0x1C0000:      # no cmd / ctrl / option
                self.text_buf += name.upper() if flags & 0x20000 else name
        self._touch("key", code, down, flags)

    def text(self, s):
        self.text_buf += s
        self._touch("text", s)

    def action(self, name):
        self._touch("action", name)


class DemoCapture:
    cursor_in_image = True

    def __init__(self, inp: DemoInput):
        self.inp = inp

    def grab(self, display_id: int, width: int, quality: float):
        from PIL import Image, ImageDraw
        w = max(64, min(int(width), W * 2))
        h = int(round(w * H / W))
        s = w / W
        im = Image.new("RGB", (w, h))
        d = ImageDraw.Draw(im)
        for i in range(h):                             # wallpaper
            t = i / h
            d.line([(0, i), (w, i)], fill=(int(30 + 60 * t), int(40 + 30 * t), int(90 + 80 * (1 - t))))
        d.rectangle([0, 0, w, 24 * s], fill=(235, 235, 240))  # menu bar
        d.text((14 * s, 5 * s), "  Finder   File   Edit   View   Go   Window   Help", fill=(20, 20, 20))
        d.text((w - 120 * s, 5 * s), time.strftime("%a %H:%M:%S"), fill=(20, 20, 20))
        x0, y0, x1, y1 = 160 * s, 110 * s, 1100 * s, 720 * s  # notes window
        d.rounded_rectangle([x0, y0, x1, y1], radius=12 * s, fill=(250, 250, 250))
        d.rounded_rectangle([x0, y0, x1, y0 + 34 * s], radius=12 * s, fill=(225, 225, 230))
        for k, c in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
            cx = x0 + (20 + 20 * k) * s
            d.ellipse([cx - 6 * s, y0 + 11 * s, cx + 6 * s, y0 + 23 * s], fill=c)
        d.text((x0 + 90 * s, y0 + 11 * s), "Notes — demo Mac Remote", fill=(60, 60, 60))
        lines = self.inp.text_buf.split("\n")[-22:]
        for i, line in enumerate(lines):
            d.text((x0 + 24 * s, y0 + (54 + i * 24) * s), line[-120:], fill=(25, 25, 25))
        d.rounded_rectangle([w / 2 - 300 * s, h - 70 * s, w / 2 + 300 * s, h - 12 * s], radius=16 * s, fill=(60, 60, 70))
        px, py = self.inp.x * s, self.inp.y * s        # pointer
        d.polygon([(px, py), (px, py + 22 * s), (px + 6 * s, py + 17 * s), (px + 11 * s, py + 27 * s),
                   (px + 15 * s, py + 25 * s), (px + 10 * s, py + 15 * s), (px + 17 * s, py + 15 * s)],
                  fill=(0, 0, 0), outline=(255, 255, 255))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=int(max(10, min(95, quality * 100))))
        return buf.getvalue(), w, h

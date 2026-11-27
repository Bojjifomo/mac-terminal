"""Turns the phone's events into mouse / keyboard actions on a backend.

The backend does the raw work (macbackend.MacInput on a Mac, demo.DemoInput anywhere else):
    pos() -> (x, y)                      pointer, global points
    displays() -> [{"id", "x", "y", "w", "h"}]   in global points, main display first
    move(x, y, held_button|None)
    button(name, down, x, y, clicks, flags)
    scroll(dx, dy)                       pixels
    key(code, down, flags)
    text(s)                              unicode text, typed as is
    action(name)                         volume and the like (optional)

Events from the phone (JSON objects, see web/app.js):
    {"t": "move", "dx", "dy"}            relative, trackpad
    {"t": "moveTo", "x", "y", "d"}       0..1 on display index d (tap on the screen picture)
    {"t": "click", "b": "left"|"right", "n"?}
    {"t": "down"|"up", "b"}              drag
    {"t": "scroll", "dx", "dy"}
    {"t": "key", "k", "mods"?}           press + release
    {"t": "mod", "k", "down"}            hold / release a modifier (Cmd+Tab, Cmd+click)
    {"t": "text", "s"}
    {"t": "action", "a"}
"""
from __future__ import annotations

import time

from keys import FLAGS, KEYCODES, MODIFIER_KEYS, flags_for, resolve

DOUBLE_CLICK_S = 0.45
DOUBLE_CLICK_PT = 6
ACTIONS = {
    # macOS default shortcuts
    "mission": ("up", ["control"]),
    "apps": ("down", ["control"]),
    "desktopLeft": ("left", ["control"]),
    "desktopRight": ("right", ["control"]),
    "spotlight": ("space", ["command"]),
    "lock": ("q", ["control", "command"]),
    "screenshot": ("4", ["shift", "command"]),
}
BACKEND_ACTIONS = {"volup", "voldown", "mute"}
MOD_KEYCODE = {"shift": KEYCODES["shift"], "control": KEYCODES["control"], "option": KEYCODES["option"],
               "command": KEYCODES["command"], "fn": KEYCODES["fn"]}


class Controller:
    def __init__(self, backend, clock=time.monotonic):
        self.b = backend
        self.clock = clock
        self.held_mods: set[str] = set()
        self.held_button: str | None = None
        self._last_click = (None, 0.0, 0.0, 0.0, 0)   # button, t, x, y, count

    # ---- geometry
    def _clamp(self, x: float, y: float) -> tuple[float, float]:
        ds = self.b.displays()
        for d in ds:
            if d["x"] <= x < d["x"] + d["w"] and d["y"] <= y < d["y"] + d["h"]:
                return x, y
        # outside every display: pull it back into the nearest one
        best, bd = None, None
        for d in ds:
            cx = min(max(x, d["x"]), d["x"] + d["w"] - 1)
            cy = min(max(y, d["y"]), d["y"] + d["h"] - 1)
            dist = (cx - x) ** 2 + (cy - y) ** 2
            if bd is None or dist < bd:
                best, bd = (cx, cy), dist
        return best if best else (x, y)

    def _flags(self, extra=()) -> int:
        return flags_for(set(self.held_mods) | set(extra or ()))

    # ---- events
    def handle(self, ev: dict) -> None:
        t = ev.get("t")
        fn = getattr(self, "_ev_" + str(t), None)
        if fn is None:
            raise ValueError(f"unknown event {t!r}")
        fn(ev)

    def handle_all(self, events: list) -> int:
        n = 0
        for ev in events:
            self.handle(ev)
            n += 1
        return n

    def _ev_move(self, ev):
        x, y = self.b.pos()
        x, y = self._clamp(x + float(ev.get("dx", 0)), y + float(ev.get("dy", 0)))
        self.b.move(x, y, self.held_button)

    def _ev_moveTo(self, ev):
        ds = self.b.displays()
        d = ds[min(max(int(ev.get("d", 0)), 0), len(ds) - 1)]
        nx = min(max(float(ev["x"]), 0.0), 0.9999)
        ny = min(max(float(ev["y"]), 0.0), 0.9999)
        self.b.move(d["x"] + nx * d["w"], d["y"] + ny * d["h"], self.held_button)

    def _click_count(self, button: str, x: float, y: float) -> int:
        lb, lt, lx, ly, lc = self._last_click
        now = self.clock()
        if lb == button and now - lt <= DOUBLE_CLICK_S and abs(x - lx) <= DOUBLE_CLICK_PT and abs(y - ly) <= DOUBLE_CLICK_PT:
            n = min(lc + 1, 3)
        else:
            n = 1
        self._last_click = (button, now, x, y, n)
        return n

    def _button(self, ev) -> str:
        b = ev.get("b", "left")
        if b not in ("left", "right"):
            raise ValueError(f"unknown button {b!r}")
        return b

    def _ev_click(self, ev):
        b = self._button(ev)
        x, y = self.b.pos()
        n = int(ev["n"]) if ev.get("n") else self._click_count(b, x, y)
        flags = self._flags(ev.get("mods"))
        if n > 1 and ev.get("n"):
            # an explicit double click: macOS wants every click of it, with rising click counts
            for i in range(1, n + 1):
                self.b.button(b, True, x, y, i, flags)
                self.b.button(b, False, x, y, i, flags)
            self._last_click = (b, self.clock(), x, y, n)
            return
        self.b.button(b, True, x, y, n, flags)
        self.b.button(b, False, x, y, n, flags)

    def _ev_down(self, ev):
        b = self._button(ev)
        x, y = self.b.pos()
        self.held_button = b
        self._last_click = (None, 0.0, 0.0, 0.0, 0)        # a drag never turns into a double click
        self.b.button(b, True, x, y, 1, self._flags(ev.get("mods")))

    def _ev_up(self, ev):
        b = self._button(ev)
        x, y = self.b.pos()
        self.held_button = None
        self.b.button(b, False, x, y, 1, self._flags(ev.get("mods")))

    def _ev_scroll(self, ev):
        self.b.scroll(float(ev.get("dx", 0)), float(ev.get("dy", 0)))

    def _ev_key(self, ev):
        code, implied = resolve(str(ev["k"]))
        flags = self._flags(list(ev.get("mods") or []) + implied)
        self.b.key(code, True, flags)
        self.b.key(code, False, flags)

    def _ev_mod(self, ev):
        k = MODIFIER_KEYS.get(str(ev["k"]))
        if k is None:
            raise ValueError(f"not a modifier: {ev['k']!r}")
        down = bool(ev.get("down"))
        if down:
            self.held_mods.add(k)
        else:
            self.held_mods.discard(k)
        self.b.key(MOD_KEYCODE[k], down, self._flags())

    def _ev_text(self, ev):
        s = str(ev.get("s", ""))
        if s:
            self.b.text(s[:2000])

    def _ev_action(self, ev):
        a = str(ev.get("a"))
        if a in ACTIONS:
            k, mods = ACTIONS[a]
            self._ev_key({"k": k, "mods": mods})
        elif a in BACKEND_ACTIONS:
            self.b.action(a)
        else:
            raise ValueError(f"unknown action {a!r}")

    def release_all(self) -> None:
        """The phone went away mid-drag / with Cmd held: let go of everything."""
        if self.held_button:
            self._ev_up({"b": self.held_button})
        for m in list(self.held_mods):
            self._ev_mod({"k": m, "down": False})


__all__ = ["Controller", "ACTIONS", "FLAGS"]

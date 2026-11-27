"""macOS side: screen capture (ScreenCaptureKit, else CoreGraphics) and input (Quartz events).

Needs: pip3 install pyobjc-framework-Quartz pyobjc-framework-ScreenCaptureKit pyobjc-framework-ApplicationServices
and two permissions for the app that runs python (Terminal / iTerm): Screen Recording and Accessibility
(System Settings > Privacy & Security). `python3 server.py --doctor` checks both.
"""
from __future__ import annotations

import subprocess
import threading

import Quartz as Q

MAX_DISPLAYS = 16


def _display_ids() -> list[int]:
    err, ids, n = Q.CGGetActiveDisplayList(MAX_DISPLAYS, None, None)
    if err:
        return [Q.CGMainDisplayID()]
    ids = list(ids[:n])
    main = Q.CGMainDisplayID()
    ids.sort(key=lambda i: i != main)                   # main display first
    return ids


def displays() -> list[dict]:
    out = []
    for i in _display_ids():
        r = Q.CGDisplayBounds(i)
        out.append({"id": int(i), "x": float(r.origin.x), "y": float(r.origin.y),
                    "w": float(r.size.width), "h": float(r.size.height)})
    return out


# ---------------------------------------------------------------- input
_MOUSE = {
    ("left", True): Q.kCGEventLeftMouseDown, ("left", False): Q.kCGEventLeftMouseUp,
    ("right", True): Q.kCGEventRightMouseDown, ("right", False): Q.kCGEventRightMouseUp,
}
_BTN = {"left": Q.kCGMouseButtonLeft, "right": Q.kCGMouseButtonRight}


def _post(ev) -> None:
    Q.CGEventPost(Q.kCGHIDEventTap, ev)


class MacInput:
    def pos(self):
        p = Q.CGEventGetLocation(Q.CGEventCreate(None))
        return float(p.x), float(p.y)

    def displays(self):
        return displays()

    def move(self, x, y, held):
        if held == "left":
            kind, btn = Q.kCGEventLeftMouseDragged, Q.kCGMouseButtonLeft
        elif held == "right":
            kind, btn = Q.kCGEventRightMouseDragged, Q.kCGMouseButtonRight
        else:
            kind, btn = Q.kCGEventMouseMoved, Q.kCGMouseButtonLeft
        _post(Q.CGEventCreateMouseEvent(None, kind, (x, y), btn))

    def button(self, name, down, x, y, clicks, flags):
        ev = Q.CGEventCreateMouseEvent(None, _MOUSE[(name, down)], (x, y), _BTN[name])
        Q.CGEventSetIntegerValueField(ev, Q.kCGMouseEventClickState, int(clicks))
        if flags:
            Q.CGEventSetFlags(ev, flags)
        _post(ev)

    def scroll(self, dx, dy):
        ev = Q.CGEventCreateScrollWheelEvent(None, Q.kCGScrollEventUnitPixel, 2, int(round(dy)), int(round(dx)))
        _post(ev)

    def key(self, code, down, flags):
        ev = Q.CGEventCreateKeyboardEvent(None, int(code), bool(down))
        Q.CGEventSetFlags(ev, flags)
        _post(ev)

    def text(self, s):
        # CGEventKeyboardSetUnicodeString takes at most ~20 UTF-16 units per event
        chunks, cur = [], ""
        for ch in s:
            if len((cur + ch).encode("utf-16-le")) // 2 > 20:
                chunks.append(cur)
                cur = ""
            cur += ch
        if cur:
            chunks.append(cur)
        for c in chunks:
            n = len(c.encode("utf-16-le")) // 2
            for down in (True, False):
                ev = Q.CGEventCreateKeyboardEvent(None, 0, down)
                Q.CGEventSetFlags(ev, 0)
                Q.CGEventKeyboardSetUnicodeString(ev, n, c)
                _post(ev)

    def action(self, name):
        script = {
            "volup": "set volume output volume ((output volume of (get volume settings)) + 6)",
            "voldown": "set volume output volume ((output volume of (get volume settings)) - 6)",
            "mute": "set volume output muted (not (output muted of (get volume settings)))",
        }[name]
        subprocess.Popen(["osascript", "-e", script], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


# ---------------------------------------------------------------- capture
def _jpeg(img, quality: float) -> bytes:
    data = Q.CFDataCreateMutable(None, 0)
    dest = Q.CGImageDestinationCreateWithData(data, "public.jpeg", 1, None)
    Q.CGImageDestinationAddImage(dest, img, {Q.kCGImageDestinationLossyCompressionQuality: float(quality)})
    if not Q.CGImageDestinationFinalize(dest):
        raise RuntimeError("JPEG encode failed")
    return bytes(data)


def _scaled(img, w: int, h: int):
    cs = Q.CGColorSpaceCreateDeviceRGB()
    ctx = Q.CGBitmapContextCreate(None, w, h, 8, 0, cs, Q.kCGImageAlphaNoneSkipFirst)
    Q.CGContextSetInterpolationQuality(ctx, Q.kCGInterpolationMedium)
    Q.CGContextDrawImage(ctx, Q.CGRectMake(0, 0, w, h), img)
    return Q.CGBitmapContextCreateImage(ctx)


def _wait(start, timeout=5.0):
    """Run an Objective-C call that answers through a completion handler; return the handler's arguments."""
    done = threading.Event()
    box = {}

    def handler(*args):
        box["args"] = args
        done.set()

    start(handler)
    if not done.wait(timeout):
        raise TimeoutError("ScreenCaptureKit did not answer")
    return box["args"]


class SCKCapture:
    """ScreenCaptureKit screenshots (macOS 14+): scaled on the GPU, cursor included."""
    cursor_in_image = True

    def __init__(self):
        import ScreenCaptureKit as SCK
        self.SCK = SCK
        self._content = None

    def _display(self, display_id: int):
        for attempt in range(2):
            if self._content is None or attempt:
                content, err = _wait(lambda h: self.SCK.SCShareableContent.getShareableContentWithCompletionHandler_(h))
                if err is not None or content is None:
                    raise PermissionError(f"Screen Recording not allowed ({err})")
                self._content = content
            for d in self._content.displays():
                if int(d.displayID()) == int(display_id):
                    return d
        raise LookupError(f"display {display_id} not found")

    def grab(self, display_id: int, width: int, quality: float) -> tuple[bytes, int, int]:
        d = self._display(display_id)
        dw, dh = int(d.width()), int(d.height())
        w = max(64, min(int(width), dw * 2))
        h = max(40, int(round(w * dh / dw)))
        filt = self.SCK.SCContentFilter.alloc().initWithDisplay_excludingWindows_(d, [])
        cfg = self.SCK.SCStreamConfiguration.alloc().init()
        cfg.setWidth_(w)
        cfg.setHeight_(h)
        cfg.setShowsCursor_(True)
        img, err = _wait(lambda hnd: self.SCK.SCScreenshotManager.captureImageWithFilter_configuration_completionHandler_(filt, cfg, hnd))
        if err is not None or img is None:
            raise RuntimeError(f"capture failed ({err})")
        return _jpeg(img, quality), w, h


class CGCapture:
    """CoreGraphics fallback (older macOS). No cursor in the picture: the phone draws it."""
    cursor_in_image = False

    def grab(self, display_id: int, width: int, quality: float) -> tuple[bytes, int, int]:
        img = Q.CGDisplayCreateImage(display_id)
        if img is None:
            raise PermissionError("Screen Recording not allowed")
        b = Q.CGDisplayBounds(display_id)
        dw, dh = b.size.width, b.size.height
        w = max(64, min(int(width), Q.CGImageGetWidth(img)))
        h = max(40, int(round(w * dh / dw)))
        return _jpeg(_scaled(img, w, h), quality), w, h


def make_capture():
    try:
        cap = SCKCapture()
        cap.grab(_display_ids()[0], 320, 0.5)
        return cap
    except Exception as exc:                            # noqa: BLE001 - any failure falls back
        first = exc
    try:
        cap = CGCapture()
        cap.grab(_display_ids()[0], 320, 0.5)
        return cap
    except Exception as exc:                            # noqa: BLE001
        raise RuntimeError(f"no way to capture the screen: ScreenCaptureKit: {first} · CoreGraphics: {exc}") from exc


# ---------------------------------------------------------------- permissions
def doctor() -> list[tuple[str, bool, str]]:
    rows = []
    try:
        ok = bool(Q.CGPreflightScreenCaptureAccess())
        if not ok:
            Q.CGRequestScreenCaptureAccess()
        rows.append(("Screen Recording", ok, "" if ok else "System Settings > Privacy & Security > Screen Recording: nyalain Terminal, lalu restart Terminal"))
    except AttributeError:
        rows.append(("Screen Recording", True, "nggak bisa dicek di macOS ini"))
    try:
        import ApplicationServices as AS
        ok = bool(AS.AXIsProcessTrustedWithOptions({AS.kAXTrustedCheckOptionPrompt: True}))
        rows.append(("Accessibility (keyboard + mouse)", ok, "" if ok else "System Settings > Privacy & Security > Accessibility: nyalain Terminal, lalu restart Terminal"))
    except ImportError:
        rows.append(("Accessibility (keyboard + mouse)", False, "pip3 install pyobjc-framework-ApplicationServices"))
    try:
        cap = make_capture()
        rows.append(("Ambil layar", True, type(cap).__name__))
    except Exception as exc:                            # noqa: BLE001
        rows.append(("Ambil layar", False, str(exc)[:200]))
    return rows

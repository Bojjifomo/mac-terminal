"""macOS virtual key codes (ANSI layout) and modifier flags. Pure: no macOS imports, so it is testable anywhere."""
from __future__ import annotations

KEYCODES = {
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
    "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
    "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36,
    "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47,
    "tab": 48, "space": 49, "`": 50, "delete": 51, "escape": 53, "command": 55, "shift": 56, "capslock": 57,
    "option": 58, "control": 59, "rightshift": 60, "rightoption": 61, "rightcontrol": 62, "fn": 63,
    "f17": 64, "f18": 79, "f19": 80, "f20": 90, "f5": 96, "f6": 97, "f7": 98, "f3": 99, "f8": 100, "f9": 101,
    "f11": 103, "f13": 105, "f16": 106, "f14": 107, "f10": 109, "f12": 111, "f15": 113, "home": 115,
    "pageup": 116, "forwarddelete": 117, "f4": 118, "end": 119, "f2": 120, "pagedown": 121, "f1": 122,
    "left": 123, "right": 124, "down": 125, "up": 126, "rightcommand": 54,
}

# CGEventFlags
FLAGS = {"shift": 0x20000, "control": 0x40000, "option": 0x80000, "command": 0x100000, "fn": 0x800000}
MODIFIER_KEYS = {"shift": "shift", "control": "control", "option": "option", "command": "command", "fn": "fn"}

# characters typed with shift on a US keyboard -> base key
SHIFTED = {"!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
           "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/", "~": "`"}


def flags_for(mods) -> int:
    f = 0
    for m in mods or ():
        if m not in FLAGS:
            raise ValueError(f"unknown modifier {m!r}")
        f |= FLAGS[m]
    return f


def resolve(key: str) -> tuple[int, list[str]]:
    """'C' -> (8, ['shift']), '!' -> (18, ['shift']), 'return' -> (36, []). Raises KeyError for unknown keys."""
    if key in KEYCODES:
        return KEYCODES[key], []
    if len(key) == 1 and key.lower() in KEYCODES and key != key.lower():
        return KEYCODES[key.lower()], ["shift"]
    if key in SHIFTED:
        return KEYCODES[SHIFTED[key]], ["shift"]
    raise KeyError(key)

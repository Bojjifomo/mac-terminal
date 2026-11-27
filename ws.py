"""A small WebSocket (RFC 6455) on top of http.server, standard library only.

One connection that stays open is what makes the remote feel fast: the Mac pushes each new picture as soon as it
has one (no request, no round trip per frame) and every tap goes back on the same socket.
"""
from __future__ import annotations

import base64
import hashlib
import struct
import threading

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_MESSAGE = 1 << 20                                 # what the phone may send: input events, never big


def accept_key(key: str) -> str:
    return base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()


def encode(payload: bytes, opcode: int, mask: bytes | None = None) -> bytes:
    n = len(payload)
    head = bytes([0x80 | opcode])
    mbit = 0x80 if mask else 0
    if n < 126:
        head += bytes([mbit | n])
    elif n < 65536:
        head += bytes([mbit | 126]) + struct.pack(">H", n)
    else:
        head += bytes([mbit | 127]) + struct.pack(">Q", n)
    if mask:
        return head + mask + unmask(payload, mask)
    return head + payload


def unmask(data: bytes, mask: bytes) -> bytes:
    if not data:
        return data
    n = len(data)
    key = (mask * (n // 4 + 1))[:n]
    return (int.from_bytes(data, "big") ^ int.from_bytes(key, "big")).to_bytes(n, "big")


class Closed(Exception):
    pass


class WebSocket:
    def __init__(self, rfile, wfile):
        self.r, self.w = rfile, wfile
        self.lock = threading.Lock()
        self.closed = False

    def _write(self, data: bytes) -> None:
        if self.closed:
            raise Closed()
        try:
            with self.lock:
                self.w.write(data)
                self.w.flush()
        except OSError as exc:
            self.closed = True
            raise Closed() from exc

    def send_text(self, s: str) -> None:
        self._write(encode(s.encode(), 0x1))

    def send_bytes(self, b: bytes) -> None:
        self._write(encode(b, 0x2))

    def close(self) -> None:
        if not self.closed:
            try:
                self._write(encode(b"", 0x8))
            except Closed:
                pass
        self.closed = True

    def _read(self, n: int) -> bytes:
        buf = b""
        while len(buf) < n:
            chunk = self.r.read(n - len(buf))
            if not chunk:
                self.closed = True
                raise Closed()
            buf += chunk
        return buf

    def recv(self):
        """The next text (str) or binary (bytes) message; raises Closed when the phone goes away."""
        parts, kind = [], None
        while True:
            b0, b1 = self._read(2)
            fin, opcode = b0 & 0x80, b0 & 0x0F
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            if n > MAX_MESSAGE:
                self.close()
                raise Closed()
            mask = self._read(4) if b1 & 0x80 else None
            data = self._read(n)
            if mask:
                data = unmask(data, mask)
            if opcode == 0x8:                                 # close
                self.close()
                raise Closed()
            if opcode == 0x9:                                 # ping
                self._write(encode(data, 0xA))
                continue
            if opcode == 0xA:                                 # pong
                continue
            if opcode in (0x1, 0x2):
                kind, parts = opcode, [data]
            elif opcode == 0x0:
                parts.append(data)
            if fin and kind is not None:
                msg = b"".join(parts)
                return msg.decode() if kind == 0x1 else msg

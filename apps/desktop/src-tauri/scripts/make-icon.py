#!/usr/bin/env python3
"""Generate the SysCode app icon without any image library (raw PNG writer).

The mark: a small node-graph — three nodes joined by edges — on the app's dark
surface, which is what the product actually is.
"""
import struct
import zlib
from pathlib import Path

W = H = 512
BG = (14, 17, 22, 255)
ACCENT = (122, 162, 247, 255)
MUTED = (139, 147, 163, 255)
EDGE = (58, 66, 80, 255)

px = [[BG for _ in range(W)] for _ in range(H)]


def blend(c, a):
    return c


def disc(cx, cy, r, color):
    for y in range(max(0, cy - r), min(H, cy + r + 1)):
        for x in range(max(0, cx - r), min(W, cx + r + 1)):
            if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                px[y][x] = color


def line(x0, y0, x1, y1, color, width=6):
    steps = int(max(abs(x1 - x0), abs(y1 - y0))) * 2 + 1
    for i in range(steps + 1):
        t = i / steps
        x = int(round(x0 + (x1 - x0) * t))
        y = int(round(y0 + (y1 - y0) * t))
        disc(x, y, width // 2, color)


# rounded background
radius = 96
for y in range(H):
    for x in range(W):
        cx = min(max(x, radius), W - radius)
        cy = min(max(y, radius), H - radius)
        if (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius:
            px[y][x] = BG

# node graph: top hub, two children
nodes = [(256, 150, 34), (140, 340, 26), (372, 340, 26)]
line(256, 150, 140, 340, EDGE, 8)
line(256, 150, 372, 340, EDGE, 8)
line(140, 340, 372, 340, EDGE, 8)
disc(*nodes[0], ACCENT)
disc(*nodes[1], MUTED)
disc(*nodes[2], MUTED)


def chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


raw = b"".join(b"\x00" + bytes(v for p in row for v in p) for row in px)
png = (
    b"\x89PNG\r\n\x1a\n"
    + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0))
    + chunk(b"IDAT", zlib.compress(raw, 9))
    + chunk(b"IEND", b"")
)

out = Path(__file__).resolve().parent.parent / "icons" / "icon.png"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_bytes(png)
print(f"wrote {out} ({len(png)} bytes)")

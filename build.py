"""Build dist\\PortTraffic.exe. Run build.cmd, which sets up the tools first.

Needs pywebview, pyinstaller and pillow in the running Python.
"""
from __future__ import annotations

import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(os.environ.get("LOCALAPPDATA") or HERE, "PortTrafficViz", "build")


def oklch(L: float, C: float, h: float) -> tuple[int, int, int]:
    """OKLCH -> sRGB, lowering chroma until it fits (same as the page's ramp)."""
    hr = math.radians(h)
    while True:
        a, b = C * math.cos(hr), C * math.sin(hr)
        l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
        m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
        s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
        lin = (4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
               -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
               -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)
        if C <= 0 or all(-1e-4 <= x <= 1.0001 for x in lin):
            out = []
            for x in lin:
                x = min(1.0, max(0.0, x))
                x = 12.92 * x if x <= 0.0031308 else 1.055 * x ** (1 / 2.4) - 0.055
                out.append(round(255 * x))
            return tuple(out)
        C = max(0.0, C - 0.004)


STOPS = [(0.58, 0.17, 258), (0.56, 0.19, 285), (0.58, 0.22, 332), (0.62, 0.23, 374), (0.64, 0.23, 388)]


def ramp(t: float) -> tuple[int, int, int]:
    n = len(STOPS) - 1
    x = min(max(t, 0.0), 1.0) * n
    k = min(n - 1, int(x))
    f = x - k
    a, b = STOPS[k], STOPS[k + 1]
    return oklch(*(a[i] + (b[i] - a[i]) * f for i in range(3)))


def make_icon(path: str) -> None:
    """A 3 x 3 isometric bar grid, short blue bars in front, tall red ones behind."""
    from PIL import Image, ImageDraw

    cos30 = math.cos(math.pi / 6)

    def proj(x, y, z):
        return ((x - y) * cos30, (x + y) * 0.5 - z)

    heights = {(0, 0): 2.6, (1, 0): 1.9, (0, 1): 1.6, (2, 0): 1.0, (1, 1): 1.25, (0, 2): 0.8,
               (2, 1): 0.55, (1, 2): 0.45, (2, 2): 0.25}
    cell, bar, plate = 1.0, 0.72, 0.22
    polys = []  # (points in world units, fill)

    def shade(c, k):
        return tuple(round(v * (1 - k)) for v in c)

    # floor plate with a little thickness
    n = 3 * cell
    polys.append(([(0, n, 0), (n, n, 0), (n, n, -plate), (0, n, -plate)], (35, 35, 33)))
    polys.append(([(n, 0, 0), (n, n, 0), (n, n, -plate), (n, 0, -plate)], (21, 21, 20)))
    polys.append(([(0, 0, 0), (n, 0, 0), (n, n, 0), (0, n, 0)], (52, 52, 49)))
    for (gx, gy), hgt in sorted(heights.items(), key=lambda kv: kv[0][0] + kv[0][1]):
        x0 = gx * cell + (cell - bar) / 2
        y0 = gy * cell + (cell - bar) / 2
        x1, y1 = x0 + bar, y0 + bar
        col = ramp(hgt / 2.6)
        polys.append(([(x0, y1, 0), (x1, y1, 0), (x1, y1, hgt), (x0, y1, hgt)], shade(col, 0.22)))
        polys.append(([(x1, y0, 0), (x1, y1, 0), (x1, y1, hgt), (x1, y0, hgt)], shade(col, 0.40)))
        polys.append(([(x0, y0, hgt), (x1, y0, hgt), (x1, y1, hgt), (x0, y1, hgt)], col))

    pts = [proj(*p) for poly, _ in polys for p in poly]
    minx, maxx = min(p[0] for p in pts), max(p[0] for p in pts)
    miny, maxy = min(p[1] for p in pts), max(p[1] for p in pts)
    size = 1024
    margin = size * 0.04
    k = (size - 2 * margin) / max(maxx - minx, maxy - miny)
    ox = (size - (maxx - minx) * k) / 2 - minx * k
    oy = (size - (maxy - miny) * k) / 2 - miny * k

    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for poly, fill in polys:
        d.polygon([(ox + proj(*p)[0] * k, oy + proj(*p)[1] * k) for p in poly], fill=fill + (255,))
    img = img.resize((256, 256), Image.LANCZOS)
    img.save(path, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


def main() -> int:
    import PyInstaller.__main__

    os.makedirs(WORK, exist_ok=True)
    icon = os.path.join(WORK, "PortTraffic.ico")
    make_icon(icon)
    PyInstaller.__main__.run([
        os.path.join(HERE, "desktop.py"),
        "--name", "PortTraffic",
        "--onefile", "--windowed", "--noconfirm", "--clean",
        "--icon", icon,
        "--add-data", f"{os.path.join(HERE, 'web')}{os.pathsep}web",
        "--distpath", os.path.join(HERE, "dist"),
        "--workpath", os.path.join(WORK, "work"),
        "--specpath", WORK,
    ])
    return 0


if __name__ == "__main__":
    sys.exit(main())

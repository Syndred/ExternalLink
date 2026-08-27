#!/usr/bin/env python3
"""Generate ExternalLink Chrome extension icons (16/48/128)."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "extension" / "icons"

# Matches DESIGN.md primary palette
BLUE_TOP = (14, 165, 233)      # #0ea5e9
BLUE_BOTTOM = (2, 132, 199)    # #0284c7
BLUE_EDGE = (3, 105, 161)        # #0369a1
WHITE = (255, 255, 255, 255)
WHITE_SOFT = (255, 255, 255, 210)
GLOW = (186, 230, 253, 90)


def lerp(a: int, b: int, t: float) -> int:
    return int(round(a + (b - a) * t))


def gradient_background(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = img.load()
    radius = size * 0.22
    for y in range(size):
        t = y / max(size - 1, 1)
        row = (
            lerp(BLUE_TOP[0], BLUE_BOTTOM[0], t),
            lerp(BLUE_TOP[1], BLUE_BOTTOM[1], t),
            lerp(BLUE_TOP[2], BLUE_BOTTOM[2], t),
        )
        for x in range(size):
            # Rounded-rect mask
            dx = max(radius - x, 0, x - (size - 1 - radius))
            dy = max(radius - y, 0, y - (size - 1 - radius))
            if dx * dx + dy * dy > radius * radius:
                continue
            px[x, y] = (*row, 255)
    return img


def draw_icon(size: int) -> Image.Image:
    img = gradient_background(size)
    draw = ImageDraw.Draw(img)
    s = size / 128.0

    # Subtle inner highlight
    inset = 10 * s
    draw.rounded_rectangle(
        (inset, inset, size - inset, size - inset),
        radius=18 * s,
        outline=(*WHITE[:3], 36),
        width=max(1, int(round(2 * s))),
    )

    # Soft glow behind the mark
    glow_box = (34 * s, 34 * s, 94 * s, 94 * s)
    draw.ellipse(glow_box, fill=GLOW)

    stroke = max(2, int(round(7 * s)))
    corner = max(2, int(round(5 * s)))

    # External-link box (bottom-left)
    box_left = 30 * s
    box_top = 52 * s
    box_right = 64 * s
    box_bottom = 86 * s
    draw.rounded_rectangle(
        (box_left, box_top, box_right, box_bottom),
        radius=corner,
        outline=WHITE,
        width=stroke,
    )

    # Arrow shaft + head (up-right)
    shaft_start = (68 * s, 60 * s)
    shaft_end = (92 * s, 36 * s)
    draw.line([shaft_start, shaft_end], fill=WHITE, width=stroke, joint="curve")

    head_len = 16 * s
    angle = math.radians(-45)
    hx, hy = shaft_end
    left = (
        hx + head_len * math.cos(angle + math.pi * 0.78),
        hy + head_len * math.sin(angle + math.pi * 0.78),
    )
    right = (
        hx + head_len * math.cos(angle - math.pi * 0.78),
        hy + head_len * math.sin(angle - math.pi * 0.78),
    )
    draw.line([shaft_end, left], fill=WHITE, width=stroke, joint="curve")
    draw.line([shaft_end, right], fill=WHITE, width=stroke, joint="curve")

    # Small chain dot — batch/link hint
    dot_r = max(2, int(round(4 * s)))
    dot_cx, dot_cy = 44 * s, 44 * s
    draw.ellipse(
        (dot_cx - dot_r, dot_cy - dot_r, dot_cx + dot_r, dot_cy + dot_r),
        fill=WHITE_SOFT,
    )

    # Outer rim for toolbar legibility
    draw.rounded_rectangle(
        (1, 1, size - 2, size - 2),
        radius=22 * s,
        outline=(*BLUE_EDGE, 180),
        width=max(1, int(round(2 * s))),
    )

    return img.convert("RGB")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    master = draw_icon(256)
    for size, name in ((128, "icon128.png"), (48, "icon48.png"), (16, "icon16.png")):
        icon = master.resize((size, size), Image.Resampling.LANCZOS)
        path = OUT_DIR / name
        icon.save(path, format="PNG", optimize=True)
        print(f"wrote {path} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()

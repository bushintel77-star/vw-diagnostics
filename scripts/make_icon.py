"""App icon generator: dark rounded square, gauge dial + dyno torque curve.

Draws at 4x and downsamples for clean antialiased edges, then emits the
Windows .ico set (electron-builder's default build/icon.ico), a 512 px PNG,
and overwrites resources/icon.png used by the BrowserWindow.

    python scripts/make_icon.py
"""

import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent

S = 4096          # supersampled canvas
OUT = 1024        # master render size
CORNER = int(S * 0.175)

# App theme colors (theme.css)
BG_TOP = (32, 36, 48)        # dark slate
BG_BOTTOM = (14, 16, 23)     # near-black
TRACK = (255, 255, 255, 46)  # 18% white
ARC = (240, 89, 46)          # chart-1 red-orange (hsl 12 76% 61%)
CURVE = (32, 166, 143)       # chart-2 teal (hsl 173 58% 45%)
NEEDLE = ARC
STROKE_S = int(S * 0.044)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def main() -> None:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Rounded-square background with a vertical gradient (drawn as thin bands
    # clipped to the rounded rect mask).
    grad = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(grad)
    for y in range(S):
        gdraw.line([(0, y), (S, y)], fill=lerp(BG_TOP, BG_BOTTOM, y / S) + (255,))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], CORNER, fill=255)
    img.paste(grad, (0, 0), mask)
    draw = ImageDraw.Draw(img)

    # Subtle top highlight edge
    draw.rounded_rectangle(
        [int(S * 0.008)] * 2 + [S - int(S * 0.008)] * 2,
        CORNER, outline=(255, 255, 255, 26), width=int(S * 0.006),
    )

    cx, cy = S * 0.5, S * 0.47
    r_track = S * 0.335

    # Gauge track: 270-degree sweep, opening at the top
    bbox = [cx - r_track, cy - r_track, cx + r_track, cy + r_track]
    draw.arc(bbox, start=135, end=405, fill=TRACK, width=STROKE_S)

    # Progress arc (the reading): ~200 degrees of the sweep
    draw.arc(bbox, start=135, end=330, fill=ARC, width=STROKE_S)

    # Tick marks at 25% steps along the sweep
    for angle in (135, 202.5, 270, 337.5, 405):
        rad = math.radians(angle)
        x1 = cx + (r_track - STROKE_S * 0.95) * math.cos(rad)
        y1 = cy + (r_track - STROKE_S * 0.95) * math.sin(rad)
        x2 = cx + (r_track + STROKE_S * 0.95) * math.cos(rad)
        y2 = cy + (r_track + STROKE_S * 0.95) * math.sin(rad)
        draw.line([x1, y1, x2, y2], fill=(255, 255, 255, 90), width=int(S * 0.008))

    # Needle pointing into the red zone (upper right, ~348 degrees)
    rad = math.radians(348)
    nx = cx + r_track * 0.72 * math.cos(rad)
    ny = cy + r_track * 0.72 * math.sin(rad)
    draw.line([cx, cy, nx, ny], fill=NEEDLE, width=int(S * 0.030), joint="curve")
    draw.ellipse(
        [cx - S * 0.030, cy - S * 0.030, cx + S * 0.030, cy + S * 0.030],
        fill=NEEDLE,
    )
    draw.ellipse(
        [cx - S * 0.013, cy - S * 0.013, cx + S * 0.013, cy + S * 0.013],
        fill=BG_BOTTOM,
    )

    # Dyno torque curve sweeping across the lower third: rise, plateau, taper
    curve = [
        (S * 0.22, S * 0.760),
        (S * 0.34, S * 0.700),
        (S * 0.46, S * 0.600),
        (S * 0.58, S * 0.575),
        (S * 0.70, S * 0.575),
        (S * 0.80, S * 0.620),
        (S * 0.86, S * 0.660),
    ]
    draw.line(curve, fill=CURVE, width=int(S * 0.026), joint="curve")
    # endpoint dot
    draw.ellipse(
        [curve[-1][0] - S * 0.014, curve[-1][1] - S * 0.014,
         curve[-1][0] + S * 0.014, curve[-1][1] + S * 0.014],
        fill=CURVE,
    )

    master = img.resize((OUT, OUT), Image.LANCZOS)

    build = ROOT / "build"
    build.mkdir(exist_ok=True)
    master.save(build / "icon.png")
    master.save(
        build / "icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    master.resize((512, 512), Image.LANCZOS).save(ROOT / "resources" / "icon.png")

    print("wrote build/icon.ico, build/icon.png, resources/icon.png")


if __name__ == "__main__":
    main()

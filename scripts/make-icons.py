"""Draws the PNG app icons from public/icon.svg's design (navy rounded square,
white E, gold dot) into public/icons/. iPhones ignore SVG for Add to Home
Screen, and Android wants PNGs in the manifest.

    python scripts/make-icons.py

- apple-touch-icon.png 180x180: full-bleed square, no transparency (iOS rounds it)
- icon-192.png, icon-512.png: the SVG as drawn, rounded corners transparent
- maskable-512.png: full-bleed, the art scaled into the safe zone (the middle
  80% circle), so any mask shape the phone uses keeps all of it
"""
from pathlib import Path
from PIL import Image, ImageDraw

NAVY, WHITE, GOLD = (0x14, 0x21, 0x3d), (0xff, 0xff, 0xff), (0xb7, 0x79, 0x1f)
# public/icon.svg, in its 512 x 512 viewBox
E = [(152, 136), (360, 136), (360, 188), (214, 188), (214, 232), (340, 232), (340, 282),
     (214, 282), (214, 324), (360, 324), (360, 376), (152, 376)]
DOT, DOT_R, RX = (380, 384), 28, 112
SS = 4  # drawn at 4x and scaled down, for smooth edges
OUT = Path(__file__).resolve().parent.parent / 'public' / 'icons'


def draw(size, rounded, art_scale=1.0):
    big = size * SS
    k = big / 512
    img = Image.new('RGBA' if rounded else 'RGB', (big, big), (0, 0, 0, 0) if rounded else NAVY)
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle([0, 0, big - 1, big - 1], radius=RX * k, fill=NAVY)
    # Art scaled about the centre (256, 256) of the viewBox.
    p = lambda x, y: ((256 + (x - 256) * art_scale) * k, (256 + (y - 256) * art_scale) * k)
    d.polygon([p(x, y) for x, y in E], fill=WHITE)
    cx, cy = p(*DOT)
    r = DOT_R * art_scale * k
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=GOLD)
    return img.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    draw(180, rounded=False).save(OUT / 'apple-touch-icon.png', optimize=True)
    draw(192, rounded=True).save(OUT / 'icon-192.png', optimize=True)
    draw(512, rounded=True).save(OUT / 'icon-512.png', optimize=True)
    # At full size the gold dot reaches 206 px from the centre, just past the
    # 204.8 px safe-zone radius; at 0.8 everything sits within 165 px.
    draw(512, rounded=False, art_scale=0.8).save(OUT / 'maskable-512.png', optimize=True)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Generate a placeholder 1024x1024 app icon for ProPlan (a simple gradient
tile with a mini Gantt-bar motif). `tauri icon` derives the full icon set
(icns/ico/pngs) from this single source image. Swap this out any time by
replacing icons/icon-source.png and re-running `npx tauri icon`."""
from PIL import Image, ImageDraw

SIZE = 1024
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Rounded-square background, vertical gradient indigo -> blue.
top = (99, 102, 241)      # #6366f1
bottom = (56, 189, 248)   # #38bdf8
grad = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
gd = ImageDraw.Draw(grad)
for y in range(SIZE):
    t = y / (SIZE - 1)
    r = round(top[0] + (bottom[0] - top[0]) * t)
    g = round(top[1] + (bottom[1] - top[1]) * t)
    b = round(top[2] + (bottom[2] - top[2]) * t)
    gd.line([(0, y), (SIZE, y)], fill=(r, g, b, 255))

mask = Image.new("L", (SIZE, SIZE), 0)
md = ImageDraw.Draw(mask)
radius = int(SIZE * 0.22)
md.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=radius, fill=255)
img = Image.composite(grad, img, mask)
draw = ImageDraw.Draw(img)

# Three horizontal "Gantt bars" of decreasing width, staggered — the app's
# core visual motif — in translucent white.
bar_h = int(SIZE * 0.085)
gap = int(SIZE * 0.06)
left = int(SIZE * 0.20)
widths = [0.60, 0.46, 0.33]
starts_y = int(SIZE * 0.30)
bar_radius = bar_h // 2
for i, w in enumerate(widths):
    y0 = starts_y + i * (bar_h + gap)
    y1 = y0 + bar_h
    x0 = left + int(i * SIZE * 0.07)
    x1 = x0 + int(SIZE * w)
    draw.rounded_rectangle([x0, y0, x1, y1], radius=bar_radius, fill=(255, 255, 255, 235))

out = "src-tauri/icons/icon-source.png"
img.save(out)
print(f"wrote {out} ({SIZE}x{SIZE})")

"""Draw the app and tray icons (a mic in Kritvia's indigo). Run: python3 scripts/make_icons.py"""
from PIL import Image, ImageDraw

INDIGO = (79, 70, 229, 255)


def mic(draw, s, cx, cy, color, w):
    bw, bh = s * 0.22, s * 0.36
    draw.rounded_rectangle([cx - bw / 2, cy - bh * 0.75, cx + bw / 2, cy + bh * 0.25], radius=bw / 2, fill=color)
    r = s * 0.24
    draw.arc([cx - r, cy - r * 0.95, cx + r, cy + r * 1.05], start=0, end=180, fill=color, width=w)
    draw.line([cx, cy + r * 1.05, cx, cy + r * 1.5], fill=color, width=w)
    draw.line([cx - r * 0.55, cy + r * 1.5, cx + r * 0.55, cy + r * 1.5], fill=color, width=w)


def app_icon(size=1024):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([size * 0.06] * 2 + [size * 0.94] * 2, radius=size * 0.22, fill=INDIGO)
    mic(d, size, size / 2, size / 2, (255, 255, 255, 255), int(size * 0.045))
    return img


def tray_icon(size, color):
    img = Image.new("RGBA", (size * 4, size * 4), (0, 0, 0, 0))
    mic(ImageDraw.Draw(img), size * 4 * 1.25, size * 2, size * 1.85, color, size // 3 or 1)
    return img.resize((size, size), Image.LANCZOS)


app_icon().resize((512, 512), Image.LANCZOS).save("assets/icon.png")
tray_icon(32, INDIGO).save("assets/tray.png")
tray_icon(22, (0, 0, 0, 255)).save("assets/trayTemplate.png")
tray_icon(44, (0, 0, 0, 255)).save("assets/trayTemplate@2x.png")
print("icons written to assets/")

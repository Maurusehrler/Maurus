#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Erzeugt die App-Icons (PNG) für iPhone/iPad und den Browser.
Nur einmal nötig – die Icons liegen danach in docs/icons/.
Aufruf: python scripts/make_icons.py   (benötigt: pip install pillow)
"""
from pathlib import Path
from PIL import Image, ImageDraw

ZIEL = Path(__file__).resolve().parent.parent / "docs" / "icons"
ZIEL.mkdir(parents=True, exist_ok=True)


def icon(groesse: int, rand: float = 0.0) -> Image.Image:
    """Zeichnet das Icon: dunkler Verlauf, grüne Kurslinie, kleines Schweizer Kreuz."""
    s = 4 * groesse                      # gross zeichnen, dann verkleinern = glatte Kanten
    img = Image.new("RGB", (s, s))
    d = ImageDraw.Draw(img)
    for y in range(s):                   # Hintergrund-Verlauf (dunkelblau)
        t = y / s
        d.line([(0, y), (s, y)], fill=(int(14 + 10 * t), int(22 + 18 * t), int(48 + 30 * t)))
    p = s * (0.16 + rand)                # Innenabstand (grösser bei "maskable")
    w = s - 2 * p
    # Kurslinie
    punkte = [(0.00, 0.78), (0.18, 0.62), (0.34, 0.70), (0.52, 0.42), (0.68, 0.52), (1.00, 0.16)]
    xy = [(p + x * w, p + y * w) for x, y in punkte]
    # Fläche unter der Linie (halbtransparent grün)
    flaeche = Image.new("RGBA", (s, s))
    ImageDraw.Draw(flaeche).polygon(xy + [(p + w, p + w), (p, p + w)], fill=(34, 197, 94, 70))
    img.paste(flaeche, (0, 0), flaeche)
    d.line(xy, fill=(52, 211, 120), width=int(s * 0.055), joint="curve")
    r = s * 0.035
    for x, y in xy[-1:]:
        d.ellipse([x - 2 * r, y - 2 * r, x + 2 * r, y + 2 * r], fill=(52, 211, 120))
    # Schweizer Kreuz oben links
    k = s * 0.13
    kx, ky = p, p
    d.rounded_rectangle([kx, ky, kx + k, ky + k], radius=k * 0.12, fill=(218, 41, 28))
    a, b = k * 0.2, k * 0.4
    d.rectangle([kx + b, ky + a, kx + k - b, ky + k - a], fill="white")
    d.rectangle([kx + a, ky + b, kx + k - a, ky + k - b], fill="white")
    return img.resize((groesse, groesse), Image.LANCZOS)


for g in (180, 192, 512):
    icon(g).save(ZIEL / f"icon-{g}.png", optimize=True)
icon(512, rand=0.08).save(ZIEL / "icon-maskable-512.png", optimize=True)
icon(64).save(ZIEL / "favicon.png", optimize=True)
print("Icons erstellt in", ZIEL)

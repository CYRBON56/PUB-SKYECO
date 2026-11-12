from PIL import Image, ImageDraw, ImageFont, ImageFilter
import math

NAVY = (22, 58, 99)
NAVY2 = (14, 40, 70)
BLUE = (44, 93, 143)
YEL = (255, 199, 44)
WHITE = (255, 255, 255)
CREAM = (246, 243, 236)
INK = (24, 32, 44)
GREY = (110, 120, 135)
LGREY = (225, 229, 235)
RED = (226, 76, 60)
GREEN = (46, 160, 90)
ORANGE = (243, 128, 32)

F = "/usr/share/fonts/opentype/inter/Inter-%s.otf"
_cache = {}


def font(w, s):
    k = (w, s)
    if k not in _cache:
        _cache[k] = ImageFont.truetype(F % w, s)
    return _cache[k]


def wrap(d, text, fnt, maxw):
    lines = []
    for para in text.split("\n"):
        words = para.split(" ")
        cur = ""
        for w in words:
            t = (cur + " " + w).strip()
            if d.textlength(t, font=fnt) <= maxw:
                cur = t
            else:
                if cur:
                    lines.append(cur)
                cur = w
        lines.append(cur)
    return lines


def text_block(d, xy, text, fnt, fill, maxw, lh=1.18, align="left", hl=None, hlfill=YEL):
    """Draw wrapped text; words in hl set are coloured hlfill. Returns bottom y."""
    x, y = xy
    hl = hl or set()
    lines = wrap(d, text, fnt, maxw)
    size = fnt.size
    for ln in lines:
        lw = d.textlength(ln, font=fnt)
        cx = x if align == "left" else x + (maxw - lw) / 2
        for i, w in enumerate(ln.split(" ")):
            token = w.strip(".,:;!?…»«")
            col = hlfill if token in hl else fill
            d.text((cx, y), w, font=fnt, fill=col)
            cx += d.textlength(w + " ", font=fnt)
        y += size * lh
    return y


def logo(size):
    S = 4
    im = Image.new("RGBA", (512 * S, 512 * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, 512 * S, 512 * S), 112 * S, fill=NAVY)
    d.rounded_rectangle((8 * S, 8 * S, 504 * S, 504 * S), 105 * S, outline=BLUE, width=16 * S)

    def pl(pts, col, w):
        pts = [(a * S, b * S) for a, b in pts]
        d.line(pts, fill=col, width=w * S, joint="curve")
        for p in (pts[0], pts[-1]):
            r = w * S / 2
            d.ellipse((p[0] - r, p[1] - r, p[0] + r, p[1] + r), fill=col)
    pl([(96, 250), (256, 112), (416, 250)], YEL, 40)
    pl([(150, 230), (150, 400), (362, 400), (362, 230)], WHITE, 32)
    pl([(196, 312), (240, 356), (320, 270)], YEL, 40)
    return im.resize((size, size), Image.LANCZOS)


def brand_row(img, x, y, size=64, color=WHITE, sub=None):
    img.alpha_composite(logo(size), (x, y))
    d = ImageDraw.Draw(img)
    f = font("ExtraBold", int(size * 0.5))
    d.text((x + size + 20, y + size * 0.5), "Contact Chantier", font=f, fill=color, anchor="lm")


def shadow(img, box, radius=36, off=14, blur=28, alpha=70):
    x0, y0, x1, y1 = box
    sh = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((x0, y0 + off, x1, y1 + off), radius, fill=(0, 0, 0, alpha))
    sh = sh.filter(ImageFilter.GaussianBlur(blur))
    img.alpha_composite(sh)


def card(img, box, radius=36, fill=WHITE, sh=True):
    if sh:
        shadow(img, box, radius)
    ImageDraw.Draw(img).rounded_rectangle(box, radius, fill=fill)


def bg_navy(w, h):
    im = Image.new("RGBA", (w, h), NAVY)
    d = ImageDraw.Draw(im)
    # subtle diagonal gradient
    for i in range(h):
        t = i / h
        c = tuple(int(NAVY[k] * (1 - t) + NAVY2[k] * t) for k in range(3))
        d.line((0, i, w, i), fill=c)
    # blueprint grid
    g = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(g)
    for x in range(0, w, 60):
        gd.line((x, 0, x, h), fill=(255, 255, 255, 10), width=1)
    for y in range(0, h, 60):
        gd.line((0, y, w, y), fill=(255, 255, 255, 10), width=1)
    im.alpha_composite(g)
    return im


def bg_cream(w, h):
    im = Image.new("RGBA", (w, h), CREAM)
    g = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(g)
    for x in range(0, w, 60):
        gd.line((x, 0, x, h), fill=(22, 58, 99, 14), width=1)
    for y in range(0, h, 60):
        gd.line((0, y, w, y), fill=(22, 58, 99, 14), width=1)
    im.alpha_composite(g)
    return im


def pill(d, xy, text, fnt, fill, txt, padx=26, pady=14, anchor="l"):
    x, y = xy
    tw = d.textlength(text, font=fnt)
    h = fnt.size + 2 * pady
    if anchor == "c":
        x = x - (tw + 2 * padx) / 2
    d.rounded_rectangle((x, y, x + tw + 2 * padx, y + h), h / 2, fill=fill)
    d.text((x + padx, y + h / 2), text, font=fnt, fill=txt, anchor="lm")
    return x + tw + 2 * padx, y + h


def check_icon(d, cx, cy, r, bg=GREEN, fg=WHITE):
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=bg)
    w = max(3, int(r * 0.28))
    d.line([(cx - r * 0.45, cy + r * 0.02), (cx - r * 0.12, cy + r * 0.35), (cx + r * 0.48, cy - r * 0.32)], fill=fg, width=w, joint="curve")


def plan_house(img, box, t_lines=1.0):
    """Draw a simple architectural floor plan inside box on white."""
    x0, y0, x1, y1 = box
    d = ImageDraw.Draw(img)
    W = x1 - x0
    H = y1 - y0
    wall = (40, 52, 70)
    lw = max(6, int(W / 90))
    # outer walls
    d.rectangle((x0, y0, x1, y1), outline=wall, width=lw)
    # internal walls
    def L(a, b, c, e, w=None):
        d.line((x0 + W * a, y0 + H * b, x0 + W * c, y0 + H * e), fill=wall, width=w or int(lw * 0.7))
    L(0.55, 0, 0.55, 0.42)
    L(0.55, 0.58, 0.55, 1)
    L(0.55, 0.5, 1, 0.5)
    L(0.78, 0.5, 0.78, 1)
    L(0, 0.62, 0.3, 0.62)
    L(0.42, 0.62, 0.55, 0.62)
    fl = font("Medium", max(14, int(W / 34)))
    lab = GREY
    d.text((x0 + W * 0.27, y0 + H * 0.3), "Séjour", font=fl, fill=lab, anchor="mm")
    d.text((x0 + W * 0.77, y0 + H * 0.25), "Chambre 1", font=fl, fill=lab, anchor="mm")
    d.text((x0 + W * 0.66, y0 + H * 0.76), "SdB", font=fl, fill=lab, anchor="mm")
    d.text((x0 + W * 0.89, y0 + H * 0.76), "WC", font=fl, fill=lab, anchor="mm")
    d.text((x0 + W * 0.27, y0 + H * 0.82), "Cuisine", font=fl, fill=lab, anchor="mm")


def pin(img, cx, cy, r, col, glyph, scale=1.0):
    if r * scale < 4:
        return
    r = r * scale
    d = ImageDraw.Draw(img)
    shadow(img, (cx - r, cy - r, cx + r, cy + r), radius=int(r), off=4, blur=8, alpha=60)
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=col, outline=WHITE, width=max(3, int(r * 0.14)))
    if glyph == "check":
        w = max(3, int(r * 0.24))
        d.line([(cx - r * 0.42, cy + r * 0.02), (cx - r * 0.1, cy + r * 0.34), (cx + r * 0.45, cy - r * 0.3)], fill=WHITE, width=w, joint="curve")
    elif glyph == "cam":
        d.rounded_rectangle((cx - r * 0.5, cy - r * 0.3, cx + r * 0.5, cy + r * 0.38), r * 0.1, fill=WHITE)
        d.rectangle((cx - r * 0.18, cy - r * 0.42, cx + r * 0.18, cy - r * 0.28), fill=WHITE)
        d.ellipse((cx - r * 0.2, cy - r * 0.16, cx + r * 0.2, cy + r * 0.24), fill=col)
    else:
        d.text((cx, cy), glyph, font=font("ExtraBold", int(r * 1.05)), fill=WHITE, anchor="mm")


def label_card(img, x, y, title, sub, col, maxw=420, scale=1.0, alpha=1.0):
    if alpha <= 0:
        return
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    ft = font("Bold", 30)
    fs = font("Medium", 25)
    tw = max(d.textlength(title, font=ft), d.textlength(sub, font=fs))
    w = min(maxw, tw + 64)
    h = 108
    shadow(layer, (x, y, x + w, y + h), radius=22, off=8, blur=16, alpha=55)
    d.rounded_rectangle((x, y, x + w, y + h), 22, fill=WHITE)
    d.rounded_rectangle((x, y, x + 10, y + h), 5, fill=col)
    d.text((x + 30, y + 22), title, font=ft, fill=INK)
    d.text((x + 30, y + 62), sub, font=fs, fill=GREY)
    if alpha < 1:
        a = layer.getchannel("A").point(lambda v: int(v * alpha))
        layer.putalpha(a)
    img.alpha_composite(layer)


def ease(t):
    t = max(0.0, min(1.0, t))
    return 1 - (1 - t) ** 3


def pop(t):
    """overshoot pop 0->1"""
    t = max(0.0, min(1.0, t))
    c1, c3 = 1.70158, 2.70158
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2

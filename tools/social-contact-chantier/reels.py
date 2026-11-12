import sys, os, subprocess
sys.path.insert(0, "/tmp/cc")
from lib import *
import posts

W, H = 1080, 1920
FPS = 30
OUT = "/tmp/cc/out"
XF = 0.35  # crossfade seconds
_bg_n = bg_navy(W, H)
_bg_c = bg_cream(W, H)
LIGHT = (205, 218, 235)


def BN():
    return _bg_n.copy()


def BC():
    return _bg_c.copy()


def fade_text(img, xy, text, fnt, fill, maxw, t, lh=1.12, align="left", hl=None, hlfill=YEL, dy=40):
    """text appears with slide-up + fade, t in 0..1"""
    a = ease(t)
    if a <= 0:
        return xy[1] + fnt.size * lh * len(wrap(ImageDraw.Draw(img), text, fnt, maxw))
    lay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    y = text_block(ImageDraw.Draw(lay), (xy[0], xy[1] + dy * (1 - a)), text, fnt, fill, maxw, lh=lh, align=align, hl=hl, hlfill=hlfill)
    if a < 1:
        lay.putalpha(lay.getchannel("A").point(lambda v: int(v * a)))
    img.alpha_composite(lay)
    return y - dy * (1 - a)


def with_alpha(img, layer, a):
    if a <= 0:
        return
    if a < 1:
        layer.putalpha(layer.getchannel("A").point(lambda v: int(v * a)))
    img.alpha_composite(layer)


def header(img, dark=True):
    brand_row(img, 80, 120, 72, color=WHITE if dark else NAVY)


def step_badge(img, n, label, t, dark=True):
    lay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    pill(d, (80, 300), f"ÉTAPE {n}/3", font("Bold", 30), YEL if dark else NAVY, NAVY if dark else WHITE)
    with_alpha(img, lay, ease(t * 2))


def cta_scene(lt, dur):
    im = BN()
    d = ImageDraw.Draw(im)
    s = pop(lt / 0.6)
    size = max(1, int(240 * s))
    im.alpha_composite(logo(size), ((W - size) // 2, 330 + (240 - size) // 2))
    fade_text(im, (90, 640), "Contact Chantier", font("ExtraBold", 80), WHITE, 900, (lt - 0.2) / 0.5, align="center")
    fade_text(im, (90, 740), "le suivi de chantier entre artisans", font("Medium", 40), LIGHT, 900, (lt - 0.3) / 0.5, align="center")
    y = fade_text(im, (90, 900), "3 mois offerts", font("ExtraBold", 100), YEL, 900, (lt - 0.5) / 0.5, align="center")
    fade_text(im, (90, y + 20), "Sans carte bancaire · artisans gratuits", font("SemiBold", 40), WHITE, 900, (lt - 0.7) / 0.5, align="center")
    lay = Image.new("RGBA", im.size, (0, 0, 0, 0))
    ld = ImageDraw.Draw(lay)
    bw, bh = 720, 130
    by = 1260
    pulse = 1 + 0.03 * math.sin(lt * 6) if lt > 1.2 else 1
    bw2, bh2 = bw * pulse, bh * pulse
    ld.rounded_rectangle(((W - bw2) / 2, by + (bh - bh2) / 2, (W + bw2) / 2, by + (bh + bh2) / 2), bh2 / 2, fill=YEL)
    ld.text((W / 2, by + bh / 2), "contactchantier.com", font=font("ExtraBold", 52), fill=NAVY, anchor="mm")
    with_alpha(im, lay, ease((lt - 0.9) / 0.4))
    return im


def render(name, scenes):
    total = sum(s[0] for s in scenes)
    n = int(round(total * FPS))
    tmp = f"{OUT}/{name}.tmp.mp4"
    p = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                          "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
                          "-shortest", "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p", "-profile:v", "high",
                          "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", tmp], stdin=subprocess.PIPE)
    starts = []
    acc = 0
    for s in scenes:
        starts.append(acc)
        acc += s[0]
    for f in range(n):
        t = f / FPS
        k = max(i for i in range(len(scenes)) if starts[i] <= t + 1e-9)
        lt = t - starts[k]
        fr = scenes[k][1](lt, scenes[k][0])
        if k > 0 and lt < XF:
            prev = scenes[k - 1][1](scenes[k - 1][0], scenes[k - 1][0])
            fr = Image.blend(prev.convert("RGB"), fr.convert("RGB"), ease(lt / XF))
        p.stdin.write(fr.convert("RGB").tobytes())
    p.stdin.close()
    assert p.wait() == 0
    os.replace(tmp, f"{OUT}/{name}.mp4")


def still(name, fn, t, dur=10):
    fn(t, dur).convert("RGB").save(f"{OUT}/{name}.jpg", quality=90)


# ======================= REEL 1 : 3 étapes =======================
def r1_hook(lt, dur):
    im = BN()
    header(im)
    f = font("ExtraBold", 120)
    y = 470
    for i, (w, c) in enumerate([("Un chantier.", WHITE), ("10 artisans.", WHITE), ("200 SMS.", YEL)]):
        y = fade_text(im, (80, y), w, f, c, 940, (lt - i * 0.45) / 0.35) + 10
    fade_text(im, (80, y + 60), "Et si tout tenait au même endroit ?", font("Bold", 54), LIGHT, 900, (lt - 1.7) / 0.4)
    return im


LOTS = [("Plomberie", BLUE), ("Électricité", ORANGE), ("Maçonnerie", RED), ("Menuiserie", GREEN), ("Peinture", (130, 90, 190)), ("Carrelage", (20, 140, 150))]


def r1_s1(lt, dur):
    im = BC()
    header(im, dark=False)
    step_badge(im, 1, "", lt, dark=False)
    y = fade_text(im, (80, 400), "Créez le chantier et déposez le CCTP", font("ExtraBold", 84), INK, 920, lt / 0.4, hl={"CCTP"}, hlfill=BLUE)
    # document
    dt = ease((lt - 0.4) / 0.4)
    lay = Image.new("RGBA", im.size, (0, 0, 0, 0))
    dx, dy = 290, y + 70 + 60 * (1 - dt)
    card(lay, (dx, dy, dx + 500, dy + 330), radius=24)
    ld = ImageDraw.Draw(lay)
    ld.rounded_rectangle((dx + 40, dy + 40, dx + 150, dy + 90), 12, fill=RED)
    ld.text((dx + 95, dy + 65), "PDF", font=font("ExtraBold", 30), fill=WHITE, anchor="mm")
    ld.text((dx + 175, dy + 65), "CCTP_maison.pdf", font=font("Bold", 32), fill=INK, anchor="lm")
    for i in range(5):
        ld.rounded_rectangle((dx + 40, dy + 130 + i * 38, dx + 460 - (i % 3) * 70, dy + 146 + i * 38), 8, fill=LGREY)
    with_alpha(im, lay, dt)
    d = ImageDraw.Draw(im)
    # lots pop
    by = y + 480
    fl = font("Bold", 36)
    x = 80
    row = 0
    for i, (lot, col) in enumerate(LOTS):
        s = pop((lt - 1.1 - i * 0.18) / 0.35)
        tw = d.textlength(lot, font=fl) + 70
        if x + tw > W - 80:
            x = 80
            row += 1
        if s > 0:
            lay = Image.new("RGBA", im.size, (0, 0, 0, 0))
            ld = ImageDraw.Draw(lay)
            yy = by + row * 100
            ld.rounded_rectangle((x, yy, x + tw, yy + 76), 38, fill=col)
            ld.text((x + tw / 2, yy + 38), lot, font=fl, fill=WHITE, anchor="mm")
            with_alpha(im, lay, min(1, s))
        x += tw + 20
    fade_text(im, (80, by + 260), "Chaque corps de métier reçoit ses articles.", font("SemiBold", 44), GREY, 920, (lt - 2.3) / 0.4)
    return im


def phone(img, x, y, w, h):
    shadow(img, (x, y, x + w, y + h), radius=70, off=20, blur=30, alpha=90)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((x, y, x + w, y + h), 70, fill=(18, 22, 30))
    d.rounded_rectangle((x + 18, y + 18, x + w - 18, y + h - 18), 56, fill=(242, 242, 247))
    d.rounded_rectangle((x + w / 2 - 80, y + 34, x + w / 2 + 80, y + 70), 18, fill=(18, 22, 30))
    return (x + 18, y + 18, x + w - 18, y + h - 18)


def r1_s2(lt, dur):
    im = BN()
    header(im)
    step_badge(im, 2, "", lt)
    y = fade_text(im, (80, 400), "Chaque artisan reçoit son lien par SMS", font("ExtraBold", 84), WHITE, 920, lt / 0.4, hl={"SMS"})
    pt = ease((lt - 0.3) / 0.5)
    lay = Image.new("RGBA", im.size, (0, 0, 0, 0))
    px, py = 250, y + 60 + 200 * (1 - pt)
    sx0, sy0, sx1, sy1 = phone(lay, px, py, 580, 760)
    ld = ImageDraw.Draw(lay)
    ld.text(((sx0 + sx1) / 2, sy0 + 100), "Messages", font=font("Bold", 30), fill=INK, anchor="mm")
    ld.line((sx0, sy0 + 140, sx1, sy0 + 140), fill=LGREY, width=2)
    with_alpha(im, lay, pt)
    bt = ease((lt - 1.0) / 0.4)
    if bt > 0:
        lay = Image.new("RGBA", im.size, (0, 0, 0, 0))
        ld = ImageDraw.Draw(lay)
        bx0, by0 = sx0 + 30, sy0 + 190 + 30 * (1 - bt)
        msg = "Bonjour Paul, voici votre accès au chantier Maison Le Goff :"
        fm = font("Medium", 30)
        lines = wrap(ld, msg, fm, 400)
        bh = 50 + len(lines) * 40 + 60
        ld.rounded_rectangle((bx0, by0, bx0 + 460, by0 + bh), 30, fill=(229, 229, 234))
        yy = by0 + 28
        for ln in lines:
            ld.text((bx0 + 28, yy), ln, font=fm, fill=INK)
            yy += 40
        ld.text((bx0 + 28, yy + 8), "contactchantier.com/c/…", font=font("SemiBold", 30), fill=(10, 110, 230))
        with_alpha(im, lay, bt)
    # tap → opens
    ct = ease((lt - 1.9) / 0.4)
    if ct > 0:
        lay = Image.new("RGBA", im.size, (0, 0, 0, 0))
        ld = ImageDraw.Draw(lay)
        cy0 = sy0 + 480 + 30 * (1 - ct)
        ld.rounded_rectangle((sx0 + 30, cy0, sx1 - 30, cy0 + 200), 28, fill=WHITE)
        ld.rounded_rectangle((sx0 + 30, cy0, sx0 + 42, cy0 + 200), 6, fill=BLUE)
        ld.text((sx0 + 70, cy0 + 50), "Lot Plomberie", font=font("Bold", 34), fill=INK, anchor="lm")
        ld.text((sx0 + 70, cy0 + 105), "4 tâches · 2 plans · 1 message", font=font("Medium", 28), fill=GREY, anchor="lm")
        ld.text((sx0 + 70, cy0 + 155), "Ouvert sans compte ✓", font=font("SemiBold", 28), fill=GREEN, anchor="lm")
        with_alpha(im, lay, ct)
    fade_text(im, (80, 1560), "Pas de compte. Pas d'appli à installer.", font("Bold", 46), YEL, 920, (lt - 2.4) / 0.4, align="center")
    return im


def r1_s3(lt, dur, badge=True, title="Les problèmes arrivent en photo, sur le plan"):
    im = BC()
    header(im, dark=False)
    if badge:
        step_badge(im, 3, "", lt, dark=False)
    y = fade_text(im, (80, 400), title, font("ExtraBold", 80), INK, 920, lt / 0.4, hl={"plan"}, hlfill=BLUE)
    box = (60, y + 60, W - 60, y + 60 + 640)
    prog = [(lt - 0.6 - i * 0.55) / 0.35 for i in range(4)]
    pts = posts.plan_scene(im, box, prog=prog, r=40)
    # label card for latest pin
    ly = box[3] + 50
    for i, (cx, cy, col, t, s) in enumerate(pts):
        a = ease((lt - 0.75 - i * 0.55) / 0.3)
        nxt = ease((lt - 0.75 - (i + 1) * 0.55) / 0.3) if i < 3 else 0
        if a > 0 and nxt < 1:
            label_card(im, 80, ly + 20 * (1 - a), t, s, col, maxw=920, alpha=a * (1 - nxt))
    return im


def r1():
    render("reel1_3etapes", [(3.2, r1_hook), (3.6, r1_s1), (3.6, r1_s2), (3.6, r1_s3), (3.4, cta_scene)])


# ======================= REEL 2 : le plan =======================
def r2_hook(lt, dur):
    im = BN()
    header(im)
    y = fade_text(im, (80, 520), "Le plombier laisse une photo…", font("ExtraBold", 104), WHITE, 920, lt / 0.4)
    y = fade_text(im, (80, y + 30), "…pour l'électricien.", font("ExtraBold", 104), YEL, 920, (lt - 0.9) / 0.4)
    fade_text(im, (80, y + 80), "Sans un seul SMS.", font("Bold", 56), LIGHT, 920, (lt - 1.7) / 0.4)
    return im


def r2_plan(lt, dur):
    return r1_s3(lt * 1.0, dur, badge=False, title="Tout le chantier, sur un seul plan")


def r2_office(lt, dur):
    im = BN()
    header(im)
    y = fade_text(im, (80, 420), "Vous, au bureau :", font("ExtraBold", 84), WHITE, 920, lt / 0.4)
    items = [("Vous voyez tout", "Photos, vidéos, messages vocaux"), ("Vous validez", "Ou vous renvoyez avec une note"), ("Vous relancez", "Le bon artisan, au bon moment")]
    yy = y + 60
    for i, (t, s) in enumerate(items):
        a = ease((lt - 0.5 - i * 0.4) / 0.35)
        lay = Image.new("RGBA", im.size, (0, 0, 0, 0))
        ox = 60 * (1 - a)
        card(lay, (80 + ox, yy, W - 80 + ox, yy + 190), radius=30)
        ld = ImageDraw.Draw(lay)
        check_icon(ld, 165 + ox, yy + 95, 42)
        ld.text((240 + ox, yy + 70), t, font=font("Bold", 46), fill=INK, anchor="lm")
        ld.text((240 + ox, yy + 128), s, font=font("Medium", 34), fill=GREY, anchor="lm")
        with_alpha(im, lay, a)
        yy += 220
    fade_text(im, (80, yy + 40), "Le compte rendu se prépare tout seul.", font("Bold", 46), YEL, 920, (lt - 1.9) / 0.4)
    return im


def r2():
    render("reel2_plan", [(3.0, r2_hook), (3.8, r2_plan), (3.4, r2_office), (3.4, cta_scene)])


# ======================= REEL 3 : client =======================
def r3_hook(lt, dur):
    im = BC()
    header(im, dark=False)
    y = fade_text(im, (80, 500), "Votre client vous appelle 3 fois par semaine", font("ExtraBold", 100), INK, 920, lt / 0.4, hl={"3", "fois"}, hlfill=RED)
    fade_text(im, (80, y + 50), "pour savoir où en est son chantier ?", font("Bold", 58), GREY, 920, (lt - 0.8) / 0.4)
    # phone ringing icon
    a = ease((lt - 1.2) / 0.3)
    if a > 0:
        lay = Image.new("RGBA", im.size, (0, 0, 0, 0))
        ld = ImageDraw.Draw(lay)
        wob = 8 * math.sin(lt * 40) if lt > 1.4 else 0
        cx, cy = W / 2 + wob, 1480
        ld.ellipse((cx - 90, cy - 90, cx + 90, cy + 90), fill=GREEN)
        ld.text((cx, cy), "📞" if False else "☎", font=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 100), fill=WHITE, anchor="mm")
        with_alpha(im, lay, a)
    return im


TASKS = ["Démolition salle de bain", "Évacuations et attentes", "Pose du bac à douche", "Faïence murale", "Meuble vasque"]


def r3_tasks(lt, dur):
    im = BN()
    header(im)
    y = fade_text(im, (80, 380), "Vos équipes cochent. Vous validez.", font("ExtraBold", 80), WHITE, 920, lt / 0.4, hl={"cochent.", "validez."})
    top = y + 60
    lay = Image.new("RGBA", im.size, (0, 0, 0, 0))
    card(lay, (80, top, W - 80, top + 870), radius=34)
    ld = ImageDraw.Draw(lay)
    ld.text((130, top + 60), "Rénovation SdB · Mme Le Goff", font=font("Bold", 36), fill=INK, anchor="lm")
    ndone = 0
    yy = top + 140
    for i, t in enumerate(TASKS):
        c = (lt - 0.7 - i * 0.5) / 0.25 if i < 3 else -1
        if c >= 1:
            ndone += 1
        if c > 0:
            s = pop(c)
            check_icon(ld, 150, yy + 40, 30 * max(0.01, s))
        else:
            ld.ellipse((120, yy + 10, 180, yy + 70), outline=LGREY, width=5)
        ld.text((210, yy + 40), t, font=font("SemiBold", 38), fill=GREY if c >= 1 else INK, anchor="lm")
        yy += 105
    # progress
    prog = min(3, max(0, (lt - 0.7) / 0.5 + 0.0)) / 5
    prog = min(0.6, ease(prog / 0.6) * 0.6) if lt > 0.7 else 0
    py = top + 770
    ld.rounded_rectangle((130, py, W - 130, py + 34), 17, fill=LGREY)
    ld.rounded_rectangle((130, py, 130 + max(34, (W - 260) * prog), py + 34), 17, fill=GREEN)
    ld.text((W - 130, py - 40), f"{int(round(prog * 100))} %", font=font("ExtraBold", 40), fill=GREEN, anchor="rm")
    ld.text((130, py - 40), "Avancement", font=font("SemiBold", 32), fill=GREY, anchor="lm")
    with_alpha(im, lay, ease((lt - 0.2) / 0.4))
    return im


def r3_mail(lt, dur):
    im = BC()
    header(im, dark=False)
    y = fade_text(im, (80, 380), "Et votre client suit tout, par mail.", font("ExtraBold", 84), INK, 920, lt / 0.4, hl={"mail."}, hlfill=BLUE)
    a = ease((lt - 0.5) / 0.45)
    lay = Image.new("RGBA", im.size, (0, 0, 0, 0))
    top = y + 60 - 120 * (1 - a)
    card(lay, (80, top, W - 80, top + 560), radius=34)
    ld = ImageDraw.Draw(lay)
    lay.alpha_composite(logo(80), (130, int(top + 50)))
    ld.text((235, top + 72), "Contact Chantier", font=font("Bold", 34), fill=INK, anchor="lm")
    ld.text((235, top + 112), "à : Mme Le Goff", font=font("Medium", 28), fill=GREY, anchor="lm")
    ld.text((130, top + 200), "Étape validée :", font=font("SemiBold", 34), fill=GREY, anchor="lm")
    ld.text((130, top + 255), "Pose du bac à douche ✓", font=font("ExtraBold", 46), fill=INK, anchor="lm")
    ld.rounded_rectangle((130, top + 330, W - 130, top + 364), 17, fill=LGREY)
    ld.rounded_rectangle((130, top + 330, 130 + (W - 260) * 0.6, top + 364), 17, fill=GREEN)
    ld.text((130, top + 410), "Avancement : 60 %", font=font("Bold", 34), fill=GREEN, anchor="lm")
    ld.rounded_rectangle((130, top + 455, 520, top + 520), 32, fill=NAVY)
    ld.text((325, top + 487), "Suivre mon chantier", font=font("Bold", 28), fill=WHITE, anchor="mm")
    with_alpha(im, lay, a)
    fade_text(im, (80, 1500), "Les photos, l'avancement… jamais les prix.", font("Bold", 46), ORANGE, 920, (lt - 1.4) / 0.4, align="center")
    return im


def r3():
    render("reel3_client", [(3.0, r3_hook), (3.4, r3_tasks), (3.4, r3_mail), (3.4, cta_scene)])


if __name__ == "__main__":
    which = sys.argv[1]
    if which == "stills":
        for nm, fn, t in [("st_r1hook", r1_hook, 3), ("st_r1s1", r1_s1, 3.5), ("st_r1s2", r1_s2, 3.5), ("st_r1s3", r1_s3, 3.5), ("st_cta", cta_scene, 3),
                          ("st_r2hook", r2_hook, 3), ("st_r2off", r2_office, 3.3), ("st_r3hook", r3_hook, 2.9), ("st_r3tasks", r3_tasks, 3.3), ("st_r3mail", r3_mail, 3.3)]:
            still(nm, fn, t)
    else:
        {"r1": r1, "r2": r2, "r3": r3}[which]()

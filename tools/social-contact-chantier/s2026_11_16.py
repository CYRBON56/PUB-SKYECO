"""Contenus programmés le 16/11/2026 : reel « groupe du chantier » (29/11) + carrousel mythes (30/11)."""
import sys, os
sys.path.insert(0, "/tmp/cc")
from lib import *
import posts
import reels
from reels import BN, BC, fade_text, with_alpha, header, cta_scene, render, r1_s3, LIGHT

PW, PH = 1080, 1350
PRE = "2026-11-16"


# ======================= CARROUSEL : 4 idées reçues =======================
MYTHS = [
    ("« Mes artisans n'installeront jamais une appli. »",
     "Ils n'installent rien.",
     "Un lien par SMS : pas de compte, pas de mot de passe. Chacun ne voit que sa partie."),
    ("« Découper mon CCTP par lot, c'est des heures. »",
     "Vous déposez le CCTP, il est découpé par lot.",
     "PDF ou Word. Chaque corps de métier reçoit ses articles et coche ce qui est fait."),
    ("« Si mon client suit le chantier, il verra mes prix. »",
     "Jamais.",
     "Le devis signé est importé, les prix sont retirés. Le client voit les étapes, l'avancement et les photos."),
    ("« Encore un abonnement à payer pour mes artisans. »",
     "C'est gratuit pour les artisans.",
     "Ils reçoivent leur lien et travaillent. Rien à payer, rien à installer."),
]


def m_cover():
    im = bg_navy(PW, PH)
    d = ImageDraw.Draw(im)
    brand_row(im, 80, 80, 64)
    pill(d, (80, 300), "MYTHE OU RÉALITÉ ?", font("Bold", 28), YEL, NAVY)
    y = text_block(d, (80, 410), "4 idées reçues sur le suivi de chantier", font("ExtraBold", 96), WHITE, 920, lh=1.06, hl={"4", "idées", "reçues"})
    y = text_block(d, (80, y + 40), "Architectes, maîtres d'œuvre, artisans : on les entend souvent. Voici ce qu'il en est vraiment.", font("Medium", 38), (210, 222, 238), 880, lh=1.35)
    pill(d, (80, PH - 200), "Glissez  →", font("Bold", 34), WHITE, NAVY)
    d.text((PW - 80, PH - 70), "1/6", font=font("Medium", 26), fill=(180, 195, 215), anchor="rm")
    posts.save(im, f"{PRE}_mythes_1")


def m_slide(i):
    myth, real, expl = MYTHS[i]
    im = bg_cream(PW, PH)
    d = ImageDraw.Draw(im)
    brand_row(im, 80, 80, 56, color=NAVY)
    pill(d, (80, 230), f"IDÉE REÇUE N°{i + 1}", font("Bold", 28), RED, WHITE)
    y = text_block(d, (80, 330), myth, font("ExtraBold", 66), INK, 920, lh=1.12)
    # big red cross
    y += 40
    card(im, (80, y, PW - 80, y + 560), radius=34)
    d = ImageDraw.Draw(im)
    pill(d, (130, y + 50), "RÉALITÉ", font("Bold", 28), GREEN, WHITE)
    check_icon(d, PW - 160, y + 80, 40)
    yy = text_block(d, (130, y + 140), real, font("ExtraBold", 58), NAVY, 820, lh=1.12)
    text_block(d, (130, yy + 26), expl, font("Medium", 38), GREY, 820, lh=1.35)
    posts.footer(im, dark=False, page=f"{i + 2}/6")
    posts.save(im, f"{PRE}_mythes_{i + 2}")


def mythes():
    m_cover()
    for i in range(4):
        m_slide(i)
    posts.cta(f"{PRE}_mythes_6", page="6/6")


# ======================= REEL : le groupe du chantier =======================
BUBBLES = [
    ("Qui a le plan à jour ?", 80, False),
    ("C'est la V3 ou la V4 ??", 300, True),
    ("Photo de la réservation svp", 80, False),
    ("Elle passe où la gaine ?", 260, True),
    ("Le client a encore appelé", 80, False),
    ("Je l'avais dit mardi…", 330, True),
]


def g_hook(lt, dur):
    im = BN()
    header(im)
    y = fade_text(im, (80, 300), "Le groupe du chantier,", font("ExtraBold", 84), WHITE, 900, lt / 0.3)
    fade_text(im, (80, y + 4), "22h47.", font("ExtraBold", 84), YEL, 900, (lt - 0.25) / 0.3)
    fb = font("SemiBold", 40)
    by = 690
    for i, (t, x, right) in enumerate(BUBBLES):
        s = pop((lt - 0.45 - i * 0.28) / 0.25)
        if s <= 0:
            continue
        lay = Image.new("RGBA", im.size, (0, 0, 0, 0))
        ld = ImageDraw.Draw(lay)
        tw = ld.textlength(t, font=fb)
        bw, bh = tw + 70, 96
        bx = min(x, 940 - bw)
        yy = by + i * 132
        sc = max(0.01, s)
        cx, cy = bx + bw / 2, yy + bh / 2
        ld.rounded_rectangle((cx - bw * sc / 2, cy - bh * sc / 2, cx + bw * sc / 2, cy + bh * sc / 2), 34 * sc,
                             fill=(226, 246, 214) if right else WHITE)
        if sc > 0.8:
            ld.text((cx, cy), t, font=fb, fill=INK, anchor="mm")
        with_alpha(im, lay, min(1, s))
    # unread badge
    a = pop((lt - 2.2) / 0.3)
    if a > 0:
        lay = Image.new("RGBA", im.size, (0, 0, 0, 0))
        ld = ImageDraw.Draw(lay)
        r = 70 * max(0.01, a)
        cx, cy = 860, 330
        ld.ellipse((cx - r, cy - r, cx + r, cy + r), fill=RED)
        ld.text((cx, cy), "99+", font=font("ExtraBold", max(2, int(48 * a))), fill=WHITE, anchor="mm")
        with_alpha(im, lay, min(1, a))
    return im


LOTS3 = [("Plomberie", BLUE, "3 tâches · plan à jour"), ("Électricité", ORANGE, "4 tâches · plan à jour"), ("Maçonnerie", RED, "2 tâches · 1 signalement")]


def g_lots(lt, dur):
    im = BC()
    header(im, dark=False)
    y = fade_text(im, (80, 360), "Avec Contact Chantier,", font("ExtraBold", 76), INK, 940, lt / 0.35, hl={"Contact", "Chantier"}, hlfill=BLUE)
    y = fade_text(im, (80, y + 6), "chacun ne voit que son lot.", font("ExtraBold", 76), INK, 940, (lt - 0.2) / 0.35)
    yy = y + 70
    for i, (lot, col, sub) in enumerate(LOTS3):
        a = ease((lt - 0.6 - i * 0.35) / 0.35)
        lay = Image.new("RGBA", im.size, (0, 0, 0, 0))
        ox = 80 * (1 - a)
        card(lay, (80 + ox, yy, 940 + ox, yy + 200), radius=30)
        ld = ImageDraw.Draw(lay)
        ld.rounded_rectangle((80 + ox, yy, 96 + ox, yy + 200), 8, fill=col)
        ld.text((140 + ox, yy + 72), lot, font=font("Bold", 50), fill=INK, anchor="lm")
        ld.text((140 + ox, yy + 138), sub, font=font("Medium", 36), fill=GREY, anchor="lm")
        check_icon(ld, 860 + ox, yy + 100, 36)
        with_alpha(im, lay, a)
        yy += 230
    fade_text(im, (80, yy + 30), "Un lien par SMS. Rien à installer.", font("Bold", 48), BLUE, 860, (lt - 1.9) / 0.4)
    return im


def g_plan(lt, dur):
    return r1_s3(lt, dur, badge=False, title="Les problèmes, posés sur le plan")


def reel_groupe():
    render(f"{PRE}_reel_groupe-chantier", [(3.4, g_hook), (3.6, g_lots), (3.8, g_plan), (3.6, cta_scene)])


if __name__ == "__main__":
    w = sys.argv[1]
    if w == "posts":
        mythes()
    elif w == "stills":
        for nm, fn, t in [("st_ghook", g_hook, 3.3), ("st_ghook_early", g_hook, 0.8), ("st_glots", g_lots, 3.5), ("st_gplan", g_plan, 3.7), ("st_cta2", cta_scene, 3.5)]:
            reels.still(nm, fn, t)
    elif w == "reel":
        reel_groupe()

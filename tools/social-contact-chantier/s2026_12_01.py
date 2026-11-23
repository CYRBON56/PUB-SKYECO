"""Contenus Contact Chantier programmés le 01/12/2026 pour la semaine du 2026-12-02 au 2026-12-06.
Sujets : (1) avant/après WhatsApp vs Contact Chantier (reel), (2) congés de fin d'année (carrousel),
(3) coulisses de Cyrille / parcours (reel).
"""
import sys, os
sys.path.insert(0, "/tmp/cc")
from lib import *
import posts
import reels
from reels import BN, BC, fade_text, with_alpha, header, cta_scene, render, LIGHT

PW, PH = 1080, 1350
PRE = "2026-12-01"

# ======================= CARROUSEL : congés de fin d'année =======================

def s_cover():
    im = bg_navy(PW, PH)
    d = ImageDraw.Draw(im)
    brand_row(im, 80, 80, 64)
    pill(d, (80, 300), "AVANT LES FÊTES", font("Bold", 28), YEL, NAVY)
    y = text_block(d, (80, 400), "Les chantiers n'attendent pas les vacances.", font("ExtraBold", 84), WHITE, 920, lh=1.08, hl={"vacances."})
    y = text_block(d, (80, y + 36), "Entre Noël et le jour de l'an, qui sait encore où en est quoi ? Le point avant de partir.", font("Medium", 38), (210, 222, 238), 880, lh=1.35)
    pill(d, (80, PH - 200), "Glissez  →", font("Bold", 34), WHITE, NAVY)
    d.text((PW - 80, PH - 70), "1/4", font=font("Medium", 26), fill=(180, 195, 215), anchor="rm")
    posts.save(im, f"{PRE}_conges_1")


def s_probleme():
    im = bg_cream(PW, PH)
    d = ImageDraw.Draw(im)
    brand_row(im, 80, 80, 56, color=NAVY)
    pill(d, (80, 230), "SUR LE TERRAIN", font("Bold", 24), RED, WHITE)
    y = text_block(d, (80, 320), "Équipes en congés, artisans sur d'autres chantiers, client qui s'inquiète.", font("ExtraBold", 58), INK, 920, lh=1.14, hl={"congés,"}, hlfill=RED)
    items = [
        ("Le dernier message date d'avant les fêtes", "Et personne ne sait ce qu'il reste à finir."),
        ("Le client rappelle « juste pour savoir »", "Pile pendant les congés."),
        ("En janvier, on repart de zéro", "Le temps de tout se réexpliquer."),
    ]
    yy = y + 50
    for t, s in items:
        card(im, (80, yy, PW - 80, yy + 190), radius=28, fill=WHITE)
        d = ImageDraw.Draw(im)
        d.ellipse((120, yy + 55, 190, yy + 125), fill=RED)
        d.text((155, yy + 90), "!", font=font("ExtraBold", 48), fill=WHITE, anchor="mm")
        d.text((230, yy + 65), t, font=font("Bold", 34), fill=INK, anchor="lm")
        text_block(d, (230, yy + 112), s, font("Medium", 28), GREY, 700, lh=1.3)
        yy += 220
    posts.footer(im, dark=False, page="2/4")
    posts.save(im, f"{PRE}_conges_2")


def s_solution():
    im = bg_navy(PW, PH)
    d = ImageDraw.Draw(im)
    pill(d, (80, 80), "AVEC CONTACT CHANTIER", font("Bold", 24), YEL, NAVY)
    y = text_block(d, (80, 170), "Tout reste accessible, même pendant les congés.", font("ExtraBold", 62), WHITE, 920, lh=1.12, hl={"accessible,"})
    items = [
        ("Photos et avancement restent en ligne", "Rien ne se perd entre les équipes."),
        ("Le client suit sans vous appeler", "Un mail à chaque étape déjà validée."),
        ("Vous repartez du bon pied en janvier", "Tout est là où vous l'avez laissé."),
    ]
    yy = y + 50
    for t, s in items:
        card(im, (80, yy, PW - 80, yy + 190), radius=28)
        d = ImageDraw.Draw(im)
        check_icon(d, 160, yy + 95, 38)
        d.text((230, yy + 65), t, font=font("Bold", 34), fill=INK, anchor="lm")
        text_block(d, (230, yy + 112), s, font("Medium", 28), GREY, 700, lh=1.3)
        yy += 220
    posts.footer(im, dark=True, page="3/4")
    posts.save(im, f"{PRE}_conges_3")


def conges():
    s_cover()
    s_probleme()
    s_solution()
    posts.cta(f"{PRE}_conges_4", page="4/4")


# ======================= REEL : avant / après (WhatsApp vs Contact Chantier) =======================

def av_hook(lt, dur):
    im = BN()
    header(im)
    y = fade_text(im, (80, 480), "Avant : un groupe WhatsApp", font("ExtraBold", 92), WHITE, 920, lt / 0.35)
    y = fade_text(im, (80, y + 10), "avec tout le monde.", font("ExtraBold", 92), WHITE, 920, (lt - 0.35) / 0.35)
    fade_text(im, (80, y + 70), "Après : chacun ne voit que son lot.", font("Bold", 54), YEL, 920, (lt - 1.3) / 0.4, hl={"son", "lot."})
    return im


AV_BUBBLES = [
    ("Qui a le plan à jour ?", 80),
    ("C'est la V3 ou la V4 ??", 300),
    ("Le client a encore appelé", 110),
]


def av_avant(lt, dur):
    im = BC()
    header(im, dark=False)
    lay0 = Image.new("RGBA", im.size, (0, 0, 0, 0))
    ld0 = ImageDraw.Draw(lay0)
    pill(ld0, (80, 260), "AVANT", font("Bold", 28), RED, WHITE)
    with_alpha(im, lay0, reels.ease(lt / 0.3))
    y = fade_text(im, (80, 350), "Tout le monde avec tout le monde.", font("ExtraBold", 66), INK, 920, lt / 0.35, hl={"tout."} )
    by = y + 60
    for i, (t, x) in enumerate(AV_BUBBLES):
        s = reels.pop((lt - 0.5 - i * 0.3) / 0.3)
        if s <= 0:
            continue
        lay = Image.new("RGBA", im.size, (0, 0, 0, 0))
        ld = ImageDraw.Draw(lay)
        fb = font("SemiBold", 38)
        tw = ld.textlength(t, font=fb)
        bw, bh = tw + 70, 96
        bx = min(x, 940 - bw)
        yy = by + i * 132
        sc = max(0.01, s)
        cx, cy = bx + bw / 2, yy + bh / 2
        ld.rounded_rectangle((cx - bw * sc / 2, cy - bh * sc / 2, cx + bw * sc / 2, cy + bh * sc / 2), 34 * sc, fill=WHITE, outline=LGREY, width=2)
        if sc > 0.8:
            ld.text((cx, cy), t, font=fb, fill=INK, anchor="mm")
        with_alpha(im, lay, min(1, s))
    fade_text(im, (80, by + 460), "Et au final, rien ne reste nulle part.", font("Bold", 44), RED, 920, (lt - 1.9) / 0.35)
    return im


AV_LOTS = [("Plomberie", BLUE, "Ses tâches, ses photos, ses plans."), ("Électricité", ORANGE, "Rien d'autre à filtrer."), ("Maçonnerie", RED, "Son lot, et c'est tout.")]


def av_apres(lt, dur):
    im = BN()
    header(im)
    pill(ImageDraw.Draw(im), (80, 260), "APRÈS", font("Bold", 28), YEL, NAVY)
    y = fade_text(im, (80, 350), "Chaque artisan ne voit que son lot.", font("ExtraBold", 66), WHITE, 920, lt / 0.35, hl={"son", "lot."})
    yy = y + 60
    for i, (lot, col, sub) in enumerate(AV_LOTS):
        a = reels.ease((lt - 0.5 - i * 0.35) / 0.35)
        lay = Image.new("RGBA", im.size, (0, 0, 0, 0))
        ox = 80 * (1 - a)
        card(lay, (80 + ox, yy, PW - 80 + ox, yy + 190), radius=28)
        ld = ImageDraw.Draw(lay)
        ld.rounded_rectangle((80 + ox, yy, 96 + ox, yy + 190), 8, fill=col)
        ld.text((140 + ox, yy + 60), lot, font=font("Bold", 42), fill=INK, anchor="lm")
        text_block(ld, (140 + ox, yy + 110), sub, font("Medium", 28), GREY, 700, lh=1.3)
        check_icon(ld, PW - 150 + ox, yy + 95, 32)
        with_alpha(im, lay, a)
        yy += 220
    fade_text(im, (80, yy + 30), "Un lien par SMS. Rien à installer.", font("Bold", 44), YEL, 920, (lt - 1.9) / 0.4)
    return im


def reel_avant_apres():
    render(f"{PRE}_reel_avant-apres", [(3.2, av_hook), (3.8, av_avant), (3.8, av_apres), (3.4, cta_scene)])


# ======================= REEL : coulisses de Cyrille =======================

def repo_photo():
    path = os.environ.get("REPO", "/home/claude/pub-skyeco") + "/public/signature/cyrille-bon.jpg"
    return Image.open(path).convert("RGB")


_photo_cache = None


def cy_photo_circle(size):
    global _photo_cache
    if _photo_cache is None:
        _photo_cache = repo_photo()
    ph = _photo_cache
    w0, h0 = ph.size
    m = min(w0, h0)
    ph2 = ph.crop(((w0 - m) // 2, 0, (w0 - m) // 2 + m, m)).resize((size, size), Image.LANCZOS)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size, size), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(ph2, (0, 0), mask)
    return out


def cy_hook(lt, dur):
    im = BN()
    header(im)
    s = reels.pop(lt / 0.5)
    size = max(1, int(360 * s))
    cx, cy = PW // 2, 560
    lay = Image.new("RGBA", im.size, (0, 0, 0, 0))
    ld = ImageDraw.Draw(lay)
    ld.ellipse((cx - size / 2 - 10, cy - size / 2 - 10, cx + size / 2 + 10, cy + size / 2 + 10), fill=YEL)
    with_alpha(im, lay, min(1, s))
    if s > 0.3:
        photo = cy_photo_circle(size)
        im.alpha_composite(photo, (cx - size // 2, cy - size // 2))
    y = fade_text(im, (80, 920), "20 ans de chantiers.", font("ExtraBold", 92), WHITE, 920, (lt - 0.5) / 0.35, align="center")
    fade_text(im, (80, y + 10), "Assainissement, aménagement extérieur, Morbihan.", font("Medium", 38), LIGHT, 920, (lt - 0.9) / 0.4, align="center")
    return im


def cy_citation(lt, dur):
    im = BC()
    header(im, dark=False)
    y = fade_text(im, (80, 480), "« J'ai créé l'outil", font("ExtraBold", 86), INK, 920, lt / 0.4, align="center")
    y = fade_text(im, (80, y + 10), "que j'aurais voulu avoir. »", font("ExtraBold", 86), BLUE, 920, (lt - 0.4) / 0.4, align="center", hl={"j'aurais", "voulu", "avoir."}, hlfill=BLUE)
    fade_text(im, (80, y + 90), "Pas un logiciel de bureau de plus :\nune appli pensée par quelqu'un qui a les bottes sur le chantier.", font("Medium", 36), GREY, 880, (lt - 1.2) / 0.4, align="center", lh=1.35)
    return im


def cy_items(lt, dur):
    im = BN()
    header(im)
    y = fade_text(im, (80, 380), "Pensé pour le terrain :", font("ExtraBold", 72), WHITE, 920, lt / 0.35)
    items = [("Simple pour les artisans", "Un lien par SMS, rien à installer."), ("Clair pour les clients", "L'avancement, sans jamais voir les prix."), ("Tout au même endroit", "Plans, photos, messages, CCTP.")]
    yy = y + 50
    for i, (t, s) in enumerate(items):
        a = reels.ease((lt - 0.5 - i * 0.35) / 0.35)
        lay = Image.new("RGBA", im.size, (0, 0, 0, 0))
        ox = 60 * (1 - a)
        card(lay, (80 + ox, yy, PW - 80 + ox, yy + 180), radius=28)
        ld = ImageDraw.Draw(lay)
        check_icon(ld, 165 + ox, yy + 90, 36)
        ld.text((235 + ox, yy + 58), t, font=font("Bold", 38), fill=INK, anchor="lm")
        text_block(ld, (235 + ox, yy + 108), s, font("Medium", 28), GREY, 700, lh=1.3)
        with_alpha(im, lay, a)
        yy += 210
    return im


def reel_coulisses():
    render(f"{PRE}_reel_coulisses-cyrille", [(3.0, cy_hook), (3.6, cy_citation), (3.6, cy_items), (3.4, cta_scene)])


if __name__ == "__main__":
    which = sys.argv[1]
    if which == "posts":
        conges()
    elif which == "reel1":
        reel_avant_apres()
    elif which == "reel2":
        reel_coulisses()
    elif which == "stills":
        for nm, fn, t in [("st_avhook", av_hook, 3), ("st_avavant", av_avant, 3.5), ("st_avapres", av_apres, 3.5),
                           ("st_cyhook", cy_hook, 2.8), ("st_cycit", cy_citation, 3.4), ("st_cyitems", cy_items, 3.4)]:
            reels.still(nm, fn, t)

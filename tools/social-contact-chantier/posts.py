import sys, os
sys.path.insert(0, "/tmp/cc")
from lib import *

W, H = 1080, 1350
OUT = "/tmp/cc/out"
os.makedirs(OUT, exist_ok=True)

PINS = [  # relative pos on plan, colour, glyph, title, sub, label offset side
    (0.30, 0.18, BLUE, "📷", "Plomberie", "Attentes eau posées côté séjour"),
    (0.12, 0.76, ORANGE, "?", "Électricité", "Hauteur des prises cuisine ?"),
    (0.80, 0.12, RED, "!", "Maçonnerie", "Réservation VMC oubliée ch. 1"),
    (0.42, 0.62, GREEN, "check", "Menuiserie", "Porte SdB posée · validé"),
]


def plan_scene(img, box, prog=(1, 1, 1, 1), labels=(1, 1, 1, 1), r=34):
    x0, y0, x1, y1 = box
    card(img, box, radius=30)
    pad = 50
    px0, py0, px1, py1 = x0 + pad, y0 + pad, x1 - pad, y1 - pad
    plan_house(img, (px0, py0, px1, py1))
    PW, PH = px1 - px0, py1 - py0
    pts = []
    for i, (rx, ry, col, g, t, s) in enumerate(PINS):
        cx, cy = px0 + PW * rx, py0 + PH * ry
        glyph = "cam" if g == "📷" else g
        pin(img, cx, cy, r, col, glyph, scale=pop(prog[i]))
        pts.append((cx, cy, col, t, s))
    return pts


def save(img, name):
    img.convert("RGB").save(f"{OUT}/{name}.jpg", quality=93)


def footer(img, dark=True, page=None):
    d = ImageDraw.Draw(img)
    col = (255, 255, 255, 170) if dark else GREY
    f = font("SemiBold", 28)
    d.text((80, H - 80), "contactchantier.com", font=f, fill=YEL if dark else NAVY, anchor="lm")
    if page:
        d.text((W - 80, H - 80), page, font=font("Medium", 26), fill=col, anchor="rm")


# ---------------- Carrousel 1 : architectes -----------------
def c1():
    # S1 hook
    im = bg_navy(W, H)
    d = ImageDraw.Draw(im)
    brand_row(im, 80, 80, 64)
    pill(d, (80, 300), "ARCHITECTES · MAÎTRES D'ŒUVRE", font("Bold", 26), YEL, NAVY)
    y = text_block(d, (80, 400), "Vos infos de chantier se perdent dans les SMS ?", font("ExtraBold", 92), WHITE, 920, lh=1.08, hl={"SMS"})
    y = text_block(d, (80, y + 40), "Photos, questions, problèmes… tout le monde envoie à tout le monde, et plus personne ne retrouve rien.", font("Medium", 38), (210, 222, 238), 880, lh=1.35)
    # bubble stack decoration
    fb = font("SemiBold", 32)
    by = y + 70
    for i, (t, x, tilt) in enumerate([("Tu as vu pour la VMC ?", 300, 0), ("Je t'ai envoyé la photo hier", 120, 0), ("C'est pour quel lot ??", 420, 0)] ):
        tw = d.textlength(t, font=fb)
        bx0, by0 = x, by + i * 100
        lay = Image.new("RGBA", im.size, (0, 0, 0, 0))
        ld = ImageDraw.Draw(lay)
        a = 255 - i * 25
        ld.rounded_rectangle((bx0, by0, bx0 + tw + 60, by0 + 78), 30, fill=(255, 255, 255, a) if i % 2 == 0 else (44, 93, 143, 255))
        ld.text((bx0 + 30, by0 + 39), t, font=fb, fill=INK if i % 2 == 0 else WHITE, anchor="lm")
        im.alpha_composite(lay)
    d = ImageDraw.Draw(im)
    pill(d, (W - 80, H - 112), "Glissez  →", font("Bold", 30), WHITE, NAVY, anchor="l") if False else None
    d.text((W - 80, H - 80), "Glissez →", font=font("Bold", 32), fill=YEL, anchor="rm")
    d.text((80, H - 80), "1/4", font=font("Medium", 26), fill=(180, 195, 215), anchor="lm")
    save(im, "c1_1")

    # S2 plan
    im = bg_cream(W, H)
    d = ImageDraw.Draw(im)
    pill(d, (80, 80), "LA SOLUTION", font("Bold", 24), NAVY, WHITE)
    y = text_block(d, (80, 160), "Chaque artisan signale ce qu'il voit, directement sur le plan.", font("ExtraBold", 58), INK, 920, lh=1.12, hl={"plan"}, hlfill=BLUE)
    box = (80, y + 30, W - 80, y + 30 + 600)
    pts = plan_scene(im, box)
    # legend
    ly = box[3] + 40
    fl = font("SemiBold", 27)
    lx = 80
    for (cx, cy, col, t, s) in pts:
        d.ellipse((lx, ly + 4, lx + 26, ly + 30), fill=col)
        d.text((lx + 38, ly + 17), t, font=fl, fill=INK, anchor="lm")
        lx += 60 + d.textlength(t, font=fl) + 20
    text_block(d, (80, ly + 70), "Photo, vidéo ou message vocal, depuis son téléphone. Vous suivez tout depuis le bureau.", font("Medium", 32), GREY, 920, lh=1.35)
    footer(im, dark=False, page="2/4")
    save(im, "c1_2")

    # S3 no install
    im = bg_navy(W, H)
    d = ImageDraw.Draw(im)
    pill(d, (80, 80), "POUR VOS ARTISANS", font("Bold", 24), YEL, NAVY)
    y = text_block(d, (80, 170), "Rien à installer. Juste un lien par SMS.", font("ExtraBold", 76), WHITE, 920, lh=1.1, hl={"SMS"})
    items = [
        ("Un lien personnel", "Il l'ouvre, il est sur le chantier."),
        ("Pas de compte, pas de mot de passe", "Ni appli à télécharger."),
        ("Chacun ne voit que son lot", "Ses tâches, ses plans, ses messages."),
        ("Gratuit pour les artisans", "Toujours."),
    ]
    yy = y + 50
    for t, s in items:
        card(im, (80, yy, W - 80, yy + 170), radius=28, fill=WHITE)
        check_icon(d, 160, yy + 85, 38)
        d.text((230, yy + 58), t, font=font("Bold", 38), fill=INK, anchor="lm")
        d.text((230, yy + 112), s, font=font("Medium", 30), fill=GREY, anchor="lm")
        yy += 200
    d = ImageDraw.Draw(im)
    footer(im, dark=True, page="3/4")
    save(im, "c1_3")

    # S4 CTA
    cta(im_name="c1_4", page="4/4")


def cta(im_name, page=None, kicker="ESSAI GRATUIT"):
    im = bg_navy(W, H)
    d = ImageDraw.Draw(im)
    im.alpha_composite(logo(200), ((W - 200) // 2, 150))
    d = ImageDraw.Draw(im)
    d.text((W / 2, 420), "Contact Chantier", font=font("ExtraBold", 64), fill=WHITE, anchor="mm")
    d.text((W / 2, 490), "le suivi de chantier entre artisans", font=font("Medium", 34), fill=(200, 214, 232), anchor="mm")
    pill(d, (W / 2, 590), kicker, font("Bold", 26), YEL, NAVY, anchor="c")
    y = text_block(d, (90, 680), "3 mois offerts sur un vrai chantier", font("ExtraBold", 74), WHITE, 900, lh=1.1, align="center", hl={"3", "mois", "offerts"})
    y = text_block(d, (90, y + 24), "Sans carte bancaire · sans engagement\nArtisans toujours gratuits", font("Medium", 36), (210, 222, 238), 900, lh=1.4, align="center")
    # button
    bw, bh = 640, 110
    bx, by = (W - bw) / 2, y + 50
    d.rounded_rectangle((bx, by, bx + bw, by + bh), bh / 2, fill=YEL)
    d.text((W / 2, by + bh / 2), "contactchantier.com", font=font("ExtraBold", 44), fill=NAVY, anchor="mm")
    d.text((W / 2, by + bh + 60), "Lien dans la bio", font=font("SemiBold", 30), fill=(200, 214, 232), anchor="mm")
    if page:
        d.text((W - 80, H - 70), page, font=font("Medium", 26), fill=(180, 195, 215), anchor="rm")
    save(im, im_name)


# ---------------- Carrousel 2 : artisans -----------------
def c2():
    im = bg_cream(W, H)
    d = ImageDraw.Draw(im)
    brand_row(im, 80, 80, 64, color=NAVY)
    d = ImageDraw.Draw(im)
    pill(d, (80, 270), "ARTISANS · PAYSAGISTES · BTP", font("Bold", 26), NAVY, WHITE)
    y = text_block(d, (80, 370), "Votre devis signé devient la liste de tâches de vos équipes.", font("ExtraBold", 84), INK, 920, lh=1.08, hl={"tâches"}, hlfill=BLUE)
    text_block(d, (80, y + 36), "Sans les prix. En deux minutes.", font("Bold", 44), ORANGE, 920)
    d.text((W - 80, H - 80), "Glissez →", font=font("Bold", 32), fill=NAVY, anchor="rm")
    d.text((80, H - 80), "1/4", font=font("Medium", 26), fill=GREY, anchor="lm")
    save(im, "c2_1")

    # S2: devis -> tasks
    im = bg_navy(W, H)
    d = ImageDraw.Draw(im)
    pill(d, (80, 80), "COMMENT ÇA MARCHE", font("Bold", 24), YEL, NAVY)
    y = text_block(d, (80, 165), "Vous importez le devis (PDF ou Word). Les prix disparaissent.", font("ExtraBold", 56), WHITE, 920, lh=1.12, hl={"prix"})
    # devis card left -> tasks right
    top = y + 50
    card(im, (80, top, 520, top + 640), radius=24)
    d = ImageDraw.Draw(im)
    d.text((115, top + 45), "DEVIS N°2026-118", font=font("Bold", 24), fill=NAVY)
    rows = ["Terrassement", "Pose bordures", "Enrobé 120 m²", "Portail alu", "Nettoyage"]
    prices = ["1 450 €", "980 €", "5 400 €", "2 900 €", "250 €"]
    ry = top + 110
    for r_, p in zip(rows, prices):
        d.text((115, ry), r_, font=font("Medium", 27), fill=INK)
        d.text((485, ry), p, font=font("SemiBold", 27), fill=GREY, anchor="ra")
        tw = d.textlength(p, font=font("SemiBold", 27))
        d.line((485 - tw - 6, ry + 17, 491, ry + 17), fill=RED, width=4)
        ry += 90
    # arrow
    d.text((560, top + 320), "→", font=font("ExtraBold", 90), fill=YEL, anchor="mm")
    card(im, (600, top, W - 80, top + 640), radius=24)
    d = ImageDraw.Draw(im)
    d.text((630, top + 45), "TÂCHES · ÉQUIPE A", font=font("Bold", 24), fill=BLUE)
    ry = top + 105
    for i, r_ in enumerate(rows):
        done = i < 2
        if done:
            check_icon(d, 652, ry + 18, 22)
        else:
            d.ellipse((630, ry - 4, 674, ry + 40), outline=LGREY, width=4)
        d.text((695, ry + 18), r_, font=font("SemiBold", 27), fill=INK if not done else GREY, anchor="lm")
        ry += 90
    text_block(d, (80, top + 690), "Chaque ligne devient une tâche confiée à une de vos équipes.", font("Medium", 34), (210, 222, 238), 920, lh=1.35)
    footer(im, dark=True, page="2/4")
    save(im, "c2_2")

    # S3: 3 steps
    im = bg_cream(W, H)
    d = ImageDraw.Draw(im)
    pill(d, (80, 80), "SUR LE CHANTIER", font("Bold", 24), NAVY, WHITE)
    y = text_block(d, (80, 165), "Fini les coups de fil pour savoir où on en est.", font("ExtraBold", 62), INK, 920, lh=1.1)
    steps = [
        ("1", "Le chef d'équipe coche", "« C'est fait », avec une photo s'il veut.", BLUE),
        ("2", "Vous validez", "Depuis le bureau ou sur place.", ORANGE),
        ("3", "Votre client suit son chantier", "Il reçoit un mail à chaque étape validée. Jamais les prix.", GREEN),
    ]
    yy = y + 50
    for n, t, s, col in steps:
        card(im, (80, yy, W - 80, yy + 230), radius=28)
        d = ImageDraw.Draw(im)
        d.ellipse((120, yy + 65, 220, yy + 165), fill=col)
        d.text((170, yy + 115), n, font=font("ExtraBold", 54), fill=WHITE, anchor="mm")
        d.text((260, yy + 75), t, font=font("Bold", 40), fill=INK)
        text_block(d, (260, yy + 130), s, font("Medium", 30), GREY, 700, lh=1.3)
        yy += 260
    footer(im, dark=False, page="3/4")
    save(im, "c2_3")
    cta("c2_4", page="4/4")


# ---------------- Post 3 : fondateur -----------------
def p3():
    im = bg_navy(W, H)
    d = ImageDraw.Draw(im)
    ph = Image.open(""+__import__("os").environ.get("REPO","/home/claude/pub-skyeco")+"/public/signature/cyrille-bon.jpg").convert("RGB")
    s = 340
    w0, h0 = ph.size
    m = min(w0, h0)
    ph = ph.crop(((w0 - m) // 2, 0, (w0 - m) // 2 + m, m)).resize((s, s), Image.LANCZOS)
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, s, s), fill=255)
    cx, cy = 80, 110
    d.ellipse((cx - 10, cy - 10, cx + s + 10, cy + s + 10), fill=YEL)
    im.paste(ph, (cx, cy), mask)
    d = ImageDraw.Draw(im)
    d.text((480, 210), "Cyrille Bon", font=font("ExtraBold", 54), fill=WHITE)
    d.text((480, 285), "Artisan à Brech (56)", font=font("Medium", 34), fill=(200, 214, 232))
    d.text((480, 335), "Créateur de Contact Chantier", font=font("Medium", 34), fill=YEL)
    y = text_block(d, (80, 560), "« 20 ans de chantiers. J'ai créé l'outil que j'aurais voulu avoir. »", font("ExtraBold", 70), WHITE, 920, lh=1.12, hl={"l'outil"})
    text_block(d, (80, y + 40), "Pas un logiciel de bureau de plus : une appli simple, pensée par quelqu'un qui a les bottes sur le chantier.", font("Medium", 36), (210, 222, 238), 900, lh=1.38)
    footer(im, dark=True)
    save(im, "p3")


# ---------------- Post 4 : offre -----------------
def p4():
    im = bg_cream(W, H)
    d = ImageDraw.Draw(im)
    brand_row(im, 80, 80, 64, color=NAVY)
    d = ImageDraw.Draw(im)
    y = text_block(d, (80, 250), "Testez-le sur un vrai chantier. 3 mois offerts.", font("ExtraBold", 86), INK, 920, lh=1.08, hl={"3", "mois", "offerts."}, hlfill=BLUE)
    items = ["Chantiers, artisans et CCTP illimités", "Votre logo et votre couleur", "Sans carte bancaire, sans engagement", "Vos artisans : toujours gratuit"]
    yy = y + 50
    card(im, (80, yy, W - 80, yy + 470), radius=30)
    d = ImageDraw.Draw(im)
    yy += 60
    for it in items:
        check_icon(d, 150, yy + 22, 28)
        d.text((205, yy + 22), it, font=font("SemiBold", 36), fill=INK, anchor="lm")
        yy += 98
    bw, bh = 700, 110
    by = H - 250
    d.rounded_rectangle(((W - bw) / 2, by, (W + bw) / 2, by + bh), bh / 2, fill=NAVY)
    d.text((W / 2, by + bh / 2), "contactchantier.com", font=font("ExtraBold", 46), fill=YEL, anchor="mm")
    d.text((W / 2, by + bh + 55), "En place en 10 minutes, sur le chantier dès demain.", font=font("Medium", 30), fill=GREY, anchor="mm")
    save(im, "p4")


if __name__ == "__main__":
    c1(); c2(); p3(); p4()

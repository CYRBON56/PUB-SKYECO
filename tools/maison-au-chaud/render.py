"""Génère les vidéos Maison au Chaud (1080x1920, ~19 s) à partir d'un fichier JSON de scripts.
Usage : python3 render.py scripts.json dossier_sortie musique.m4a
"""
import json, sys, subprocess, pathlib, html
from playwright.sync_api import sync_playwright

W, H = 1080, 1920
SERIE_TOTAL = 30

CSS = """
*{margin:0;padding:0;box-sizing:border-box}
body{width:1080px;height:1920px;font-family:'Inter',sans-serif;color:#fff;overflow:hidden;
 background:radial-gradient(ellipse at 50% 115%,#ff7a2f55 0%,#0000 55%),
 radial-gradient(ellipse at 15% 0%,#2b4a7a 0%,#0000 50%),linear-gradient(170deg,#0f1b2d 0%,#0a1220 100%);}
.top{position:absolute;top:110px;width:100%;text-align:center;font-weight:800;letter-spacing:6px;font-size:34px;color:#ff8a3d}
.badge{position:absolute;top:175px;left:50%;transform:translateX(-50%);background:#ffffff14;border:2px solid #ffffff30;
 border-radius:40px;padding:10px 30px;font-size:30px;font-weight:700;color:#ffd9bf}
.center{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:center;padding:0 90px;text-align:center}
.h1{font-size:92px;font-weight:900;line-height:1.08}
.h2{font-size:80px;font-weight:900;line-height:1.1;color:#ff8a3d;margin-top:30px}
.card{background:#ffffff10;border:2px solid #ffffff22;border-radius:40px;padding:70px 64px;text-align:left;width:900px}
.num{width:110px;height:110px;border-radius:50%;background:#ff7a2f;display:flex;align-items:center;justify-content:center;font-size:62px;font-weight:900;margin-bottom:40px}
.t{font-size:70px;font-weight:900;line-height:1.1;margin-bottom:30px}
.d{font-size:48px;line-height:1.35;color:#dbe4f0}
.dots{position:absolute;bottom:330px;width:100%;text-align:center;font-size:40px;letter-spacing:18px;color:#ffffff40}
.dots b{color:#ff8a3d}
.btn{margin-top:60px;background:#ff7a2f;border-radius:60px;padding:34px 70px;font-size:60px;font-weight:900}
.handle{margin-top:36px;font-size:44px;font-weight:700;color:#ffb27f}
"""

def page(body, badge):
    return f"<html><head><style>{CSS}</style></head><body><div class='top'>🔥 MAISON AU CHAUD</div>" \
           f"<div class='badge'>{html.escape(badge)}</div>{body}</body></html>"

def slides(s):
    def e(t):
        for a in (" ?", " !", " :", " °C", " %"):
            t = t.replace(a, " " + a[1:])
        return html.escape(t)
    # Champ optionnel "label" (ex. "TROUVAILLE N°3") : remplace le badge "JOUR X/30" et la phrase de fin.
    badge = s['label'] if s.get('label') else f"JOUR {s['jour']}/{SERIE_TOTAL}"
    out = [page(f"<div class='center'><div class='h1'>{e(s['hook'][0])}</div><div class='h2'>{e(s['hook'][1])}</div></div>", badge)]
    for i, (t, d) in enumerate(s['steps'], 1):
        dots = "".join("<b>●</b>" if k == i else "●" for k in range(1, 4))
        out.append(page(f"<div class='center'><div class='card'><div class='num'>{i}</div><div class='t'>{e(t)}</div>"
                        f"<div class='d'>{e(d)}</div></div></div><div class='dots'>{dots}</div>", badge))
    if s.get('label'):
        nxt, sub = "Abonne-toi :", "une trouvaille anti-froid chaque jour"
    else:
        nxt = "Demain : jour %d" % (s['jour'] + 1) if s['jour'] < SERIE_TOTAL else "Merci d'avoir suivi !"
        sub = "Abonne-toi pour ne pas le rater"
    out.append(page(f"<div class='center'><div class='h1'>{e(nxt)}</div><div class='h2'>{e(sub)}</div>"
                    f"<div class='btn'>S'abonner</div><div class='handle'>@maisonauchaud3</div></div>", badge))
    return out

DUR = [3.5, 4.0, 4.0, 4.0, 4.5]  # secondes par écran
FADE = 0.4

def main(js, outdir, music):
    outdir = pathlib.Path(outdir); outdir.mkdir(parents=True, exist_ok=True)
    data = json.load(open(js))
    with sync_playwright() as p:
        b = p.chromium.launch(); pg = b.new_page(viewport={"width": W, "height": H})
        for s in data:
            tmp = outdir / f"_{s['id']}"; tmp.mkdir(exist_ok=True)
            for k, h in enumerate(slides(s)):
                pg.set_content(h); pg.wait_for_timeout(150); pg.screenshot(path=str(tmp / f"{k}.png"))
            inputs, filt = [], []
            for k, d in enumerate(DUR):
                inputs += ["-loop", "1", "-t", str(d), "-i", str(tmp / f"{k}.png")]
                filt.append(f"[{k}:v]scale={W}:{H},zoompan=z='min(zoom+0.0006,1.05)':d={int(d*30)}:s={W}x{H}:fps=30,setsar=1[v{k}]")
            prev, off = "v0", 0.0
            for k in range(1, len(DUR)):
                off += DUR[k-1] - FADE
                filt.append(f"[{prev}][v{k}]xfade=transition=fade:duration={FADE}:offset={off:.2f}[x{k}]")
                prev = f"x{k}"
            total = sum(DUR) - FADE * (len(DUR) - 1)
            n = len(DUR)
            filt.append(f"[{n}:a]volume=0.5,afade=t=in:d=0.5,afade=t=out:st={total-1:.2f}:d=1[a]")
            cmd = ["ffmpeg", "-v", "error", "-y", *inputs, "-stream_loop", "-1", "-i", music,
                   "-filter_complex", ";".join(filt), "-map", f"[{prev}]", "-map", "[a]", "-t", f"{total:.2f}",
                   "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p",
                   "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(outdir / f"{s['id']}.mp4")]
            subprocess.run(cmd, check=True)
            print("ok", s['id'])
        b.close()

if __name__ == "__main__":
    main(*sys.argv[1:4])

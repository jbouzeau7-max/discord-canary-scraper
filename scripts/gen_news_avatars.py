"""Génère les photos de profil des webhooks Actus (media/news-*.png).

Style « néon glass » : dégradé diagonal 2 tons + rayons lumineux + trame de
points + halo coloré + emoji Noto 3D + reflet vitré + anneau dégradé.

Ajustement au cercle Discord : l'emoji est mis à l'échelle selon la distance
réelle de ses pixels opaques au centre (pas sa boîte englobante), pour que
chaque forme (ballon rond, voiture large, micro en diagonale...) remplisse le
cercle au maximum SANS jamais être rognée.
Vérification : aucun pixel de l'emoji au-delà de SAFE × rayon (assert).

Usage : python3 scripts/gen_news_avatars.py  (requiert Pillow)
"""
import io
import math
import os
import urllib.request

from PIL import Image, ImageChops, ImageDraw, ImageFilter

NOTO = 'https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@99701e07d3d1fe1bdbcdb14964547f0fd592966f/3D/png/512/'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'media')
S = 512            # taille finale
W = S * 2          # rendu suréchantillonné
SAFE = 0.74        # rayon max (fraction du rayon) des pixels de l'emoji
MAX_SIDE = 0.66    # côté max de l'emoji (fraction du diamètre)

# name: (emoji, couleur sombre, couleur vive)
AV = {
    'monde':   ('1f30d', (18, 30, 110),  (88, 101, 242)),
    'social':  ('1f310', (90, 10, 80),   (235, 69, 158)),
    'foot':    ('26bd',  (4, 60, 30),    (87, 242, 135)),
    'tech':    ('1f4f1', (10, 25, 70),   (52, 152, 219)),
    'spotify': ('1f3a7', (4, 35, 18),    (29, 185, 84)),
    'gaming':  ('1f3ae', (40, 10, 90),   (168, 85, 247)),
    'cinema':  ('1f3ac', (70, 5, 15),    (239, 68, 68)),
    'f1':      ('1f3ce', (60, 0, 0),     (255, 60, 20)),
    'basket':  ('1f3c0', (80, 30, 0),    (251, 146, 60)),
    'science': ('1f680', (8, 8, 45),     (34, 211, 238)),
    'crypto':  ('1fa99', (70, 45, 0),    (250, 204, 21)),
    'rap':     ('1f3a4', (20, 20, 25),   (236, 72, 153)),
    'ia':      ('1f916', (10, 20, 60),   (99, 102, 241)),
    'anime':   ('1f365', (90, 10, 50),   (244, 114, 182)),
    'tennis':  ('1f3be', (40, 70, 0),    (190, 242, 100)),
    'mma':     ('1f94a', (60, 0, 10),    (220, 38, 38)),
    'auto':    ('1f697', (15, 25, 35),   (148, 163, 184)),
}


def lerp(a, b, t):
    return tuple(int(a[i] * (1 - t) + b[i] * t) for i in range(3))


def diag(flip=False):
    lg = Image.linear_gradient('L').resize((W * 2, W * 2)).rotate(-45 if flip else 45, resample=Image.BICUBIC)
    return lg.crop((W // 2, W // 2, W // 2 + W, W // 2 + W))


def gradient(c1, c2):
    """Dégradé diagonal : c1 en haut-gauche → c2 en bas-droite."""
    return Image.composite(Image.new('RGB', (W, W), c2), Image.new('RGB', (W, W), c1), diag()).convert('RGBA')


def layer():
    return Image.new('RGBA', (W, W), (0, 0, 0, 0))


def blurred_ellipse(box, fill, blur):
    im = layer()
    ImageDraw.Draw(im).ellipse(box, fill=fill)
    return im.filter(ImageFilter.GaussianBlur(blur))


def rays(n=14, alpha=30):
    im = layer()
    d = ImageDraw.Draw(im)
    c = W / 2
    for i in range(n):
        a0 = (i / n) * 2 * math.pi
        a1 = a0 + math.pi / n * 0.55
        d.polygon([(c, c), (c + W * math.cos(a0), c + W * math.sin(a0)), (c + W * math.cos(a1), c + W * math.sin(a1))],
                  fill=(255, 255, 255, alpha))
    im = im.filter(ImageFilter.GaussianBlur(W * 0.012))
    fade = ImageChops.invert(Image.radial_gradient('L').resize((W, W)))
    im.putalpha(ImageChops.multiply(im.split()[3], fade))
    return im


def dots(alpha=40):
    im = layer()
    d = ImageDraw.Draw(im)
    step = W // 22
    r = max(2, W // 260)
    for y in range(step // 2, W, step):
        for x in range(step // 2, W, step):
            d.ellipse((x - r, y - r, x + r, y + r), fill=(255, 255, 255, alpha))
    im.putalpha(ImageChops.multiply(im.split()[3], diag()))
    return im


def vignette():
    v = Image.radial_gradient('L').resize((W, W))      # 0 centre → 255 bord
    im = Image.new('RGBA', (W, W), (0, 0, 0, 255))
    im.putalpha(v.point(lambda p: min(150, int(max(0, p - 120) * 1.3))))
    return im


def opaque_far(alpha, cx, cy, step=1):
    px = alpha.load()
    far = 0.0
    for y in range(0, alpha.height, step):
        for x in range(0, alpha.width, step):
            if px[x, y] > 24:
                dd = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
                if dd > far:
                    far = dd
    return far


def fit_emoji(e):
    """Échelle max telle que tout pixel opaque reste sous SAFE × rayon."""
    e = e.crop(e.getbbox())
    w, h = e.size
    far = opaque_far(e.split()[3], w / 2, h / 2, step=2) + 2
    sc = min((SAFE * W / 2) / far, (MAX_SIDE * W) / max(w, h))
    return e.resize((max(1, int(w * sc)), max(1, int(h * sc))), Image.LANCZOS)


def fetch_emoji(code):
    url = NOTO + 'emoji_u' + code + '.png'
    last = None
    for _ in range(3):
        try:
            return Image.open(io.BytesIO(urllib.request.urlopen(url, timeout=30).read())).convert('RGBA')
        except Exception as ex:  # réseau instable : 3 essais
            last = ex
    raise last


def make(name, code, c1, c2):
    g = gradient(c1, c2)
    g = Image.alpha_composite(g, rays())
    g = Image.alpha_composite(g, dots())
    g = Image.alpha_composite(g, vignette())
    # halo coloré + cœur blanc derrière l'emoji
    light = lerp(c2, (255, 255, 255), 0.35)
    r = W * 0.40
    g = Image.alpha_composite(g, blurred_ellipse((W / 2 - r, W / 2 - r, W / 2 + r, W / 2 + r), light + (150,), W * 0.09))
    r = W * 0.22
    g = Image.alpha_composite(g, blurred_ellipse((W / 2 - r, W / 2 - r, W / 2 + r, W / 2 + r), (255, 255, 255, 110), W * 0.07))

    e = fit_emoji(fetch_emoji(code))
    ox, oy = (W - e.width) // 2, (W - e.height) // 2
    # ombre portée douce
    sd = Image.new('RGBA', e.size, (0, 0, 0, 255))
    sd.putalpha(e.split()[3].point(lambda v: int(v * 0.55)))
    sh = layer()
    sh.paste(sd, (ox, oy + int(W * 0.03)), sd)
    g = Image.alpha_composite(g, sh.filter(ImageFilter.GaussianBlur(W * 0.025)))
    g.alpha_composite(e, (ox, oy))

    # reflet vitré (haut)
    gl = layer()
    ImageDraw.Draw(gl).ellipse((-W * 0.25, -W * 0.72, W * 1.25, W * 0.42), fill=(255, 255, 255, 46))
    g = Image.alpha_composite(g, gl.filter(ImageFilter.GaussianBlur(W * 0.02)))

    # anneau dégradé + lueur (dans la zone visible du cercle)
    m = int(W * 0.03)
    ring_mask = Image.new('L', (W, W), 0)
    ImageDraw.Draw(ring_mask).ellipse((m, m, W - m, W - m), outline=255, width=int(W * 0.016))
    ring = layer()
    ring.paste(gradient(lerp(c2, (255, 255, 255), 0.85), lerp(c2, (255, 255, 255), 0.25)), (0, 0),
               ring_mask.point(lambda v: int(v * 0.85)))
    g = Image.alpha_composite(g, ring.filter(ImageFilter.GaussianBlur(W * 0.012)))
    g = Image.alpha_composite(g, ring)

    g.resize((S, S), Image.LANCZOS).convert('RGB').save(os.path.join(OUT, f'news-{name}.png'), optimize=True)
    # vérif exhaustive : rayon max des pixels opaques de l'emoji posé
    full = Image.new('L', (W, W), 0)
    full.paste(e.split()[3], (ox, oy))
    return opaque_far(full, W / 2, W / 2) / (W / 2)


def main():
    for n, (code, c1, c2) in AV.items():
        d = make(n, code, c1, c2)
        print(n, 'rayon max emoji = %.3f' % d)
        assert d <= SAFE + 0.01, n + ' dépasse la zone sûre du cercle'
    # aperçu : grille recadrée en cercle comme dans Discord
    cols, cell, sz = 6, 200, 180
    rows = math.ceil(len(AV) / cols)
    prev = Image.new('RGB', (cols * cell, rows * cell), (49, 51, 56))
    mask = Image.new('L', (sz * 4, sz * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, sz * 4 - 1, sz * 4 - 1), fill=255)
    mask = mask.resize((sz, sz), Image.LANCZOS)
    for i, n in enumerate(AV):
        im = Image.open(os.path.join(OUT, f'news-{n}.png')).resize((sz, sz), Image.LANCZOS)
        prev.paste(im, ((i % cols) * cell + 10, (i // cols) * cell + 10), mask)
    prev.save(os.path.join(OUT, 'news-avatars-preview.png'), optimize=True)


if __name__ == '__main__':
    main()

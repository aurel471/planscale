"""
core.py - Pläne laden, Vorschau rendern, Einrastpunkte auslesen und maßstäblich als PDF ausgeben.

Koordinaten: Quelle in PDF-Punkten (pt, 1/72 Zoll), Blatt in Millimetern.
Der Export bleibt vektorbasiert: die Quellseite wird als Form-XObject auf das neue Blatt gesetzt.
"""
from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass

import fitz  # PyMuPDF

MM_PER_PT = 25.4 / 72
PT_PER_MM = 72 / 25.4

PREVIEW_MAX_PX = 7000   # längste Kante des Vorschaubilds
PREVIEW_MAX_DPI = 200
SNAP_MAX_POINTS = 400_000

IMAGE_TYPES = {"png", "jpg", "jpeg", "tif", "tiff", "bmp", "gif", "webp"}


@dataclass
class Plan:
    id: str
    name: str
    doc: fitz.Document


_plans: dict[str, Plan] = {}


def load_plan(data: bytes, filename: str) -> Plan:
    """Öffnet PDF oder Bild. Bilder werden zu einer PDF-Seite gewandelt, damit alles gleich weiterläuft."""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "pdf"
    plan_id = hashlib.sha1(data).hexdigest()[:16]
    if plan_id in _plans:
        return _plans[plan_id]
    if ext in IMAGE_TYPES:
        img = fitz.open(stream=data, filetype=ext)
        doc = fitz.open("pdf", img.convert_to_pdf())
    else:
        doc = fitz.open(stream=data, filetype="pdf")
    if doc.page_count == 0:
        raise ValueError("Die Datei enthält keine Seiten.")
    plan = Plan(id=plan_id, name=filename, doc=doc)
    _plans[plan_id] = plan
    while len(_plans) > 8:  # nur die zuletzt geöffneten Pläne im Speicher halten
        _plans.pop(next(iter(_plans)))
    return plan


def get_plan(plan_id: str) -> Plan:
    if plan_id not in _plans:
        raise KeyError("Plan nicht mehr geladen - bitte erneut öffnen.")
    return _plans[plan_id]


def plan_info(plan: Plan) -> dict:
    pages = [{"w": p.rect.width, "h": p.rect.height} for p in plan.doc]
    return {"id": plan.id, "name": plan.name, "pages": pages}


def render_page(plan: Plan, pno: int) -> tuple[bytes, float]:
    """PNG der Seite mit transparentem Hintergrund. Gibt (png, Pixel pro pt) zurück."""
    page = plan.doc[pno]
    longest = max(page.rect.width, page.rect.height)
    zoom = min(PREVIEW_MAX_DPI / 72, PREVIEW_MAX_PX / longest)
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=True, annots=True)
    return pix.tobytes("png"), pix.width / page.rect.width


def snap_points(plan: Plan, pno: int) -> list[float]:
    """Endpunkte und Ecken aller Vektorpfade als flache Liste [x0, y0, x1, y1, ...] in Seitenkoordinaten."""
    page = plan.doc[pno]
    mat = page.rotation_matrix  # get_drawings liefert ungedrehte Koordinaten
    seen: set[tuple[int, int]] = set()
    out: list[float] = []

    def add(p):
        q = fitz.Point(p) * mat
        key = (round(q.x * 10), round(q.y * 10))
        if key not in seen:
            seen.add(key)
            out.extend((round(q.x, 3), round(q.y, 3)))

    for path in page.get_drawings():
        for item in path["items"]:
            kind = item[0]
            if kind == "l":
                add(item[1]); add(item[2])
            elif kind == "c":
                add(item[1]); add(item[4])
            elif kind == "re":
                r = item[1]
                for p in (r.tl, r.tr, r.br, r.bl):
                    add(p)
            elif kind == "qu":
                q = item[1]
                for p in (q.ul, q.ur, q.lr, q.ll):
                    add(p)
        if len(out) >= SNAP_MAX_POINTS * 2:
            break
    return out


# ---------------------------------------------------------------- Export

@dataclass
class Layout:
    pno: int
    sheet_w_mm: float
    sheet_h_mm: float
    mm_per_pt: float        # Papier-mm je Quell-pt (der eigentliche Skalierfaktor)
    rotation: int           # Drehung im Uhrzeigersinn: 0, 90, 180, 270
    offset_x_mm: float      # linke obere Ecke des (gedrehten) Plans auf dem Blatt
    offset_y_mm: float
    scale_label: str = ""   # z.B. "M 1:50", leer = keine Beschriftung
    real_mm_per_paper_mm: float = 0.0  # >0 aktiviert die Maßstabsleiste
    margin_mm: float = 10.0
    frame: bool = False     # Rahmen auf dem Rand zeichnen


def _nice_bar_length(real_per_paper: float, target_paper_mm: float = 60.0) -> float:
    """Runde Maßstabsleisten-Länge (1/2/5 x 10^n mm real) nahe der Wunschlänge auf dem Papier."""
    raw = target_paper_mm * real_per_paper
    exp = 10 ** math.floor(math.log10(raw))
    for f in (5, 2, 1):
        if f * exp <= raw:
            return f * exp
    return exp


def _fmt_real(mm: float) -> str:
    if mm >= 1000:
        v, unit = mm / 1000, "m"
    elif mm >= 10:
        v, unit = mm / 10, "cm"
    else:
        v, unit = mm, "mm"
    s = f"{v:.2f}".rstrip("0").rstrip(".").replace(".", ",")
    return f"{s} {unit}"


def export_pdf(plan: Plan, lay: Layout) -> bytes:
    src_page = plan.doc[lay.pno]
    w_pt, h_pt = src_page.rect.width, src_page.rect.height
    pw, ph = w_pt * lay.mm_per_pt, h_pt * lay.mm_per_pt
    box_w, box_h = (pw, ph) if lay.rotation in (0, 180) else (ph, pw)

    out = fitz.open()
    page = out.new_page(width=lay.sheet_w_mm * PT_PER_MM, height=lay.sheet_h_mm * PT_PER_MM)
    x0, y0 = lay.offset_x_mm * PT_PER_MM, lay.offset_y_mm * PT_PER_MM
    target = fitz.Rect(x0, y0, x0 + box_w * PT_PER_MM, y0 + box_h * PT_PER_MM)
    # show_pdf_page dreht gegen den Uhrzeigersinn, die App rechnet im Uhrzeigersinn
    page.show_pdf_page(target, plan.doc, lay.pno, keep_proportion=True, rotate=(360 - lay.rotation) % 360)

    m = lay.margin_mm * PT_PER_MM
    if lay.frame:
        page.draw_rect(fitz.Rect(m, m, page.rect.width - m, page.rect.height - m), color=(0, 0, 0), width=0.5)

    bar_y = page.rect.height - m - 4 * PT_PER_MM
    bx = m + 4 * PT_PER_MM
    if lay.real_mm_per_paper_mm > 0:
        real_len = _nice_bar_length(lay.real_mm_per_paper_mm)
        bar_len = real_len / lay.real_mm_per_paper_mm * PT_PER_MM
        seg = bar_len / 5
        bh = 1.6 * PT_PER_MM
        rect = fitz.Rect(bx, bar_y - bh, bx + bar_len, bar_y)
        page.draw_rect(rect, color=(0, 0, 0), fill=(1, 1, 1), width=0.4)
        for i in range(0, 5, 2):
            page.draw_rect(fitz.Rect(bx + i * seg, bar_y - bh, bx + (i + 1) * seg, bar_y), color=None, fill=(0, 0, 0))
        page.draw_rect(rect, color=(0, 0, 0), width=0.4)
        page.insert_text((bx - 1, bar_y - bh - 2), "0", fontsize=6.5, fontname="helv")
        label = _fmt_real(real_len)
        tw = fitz.get_text_length(label, fontname="helv", fontsize=6.5)
        page.insert_text((bx + bar_len - tw / 2, bar_y - bh - 2), label, fontsize=6.5, fontname="helv")
        bx += bar_len + 6 * PT_PER_MM
    if lay.scale_label:
        page.insert_text((bx, bar_y), lay.scale_label, fontsize=9, fontname="hebo")

    return out.tobytes(garbage=3, deflate=True)

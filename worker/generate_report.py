# -*- coding: utf-8 -*-
"""
generate_report.py
Tạo PDF phiếu tiêm/truyền dạng card 2 cột A4.
- Input : DuLieu_PhanLoai.json
- Output: PDF

Ca mặc định: cả ngày (0h-23h), hiển thị tất cả giờ dùng thuốc.

Tham số:
  --date      dd/mm/yyyy          lọc 1 ngày
  --from/--to dd/mm/yyyy          lọc khoảng ngày (inclusive)
  --start     giờ (0-23)          giờ bắt đầu ca (mặc định: 0)
  --end       giờ (0-23)          giờ kết thúc ca (mặc định: 23)
  --no0                           bỏ qua giờ 0h
"""

import argparse
import json
import os
import re
from shared.text_utils import norm_space as norm
import unicodedata
from datetime import datetime

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

# ─── Regex trích giờ ─────────────────────────────────────────────────────────
_RE_GIO_WORD  = re.compile(r"(?<!\d)(\d{1,2})\s*(?:gi(?:ờ|o)|h)\b", re.IGNORECASE)
_RE_GIO_HHMM  = re.compile(r"(?<!\d)(\d{1,2})\s*h(?=\s*\d{2}\b)",   re.IGNORECASE)
_RE_GIO_COLON = re.compile(r"(?<!\d)(\d{1,2})\s*:\s*(\d{2})\b")
# Nhận diện y lệnh theo khoảng cách, ví dụ: "mỗi 6h", "mỗi 8 giờ", "q6h".
# Nếu không xử lý riêng, regex giờ sẽ hiểu nhầm "mỗi 6h" là chỉ có 06h.
_RE_EVERY_HOURS = re.compile(
    r"\b(?:moi|q|cach)\s*(\d{1,2})\s*(?:h|gio)\b",
    re.IGNORECASE,
)


# ─── Helpers ─────────────────────────────────────────────────────────────────
def _to_int(x, default=None):
    try:
        return int(str(x).strip())
    except Exception:
        return default

def _parse_dmy(s):
    try:
        return datetime.strptime((s or "").strip(), "%d/%m/%Y")
    except Exception:
        return None

def _hour_from_tg(tg):
    """Lấy giờ từ chuỗi 'HH:MM dd/mm/yyyy' hoặc 'HH:MM'."""
    try:
        hh = int((tg or "").strip().split()[0].split(":")[0])
        return hh if 0 <= hh <= 23 else None
    except Exception:
        return None

# norm → shared.text_utils.norm_space

def ellipsize(text, max_chars):
    t = norm(text)
    if len(t) <= max_chars:
        return t
    return t[:max(1, max_chars - 1)].rstrip() + "…"


# ─── Font ────────────────────────────────────────────────────────────────────
def _find_system_fonts():
    """Tìm các font hỗ trợ Unicode/tiếng Việt trên hệ thống hiện tại."""
    import glob
    here = os.path.dirname(os.path.abspath(__file__))
    candidates_reg = [
        # Font kèm theo dự án (ưu tiên cao nhất)
        os.path.join(here, "DejaVuSans.ttf"),
        # Linux
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
        # macOS
        "/Library/Fonts/Arial Unicode MS.ttf",
        "/System/Library/Fonts/Supplemental/Arial Unicode MS.ttf",
        "/Library/Fonts/Arial.ttf",
        # Windows
        r"C:\Windows\Fonts\arial.ttf",
        r"C:\Windows\Fonts\calibri.ttf",
        r"C:\Windows\Fonts\tahoma.ttf",
    ]
    candidates_bold = [
        os.path.join(here, "DejaVuSans-Bold.ttf"),
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/Library/Fonts/Arial Bold.ttf",
        r"C:\Windows\Fonts\arialbd.ttf",
        r"C:\Windows\Fonts\calibrib.ttf",
        r"C:\Windows\Fonts\tahomabd.ttf",
    ]
    # Quét thêm bằng glob (hữu ích trên Linux với font được cài tùy chỉnh)
    for pattern in ["/usr/share/fonts/**/*Sans*Regular*.ttf", "/usr/share/fonts/**/*Arial*.ttf"]:
        candidates_reg.extend(glob.glob(pattern, recursive=True))
    for pattern in ["/usr/share/fonts/**/*Sans*Bold*.ttf", "/usr/share/fonts/**/*Arial*Bold*.ttf"]:
        candidates_bold.extend(glob.glob(pattern, recursive=True))
    return candidates_reg, candidates_bold


def _register_fonts():
    candidates_reg, candidates_bold = _find_system_fonts()

    def try_reg(name, paths):
        for p in paths:
            if p and os.path.exists(p):
                try:
                    pdfmetrics.registerFont(TTFont(name, p))
                    print(f"[FONT] Đã load font '{name}' từ: {p}")
                    return name
                except Exception:
                    pass
        # Fallback: ReportLab built-in (không hỗ trợ tiếng Việt đầy đủ nhưng không crash)
        print(f"[FONT] WARN: Không tìm thấy font Unicode cho '{name}' — tiếng Việt có thể bị lỗi. "
              f"Cài DejaVu Sans hoặc đặt DejaVuSans.ttf vào thư mục worker/.")
        return "Helvetica"

    reg  = try_reg("VN",  candidates_reg)
    bold = try_reg("VNB", candidates_bold)
    if bold == "Helvetica":
        bold = reg  # dùng cùng font nếu bold không tìm được
    return reg, bold


# ─── Parse giờ ───────────────────────────────────────────────────────────────
def _strip_accents(text):
    """Bỏ dấu tiếng Việt để nhận diện các cụm như 'mỗi 6h' ổn định hơn."""
    s = str(text or "")
    s = unicodedata.normalize("NFD", s)
    return "".join(ch for ch in s if unicodedata.category(ch) != "Mn")

def _every_interval_hours(text):
    """Trả về khoảng lặp giờ nếu y lệnh có dạng 'mỗi 6h', 'mỗi 8 giờ', 'q6h'."""
    t = _strip_accents(text).lower()
    t = re.sub(r"\s+", " ", t)
    m = _RE_EVERY_HOURS.search(t)
    if not m:
        return None
    n = _to_int(m.group(1), None)
    if not n or n <= 0 or n > 24:
        return None
    return n

def _expand_every_hours(start_hour, interval):
    """Mở rộng lịch lặp từ giờ bắt đầu: 6h mỗi 6h -> 06,12,18,00."""
    if start_hour is None or interval is None:
        return []
    try:
        start_hour = int(start_hour) % 24
        interval = int(interval)
    except Exception:
        return []
    if interval <= 0 or interval > 24:
        return [start_hour]
    out = []
    seen = set()
    h = start_hour
    # Tối đa 24 bước để tránh vòng lặp vô hạn nếu interval bất thường.
    for _ in range(24):
        if h in seen:
            break
        seen.add(h)
        out.append(h)
        h = (h + interval) % 24
    return out

def _parse_hours_str(text, allow_colon=False):
    if not text:
        return []
    s  = str(text)
    hs = set()

    def add(h):
        if h == 24: h = 0
        if 0 <= h <= 23: hs.add(h)

    for m in _RE_GIO_WORD.finditer(s):
        add(_to_int(m.group(1), -1))
    for m in _RE_GIO_HHMM.finditer(s):
        add(_to_int(m.group(1), -1))
    if allow_colon:
        for m in _RE_GIO_COLON.finditer(s):
            h  = _to_int(m.group(1), -1)
            mm = (m.group(2) or "").strip()
            if h == 24 and mm != "00":
                continue
            add(h)
    return sorted(hs)

def collect_hours(item):
    duong_dung_goc = item.get("duong_dung_goc") or ""
    gio_dung = item.get("gio_dung") or ""

    # Trường hợp y lệnh ghi theo khoảng cách như "mỗi 6h" / "q6h":
    # không được hiểu số 6 là giờ duy nhất. Ưu tiên giờ đã được parser tách ra
    # ở từng lần truyền; nếu chỉ có 1 mốc bắt đầu thì mở rộng ra cả ngày.
    interval = _every_interval_hours(duong_dung_goc)
    if interval:
        explicit_hours = _parse_hours_str(gio_dung, allow_colon=True)
        start_hour = explicit_hours[0] if explicit_hours else _hour_from_tg(item.get("tg_bat_dau") or "")
        if start_hour is not None:
            return _expand_every_hours(start_hour, interval)
        return explicit_hours

    hours = _parse_hours_str(duong_dung_goc)
    if not hours:
        hours = _parse_hours_str(gio_dung, allow_colon=True)
    if not hours:
        h = _hour_from_tg(item.get("tg_bat_dau") or "")
        if h is not None:
            hours = [h]
    return hours


# ─── Lọc giờ theo ca ─────────────────────────────────────────────────────────
def filter_hours(hours, start, end, include0):
    """
    Lọc giờ nằm trong ca.
    - Ca thông thường (start <= end): giờ trong [start..end]
    - Ca qua ngày    (start > end) : giờ >= start HOẶC giờ <= end
    - start=0, end=23              : lấy tất cả
    """
    if not hours:
        return []
    out = []
    for h in hours:
        if h == 0 and not include0:
            continue
        if start == 0 and end == 23:
            out.append(h)
        elif start <= end:
            if start <= h <= end:
                out.append(h)
        else:
            # ca qua ngày: vd 22h–6h
            if h >= start or h <= end:
                out.append(h)
    return sorted(set(out))


# ─── Phân loại ───────────────────────────────────────────────────────────────
def is_prn(item):
    s = (item.get("duong_dung_goc") or "").lower()
    return "khi cần" in s or "khi can" in s

def is_continuous(item):
    has_tg = bool(item.get("tg_bat_dau") or item.get("tg_ket_thuc"))
    hours  = (_parse_hours_str(item.get("gio_dung") or "", allow_colon=True)
              or _parse_hours_str(item.get("duong_dung_goc") or ""))
    return has_tg and not hours

def route_abbr(dd):
    s = (dd or "").lower()
    if "khi cần" in s or "khi can" in s:   return "KCN"
    if "uống"   in s or "uong"   in s:     return "U"
    if "tiêm bắp" in s or "tiem bap" in s: return "TB"
    if "tiêm dưới da" in s:                return "TDD"
    if "tiêm" in s and "mạch" in s:        return "TMC"
    if "truyền" in s or "ttm" in s:        return "TTM"
    return ""

def _fmt_vol(ml):
    try:
        v = float(str(ml).replace(",", "."))
        if v <= 0: return ""
        return f"{int(round(v))}ml" if abs(v - round(v)) < 1e-9 else f"{v:g}ml"
    except Exception:
        return ""

def pick_name(item):
    name = norm(item.get("ten_hien_thi") or item.get("ten_thuoc") or "")
    if not name: return ""
    ml   = item.get("the_tich") or item.get("tui_dich_truyen_ml")
    vol  = _fmt_vol(ml)
    if not vol or re.search(r"\b\d+(?:[.,]\d+)?\s*ml\b", name, re.IGNORECASE):
        return name
    try:
        ml_v = float(str(ml).replace(",", "."))
    except Exception:
        ml_v = 0.0
    route = (item.get("duong_dung_goc") or "").lower()
    if (item.get("dung_moi") or ml_v >= 50
            or any(k in route for k in ["truyền", "truyen", "ttm"])):
        return f"{name} ({vol})"
    return name


# ─── Build cards ─────────────────────────────────────────────────────────────
def build_cards(records, start, end, include0, show_date):
    cards = []
    for rec in records:
        if not isinstance(rec, dict):
            continue
        thuoc = rec.get("thuoc") or {}
        meds  = []

        for cat in ("dich_truyen", "thuoc_tiem", "khac"):
            for item in (thuoc.get(cat) or []):
                if not isinstance(item, dict): continue
                name  = pick_name(item)
                if not name: continue
                prn   = is_prn(item)
                cont  = is_continuous(item)
                hours = filter_hours(collect_hours(item), start, end, include0)
                if not hours and not prn and not cont:
                    continue
                ab     = route_abbr(item.get("duong_dung_goc") or "")
                so_lo  = item.get("so_lo_moi_lan")   # int | None
                don_vi = (item.get("dang") or "").strip().lower()
                key    = (name, ab, prn, cont)
                meds.append((key, hours, item, so_lo, don_vi))

        merged = {}
        for (key, hours, item, so_lo, don_vi) in meds:
            if key not in merged:
                merged[key] = {
                    "name": key[0], "abbr": key[1],
                    "prn":  key[2], "cont": key[3],
                    "hours":       set(hours),
                    "tg_bat_dau":  item.get("tg_bat_dau")  or "",
                    "tg_ket_thuc": item.get("tg_ket_thuc") or "",
                    "so_lo_map":   {},    # {gio_int: qty}
                    "don_vi":      don_vi,
                    "toc_do":      item.get("toc_do") or "",
                }
            else:
                merged[key]["hours"].update(hours)
                for fld in ("tg_bat_dau", "tg_ket_thuc"):
                    if not merged[key][fld] and item.get(fld):
                        merged[key][fld] = item[fld]
                if don_vi and not merged[key]["don_vi"]:
                    merged[key]["don_vi"] = don_vi
            # Ghi số lọ/túi theo từng giờ
            if so_lo is not None:
                for h in hours:
                    merged[key]["so_lo_map"][h] = so_lo

        rows = list(merged.values())

        def _sk(r):
            if r["prn"]: return (99, r["name"])
            if r["cont"]:
                h = _hour_from_tg(r.get("tg_bat_dau") or "")
                return (h if h is not None else 99, r["name"])
            hs = sorted(r["hours"], key=lambda h: 24 if h == 0 else h)
            return (24 if hs[0] == 0 else hs[0] if hs else 99, r["name"])

        rows.sort(key=_sk)
        if not rows: continue

        day   = rec.get("ngay_lam") or ""
        phong = rec.get("so_phong") or "?"
        cards.append({
            "phong": phong,
            "ten":   norm(rec.get("ho_ten") or "KHÔNG RÕ"),
            "ma_bn": str(rec.get("ma_bn") or ""),
            "ngay":  day if show_date else "",
            "rows":  rows,
        })
    return cards



def _snapshot_time_minutes(value):
    m = re.match(r"^(\d{1,2}):(\d{2})$", str(value or "").strip())
    if not m:
        return None
    h, minute = int(m.group(1)), int(m.group(2))
    if not (0 <= h <= 23 and 0 <= minute <= 59):
        return None
    return h * 60 + minute


def _snapshot_time_in_range(value, start, end, include0):
    minutes = _snapshot_time_minutes(value)
    if minutes is None:
        return True
    h = minutes // 60
    if h == 0 and not include0:
        return False
    if start == 0 and end == 23:
        return True
    if start <= end:
        return start <= h <= end
    return h >= start or h <= end


def build_cards_from_rows(rows, start=0, end=23, include0=True, report_date=""):
    """Dựng card trực tiếp từ các dòng đã chuẩn hóa ở frontend.

    Mỗi dòng snapshot được giữ là một dòng y lệnh riêng; không merge theo tên thuốc,
    nhờ vậy PDF không thể ghi đè số lượng của hai y lệnh khác nhau.
    """
    grouped = {}
    order = []
    for idx, raw in enumerate(rows or []):
        if not isinstance(raw, dict):
            continue
        name = norm(raw.get("drugName") or "")
        if not name:
            continue

        time_value = str(raw.get("time") or "").strip()
        no_time = bool(raw.get("noTime")) or not _snapshot_time_minutes(time_value)
        if not no_time and not _snapshot_time_in_range(time_value, start, end, include0):
            continue

        day = str(raw.get("date") or report_date or "").strip()
        room = str(raw.get("room") or "—").strip() or "—"
        patient_name = norm(raw.get("patientName") or "KHÔNG RÕ")
        patient_id = str(raw.get("patientId") or "").strip()
        key = (patient_id or patient_name, room, patient_name, day)
        if key not in grouped:
            grouped[key] = {
                "phong": room,
                "ten": patient_name,
                "ma_bn": patient_id,
                "ngay": day,
                "rows": [],
            }
            order.append(key)

        route = str(raw.get("route") or "").strip()
        unit = str(raw.get("unit") or "").strip().lower()
        quantity = raw.get("quantity")
        try:
            quantity = float(quantity)
            if quantity.is_integer():
                quantity = int(quantity)
        except Exception:
            quantity = None

        slot = time_value if not no_time else ""
        so_lo_map = {slot: quantity} if slot and quantity is not None else {}
        note_badge = "chưa rõ giờ" if no_time else ""
        if raw.get("tuTuc"):
            note_badge = f"{note_badge} · tự túc".strip(" ·") if note_badge else "tự túc"

        grouped[key]["rows"].append({
            "name": name,
            "abbr": route,
            "prn": False,
            "cont": False,
            "hours": set([slot]) if slot else set(),
            "tg_bat_dau": "",
            "tg_ket_thuc": "",
            "so_lo_map": so_lo_map,
            "don_vi": unit,
            "toc_do": "",
            "note_badge": note_badge,
            "_source_index": idx,
        })

    def room_key(value):
        m = re.search(r"(\d+)", value or "")
        return (int(m.group(1)) if m else 9999, value or "")

    cards = [grouped[key] for key in order]
    cards.sort(key=lambda card: (
        _parse_dmy(card.get("ngay") or "") or datetime.max,
        room_key(card.get("phong") or ""),
        norm(card.get("ten") or ""),
    ))
    for card in cards:
        card["rows"].sort(key=lambda row: (
            _snapshot_time_minutes(next(iter(row.get("hours") or []), "")) if row.get("hours") else 9999,
            row.get("_source_index", 999999),
        ))
    return cards


# ─── Bảng màu — print-first, no-border design ────────────────────────────────
C_PAGE_HDR_BG  = colors.HexColor("#1e293b")   # header trang
C_PAGE_HDR_TXT = colors.white
C_PAGE_HDR_SUB = colors.HexColor("#94a3b8")

# Patient header strip — xanh dương rất nhạt, không viền
C_PT_HDR_BG    = colors.HexColor("#eff6ff")   # blue-50
C_PT_HDR_ROOM  = colors.HexColor("#1e40af")   # blue-800, đậm để nổi
C_PT_HDR_NAME  = colors.HexColor("#0f172a")
C_PT_HDR_ID    = colors.HexColor("#94a3b8")

# Column header (giờ) — xám nhạt
C_COL_HDR_BG   = colors.HexColor("#f1f5f9")   # slate-100
C_COL_HDR_TXT  = colors.HexColor("#475569")   # slate-600

# Drug rows — zebra striping, không đường kẻ
C_ROW_ODD      = colors.white
C_ROW_EVEN     = colors.HexColor("#f8fafc")   # slate-50

C_DRUG_BOLD    = colors.HexColor("#0f172a")   # tên thuốc — đen đậm
C_BADGE_BG     = colors.HexColor("#e2e8f0")   # slate-200 — badge route/speed
C_BADGE_TXT    = colors.HexColor("#475569")   # slate-600

# Checkbox □ để điều dưỡng ký nháy
C_CHECK_BDR    = colors.HexColor("#64748b")   # slate-500 — viền ô trống
C_CHECK_BG     = colors.white


# ─── Render PDF ──────────────────────────────────────────────────────────────
def render_pdf(cards, out_path, start, end, gen_date, report_date_label=""):
    font_r, font_b = _register_fonts()

    W, H        = A4
    MARGIN      = 14
    GAP         = 4    # khoảng cách giữa 2 cột
    CARD_W      = (W - 2 * MARGIN - GAP) / 2

    PAGE_HDR_H  = 20
    PT_HDR_H    = 18   # dải tên bệnh nhân
    COL_HDR_H   = 11   # dải tiêu đề giờ
    ROW_H       = 17   # dòng thuốc
    CARD_GAP    = 8    # khoảng trắng giữa các bệnh nhân (thay viền)
    PAD_X       = 7
    MIN_NAME_W  = 90

    def sw(s, fs, fn=None):
        return pdfmetrics.stringWidth(s, fn or font_r, fs)

    def slot_sort_value(slot):
        if isinstance(slot, int):
            return (24 * 60) if slot == 0 else slot * 60
        m = re.match(r"^(\d{1,2}):(\d{2})$", str(slot or "").strip())
        if not m:
            return 999999
        value = int(m.group(1)) * 60 + int(m.group(2))
        return 24 * 60 if value == 0 else value

    def slot_label(slot):
        if isinstance(slot, int):
            return f"{slot:02d}h"
        m = re.match(r"^(\d{1,2}):(\d{2})$", str(slot or "").strip())
        if not m:
            return str(slot or "")
        h, minute = int(m.group(1)), int(m.group(2))
        return f"{h:02d}h" if minute == 0 else f"{h:02d}:{minute:02d}"

    def get_card_hours(rows):
        hs = set()
        for r in rows:
            if r.get("prn") or r.get("cont"):
                continue
            hs.update(r.get("hours", []))
        return sorted(hs, key=slot_sort_value)

    def col_layout(n_cols):
        avail = CARD_W - 2 * PAD_X
        for cw in (22, 20, 18, 16):
            nw = avail - n_cols * cw
            if nw >= MIN_NAME_W:
                return cw, nw
        cw = max(14, int((avail - MIN_NAME_W) / max(n_cols, 1)))
        return cw, avail - n_cols * cw

    def calc_card_h(rows, hours):
        return PT_HDR_H + (COL_HDR_H if hours else 0) + len(rows) * ROW_H

    def draw_page_header(cv, pn):
        y = H - MARGIN
        cv.setFillColor(C_PAGE_HDR_BG)
        cv.rect(MARGIN, y - PAGE_HDR_H, W - 2 * MARGIN, PAGE_HDR_H, stroke=0, fill=1)
        ca_lbl = "CẢ NGÀY" if (start == 0 and end == 23) else f"CA {start:02d}h – {end:02d}h"
        cv.setFillColor(C_PAGE_HDR_TXT)
        cv.setFont(font_b, 8)
        date_part = f"NGÀY THỰC HIỆN: {report_date_label}  ·  " if report_date_label else ""
        cv.drawString(MARGIN + PAD_X, y - PAGE_HDR_H + 7,
                      f"PHIẾU TIÊM TRUYỀN  ·  {ca_lbl}  ·  {date_part}Tạo lúc {gen_date}")
        cv.setFillColor(C_PAGE_HDR_SUB)
        cv.setFont(font_r, 7)
        cv.drawRightString(W - MARGIN - PAD_X, y - PAGE_HDR_H + 7, f"Trang {pn}")

    x_card_cols = [MARGIN, MARGIN + CARD_W + GAP]
    y_top    = H - MARGIN - PAGE_HDR_H - 6
    page_num = 1
    col      = 0
    y        = y_top

    cv = canvas.Canvas(out_path, pagesize=A4)
    draw_page_header(cv, page_num)

    for card in cards:
        rows  = card["rows"]
        hours = get_card_hours(rows)
        ch    = calc_card_h(rows, hours)

        if y - ch < MARGIN:
            if col == 0:
                col = 1
                y   = y_top
            else:
                cv.showPage()
                page_num += 1
                draw_page_header(cv, page_num)
                col = 0
                y   = y_top

        x0 = x_card_cols[col]
        y0 = y

        # ── Dải tên bệnh nhân — màu nền, KHÔNG viền ───────────────────────
        cv.setFillColor(C_PT_HDR_BG)
        cv.rect(x0, y0 - PT_HDR_H, CARD_W, PT_HDR_H, stroke=0, fill=1)

        y_hdr_mid = y0 - PT_HDR_H / 2 - 2.5
        cv.setFillColor(C_PT_HDR_ROOM)
        cv.setFont(font_b, 8)
        phong_txt = card["phong"]
        cv.drawString(x0 + PAD_X, y_hdr_mid, phong_txt)
        phong_w = sw(phong_txt, 8, font_b)

        sep = "  ·  "
        sep_w = sw(sep, 7.5, font_r)
        cv.setFont(font_r, 7.5)
        cv.setFillColor(C_PT_HDR_ID)
        cv.drawString(x0 + PAD_X + phong_w, y_hdr_mid, sep)

        x_ten = x0 + PAD_X + phong_w + sep_w
        id_w  = sw(card["ma_bn"], 6.5, font_r) + PAD_X + 2
        max_ten = CARD_W - (x_ten - x0) - id_w
        ten = card["ten"]
        cv.setFillColor(C_PT_HDR_NAME)
        cv.setFont(font_b, 8)
        if sw(ten, 8, font_b) > max_ten:
            while ten and sw(ten + "…", 8, font_b) > max_ten:
                ten = ten[:-1]
            ten = ten.rstrip() + "…"
        cv.drawString(x_ten, y_hdr_mid, ten)

        if card["ma_bn"]:
            lbl = card["ma_bn"] + (f"  {card['ngay']}" if card.get("ngay") else "")
            cv.setFont(font_r, 6.5)
            cv.setFillColor(C_PT_HDR_ID)
            cv.drawRightString(x0 + CARD_W - PAD_X, y_hdr_mid, lbl)

        # ── Dải tiêu đề cột giờ — KHÔNG đường kẻ dọc ─────────────────────
        n_cols = len(hours)
        if n_cols:
            cw, name_w = col_layout(n_cols)
            x_grid = x0 + PAD_X + name_w

            y_col_top = y0 - PT_HDR_H
            y_col_bot = y_col_top - COL_HDR_H

            cv.setFillColor(C_COL_HDR_BG)
            cv.rect(x0, y_col_bot, CARD_W, COL_HDR_H, stroke=0, fill=1)

            cv.setFont(font_b, 6)
            cv.setFillColor(C_COL_HDR_TXT)
            for i, h in enumerate(hours):
                xc = x_grid + i * cw
                cv.drawCentredString(xc + cw / 2, y_col_bot + 3, slot_label(h))

            y_rows_start = y_col_bot
        else:
            name_w       = CARD_W - 2 * PAD_X
            cw           = 0
            x_grid       = x0 + PAD_X + name_w
            y_rows_start = y0 - PT_HDR_H

        # ── Các dòng thuốc — zebra striping, không đường kẻ ──────────────
        y_ln = y_rows_start
        for idx, r in enumerate(rows):
            y_mid = y_ln - ROW_H / 2

            # Zebra: xen kẽ trắng / xám rất nhạt
            cv.setFillColor(C_ROW_ODD if idx % 2 == 0 else C_ROW_EVEN)
            cv.rect(x0, y_ln - ROW_H, CARD_W, ROW_H, stroke=0, fill=1)

            # ── Tên thuốc (bold) + badge route/speed inline ───────────────
            so_lo_map = r.get("so_lo_map") or {}
            don_vi    = (r.get("don_vi") or "").strip().lower()
            dv   = "lọ" if "lọ" in don_vi else "túi" if "túi" in don_vi else "ống" if "ống" in don_vi else ""
            qtys = [v for v in so_lo_map.values() if v is not None]
            qty_str = ""
            if qtys and dv:
                qty_str = f" {qtys[0]}{dv}" if len(set(qtys)) == 1 else f" {max(qtys)}/{min(qtys)}{dv}"

            abbr   = r["abbr"]
            toc_do = str(r.get("toc_do") or "").strip()

            # Ghi chú KCN / BD→KT cho dòng phụ
            note = str(r.get("note_badge") or "").strip()
            note_color = C_BADGE_TXT
            if note:
                note_color = colors.HexColor("#92400e") if "chưa rõ giờ" in note else C_BADGE_TXT
            elif r.get("prn"):
                note = "khi cần"
                note_color = colors.HexColor("#7f1d1d")
            elif r.get("cont"):
                bd = _hour_from_tg(r.get("tg_bat_dau") or "")
                kt = _hour_from_tg(r.get("tg_ket_thuc") or "")
                note = f"BD{bd:02d}h→KT{kt:02d}h" if bd is not None and kt is not None else "truyền liên tục"
                note_color = colors.HexColor("#3730a3")

            # Badge: route + speed — vẽ trước để biết độ rộng
            badge_parts = []
            if abbr:
                badge_parts.append(abbr)
            if toc_do:
                badge_parts.append(f"{toc_do}g/ph")
            if note:
                badge_parts = [note]  # note thay thế badge thông thường
            badge_txt = "  ".join(badge_parts)
            badge_w = 0
            BADGE_FS = 5.5
            BADGE_PAD = 3
            if badge_txt:
                badge_w = sw(badge_txt, BADGE_FS, font_r) + BADGE_PAD * 2
            badge_h = 7.5

            # Tên thuốc — truncate để nhường chỗ cho badge
            txt     = norm(f"{r['name']}{qty_str}")
            max_w   = name_w - (badge_w + 4 if badge_w else 0) - 3
            cv.setFont(font_b, 7.5)
            if sw(txt, 7.5, font_b) > max_w:
                while txt and sw(txt + "…", 7.5, font_b) > max_w:
                    txt = txt[:-1]
                txt = txt.rstrip() + "…"
            cv.setFillColor(C_DRUG_BOLD)
            y_name = y_ln - ROW_H * 0.42
            cv.drawString(x0 + PAD_X, y_name, txt)

            # Badge — cùng dòng với tên, sát lề phải cột tên
            if badge_txt:
                bx = x0 + PAD_X + name_w - badge_w - 1
                by = y_mid - badge_h / 2
                # Badge đặc biệt (KCN/cont) dùng màu khác
                if note:
                    cv.setFillColor(colors.HexColor("#f1f5f9"))
                else:
                    cv.setFillColor(C_BADGE_BG)
                cv.roundRect(bx, by, badge_w, badge_h, 2, stroke=0, fill=1)
                cv.setFillColor(note_color if note else C_BADGE_TXT)
                cv.setFont(font_b if note else font_r, BADGE_FS)
                cv.drawCentredString(bx + badge_w / 2, by + 1.8, badge_txt)

            # ── Checkbox □ để điều dưỡng ký nháy ─────────────────────────
            if n_cols and not r.get("prn") and not r.get("cont"):
                row_hours = r.get("hours", set())
                sq = 6.5
                for i, h in enumerate(hours):
                    xc = x_grid + i * cw
                    sx = xc + (cw - sq) / 2
                    sy = y_mid - sq / 2
                    if h in row_hours:
                        # Ô rỗng □ — chỉ viền, để điều dưỡng ký nháy
                        cv.setFillColor(C_CHECK_BG)
                        cv.setStrokeColor(C_CHECK_BDR)
                        cv.setLineWidth(0.8)
                        cv.rect(sx, sy, sq, sq, stroke=1, fill=1)
                    # Ô không áp dụng: không vẽ gì — khoảng trắng sạch

            y_ln -= ROW_H

        # Khoảng trắng giữa bệnh nhân — thay cho viền card
        y = y0 - ch - CARD_GAP

    cv.save()


# ─── Main ────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input",  default="DuLieu_PhanLoai.json")
    ap.add_argument("--rows-input", default="", help="JSON snapshot các dòng đã chuẩn hóa từ Báo cáo trực")
    ap.add_argument("--out",    default="Phieu_Tiem_Truyen.pdf")
    ap.add_argument("--date",   default="")
    ap.add_argument("--from",   dest="from_date", default="")
    ap.add_argument("--to",     dest="to_date",   default="")
    ap.add_argument("--start",  type=int, default=0,
                    help="Giờ bắt đầu ca (0 = cả ngày khi end=23)")
    ap.add_argument("--end",    type=int, default=23,
                    help="Giờ kết thúc ca (23 = cả ngày khi start=0)")
    ap.add_argument("--no0",    action="store_true", help="Bỏ qua giờ 0h")
    args = ap.parse_args()

    include0 = not args.no0

    if args.rows_input:
        with open(args.rows_input, "r", encoding="utf-8") as f:
            snapshot = json.load(f)
        if isinstance(snapshot, list):
            snapshot = {"rows": snapshot}
        rows = snapshot.get("rows") if isinstance(snapshot, dict) else []
        report_date = args.date.strip() or str((snapshot or {}).get("date") or "").strip()
        cards = build_cards_from_rows(rows, args.start, args.end, include0, report_date)
        gen_date = datetime.now().strftime("%d/%m/%Y %H:%M")
        render_pdf(cards, args.out, args.start, args.end, gen_date, report_date)
        print(f"SUCCESS: {len(cards)} cards from normalized rows -> {args.out}")
        return

    with open(args.input, "r", encoding="utf-8") as f:
        data = json.load(f)

    target   = args.date.strip() or None
    if not target and not args.from_date.strip() and not args.to_date.strip():
        target = datetime.now().strftime("%d/%m/%Y")

    dt_from = _parse_dmy(args.from_date)
    dt_to   = _parse_dmy(args.to_date)

    records = [r for r in data if isinstance(r, dict)]
    for r in records:
        r["_dt"] = _parse_dmy(r.get("ngay_lam", ""))

    if target:
        records = [r for r in records if r.get("ngay_lam") == target]
    else:
        if dt_from and dt_to and dt_from > dt_to:
            dt_from, dt_to = dt_to, dt_from
        if dt_from:
            records = [r for r in records if r.get("_dt") and r["_dt"] >= dt_from]
        if dt_to:
            records = [r for r in records if r.get("_dt") and r["_dt"] <= dt_to]

    def _rk(s):
        m = re.search(r"(\d+)", s or "")
        return (int(m.group(1)) if m else 999, s or "")

    records.sort(key=lambda r: (
        r.get("_dt") or datetime.max,
        _rk(r.get("so_phong", "")),
        norm(r.get("ho_ten", "")),
    ))

    uniq_days = {r.get("ngay_lam") for r in records if r.get("ngay_lam")}
    show_date = len(uniq_days) > 1

    cards    = build_cards(records, args.start, args.end, include0, show_date)
    gen_date = datetime.now().strftime("%d/%m/%Y %H:%M")
    report_date_label = target or (
        f"{args.from_date}–{args.to_date}" if args.from_date and args.to_date
        else args.from_date or args.to_date or ""
    )
    render_pdf(cards, args.out, args.start, args.end, gen_date, report_date_label)
    print(f"SUCCESS: {len(cards)} cards -> {args.out}")

if __name__ == "__main__":
    main()

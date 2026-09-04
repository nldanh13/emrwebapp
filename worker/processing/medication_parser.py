# -*- coding: utf-8 -*-
"""Parser thuốc: tên thuốc, đường dùng, tốc độ, giờ dùng và phân loại nhóm thuốc."""
import re

from drug_normalizer import DRUG_NORMALIZER
from runtime_logging import get_worker_logger
from xu_ly_config import (
    ALWAYS_INFUSION_DRUGS,
    DEFAULT_VOLUMES,
    INFUSION_NAME_KEYWORDS,
    THE_TICH_AO,
    TRUE_INFUSIONS,
    get_safety_nacl_volume,
    parse_hours_from_gio_dung,
    parse_numeric_value,
    format_quantity_value,
    parse_quantity_int,
)

try:
    from processing.rule_engine import detect_drug_category
except Exception:
    detect_drug_category = None

try:
    from processing.semantic_search import semantic_solvent_kind
except Exception:
    semantic_solvent_kind = None

LOG = get_worker_logger('xu_ly.medication')

_RATE_MAP = {
    "XXX": "30", "C": "100", "XL": "40", "L": "50", "LX": "60",
    "XX": "20", "XV": "15", "X": "10",
}

def get_volume_from_config(brand_name, active_name, form):
    """Tra cứu thể tích để phục vụ phân loại.

    Nguyên tắc (giảm lỗi 'SODIUM'/'NATRI' dính vào hoạt chất):
    - Chỉ match thể tích dựa trên *brand_name* (tên dòng thuốc), không dùng active_name.
    - Với 5_TU_DIEN_THE_TICH_AO: chỉ match substring trực tiếp (không dùng core fallback).
    - Với Natri clorid / Sodium chloride / NaCl: ưu tiên số ml có trong tên; nếu không có thì fallback 100ml (khi là Túi/Chai).
    - Cuối cùng mới fallback DEFAULT_VOLUMES.
    """
    full_name = (str(brand_name or "")).upper()
    form_u = (str(form or "")).upper()

    # 0) Nếu là Natri clorid / Sodium chloride / NaCl (dung môi)
    if (re.search(r"\bNATRI\s+CLORID\b", full_name) or
        re.search(r"\bSODIUM\s+CHLORIDE\b", full_name) or
        "NACL" in full_name):
        m = re.search(r"(\d{2,4})\s*ML", full_name)
        if m:
            try:
                return float(m.group(1))
            except Exception as exc:
                LOG.debug("Handled xu_ly fallback exception", exc_info=True)
                pass
        # Nếu không có số ml trong tên thì dựa vào dạng
        if any(x in form_u for x in ["TÚI", "TUI", "CHAI", "BÌNH", "BINH"]):
            return 100.0
        return 0.0

    # 1) Tra trong THE_TICH_AO (match trực tiếp, không core)
    if isinstance(THE_TICH_AO, dict):
        for k, v in THE_TICH_AO.items():
            k_norm = str(k).upper().replace("_", " ")
            if k_norm and k_norm in full_name:
                try:
                    return float(v)
                except Exception as exc:
                    LOG.debug("Handled xu_ly fallback exception", exc_info=True)
                    pass

    # 2) Fallback mặc định (keyword đủ đặc trưng)
    for k, v in DEFAULT_VOLUMES.items():
        if k in full_name:
            return float(v)
    return 0.0

def normalize_rate_codes(text: str) -> str:
    """Chuẩn hoá ký hiệu tốc độ thành '<số> giọt/phút'.

    Xử lý các dạng viết tắt tốc độ gặp trong thực tế:
      Số La Mã: C=100, LX=60, L=50, XL=40, XXX=30, XX=20, XV=15, X=10
      Đơn vị viết tắt: g/p, g/ph, g.ph, g/phút, giot/phut, C/p, C/ph, XL standalone
      Dạng ghép: Cg/ph, C/ph, C g/ph, Cg.ph → 100 giọt/phút
    """
    if not text:
        return ""
    t = str(text)

    rate_map = _RATE_MAP

    # ── Bước 1: Xử lý dạng "Mã + /ph | /p | .ph" (không có 'g' ở giữa) ──────
    # Ví dụ: C/ph → 100 giọt/phút,  C/p → 100 giọt/phút,  XL/ph → 40 giọt/phút
    for code, val in rate_map.items():
        t = re.sub(
            fr'\b{code}\s*/\s*ph?(?:út)?\b',
            f'{val} giọt/phút',
            t, flags=re.IGNORECASE,
        )

    # ── Bước 2: Chuẩn hoá đơn vị tốc độ (chỉ một lần, không double-replace) ─
    # Dùng hàm thay thế để chắc chắn chỉ thay một lần và không tạo ra 'phútút'.
    def _to_giot_phut(m):
        return 'giọt/phút'

    unit_patterns = [
        r'g\s*[/\.]\s*ph(?:út)?',   # g/ph, g.ph, g/phút
        r'g\s*/\s*p(?=[^h]|$)',     # g/p không theo sau h
        r'giọt\s*/\s*phút',
        r'giot\s*/\s*phut',
    ]
    for pat in unit_patterns:
        t = re.sub(pat, _to_giot_phut, t, flags=re.IGNORECASE)

    # ── Bước 3: Thay mã số La Mã khi theo sau là đơn vị ─────────────────────
    units = r'(?:giọt/phút|giọt|ml\s*/\s*h|ml\s*/\s*giờ)'
    for code, val in rate_map.items():
        t = re.sub(fr'\b{code}(?=\s*{units})', val, t, flags=re.IGNORECASE)

    # ── Bước 4: Mã sau "TTM" không có đơn vị — "TTM C" → "TTM 100 giọt/phút" ─
    for code, val in rate_map.items():
        t = re.sub(fr'\b(TTM)\s+{code}\b', fr'\1 {val} giọt/phút', t, flags=re.IGNORECASE)

    # ── Bước 5: "XL" standalone (cuối chuỗi hoặc trước khoảng trắng/dấu) ────
    t = re.sub(r'\bXL\b(?!\s*(?:giọt|ml|g|\d))', '40 giọt/phút', t)

    # ── Bước 6: Chuẩn hoá khoảng trắng giữa số và đơn vị ────────────────────
    t = re.sub(r'(\d+)\s*(giọt/phút|giọt|ml/h|ml/giờ)', r'\1 \2', t, flags=re.IGNORECASE)

    return t


def extract_infusion_rate(text):
    """Tách tốc độ truyền thành chuỗi số (vd: '100', '40'). Trả về '' nếu không parse được.

    Không được hiểu chữ ``x`` trong phép nhân số lượng (``x 1``, ``x 8``) là
    mã La Mã X = 10 giọt/phút. Fallback mã La Mã chỉ được phép chạy khi chính
    dòng đó có ngữ cảnh truyền dịch rõ ràng.
    """
    t = normalize_rate_codes(text or "")

    m = re.search(r'(\d+)\s*(?:giọt/phút|giọt|ml/h|ml/giờ)', t, re.IGNORECASE)
    if m:
        return m.group(1)

    # Fallback mã La Mã không kèm đơn vị (hiếm): chỉ chấp nhận trong ngữ cảnh
    # TTM/truyền. Đồng thời cấm dạng "X 1"/"X 8" vì đó là số lượng thuốc.
    t_upper = t.upper()
    has_infusion_context = bool(re.search(r'\b(?:TTM|TRUYEN|TRUYỀN)\b', t_upper, re.IGNORECASE))
    if has_infusion_context:
        for code, value in _RATE_MAP.items():
            if re.search(fr'(?<![A-Z0-9]){code}(?!\s*\d)(?![A-Z0-9])', t_upper):
                return value

    return ""

def clean_text_for_entry(text):
    """Làm sạch rác trong diễn biến/y lệnh"""
    if not text: return ""
    rate_map = _RATE_MAP
    for code, value in rate_map.items():
        pattern = re.compile(fr'\b{code}\s*(?=(?:g/p|giọt|ml/h))', re.IGNORECASE)
        text = pattern.sub(value, text)
        
    lines = text.split('\n')
    cleaned_lines = []
    garbage = ["Dự trù thuốc", "Đã xem hồ sơ", "CTCH xem lại bệnh", "----------------", "+ Y lệnh", "+ Thuốc", "Chỉ định DVKT"]
    
    for line in lines:
        line = line.strip()
        if not line or len(line) < 2: continue
        if re.match(r'^\s*(?:\[\s*)?\d{1,2}(?::|h)\d{0,2}[^\n]*?(?:BS|B(?:Á|A)C\s*S(?:Ĩ|I))\s*:\s*.+$', line, re.IGNORECASE): continue
        if any(k.lower() in line.lower() for k in garbage): continue
        cleaned_lines.append(line)
    return "\n".join(cleaned_lines)

# Map tên buổi → giờ mặc định (dùng khi không có giờ rõ trong "Liều dùng")
_SESSION_HOUR_MAP = {'sáng': 8, 'trưa': 12, 'chiều': 16, 'tối': 20, 'đêm': 22}

_RE_LIEU_DUNG   = re.compile(r'Li[eề]u\s*d[uù]ng\s*\d*\s*\(([^)]+)\)', re.IGNORECASE)
_RE_SESSION_QTY = re.compile(
    r'(sáng|chiều|trưa|tối|đêm)\s+(\d+(?:[\.,]\d+)?|\d+\s*/\s*\d+|một|mot|hai|ba|bốn|bon|tư|tu|năm|nam|sáu|sau|bảy|bay|tám|tam|chín|chin|mười|muoi)\s*(lọ|túi|ống|chai|viên)',
    re.IGNORECASE
)
_RE_GIO_IN_LIEU = re.compile(r'(\d{1,2})\s*giờ', re.IGNORECASE)

def parse_dose_per_hour(usage_text: str) -> dict:
    """Phân tích số lọ/túi/ống mỗi cử từ dòng đường dùng.

    Trả về dict {gio_int: so_luong_int | None}.
    - None nghĩa là có giờ nhưng không biết số lượng mỗi cử.

    Hỗ trợ:
      Đối xứng  : "sáng 2 lọ, tối 2 lọ, Liều dùng 2(8 giờ, 20 giờ)"  → {8:2, 20:2}
      Bất đối xứng: "sáng 3 lọ, tối 1 lọ, Liều dùng 2(8 giờ, 20 giờ)"  → {8:3, 20:1}
      Chỉ giờ   : "Liều dùng 2(8 giờ, 20 giờ)"                          → {8:None, 20:None}
      Chỉ buổi  : "sáng 1 túi, chiều 1 túi, tối 1 túi"                  → {8:1, 14:1, 20:1}
    """
    # 1. Lấy giờ rõ ràng từ "Liều dùng X(H giờ, H giờ)"
    explicit_hours = []
    m_lieu = _RE_LIEU_DUNG.search(usage_text)
    if m_lieu:
        explicit_hours = [int(h) for h in parse_hours_from_gio_dung(m_lieu.group(1)) if int(h) <= 23]

    # EMR thường ghi trực tiếp: "sáng 1 viên, chiều 1 viên, tối 1 viên(8 giờ, 16 giờ, 22 giờ)"
    # không có chữ "Liều dùng". Nếu không bắt thêm đoạn ngoặc cuối, số lượng mỗi giờ
    # sẽ bị quy về mặc định sáng/chiều/tối = 8/14/20 và lệch với giờ dùng thật.
    if not explicit_hours:
        m_hours_group = re.search(r"\(([^)]*\d{1,2}\s*(?:giờ|h)[^)]*)\)\s*\.?\s*$", usage_text or "", re.IGNORECASE)
        if m_hours_group:
            explicit_hours = [int(h) for h in parse_hours_from_gio_dung(m_hours_group.group(1)) if int(h) <= 23]

    # 2. Lấy session + số lượng (sáng X lọ, tối Y lọ, ...)
    sessions = _RE_SESSION_QTY.findall(usage_text)  # [(ten_buoi, so_luong, don_vi), ...]

    if not sessions:
        # Không có session → chỉ trả giờ, không biết qty
        return {h: None for h in explicit_hours}

    session_pairs = [(s[0].lower(), parse_numeric_value(s[1], None)) for s in sessions]

    # 3. Map session → giờ
    if explicit_hours and len(explicit_hours) == len(session_pairs):
        # Số session khớp số giờ → map theo thứ tự xuất hiện
        return {h: qty for (_, qty), h in zip(session_pairs, explicit_hours)}

    if explicit_hours and len(explicit_hours) != len(session_pairs):
        # Bất đối xứng: thử ghép session → giờ theo tên buổi
        result = {}
        for sn, qty in session_pairs:
            h = _SESSION_HOUR_MAP.get(sn)
            if h is not None:
                result[h] = qty
        # Giờ rõ chưa có qty → thêm vào với None
        for h in explicit_hours:
            if h not in result:
                result[h] = None
        return result

    # 4. Không có giờ rõ → dùng map buổi mặc định
    return {_SESSION_HOUR_MAP.get(sn, 0): qty for sn, qty in session_pairs
            if _SESSION_HOUR_MAP.get(sn)}


def _has_oral_marker(text: str) -> bool:
    t = str(text or "").lower()
    return bool(re.search(r"\(\s*u\s*\)|\buống\b|\buong\b|(?<![0-9a-zA-ZÀ-ỹ])u(?![0-9a-zA-ZÀ-ỹ])", t, flags=re.IGNORECASE))


def _is_flush_only_usage(text: str) -> bool:
    """True khi dòng chỉ có mục đích thông/tráng đường truyền, không phải truyền dịch.

    Phạm vi cố ý hẹp để không loại các y lệnh thuốc có thêm câu "tráng ống" ở
    cuối một hướng dẫn tiêm/truyền thực sự.
    """
    t = str(text or "").strip().lower().strip(" .;,:-–—")
    return bool(re.fullmatch(
        r'(?:thông\s*)?(?:tráng|trang)\s+(?:ống|ong)(?:\s+kim\s+(?:luồn|luon))?'
        r'|(?:rửa|rua)\s+(?:ống|ong)(?:\s+kim\s+(?:luồn|luon))?',
        t,
        flags=re.IGNORECASE,
    ))


def _safe_int_from_text(raw, default=None):
    return parse_quantity_int(raw, default=default)


def _expand_interval_hours_from_usage(usage_text: str, info: dict, explicit_hours: list) -> list:
    """Mở rộng các mẫu tần suất kiểu 'mỗi 6h'.

    Ví dụ: Piperacillin/Tazobactam x4 TTM mỗi 6h -> 6, 12, 18, 0.
    """
    u = (usage_text or "").lower()
    m = re.search(r"(?:mỗi|moi|q)\s*(\d{1,2})\s*h\b", u, flags=re.IGNORECASE)
    if not m:
        return explicit_hours
    interval = _safe_int_from_text(m.group(1), None)
    if not interval or interval <= 0 or interval > 24:
        return explicit_hours
    qty = _safe_int_from_text(info.get("so_luong"), None)
    if not qty:
        mx = re.search(r"\bx\s*(\d{1,2})\b", u, flags=re.IGNORECASE)
        qty = _safe_int_from_text(mx.group(1), None) if mx else None
    if not qty:
        qty = max(1, int(round(24 / interval)))
    qty = max(1, min(int(qty), 12))
    start = None
    if explicit_hours:
        try:
            start = int(explicit_hours[0])
        except Exception:
            start = None
    if start is None:
        start = 6 if interval == 6 else 8
    out = []
    for i in range(qty):
        h = (start + i * interval) % 24
        if h not in out:
            out.append(h)
    return [str(h) for h in out]

def parse_drug_name(line):
    """Tách tên thuốc:
    - Loại bỏ tiền tố đánh số kiểu (5) / 5) ở đầu dòng.
    - Nếu có ngoặc (Paracetamol) ở sau tên, tách hoạt chất nhưng KHÔNG để ngoặc đầu dòng làm nhiễu.
    - Nếu không có ngoặc, giữ nguyên tên gốc (bao gồm hàm lượng như 20MG/2ML).
    """
    if not line:
        return {"ten_thuoc": "", "hoat_chat": "", "ham_luong": "", "the_tich": 0, "dang": "", "so_luong": "", "toc_do": "", "gio_dung": "", "duong_dung_goc": ""}

    # Chuẩn hoá & bỏ prefix đánh số/bullet/nhãn (CS)/(TT) theo rule có thứ tự.
    line = DRUG_NORMALIZER.normalize_line(line)

    info = {"ten_thuoc": line, "hoat_chat": "", "ham_luong": "", "the_tich": 0, "dang": "", "so_luong": "", "toc_do": "", "gio_dung": "", "duong_dung_goc": ""}

    # Chuẩn hoá lỗi viết tắt thường gặp: 01 vx3 -> 01 viên x 3; 01v -> 01 viên.
    line = re.sub(r'(?i)\b(\d+)\s*vx\s*(\d+)\b', r'\1 viên x \2', line)
    line = re.sub(r'(?i)\b(\d+)vx(\d+)\b', r'\1 viên x \2', line)
    line = re.sub(r'(?i)\b(\d+)\s*v\b', r'\1 viên', line)
    line = re.sub(r'(?i)\b(\d+)v(?=\s|$)', r'\1 viên', line)

    # Tách phần số lượng sau chữ 'x' (số Ả Rập, thập phân/phân số hoặc chữ Một/Hai/Ba...).
    qty_word = r'(?:\d+(?:[\.,]\d+)?|\d+\s*/\s*\d+|một|mot|hai|ba|bốn|bon|tư|tu|năm|nam|sáu|sau|bảy|bay|tám|tam|chín|chin|mười|muoi)'
    split_parts = re.split(r'\s+x\s*(?=' + qty_word + r'\b)', line, maxsplit=1, flags=re.IGNORECASE)
    left_part = split_parts[0].strip() if len(split_parts) > 1 else line
    right_part = split_parts[1].strip() if len(split_parts) > 1 else ""

    # 1. Trích xuất hoạt chất trong ngoặc (nếu có) - chỉ lấy ngoặc KHÔNG ở đầu dòng
    # Ví dụ: THERMODOL (Paracetamol) -> Paracetamol
    match_active = re.search(r'\s\(([^\)]+)\)', left_part)
    if match_active:
        cand = match_active.group(1).strip()
        cand_l = cand.lower()
        # Loại trừ các ngoặc dùng để ghi đường dùng/viết tắt như (u), (uống), (tiêm)...
        bad = ['u', 'uống', 'tiêm', 'truyền', 'tm', 'ttm', 'mạch', 'tĩnh mạch', 'bắp', 'da', 'uống)', 'tiêm)']
        if len(cand) > 2 and not any(b in cand_l for b in bad):
            info['hoat_chat'] = cand
    # 2. Trích xuất thể tích (nếu có). Lưu ý: 20MG/2ML sẽ ra 2ML (ampoule), còn "100ML" túi/chai thường sẽ được override ở usage_line.
    vol_matches = re.findall(r'(?<![a-zA-Z])[\/\s]*(\d+(?:[\.,]\d+)?)\s*ML\b', left_part, flags=re.IGNORECASE)
    if vol_matches:
        try:
            info["the_tich"] = float(vol_matches[0].replace(',', '.'))
        except Exception as exc:
            LOG.debug("Handled xu_ly fallback exception", exc_info=True)
            info["the_tich"] = 0

    # 3. Cắt tên hiển thị:
    if '(' in left_part:
        clean_name = left_part.split('(')[0].strip()
    else:
        clean_name = left_part
    info["ten_thuoc"] = clean_name.strip(',.-/ ')
    # Nếu chưa có 'dang' (Viên/Ống/Lọ/Chai/Túi/Gói...), cố gắng suy luận từ phần tên (ví dụ: '01 viên') để tránh tạo thuốc rỗng.
    if not info.get('dang'):
        m_form = re.search(r'\b(viên|ống|lọ|chai|túi|gói)\b', left_part, flags=re.IGNORECASE)
        if m_form:
            info['dang'] = m_form.group(1).strip().capitalize()
            # loại bỏ phần định dạng ở cuối tên nếu có (vd: '01 viên', '1 gói', '01chai')
            # \s* cho phép không có space giữa số và đơn vị: '01chai', '1viên'
            info['ten_thuoc'] = re.sub(
                r'\s*\d+\s*(viên|ống|lọ|chai|túi|gói)\b\s*$',
                '', info['ten_thuoc'], flags=re.IGNORECASE
            ).strip()

    # 4. Số lượng / dạng thuốc bên phải
    if right_part:
        match_form = re.search(r'\((.*?)\)', right_part)
        if match_form:
            info["dang"] = match_form.group(1)
            raw_qty = right_part.split('(')[0].strip()
        else:
            raw_qty = right_part

        qty_val = parse_numeric_value(raw_qty, None)
        info["so_luong"] = format_quantity_value(qty_val) if qty_val is not None else raw_qty

    return info

def update_drug_usage(info, usage_line, time_map):
    """Cập nhật đường dùng/giờ/tốc độ và bóc tách thông tin pha - truyền.

    Các mẫu hỗ trợ:
    - pha với nước cất / tiêm mạch chậm
    - pha với Natri clorid / NaCl / Sodium (0.9%) 100ml hoặc 500ml
    - lấy 50/75/150/250/375... ml
    - pha đủ 50ml...
    """
    usage_line = (usage_line or "").strip()
    usage_line_norm = normalize_rate_codes(usage_line)
    info["duong_dung_goc"] = usage_line_norm
    u = usage_line_norm.lower()

    # NaCl chỉ dùng để thông/tráng đường truyền không phải là một chai dịch truyền
    # cần nhập. Gắn cờ sớm và không suy luận giờ/tốc độ/dung môi từ câu này.
    if _is_flush_only_usage(usage_line_norm):
        info["flush_only"] = True
        info["usage_purpose"] = "iv_line_flush"
        info["gio_dung"] = ""
        info["toc_do"] = ""
        info.pop("so_luong_moi_gio", None)
        return info
    info.pop("flush_only", None)
    info.pop("usage_purpose", None)

    # Thời gian đặc biệt (không đưa vào lịch thực hiện tại khoa)
    if "trước rạch da" in u or "truoc rach da" in u:
        m_pre = re.search(r"(?:trước rạch da|truoc rach da)\s*(\d+)\s*phút", u)
        if m_pre:
            info["thoi_gian_dac_biet"] = f"Trước rạch da {m_pre.group(1)} phút"
        else:
            info["thoi_gian_dac_biet"] = "Trước rạch da"


    def _to_float(s):
        try:
            return float(str(s).replace(',', '.'))
        except Exception as exc:
            LOG.debug("Handled xu_ly fallback exception", exc_info=True)
            return None

    # =========================
    # 1) DUNG MÔI & THỂ TÍCH
    # =========================
    has_water = ("nước cất" in u) or ("nuoc cat" in u)

    # Nhận diện NaCl: natri/nacl/nước muối hoặc "sodium 0.9%" (thiếu chữ clorid vẫn nhận).
    # Nếu exact không khớp, dùng semantic/fuzzy để bắt lỗi chính tả như "nước mối".
    solvent_kind = semantic_solvent_kind(usage_line_norm) if callable(semantic_solvent_kind) else None
    has_sodium_09 = ("sodium" in u) and (("0.9" in u) or ("0,9" in u))
    has_nacl = has_sodium_09 or any(k in u for k in [
        "natri clorid", "natri chlorid", "natri chloride",
        "sodium clorid", "sodium chlorid", "sodium chloride",
        "nacl", "nước muối", "nuoc muoi"
    ]) or solvent_kind in ("NACL", "SODIUM")

    
    if has_water or solvent_kind == "NUOC_CAT":
        info["dung_moi"] = "NUOC_CAT"
        if solvent_kind == "NUOC_CAT" and not has_water:
            info["semantic_solvent_match"] = "NUOC_CAT"
    else:
        # Phân biệt NATRI (túi 100ml) và SODIUM (chai 500ml)
        has_sodium = (("sodium" in u) and (("0.9" in u) or ("0,9" in u) or ("chloride" in u) or ("clorid" in u))) or solvent_kind == "SODIUM"
        if has_sodium:
            info["dung_moi"] = "SODIUM_0.9"
            if solvent_kind == "SODIUM" and "sodium" not in u:
                info["semantic_solvent_match"] = "SODIUM"
        elif has_nacl:
            info["dung_moi"] = "NACL_0.9"
            if solvent_kind == "NACL" and not any(k in u for k in ["natri", "nacl", "nước muối", "nuoc muoi"]):
                info["semantic_solvent_match"] = "NACL"
        else:
            info.pop("dung_moi", None)
# Thể tích túi/chai (100ml/500ml...) - hỗ trợ cả 2 hướng "... 100ml Natri/Sodium ..." và "Natri/Sodium ... 100ml"
    bag_ml = None
    m1 = re.search(
        r'(\d+(?:[\.,]\d+)?)\s*ml\s*(?:nacl|natri\s*(?:clorid|chlorid|chloride)|sodium(?:\s*(?:clorid|chlorid|chloride))?|nước\s*muối|nuoc\s*muoi)\b',
        u, flags=re.IGNORECASE
    )
    if m1:
        bag_ml = _to_float(m1.group(1))
    else:
        m2 = re.search(
            r'(?:nacl|natri\s*(?:clorid|chlorid|chloride)|sodium(?:\s*(?:clorid|chlorid|chloride))?|nước\s*muối|nuoc\s*muoi)\b.{0,80}?(\d+(?:[\.,]\d+)?)\s*ml',
            u, flags=re.IGNORECASE
        )
        if m2:
            bag_ml = _to_float(m2.group(1))

    # Lấy / pha đủ
    take_ml = None
    m_take = re.search(r'(?:chỉ\s*)?lấy\s*(?:đủ\s*)?(\d+(?:[\.,]\d+)?)\s*ml', u, flags=re.IGNORECASE)
    if m_take:
        take_ml = _to_float(m_take.group(1))

    # Chuẩn hoá dung môi: nếu thể tích dung môi dùng để pha > 100ml thì coi là SODIUM (chai lớn),
    # còn <= 100ml coi là NATRI/NACL (túi 100ml)
    if info.get("dung_moi") == "NACL_0.9":
        _vol_for_type = take_ml if take_ml is not None else bag_ml
        if (_vol_for_type is not None and _vol_for_type > 100) or ("sodium" in u):
            info["dung_moi"] = "SODIUM_0.9"


    pha_du_ml = None
    m_phadu = re.search(r'pha\s*đủ\s*(\d+(?:[\.,]\d+)?)\s*ml', u, flags=re.IGNORECASE)
    if m_phadu:
        pha_du_ml = _to_float(m_phadu.group(1))

    # Các y lệnh Vancomycin thường ghi: "Pha 200ml natriclorid X2 TTM ...".
    # Đây là thể tích dịch truyền thực tế cho mỗi cữ, không phải thể tích mặc định 100ml.
    # Bắt riêng mẫu "pha 200ml ..." để không bị bỏ sót khi tên dung môi viết dính
    # như "natriclorid" hoặc khi dòng Sodium chloride bị tách riêng ở bên dưới.
    if pha_du_ml is None and take_ml is None and has_nacl:
        m_pha_ml = re.search(r'\bpha\s*(?:với\s*)?(\d+(?:[\.,]\d+)?)\s*ml\b', u, flags=re.IGNORECASE)
        if m_pha_ml:
            pha_du_ml = _to_float(m_pha_ml.group(1))

    if bag_ml is not None:
        info["tui_dich_truyen_ml"] = bag_ml
    else:
        info.pop("tui_dich_truyen_ml", None)

    if take_ml is not None:
        info["the_tich_lay_ml"] = take_ml
    else:
        info.pop("the_tich_lay_ml", None)

    if pha_du_ml is not None:
        info["the_tich_pha_du_ml"] = pha_du_ml
    else:
        info.pop("the_tich_pha_du_ml", None)

    # Override thể tích thực tế dùng cho truyền
    current_vol = float(info.get("the_tich") or 0)
    if take_ml is not None:
        info["the_tich"] = float(take_ml)
    elif pha_du_ml is not None:
        info["the_tich"] = float(pha_du_ml)
    elif bag_ml is not None and bag_ml >= 50 and current_vol < 50:
        info["the_tich"] = float(bag_ml)

    
    # SPECIAL CASE: PARACETAMOL/THERMODOL dạng TTM thường là chai/túi truyền sẵn.
    # Không tự gắn dung môi NaCl nếu y lệnh không ghi rõ "pha với Natri/NaCl".
    # Chỉ bù thể tích 100ml để tính thời gian truyền khi EMR ghi thiếu thể tích.
    name_u = (info.get("ten_thuoc") or "").upper()
    dang_u = (info.get("dang") or "").upper()
    is_para_inj = ("INJ" in name_u) or ("INJECTION" in name_u) or ("ỐNG" in dang_u) or ("ONG" in dang_u)
    has_explicit_nacl_text = any(k in u for k in [
        "natri clorid", "natri chlorid", "natri chloride",
        "sodium clorid", "sodium chlorid", "sodium chloride",
        "nacl", "nước muối", "nuoc muoi",
    ])
    if is_para_inj and any(k in name_u for k in ["PARACETAMOL", "THERMODOL"]) and (take_ml is None) and (pha_du_ml is None) and (bag_ml is None):
        try:
            if float(info.get("the_tich") or 0) < 50:
                info["the_tich"] = 100.0
        except Exception as exc:
            LOG.debug("Handled xu_ly fallback exception", exc_info=True)
            info["the_tich"] = 100.0
        info["tui_dich_truyen_ml"] = 100.0
        if has_explicit_nacl_text:
            info["dung_moi"] = "NACL_0.9"


# Nếu vẫn thiếu thể tích, tra theo config / default. Riêng đường uống không lấy thể tích truyền từ config
    # vì các thuốc như Linezolid 600mg có thể bị gán nhầm 300ml dù y lệnh ghi uống.
    if not info.get("the_tich") and not _has_oral_marker(usage_line_norm):
        info["the_tich"] = get_volume_from_config(info.get("ten_thuoc", ""), info.get("hoat_chat", ""), info.get("dang", ""))

    # Fallback thể tích túi dịch: nếu thuốc có dung môi pha truyền nhưng y lệnh
    # không ghi thể tích túi/lượng lấy rõ ràng, thể tích nằm trong tên thuốc
    # (vd. TRASOLU 100mg/2ml -> 2ml) chỉ là thể tích ống thuốc, KHÔNG phải thể
    # tích dịch truyền. Dùng luật an toàn theo thuốc, fallback 100ml.
    if (
        info.get("dung_moi") in ("NACL_0.9", "SODIUM_0.9")
        and not info.get("tui_dich_truyen_ml")
        and take_ml is None
        and pha_du_ml is None
    ):
        current_vol = float(info.get("the_tich") or 0)
        safety_bag = get_safety_nacl_volume(info.get("ten_thuoc", "") or info.get("hoat_chat", ""))
        # Giữ hành vi cũ cho thuốc không có thể tích (0 -> mặc định 100ml).
        # Chỉ ghi đè thể tích ống thuốc nhỏ (vd. 2ml) khi thuốc có luật an toàn
        # pha NaCl riêng, tránh biến mọi thuốc tiêm pha dung môi thành túi 100ml.
        if current_vol == 0 or (0 < current_vol < 50 and safety_bag is not None):
            inferred_bag = safety_bag or 100.0
            if current_vol > 0:
                info["the_tich_thuoc_goc_ml"] = current_vol
            info["the_tich"] = float(inferred_bag)
            info["tui_dich_truyen_ml"] = float(inferred_bag)
            info["tui_dich_truyen_inferred"] = True

    # =========================
    # 2) GIỜ DÙNG
    # =========================
    # Bắt giờ dùng rõ ràng bằng helper chung để hỗ trợ cả: 8h, 8 giờ, 03:35, 8-16-20 giờ, sáng-chiều-tối.
    explicit_hours = [str(h) for h in parse_hours_from_gio_dung(usage_line_norm)]

    # Nếu có tần suất kiểu "mỗi 6h" / "q6h", mở rộng thành đủ các cữ theo số lần xN.
    explicit_hours = _expand_interval_hours_from_usage(usage_line_norm, info, explicit_hours)

    # Nếu có giờ rõ ràng -> dùng luôn (không tự bù theo số lượng vì số lượng thường là số lọ/ống, không phải số lần)
    final_hours = []
    if explicit_hours:
        # giữ thứ tự xuất hiện + loại trùng
        seen = set()
        for h in explicit_hours:
            if h not in seen:
                seen.add(h)
                final_hours.append(h)
    else:
        # suy luận theo từ khoá sáng/trưa/chiều/tối
        for key, val in (time_map or {}).items():
            if key.lower() in u:
                m = re.search(r'(\d{1,2})', str(val))
                if m:
                    final_hours.append(m.group(1))
        if not final_hours:
            final_hours = []  # no fallback

    info["gio_dung"] = ", ".join([f"{h} giờ" for h in final_hours])

    # Phân tích số lọ/túi/ống mỗi cử (đối xứng và bất đối xứng)
    dose_map = parse_dose_per_hour(usage_line_norm)
    if dose_map:
        info["so_luong_moi_gio"] = dose_map  # {gio_int: so_luong | None}


    # =========================
    info["toc_do"] = extract_infusion_rate(usage_line_norm)

    # =========================
    # 4) TÊN HIỂN THỊ (bỏ số ml)
    # =========================
    if info.get("dung_moi") in ("NACL_0.9", "SODIUM_0.9"):
        disp = info.get("ten_thuoc", "")
        disp = f"{disp} + {'Sodium chloride 0.9%' if info.get('dung_moi') == 'SODIUM_0.9' else 'Natri clorid 0.9%'}"
        info["ten_hien_thi"] = disp

    return info



def categorize_drug(drug_info):
    """Phân loại thuốc (tiêm / uống / dịch truyền / khác).

    Phần nhận dạng chính đã chuyển sang ``processing/rule_engine.py`` và
    ``config/order_rules.json`` để sau này thêm từ khóa/luật mới không cần
    sửa trực tiếp file xử lý dài này.

    Giữ nguyên API cũ và các nhóm output cũ:
    - dich_truyen
    - thuoc_tiem
    - thuoc_uong
    - thuoc_hit_xit / thuoc_boi / thuoc_nho / thuoc_dat
    - khac
    """
    if callable(detect_drug_category):
        category, reason = detect_drug_category(
            drug_info or {},
            extra_true_infusions=TRUE_INFUSIONS,
            extra_infusion_keywords=INFUSION_NAME_KEYWORDS,
            extra_always_infusion_drugs=ALWAYS_INFUSION_DRUGS,
            safety_nacl_volume_getter=get_safety_nacl_volume,
            with_reason=True,
        )
        try:
            LOG.debug(
                "[drug-category] %s -> %s (%s)",
                (drug_info or {}).get("ten_thuoc") or (drug_info or {}).get("ten_hien_thi") or "",
                category,
                reason,
            )
        except Exception:
            pass
        return category

    # Fallback tối thiểu nếu module rule_engine không import được.
    name_u = ((drug_info or {}).get("ten_thuoc") or "").upper()
    route_l = ((drug_info or {}).get("duong_dung_goc") or "").lower()
    try:
        vol = float((drug_info or {}).get("the_tich") or 0)
    except Exception:
        vol = 0.0

    if _has_oral_marker(route_l):
        return "thuoc_uong"
    if any(k in route_l for k in ["truyền", "ttm", "giọt/phút", "g/p", "ml/h", "tiêm truyền"]):
        return "dich_truyen"
    if any(k in route_l for k in ["tĩnh mạch chậm", "tmc", "tiêm chậm", "tiêm", "bắp", "dưới da"]):
        return "thuoc_tiem"
    if any(k in name_u for k in TRUE_INFUSIONS) or any(k in name_u for k in INFUSION_NAME_KEYWORDS) or vol >= 50:
        return "dich_truyen"
    return "khac"

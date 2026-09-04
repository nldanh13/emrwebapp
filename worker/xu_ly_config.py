# -*- coding: utf-8 -*-
"""xu_ly_config.py — Hằng số, cấu hình và helpers thuần cho xu_ly.
Import duy nhất: from xu_ly_config import *
"""
import json
import re
import os
from datetime import datetime, timedelta
import glob
from copy import deepcopy
try:
    from clinical_rules import apply_clinical_rules_to_record, extract_care_special_events, extract_admission_transfer_events
except Exception:
    apply_clinical_rules_to_record = None
    extract_care_special_events = None
    extract_admission_transfer_events = None
# ==============================================================================
# 1. CẤU HÌNH & KHỞI TẠO
# ==============================================================================

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
_DEFAULT_CONFIG_FILE = os.path.join(BASE_DIR, 'd_v2.json')
_PROJECT_CONFIG_FILE = os.path.join(os.path.dirname(BASE_DIR), 'config', 'd_v2.json')
CONFIG_FILE = os.environ.get('D_V2_CONFIG_PATH') or (_DEFAULT_CONFIG_FILE if os.path.exists(_DEFAULT_CONFIG_FILE) else _PROJECT_CONFIG_FILE)
OUTPUT_FILE = os.path.join(BASE_DIR, 'data_phan_loai_chuan_v16.json')  # fallback nếu gọi trực tiếp
DEFAULT_INPUT_FILE = os.path.join(BASE_DIR, 'KetQua_YLenh.json')
# Thể tích mặc định (Dùng khi văn bản không ghi rõ thể tích túi/chai)
DEFAULT_VOLUMES = {
    # Các dịch truyền/thuốc truyền có thể tích rõ ràng theo tên sản phẩm
    "THERMODOL": 100,
    "PARACETAMOL": 100,
    "GLUCOSE": 500,
    "RINGER": 500,
    "CIPRO": 200,
    "LEVO": 100,
    "METRO": 100,
    # Aminoleban thường là chai dịch truyền; dùng để tránh mất lịch khi BS không ghi thể tích.
    "AMINOLEBAN": 500,
}

# Danh sách các dịch truyền chắc chắn (KHÔNG dùng keyword quá chung như 'SODIUM' để tránh dính vào hoạt chất dạng '... sodium')
TRUE_INFUSIONS = [
    "PARACETAMOL", "THERMODOL",
    "NATRI CLORID", "SODIUM CHLORIDE", "NACL",
    "GLUCOSE", "RINGER", "CIPRO", "LEVO", "METRO", "AMINOLEBAN"
]

# Danh sách thuốc thể tích nhỏ nhưng BẮT BUỘC là pha truyền (Tránh bị ép thành tiêm)
ALWAYS_INFUSION_DRUGS = ["NEFOPAM"]  # TRAMADOL xử lý riêng: ưu tiên tiêm bắp, chỉ pha NaCl khi có dung môi rời phù hợp
def load_config(config_path):
    default_config = {"gio_mac_dinh": {"sáng": "8 giờ", "trưa": "12 giờ", "chiều": "16 giờ", "tối": "20 giờ"}, "bo_sung_the_tich": []}
    if not os.path.exists(config_path):
        return default_config
    try:
        with open(config_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else default_config
    except Exception as e:
        print(f"[WARN] Không đọc được cấu hình d_v2 ({config_path}): {e}")
        return default_config

CONFIG = load_config(CONFIG_FILE)
# ===== Config-derived helpers (from d.json) =====
THE_TICH_AO = CONFIG.get("5_TU_DIEN_THE_TICH_AO", {}) if isinstance(CONFIG, dict) else {}
LUAT_AN_TOAN = CONFIG.get("3_LUAT_AN_TOAN_DAC_BIET", {}) if isinstance(CONFIG, dict) else {}

# Từ khóa nhận diện dịch truyền theo tên (bổ sung ngoài TRUE_INFUSIONS)
INFUSION_NAME_KEYWORDS = [
    "AMINOPLASMAL", "NEPHROSTERIL", "ALBUNORM", "ALBUMIN",
    "INTRALIPID", "SMOF", "KABIVEN", "OLICLINOMEL", "NUTRIFLEX",
    "AMINOLEBAN",
]

# Thuốc thường pha NaCl nếu y lệnh không ghi rõ (bạn có thể mở rộng list này)
DEFAULT_NACL_VOLUME_BY_KEYWORD = {
    "MEROVIA": 100,  # Meropenem
    "PIPERACILLIN/TAZOBACTAM": 100,
    "TAZOBACTAM": 100,
    "VANCOMYCIN": 100,  # fallback khi y lệnh không ghi thể tích; ưu tiên dữ liệu NaCl 100ml thực tế
    "COLISTIMED": 50,
    "COLISTIN": 50,
}

# ── Bản đồ nhãn đường dùng thuốc ─────────────────────────────────────────────
# Kiểm tra theo thứ tự — dừng lại ở match đầu tiên.
# Nguồn: Bảng phân loại đường dùng thuốc VN (BYT).
ROUTE_LABEL_MAP = [
    # TTM / Dịch truyền — phải kiểm tra TRƯỚC "tiêm" để tránh nhầm
    (["ttm", "tiêm truyền", "truyền tĩnh mạch", "truyền nhỏ giọt"],  "TTM"),
    # Tiêm — phân biệt vị trí
    (["tiêm bắp", "bắp đùi", "bắp tay", " im ", "(im)"],            "TB"),
    (["dưới da", "duoi da", "tiêm dưới da", "tiem duoi da", "tdd", " sc ", "(sc)", "(tdd)"], "TDD"),
    (["tĩnh mạch chậm", "tmc", "tm chậm", "tiêm chậm",
      "tiêm mạch", "tĩnh mạch"],                                      "TMC"),
    (["tiêm"],                                                         "TMC"),
    # Đường uống
    (["uống"],                                                         "U"),
    (["ngậm dưới lưỡi", "dưới lưỡi"],                                 "NDL"),
    # Đường hô hấp
    (["hít", "xịt", "khí dung", "hít/xịt", "phun mù",
      "định liều", "aerosol"],                                         "Hít/Xịt"),
    # Ngoài da
    (["bôi", "thoa"],                                                  "Bôi"),
    (["dán qua da", "miếng dán", "patch"],                             "Dán"),
    # Nhỏ giọt
    (["nhỏ mắt"],                                                      "Nhỏ mắt"),
    (["nhỏ mũi"],                                                      "Nhỏ mũi"),
    (["nhỏ tai"],                                                      "Nhỏ tai"),
    (["nhỏ"],                                                          "Nhỏ"),
    # Đặt
    (["đặt hậu môn", "trực tràng"],                                    "Trực tràng"),
    (["âm đạo"],                                                       "Âm đạo"),
    (["đặt"],                                                          "Đặt"),
    # Ngậm chung
    (["ngậm"],                                                         "Ngậm"),
]

# Màu badge đường dùng (dùng trong frontend token)
ROUTE_COLORS = {
    "TTM":          "green",
    "TMC":          "amber",
    "TB":           "amber",
    "TDD":          "amber",
    
    "U":            "purple",
    "NDL":          "purple",
    "Hít/Xịt":      "blue",
    "Bôi":          "gray",
    "Dán":          "gray",
    "Nhỏ mắt":      "gray",
    "Nhỏ mũi":      "gray",
    "Nhỏ tai":      "gray",
    "Nhỏ":          "gray",
    "Trực tràng":   "gray",
    "Âm đạo":       "gray",
    "Đặt":          "gray",
    "Ngậm":         "purple",
}


def get_route_label(duong_dung_goc: str, ten_thuoc: str = "") -> str:
    """Trả về nhãn ngắn của đường dùng thuốc từ chuỗi duong_dung_goc.

    Nhận thêm ten_thuoc để phát hiện lỗi nhập liệu EMR:
      "Tiêm (tự túc)" + tên chứa "uống" → "U"
    """
    u      = (duong_dung_goc or "").lower()
    name_l = (ten_thuoc      or "").lower()

    # Phát hiện đường uống, kể cả ký hiệu ngắn "u" của thuốc tự túc.
    if re.search(r"\(\s*u\s*\)|\buống\b|\buong\b|(?<![0-9a-zA-ZÀ-ỹ])u(?![0-9a-zA-ZÀ-ỹ])", u, flags=re.IGNORECASE):
        return "U"

    # Phát hiện "Tiêm (tự túc)" nhưng tên thuốc chứa "uống" → thực ra là uống
    if u.strip() in ("tiêm (tự túc)", "tiêm(tự túc)") and "uống" in name_l:
        return "U"

    # TRAMADOL: nếu EMR chỉ ghi chung chung "Tiêm" thì ưu tiên hiểu là tiêm bắp.
    # Chỉ để dạng truyền khi y lệnh ghi rõ TTM/truyền/pha NaCl, hoặc được rule dung môi rời xử lý sau.
    name_u_local = _norm_upper(name_l)
    if "TRAMADOL" in name_u_local:
        has_infusion_hint = any(k in u for k in [
            "ttm", "truyền", "truyen", "tiêm truyền", "tiem truyen",
            "natri clorid", "natri chlorid", "natri chloride",
            "sodium clorid", "sodium chlorid", "sodium chloride",
            "nacl", "nước muối", "nuoc muoi", "giọt/phút", "giot/phut", "g/p", "ml/h"
        ])
        has_generic_injection = "tiêm" in u or "tiem" in u
        if has_generic_injection and not has_infusion_hint:
            return "TB"

    for keywords, label in ROUTE_LABEL_MAP:
        if any(k in u for k in keywords):
            return label
    return ""

# Những thuốc có dung môi đi kèm (không gắn nhãn '+ Pha nước cất')
NO_WATER_TAG_KEYWORDS = [
    "METHYLPREDNISOLON", "SOLU-MEDROL", "SOLU MEDROL"
]

def _norm_upper(s: str) -> str:
    return (s or "").upper()

def _contains_any(text: str, kws):
    t = (text or "")
    return any(k in t for k in kws)


_VI_NUMBER_WORDS = {
    "không": 0, "khong": 0,
    "một": 1, "mot": 1, "mốt": 1,
    "hai": 2,
    "ba": 3,
    "bốn": 4, "bon": 4, "tư": 4, "tu": 4,
    "năm": 5, "nam": 5,
    "sáu": 6, "sau": 6,
    "bảy": 7, "bay": 7,
    "tám": 8, "tam": 8,
    "chín": 9, "chin": 9,
    "mười": 10, "muoi": 10,
}


def parse_numeric_value(raw, default=None):
    """Parse số trong y lệnh: 2, 0,5, 1/2, hoặc chữ Một/Hai/Ba...

    Trả về float để không làm mất liều thập phân/phân số.
    """
    text = str(raw or "").strip().lower()
    if not text:
        return default

    m_frac = re.search(r"(?<!\d)(\d+)\s*/\s*(\d+)(?!\d)", text)
    if m_frac:
        try:
            den = float(m_frac.group(2))
            if den != 0:
                return float(m_frac.group(1)) / den
        except Exception:
            pass

    m_num = re.search(r"(?<!\d)(\d+(?:[\.,]\d+)?)(?!\d)", text)
    if m_num:
        try:
            return float(m_num.group(1).replace(',', '.'))
        except Exception:
            pass

    words = re.sub(r"[^a-zà-ỹđ]+", " ", text, flags=re.IGNORECASE).strip().split()
    for w in words:
        if w in _VI_NUMBER_WORDS:
            return float(_VI_NUMBER_WORDS[w])
    return default


def format_quantity_value(value):
    """Định dạng số lượng để ghi vào JSON: 2.0 -> '2', 0.5 -> '0.5'."""
    try:
        v = float(value)
    except Exception:
        return ""
    if abs(v - round(v)) < 1e-9:
        return str(int(round(v)))
    return (f"{v:.3f}").rstrip('0').rstrip('.')


def parse_quantity_int(raw, default=0):
    """Parse số lượng nguyên; dùng cho số lọ/chai/túi. Không ném lỗi khi gặp chữ."""
    v = parse_numeric_value(raw, default=None)
    if v is None:
        return default
    try:
        return int(round(float(v)))
    except Exception:
        return default


def parse_hours_from_gio_dung(gio_dung: str):
    # "8 giờ, 16 giờ, 0 giờ" -> [8,16,0]
    # "03:35, 16 giờ, 23 giờ" -> [3,16,23]
    # "8-16-20 giờ" / "8-16-20h" -> [8,16,20]
    # "sáng-chiều-tối" -> [8,16,20]
    # Không dùng regex (\d+) chung vì sẽ tách sai phút "03:35" thành số 35.
    if not gio_dung:
        return []

    text = str(gio_dung or '')
    out = []
    seen = set()

    def _add_hour(raw_h):
        try:
            h = int(raw_h)
        except Exception:
            return
        if 0 <= h <= 23 and h not in seen:
            seen.add(h)
            out.append(h)

    # 1) Cụm giờ gộp: 8-16-20 giờ, 8 - 16 - 20h.
    # Chỉ bắt khi có ít nhất một dấu '-' để tránh nhầm "1g/8h".
    grouped_pattern = re.compile(
        r'(?<![\d/])((?:2[0-3]|[01]?\d)(?:\s*[-–—]\s*(?:2[0-3]|[01]?\d))+)\s*(?:giờ|gio|h)(?![a-zA-ZÀ-ỹ0-9])',
        flags=re.IGNORECASE,
    )
    consumed_spans = []
    for m in grouped_pattern.finditer(text):
        consumed_spans.append(m.span())
        for h in re.findall(r'(?:2[0-3]|[01]?\d)', m.group(1)):
            _add_hour(h)

    def _inside_consumed(pos):
        return any(a <= pos < b for a, b in consumed_spans)

    # 2) Giờ HH:MM và giờ có hậu tố h/giờ.
    pattern = re.compile(
        r'(?P<hhmm>\b(?P<h1>[01]?\d|2[0-3]):(?P<m1>[0-5]\d)\b)'
        r'|'
        r'(?P<hour>\b(?P<h2>[01]?\d|2[0-3])\s*(?:giờ|gio|h)(?![a-zA-ZÀ-ỹ0-9]))',
        flags=re.IGNORECASE,
    )
    for m in pattern.finditer(text):
        if _inside_consumed(m.start()):
            continue
        _add_hour(m.group('h1') if m.group('hhmm') else m.group('h2'))

    # 3) Cụm buổi khi BS ghi sáng-chiều-tối nhưng không ghi số giờ.
    if not out:
        session_map = [
            (r'\bsáng\b|\bsang\b', 8),
            (r'\btrưa\b|\btrua\b', 12),
            (r'\bchiều\b|\bchieu\b', 16),
            (r'\btối\b|\btoi\b', 20),
            (r'\bđêm\b|\bdem\b', 22),
        ]
        for pat, h in session_map:
            if re.search(pat, text, flags=re.IGNORECASE):
                _add_hour(h)
    return out

def get_safety_nacl_volume(drug_name_upper: str):
    # Tra cứu luật an toàn: NEFOPAM/TRAMADOL có tong_the_tich_sau_pha=100
    for _, rule in (LUAT_AN_TOAN or {}).items():
        try:
            hoat_chat = _norm_upper(rule.get("hoat_chat", ""))
            if hoat_chat and hoat_chat in drug_name_upper:
                yc = rule.get("yeu_cau_pha_che", {}) or {}
                dung_moi = _norm_upper(yc.get("dung_moi_bat_buoc", ""))
                if "CLORID" in dung_moi or "CHLORIDE" in dung_moi or "NACL" in dung_moi:
                    vol = yc.get("tong_the_tich_sau_pha", None)
                    return float(vol) if vol is not None else None
        except:
            continue
    return None



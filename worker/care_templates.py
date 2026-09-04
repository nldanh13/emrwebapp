# -*- coding: utf-8 -*-
"""care_templates.py

Mục tiêu:
- Template diễn biến + rule action cho nhập chăm sóc.
- Hỗ trợ placeholder dạng {vị trí đau}, {cac_can_lam_sang}, ... và tự suy luận từ dữ liệu sẵn có trong JSON.

Lưu ý:
- Placeholder trong template của bạn có thể chứa dấu/ khoảng trắng => dùng cơ chế replace riêng (không dùng str.format).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import re
import unicodedata
from typing import Dict, Iterable, List, Mapping, MutableMapping, Optional, Set


# ==============================================================================
# 1) TEMPLATE DIỄN BIẾN CƠ BẢN (dùng cho 8h hoặc khi có action)
# ==============================================================================
def _load_dien_bien_base_lines() -> List[str]:
    """Đọc mẫu diễn biến chung từ config/clinical_rules.json.

    Sửa config.care_dien_bien_rules.base_lines là preview JS và nhập thật Python
    sẽ cùng đổi, không cần sửa 2 nơi.
    """
    fallback = [
        "Người bệnh tỉnh",
        "Tiếp xúc tốt",
        "Da niêm hồng",
        "Mạch rõ, chi ấm",
        "__PAIN_LINE__",
        "Vận động hạn chế",
        "Ăn được, ngủ được",
    ]
    try:
        import json as _json, os as _os
        base_dir = _os.path.dirname(_os.path.abspath(__file__))
        cfg_path = _os.path.normpath(_os.path.join(base_dir, "..", "config", "clinical_rules.json"))
        if not _os.path.isfile(cfg_path):
            return fallback
        with open(cfg_path, "r", encoding="utf-8") as f:
            data = _json.load(f)
        raw = ((data or {}).get("care_dien_bien_rules") or {}).get("base_lines") or []
        lines = [str(x).strip() for x in raw if str(x or "").strip()]
        return lines if "__PAIN_LINE__" in lines else fallback
    except Exception:
        return fallback


DIEN_BIEN_BASE_LINES: List[str] = _load_dien_bien_base_lines()


# ==============================================================================
# 2) ĐỊNH NGHĨA ACTION -> ẢNH HƯỞNG LÊN CHĂM SÓC / DIỄN BIẾN
# ==============================================================================
@dataclass(frozen=True)
class ActionDef:
    """Định nghĩa 1 action.

    match_contains: các cụm từ chỉ cần xuất hiện một trong số đó trong tên chỉ định (sau khi normalize).
    care_add: nội dung thêm vào ô "Chăm sóc".
    dien_bien_add: dòng thêm vào ô "Diễn biến".
    """

    match_contains: List[str]
    care_add: List[str]
    dien_bien_add: List[str]


ACTION_DEFS: Mapping[str, ActionDef] = {
    # Nếu có chỉ định thay băng / cắt chỉ vết mổ <=15cm
    "THAY_BANG": ActionDef(
        match_contains=["thay băng", "cắt chỉ", "vết mổ", "chăm sóc vết mổ", "thay băng vết mổ"],
        care_add=["Thay băng"],
        dien_bien_add=[
            "Vết mổ rỉ dịch ít",
        ],
    ),
    "VAT_LY_TRI_LIEU": ActionDef(
        match_contains=["vật lý trị liệu"],
        care_add=["Mời tập vật lý trị liệu"],
        dien_bien_add=[],
    ),
}


# ==============================================================================
# 3) NGUỒN TRÍCH XUẤT ACTION (từ chi_dinh_khac trong JSON v16)
# ==============================================================================
@dataclass(frozen=True)
class ActionSource:
    """Nơi lấy action trong chi_dinh_khac.

    key: tên field trong chi_dinh_khac (vd: 'thay_bang_cat_chi')
    action: action id (vd: 'THAY_BANG')
    time_format: format parse datetime từ chuỗi item[time_field]
    name_field, time_field: key trong từng item dict
    """

    key: str
    action: str
    time_format: str = "%H:%M %d/%m/%Y"
    name_field: str = "ten"
    time_field: str = "gio"


ACTION_SOURCES: List[ActionSource] = [
    ActionSource(key="thay_bang_cat_chi", action="THAY_BANG"),
]


# ==============================================================================
# 4) HELPER: normalize / placeholder / suy luận vị trí đau
# ==============================================================================
def normalize_vi(text: str) -> str:
    """Chuẩn hoá tiếng Việt: lower + bỏ dấu + gọn khoảng trắng."""
    if text is None:
        return ""
    s = str(text).strip().lower()
    s = s.replace("đ", "d").replace("Đ", "d")
    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    s = " ".join(s.split())
    return s


def _strip_outer_quotes(s: str) -> str:
    s = (s or "").strip()
    if len(s) >= 2 and ((s[0] == s[-1] == '"') or (s[0] == s[-1] == "'")):
        return s[1:-1].strip()
    return s


_PLACEHOLDER_RE = re.compile(r"\{([^{}]+)\}")


def replace_placeholders(text: str, ctx: Mapping[str, str]) -> str:
    """Replace {key} bằng ctx[key], key có thể chứa dấu/ khoảng trắng."""
    if not text:
        return ""
    ctx2 = {str(k).strip(): ("" if v is None else str(v)) for k, v in (ctx or {}).items()}

    def _rep(m: re.Match) -> str:
        key = m.group(1).strip()
        return ctx2.get(key, "")
    out = _PLACEHOLDER_RE.sub(_rep, text)
    # dọn lại dấu + khoảng trắng
    out = re.sub(r"[ \t]+", " ", out)
    out = re.sub(r"\n{3,}", "\n\n", out).strip()
    return out


def _extract_pain_phrase(text: str) -> str:
    """Ưu tiên lấy trực tiếp từ diễn biến: '... đau ...'."""
    if not text:
        return ""
    # lấy dòng có 'đau'
    for line in text.splitlines():
        l = line.strip()
        if not l:
            continue
        # match các kiểu: "Than đau ...", "Bệnh than đau ...", "Đau ..."
        m = re.search(r"\bđau\b\s*(.+)$", l, flags=re.IGNORECASE)
        if m:
            tail = m.group(1).strip(" .;:-")
            # bỏ các phần không phải vị trí
            tail = re.sub(r"^(nhieu|ít|vua|tang|giam)\b\s*", "", tail, flags=re.IGNORECASE)
            if tail:
                return tail
    return ""


# map theo chẩn đoán — load từ clinical_rules.json để đồng nhất với frontend.
# Fallback về list cứng nếu config không đọc được.

def _load_diag_to_pain():
    """Đọc pain_location_map từ clinical_rules.json.

    Keywords được normalize (bỏ dấu) để khớp với infer_vi_tri_dau.
    Đồng nhất với patient_helpers.js phía frontend — sửa JSON là đủ.
    """
    _FALLBACK = [
        (["thoat vi dia dem", "thoai hoa cot song", "cot song"], "cột sống"),
        (["gay xuong cang chan", "xuong chay", "xuong mac", "cang chan"], "cẳng chân"),
        (["gay xuong dui", "xuong dui"], "đùi"),
        (["gay xuong canh tay", "xuong canh tay", "canh tay"], "cánh tay"),
        (["gay xuong cang tay", "gay xuong quay", "gay xuong tru", "cang tay"], "cẳng tay"),
        (["gay xuong ban chan", "ban chan"], "bàn chân"),
        (["gay xuong ngon", "ngon chan", "ngon tay"], "ngón"),
        (["dau vai", "khop vai"], "vai"),
        (["khop goi", "goi"], "gối"),
        (["khop hang", "hang"], "háng"),
        (["co tay", "ong co tay", "hoi chung ong co tay"], "cổ tay"),
        (["mong"], "mông"),
        (["ap xe chi", "viem mo bao chi"], "chi"),
    ]
    try:
        import json as _json, os as _os
        _base = _os.path.dirname(_os.path.abspath(__file__))
        _cfg = _os.path.normpath(_os.path.join(_base, "..", "config", "clinical_rules.json"))
        if not _os.path.isfile(_cfg):
            return _FALLBACK
        with open(_cfg, "r", encoding="utf-8") as f:
            _data = _json.load(f)
        _raw = _data.get("pain_location_map", [])
        if not _raw:
            return _FALLBACK
        _result = []
        for _entry in _raw:
            _keys = [normalize_vi(k) for k in (_entry.get("keywords") or []) if k]
            _label = str(_entry.get("label") or "").strip()
            if _keys and _label:
                _result.append((_keys, _label))
        return _result if _result else _FALLBACK
    except Exception:
        return _FALLBACK

_DIAG_TO_PAIN: List[tuple] = _load_diag_to_pain()


def _extract_diagnosis_text(entry: Mapping) -> str:
    """Lấy chẩn đoán từ field danh sách hoặc nhap_cham_soc.dien_bien nếu có."""
    for key in ("chan_doan", "Chẩn đoán", "chẩn đoán", "chan_doan_text"):
        val = (entry or {}).get(key)
        if val:
            return str(val).strip()
    nb = (entry or {}).get("nhap_cham_soc") or {}
    db = nb.get("dien_bien") or ""
    # lấy sau "Chẩn đoán:" nếu có
    for line in db.splitlines():
        if "Chẩn đoán" in line or "Chan doan" in normalize_vi(line):
            parts = line.split(":", 1)
            if len(parts) == 2:
                return parts[1].strip()
    return ""


def infer_vi_tri_dau(entry: Mapping) -> str:
    """Suy luận {vị trí đau} từ dữ liệu sẵn có."""
    nb = (entry or {}).get("nhap_cham_soc") or {}
    db = nb.get("dien_bien") or ""
    pain = _extract_pain_phrase(db)
    if pain:
        return pain

    diag = _extract_diagnosis_text(entry)
    diag_norm = normalize_vi(diag)
    for keys, loc in _DIAG_TO_PAIN:
        if any(k in diag_norm for k in keys):
            return loc
    return "tổn thương"


def build_pain_line(raw_location: str) -> str:
    """Chuẩn hoá thành dạng: 'Đau vùng ...' thay vì 'Đau + ...'."""
    loc = str(raw_location or "").strip()
    if not loc:
        return "Đau vùng tổn thương"

    loc_norm = normalize_vi(loc)
    if loc_norm.startswith("vung "):
        loc = re.sub(r"^\s*vùng\s+", "", loc, flags=re.IGNORECASE).strip()
    elif loc_norm.startswith("tai "):
        loc = re.sub(r"^\s*tại\s+", "", loc, flags=re.IGNORECASE).strip()
    elif loc_norm.startswith("o "):
        loc = re.sub(r"^\s*ở\s+", "", loc, flags=re.IGNORECASE).strip()

    return f"Đau vùng {loc}"


def build_can_lam_sang(entry: Mapping) -> str:
    """{cac_can_lam_sang} từ chi_dinh_dvkt (danh sách chỉ định DVKT)."""
    items = (entry or {}).get("chi_dinh_dvkt") or []
    names = []
    for it in items:
        name = str((it or {}).get("ten") or "").strip()
        if name and name not in names:
            names.append(name)
    return ", ".join(names)


def has_vip_score(entry: Mapping) -> bool:
    """Có TMC/TTM thì thêm dòng Vip Score: 0."""
    thuoc = (entry or {}).get("thuoc") or {}
    if (thuoc.get("dich_truyen") or []):
        return True

    for item in (thuoc.get("thuoc_tiem") or []):
        route = normalize_vi(str((item or {}).get("duong_dung") or (item or {}).get("duong_dung_goc") or ""))
        if any(k in route for k in ["tmc", "tm cham", "tinh mach cham", "tiem cham", "tinh mach"]):
            return True
    return False


def build_placeholder_context(entry: Mapping) -> Dict[str, str]:
    """Context cho các placeholder trong template của bạn."""
    ctx: Dict[str, str] = {}
    ctx["vị trí đau"] = infer_vi_tri_dau(entry)
    ctx["cac_can_lam_sang"] = build_can_lam_sang(entry)
    # Các placeholder khác: chưa có dữ liệu trong JSON => để rỗng
    ctx["thuoc"] = ""
    ctx["so_nam_tha"] = ""
    ctx["thuoc_tha"] = ""
    ctx["so_nam_dtd"] = ""
    ctx["thuoc_dtd"] = ""
    ctx["khoa_khac"] = ""
    ctx["Thuoc_truoc_mo"] = ""
    if has_vip_score(entry):
        ctx["vip_score_line"] = "Vip Score: 0"
        ctx["co_vip_score"] = "1"
    else:
        ctx["vip_score_line"] = ""
        ctx["co_vip_score"] = ""
    return ctx


# ==============================================================================
# 5) ACTION EXTRACT / BUILD TEXT
# ==============================================================================
def match_action_name(raw_name: str, action: str) -> bool:
    """Tên chỉ định có khớp với action hay không (theo match_contains)."""
    adef = ACTION_DEFS.get(action)
    if not adef:
        return False
    name_norm = normalize_vi(raw_name)
    return any(normalize_vi(k) in name_norm for k in adef.match_contains)


def _extract_hour_from_action_value(value, default_hour: int = 8) -> Optional[int]:
    """Lấy giờ từ chuỗi/dict action, fallback 08:00 nếu có action nhưng thiếu giờ."""
    if value is None:
        return None
    if isinstance(value, Mapping):
        text = str(value.get("gio") or value.get("time") or value.get("time_full") or value.get("time_label") or "")
    else:
        text = str(value or "")
    if not text.strip():
        return None

    m = re.search(r"(\d{1,2}):(\d{2})", text)
    if m:
        try:
            hour = int(m.group(1))
            if 0 <= hour <= 23:
                return hour
        except Exception:
            pass
    m = re.search(r"(?<!\d)(\d{1,2})\s*(?:h|giờ)\b", text, flags=re.IGNORECASE)
    if m:
        try:
            hour = int(m.group(1))
            if 0 <= hour <= 23:
                return hour
        except Exception:
            pass
    return default_hour


def extract_actions_by_hour(chi_dinh_khac: Mapping) -> Dict[int, Set[str]]:
    """Trích xuất {hour: {actions}} từ chi_dinh_khac."""
    out: Dict[int, Set[str]] = {}

    if not chi_dinh_khac:
        return out

    for src in ACTION_SOURCES:
        items = chi_dinh_khac.get(src.key) or []
        for item in items:
            try:
                name = str(item.get(src.name_field, "")).strip()
                time_str = str(item.get(src.time_field, "")).strip()
                dt = datetime.strptime(time_str, src.time_format)
                hour = dt.hour
            except Exception:
                continue

            if match_action_name(name, src.action):
                out.setdefault(hour, set()).add(src.action)

    # VLTL đang lưu dạng chuỗi để tương thích schema cũ; vẫn phải tạo action chăm sóc.
    vltl = chi_dinh_khac.get("vat_ly_tri_lieu")
    if isinstance(vltl, list):
        for item in vltl:
            hour = _extract_hour_from_action_value(item, default_hour=8)
            if hour is not None:
                out.setdefault(hour, set()).add("VAT_LY_TRI_LIEU")
    elif str(vltl or "").strip():
        hour = _extract_hour_from_action_value(vltl, default_hour=8)
        if hour is not None:
            out.setdefault(hour, set()).add("VAT_LY_TRI_LIEU")

    return out




def extract_action_care_labels_by_hour(chi_dinh_khac: Mapping) -> Dict[int, Dict[str, List[str]]]:
    """Trích xuất nhãn chăm sóc gốc theo giờ và action.

    Kết quả có dạng::

        {8: {"THAY_BANG": ["Thay băng, cắt chỉ vết mổ ..."]}}

    Hàm này đi song song với :func:`extract_actions_by_hour`. Mục đích là
    giữ nguyên tên chỉ định đầy đủ khi nhập EMR, thay vì luôn rút gọn thành
    nhãn mặc định trong ``ACTION_DEFS``.
    """
    out: Dict[int, Dict[str, List[str]]] = {}

    if not chi_dinh_khac:
        return out

    def _add(hour: Optional[int], action: str, label: str) -> None:
        if hour is None or not (0 <= int(hour) <= 23):
            return
        label_text = str(label or "").strip()
        if not label_text:
            return
        bucket = out.setdefault(int(hour), {}).setdefault(action, [])
        label_norm = normalize_vi(label_text)
        if all(normalize_vi(old) != label_norm for old in bucket):
            bucket.append(label_text)

    for src in ACTION_SOURCES:
        items = chi_dinh_khac.get(src.key) or []
        if not isinstance(items, list):
            items = [items]
        for item in items:
            if not isinstance(item, Mapping):
                continue
            name = str(item.get(src.name_field, "") or "").strip()
            if not name or not match_action_name(name, src.action):
                continue
            time_value = item.get(src.time_field)
            hour: Optional[int] = None
            try:
                hour = datetime.strptime(str(time_value or "").strip(), src.time_format).hour
            except Exception:
                hour = _extract_hour_from_action_value(time_value, default_hour=8)
            _add(hour, src.action, name)

    # Preview hiển thị VLTL bằng nhãn chuẩn này, nên worker cũng dùng cùng nhãn.
    vltl = chi_dinh_khac.get("vat_ly_tri_lieu")
    if isinstance(vltl, list):
        for item in vltl:
            hour = _extract_hour_from_action_value(item, default_hour=8)
            if hour is not None:
                _add(hour, "VAT_LY_TRI_LIEU", "Mời tập vật lý trị liệu")
    elif str(vltl or "").strip():
        hour = _extract_hour_from_action_value(vltl, default_hour=8)
        if hour is not None:
            _add(hour, "VAT_LY_TRI_LIEU", "Mời tập vật lý trị liệu")

    return out


def build_dien_bien(base_lines: Iterable[str], actions_set: Set[str], ctx: Optional[Mapping[str, str]] = None) -> str:
    """Ghép mẫu diễn biến theo mẫu chuẩn mới.

    - Ca thường: Đau vùng ...
    - Có thay băng / cắt chỉ: Đau vết mổ + Vết mổ rỉ dịch ít
    - Có TMC/TTM: thêm Vip Score: 0
    """
    ctx2 = {str(k).strip(): ("" if v is None else str(v)) for k, v in (ctx or {}).items()}
    has_thay_bang = "THAY_BANG" in (actions_set or set())

    lines: List[str] = []
    for line in list(base_lines or []):
        if line == "__PAIN_LINE__":
            pain_line = "Đau vết mổ" if has_thay_bang else build_pain_line(ctx2.get("vị trí đau", ""))
            if pain_line not in lines:
                lines.append(pain_line)
            continue
        if line and line not in lines:
            lines.append(line)

    for act in sorted(actions_set or []):
        adef = ACTION_DEFS.get(act)
        if not adef:
            continue
        for extra in adef.dien_bien_add:
            if extra and extra not in lines:
                lines.append(extra)

    vip_line = ctx2.get("vip_score_line", "").strip()
    if vip_line and vip_line not in lines:
        lines.append(vip_line)

    text = "\n".join(lines).strip()
    return replace_placeholders(text, ctx2)


def extend_care_parts(care_parts: List[str], actions_set: Set[str]) -> List[str]:
    """Bổ sung nội dung chăm sóc theo action."""
    for act in sorted(actions_set or []):
        adef = ACTION_DEFS.get(act)
        if not adef:
            continue
        for extra in adef.care_add:
            if extra and extra not in care_parts:
                care_parts.append(extra)
    return care_parts


# ==============================================================================
# TRUYỀN MÁU — Template 4 mốc chăm sóc
# ==============================================================================
# offset_minutes: số phút tính từ giờ nhận máu
# Mốc cuối (3h53p = 233 phút) là kết thúc truyền túi 350 ml ở tốc độ 30 giọt/phút.

TRUYEN_MAU_CARE_SLOTS = [
    {
        "offset_minutes": 0,
        "label": "Nhận máu",
        "dien_bien": "Người bệnh tỉnh",
        "cham_soc": "Lấy dấu hiệu sinh tồn + Thử phản ứng thuận hợp tại giường + Trình Bác sĩ trực sau 15p",
    },
    {
        "offset_minutes": 60,
        "label": "Sau 1h truyền máu",
        "dien_bien": "Người bệnh tỉnh",
        "cham_soc": "Lấy dấu hiệu sinh tồn",
    },
    {
        "offset_minutes": 120,
        "label": "Sau 2h truyền máu",
        "dien_bien": "Người bệnh tỉnh",
        "cham_soc": "Lấy dấu hiệu sinh tồn",
    },
    {
        "offset_minutes": 233,
        "label": "Kết thúc truyền máu",
        "dien_bien": "Người bệnh tỉnh",
        "cham_soc": "Lấy dấu hiệu sinh tồn + Kết thúc truyền máu",
    },
]

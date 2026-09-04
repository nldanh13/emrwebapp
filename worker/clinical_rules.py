# -*- coding: utf-8 -*-
"""Clinical rule engine for parsed EMR orders/care preview.

Mục tiêu:
- Tập trung rule nghiệp vụ ở một chỗ để sau này thêm rule mới dễ hơn.
- Lọc thuốc/y lệnh đã thực hiện ở phòng mổ/hậu phẫu.
- Nhận diện case người bệnh đi mổ/chuyển hậu phẫu rồi khoa CTCH nhận lại, để chỉ tạo phiếu chăm sóc từ mốc nhận khoa.
"""
from __future__ import annotations

import json
import os
import re
import unicodedata
from shared.text_utils import norm_vi as _norm
from copy import deepcopy
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

try:
    from care_templates import infer_vi_tri_dau, build_pain_line
except Exception:  # pragma: no cover
    infer_vi_tri_dau = None  # type: ignore
    build_pain_line = None  # type: ignore

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(BASE_DIR)
DEFAULT_RULES_PATH = os.path.join(ROOT_DIR, "config", "clinical_rules.json")

POSTOP_RECEIVE_DEFAULT_DIEN_BIEN = "\n".join([
    "Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh nhận bệnh",
    "Người bệnh tỉnh",
    "Tiếp xúc tốt",
    "Da niêm hồng",
    "Mạch rõ, chi ấm",
    "Đau vết mổ",
    "Vết mổ chưa ghi nhận dịch thấm băng",
])

POSTOP_RECEIVE_DEFAULT_CARE = " + ".join([
    "Nhận hồ sơ",
    "Lấy dấu hiệu sinh tồn",
    "Trình Bác sĩ trực",
    "Hướng dẫn ăn uống nghỉ ngơi sau mổ",
])

DISCHARGE_DEFAULT_DIEN_BIEN = "Người bệnh xuất viện"

DISCHARGE_DEFAULT_CARE = " + ".join([
    "Hoàn tất hồ sơ ra viện",
    "Cấp giấy ra viện",
    "Cấp thuốc theo toa",
    "Hướng dẫn tái khám",
])

CLINIC_ADMISSION_DEFAULT_CARE = " + ".join([
    "Hoàn tất hồ sơ nhập viện",
    "Kính chuyển Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh",
    "Hồ sơ",
])

WARD_RECEIVE_DEFAULT_CARE = " + ".join([
    "Nhận hồ sơ",
    "Lấy dấu hiệu sinh tồn",
    "Trình Bác sĩ trực",
    "Hướng dẫn nội quy khoa phòng",
    "Thực hiện cận lâm sàng",
])

INTERDEPT_RECEIVE_DEFAULT_CARE = " + ".join([
    "Nhận hồ sơ",
    "Lấy dấu hiệu sinh tồn",
    "Trình Bác sĩ trực",
    "Hướng dẫn nội quy khoa phòng",
])

# DEFAULT_RULES là fallback khi không đọc được config/clinical_rules.json.
# Để thay đổi rule nghiệp vụ, hãy sửa config/clinical_rules.json — KHÔNG sửa dict này.
DEFAULT_RULES = {
    "medication_skip_rules": [
        {
            "id": "post_op_or_intra_op_already_done",
            "enabled": True,
            "categories": ["dich_truyen", "thuoc_tiem", "thuoc_uong", "khac"],
            "reason": "Thuốc ghi trong mổ/sau mổ/SM được xem là đã thực hiện ở phòng mổ/hậu phẫu, không nhập lại tại khoa.",
            "patterns": [
                r"\btrong\s+mo\b",
                r"\bsau\s+mo\b",
                r"\bhau\s+phau\b",

                # Bắt SM-16h, SM:16h, SM 16h.
                # Không bắt nhầm các tên như SMOF vì sau SM phải là dấu -, :, khoảng trắng + số giờ.
                r"(?<![a-z0-9])sm\s*[-:]?\s*\d{1,2}\s*h?\b",
            ],
        }
    ],
    "postop_receive_rules": {
        "enabled": True,
        "dept_receive_text": "Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh nhận bệnh",
        "dien_bien_template": POSTOP_RECEIVE_DEFAULT_DIEN_BIEN,
        "care_template": POSTOP_RECEIVE_DEFAULT_CARE,
        "receive_patterns": [
            r"\bngoai\s+ctch\s+nhan\b",
            r"\bctch\s*(?:-|\s)*tk\s+nhan\b",
            r"\bctch\s+nhan\b",
            r"\bkhoa\s+ngoai\s+chan\s+thuong\s+chinh\s+hinh\s+va\s+than\s+kinh\s+nhan\s+benh\b",
        ],
        "context_patterns": [
            r"\bchuyen\s+mo\b",
            r"\bphau\s+thuat\b",
            r"\bsau\s+mo\b",
            r"\bhau\s+phau\b",
            r"\bkinh\s+chuyen\s+khoa\s+ngoai\s+ctch\b",
            r"\bkinh\s+chuyen\s+khoa\s+ctch\b",
            r"\bctch\s*(?:-|\s)*tk\b",
            r"\bpt\s*0?1\b",
            r"\bvet\s+mo\b",
            r"\bbang\s+kin\b",
            r"\bhp\s+nhan\s+benh\b",
        ],
    },
    "discharge_rules": {
        "enabled": True,
        "dien_bien_template": DISCHARGE_DEFAULT_DIEN_BIEN,
        "care_template": DISCHARGE_DEFAULT_CARE,
        "disposition_patterns": [
            r"\bra\s+vien\b",
            r"\bxuat\s+vien\b",
        ],
    },
    "admission_transfer_rules": {
        "enabled": True,
        "clinic_source_patterns": [
            r"\bkhoa\s+kham\s+benh\b",
            r"\bphong\s+kham\b",
        ],
        "postop_source_patterns": [
            r"\bkhoa\s+gay\s+me\s+hoi\s+suc\b",
            r"\bhau\s+phau\b",
            r"\bphong\s+phau\s+thuat\b",
        ],
        "ward_receive_patterns": [
            r"\bctch\s+nhan\b",
            r"\bngoai\s+ctch\s+nhan\b",
            r"\bctch\s*(?:-|\s)*tk\s+nhan\b",
            r"\bctch\s+nhan\b",
            r"\bkhoa\s+ngoai\s+chan\s+thuong\s+chinh\s+hinh\s+va\s+than\s+kinh\s+nhan\s+benh\b",
        ],
        "clinic_admission_care_template": CLINIC_ADMISSION_DEFAULT_CARE,
        "ward_receive_care_template": WARD_RECEIVE_DEFAULT_CARE,
        "interdepartment_receive_care_template": INTERDEPT_RECEIVE_DEFAULT_CARE,
    },
}


# _norm → shared.text_utils.norm_vi (xem MIGRATION.md)


def _norm_multiline(text: Any) -> str:
    s = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def load_clinical_rules() -> Dict[str, Any]:
    """Đọc config/clinical_rules.json nếu có, không có thì dùng rule mặc định."""
    path = os.environ.get("CLINICAL_RULES_PATH") or DEFAULT_RULES_PATH
    if not os.path.exists(path):
        return deepcopy(DEFAULT_RULES)

    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            merged = deepcopy(DEFAULT_RULES)
            for key, value in data.items():
                merged[key] = value
            return merged
    except Exception:
        pass

    return deepcopy(DEFAULT_RULES)


def _drug_blob(item: Dict[str, Any]) -> str:
    parts = [
        item.get("ten_hien_thi"),
        item.get("ten_thuoc"),
        item.get("hoat_chat"),
        item.get("duong_dung_goc"),
        item.get("duong_dung"),
        item.get("gio_dung"),
        item.get("tg_bat_dau"),
        item.get("tg_ket_thuc"),
        item.get("ghi_chu"),
        item.get("note"),
    ]
    return _norm(" ".join(str(x or "") for x in parts))


def medication_skip_decision(item: Dict[str, Any], category: str = "") -> Tuple[bool, Dict[str, Any]]:
    """Trả về (có bỏ qua không, thông tin rule).

    Thuốc tự túc (tu_tuc=True) luôn được nhập — không bị skip bởi bất kỳ rule nào.
    """
    if not isinstance(item, dict):
        return False, {}

    # Thuốc tự túc: bệnh nhân tự mua, không liên quan đến quy trình phòng mổ/hậu phẫu.
    # Luôn giữ lại, không apply rule.
    if item.get("tu_tuc"):
        return False, {}

    blob = _drug_blob(item)
    rules = load_clinical_rules().get("medication_skip_rules") or []

    for rule in rules:
        if not rule or rule.get("enabled") is False:
            continue

        categories = rule.get("categories") or []
        if category and categories and category not in categories:
            continue

        for pattern in rule.get("patterns") or []:
            try:
                if re.search(pattern, blob, flags=re.IGNORECASE):
                    return True, {
                        "rule_id": rule.get("id") or "unnamed_rule",
                        "reason": rule.get("reason") or "Bỏ qua theo rule nghiệp vụ",
                        "matched_pattern": pattern,
                    }
            except re.error:
                continue

    return False, {}


def _parse_hours_from_text(raw: Any) -> List[int]:
    s = str(raw or "")
    hours: List[int] = []

    for m in re.finditer(r"\b(\d{1,2})(?::\d{2}|\s*h|\s*gio|\s*giờ)\b", s, flags=re.IGNORECASE):
        try:
            h = int(m.group(1))
            if 0 <= h <= 23 and h not in hours:
                hours.append(h)
        except Exception:
            pass

    return hours


def recompute_medication_hours(record: Dict[str, Any]) -> List[int]:
    """Tính lại tong_hop_gio_dung sau khi thuốc đã bị lọc bởi rule."""
    thuoc = record.get("thuoc") or {}
    hours = set()

    for cat in ("dich_truyen", "thuoc_tiem", "thuoc_uong"):
        for item in thuoc.get(cat, []) or []:
            for field in ("tg_bat_dau", "gio_dung"):
                for h in _parse_hours_from_text(item.get(field)):
                    hours.add(h)

    return sorted(hours)


def _split_timeline_blocks(raw_text: Any, source: str = "") -> List[Dict[str, str]]:
    """Tách đoạn kiểu '13:35 | Bác sĩ: Hồ Điền\n...' từ diễn biến/y lệnh gốc."""
    raw = str(raw_text or "").replace("\r\n", "\n").replace("\r", "\n")
    blocks: List[Dict[str, str]] = []

    # Cắt theo dòng --- nhưng vẫn đọc được các đoạn có header thời gian.
    for part in re.split(r"\n\s*---\s*\n", raw):
        part = part.strip()
        if not part:
            continue
        m = re.match(r"^\s*(\d{1,2}:\d{2})\s*\|\s*Bác\s*sĩ:\s*([^\n]*)\n(?P<body>.*)$", part, flags=re.IGNORECASE | re.DOTALL)
        if not m:
            continue
        blocks.append({
            "time": f"{int(m.group(1).split(':')[0]):02d}:{m.group(1).split(':')[1]}",
            "doctor": (m.group(2) or "").strip(),
            "body": _norm_multiline(m.group("body")),
            "raw": part,
            "source": source,
        })

    return blocks


def _hhmm_to_minutes(hhmm: Any) -> Optional[int]:
    m = re.search(r"(\d{1,2}):(\d{2})", str(hhmm or ""))
    if not m:
        return None
    try:
        h = int(m.group(1)); mi = int(m.group(2))
        if 0 <= h <= 23 and 0 <= mi <= 59:
            return h * 60 + mi
    except Exception:
        return None
    return None


def _extract_item_minutes(item: Dict[str, Any], ngay_lam: str = "") -> Optional[int]:
    """Lấy phút trong ngày theo giờ thực hiện thuốc nếu có."""
    for field in ("tg_bat_dau", "gio_dung"):
        raw = str(item.get(field) or "")
        m = re.search(r"(\d{1,2}):(\d{2})", raw)
        if m:
            return _hhmm_to_minutes(m.group(0))
        m = re.search(r"\b(\d{1,2})\s*(?:h|giờ|gio)\b", raw, flags=re.IGNORECASE)
        if m:
            try:
                h = int(m.group(1))
                if 0 <= h <= 23:
                    return h * 60
            except Exception:
                pass
    return None


def _extract_order_minutes(item: Dict[str, Any]) -> Optional[int]:
    return _hhmm_to_minutes(item.get("gio_y_lenh"))


def _block_matches_any(block: Dict[str, Any], patterns: List[str]) -> Tuple[bool, str]:
    body_norm = _norm(block.get("body"))
    raw_norm = _norm(block.get("raw"))
    blob = f"{body_norm} {raw_norm}".strip()
    for pat in patterns or []:
        try:
            if re.search(pat, blob, flags=re.IGNORECASE):
                return True, pat
        except re.error:
            continue
    return False, ""


def _block_minutes(block: Dict[str, Any]) -> Optional[int]:
    return _hhmm_to_minutes(block.get("time"))


def extract_care_special_events(raw_dien_bien: Any, raw_y_lenh: Any = "", ngay_lam: str = "") -> List[Dict[str, Any]]:
    """Nhận diện các phiếu chăm sóc đặc biệt trong timeline cùng ngày.

    Gồm:
    - Hậu phẫu/chuyển khoa rồi CTCH nhận lại.
    - Xuất viện thể hiện trong diễn biến, kể cả khi cột Xử trí bị ghi nhầm.
    """
    discharge_events = _extract_discharge_special_events_from_timeline(raw_dien_bien, ngay_lam)

    rules = load_clinical_rules().get("postop_receive_rules") or {}
    if rules.get("enabled") is False:
        return discharge_events

    receive_patterns = rules.get("receive_patterns") or []
    context_patterns = rules.get("context_patterns") or []
    if not receive_patterns or not context_patterns:
        return discharge_events

    db_blocks = _split_timeline_blocks(raw_dien_bien, source="dien_bien")
    yl_blocks = _split_timeline_blocks(raw_y_lenh, source="y_lenh")
    if not db_blocks and not yl_blocks:
        return []

    # Chỉ lấy block nhận khoa từ diễn biến bệnh. Y lệnh chỉ dùng làm ngữ cảnh trước nhận khoa.
    # Như vậy các ngày sau có chữ "sau mổ" hoặc thuốc hậu phẫu sẽ không bị hiểu nhầm.
    receive_candidates = []
    for block in db_blocks:
        matched, pat = _block_matches_any(block, receive_patterns)
        if matched:
            receive_candidates.append((block, pat))

    if not receive_candidates:
        return discharge_events

    context_blocks = db_blocks + yl_blocks
    out: List[Dict[str, Any]] = []

    for block, receive_pat in receive_candidates:
        receive_mins = _block_minutes(block)
        if receive_mins is None:
            continue

        matched_context = None
        matched_context_pat = ""
        for ctx in context_blocks:
            ctx_mins = _block_minutes(ctx)
            if ctx_mins is None:
                continue
            # Ngữ cảnh mổ/hậu phẫu phải xảy ra trước hoặc nằm ngay trong block nhận khoa.
            # Trường hợp thực tế: cùng block ghi "CTCH nhận ... Hậu phẫu ... vết mổ".
            # Chỉ bỏ các block sau mốc nhận khoa để tránh ngày sau bị hiểu nhầm.
            if ctx_mins > receive_mins:
                continue
            ok, ctx_pat = _block_matches_any(ctx, context_patterns)
            if ok:
                matched_context = ctx
                matched_context_pat = ctx_pat
                break

        if not matched_context:
            continue

        hhmm = block.get("time") or ""
        time_full = f"{hhmm} {ngay_lam}" if ngay_lam else hhmm
        out.append({
            "type": "postop_receive",
            "source_date": ngay_lam,
            "time_full": time_full,
            "time_label": hhmm,
            "time_minutes": receive_mins,
            "doctor": block.get("doctor") or "",
            "title": "Nhận bệnh sau mổ/chuyển khoa",
            "dien_bien": _norm_multiline(rules.get("dien_bien_template") or POSTOP_RECEIVE_DEFAULT_DIEN_BIEN),
            "cham_soc": _norm_multiline(rules.get("care_template") or POSTOP_RECEIVE_DEFAULT_CARE),
            "needs_vitals": True,
            "source_body": block.get("body") or "",
            "recognition": {
                "receive_pattern": receive_pat,
                "context_pattern": matched_context_pat,
                "context_time": matched_context.get("time") or "",
                "context_source": matched_context.get("source") or "",
                "context_body": matched_context.get("body") or "",
            },
        })

    # Dedup theo ngày + giờ + type.
    seen = set()
    deduped = []
    for ev in discharge_events + out:
        key = (ev.get("type"), ev.get("source_date"), ev.get("time_full"))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(ev)
    return sorted(deduped, key=lambda x: int(x.get("time_minutes") or 0))


def _field_first(record: Dict[str, Any], keys: List[str]) -> str:
    for key in keys:
        val = record.get(key)
        if val is not None and str(val).strip():
            return str(val).strip()
    return ""


def _match_any_text(text: Any, patterns: List[str]) -> Tuple[bool, str]:
    blob = _norm(text)
    for pat in patterns or []:
        try:
            if re.search(pat, blob, flags=re.IGNORECASE):
                return True, pat
        except re.error:
            continue
    return False, ""


def _event_pain_line(source_record: Dict[str, Any], raw_dien_bien: Any = "") -> str:
    diag = _field_first(source_record, ["Chẩn đoán", "chan_doan", "chẩn đoán", "chan_doan_text"])
    entry = {
        "nhap_cham_soc": {
            "dien_bien": "\n".join(x for x in [str(raw_dien_bien or "").strip(), f"Chẩn đoán: {diag}" if diag else ""] if x)
        }
    }
    try:
        if infer_vi_tri_dau and build_pain_line:
            return build_pain_line(infer_vi_tri_dau(entry))
    except Exception:
        pass
    return "Đau vùng tổn thương"


def _clinic_admission_dien_bien(pain_line: str) -> str:
    return _norm_multiline("\n".join([
        "Phòng khám Chấn thương chỉnh hình - Thần kinh nhận",
        "Người bệnh tỉnh",
        "Tiếp xúc tốt",
        "Da niêm hồng",
        "Mạch rõ, chi ấm",
        pain_line or "Đau vùng tổn thương",
        "Vận động hạn chế",
        "Tiền sử dị ứng thuốc chưa ghi nhận",
    ]))


def _has_postop_receive_context_from_text(*parts: Any) -> bool:
    """Nhận diện ca chuyển khoa nhưng thực chất là hậu phẫu/GMHS trả về khoa."""
    text = _norm("\n".join(str(p or "") for p in parts if p is not None))
    if not text:
        return False
    patterns = [
        r"\bhau\s+phau\b",
        r"\bsau\s+mo\b",
        r"\bphong\s+phau\s+thuat\b",
        r"\bgay\s+me\s+hoi\s+suc\b",
        r"\bgmhs\b",
        r"\bpt\s*0?1\b",
        r"\bvet\s+mo\b",
        r"\bket\s+hop\s+xuong\b",
        r"\bthay\s+khop\b",
        r"\bnoi\s+soi\b",
    ]
    return any(re.search(pat, text, flags=re.IGNORECASE) for pat in patterns)


def _ward_receive_dien_bien(pain_line: str, include_allergy: bool = True, include_belly: bool = False) -> str:
    lines = [
        "Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh nhận",
        "Người bệnh tỉnh",
        "Tiếp xúc tốt",
        "Da niêm hồng",
        "Mạch rõ, chi ấm",
    ]
    if include_belly:
        lines.append("Bụng mềm")
    lines.extend([
        pain_line or "Đau vùng tổn thương",
        "Vận động hạn chế",
    ])
    if include_allergy:
        lines.append("Tiền sử dị ứng thuốc chưa ghi nhận")
    return _norm_multiline("\n".join(lines))


def _first_timeline_block_after(raw_dien_bien: Any, raw_y_lenh: Any, after_minutes: Optional[int], patterns: List[str]) -> Optional[Dict[str, Any]]:
    blocks = _split_timeline_blocks(raw_dien_bien, source="dien_bien") + _split_timeline_blocks(raw_y_lenh, source="y_lenh")
    prepared = []
    for block in blocks:
        mins = _block_minutes(block)
        if mins is None:
            continue
        if after_minutes is not None and mins < after_minutes:
            continue
        prepared.append((mins, block))
    prepared.sort(key=lambda x: x[0])

    for _mins, block in prepared:
        ok, _pat = _block_matches_any(block, patterns)
        if ok:
            return block
    return prepared[0][1] if prepared else None


def extract_admission_transfer_events(source_record: Dict[str, Any], raw_dien_bien: Any = "", raw_y_lenh: Any = "", ngay_lam: str = "") -> List[Dict[str, Any]]:
    """Nhận diện ngày người bệnh mới vào/chuyển về khoa từ cột T/G vào + Khoa chuyển đến.

    Chỉ tạo event trong đúng ngày có T/G vào trùng ngay_lam để các ngày sau không bị nhầm là mới chuyển.
    Khoa Gây Mê Hồi Sức/hậu phẫu được bỏ qua ở rule này, vì đã có rule postop_receive riêng.
    """
    rules = load_clinical_rules().get("admission_transfer_rules") or {}
    if rules.get("enabled") is False:
        return []
    if not isinstance(source_record, dict):
        source_record = {}

    record_date = _normalize_dmy_date(ngay_lam)
    tg_vao = _field_first(source_record, ["T/G vào", "tg_vao", "thoi_gian_vao_khoa", "Ngày giờ vào khoa", "Thời gian vào khoa", "thoi_gian_vao", "Thời gian vào", "tgvao"])
    if not record_date or not tg_vao:
        return []
    tg_vao_date = _normalize_dmy_date(tg_vao)
    if not tg_vao_date or tg_vao_date != record_date:
        return []

    # Nếu diễn biến/y lệnh cùng ngày đã nhận diện được bệnh hậu phẫu/chuyển khoa sau mổ
    # thì KHÔNG tạo thêm phiếu nhận chuyển khoa từ cột T/G vào. Trường hợp này như ca
    # hậu phẫu về khoa: chỉ cần phiếu "Nhận bệnh sau mổ/chuyển khoa" theo block diễn biến.
    try:
        if extract_care_special_events(raw_dien_bien, raw_y_lenh, record_date):
            return []
    except Exception:
        pass

    hhmm = _extract_hhmm(tg_vao)
    if not hhmm:
        return []
    admit_mins = _hhmm_to_minutes(hhmm)
    if admit_mins is None:
        return []

    khoa_chuyen_den = _field_first(source_record, ["Tên khoa điều trị", "Khoa điều trị", "Khoa hiện tại", "ten_khoa_dieu_tri", "khoa_dieu_tri", "Khoa chuyển đến", "khoa_chuyen_den", "khoa_chuyen", "khoa_nguon"])
    is_postop_source, _ = _match_any_text(khoa_chuyen_den, rules.get("postop_source_patterns") or [])
    raw_postop_context = _has_postop_receive_context_from_text(khoa_chuyen_den, raw_dien_bien, raw_y_lenh)
    if is_postop_source:
        return []
    is_clinic_source, _ = _match_any_text(khoa_chuyen_den, rules.get("clinic_source_patterns") or [])

    pain_line = _event_pain_line(source_record, raw_dien_bien)
    out: List[Dict[str, Any]] = []

    if is_clinic_source:
        out.append({
            "type": "clinic_admission",
            "source_date": record_date,
            "time_full": f"{hhmm} {record_date}",
            "time_label": hhmm,
            "time_minutes": admit_mins,
            "title": "Phòng khám nhận/người bệnh nhập viện",
            "dien_bien": _clinic_admission_dien_bien(pain_line),
            "cham_soc": _norm_multiline(rules.get("clinic_admission_care_template") or CLINIC_ADMISSION_DEFAULT_CARE),
            "needs_vitals": False,
            # Điều dưỡng nhận theo lịch ca thực tế của thời điểm nhận.
            "recognition": {
                "tg_vao": tg_vao,
                "khoa_chuyen_den": khoa_chuyen_den,
                "source": "list_column_tg_vao_khoa_chuyen_den",
            },
        })

        ward_block = _first_timeline_block_after(raw_dien_bien, raw_y_lenh, admit_mins, rules.get("ward_receive_patterns") or [])
        if ward_block:
            ward_hhmm = ward_block.get("time") or ""
            ward_mins = _hhmm_to_minutes(ward_hhmm)
            if ward_hhmm and ward_mins is not None:
                out.append({
                    "type": "ward_receive",
                    "source_date": record_date,
                    "time_full": f"{ward_hhmm} {record_date}",
                    "time_label": ward_hhmm,
                    "time_minutes": ward_mins,
                    "doctor": ward_block.get("doctor") or "",
                    "title": "Khoa Ngoại CTCH-TK nhận người bệnh",
                    "dien_bien": _ward_receive_dien_bien(pain_line, include_allergy=True, include_belly=False),
                    "cham_soc": _norm_multiline(rules.get("ward_receive_care_template") or WARD_RECEIVE_DEFAULT_CARE),
                    "needs_vitals": True,
                    # Điều dưỡng nhận theo lịch ca thực tế của thời điểm nhận.
                    "recognition": {
                        "tg_vao": tg_vao,
                        "khoa_chuyen_den": khoa_chuyen_den,
                        "source_block": ward_block.get("source") or "",
                        "source_body": ward_block.get("body") or "",
                    },
                })
    else:
        if raw_postop_context:
            out.append({
                "type": "postop_receive",
                "source_date": record_date,
                "time_full": f"{hhmm} {record_date}",
                "time_label": hhmm,
                "time_minutes": admit_mins,
                "title": "Nhận bệnh sau mổ/chuyển khoa",
                "dien_bien": _norm_multiline(POSTOP_RECEIVE_DEFAULT_DIEN_BIEN),
                "cham_soc": _norm_multiline(POSTOP_RECEIVE_DEFAULT_CARE),
                "needs_vitals": True,
                "recognition": {
                    "tg_vao": tg_vao,
                    "khoa_chuyen_den": khoa_chuyen_den,
                    "source": "list_column_tg_vao_khoa_chuyen_den_postop_context",
                },
            })
        else:
            out.append({
                "type": "interdepartment_receive",
                "source_date": record_date,
                "time_full": f"{hhmm} {record_date}",
                "time_label": hhmm,
                "time_minutes": admit_mins,
                "title": "Nhận người bệnh chuyển khoa",
                "dien_bien": _ward_receive_dien_bien(pain_line, include_allergy=False, include_belly=True),
                "cham_soc": _norm_multiline(rules.get("interdepartment_receive_care_template") or INTERDEPT_RECEIVE_DEFAULT_CARE),
                "needs_vitals": True,
                "recognition": {
                    "tg_vao": tg_vao,
                    "khoa_chuyen_den": khoa_chuyen_den,
                    "source": "list_column_tg_vao_khoa_chuyen_den",
                },
            })

    seen = set()
    deduped = []
    for ev in out:
        key = (ev.get("type"), ev.get("source_date"), ev.get("time_full"))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(ev)
    return sorted(deduped, key=lambda x: int(x.get("time_minutes") or 0))

def _get_receive_event(record: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    for ev in record.get("care_special_events") or []:
        if isinstance(ev, dict) and ev.get("type") == "postop_receive":
            return ev
    return None


def _skip_before_receive_decision(item: Dict[str, Any], record: Dict[str, Any]) -> Tuple[bool, Dict[str, Any]]:
    # Thuốc tự túc không bị giữ lại bởi rule này — bệnh nhân tự mua, không liên quan mốc nhận khoa.
    if isinstance(item, dict) and item.get("tu_tuc"):
        return False, {}
    ev = _get_receive_event(record)
    if not ev:
        return False, {}
    receive_mins = ev.get("time_minutes")
    try:
        receive_mins = int(receive_mins)
    except Exception:
        receive_mins = None
    if receive_mins is None:
        return False, {}

    exec_mins = _extract_item_minutes(item, record.get("ngay_lam") or "")
    if exec_mins is not None:
        if exec_mins < receive_mins:
            return True, {
                "rule_id": "skip_medication_before_postop_receive",
                "reason": "Thuốc có giờ thực hiện trước mốc khoa nhận bệnh sau mổ/chuyển khoa, không nhập tại khoa.",
                "matched_pattern": f"exec<{ev.get('time_label')}",
            }
        return False, {}

    # Nếu không có giờ thực hiện rõ nhưng giờ ra y lệnh trước mốc nhận khoa thì bỏ,
    # vì thường là thuốc/việc đã xử trí ở phòng mổ/hậu phẫu.
    order_mins = _extract_order_minutes(item)
    if order_mins is not None and order_mins < receive_mins:
        return True, {
            "rule_id": "skip_undated_medication_ordered_before_postop_receive",
            "reason": "Thuốc/y lệnh không có giờ thực hiện rõ và được ra trước mốc khoa nhận bệnh, không tự nhập tại khoa.",
            "matched_pattern": f"order<{ev.get('time_label')}",
        }

    return False, {}


def _normalize_dmy_date(raw: Any) -> str:
    """Chuẩn hoá ngày về dd/mm/yyyy từ dd/mm/yyyy, dd-mm-yyyy hoặc chuỗi có giờ."""
    s = str(raw or "").strip()
    if not s:
        return ""
    m = re.search(r"(\d{1,2})[/-](\d{1,2})[/-](\d{4})", s)
    if not m:
        return ""
    try:
        d = int(m.group(1)); mo = int(m.group(2)); y = int(m.group(3))
        return f"{d:02d}/{mo:02d}/{y:04d}"
    except Exception:
        return ""


def _extract_hhmm(raw: Any) -> str:
    m = re.search(r"(\d{1,2}):(\d{2})", str(raw or ""))
    if not m:
        return ""
    try:
        h = int(m.group(1)); mi = int(m.group(2))
        if 0 <= h <= 23 and 0 <= mi <= 59:
            return f"{h:02d}:{mi:02d}"
    except Exception:
        pass
    return ""


def _record_has_discharge_disposition(record: Dict[str, Any]) -> bool:
    rules = load_clinical_rules().get("discharge_rules") or {}
    pats = rules.get("disposition_patterns") or []
    blob = _norm(" ".join(str(record.get(k) or "") for k in ("xu_tri", "Xử trí", "xu_tri_text", "disposition")))
    if not blob:
        return bool(record.get("ra_vien_hom_nay") and (record.get("ngay_ra_vien") or record.get("gio_ra_vien")))
    for pat in pats:
        try:
            if re.search(pat, blob, flags=re.IGNORECASE):
                return True
        except re.error:
            continue
    return bool(record.get("ra_vien_hom_nay") and (record.get("ngay_ra_vien") or record.get("gio_ra_vien")))


def _discharge_timeline_block_is_actual(block: Dict[str, Any], rules: Dict[str, Any]) -> Tuple[bool, str]:
    """Nhận diện phiếu diễn biến thực sự cho xuất viện.

    Fallback này xử lý các ca cột Xử trí bị mất/ghi nhầm nhưng diễn biến có câu
    kiểu: "Bệnh tạm ổn -> Xuất viện" và hướng dẫn thuốc theo toa, tái khám.
    Không bắt các câu chỉ là "dự kiến xuất viện" trong y lệnh.
    """
    body_norm = _norm(block.get("body"))
    if not body_norm:
        return False, ""

    excluded = rules.get("timeline_exclude_patterns") or [
        r"\bdu\s+kien\s+(?:ra|xuat)\s+vien\b",
        r"\bdu\s+tinh\s+(?:ra|xuat)\s+vien\b",
        r"\bngay\s+mai\s+(?:ra|xuat)\s+vien\b",
        r"\bhen\s+(?:ra|xuat)\s+vien\b",
    ]
    for pat in excluded:
        try:
            if re.search(pat, body_norm, flags=re.IGNORECASE):
                return False, pat
        except re.error:
            continue

    discharge_patterns = rules.get("timeline_patterns") or rules.get("disposition_patterns") or [
        r"\bra\s+vien\b",
        r"\bxuat\s+vien\b",
    ]
    matched_discharge = ""
    for pat in discharge_patterns:
        try:
            if re.search(pat, body_norm, flags=re.IGNORECASE):
                matched_discharge = pat
                break
        except re.error:
            continue
    if not matched_discharge:
        return False, ""

    confirmation_patterns = rules.get("timeline_confirmation_patterns") or [
        r"\bbenh\s+(?:tam\s+)?on\b",
        r"\btam\s+on\b",
        r"\bthuoc\s+theo\s+toa\b",
        r"\btai\s+kham\b",
        r"\bcap\s+(?:giay\s+)?ra\s+vien\b",
        r"\bhuong\s+dan\s+.*tai\s+kham\b",
    ]
    for pat in confirmation_patterns:
        try:
            if re.search(pat, body_norm, flags=re.IGNORECASE):
                return True, matched_discharge
        except re.error:
            continue

    return False, ""


def _extract_discharge_special_events_from_timeline(raw_dien_bien: Any, ngay_lam: str = "") -> List[Dict[str, Any]]:
    rules = load_clinical_rules().get("discharge_rules") or {}
    if rules.get("enabled") is False:
        return []
    record_date = _normalize_dmy_date(ngay_lam) or str(ngay_lam or "").strip()
    out: List[Dict[str, Any]] = []
    for block in _split_timeline_blocks(raw_dien_bien, source="dien_bien"):
        ok, pat = _discharge_timeline_block_is_actual(block, rules)
        if not ok:
            continue
        hhmm = block.get("time") or ""
        mins = _hhmm_to_minutes(hhmm)
        if not hhmm or mins is None:
            continue
        out.append({
            "type": "discharge",
            "source_date": record_date,
            "time_full": f"{hhmm} {record_date}" if record_date else hhmm,
            "time_label": hhmm,
            "time_minutes": mins,
            "doctor": block.get("doctor") or "",
            "title": "Ra viện",
            "dien_bien": _norm_multiline(rules.get("dien_bien_template") or DISCHARGE_DEFAULT_DIEN_BIEN),
            "cham_soc": _norm_multiline(rules.get("care_template") or DISCHARGE_DEFAULT_CARE),
            "needs_vitals": False,
            "source_body": block.get("body") or "",
            "recognition": {
                "source": "dien_bien_timeline",
                "pattern": pat,
                "source_body": block.get("body") or "",
            },
        })

    seen = set()
    deduped = []
    for ev in out:
        key = (ev.get("type"), ev.get("source_date"), ev.get("time_full"))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(ev)
    return sorted(deduped, key=lambda x: int(x.get("time_minutes") or 0))


def _make_discharge_special_event(record: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Tạo phiếu chăm sóc ra viện đúng ngày có Ngày ra viện.

    Chỉ gắn vào record/ngày có ngay_lam trùng ngày ra viện để tránh các ngày khác bị nhầm.
    """
    rules = load_clinical_rules().get("discharge_rules") or {}
    if rules.get("enabled") is False:
        return None
    if not _record_has_discharge_disposition(record):
        return None

    record_date = _normalize_dmy_date(record.get("ngay_lam"))
    discharge_date = _normalize_dmy_date(record.get("ngay_ra_vien_date") or record.get("ngay_ra_vien") or record.get("Ngày ra viện"))
    if not record_date or not discharge_date or record_date != discharge_date:
        return None

    hhmm = _extract_hhmm(record.get("gio_ra_vien") or record.get("ngay_ra_vien") or record.get("Ngày ra viện"))
    if not hhmm:
        return None

    return {
        "type": "discharge",
        "source_date": record_date,
        "time_full": f"{hhmm} {record_date}",
        "time_label": hhmm,
        "time_minutes": _hhmm_to_minutes(hhmm),
        "title": "Ra viện",
        "dien_bien": _norm_multiline(rules.get("dien_bien_template") or DISCHARGE_DEFAULT_DIEN_BIEN),
        "cham_soc": _norm_multiline(rules.get("care_template") or DISCHARGE_DEFAULT_CARE),
        "needs_vitals": False,
        "recognition": {
            "xu_tri": record.get("xu_tri") or record.get("Xử trí") or "",
            "ngay_ra_vien": record.get("ngay_ra_vien") or record.get("Ngày ra viện") or "",
        },
    }


def apply_clinical_rules_to_record(record: Dict[str, Any]) -> Dict[str, Any]:
    """Lọc thuốc/y lệnh theo rule và ghi log thuốc bị bỏ vào record['rule_log']."""
    if not isinstance(record, dict):
        return record

    # Chuẩn hoá/gắn care_special_events nếu có.
    # discharge_event được tạo ở đây để preview và input_care dùng chung một nguồn dữ liệu.
    special_events = [ev for ev in (record.get("care_special_events") or []) if isinstance(ev, dict)]
    discharge_ev = _make_discharge_special_event(record)
    if discharge_ev:
        # Nếu đã đọc được giờ ra viện chính thức từ lblNgayRaVien, dùng giờ đó làm nguồn chuẩn.
        # Không giữ event ra viện suy luận từ diễn biến 08:00, vì 08:00 vẫn là phiếu nhận định/chăm sóc thường.
        special_events = [
            ev for ev in special_events
            if not (
                isinstance(ev, dict)
                and ev.get("type") == "discharge"
                and (ev.get("time_full") or ev.get("time_label")) != (discharge_ev.get("time_full") or discharge_ev.get("time_label"))
            )
        ]
        special_events.append(discharge_ev)

    # Dữ liệu cũ có thể đã lưu đồng thời:
    # - interdepartment_receive từ cột T/G vào
    # - postop_receive từ diễn biến "Ngoại CTCH nhận" sau mổ
    # Với ca hậu phẫu về khoa, chỉ giữ postop_receive, bỏ phiếu nhận chuyển khoa bị dư.
    if any((ev.get("type") or "") == "postop_receive" for ev in special_events):
        special_events = [
            ev for ev in special_events
            if (ev.get("type") or "") not in ("clinic_admission", "ward_receive", "interdepartment_receive")
        ]

    if special_events:
        # Dedup + sort. Special event chỉ nhận event đúng ngày của record.
        # Không lưu theo bệnh nhân, chỉ lưu theo từng (ma_bn, ngay_lam) để các ngày khác không bị nhầm.
        record_date = _normalize_dmy_date(record.get("ngay_lam")) or str(record.get("ngay_lam") or "").strip()
        seen = set()
        dedup = []
        for ev in special_events:
            ev_type = ev.get("type") or "special"
            source_date = _normalize_dmy_date(ev.get("source_date") or record_date) or str(ev.get("source_date") or record_date or "").strip()
            if record_date and source_date and source_date != record_date:
                continue
            ev["source_date"] = record_date or source_date
            if ev_type == "postop_receive":
                if not ev.get("dien_bien"):
                    ev["dien_bien"] = POSTOP_RECEIVE_DEFAULT_DIEN_BIEN
                if not ev.get("cham_soc"):
                    ev["cham_soc"] = POSTOP_RECEIVE_DEFAULT_CARE
                if ev.get("time_minutes") is None:
                    ev["time_minutes"] = _hhmm_to_minutes(ev.get("time_full") or ev.get("time_label"))
                ev["needs_vitals"] = bool(ev.get("needs_vitals", True))
            elif ev_type == "discharge":
                if not ev.get("dien_bien"):
                    ev["dien_bien"] = DISCHARGE_DEFAULT_DIEN_BIEN
                if not ev.get("cham_soc"):
                    ev["cham_soc"] = DISCHARGE_DEFAULT_CARE
                if ev.get("time_minutes") is None:
                    ev["time_minutes"] = _hhmm_to_minutes(ev.get("time_full") or ev.get("time_label"))
                ev["needs_vitals"] = bool(ev.get("needs_vitals", False))
            elif ev_type in ("clinic_admission", "ward_receive", "interdepartment_receive"):
                if not ev.get("time_minutes"):
                    ev["time_minutes"] = _hhmm_to_minutes(ev.get("time_full") or ev.get("time_label"))
                if not ev.get("cham_soc"):
                    if ev_type == "clinic_admission":
                        ev["cham_soc"] = CLINIC_ADMISSION_DEFAULT_CARE
                    elif ev_type == "ward_receive":
                        ev["cham_soc"] = WARD_RECEIVE_DEFAULT_CARE
                    else:
                        ev["cham_soc"] = INTERDEPT_RECEIVE_DEFAULT_CARE
                if not ev.get("dien_bien"):
                    ev["dien_bien"] = "Người bệnh tỉnh"
                ev["needs_vitals"] = bool(ev.get("needs_vitals", ev_type != "clinic_admission"))
            key = (ev_type, ev.get("source_date") or record_date, ev.get("time_full") or ev.get("time_label"))
            if key in seen:
                continue
            seen.add(key)
            dedup.append(ev)
        record["care_special_events"] = sorted(dedup, key=lambda x: int(x.get("time_minutes") or 0))
        if any(ev.get("type") == "postop_receive" for ev in record["care_special_events"]):
            record["care_mode"] = "postop_receive_day"
        elif any(ev.get("type") == "discharge" for ev in record["care_special_events"]):
            record["care_mode"] = "discharge_day"
        elif any(ev.get("type") in ("clinic_admission", "ward_receive", "interdepartment_receive") for ev in record["care_special_events"]):
            record["care_mode"] = "admission_transfer_day"
        elif record.get("care_mode") in ("postop_receive_day", "discharge_day", "admission_transfer_day"):
            record["care_mode"] = "normal"
    elif record.get("care_mode") in ("postop_receive_day", "discharge_day", "admission_transfer_day"):
        record["care_mode"] = "normal"

    thuoc = record.setdefault("thuoc", {})
    skipped: List[Dict[str, Any]] = []

    for cat in ("dich_truyen", "thuoc_tiem", "thuoc_uong", "khac"):
        kept = []
        for item in thuoc.get(cat, []) or []:
            should_skip, meta = medication_skip_decision(item, cat)

            if not should_skip:
                should_skip, meta = _skip_before_receive_decision(item, record)

            if should_skip:
                skipped.append({
                    "category": cat,
                    "ten_thuoc": item.get("ten_hien_thi") or item.get("ten_thuoc") or "",
                    "gio_dung": item.get("tg_bat_dau") or item.get("gio_dung") or "",
                    "gio_y_lenh": item.get("gio_y_lenh") or "",
                    "duong_dung_goc": item.get("duong_dung_goc") or item.get("duong_dung") or "",
                    **meta,
                })
                continue

            kept.append(item)

        thuoc[cat] = kept

    record["tong_hop_gio_dung"] = recompute_medication_hours(record)

    if skipped:
        record.setdefault("rule_log", {})
        record["rule_log"].setdefault("skipped_medications", [])
        record["rule_log"]["skipped_medications"].extend(skipped)

    return record

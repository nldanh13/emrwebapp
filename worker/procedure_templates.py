# -*- coding: utf-8 -*-
"""Mẫu thủ thuật – phẫu thuật theo DVKT (người dùng sửa ở tab "Mẫu thủ thuật – PT").

File config/procedure_templates.json (chưa có thì dùng procedure_templates.default.json).
Mỗi mẫu: kind (thu_thuat / phau_thuat), keywords (khớp tên DVKT, không dấu), performer
(dieu_duong / bac_si: tên lấy theo Lịch Phòng khám lúc nhập), minutes, anesthesia, position,
emr_template (mẫu tường trình EMR của thủ thuật), phuong_phap, mo_ta, report, dan_do,
applies_to (all / bhyt / vien_phi), auto, enabled.
Mẫu không có từ khoá là mẫu mặc định của loại đó: dùng khi không mẫu nào khớp tên DVKT.
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional

from shared.text_utils import norm_vi as norm

ROOT_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
TEMPLATES_PATH = os.path.join(ROOT_DIR, "config", "procedure_templates.json")
DEFAULT_PATH = os.path.join(ROOT_DIR, "config", "procedure_templates.default.json")

KIND_LABEL = {"thu_thuat": "thủ thuật", "phau_thuat": "phẫu thuật"}
PERFORMER_LABEL = {"dieu_duong": "điều dưỡng", "bac_si": "bác sĩ"}


def load_templates(path: Optional[str] = None) -> List[Dict[str, Any]]:
    for candidate in ([path] if path else [TEMPLATES_PATH, DEFAULT_PATH]):
        try:
            with open(candidate, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            continue
        rows = data.get("templates") if isinstance(data, dict) else None
        if isinstance(rows, list):
            return [r for r in rows if isinstance(r, dict)]
    return []


def applies(template: Dict[str, Any], has_bhyt: Optional[bool]) -> bool:
    scope = template.get("applies_to") or "all"
    if scope == "all" or has_bhyt is None:
        return True
    return (scope == "bhyt") == bool(has_bhyt)


def match_template(templates: List[Dict[str, Any]], kind: str, service_text: str,
                   has_bhyt: Optional[bool] = None) -> Optional[Dict[str, Any]]:
    """Mẫu khớp tên DVKT: từ khoá dài nhất có trong tên thắng; không khớp thì mẫu mặc định (không từ khoá)."""
    text = norm(service_text)
    best: Optional[Dict[str, Any]] = None
    best_len = 0
    fallback: Optional[Dict[str, Any]] = None
    reserved_by_inactive_catalog = False
    for tpl in templates:
        if tpl.get("kind") != kind or not applies(tpl, has_bhyt):
            continue
        keys = [norm(k) for k in tpl.get("keywords") or [] if norm(k)]
        # Imported catalog names are full EMR service names; they must never
        # match a longer/different technique by substring (e.g. PRP variants).
        is_catalog = bool(tpl.get("catalog_code"))
        if is_catalog and text in keys and (tpl.get("enabled") is False or tpl.get("reviewed") is not True):
            reserved_by_inactive_catalog = True
        if tpl.get("enabled") is False or (is_catalog and tpl.get("reviewed") is not True):
            continue
        if not keys:
            fallback = fallback or tpl
            continue
        hit = max((len(k) for k in keys if (k == text if is_catalog else k in text)), default=0)
        if hit > best_len:
            best, best_len = tpl, hit
    # An unapproved catalog DVKT must not silently fall through to a generic
    # surgery/procedure auto template, unless an existing explicit rule matched.
    return best or (None if reserved_by_inactive_catalog else fallback)


def minutes_of(template: Dict[str, Any], default: int) -> int:
    try:
        value = int(template.get("minutes") or 0)
    except (TypeError, ValueError):
        value = 0
    return value if value > 0 else default


def text_of(template: Dict[str, Any], key: str, default: str = "") -> str:
    return " ".join(str(template.get(key) or "").split()) or default


def missing_message(kind: str, service_text: str) -> str:
    name = " ".join(str(service_text or "").split())[:120]
    return (f"Chưa có mẫu {KIND_LABEL.get(kind, kind)} cho DVKT"
            + (f" \"{name}\"" if name else "")
            + ": thêm mẫu ở tab Mẫu thủ thuật – PT rồi bấm lại")


def manual_message(template: Dict[str, Any]) -> str:
    return f"Mẫu \"{template.get('name') or ''}\" đặt nhập tay, không tự nhập"


def block_of(template: Dict[str, Any], key: str) -> str:
    """Nội dung nhiều dòng (mô tả, tường trình, dặn dò): giữ xuống dòng, bỏ khoảng trắng thừa hai đầu."""
    return "\n".join(line.rstrip() for line in str(template.get(key) or "").strip().splitlines())

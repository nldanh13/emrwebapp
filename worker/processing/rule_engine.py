# -*- coding: utf-8 -*-
"""Rule engine nhận dạng nhóm thuốc/y lệnh.

Mục tiêu: chuyển phần if/else dài trong xu_ly.py sang cấu hình JSON.
Khi bệnh viện có thêm cách ghi đường dùng mới, ưu tiên sửa:
    config/order_rules.json
thay vì sửa trực tiếp logic phân loại.
"""
from __future__ import annotations

import json
import os
import re
from functools import lru_cache
from typing import Any, Callable

try:
    from processing.semantic_search import semantic_contains
except Exception:  # pragma: no cover
    semantic_contains = None

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_WORKER_DIR = os.path.dirname(_THIS_DIR)
_PROJECT_DIR = os.path.dirname(_WORKER_DIR)
_DEFAULT_RULES_PATH = os.path.join(_PROJECT_DIR, "config", "order_rules.json")


def _default_rules() -> dict[str, Any]:
    return {
        "drug_routes": {
            "oral": ["uống", "uong", "(u)", "ngậm", "dưới lưỡi"],
            "infusion": ["truyền", "truyen", "ttm", "bơm tiêm điện", "pha truyền", "ml/h", "giọt/phút", "g/p", "tiêm truyền"],
            "slow_iv_injection": ["tĩnh mạch chậm", "tm chậm", "tmc", "tiêm chậm"],
            "injection": ["tiêm", "bắp", "dưới da", "tdd", "(tdd)", "tĩnh mạch"],
            "injection_only": ["tiêm bắp", "bắp", "dưới da", "tdd", "(tdd)", " im ", "(im)", " sc ", "(sc)"],
            "inhaled": ["hít", "xịt", "khí dung", "aerosol", "phun mù", "định liều"],
            "topical": ["bôi", "thoa", "miếng dán", "dán qua da"],
            "eye_nose_ear_drop": ["nhỏ mắt", "nhỏ mũi", "nhỏ tai", "nhỏ"],
            "suppository": ["đặt", "hậu môn", "trực tràng", "âm đạo"],
        },
        "solvents": {
            "nacl_keywords": [
                "natri clorid", "natri chlorid", "natri chloride",
                "sodium clorid", "sodium chlorid", "sodium chloride",
                "nacl", "nước muối", "nuoc muoi",
            ],
            "mix_keywords": ["pha với", "pha", "lấy", "pha đủ"],
        },
        "name_keywords": {
            "true_infusions": ["PARACETAMOL", "THERMODOL", "NATRI CLORID", "SODIUM CHLORIDE", "NACL", "GLUCOSE", "RINGER"],
            "infusion_products": ["AMINOPLASMAL", "NEPHROSTERIL", "ALBUNORM", "ALBUMIN"],
            "always_infusion_drugs": ["NEFOPAM"],
        },
        "fallback": {"large_volume_min_ml": 50},
    }


@lru_cache(maxsize=8)
def load_order_rules(path: str | None = None) -> dict[str, Any]:
    """Đọc rule JSON, có cache và fallback an toàn."""
    rules_path = path or os.environ.get("ORDER_RULES_PATH") or _DEFAULT_RULES_PATH
    defaults = _default_rules()
    try:
        with open(rules_path, "r", encoding="utf-8") as f:
            loaded = json.load(f)
        if not isinstance(loaded, dict):
            return defaults
        return _deep_merge(defaults, loaded)
    except Exception:
        return defaults


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def clear_order_rules_cache() -> None:
    """Dùng trong test/dev sau khi sửa file rule."""
    load_order_rules.cache_clear()


def _text(value: Any) -> str:
    return str(value or "")


def _lower(value: Any) -> str:
    return _text(value).lower()


def _upper(value: Any) -> str:
    return _text(value).upper()


def _keywords(rules: dict[str, Any], group: str) -> list[str]:
    vals = ((rules.get("drug_routes") or {}).get(group) or [])
    return [str(v).lower() for v in vals if str(v).strip()]


def _solvent_keywords(rules: dict[str, Any], group: str) -> list[str]:
    vals = ((rules.get("solvents") or {}).get(group) or [])
    return [str(v).lower() for v in vals if str(v).strip()]


def _name_keywords(rules: dict[str, Any], group: str) -> list[str]:
    vals = ((rules.get("name_keywords") or {}).get(group) or [])
    return [str(v).upper() for v in vals if str(v).strip()]


def contains_any(text: str, keywords: list[str]) -> bool:
    haystack = _lower(text)
    return any(k and k in haystack for k in keywords)


def semantic_contains_any(text: str, keywords: list[str], *, threshold: float = 0.90) -> bool:
    if not callable(semantic_contains):
        return False
    return bool(semantic_contains(text, keywords, threshold=threshold))


def name_contains_any(text: str, keywords: list[str]) -> bool:
    haystack = _upper(text)
    return any(k and k in haystack for k in keywords)


def has_oral_marker(route_text: str) -> bool:
    """Nhận diện đường uống, kể cả ký hiệu ngắn (u)."""
    u = _lower(route_text)
    return bool(
        re.search(
            r"\(\s*u\s*\)|\buống\b|\buong\b|(?<![0-9a-zA-ZÀ-ỹ])u(?![0-9a-zA-ZÀ-ỹ])",
            u,
            flags=re.IGNORECASE,
        )
    )


def _as_float(value: Any) -> float:
    try:
        return float(value or 0)
    except Exception:
        return 0.0


def detect_drug_category(
    drug_info: dict[str, Any],
    *,
    rules: dict[str, Any] | None = None,
    extra_true_infusions: list[str] | tuple[str, ...] | None = None,
    extra_infusion_keywords: list[str] | tuple[str, ...] | None = None,
    extra_always_infusion_drugs: list[str] | tuple[str, ...] | None = None,
    safety_nacl_volume_getter: Callable[[str], float | None] | None = None,
    with_reason: bool = False,
) -> str | tuple[str, str]:
    """Phân loại thuốc theo rule.

    Trả về một trong các nhóm cũ để không đổi output:
    dich_truyen, thuoc_tiem, thuoc_uong, thuoc_hit_xit,
    thuoc_boi, thuoc_nho, thuoc_dat, khac.
    """
    rules = rules or load_order_rules()

    name = _text(drug_info.get("ten_thuoc") or drug_info.get("ten_hien_thi") or "")
    name_u = _upper(name)
    display_name_l = _lower(drug_info.get("ten_hien_thi") or drug_info.get("ten_thuoc") or "")
    route_l = _lower(drug_info.get("duong_dung_goc") or "")
    rate = _text(drug_info.get("toc_do") or "").strip()
    vol = _as_float(drug_info.get("the_tich"))

    def done(category: str, reason: str):
        return (category, reason) if with_reason else category

    if has_oral_marker(route_l) or contains_any(route_l, _keywords(rules, "oral")) or semantic_contains_any(route_l, _keywords(rules, "oral"), threshold=0.92):
        return done("thuoc_uong", "route:oral_marker")

    if route_l.strip() in ("tiêm (tự túc)", "tiêm(tự túc)") and "uống" in display_name_l:
        return done("thuoc_uong", "emr_self_paid_injection_but_name_contains_oral")

    # TTM/truyền ưu tiên trước tiêm, vì nhiều y lệnh ghi "tiêm truyền".
    if contains_any(route_l, _keywords(rules, "infusion")) or semantic_contains_any(route_l, _keywords(rules, "infusion"), threshold=0.88):
        return done("dich_truyen", "route:infusion_keyword")

    if contains_any(route_l, _keywords(rules, "slow_iv_injection")) or semantic_contains_any(route_l, _keywords(rules, "slow_iv_injection"), threshold=0.88):
        return done("thuoc_tiem", "route:slow_iv_injection")

    true_infusions = set(_name_keywords(rules, "true_infusions"))
    true_infusions.update(_upper(x) for x in (extra_true_infusions or []) if str(x).strip())
    infusion_products = set(_name_keywords(rules, "infusion_products"))
    infusion_products.update(_upper(x) for x in (extra_infusion_keywords or []) if str(x).strip())
    if name_contains_any(name_u, list(true_infusions)) or name_contains_any(name_u, list(infusion_products)):
        return done("dich_truyen", "name:true_infusion")

    has_sodium_09 = ("sodium" in route_l) and (("0.9" in route_l) or ("0,9" in route_l))
    has_nacl = has_sodium_09 or contains_any(route_l, _solvent_keywords(rules, "nacl_keywords")) or bool(drug_info.get("dung_moi"))
    has_mix_words = contains_any(route_l, _solvent_keywords(rules, "mix_keywords"))
    if has_nacl and (has_mix_words or bool(rate)):
        return done("dich_truyen", "solvent:nacl_or_mix_or_rate")

    is_injection_only = contains_any(route_l, _keywords(rules, "injection_only"))
    always_infusion = set(_name_keywords(rules, "always_infusion_drugs"))
    always_infusion.update(_upper(x) for x in (extra_always_infusion_drugs or []) if str(x).strip())
    if (not is_injection_only) and name_contains_any(name_u, list(always_infusion)):
        safety_vol = safety_nacl_volume_getter(name_u) if callable(safety_nacl_volume_getter) else None
        if safety_vol is not None:
            return done("dich_truyen", "safety:always_infusion_with_nacl_volume")

    if contains_any(route_l, _keywords(rules, "injection")) or semantic_contains_any(route_l, _keywords(rules, "injection"), threshold=0.90):
        # Nếu chỉ ghi "tĩnh mạch" mà không có truyền thì vẫn là nhóm tiêm.
        return done("thuoc_tiem", "route:injection_keyword")

    if contains_any(route_l, _keywords(rules, "inhaled")):
        return done("thuoc_hit_xit", "route:inhaled")

    if contains_any(route_l, _keywords(rules, "topical")):
        return done("thuoc_boi", "route:topical")

    if contains_any(route_l, _keywords(rules, "eye_nose_ear_drop")):
        return done("thuoc_nho", "route:drop")

    if contains_any(route_l, _keywords(rules, "suppository")):
        return done("thuoc_dat", "route:suppository")

    try:
        large_volume_min_ml = float(((rules.get("fallback") or {}).get("large_volume_min_ml")) or 50)
    except Exception:
        large_volume_min_ml = 50
    if vol >= large_volume_min_ml:
        return done("dich_truyen", f"fallback:large_volume>={large_volume_min_ml:g}ml")

    return done("khac", "fallback:unknown")

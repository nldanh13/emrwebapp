# -*- coding: utf-8 -*-
"""shared/text_utils.py — Chuẩn hoá văn bản tiếng Việt dùng chung.

Thay thế các định nghĩa _norm / norm / strip_accents lặp lại trong:
  clinical_rules.py    → _norm()
  hchanh_fetch.py      → _norm()
  input_procedures.py  → _norm()   (wrap chuan_hoa_unicode)
  input_vtyt.py        → _norm()
  vtyt_rules.py        → norm()
  clinic_outpatient.py → strip_accents() + norm()
  generate_report.py   → norm()    (chỉ strip whitespace, KHÔNG bỏ dấu)
  utils.py             → strip_accents() + chuan_hoa_unicode()

Dùng:
  from shared.text_utils import norm_vi, norm_vi_upper, norm_space, contains_any
"""
from __future__ import annotations

import re
import unicodedata
from typing import Any, Iterable


# ── Core ──────────────────────────────────────────────────────────────────────

def strip_accents(text: Any) -> str:
    """Bỏ dấu tiếng Việt: NFC → NFD → loại combining marks → sửa đ/Đ.

    'Nguyễn Văn An' → 'Nguyen Van An'
    """
    s = unicodedata.normalize("NFC", str(text or ""))
    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    return s.replace("\u0111", "d").replace("\u0110", "D")  # đ → d, Đ → D


def norm_vi(text: Any) -> str:
    """Chuẩn hoá tiếng Việt để so khớp: bỏ dấu, chữ thường, chuẩn hoá khoảng trắng.

    Đây là hàm tương đương với _norm() lặp lại ở 6+ worker files.

    'Truyền dịch  NaCl 0.9%' → 'truyen dich nacl 0.9%'
    """
    s = strip_accents(text).lower()
    return re.sub(r"\s+", " ", s).strip()


def norm_vi_upper(text: Any) -> str:
    """Như norm_vi nhưng giữ HOA — dùng cho so khớp không phân biệt hoa thường
    nhưng cần giữ số/ký hiệu nguyên gốc (ví dụ mã ICD, mã thuốc).

    'Paracetamol 500mg' → 'PARACETAMOL 500MG'
    """
    s = strip_accents(text).upper()
    return re.sub(r"\s+", " ", s).strip()


def norm_space(text: Any) -> str:
    """Chỉ chuẩn hoá khoảng trắng, KHÔNG bỏ dấu, KHÔNG đổi hoa/thường.

    Tương đương generate_report.norm() — dùng khi cần giữ nguyên văn bản
    gốc tiếng Việt, chỉ loại bỏ khoảng trắng thừa.

    'Thuốc  tiêm   IV' → 'Thuốc tiêm IV'
    """
    return re.sub(r"\s+", " ", str(text or "")).strip()


# ── Helpers thường dùng ───────────────────────────────────────────────────────

def contains_any(text: Any, keywords: Iterable[str]) -> bool:
    """True nếu norm_vi(text) chứa ít nhất một keyword (đã norm_vi).

    Thay thế pattern lặp lại:
        n = norm(text)
        return any(norm(k) in n for k in keywords)
    """
    n = norm_vi(text)
    return any(norm_vi(k) in n for k in keywords)


def contains_all(text: Any, keywords: Iterable[str]) -> bool:
    """True nếu norm_vi(text) chứa tất cả keyword."""
    n = norm_vi(text)
    return all(norm_vi(k) in n for k in keywords)

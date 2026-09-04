# -*- coding: utf-8 -*-
"""drug_normalizer.py — Chuẩn hoá dòng tên thuốc theo rule có thứ tự ưu tiên."""
from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Pattern


@dataclass(frozen=True)
class RegexRule:
    pattern: Pattern[str]
    replacement: str


class DrugNameNormalizer:
    """Chuẩn hoá tên thuốc trước khi tách tên/số lượng/dạng thuốc.

    Rule chạy theo thứ tự cố định để dễ thêm case mới mà không làm lệch các rule cũ.
    """

    def __init__(self) -> None:
        self.prefix_rules = [
            RegexRule(re.compile(r"^[\+\-\*\s]+"), ""),
            RegexRule(re.compile(r"^\(\s*\d+\s*\)\s*"), ""),
            RegexRule(re.compile(r"^\d+\)\s*"), ""),
            RegexRule(re.compile(r"^\(\s*(CS|TT)\s*\)\s*", re.IGNORECASE), ""),
            # EMR/clipboard đôi khi làm méo marker tự túc/có sẵn:
            #   "(TT0 Nucleo..." hoặc "(TT0) Nucleo..." thay vì "(TT) Nucleo...".
            # Chỉ xoá khi sau TT/CS là dấu đóng, số 0/O hoặc khoảng trắng để không đụng "(TTM)".
            RegexRule(re.compile(r"^\(+\s*(CS|TT)(?:\s*\)|[0Oo]\)?|\s+)\s*", re.IGNORECASE), ""),
        ]
        self.body_rules = [
            RegexRule(re.compile(r"\b(\d+)\s*vx\s*(\d+)\s*u\b", re.IGNORECASE), r"\1 viên x \2 u"),
            RegexRule(re.compile(r"\b(\d+)vx(\d+)u\b", re.IGNORECASE), r"\1 viên x \2 u"),
            RegexRule(re.compile(r"\b(\d+)\s*vx\s*(\d+)\b", re.IGNORECASE), r"\1 viên x \2"),
            RegexRule(re.compile(r"\b(\d+)vx(\d+)\b", re.IGNORECASE), r"\1 viên x \2"),
            RegexRule(re.compile(r"\b(\d+)\s*v\b", re.IGNORECASE), r"\1 viên"),
            RegexRule(re.compile(r"\b(\d+)v(?=\s|$)", re.IGNORECASE), r"\1 viên"),
            RegexRule(re.compile(r"\b(\d+)\s*[xX]\s*(\d+)\s*(viên|ống|lọ|chai|túi|gói)\b", re.IGNORECASE), r"\1 \3 x \2"),
            RegexRule(re.compile(r"\b(\d+)\s*(viên|ống|lọ|chai|túi|gói)\s*x(?=\d)", re.IGNORECASE), r"\1 \2 x "),
            RegexRule(re.compile(r"\bg\s*/\s*ph\b", re.IGNORECASE), "g/p"),
            RegexRule(re.compile(r"\s+"), " "),
        ]

    def normalize_line(self, line: str) -> str:
        text = str(line or "").strip()
        for rule in self.prefix_rules:
            text = rule.pattern.sub(rule.replacement, text).strip()
        for rule in self.body_rules:
            text = rule.pattern.sub(rule.replacement, text)
        return text.strip()


DRUG_NORMALIZER = DrugNameNormalizer()

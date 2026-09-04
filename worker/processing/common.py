# -*- coding: utf-8 -*-
"""Hàm ngày làm việc dùng chung cho pipeline xử lý y lệnh."""
from datetime import datetime
from date_utils import normalize_dmy


def _today_dmy() -> str:
    return datetime.now().strftime("%d/%m/%Y")


def _coerce_work_date(raw_date=None, fallback=None) -> str:
    return normalize_dmy(raw_date, fallback=(fallback or _today_dmy()), default_year=datetime.now().year)
